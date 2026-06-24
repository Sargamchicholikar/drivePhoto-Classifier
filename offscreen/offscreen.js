/**
 * offscreen.js — Offline ML pipeline for Drive Photo Classifier.
 *
 * Model : photo_classifier.onnx  (EfficientNet-B2, 4 classes)
 * Classes: animals | group | human | junk
 * Input : [1, 3, 260, 260] float32, ImageNet-normalised RGB
 * Output: [1, 4] logits → softmax for probabilities
 */

const OFFSCREEN_RUNTIME_VERSION = "onnx-v7";
const DEFAULT_PARALLELISM       = 4;
const MAX_PARALLELISM           = 8;

const CLASSES  = ["animals", "group", "human", "junk"];
const IMG_SIZE = 260;
const MEAN     = [0.485, 0.456, 0.406];
const STD      = [0.229, 0.224, 0.225];

// ── Quality-signal thresholds ──────────────────────────────────────────────────
// BLUR_THRESHOLD: Laplacian variance on a 260x260 downscaled image.
//   80 was too aggressive — sharp photos lose detail on resize, so natural
//   group/human photos were flagged. Lowered to 18 (only severely blurry).
const BLUR_THRESHOLD      = 18;

// DEDUP_HAMMING_MAX: bits different in a 64-bit dHash before two images are
//   considered duplicates. 5/64 = 92% similar — too loose, caught similar but
//   distinct photos. Tightened to 3 (≥95% identical).
const DEDUP_HAMMING_MAX   = 3;

// SCREENSHOT_BAND_PCT: fraction of image height that must be a solid-colour
//   band at both top AND bottom to be flagged as a screenshot.
//   6% = only 15 px — triggered on ANY sky+ground photo (beach, wedding, etc.).
//   Raised to 18% AND the solid-colour tolerance tightened below.
const SCREENSHOT_BAND_PCT = 0.18;

// ── ONNX session (lazy-loaded once) ───────────────────────────────────────────
let classifierPromise = null;

function ortDistBase() {
  return chrome.runtime.getURL("lib/ort/");
}

async function ensureClassifier() {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      ort.env.wasm.wasmPaths  = ortDistBase();
      ort.env.wasm.numThreads = 1;

      const customBuf = await loadCustomModelBuffer();
      if (customBuf) {
        try {
          return await ort.InferenceSession.create(customBuf, {
            executionProviders: ["wasm"], graphOptimizationLevel: "all",
          });
        } catch (err) {
          console.warn("[Offscreen] Custom model failed, falling back to built-in:", err.message);
        }
      }

      return ort.InferenceSession.create(
        chrome.runtime.getURL("model_files/photo_classifier.onnx"),
        { executionProviders: ["wasm"], graphOptimizationLevel: "all" }
      );
    })().catch((err) => {
      classifierPromise = null;
      throw err;
    });
  }
  return classifierPromise;
}

async function loadCustomModelBuffer() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open("PhotoClassifierDB", 1);
      req.onupgradeneeded = (e) => e.target.result.createObjectStore("models");
      req.onsuccess = (e) => {
        try {
          const get = e.target.result.transaction("models", "readonly").objectStore("models").get("custom_model");
          get.onsuccess = () => resolve(get.result?.buffer ?? null);
          get.onerror   = () => resolve(null);
        } catch { resolve(null); }
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

// ── Softmax ────────────────────────────────────────────────────────────────────
function softmax(arr) {
  const max  = Math.max(...arr);
  const exps = arr.map((x) => Math.exp(x - max));
  const sum  = exps.reduce((a, b) => a + b, 0);
  return exps.map((x) => x / sum);
}

// ── Quality signal helpers ─────────────────────────────────────────────────────

function laplacianVariance(gray, w, h) {
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = -4 * gray[y * w + x] + gray[(y - 1) * w + x] + gray[(y + 1) * w + x] + gray[y * w + (x - 1)] + gray[y * w + (x + 1)];
      sum += v; sumSq += v * v; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function dHash(rgba, w, h) {
  const GW = 9, GH = 8;
  const gray = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const px = Math.round(gx / GW * (w - 1));
      const py = Math.round(gy / GH * (h - 1));
      const i  = (py * w + px) * 4;
      gray[gy * GW + gx] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  let hi = 0, lo = 0, bit = 63;
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW - 1; gx++) {
      const set = gray[gy * GW + gx] > gray[gy * GW + gx + 1] ? 1 : 0;
      if (bit >= 32) hi = (hi | (set << (bit - 32))) >>> 0;
      else           lo = (lo | (set << bit))        >>> 0;
      bit--;
    }
  }
  return [hi, lo];
}

function hammingDist(a, b) {
  let xorHi = (a[0] ^ b[0]) >>> 0;
  let xorLo = (a[1] ^ b[1]) >>> 0;
  let n = 0;
  while (xorHi) { n += xorHi & 1; xorHi >>>= 1; }
  while (xorLo) { n += xorLo & 1; xorLo >>>= 1; }
  return n;
}

function isSolidBand(rgba, w, startY, endY) {
  // Tightened tolerance: ±8 per channel (was ±20).
  // ±20 was too lenient — slight colour gradients in sky or floor triggered it.
  // ±8 only fires on true black/white letterbox bars as found on screenshots.
  // Also sample every pixel (step=1) rather than every 8th to avoid aliasing.
  const r0 = rgba[startY * w * 4], g0 = rgba[startY * w * 4 + 1], b0 = rgba[startY * w * 4 + 2];
  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(rgba[i] - r0) > 8 || Math.abs(rgba[i + 1] - g0) > 8 || Math.abs(rgba[i + 2] - b0) > 8) return false;
    }
  }
  return true;
}

// ── Classify one image blob ────────────────────────────────────────────────────
async function classifyPhoto(blob, fileId = null, sessionHashes = null) {
  const session = await ensureClassifier();

  const bitmap = await createImageBitmap(blob, { resizeWidth: IMG_SIZE, resizeHeight: IMG_SIZE, resizeQuality: "medium" });
  const canvas = new OffscreenCanvas(IMG_SIZE, IMG_SIZE);
  const ctx    = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);
  const { data }  = imageData;
  const pixels    = IMG_SIZE * IMG_SIZE;
  const qualityIssues = [];

  const grayPx = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) {
    grayPx[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  if (laplacianVariance(grayPx, IMG_SIZE, IMG_SIZE) < BLUR_THRESHOLD) qualityIssues.push("blurry");

  if (sessionHashes !== null && fileId !== null) {
    const h = dHash(data, IMG_SIZE, IMG_SIZE);
    for (const [id, existHash] of sessionHashes) {
      if (id !== fileId && hammingDist(h, existHash) <= DEDUP_HAMMING_MAX) { qualityIssues.push("duplicate"); break; }
    }
    sessionHashes.set(fileId, h);
  }

  const bandH = Math.max(1, Math.floor(IMG_SIZE * SCREENSHOT_BAND_PCT));
  if (isSolidBand(data, IMG_SIZE, 0, bandH) && isSolidBand(data, IMG_SIZE, IMG_SIZE - bandH, IMG_SIZE)) {
    qualityIssues.push("screenshot");
  }

  // ── Always run the ONNX model — quality flags are signals, not hard overrides ──
  // Previous code returned early here and never ran the model for quality-flagged
  // photos, forcing ALL blurry/outdoor/similar photos directly to Junk.
  // That caused Group and Human photos to be systematically misclassified.
  const td = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    td[0 * pixels + i] = (data[i * 4]     / 255 - MEAN[0]) / STD[0];
    td[1 * pixels + i] = (data[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    td[2 * pixels + i] = (data[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }

  const input   = new ort.Tensor("float32", td, [1, 3, IMG_SIZE, IMG_SIZE]);
  const outputs = await session.run({ image: input });
  const rawLogits = Array.from(outputs.logits.data);

  const probs  = softmax(rawLogits);
  const sorted = [...probs].sort((a, b) => b - a);
  const topIdx = probs.indexOf(sorted[0]);
  const margin = sorted[0] - sorted[1];   // confidence gap between top-2 classes

  // ── Quality override logic ────────────────────────────────────────────────────
  // Only override the model with a quality-based Junk decision when the model is
  // also uncertain (small margin) OR the model agrees it is Junk.
  // If the model is confident about Group/Human, trust the model — the photo may
  // just be slightly blurry or have a plain background.

  if (qualityIssues.length > 0) {
    const modelSaysJunk  = topIdx === 3;                   // CLASSES[3] = "junk"
    const modelUncertain = margin < 0.25;                  // model can't decide
    const onlyDuplicate  = qualityIssues.length === 1 && qualityIssues[0] === "duplicate";

    if (onlyDuplicate) {
      // Duplicates: always Junk regardless of model — keep library clean.
      return { category: "junk", confidence: 0.97, label: "quality_duplicate", qualityIssues, probs, rawLogits };
    }

    if (modelSaysJunk || modelUncertain) {
      // Model also leans Junk, or model can't decide → quality flag wins.
      return { category: "junk", confidence: 0.97, label: `quality_${qualityIssues.join("+")}`, qualityIssues, probs, rawLogits };
    }

    // Model is confident about a non-Junk class (Group/Human/Animals) →
    // trust the model. Note the quality flag in the label for debugging.
    return {
      category:   CLASSES[topIdx],
      confidence: probs[topIdx],
      label:      `onnx_${CLASSES[topIdx]}_qflag_${qualityIssues.join("+")}`,
      qualityIssues,
      probs,
      rawLogits,
    };
  }

  return {
    category:   CLASSES[topIdx],
    confidence: probs[topIdx],
    label:      `onnx_${CLASSES[topIdx]}`,
    qualityIssues: [],
    probs,
    rawLogits,
  };
}

// ── Full pipeline for one Drive file ──────────────────────────────────────────
async function classifyOneFile(file, token, sessionHashes = null) {
  let res;
  if (file.downloadUrl) {
    res = await fetch(file.downloadUrl);
  } else {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cannot fetch ${file.name}: ${res.status} ${text}`);
  }

  const blob       = await res.blob();
  const classified = await classifyPhoto(blob, file.id, sessionHashes);
  return { ...file, ...classified };
}

// ── Parallel batch runner ──────────────────────────────────────────────────────
async function classifyBatch(files, token, parallelism = DEFAULT_PARALLELISM) {
  const n             = Math.max(1, Math.min(MAX_PARALLELISM, Number(parallelism) || DEFAULT_PARALLELISM));
  const output        = new Array(files.length);
  let cursor          = 0;
  const sessionHashes = new Map();

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= files.length) return;
      try {
        output[idx] = await classifyOneFile(files[idx], token, sessionHashes);
      } catch (err) {
        output[idx] = { ...files[idx], category: "other", confidence: 0, label: "classification_error", error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: n }, worker));
  return output;
}

// ══════════════════════════════════════════════════════════════════════════════
// FACE DETECTION + RECOGNITION PIPELINE
// ══════════════════════════════════════════════════════════════════════════════

// ── Face model sessions (lazy) ─────────────────────────────────────────────────
// IMPORTANT: Face models must use:
//   - graphOptimizationLevel: "basic"  (NOT "all" — causes WASM OOM on 37 MB SFace)
//   - numThreads: 1                    (multi-thread WASM aborts in offscreen context)
//   - wasmPaths set explicitly         (same as classifier, must be set before create())
//
// The recognizer (37 MB) is NOT kept in memory permanently — it is created fresh
// per scan batch and released so the classifier WASM heap is not exhausted.

let detectorPromise   = null;
// Recognizer is created on-demand and released after each face scan batch
let _recognizerSession = null;

const FACE_SESSION_OPTS = {
  executionProviders:     ["wasm"],
  graphOptimizationLevel: "basic",   // "all" crashes WASM on large models
};

async function ensureDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      // Must set wasmPaths + numThreads before creating any session
      ort.env.wasm.wasmPaths  = ortDistBase();
      ort.env.wasm.numThreads = 1;
      return ort.InferenceSession.create(
        chrome.runtime.getURL("model_files/face_detector.onnx"),
        FACE_SESSION_OPTS
      );
    })().catch(err => { detectorPromise = null; throw err; });
  }
  return detectorPromise;
}

async function ensureRecognizer() {
  // Return cached session if already loaded this batch
  if (_recognizerSession) return _recognizerSession;
  ort.env.wasm.wasmPaths  = ortDistBase();
  ort.env.wasm.numThreads = 1;
  _recognizerSession = await ort.InferenceSession.create(
    chrome.runtime.getURL("model_files/face_recognition.onnx"),
    FACE_SESSION_OPTS
  );
  return _recognizerSession;
}

// Release the 37 MB recognizer from the WASM heap after a scan batch finishes
async function releaseRecognizer() {
  if (_recognizerSession) {
    try { await _recognizerSession.release(); } catch (_) {}
    _recognizerSession = null;
  }
}

// ── Anchor-free priors for YuNet 2023 ─────────────────────────────────────────
// YuNet 2023 is FCOS-style: 1 anchor per grid cell, no pre-defined anchor sizes.
// Strides: [8, 16, 32]  →  80×80 + 40×40 + 20×20 = 6400 + 1600 + 400 = 8400 anchors
//
// Each prior is [col, row, stride] (not normalised — raw grid integers + stride).
// The decoding formula uses FCOS-style (l,t,r,b) distances from cell centre:
//   x1 = (col + 0.5) * stride − l * stride      → then divide by img width
//   y1 = (row + 0.5) * stride − t * stride
//   x2 = (col + 0.5) * stride + r * stride
//   y2 = (row + 0.5) * stride + b * stride
const FACE_STRIDES  = [8, 16, 32];
const FACE_DET_SIZE = 640;

let _facePriors = null;

function buildFacePriors(W = FACE_DET_SIZE, H = FACE_DET_SIZE) {
  const p = [];
  for (const stride of FACE_STRIDES) {
    const gW = Math.ceil(W / stride), gH = Math.ceil(H / stride);
    for (let row = 0; row < gH; row++) {
      for (let col = 0; col < gW; col++) {
        p.push(col, row, stride); // stride 3 per anchor
      }
    }
  }
  return p; // flat, stride 3
}

function getFacePriors() {
  if (!_facePriors) _facePriors = buildFacePriors();
  return _facePriors;
}

// ── NMS ────────────────────────────────────────────────────────────────────────
function nms(boxes, scores, iouThreshold) {
  const order = scores
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.i);

  const suppressed = new Uint8Array(boxes.length);
  const keep = [];

  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    if (suppressed[i]) continue;
    keep.push(i);
    const [ax1, ay1, ax2, ay2] = boxes[i];
    const aArea = (ax2 - ax1) * (ay2 - ay1);

    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (suppressed[j]) continue;
      const [bx1, by1, bx2, by2] = boxes[j];
      const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
      const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
      if (ix2 <= ix1 || iy2 <= iy1) continue;
      const inter = (ix2 - ix1) * (iy2 - iy1);
      const iou   = inter / (aArea + (bx2 - bx1) * (by2 - by1) - inter);
      if (iou > iouThreshold) suppressed[j] = 1;
    }
  }
  return keep;
}

// ── Decode face detector output → bounding boxes (anchor-free FCOS style) ─────
// loc format per anchor: [l, t, r, b, kx1, ky1, …, kx5, ky5]  (14 values)
// l/t/r/b are distances from cell centre to box edges, in stride units.
// YuNet 2023 may output sigmoid-activated cls/obj (values already in [0,1]),
// so we guard against double-sigmoid by clamping the product instead.
function decodeFaceDetections(locData, clsData, iouData, scoreThreshold = 0.5) {
  const priors = getFacePriors();
  const W = FACE_DET_SIZE, H = FACE_DET_SIZE;
  const N = priors.length / 3;    // 8 400 anchors

  const boxes = [], scores = [];

  for (let i = 0; i < N; i++) {
    // cls/iou may be pre-sigmoid (YuNet 2023) or raw logits (custom model).
    // We apply sigmoid only when the value is outside [0,1] (i.e. a logit).
    const rawCls = clsData[i], rawIou = iouData[i];
    const cls = (rawCls > 1 || rawCls < 0) ? 1 / (1 + Math.exp(-rawCls)) : rawCls;
    const iou = (rawIou > 1 || rawIou < 0) ? 1 / (1 + Math.exp(-rawIou)) : rawIou;
    const score = cls * iou;
    if (score < scoreThreshold) continue;

    const pi = i * 3;
    const col = priors[pi], row = priors[pi + 1], stride = priors[pi + 2];

    const li = i * 14;
    const l = locData[li], t = locData[li + 1];
    const r = locData[li + 2], b = locData[li + 3];

    // FCOS-style decoding: distances in stride units from cell centre
    const cx_px = (col + 0.5) * stride;
    const cy_px = (row + 0.5) * stride;
    const x1 = Math.max(0, (cx_px - l * stride) / W);
    const y1 = Math.max(0, (cy_px - t * stride) / H);
    const x2 = Math.min(1, (cx_px + r * stride) / W);
    const y2 = Math.min(1, (cy_px + b * stride) / H);

    if (x2 > x1 && y2 > y1) { boxes.push([x1, y1, x2, y2]); scores.push(score); }
  }

  if (!boxes.length) return [];
  return nms(boxes, scores, 0.4).map(i => ({ box: boxes[i], score: scores[i] }));
}

// ── Extract face embedding from a canvas region ────────────────────────────────
// Input: detCanvas (640×640), box in normalised [0,1] coords
// Output: 512-dim L2-normalised Float32Array
async function extractFaceEmbedding(detCanvas, box) {
  const [x1, y1, x2, y2] = box;
  const W = detCanvas.width, H = detCanvas.height;

  // Expand bbox by 20% on each side to include hair/chin
  const padX = (x2 - x1) * 0.2, padY = (y2 - y1) * 0.2;
  const cx1 = Math.max(0, (x1 - padX) * W), cy1 = Math.max(0, (y1 - padY) * H);
  const cx2 = Math.min(W, (x2 + padX) * W), cy2 = Math.min(H, (y2 + padY) * H);

  const CROP = 112;
  const cropCanvas = new OffscreenCanvas(CROP, CROP);
  const ctx = cropCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(detCanvas, cx1, cy1, cx2 - cx1, cy2 - cy1, 0, 0, CROP, CROP);

  const { data } = ctx.getImageData(0, 0, CROP, CROP);
  const P = CROP * CROP;
  const input = new Float32Array(3 * P);
  for (let i = 0; i < P; i++) {
    // RGB, normalised: (pixel − 127.5) / 128
    input[0 * P + i] = (data[i * 4]     - 127.5) / 128;
    input[1 * P + i] = (data[i * 4 + 1] - 127.5) / 128;
    input[2 * P + i] = (data[i * 4 + 2] - 127.5) / 128;
  }

  const recognizer = await ensureRecognizer();
  const tensor = new ort.Tensor("float32", input, [1, 3, CROP, CROP]);
  const out    = await recognizer.run({ "input.1": tensor });
  return Array.from(out.embedding.data); // [512] L2-normalised
}

// ── Generate a small JPEG thumbnail for a face region ─────────────────────────
async function getFaceThumbnail(detCanvas, box) {
  const [x1, y1, x2, y2] = box;
  const W = detCanvas.width, H = detCanvas.height;

  const padX = (x2 - x1) * 0.2, padY = (y2 - y1) * 0.2;
  const cx1 = Math.max(0, (x1 - padX) * W), cy1 = Math.max(0, (y1 - padY) * H);
  const cx2 = Math.min(W, (x2 + padX) * W), cy2 = Math.min(H, (y2 + padY) * H);

  const THUMB = 80;
  const thumbCanvas = new OffscreenCanvas(THUMB, THUMB);
  thumbCanvas.getContext("2d").drawImage(detCanvas, cx1, cy1, cx2 - cx1, cy2 - cy1, 0, 0, THUMB, THUMB);

  const blob = await thumbCanvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// ── Full face detect-and-embed pipeline for one image blob ────────────────────
async function detectFacesInBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const D = FACE_DET_SIZE;
  const detCanvas = new OffscreenCanvas(D, D);
  const ctx = detCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, D, D);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, D, D);
  const P = D * D;

  // BGR, 0–255 (no normalisation) — matches model training preprocessing
  const input = new Float32Array(3 * P);
  for (let i = 0; i < P; i++) {
    input[0 * P + i] = data[i * 4 + 2]; // B
    input[1 * P + i] = data[i * 4 + 1]; // G
    input[2 * P + i] = data[i * 4];     // R
  }

  const detector = await ensureDetector();
  const tensor   = new ort.Tensor("float32", input, [1, 3, D, D]);
  const { loc, cls, iou } = await detector.run({ input: tensor });

  const detections = decodeFaceDetections(
    Array.from(loc.data),
    Array.from(cls.data),
    Array.from(iou.data),
    0.5
  );
  if (!detections.length) return [];

  const faces = [];
  for (const det of detections) {
    try {
      const [embedding, thumbnailDataUrl] = await Promise.all([
        extractFaceEmbedding(detCanvas, det.box),
        getFaceThumbnail(detCanvas, det.box),
      ]);
      faces.push({ box: det.box, score: det.score, embedding, thumbnailDataUrl });
    } catch (err) {
      console.warn("[Face] Skipping face due to error:", err.message);
    }
  }
  return faces;
}

// ── Auto-warmup on load ────────────────────────────────────────────────────────
ensureClassifier().catch(() => {});

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (typeof msg?.type !== "string" || !msg.type.startsWith("OFFSCREEN_")) return false;

  (async () => {
    if (msg.type === "OFFSCREEN_PING") {
      sendResponse({ ok: true, runtime: "offscreen-ready", version: OFFSCREEN_RUNTIME_VERSION, supportsOnnxClassifier: true });
      return;
    }

    if (msg.type === "OFFSCREEN_CLASSIFY_FILES") {
      const { files = [], token, parallelism } = msg;
      if (!token) { sendResponse({ ok: false, error: "Missing auth token." }); return; }
      const classified = await classifyBatch(files, token, parallelism);
      sendResponse({ ok: true, files: classified });
      return;
    }

    if (msg.type === "OFFSCREEN_DETECT_FACES") {
      const { file, token, releaseSessions, thumbnailUrl } = msg;
      if (!file?.id) { sendResponse({ ok: false, error: "Missing file." }); return; }

      try {
        let blob;

        if (thumbnailUrl) {
          // ── Fast path: use Drive CDN thumbnail (no auth needed, ~100KB vs ~5MB) ──
          // thumbnailUrl is already sized to w800 — plenty for YuNet (640px) + SFace (112px crop)
          const res = await fetch(thumbnailUrl);
          if (res.ok) {
            blob = await res.blob();
          } else {
            // CDN link expired or unavailable → fall back to authenticated full download
            if (!token) { sendResponse({ ok: false, error: "No token for fallback." }); return; }
            const fallback = await fetch(
              `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!fallback.ok) { sendResponse({ ok: false, error: `Cannot fetch ${file.name}: ${fallback.status}` }); return; }
            blob = await fallback.blob();
          }
        } else {
          // ── Standard path: authenticated full-resolution download ──
          if (!token) { sendResponse({ ok: false, error: "Missing token." }); return; }
          const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!res.ok) { sendResponse({ ok: false, error: `Cannot fetch ${file.name}: ${res.status}` }); return; }
          blob = await res.blob();
        }

        const faces = await detectFacesInBlob(blob);

        // Release the recognizer after the last photo in a batch to free WASM heap
        if (releaseSessions) await releaseRecognizer();

        sendResponse({ ok: true, faces });
      } catch (err) {
        await releaseRecognizer(); // always release on error too
        sendResponse({ ok: false, error: err.message || "Face detection failed." });
      }
      return;
    }

    if (msg.type === "OFFSCREEN_RELEASE_FACE_SESSIONS") {
      await releaseRecognizer();
      sendResponse({ ok: true });
      return;
    }

    // Extract a face embedding from a user-uploaded reference photo (base64 dataURL)
    // Used by the "Find My Photos" feature to build a reference embedding for matching.
    if (msg.type === "OFFSCREEN_EXTRACT_EMBEDDING") {
      const { imageDataUrl } = msg;
      if (!imageDataUrl) { sendResponse({ ok: false, error: "No image data provided." }); return; }
      try {
        const res  = await fetch(imageDataUrl);
        const blob = await res.blob();
        const faces = await detectFacesInBlob(blob);
        await releaseRecognizer();
        if (!faces.length) {
          sendResponse({ ok: false, error: "No face detected in the uploaded photo. Please use a clear, front-facing photo." });
          return;
        }
        // Return the highest-confidence face embedding
        const best = faces.reduce((a, b) => (b.score > a.score ? b : a), faces[0]);
        sendResponse({ ok: true, embedding: best.embedding, thumbnailDataUrl: best.thumbnailDataUrl, facesFound: faces.length });
      } catch (err) {
        await releaseRecognizer();
        sendResponse({ ok: false, error: err.message || "Embedding extraction failed." });
      }
      return;
    }

    sendResponse({ ok: false, error: "Unknown offscreen message type." });
  })().catch((err) => sendResponse({ ok: false, error: err.message || "Offscreen error." }));

  return true;
});
