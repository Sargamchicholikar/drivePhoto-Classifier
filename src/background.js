import { getAuthToken, getAuthTokenWithForcedConsent, fullSignOut, clearCachedToken } from "./auth.js";
import {
  getOrCreateFolder,
  listImageFilesPage,
  listImageFilesInFolderPage,
  listSubfolders,
  moveFileToFolder,
} from "./drive.js";
import { faceDB } from "./face-db.js";

let cachedToken = null;
let offscreenReady = false;
let sortShouldStop = false;

// ── 6-month sort reminder ────────────────────────────────────────────────────
const REMINDER_ALARM    = "photo-sort-reminder";
const AUTO_INDEX_ALARM  = "auto-index-human";
const SIX_MONTHS_MIN    = 6 * 30 * 24 * 60;
const AUTO_INDEX_MIN    = 30;

async function scheduleNextSortReminder() {
  await chrome.storage.local.set({ lastSortTimestamp: Date.now() });
  await chrome.alarms.clear(REMINDER_ALARM);
  chrome.alarms.create(REMINDER_ALARM, { delayInMinutes: SIX_MONTHS_MIN });
}

function scheduleAutoIndex() {
  chrome.alarms.get(AUTO_INDEX_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(AUTO_INDEX_ALARM, { delayInMinutes: AUTO_INDEX_MIN, periodInMinutes: AUTO_INDEX_MIN });
    }
  });
}

// Run incremental face index on new Human folder photos silently in background
async function runAutoIndex() {
  try {
    const silent = await getAuthToken(false);
    if (!silent.ok) return; // not signed in — skip silently
    cachedToken = silent.token;

    await ensureFreshOffscreenRuntime();
    const folders = await ensureFolderTree(cachedToken);

    // List all photos in Human folder
    const allPhotos = [];
    let pt = "";
    do {
      const page = await listImageFilesInFolderPage(cachedToken, folders.human.id, {
        pageToken: pt, pageSize: 100, includeVideos: false,
      });
      for (const f of (page.files || [])) {
        allPhotos.push({ ...f, sourceFolderId: folders.human.id, sourceFolderName: "Human" });
      }
      pt = page.nextPageToken || "";
    } while (pt);

    // Only process photos not yet in faceDB
    const newPhotos = [];
    for (const photo of allPhotos) {
      const done = await faceDB.getPhotoFaces(photo.id);
      if (!done) newPhotos.push(photo);
    }

    if (newPhotos.length === 0) return; // nothing new

    let indexed = 0;
    for (const photo of newPhotos) {
      try {
        const refreshed = await getAuthToken(false);
        if (refreshed.ok) cachedToken = refreshed.token;

        const offRes = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_DETECT_FACES",
          file: photo,
          token: cachedToken,
          releaseSessions: false,
        });

        const faces = offRes?.ok ? (offRes.faces || []) : [];
        const faceIds = [];

        for (let fi = 0; fi < faces.length; fi++) {
          const face   = faces[fi];
          const faceId = `face_${photo.id}_${fi}`;

          const allPersons = await faceDB.getAllPersons();
          let bestPerson = null, bestSim = -1;
          for (const person of allPersons) {
            const sim = cosineSim(face.embedding, person.centroid);
            if (sim > bestSim) { bestSim = sim; bestPerson = person; }
          }

          const CLUSTER_THRESHOLD = 0.50;
          let personId;
          if (bestSim >= CLUSTER_THRESHOLD && bestPerson) {
            const n = bestPerson.photoCount;
            personId = bestPerson.id;
            await faceDB.savePerson({
              ...bestPerson,
              centroid:        centroidUpdate(bestPerson.centroid, face.embedding, n),
              photoCount:      n + 1,
              thumbnailDataUrl: bestPerson.thumbnailDataUrl || face.thumbnailDataUrl,
            });
          } else {
            personId = `person_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            await faceDB.savePerson({
              id: personId, name: null, centroid: face.embedding,
              photoCount: 1, thumbnailDataUrl: face.thumbnailDataUrl, createdAt: Date.now(),
            });
          }

          await faceDB.saveEmbedding({
            id: faceId, photoId: photo.id, photoName: photo.name,
            photoDate: photo.modifiedTime || null,
            sourceFolderId: photo.sourceFolderId, sourceFolderName: photo.sourceFolderName,
            embedding: face.embedding, box: face.box, score: face.score,
            personId, thumbnailDataUrl: face.thumbnailDataUrl,
          });
          faceIds.push(faceId);
        }

        await faceDB.savePhotoFaces({ photoId: photo.id, faceIds, processedAt: Date.now() });
        indexed++;
      } catch (err) {
        await faceDB.savePhotoFaces({ photoId: photo.id, faceIds: [], processedAt: Date.now(), error: err.message });
      }
    }

    if (indexed > 0) {
      chrome.notifications.create("auto-index-done", {
        type:    "basic",
        iconUrl: chrome.runtime.getURL("icons/icon48.png"),
        title:   "Face index updated",
        message: `${indexed} new photo${indexed > 1 ? "s" : ""} added to your face index automatically.`,
        priority: 0,
      });
    }
  } catch (err) {
    console.warn("[AUTO_INDEX] failed:", err.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_INDEX_ALARM) { runAutoIndex(); return; }
  if (alarm.name !== REMINDER_ALARM) return;
  chrome.notifications.create(REMINDER_ALARM, {
    type:     "basic",
    iconUrl:  chrome.runtime.getURL("icons/icon48.png"),
    title:    "Time to sort your photos!",
    message:  "It has been 6 months since your last sort. Open Photo Classifier to organise your Drive photos.",
    priority: 1,
  });
});

chrome.notifications.onClicked.addListener((id) => {
  if (id !== REMINDER_ALARM) return;
  chrome.notifications.clear(id);
  chrome.action.openPopup().catch(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html") });
  });
});

const SORT_SCAN_PAGE_SIZE            = 1000;
const SORT_CLASSIFICATION_CHUNK_SIZE = 25;
const CLASSIFICATION_PARALLELISM     = 4;
const OFFSCREEN_RUNTIME_VERSION      = "onnx-v8-arcface";
const ROOT_FOLDER_NAME               = "Smart Photo Organizer";
const PROCESSED_IDS_KEY              = "processedFileIdsV3";
const MAX_PROCESSED_IDS              = 50000;
const MARGIN_THRESHOLD               = 0.20;
const CORRECTIONS_KEY                = "photoCorrectionsV1";
const LAST_SORT_SUMMARY_KEY          = "lastSortSummaryV1";
const AL_EXAMPLES_KEY                = "alExamplesV1";   // active-learning training set
const AL_PENDING_KEY                 = "alPendingV1";    // logits for current Unsure batch
const AL_KNN_K                       = 5;                // neighbours to vote
const AL_KNN_MIN_SIM                 = 0.97;             // cosine threshold to count as neighbour



async function ensureFreshToken() {
  if (cachedToken) return;
  const silent = await getAuthToken(false);
  if (silent.ok) { cachedToken = silent.token; return; }
  const auth = await getAuthToken(true);
  if (!auth.ok) throw new Error(auth.error || "Sign-in required.");
  cachedToken = auth.token;
}

function emitProgress(payload) {
  chrome.runtime.sendMessage({ type: "PROGRESS_UPDATE", ...payload }).catch(() => {});
}

async function loadProcessedIdSet() {
  const data = await chrome.storage.local.get(PROCESSED_IDS_KEY);
  const ids = Array.isArray(data?.[PROCESSED_IDS_KEY]) ? data[PROCESSED_IDS_KEY] : [];
  return new Set(ids);
}

async function saveProcessedIdSet(idSet) {
  const all = Array.from(idSet);
  const trimmed = all.slice(Math.max(0, all.length - MAX_PROCESSED_IDS));
  await chrome.storage.local.set({ [PROCESSED_IDS_KEY]: trimmed });
}

async function loadCorrections() {
  const data = await chrome.storage.local.get(CORRECTIONS_KEY);
  return data[CORRECTIONS_KEY] || {};
}

async function saveCorrection(fileId, label, originalLabel = null) {
  const data  = await chrome.storage.local.get(CORRECTIONS_KEY);
  const store = data[CORRECTIONS_KEY] || {};
  store[fileId] = { label, originalLabel, timestamp: Date.now() };
  await chrome.storage.local.set({ [CORRECTIONS_KEY]: store });
}

// ── Active Learning: k-NN classifier in logit space ───────────────────────────
// Each training example: { logits: number[4], label: string }
// Stored examples grow every time the user corrects an Unsure photo.
// At sort time, new Unsure candidates are checked against stored examples.
// If k nearest neighbours majority-agree on a label, we use it instead of Unsure.

async function loadALExamples() {
  const data = await chrome.storage.local.get(AL_EXAMPLES_KEY);
  return data[AL_EXAMPLES_KEY] || [];
}

async function saveALExample(logits, label) {
  const data     = await chrome.storage.local.get(AL_EXAMPLES_KEY);
  const examples = data[AL_EXAMPLES_KEY] || [];
  examples.push({ logits, label, timestamp: Date.now() });
  // Keep at most 2000 examples (oldest drop off)
  if (examples.length > 2000) examples.splice(0, examples.length - 2000);
  await chrome.storage.local.set({ [AL_EXAMPLES_KEY]: examples });
}

async function storePendingLogits(fileId, logits) {
  const data    = await chrome.storage.local.get(AL_PENDING_KEY);
  const pending = data[AL_PENDING_KEY] || {};
  pending[fileId] = logits;
  await chrome.storage.local.set({ [AL_PENDING_KEY]: pending });
}

async function popPendingLogits(fileId) {
  const data    = await chrome.storage.local.get(AL_PENDING_KEY);
  const pending = data[AL_PENDING_KEY] || {};
  const logits  = pending[fileId] || null;
  if (logits) {
    delete pending[fileId];
    await chrome.storage.local.set({ [AL_PENDING_KEY]: pending });
  }
  return logits;
}

function cosineSim4(a, b) {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < 4; i++) { dot += a[i]*b[i]; ma += a[i]*a[i]; mb += b[i]*b[i]; }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom > 0 ? dot / denom : 0;
}

// Returns { label, confidence, neighbours } or null if no confident prediction
function knnPredict(logits, examples) {
  if (!examples.length || !logits?.length) return null;

  // Find top-k neighbours by cosine similarity
  const scored = examples.map(ex => ({ label: ex.label, sim: cosineSim4(logits, ex.logits) }));
  scored.sort((a, b) => b.sim - a.sim);
  const neighbours = scored.slice(0, AL_KNN_K).filter(n => n.sim >= AL_KNN_MIN_SIM);

  if (!neighbours.length) return null;

  // Majority vote
  const votes = {};
  for (const n of neighbours) votes[n.label] = (votes[n.label] || 0) + 1;
  const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  const confidence = winner[1] / neighbours.length;

  // Only act if majority agree (>50%)
  if (confidence <= 0.5) return null;
  return { label: winner[0], confidence, neighbours: neighbours.length };
}

async function ensureOffscreenDocument(forceRecreate = false) {
  if (forceRecreate) {
    try { await chrome.offscreen.closeDocument(); } catch (_) {}
    offscreenReady = false;
  }
  if (offscreenReady) return;
  const exists = await chrome.offscreen.hasDocument?.();
  if (exists) { offscreenReady = true; return; }
  await chrome.offscreen.createDocument({
    url: `offscreen/offscreen.html?v=${encodeURIComponent(OFFSCREEN_RUNTIME_VERSION)}`,
    reasons: ["WORKERS"],
    justification: "Hosts offline ML model runtime for photo classification.",
  });
  offscreenReady = true;
}

async function pingOffscreen() {
  return chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
}

async function ensureFreshOffscreenRuntime() {
  await ensureOffscreenDocument();
  let pingRes = null;
  try { pingRes = await pingOffscreen(); } catch (_) { pingRes = null; }
  const isHealthy = Boolean(pingRes?.ok && pingRes.version === OFFSCREEN_RUNTIME_VERSION);
  if (isHealthy) return;
  await ensureOffscreenDocument(true);
  const secondPing = await pingOffscreen();
  if (!secondPing?.ok) throw new Error("Offscreen runtime is not responding.");
  if (secondPing.version !== OFFSCREEN_RUNTIME_VERSION) throw new Error("Stale offscreen runtime version.");
}

async function ensureFolderTree(token) {
  const root    = await getOrCreateFolder(token, ROOT_FOLDER_NAME);
  const junk    = await getOrCreateFolder(token, "Junk",         root.id);
  const animals = await getOrCreateFolder(token, "Animals",      root.id);
  const human   = await getOrCreateFolder(token, "Human",        root.id);
  const group   = await getOrCreateFolder(token, "Group Photos", root.id);
  const videos  = await getOrCreateFolder(token, "Videos",       root.id);
  const unsure  = await getOrCreateFolder(token, "Unsure",       root.id);
  return { root, junk, animals, human, group, videos, unsure };
}

function probMargin(probs) {
  if (!Array.isArray(probs) || probs.length < 2) return 0;
  const sorted = [...probs].sort((a, b) => b - a);
  return sorted[0] - sorted[1];
}

// ── Per-class adaptive thresholds (Option 1 learning) ────────────────────────
// All corrections come from the UNSURE folder review — the user manually sorts
// photos that the model was uncertain about (margin < 0.20).
//
// What each correction tells us:
//   "The model predicted class X but with LOW confidence (< 0.20 margin).
//    The correct answer WAS class X."
//   → The model is systematically UNDERCONFIDENT about class X.
//   → We should LOWER class X's threshold so future predictions of X
//     with slightly lower confidence go straight to folder X, not Unsure.
//
// Formula:
//   threshold[cls] = BASE(0.20) - (correctedTo[cls] × 0.004)
//   Minimum threshold: 0.13 (never commit on very low confidence)
//   Maximum reduction: 0.07 (at ~18 corrections, threshold reaches 0.13)
//
// Example:
//   15 Unsure photos corrected to "Group"
//   → threshold[group] = 0.20 - (15 × 0.004) = 0.14
//   → Photos where model says Group with 86%+ confidence (margin ≥ 0.14)
//     now go straight to Group instead of Unsure
//   → Fewer Group photos stuck in the Unsure folder

const THRESHOLD_STEP    = 0.004;  // reduction per correction
const THRESHOLD_MIN     = 0.13;   // floor for animals/group/junk
const THRESHOLD_MIN_HUMAN = 0.18; // stricter floor for human — false positives here
                                   // are more noticeable (wrong person in Human folder)

async function getAdaptiveThresholds() {
  const corrections = await loadCorrections();

  // Count how many Unsure photos were corrected TO each class.
  // c.label = the class the user assigned (correctedLabel from Unsure review)
  const correctedTo = { animals: 0, group: 0, human: 0, junk: 0 };
  for (const c of Object.values(corrections)) {
    if (c.label && correctedTo[c.label] !== undefined) correctedTo[c.label]++;
  }

  // Lower threshold for frequently-corrected classes
  const thresholds = {};
  for (const cls of ["animals", "group", "human", "junk"]) {
    const reduction = correctedTo[cls] * THRESHOLD_STEP;
    const floor = cls === "human" ? THRESHOLD_MIN_HUMAN : THRESHOLD_MIN;
    thresholds[cls] = Math.max(floor, MARGIN_THRESHOLD - reduction);
  }
  return thresholds;
}

function resolveTargetFolder(file, folders, thresholds = null) {
  if (String(file.mimeType || "").startsWith("video/")) {
    return { id: folders.videos.id, label: "Smart Photo Organizer/Videos" };
  }
  if (!file.corrected) {
    const margin    = probMargin(file.probs);
    // Use the per-class adaptive threshold if available, otherwise base threshold
    const threshold = thresholds?.[file.category] ?? MARGIN_THRESHOLD;
    if (margin < threshold) {
      return { id: folders.unsure.id, label: "Smart Photo Organizer/Unsure" };
    }
  }
  if (file.category === "group")   return { id: folders.group.id,   label: "Smart Photo Organizer/Group Photos" };
  if (file.category === "human")   return { id: folders.human.id,   label: "Smart Photo Organizer/Human"        };
  if (file.category === "animals") return { id: folders.animals.id, label: "Smart Photo Organizer/Animals"      };
  if (file.category === "junk")    return { id: folders.junk.id,    label: "Smart Photo Organizer/Junk"         };
  return { id: folders.unsure.id, label: "Smart Photo Organizer/Unsure" };
}

async function classifyInChunks(files, token, chunkSize, progress = null) {
  const classified = [];
  const total = files.length;
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    const offscreenRes = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_CLASSIFY_FILES",
      files: chunk,
      token,
      parallelism: CLASSIFICATION_PARALLELISM,
    });
    if (!offscreenRes?.ok) throw new Error(offscreenRes?.error || "Offscreen classification failed.");
    classified.push(...(offscreenRes.files || []));
    if (progress) progress({ processed: Math.min(i + chunk.length, total), total });
  }
  return classified;
}

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureOffscreenDocument();
  scheduleAutoIndex();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreenDocument();
  scheduleAutoIndex();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (typeof msg?.type === "string" && msg.type.startsWith("OFFSCREEN_")) {
    return false;
  }

  (async () => {

    if (msg.type === "_INTERNAL_TOKEN_REFRESHED") {
      if (msg.token) cachedToken = msg.token;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "GET_AUTH_STATUS") {
      if (cachedToken) { sendResponse({ ok: true, isSignedIn: true }); return; }
      const silent = await getAuthToken(false);
      if (silent.ok) {
        cachedToken = silent.token;
        sendResponse({ ok: true, isSignedIn: true });
      } else {
        sendResponse({ ok: true, isSignedIn: false });
      }
      return;
    }

    if (msg.type === "AUTH_SIGN_OUT") {
      cachedToken = null;
      await fullSignOut();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "AUTH_SIGN_IN") {
      cachedToken = null;
      await fullSignOut();
      const auth = await getAuthTokenWithForcedConsent();
      if (!auth.ok) { sendResponse(auth); return; }
      cachedToken = auth.token;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "GET_AUTH_TOKEN") {
      if (!cachedToken) {
        const authSilent = await getAuthToken(false);
        if (authSilent.ok) cachedToken = authSilent.token;
      }
      if (!cachedToken) {
        const authInteractive = await getAuthToken(true);
        if (!authInteractive.ok) {
          sendResponse({ ok: false, error: authInteractive.error || "Not signed in." });
          return;
        }
        cachedToken = authInteractive.token;
      }
      sendResponse({ ok: true, token: cachedToken });
      return;
    }

    if (msg.type === "DRIVE_CLASSIFY_AND_SORT") {
      try { await ensureFreshToken(); } catch (e) { sendResponse({ ok: false, error: e.message }); return; }

      try {
        emitProgress({ operation: "sort", stage: "scan", processed: 0, total: 1, message: "Scanning Drive for photos…" });
        sortShouldStop = false;
        await ensureFreshOffscreenRuntime();
        const folders = await ensureFolderTree(cachedToken);
        let pageToken = "";
        let scannedTotal = 0, classifiedTotal = 0, movedCount = 0;
        let moveFailedCount = 0, skippedAlreadyProcessed = 0, skippedAlreadyInTarget = 0;
        const categoryCounts = { animals: 0, humanSingle: 0, humanGroup: 0, junk: 0, videos: 0, unsure: 0 };
        const categorySizes  = { animals: 0, humanSingle: 0, humanGroup: 0, junk: 0, videos: 0, unsure: 0 };
        const uncertainFiles = [];
        const processedIdSet = await loadProcessedIdSet();
        const corrections    = await loadCorrections();
        const alExamples     = await loadALExamples();   // k-NN training set
        // Load adaptive thresholds once — computed from all past user corrections.
        // Classes that have been corrected more often require higher confidence
        // before committing, so borderline photos go to Unsure for human review.
        const adaptiveThresholds = await getAdaptiveThresholds();

        do {
          const refreshed = await getAuthToken(false);
          if (refreshed.ok) cachedToken = refreshed.token;

          // Exclude all Smart Photo Organizer sub-folders so already-sorted
          // photos are never accidentally re-classified during a normal sort.
          const excludeParentIds = [
            folders.root.id, folders.human.id, folders.group.id,
            folders.animals.id, folders.junk.id, folders.unsure.id,
            folders.videos.id,
          ];
          const page = await listImageFilesPage(cachedToken, {
            pageToken, pageSize: SORT_SCAN_PAGE_SIZE, includeVideos: true,
            excludeParentIds,
          });
          const pageFiles = page.files || [];
          if (!pageFiles.length) { pageToken = ""; break; }

          scannedTotal += pageFiles.length;

          // Split into new (unprocessed) and already-done files up front.
          // Already-processed files are skipped entirely — no re-classification needed.
          const newFiles   = pageFiles.filter(f => !processedIdSet.has(f.id));
          const skipCount  = pageFiles.length - newFiles.length;
          skippedAlreadyProcessed += skipCount;

          const videoFiles = newFiles.filter((f) => String(f.mimeType || "").startsWith("video/"));
          const imageFiles = newFiles.filter((f) => String(f.mimeType || "").startsWith("image/"));

          emitProgress({
            operation: "sort", stage: "classify",
            processed: scannedTotal - pageFiles.length, total: scannedTotal,
            message: `Classifying ${imageFiles.length} new images…`,
          });

          const moveClassifiedBatch = async (classifiedBatch) => {
            for (const file of classifiedBatch) {
              if (sortShouldStop) { await saveProcessedIdSet(processedIdSet); return; }
              if (processedIdSet.has(file.id)) { skippedAlreadyProcessed += 1; continue; }

              const corr = corrections[file.id];
              let eff = corr ? { ...file, category: corr.label, confidence: 1.0, corrected: true } : file;

              // ── Active Learning: k-NN override before sending to Unsure ──────
              if (!eff.corrected && eff.rawLogits?.length && alExamples.length) {
                const pred = knnPredict(eff.rawLogits, alExamples);
                if (pred) {
                  eff = { ...eff, category: pred.label, confidence: pred.confidence, alOverride: true };
                }
              }

              const targetFolder = resolveTargetFolder(eff, folders, adaptiveThresholds);
              const fileBytes = Number(eff.size || 0);

              if (String(eff.mimeType || "").startsWith("video/"))       { categoryCounts.videos      += 1; categorySizes.videos      += fileBytes; }
              else if (targetFolder.label.endsWith("/Unsure"))            { categoryCounts.unsure      += 1; categorySizes.unsure      += fileBytes; }
              else if (eff.category === "animals")                        { categoryCounts.animals     += 1; categorySizes.animals     += fileBytes; }
              else if (eff.category === "group")                          { categoryCounts.humanGroup  += 1; categorySizes.humanGroup  += fileBytes; }
              else if (eff.category === "human")                          { categoryCounts.humanSingle += 1; categorySizes.humanSingle += fileBytes; }
              else                                                        { categoryCounts.junk        += 1; categorySizes.junk        += fileBytes; }

              if (targetFolder.label.endsWith("/Unsure") && !eff.corrected && !String(eff.mimeType || "").startsWith("video/")) {
                uncertainFiles.push({ id: file.id, name: file.name, category: eff.category || "unknown", confidence: Math.round((eff.confidence || 0) * 100) });
                // Store logits so APPLY_CORRECTION can save them as a training example
                if (eff.rawLogits?.length) storePendingLogits(file.id, eff.rawLogits);
              }

              try {
                const moveRes = await moveFileToFolder(cachedToken, file.id, targetFolder.id);
                if (moveRes?.skipped) skippedAlreadyInTarget += 1;
                else movedCount += 1;
                processedIdSet.add(file.id);
              } catch (_) { moveFailedCount += 1; }

              emitProgress({
                operation: "sort", stage: "move",
                processed: movedCount + moveFailedCount + skippedAlreadyInTarget + skippedAlreadyProcessed,
                total: Math.max(1, classifiedTotal),
                message: `Moving ${movedCount + moveFailedCount}/${classifiedTotal} (skipped ${skippedAlreadyInTarget + skippedAlreadyProcessed})`,
                categoryCounts: { ...categoryCounts },
                categorySizes:  { ...categorySizes },
              });
            }
          };

          const imageChunks = [];
          for (let i = 0; i < imageFiles.length; i += SORT_CLASSIFICATION_CHUNK_SIZE) {
            imageChunks.push(imageFiles.slice(i, i + SORT_CLASSIFICATION_CHUNK_SIZE));
          }

          const classifiedVideos = videoFiles.map((f) => ({ ...f, category: "video", confidence: 1, label: "video_detected" }));
          classifiedTotal += classifiedVideos.length;

          let pendingMovePromise = classifiedVideos.length ? moveClassifiedBatch(classifiedVideos) : null;
          let nextClassifyPromise = null;
          let imageProcessedWithinPage = 0;

          if (imageChunks.length) {
            nextClassifyPromise = classifyInChunks(imageChunks[0], cachedToken, SORT_CLASSIFICATION_CHUNK_SIZE, ({ processed, total }) => {
              emitProgress({ operation: "sort", stage: "classify", processed: classifiedTotal + imageProcessedWithinPage + processed, total: Math.max(classifiedTotal + imageProcessedWithinPage + total, scannedTotal), message: `Classifying images ${classifiedTotal + imageProcessedWithinPage + processed}` });
            });
          }

          for (let chunkIndex = 0; chunkIndex < imageChunks.length; chunkIndex++) {
            const classifiedChunk = await nextClassifyPromise;
            imageProcessedWithinPage += classifiedChunk.length;
            classifiedTotal += classifiedChunk.length;
            const hasNext = chunkIndex + 1 < imageChunks.length;
            if (hasNext) {
              nextClassifyPromise = classifyInChunks(imageChunks[chunkIndex + 1], cachedToken, SORT_CLASSIFICATION_CHUNK_SIZE, ({ processed, total }) => {
                emitProgress({ operation: "sort", stage: "classify", processed: classifiedTotal + processed, total: Math.max(classifiedTotal + total, scannedTotal), message: `Classifying images ${classifiedTotal + processed}` });
              });
            }
            const movePromise = moveClassifiedBatch(classifiedChunk);
            if (pendingMovePromise) await pendingMovePromise;
            pendingMovePromise = movePromise;
          }

          if (pendingMovePromise) await pendingMovePromise;
          pageToken = sortShouldStop ? "" : (page.nextPageToken || "");
        } while (pageToken);

        emitProgress({ operation: "sort", stage: "done", processed: 1, total: 1, message: sortShouldStop ? "Sort stopped — progress saved." : "Sorting complete." });
        await saveProcessedIdSet(processedIdSet);
        await scheduleNextSortReminder();

        const folderTree = {
          root:    { id: folders.root.id,    label: "Smart Photo Organizer" },
          junk:    { id: folders.junk.id,    label: "Smart Photo Organizer/Junk" },
          animals: { id: folders.animals.id, label: "Smart Photo Organizer/Animals" },
          human:   { id: folders.human.id,   label: "Smart Photo Organizer/Human" },
          group:   { id: folders.group.id,   label: "Smart Photo Organizer/Group Photos" },
          videos:  { id: folders.videos.id,  label: "Smart Photo Organizer/Videos" },
          unsure:  { id: folders.unsure.id,  label: "Smart Photo Organizer/Unsure" },
        };

        // Persist summary so the popup can restore it on any future re-open
        const sortSummary = {
          categoryCounts, categorySizes,
          movedCount, scannedTotal, moveFailedCount,
          skippedAlreadyProcessed, skippedAlreadyInTarget,
          wasStopped: sortShouldStop,
          timestamp: Date.now(),
          folders: folderTree,
        };
        await chrome.storage.local.set({ [LAST_SORT_SUMMARY_KEY]: sortSummary });

        // Note: the full Unsure folder listing is done by GET_UNSURE_FILES
        // (called by autoLaunchUnsureReview in the popup) — no cap, all pages.
        sendResponse({
          ok: true,
          uncertainFiles,
          summary: { scannedTotal, classifiedTotal, movedCount, moveFailedCount, skippedAlreadyProcessed, skippedAlreadyInTarget, categoryCounts, categorySizes, wasStopped: sortShouldStop },
          folders: folderTree,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    if (msg.type === "CLEAR_PROCESSED_IDS") {
      await chrome.storage.local.remove([PROCESSED_IDS_KEY]);
      sendResponse({ ok: true });
      return;
    }

    // ── Re-sort: re-classify photos already inside Smart Photo Organizer ───────
    // Only scans Human / Group / Animals / Junk / Unsure sub-folders.
    // Videos are never re-classified (they stay in Videos/).
    // This does NOT touch photos outside Smart Photo Organizer.
    if (msg.type === "RESORT_SMART_ORGANIZER") {
      try {
        await ensureFreshToken();
        sortShouldStop = false;
        emitProgress({ operation: "sort", stage: "scan", processed: 0, total: 1, message: "Scanning Smart Photo Organizer…" });

        await ensureFreshOffscreenRuntime();
        const folders = await ensureFolderTree(cachedToken);
        const corrections    = await loadCorrections();
        const adaptiveThresholds = await getAdaptiveThresholds();

        // Collect all images from all subfolders under Smart Photo Organizer root
        // (the 5 standard folders, all People subfolders, plus any custom folders)
        const peopleRoot     = await getOrCreateFolder(cachedToken, "People", folders.root.id);
        const personFolders  = await listSubfolders(cachedToken, peopleRoot.id);
        const rootSubfolders = await listSubfolders(cachedToken, folders.root.id);

        // Known folder IDs to avoid duplicates
        const knownIds = new Set([
          folders.human.id, folders.group.id, folders.animals.id,
          folders.junk.id, folders.unsure.id, folders.videos.id,
          peopleRoot.id,
        ]);
        const extraFolders = rootSubfolders.filter(f => !knownIds.has(f.id));

        const RESORT_FOLDERS = [
          folders.human, folders.group, folders.animals,
          folders.junk,  folders.unsure,
          ...personFolders,
          ...extraFolders,
        ];

        let allFiles = [];
        for (const folder of RESORT_FOLDERS) {
          let pt = "";
          do {
            const refreshed = await getAuthToken(false);
            if (refreshed.ok) cachedToken = refreshed.token;
            const page = await listImageFilesInFolderPage(cachedToken, folder.id, {
              pageToken: pt, pageSize: SORT_SCAN_PAGE_SIZE, includeVideos: false,
            });
            allFiles = allFiles.concat(page.files || []);
            pt = page.nextPageToken || "";
          } while (pt && !sortShouldStop);
        }

        // Use CDN thumbnails for classification — same ~40x speedup as face detection
        allFiles = allFiles.map(f => ({
          ...f,
          downloadUrl: f.thumbnailLink
            ? f.thumbnailLink.replace(/=s\d+$/, "=w800").replace(/=w\d+$/, "=w800")
            : undefined,
        }));

        emitProgress({ operation: "sort", stage: "classify", processed: 0, total: allFiles.length, message: `Re-classifying ${allFiles.length} photos…` });

        let movedCount = 0, moveFailedCount = 0, skippedAlreadyInTarget = 0;
        const categoryCounts = { animals: 0, humanSingle: 0, humanGroup: 0, junk: 0, videos: 0, unsure: 0 };
        const categorySizes  = { animals: 0, humanSingle: 0, humanGroup: 0, junk: 0, videos: 0, unsure: 0 };
        const uncertainFiles = [];
        const processedIdSet = await loadProcessedIdSet();

        // Classify in chunks and move each chunk immediately (interleaved pipeline)
        for (let i = 0; i < allFiles.length; i += SORT_CLASSIFICATION_CHUNK_SIZE) {
          if (sortShouldStop) break;
          const chunk = allFiles.slice(i, i + SORT_CLASSIFICATION_CHUNK_SIZE);

          const refreshed = await getAuthToken(false);
          if (refreshed.ok) cachedToken = refreshed.token;

          const classified = await classifyInChunks(chunk, cachedToken, SORT_CLASSIFICATION_CHUNK_SIZE);

          for (const file of classified) {
            if (sortShouldStop) break;
            const corr = corrections[file.id];
            const eff  = corr ? { ...file, category: corr.label, confidence: 1.0, corrected: true } : file;
            const targetFolder = resolveTargetFolder(eff, folders, adaptiveThresholds);
            const fileBytes = Number(eff.size || 0);

            if (targetFolder.label.endsWith("/Unsure"))      { categoryCounts.unsure      += 1; categorySizes.unsure      += fileBytes; }
            else if (eff.category === "animals")             { categoryCounts.animals     += 1; categorySizes.animals     += fileBytes; }
            else if (eff.category === "group")               { categoryCounts.humanGroup  += 1; categorySizes.humanGroup  += fileBytes; }
            else if (eff.category === "human")               { categoryCounts.humanSingle += 1; categorySizes.humanSingle += fileBytes; }
            else                                             { categoryCounts.junk        += 1; categorySizes.junk        += fileBytes; }

            if (targetFolder.label.endsWith("/Unsure") && !eff.corrected) {
              uncertainFiles.push({ id: file.id, name: file.name, category: eff.category || "unknown", confidence: Math.round((eff.confidence || 0) * 100) });
            }

            try {
              const moveRes = await moveFileToFolder(cachedToken, file.id, targetFolder.id);
              if (moveRes?.skipped) skippedAlreadyInTarget += 1;
              else { movedCount += 1; processedIdSet.add(file.id); }
            } catch (_) { moveFailedCount += 1; }

            emitProgress({
              operation: "sort", stage: "move",
              processed: movedCount + moveFailedCount + skippedAlreadyInTarget,
              total: allFiles.length,
              message: `Re-sorting: ${movedCount + moveFailedCount}/${allFiles.length}`,
              categoryCounts: { ...categoryCounts },
              categorySizes:  { ...categorySizes },
            });
          }
        }

        await saveProcessedIdSet(processedIdSet);
        emitProgress({ operation: "sort", stage: "done", processed: 1, total: 1, message: sortShouldStop ? "Re-sort stopped." : "Re-sort complete." });

        const folderTree = {
          root:    { id: folders.root.id,    label: "Smart Photo Organizer" },
          junk:    { id: folders.junk.id,    label: "Smart Photo Organizer/Junk" },
          animals: { id: folders.animals.id, label: "Smart Photo Organizer/Animals" },
          human:   { id: folders.human.id,   label: "Smart Photo Organizer/Human" },
          group:   { id: folders.group.id,   label: "Smart Photo Organizer/Group Photos" },
          videos:  { id: folders.videos.id,  label: "Smart Photo Organizer/Videos" },
          unsure:  { id: folders.unsure.id,  label: "Smart Photo Organizer/Unsure" },
        };

        const sortSummary = {
          categoryCounts, categorySizes,
          movedCount, scannedTotal: allFiles.length, moveFailedCount,
          skippedAlreadyProcessed: 0, skippedAlreadyInTarget,
          wasStopped: sortShouldStop,
          timestamp: Date.now(),
          folders: folderTree,
        };
        await chrome.storage.local.set({ [LAST_SORT_SUMMARY_KEY]: sortSummary });

        sendResponse({
          ok: true,
          uncertainFiles,
          summary: { scannedTotal: allFiles.length, movedCount, moveFailedCount, skippedAlreadyInTarget, categoryCounts, categorySizes, wasStopped: sortShouldStop },
          folders: folderTree,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    if (msg.type === "APPLY_CORRECTION") {
      const { fileId, correctedLabel, originalLabel } = msg;
      if (!fileId || !correctedLabel) { sendResponse({ ok: false, error: "fileId and correctedLabel are required." }); return; }
      try {
        await ensureFreshToken();
        await saveCorrection(fileId, correctedLabel, originalLabel);

        // ── Active Learning: save logits + label as a training example ─────────
        const pendingLogits = await popPendingLogits(fileId);
        if (pendingLogits) {
          await saveALExample(pendingLogits, correctedLabel);
        }

        const folders  = await ensureFolderTree(cachedToken);
        const labelMap = { human: folders.human, group: folders.group, animals: folders.animals, junk: folders.junk };
        const targetFolder = labelMap[correctedLabel] ?? folders.unsure;
        await moveFileToFolder(cachedToken, fileId, targetFolder.id);

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    if (msg.type === "EXPORT_CORRECTIONS") {
      const corrections = await loadCorrections();
      sendResponse({ ok: true, corrections });
      return;
    }

    if (msg.type === "GET_MODEL_INFO") {
      const corrections = await loadCorrections();
      const alExamples  = await loadALExamples();
      const { lastSortTimestamp } = await chrome.storage.local.get("lastSortTimestamp");
      const stored = await chrome.storage.local.get(LAST_SORT_SUMMARY_KEY);
      const lastSortSummary = stored[LAST_SORT_SUMMARY_KEY] || null;
      sendResponse({
        ok: true,
        runtimeVersion: OFFSCREEN_RUNTIME_VERSION,
        correctionsCount: Object.keys(corrections).length,
        alExamplesCount: alExamples.length,
        lastSortTimestamp: lastSortTimestamp || null,
        lastSortSummary,
      });
      return;
    }


    if (msg.type === "RELOAD_OFFSCREEN") {
      await ensureOffscreenDocument(true);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "STOP_SORT") {
      sortShouldStop = true;
      sendResponse({ ok: true });
      return;
    }

    // ── Fetch all images from the Unsure folder for post-sort review ───────────
    if (msg.type === "GET_UNSURE_FILES") {
      try {
        await ensureFreshToken();
        const folders = await ensureFolderTree(cachedToken);
        const unsureFolderId = folders.unsure.id;

        // Fetch ALL files from the Unsure folder across as many pages as needed.
        // Each page returns up to 100 file metadata records (no image data),
        // so even 2,000 unsure files only costs ~20 lightweight API calls.
        const allFiles = [];
        let pt = "";
        do {
          const page = await listImageFilesInFolderPage(
            cachedToken, unsureFolderId,
            { pageToken: pt, pageSize: 100, includeVideos: false }
          );
          allFiles.push(...(page.files || []));
          pt = page.nextPageToken || "";

          // Emit progress so the popup can show "Loading X unsure photos…"
          // while pagination is still running for large folders.
          try {
            chrome.runtime.sendMessage({
              type: "UNSURE_LOAD_PROGRESS",
              loaded: allFiles.length,
              done: !pt,
            }).catch(() => {});
          } catch (_) {}

        } while (pt);   // ← no cap — fetch every page until Drive says there are no more

        // Build a larger thumbnail URL from Google's CDN link
        const files = allFiles.map(f => ({
          id:           f.id,
          name:         f.name,
          // Replace the size suffix (=s72 or similar) with =s400 for a clear preview
          thumbnailUrl: f.thumbnailLink
            ? f.thumbnailLink.replace(/=s\d+$/, "=s400")
            : null,
        }));

        sendResponse({ ok: true, files, total: allFiles.length, folderId: unsureFolderId });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    // ── Face scan: detect faces in Human + Group folders ───────────────────────
    if (msg.type === "SCAN_FACES") {
      // Respond immediately — the scan runs in background and emits PROGRESS_UPDATE events.
      // This prevents the Chrome message channel from timing out on large photo libraries.
      sendResponse({ ok: true, started: true });

      (async () => {
      try {
        await ensureFreshToken();
        await ensureFreshOffscreenRuntime();

        const folders = await ensureFolderTree(cachedToken);

        // Track which folder each photo came from so we can store it in faceDB
        const foldersToScan = [
          { id: folders.human.id, name: "Human" },
        ];
        const allPhotos = []; // each entry: { ...fileFields, sourceFolderId, sourceFolderName }

        for (const folder of foldersToScan) {
          let pt = "";
          do {
            const page = await listImageFilesInFolderPage(cachedToken, folder.id, {
              pageToken: pt, pageSize: 100, includeVideos: false,
            });
            for (const f of (page.files || [])) {
              allPhotos.push({ ...f, sourceFolderId: folder.id, sourceFolderName: folder.name });
            }
            pt = page.nextPageToken || "";
          } while (pt);
        }

        emitProgress({ operation: "faces", stage: "scan", processed: 0, total: allPhotos.length, message: `Found ${allPhotos.length} photos to scan for faces…` });

        let processed = 0;
        for (const photo of allPhotos) {
          if (sortShouldStop) break;

          const alreadyDone = await faceDB.getPhotoFaces(photo.id);
          if (alreadyDone) { processed++; continue; }

          emitProgress({ operation: "faces", stage: "scan", processed, total: allPhotos.length, message: `Scanning faces: ${processed}/${allPhotos.length}` });

          try {
            const refreshed = await getAuthToken(false);
            if (refreshed.ok) cachedToken = refreshed.token;

            const isLastPhoto = (processed === allPhotos.length);
            const offRes = await chrome.runtime.sendMessage({
              type: "OFFSCREEN_DETECT_FACES",
              file: photo,
              token: cachedToken,
              releaseSessions: isLastPhoto, // free 37MB recognizer after last photo
            });

            const faces = offRes?.ok ? (offRes.faces || []) : [];
            const faceIds = [];

            for (let fi = 0; fi < faces.length; fi++) {
              const face   = faces[fi];
              const faceId = `face_${photo.id}_${fi}`;

              const allPersons = await faceDB.getAllPersons();
              let bestPerson = null, bestSim = -1;

              for (const person of allPersons) {
                const sim = cosineSim(face.embedding, person.centroid);
                if (sim > bestSim) { bestSim = sim; bestPerson = person; }
              }

              const CLUSTER_THRESHOLD = 0.50; // balanced: fewer missed groupings vs. false merges
              let personId;

              if (bestSim >= CLUSTER_THRESHOLD && bestPerson) {
                // Merge into existing person cluster — update centroid as running mean
                const n = bestPerson.photoCount;
                const newCentroid = centroidUpdate(bestPerson.centroid, face.embedding, n);
                personId = bestPerson.id;
                await faceDB.savePerson({
                  ...bestPerson,
                  centroid:       newCentroid,
                  photoCount:     n + 1,
                  thumbnailDataUrl: bestPerson.thumbnailDataUrl || face.thumbnailDataUrl,
                });
              } else {
                // New unknown person
                personId = `person_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                await faceDB.savePerson({
                  id:              personId,
                  name:            null,
                  centroid:        face.embedding,
                  photoCount:      1,
                  thumbnailDataUrl: face.thumbnailDataUrl,
                  createdAt:       Date.now(),
                });
              }

              await faceDB.saveEmbedding({
                id:               faceId,
                photoId:          photo.id,
                photoName:        photo.name,
                photoDate:        photo.modifiedTime || null,
                sourceFolderId:   photo.sourceFolderId   || null,
                sourceFolderName: photo.sourceFolderName || null,
                embedding:        face.embedding,
                box:              face.box,
                score:            face.score,
                personId,
                thumbnailDataUrl: face.thumbnailDataUrl,
              });

              faceIds.push(faceId);
            }

            await faceDB.savePhotoFaces({ photoId: photo.id, faceIds, processedAt: Date.now() });
          } catch (err) {
            console.warn("[SCAN_FACES] Error on photo", photo.name, err.message);
            await faceDB.savePhotoFaces({ photoId: photo.id, faceIds: [], processedAt: Date.now(), error: err.message });
          }

          processed++;
        }

        emitProgress({ operation: "faces", stage: "done", processed: allPhotos.length, total: allPhotos.length, message: "Face scan complete." });

        const indexed = await faceDB.getAllEmbeddings();
        emitProgress({ operation: "faces", stage: "done", processed: allPhotos.length, total: allPhotos.length, message: `Face scan complete — ${indexed.length} faces indexed.`, indexed: indexed.length });
      } catch (err) {
        emitProgress({ operation: "faces", stage: "error", processed: 0, total: 0, message: `Face scan failed: ${err.message}` });
      }
      })();
      return;
    }

    // ── Build People Albums in Drive (+ smart event albums) ────────────────────
    if (msg.type === "BUILD_PEOPLE_ALBUMS") {
      try {
        await ensureFreshToken();
        const persons    = await faceDB.getAllPersons();
        // Only build albums for starred persons (important people selected by user)
        // Fall back to all named persons if no one is starred yet
        const starred    = persons.filter(p => p.starred && p.name);
        const named      = starred.length
          ? starred
          : persons.filter(p => p.name && p.photoCount >= 1);
        if (!named.length) { sendResponse({ ok: true, results: [], message: "Star at least one person or name them first." }); return; }

        const root       = await getOrCreateFolder(cachedToken, ROOT_FOLDER_NAME);
        const peopleRoot = await getOrCreateFolder(cachedToken, "People", root.id);
        const results    = [];

        for (const person of named) {
          const personFolder = await getOrCreateFolder(cachedToken, person.name, peopleRoot.id);
          const embeddings   = await faceDB.getEmbeddingsByPerson(person.id);
          const photoIds     = [...new Set(embeddings.map(e => e.photoId))];

          // ── Smart event detection: group this person's photos by month ────────
          // Photos within the same calendar month form an event.
          // Events with ≥ 3 photos get their own sub-album: "PersonName – Mon YYYY"
          const monthBuckets = {};
          for (const emb of embeddings) {
            if (!emb.photoDate) continue;
            const d    = new Date(emb.photoDate);
            const key  = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const label = d.toLocaleString("en", { month: "short", year: "numeric" });
            (monthBuckets[key] = monthBuckets[key] || { label, photoIds: new Set() }).photoIds.add(emb.photoId);
          }

          // Build a map of photoId → sourceFolderId so we know exactly
          // which parent folder to detach each photo from during the move
          const photoSourceMap = {};
          for (const emb of embeddings) {
            if (emb.photoId && emb.sourceFolderId) {
              photoSourceMap[emb.photoId] = emb.sourceFolderId;
            }
          }

          let moved = 0;
          for (const photoId of photoIds) {
            try {
              await moveFileToFolder(cachedToken, photoId, personFolder.id);
              moved++;
            } catch (_) {}
          }

          // Create event sub-albums for months with ≥ 3 photos
          const events = [];
          for (const [, bucket] of Object.entries(monthBuckets)) {
            if (bucket.photoIds.size < 3) continue;
            const evtName   = `${person.name} – ${bucket.label}`;
            const evtFolder = await getOrCreateFolder(cachedToken, evtName, peopleRoot.id);
            let evtMoved = 0;
            for (const pid of bucket.photoIds) {
              try { await moveFileToFolder(cachedToken, pid, evtFolder.id); evtMoved++; } catch (_) {}
            }
            events.push({ name: evtName, photosMoved: evtMoved, folderId: evtFolder.id });
          }

          results.push({ personId: person.id, name: person.name, photosMoved: moved, folderId: personFolder.id, events });
        }

        sendResponse({ ok: true, results });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Get all people (for popup rendering) ───────────────────────────────────
    if (msg.type === "GET_PEOPLE") {
      try {
        const persons    = await faceDB.getAllPersons();
        const embeddings = await faceDB.getAllEmbeddings();

        // Aggregate which source folders each person's photos came from
        const personFolderNames = {};
        for (const emb of embeddings) {
          if (!emb.sourceFolderName || !emb.personId) continue;
          if (!personFolderNames[emb.personId]) personFolderNames[emb.personId] = new Set();
          personFolderNames[emb.personId].add(emb.sourceFolderName);
        }

        sendResponse({
          ok: true,
          persons: persons
            .sort((a, b) => b.photoCount - a.photoCount) // most-seen first
            .map(p => ({
              id:               p.id,
              name:             p.name,
              photoCount:       p.photoCount,
              starred:          p.starred || false,
              thumbnailDataUrl: p.thumbnailDataUrl,
              // e.g. ["Human", "Group"] — which folders this person appears in
              sourceFolders:    Array.from(personFolderNames[p.id] || []),
            })),
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Rename a person cluster ────────────────────────────────────────────────
    if (msg.type === "RENAME_PERSON") {
      const { personId, name } = msg;
      if (!personId) { sendResponse({ ok: false, error: "personId required." }); return; }
      try {
        const person = await faceDB.getPerson(personId);
        if (!person) { sendResponse({ ok: false, error: "Person not found." }); return; }
        await faceDB.savePerson({ ...person, name: name || null });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Star / unstar a person (mark as important) ────────────────────────────
    if (msg.type === "TOGGLE_STAR") {
      const { personId, starred } = msg;
      if (!personId) { sendResponse({ ok: false, error: "personId required." }); return; }
      try {
        await faceDB.starPerson(personId, starred);
        sendResponse({ ok: true, starred });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Extract face embedding from uploaded reference photo ───────────────────
    if (msg.type === "EXTRACT_FACE_EMBEDDING") {
      const { imageDataUrl } = msg;
      if (!imageDataUrl) { sendResponse({ ok: false, error: "No image data." }); return; }
      try {
        await ensureFreshOffscreenRuntime();
        const res = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_EXTRACT_EMBEDDING",
          imageDataUrl,
        });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── List Drive images for the reference photo picker (all pages) ──────────
    if (msg.type === "LIST_DRIVE_IMAGES_FOR_PICKER") {
      try {
        await ensureFreshToken();
        const folders = await ensureFolderTree(cachedToken);

        // Collect folder IDs to search: Human + all People/ subfolders
        const folderIds = [];
        if (folders.human?.id) folderIds.push(folders.human.id);
        const peopleRoot = await getOrCreateFolder(cachedToken, "People", folders.root.id);
        const peopleSubs = await listSubfolders(cachedToken, peopleRoot.id);
        for (const sub of peopleSubs) folderIds.push(sub.id);

        if (!folderIds.length) { sendResponse({ ok: true, files: [] }); return; }

        // Build OR query across all folders
        const parentQ = folderIds.map(id => `'${id}' in parents`).join(" or ");
        const q = `(${parentQ}) and mimeType contains 'image/' and trashed=false`;

        async function fetchAllPages(query) {
          let files = [], pt = "";
          do {
            const url = new URL("https://www.googleapis.com/drive/v3/files");
            url.searchParams.set("q", query);
            url.searchParams.set("orderBy", "modifiedTime desc");
            url.searchParams.set("pageSize", "200");
            url.searchParams.set("fields", "nextPageToken,files(id,name,thumbnailLink,mimeType,modifiedTime)");
            url.searchParams.set("supportsAllDrives", "true");
            url.searchParams.set("includeItemsFromAllDrives", "true");
            if (pt) url.searchParams.set("pageToken", pt);
            const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${cachedToken}` } });
            if (!resp.ok) throw new Error(`Drive API ${resp.status}`);
            const data = await resp.json();
            files = files.concat(data.files || []);
            pt = data.nextPageToken || "";
          } while (pt);
          return files;
        }

        const allFiles = await fetchAllPages(q);
        sendResponse({ ok: true, files: allFiles });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Download a Drive image and return it as a base64 dataURL ──────────────
    if (msg.type === "DOWNLOAD_DRIVE_IMAGE_BASE64") {
      try {
        await ensureFreshToken();
        const { fileId, mimeType } = msg;
        const resp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { Authorization: `Bearer ${cachedToken}` } },
        );
        if (!resp.ok) throw new Error(`Drive download ${resp.status}`);
        const arrayBuffer = await resp.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        // Convert to base64 in chunks (safe for large files in service worker)
        const chunkSize = 8192;
        let binary = "";
        for (let i = 0; i < uint8.length; i += chunkSize) {
          binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
        }
        const base64  = btoa(binary);
        const dataUrl = `data:${mimeType || "image/jpeg"};base64,${base64}`;
        sendResponse({ ok: true, dataUrl });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Find & move person photos ──────────────────────────────────────────────
    // Upload a reference photo → extract embedding → scan Human, Junk, Unsure
    // (NOT Group — group photos contain multiple people) → move matches to
    // Smart Photo Organizer/People/[name]/
    if (msg.type === "FIND_AND_MOVE_PERSON_PHOTOS") {
      const { referenceEmbeddings, referenceEmbedding, personName, threshold = 0.55 } = msg;
      // Support both single centroid (legacy) and array of embeddings (max-sim mode)
      const refEmbeddings = referenceEmbeddings || (referenceEmbedding ? [referenceEmbedding] : null);
      if (!refEmbeddings?.length || !personName) {
        sendResponse({ ok: false, error: "Reference photo and name are required." });
        return;
      }

      // Keep the service worker alive for the duration of the scan.
      // Chrome MV3 kills service workers after ~5 min of inactivity;
      // a repeating alarm every 20s resets that timer.
      const KEEPALIVE_ALARM = "findPersonKeepalive";
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 / 3 }); // every 20s

      try {
        await ensureFreshToken();
        await ensureFreshOffscreenRuntime();

        const folders = await ensureFolderTree(cachedToken);

        // Scan Human only — these are already confirmed solo-person photos,
        // so face detection is most likely to succeed and match correctly.
        const foldersToScan = [
          { id: folders.human.id, name: "Human" },
        ];

        // Collect all photos from those three folders
        const allPhotos = [];
        for (const folder of foldersToScan) {
          let pt = "";
          do {
            const refreshed = await getAuthToken(false);
            if (refreshed.ok) cachedToken = refreshed.token;
            const page = await listImageFilesInFolderPage(cachedToken, folder.id, {
              pageToken: pt, pageSize: 100, includeVideos: false,
            });
            for (const f of (page.files || [])) {
              allPhotos.push({ ...f, sourceFolderId: folder.id, sourceFolderName: folder.name });
            }
            pt = page.nextPageToken || "";
          } while (pt);
        }

        emitProgress({
          operation: "findPerson", stage: "scan",
          processed: 0, total: allPhotos.length,
          message: `Scanning ${allPhotos.length} photos for ${personName}…`,
        });

        // Create destination folder: Smart Photo Organizer/People/[name]/
        const root       = await getOrCreateFolder(cachedToken, ROOT_FOLDER_NAME);
        const peopleRoot = await getOrCreateFolder(cachedToken, "People", root.id);
        const personFolder = await getOrCreateFolder(cachedToken, personName, peopleRoot.id);

        let matched = 0, movedCount = 0, scanned = 0;
        const MOVE_CONCURRENCY = 5;
        const pendingMoves = [];
        let pendingMoveIds = [];

        function flushMoves() {
          if (!pendingMoveIds.length) return;
          const ids = pendingMoveIds.splice(0);
          const p = (async () => {
            for (let j = 0; j < ids.length; j += MOVE_CONCURRENCY) {
              const chunk = ids.slice(j, j + MOVE_CONCURRENCY);
              await Promise.all(chunk.map(id =>
                moveFileToFolder(cachedToken, id, personFolder.id)
                  .then(() => { movedCount++; })
                  .catch(err => console.warn("[FIND_PERSON] Move failed:", err.message))
              ));
            }
          })();
          pendingMoves.push(p);
        }

        for (let idx = 0; idx < allPhotos.length; idx++) {
          if (sortShouldStop) break;
          const photo = allPhotos[idx];
          scanned++;

          emitProgress({
            operation: "findPerson", stage: "scan",
            processed: scanned, total: allPhotos.length,
            message: `Scanning ${scanned}/${allPhotos.length} — ${matched} matched, ${movedCount} moved…`,
            personName,
          });

          try {
            const refreshed = await getAuthToken(false);
            if (refreshed.ok) cachedToken = refreshed.token;

            const thumbnailUrl = photo.thumbnailLink
              ? photo.thumbnailLink.replace(/=s\d+$/, "=w800").replace(/=w\d+$/, "=w800")
              : null;

            const isLast = scanned === allPhotos.length;
            const offRes = await chrome.runtime.sendMessage({
              type: "OFFSCREEN_DETECT_FACES",
              file: photo, token: cachedToken,
              thumbnailUrl, releaseSessions: isLast,
            });

            if (!offRes?.ok || !offRes.faces?.length) continue;
            if (offRes.faces.length > 1) continue; // skip group photos

            const faceEmb = offRes.faces[0].embedding;
            const sim = Math.max(...refEmbeddings.map(ref => cosineSim(faceEmb, ref)));
            if (sim >= threshold) {
              matched++;
              pendingMoveIds.push(photo.id);
            }
          } catch (err) {
            console.warn("[FIND_PERSON] Error on photo", photo.name, err.message);
          }

          if ((idx + 1) % 10 === 0 || idx === allPhotos.length - 1) flushMoves();
        }

        await Promise.all(pendingMoves);
        chrome.alarms.clear(KEEPALIVE_ALARM);

        emitProgress({
          operation: "findPerson", stage: "done",
          processed: allPhotos.length, total: allPhotos.length,
          message: `Done — moved ${movedCount} of ${matched} matched photos to ${personName}/`,
          personName,
        });

        sendResponse({
          ok: true,
          personName,
          matched,
          movedCount,
          scanned: allPhotos.length,
          folderId: personFolder.id,
        });

      } catch (err) {
        chrome.alarms.clear(KEEPALIVE_ALARM);
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Google Photos content-script data relay ───────────────────────────────
    // These messages arrive from content/gp-relay.js running on photos.google.com.
    // We accumulate filenames per person cluster in chrome.storage.session so they
    // survive service-worker restarts within the same browser session.

    if (msg.type === "GPHOTO_FILENAMES") {
      const { personId, filenames } = msg;
      if (!personId || !Array.isArray(filenames)) { sendResponse({ ok: true }); return; }
      try {
        const key = `gp_names_${personId}`;
        const stored = await chrome.storage.session.get(key);
        const existing = new Set(stored[key] || []);
        filenames.forEach(f => existing.add(f));
        await chrome.storage.session.set({ [key]: Array.from(existing) });
        sendResponse({ ok: true, total: existing.size });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
      return;
    }

    if (msg.type === "GPHOTO_PEOPLE_LIST") {
      const { people } = msg;
      if (Array.isArray(people)) {
        await chrome.storage.session.set({ gp_people_list: people });
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "GPHOTO_PAGE_CHANGE") {
      const { personId, name } = msg;
      if (personId && name) {
        // Store name so the popup can label the cluster
        const key = `gp_name_label_${personId}`;
        await chrome.storage.session.set({ [key]: name });
      }
      sendResponse({ ok: true });
      return;
    }

    // ── Popup asks for accumulated Google Photos data ──────────────────────────
    if (msg.type === "GPHOTO_GET_STATE") {
      const allData = await chrome.storage.session.get(null);
      const people = allData.gp_people_list || [];

      // Merge captured filename counts into each person entry
      const enriched = people.map(p => {
        const filenames = allData[`gp_names_${p.id}`] || [];
        const label = allData[`gp_name_label_${p.id}`] || p.name || null;
        return { ...p, name: label, filenameCount: filenames.length };
      });

      // Also surface any person IDs we have filenames for but no entry in the people list
      const knownIds = new Set(people.map(p => p.id));
      for (const key of Object.keys(allData)) {
        if (!key.startsWith('gp_names_')) continue;
        const personId = key.replace('gp_names_', '');
        if (knownIds.has(personId)) continue;
        const filenames = allData[key] || [];
        const label = allData[`gp_name_label_${personId}`] || null;
        enriched.push({ id: personId, name: label, thumbnailUrl: null, filenameCount: filenames.length });
      }

      sendResponse({ ok: true, people: enriched });
      return;
    }

    // ── Match Google Photos filenames → Drive files and move them ─────────────
    if (msg.type === "GPHOTO_MATCH_AND_MOVE") {
      const { personId, folderName } = msg;
      if (!personId || !folderName) {
        sendResponse({ ok: false, error: "personId and folderName required." });
        return;
      }

      const KEEPALIVE_ALARM = "gphotMatchKeepalive";
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 / 3 });

      try {
        await ensureFreshToken();

        const key = `gp_names_${personId}`;
        const stored = await chrome.storage.session.get(key);
        const filenames = stored[key] || [];

        if (!filenames.length) {
          sendResponse({ ok: false, error: "No filenames captured yet. Open the person's page in Google Photos first." });
          chrome.alarms.clear(KEEPALIVE_ALARM);
          return;
        }

        emitProgress({
          operation: "gpMatch", stage: "search",
          processed: 0, total: filenames.length,
          message: `Searching Drive for ${filenames.length} photo filenames…`,
        });

        // Create destination folder
        const root = await getOrCreateFolder(cachedToken, ROOT_FOLDER_NAME);
        const peopleRoot = await getOrCreateFolder(cachedToken, "People", root.id);
        const personFolder = await getOrCreateFolder(cachedToken, folderName, peopleRoot.id);

        // Search only inside the Human folder so group photos are never moved
        const folders = await ensureFolderTree(cachedToken);
        const humanFolderId = folders.human.id;

        // Search Drive in batches of 20 filenames (keeps query under URL limit)
        const BATCH = 20;
        const matchedFiles = [];
        for (let i = 0; i < filenames.length; i += BATCH) {
          const refreshed = await getAuthToken(false);
          if (refreshed.ok) cachedToken = refreshed.token;

          const batch = filenames.slice(i, i + BATCH);
          // Escape single quotes inside filenames
          const clauses = batch.map(n => `name = '${n.replace(/'/g, "\\'")}'`).join(' or ');
          const q = `'${humanFolderId}' in parents and (${clauses}) and trashed=false`;

          const url = new URL("https://www.googleapis.com/drive/v3/files");
          url.searchParams.set("q", q);
          url.searchParams.set("fields", "files(id,name,parents)");
          url.searchParams.set("pageSize", "100");
          url.searchParams.set("supportsAllDrives", "true");
          url.searchParams.set("includeItemsFromAllDrives", "true");

          const resp = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${cachedToken}` },
          });
          if (resp.ok) {
            const data = await resp.json();
            matchedFiles.push(...(data.files || []));
          }

          emitProgress({
            operation: "gpMatch", stage: "search",
            processed: Math.min(i + BATCH, filenames.length), total: filenames.length,
            message: `Searching… found ${matchedFiles.length} matches so far`,
          });
        }

        // Deduplicate (same file may match multiple filenames if names collide)
        const unique = [...new Map(matchedFiles.map(f => [f.id, f])).values()];

        emitProgress({
          operation: "gpMatch", stage: "move",
          processed: 0, total: unique.length,
          message: `Moving ${unique.length} matched photos to ${folderName}/…`,
        });

        let moved = 0, failed = 0;
        for (const file of unique) {
          try {
            await moveFileToFolder(cachedToken, file.id, personFolder.id);
            moved++;
          } catch (_) { failed++; }

          emitProgress({
            operation: "gpMatch", stage: "move",
            processed: moved + failed, total: unique.length,
            message: `Moving ${moved + failed}/${unique.length}…`,
          });
        }

        chrome.alarms.clear(KEEPALIVE_ALARM);
        emitProgress({
          operation: "gpMatch", stage: "done",
          processed: unique.length, total: unique.length,
          message: `Done — moved ${moved} photos to ${folderName}/`,
        });

        sendResponse({ ok: true, filenameCount: filenames.length, matched: unique.length, moved, failed, folderId: personFolder.id });
      } catch (err) {
        chrome.alarms.clear(KEEPALIVE_ALARM);
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Clear Google Photos session data ──────────────────────────────────────
    if (msg.type === "GPHOTO_CLEAR") {
      const allData = await chrome.storage.session.get(null);
      const gpKeys = Object.keys(allData).filter(k => k.startsWith('gp_'));
      if (gpKeys.length) await chrome.storage.session.remove(gpKeys);
      sendResponse({ ok: true });
      return;
    }

    // ── Index-based person search (instant — uses pre-built faceDB) ───────────
    // This replaces FIND_AND_MOVE_PERSON_PHOTOS for users who have already
    // run SCAN_FACES. Instead of scanning every photo again (2+ hrs), we
    // compare the reference embedding against all stored embeddings in memory.
    // 10,000 embeddings compared in < 100 ms.
    if (msg.type === "FIND_PERSON_FROM_INDEX") {
      const { referenceEmbeddings, personName, threshold = 0.60 } = msg;
      if (!referenceEmbeddings?.length || !personName) {
        sendResponse({ ok: false, error: "Reference photo and name required." });
        return;
      }
      try {
        await ensureFreshToken();

        const allEmbeddings = await faceDB.getAllEmbeddings();
        if (!allEmbeddings.length) {
          sendResponse({ ok: false, error: "NO_INDEX" });
          return;
        }

        emitProgress({
          operation: "findPersonIndex", stage: "match",
          processed: 0, total: allEmbeddings.length,
          message: `Searching ${allEmbeddings.length} indexed faces for ${personName}…`,
        });

        const matchedPhotoIds = new Set();
        const allSims = [];
        for (const emb of allEmbeddings) {
          if (!emb.embedding?.length) continue;
          const sim = Math.max(...referenceEmbeddings.map(ref => cosineSim(emb.embedding, ref)));
          allSims.push(sim);
          if (sim >= threshold) matchedPhotoIds.add(emb.photoId);
        }
        allSims.sort((a, b) => b - a);
        const topSims = allSims.slice(0, 10); // top-10 scores for debugging

        emitProgress({
          operation: "findPersonIndex", stage: "move",
          processed: 0, total: matchedPhotoIds.size,
          message: `Found ${matchedPhotoIds.size} matches — creating folder for ${personName}…`,
        });

        const root         = await getOrCreateFolder(cachedToken, ROOT_FOLDER_NAME);
        const peopleRoot   = await getOrCreateFolder(cachedToken, "People", root.id);
        const personFolder = await getOrCreateFolder(cachedToken, personName, peopleRoot.id);

        let moved = 0, failed = 0;
        const ids = Array.from(matchedPhotoIds);
        for (let i = 0; i < ids.length; i++) {
          try {
            await moveFileToFolder(cachedToken, ids[i], personFolder.id);
            moved++;
          } catch (_) { failed++; }
          emitProgress({
            operation: "findPersonIndex", stage: "move",
            processed: i + 1, total: ids.length,
            message: `Moving ${i + 1}/${ids.length} matched photos…`,
          });
        }

        emitProgress({
          operation: "findPersonIndex", stage: "done",
          processed: ids.length, total: ids.length,
          message: `Done — moved ${moved} photos of ${personName}.`,
        });

        const modelUsed = await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: "OFFSCREEN_GET_MODEL_INFO" }, r => resolve(r?.model ?? "unknown"));
        }).catch(() => "unknown");

        sendResponse({
          ok: true, personName,
          indexedFaces: allEmbeddings.length,
          matched: matchedPhotoIds.size,
          moved, failed,
          folderId: personFolder.id,
          topSims,
          model: modelUsed,
          threshold,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Multi-person index search — one pass, winner-takes-all ────────────────
    // Each indexed face is assigned to whichever person scores highest above
    // the threshold. A photo is moved to only ONE folder (the best match).
    if (msg.type === "FIND_MULTIPLE_PERSONS_FROM_INDEX") {
      const { persons, threshold = 0.45 } = msg;
      if (!persons?.length) { sendResponse({ ok: false, error: "No persons provided." }); return; }
      try {
        await ensureFreshToken();
        const allEmbeddings = await faceDB.getAllEmbeddings();
        if (!allEmbeddings.length) { sendResponse({ ok: false, error: "NO_INDEX" }); return; }

        // Photos whose source folder is the Group Photos folder are always excluded
        const folders = await ensureFolderTree(cachedToken);
        const groupFolderId = folders.group?.id || null;

        emitProgress({ operation: "findMultiPerson", stage: "match", processed: 0, total: allEmbeddings.length, message: `Searching ${allEmbeddings.length} faces for ${persons.length} people…` });

        // Winner-takes-all: track best and second-best score per photo
        // photoId → { personIdx, score, secondScore }
        const photoWinner = new Map();
        for (let e = 0; e < allEmbeddings.length; e++) {
          const emb = allEmbeddings[e];
          if (!emb.embedding?.length) continue;
          if (groupFolderId && emb.sourceFolderId === groupFolderId) continue;

          const scores = persons.map(person =>
            Math.max(...person.referenceEmbeddings.map(ref => cosineSim(emb.embedding, ref)))
          );

          let bestIdx = -1, bestScore = threshold, secondScore = 0;
          for (let p = 0; p < scores.length; p++) {
            if (scores[p] > bestScore) { secondScore = bestScore; bestScore = scores[p]; bestIdx = p; }
            else if (scores[p] > secondScore) secondScore = scores[p];
          }

          if (bestIdx >= 0) {
            const prev = photoWinner.get(emb.photoId);
            const newSecond = Math.max(secondScore, prev?.secondScore || 0);
            if (!prev || bestScore > prev.score) {
              photoWinner.set(emb.photoId, { personIdx: bestIdx, score: bestScore, secondScore: newSecond });
            } else {
              photoWinner.set(emb.photoId, { ...prev, secondScore: newSecond });
            }
          }

          if (e % 500 === 0) emitProgress({ operation: "findMultiPerson", stage: "match", processed: e, total: allEmbeddings.length, message: `Matching faces… ${e}/${allEmbeddings.length}` });
        }

        // Assign only if:
        // 1. The winner clearly beats the second person by at least MIN_MARGIN
        //    (avoids coin-flip assignments between similar family members)
        // 2. The second person isn't suspiciously close (group photo ratio check)
        const MIN_MARGIN  = 0.10; // winner must beat 2nd by at least 0.10
        const GROUP_RATIO = 0.92; // if 2nd/winner >= 0.92, likely a real group photo
        const personPhotoIds = persons.map(() => []);
        for (const [photoId, { personIdx, score, secondScore }] of photoWinner) {
          if (secondScore / score >= GROUP_RATIO) continue;       // group photo → skip
          if (score - secondScore < MIN_MARGIN) continue;         // too close to call → skip
          personPhotoIds[personIdx].push(photoId);
        }

        // Create folders and move files
        const root       = await getOrCreateFolder(cachedToken, ROOT_FOLDER_NAME);
        const peopleRoot = await getOrCreateFolder(cachedToken, "People", root.id);

        const results = [];
        let totalMoved = 0;
        for (let p = 0; p < persons.length; p++) {
          const { personName, thumbnailDataUrl } = persons[p];
          const ids = personPhotoIds[p];
          if (!ids.length) { results.push({ personName, matched: 0, moved: 0, thumbnailDataUrl }); continue; }

          const folder = await getOrCreateFolder(cachedToken, personName, peopleRoot.id);
          let moved = 0;
          for (let i = 0; i < ids.length; i++) {
            try { await moveFileToFolder(cachedToken, ids[i], folder.id); moved++; } catch (_) {}
            emitProgress({ operation: "findMultiPerson", stage: "move", processed: totalMoved + i + 1, total: photoWinner.size, message: `Moving photos… ${personName} ${i + 1}/${ids.length}` });
          }
          totalMoved += moved;
          results.push({ personName, matched: ids.length, moved, folderId: folder.id, thumbnailDataUrl });
        }

        sendResponse({ ok: true, results, totalIndexed: allEmbeddings.length });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Get face index status (how many faces indexed) ─────────────────────────
    if (msg.type === "GET_FACE_INDEX_STATUS") {
      try {
        const allEmbeddings = await faceDB.getAllEmbeddings();
        const allPhotos     = await faceDB.getAllPersons();
        const photoFaceCount = (await new Promise(resolve => {
          faceDB.getAllEmbeddings().then(e => resolve(e.length));
        }));
        sendResponse({ ok: true, embeddingCount: allEmbeddings.length, personCount: allPhotos.length });
      } catch (err) {
        sendResponse({ ok: true, embeddingCount: 0, personCount: 0 });
      }
      return;
    }

    // ── Clear all face data ────────────────────────────────────────────────────
    if (msg.type === "CLEAR_FACE_DB") {
      try {
        await faceDB.clearAll();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    sendResponse({ ok: false, error: "Unknown message type." });
  })();

  return true;
});

// ── Face clustering helpers ────────────────────────────────────────────────────
// ArcFace (w600k_mbf) outputs unnormalized embeddings (magnitude ≈ 15-20),
// so raw dot products are in the 200-280 range for same-person pairs.
// True cosine similarity (dot / |a| * |b|) normalizes this to -1..1.
// Same-person ArcFace cosine: 0.30–0.60. Family members: 0.10–0.30.
function cosineSim(a, b) {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma  += a[i] * a[i];
    mb  += b[i] * b[i];
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom > 0 ? dot / denom : 0;
}

// Running-mean centroid update, then re-normalise.
function centroidUpdate(centroid, newEmb, n) {
  const dim     = centroid.length;
  const updated = new Array(dim);
  for (let i = 0; i < dim; i++) updated[i] = (centroid[i] * n + newEmb[i]) / (n + 1);
  const norm = Math.sqrt(updated.reduce((s, x) => s + x * x, 0)) || 1;
  return updated.map(x => x / norm);
}
