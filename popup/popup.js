// ── Element refs ─────────────────────────────────────────────────────────────
const signInBtn    = document.getElementById("signInBtn");
const signOutBtn   = document.getElementById("signOutBtn");
const sortBtn      = document.getElementById("sortBtn");
const stopBtn      = document.getElementById("stopBtn");
const resortBtn    = document.getElementById("resortBtn");
const scanFacesBtn = document.getElementById("scanFacesBtn");
const sortBtnLabel = document.getElementById("sortBtnLabel");
const copyTokenBtn = document.getElementById("copyTokenBtn");
const mainView     = document.getElementById("mainView");
const authView     = document.getElementById("authView");

// ── Stats ─────────────────────────────────────────────────────────────────────
const STAT_KEYS = ["Human","Group","Animals","Junk","Unsure","Videos"];
const scnt  = Object.fromEntries(STAT_KEYS.map(k => [k, document.getElementById(`scnt${k}`)]));
const sbar  = Object.fromEntries(STAT_KEYS.map(k => [k, document.getElementById(`sbar${k}`)]));
const scard = Object.fromEntries(STAT_KEYS.map(k => [k, document.getElementById(`scard${k}`)]));
const ssize = Object.fromEntries(STAT_KEYS.map(k => [k, document.getElementById(`ssize${k}`)]));

const COUNT_MAP = {
  humanSingle: "Human",
  humanGroup:  "Group",
  animals:     "Animals",
  junk:        "Junk",
  videos:      "Videos",
  unsure:      "Unsure",
};

function formatBytes(b) {
  if (!b || b <= 0) return "";
  if (b < 1024)             return `${b} B`;
  if (b < 1024 ** 2)        return `${(b/1024).toFixed(1)} KB`;
  if (b < 1024 ** 3)        return `${(b/1024**2).toFixed(1)} MB`;
  return `${(b/1024**3).toFixed(2)} GB`;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusDot     = document.getElementById("statusDot");
const statusText    = document.getElementById("statusText");
const progressWrap  = document.getElementById("progressWrap");
const progressLabel = document.getElementById("progressLabel");
const progressMeta  = document.getElementById("progressMeta");
const progressBar   = document.getElementById("progressBar");
const foldersEl     = document.getElementById("folders");

// ── Tab switching ─────────────────────────────────────────────────────────────
const tabBtns   = document.querySelectorAll(".tab-btn");
const tabPanels = {
  sort:    document.getElementById("panelSort"),
  people:  document.getElementById("panelPeople"),
  gphoto:  document.getElementById("panelGPhoto"),
};

tabBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    tabBtns.forEach(b => b.classList.toggle("tab-btn--active", b.dataset.tab === target));
    Object.entries(tabPanels).forEach(([key, panel]) => panel.classList.toggle("hidden", key !== target));
    if (target === "gphoto")  gpRefreshPeopleList();
    if (target === "people")  refreshOrgIndexBanner();
  });
});

// ── State ─────────────────────────────────────────────────────────────────────
let progressStartMs   = 0;
let progressOperation = "";
let _lastCounts = {};
let _lastSizes  = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(text, mode = "idle") {
  statusText.textContent = text;
  statusDot.className    = "status-dot";
  if (mode === "active") statusDot.classList.add("active");
  else if (mode === "error") statusDot.classList.add("error");
  else if (mode === "done")  statusDot.classList.add("done");
}

function showProgress() {
  progressWrap.classList.remove("hidden");
  // Hide the status banner while the progress bar is active —
  // they show the same message so displaying both is redundant.
  document.getElementById("statusBanner").classList.add("hidden");
  if (!progressStartMs) progressStartMs = Date.now();
}

function hideProgress() {
  progressWrap.classList.add("hidden");
  // Restore the status banner once the progress bar is gone.
  document.getElementById("statusBanner").classList.remove("hidden");
  progressStartMs = 0;
  progressOperation = "";
  progressMeta.textContent = "";
}

function setSortRunning(running) {
  stopBtn.classList.toggle("hidden", !running);
  stopBtn.disabled = false;
  resortBtn.style.display = !running ? "" : "none";
}

function setProgress(message, processed, total, operation = "") {
  const safeTotal     = Math.max(1, Number(total     || 0));
  const safeProcessed = Math.max(0, Number(processed || 0));
  const pct = Math.min(100, Math.round((safeProcessed / safeTotal) * 100));

  if (operation && progressOperation !== operation) {
    progressOperation = operation;
    progressStartMs   = Date.now();
  }

  progressLabel.textContent = message || `Progress ${pct}%`;
  progressBar.style.width   = `${pct}%`;

  if (safeProcessed > 0 && progressStartMs > 0) {
    const elapsedSec = Math.max(1, Math.round((Date.now() - progressStartMs) / 1000));
    const perMin     = Math.round((safeProcessed / elapsedSec) * 60);
    progressMeta.textContent = `${safeProcessed}/${safeTotal} · ${perMin}/min`;
  } else {
    progressMeta.textContent = `${safeProcessed}/${safeTotal}`;
  }
}

function updateStatsGrid(counts = {}, folderUrls = {}, sizes = {}) {
  const merged = { ..._lastCounts };
  for (const [bgKey, cardKey] of Object.entries(COUNT_MAP)) {
    const v = counts[bgKey];
    if (v !== undefined && v !== null) merged[cardKey] = v;
  }
  _lastCounts = merged;

  const mergedSizes = { ..._lastSizes };
  for (const [bgKey, cardKey] of Object.entries(COUNT_MAP)) {
    const v = sizes[bgKey];
    if (v !== undefined && v !== null) mergedSizes[cardKey] = v;
  }
  _lastSizes = mergedSizes;

  const total = Math.max(1, Object.values(merged).reduce((s, n) => s + (n || 0), 0));

  for (const key of STAT_KEYS) {
    const val  = merged[key] ?? 0;
    const el   = scnt[key];
    const bar  = sbar[key];
    const card = scard[key];
    const szel = ssize[key];

    const prev = parseInt(el.textContent) || 0;
    if (val !== prev) {
      el.textContent = val.toLocaleString();
      el.classList.remove("pop");
      void el.offsetWidth;
      el.classList.add("pop");
    }

    if (szel) szel.textContent = formatBytes(mergedSizes[key] ?? 0);
    card.classList.toggle("zero", val === 0);
    bar.style.width = `${Math.min(100, (val / total) * 100)}%`;

    const url = folderUrls[key];
    if (url) { card.href = url; }
  }
}

function renderFolderLinks(folders) {
  foldersEl.innerHTML = "";
  if (!folders) return;
  const entries = [
    { ...folders.root,    emoji: "📁" },
    { ...folders.human,   emoji: "👤" },
    { ...folders.group,   emoji: "👥" },
    { ...folders.animals, emoji: "🐾" },
    { ...folders.junk,    emoji: "🗑️" },
    { ...folders.videos,  emoji: "🎬" },
    { ...folders.unsure,  emoji: "❓" },
  ].filter(f => f.id);
  for (const folder of entries) {
    const a = document.createElement("a");
    a.href      = `https://drive.google.com/drive/folders/${folder.id}`;
    a.target    = "_blank";
    a.rel       = "noopener noreferrer";
    a.className = "folder-link";
    const short = (folder.label || "")
      .replace("Smart Photo Organizer/", "")
      .replace("Smart Photo Organizer", "Root");
    a.textContent = `${folder.emoji} ${short}`;
    foldersEl.appendChild(a);
  }
}

async function sendMessage(type, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    return res ?? { ok: false, error: "No response from background." };
  } catch (err) {
    return { ok: false, error: err?.message || "Extension communication error." };
  }
}

// ── Progress listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "PROGRESS_UPDATE") return;
  showProgress();  // hides status banner, shows progress bar
  setProgress(msg.message, msg.processed, msg.total, msg.operation);
  // NOTE: do NOT call setStatus() here — the progress bar already shows the
  // message and calling both creates the duplicate-layout bug.
  if (msg.categoryCounts) {
    updateStatsGrid(msg.categoryCounts, {}, msg.categorySizes || {});
  }
});

// ── Auth helpers ──────────────────────────────────────────────────────────────
function showSignedIn() {
  authView.classList.add("hidden");
  mainView.classList.remove("hidden");
  signOutBtn.classList.remove("hidden");
  sortBtn.disabled      = false;
  resortBtn.disabled    = false;
  scanFacesBtn.disabled = false;
  setStatus("Signed in. Ready to sort.", "done");
}

function showSignedOut() {
  mainView.classList.add("hidden");
  authView.classList.remove("hidden");
  signOutBtn.classList.add("hidden");
  sortBtn.disabled      = true;
  resortBtn.disabled    = true;
  scanFacesBtn.disabled = true;
}

// ── Sign in ───────────────────────────────────────────────────────────────────
signInBtn.addEventListener("click", async () => {
  signInBtn.disabled  = true;
  const orig = signInBtn.innerHTML;
  signInBtn.innerHTML = `<span style="opacity:.7">Signing in…</span>`;

  const res = await sendMessage("AUTH_SIGN_IN");

  signInBtn.disabled  = false;
  signInBtn.innerHTML = orig;

  if (!res?.ok) {
    authView.querySelector(".signin-error")?.remove();
    const err = document.createElement("p");
    err.className  = "signin-error";
    err.textContent = res?.error || "Sign-in failed. Please try again.";
    signInBtn.after(err);
    return;
  }

  showSignedIn();
});

// ── Sort ──────────────────────────────────────────────────────────────────────
async function runDriveSort() {
  setStatus("Classifying and moving Drive photos…", "active");
  const res = await sendMessage("DRIVE_CLASSIFY_AND_SORT");
  hideProgress();

  if (!res?.ok) {
    setStatus(`Sort failed: ${res?.error || "Unknown error"}`, "error");
    return;
  }

  const c  = res.summary?.categoryCounts ?? {};
  const sz = res.summary?.categorySizes  ?? {};
  const f  = res.folders ?? {};

  const folderUrls = {
    Human:   f.human   ? `https://drive.google.com/drive/folders/${f.human.id}`   : null,
    Group:   f.group   ? `https://drive.google.com/drive/folders/${f.group.id}`   : null,
    Animals: f.animals ? `https://drive.google.com/drive/folders/${f.animals.id}` : null,
    Junk:    f.junk    ? `https://drive.google.com/drive/folders/${f.junk.id}`    : null,
    Videos:  f.videos  ? `https://drive.google.com/drive/folders/${f.videos.id}`  : null,
    Unsure:  f.unsure  ? `https://drive.google.com/drive/folders/${f.unsure.id}`  : null,
  };

  updateStatsGrid(c, folderUrls, sz);
  renderFolderLinks(res.folders);

  const moved      = res.summary?.movedCount             ?? 0;
  const scanned    = res.summary?.scannedTotal           ?? 0;
  const failed     = res.summary?.moveFailedCount        ?? 0;
  const skipped    = (res.summary?.skippedAlreadyProcessed ?? 0) + (res.summary?.skippedAlreadyInTarget ?? 0);
  const unsure     = c.unsure ?? 0;
  const wasStopped = res.summary?.wasStopped;

  setStatus(
    (wasStopped ? "Stopped. " : "Done! ") +
    `Scanned ${scanned} · Moved ${moved}` +
    (unsure  ? ` · ${unsure} unsure`   : "") +
    (skipped ? ` · Skipped ${skipped}` : "") +
    (failed  ? ` · Failed ${failed}`   : "") +
    (wasStopped ? " — click Sort to resume." : ""),
    wasStopped ? "idle" : "done"
  );

  // Auto-launch Unsure review — fetch ALL images from the Unsure folder
  autoLaunchUnsureReview();
}

sortBtn.addEventListener("click", async () => {
  sortBtn.disabled = true;
  _lastCounts = {};
  _lastSizes  = {};
  updateStatsGrid({});
  showProgress();
  try {
    setSortRunning(true);
    await runDriveSort();
  } catch (err) {
    hideProgress();
    setStatus(`Error: ${err?.message || err}`, "error");
  }
  sortBtn.disabled = false;
  sortBtnLabel.textContent = "Sort Drive Photos";
  try { setSortRunning(false); } catch (_) {}
});

// ── Stop ──────────────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  await sendMessage("STOP_SORT");
  stopBtn.classList.add("hidden");
  sortBtn.disabled = false;
  sortBtnLabel.textContent = "▶ Resume Sort";
  setStatus("Sort stopped. Click Sort to resume.", "idle");
  hideProgress();
});

// ── Re-sort All ───────────────────────────────────────────────────────────────
resortBtn.addEventListener("click", async () => {
  if (!confirm(
    "Re-sort All will re-classify every photo already inside Smart Photo Organizer.\n\n" +
    "Photos outside Smart Photo Organizer are NOT affected.\n\nContinue?"
  )) return;

  sortBtn.disabled   = true;
  resortBtn.disabled = true;
  _lastCounts = {};
  _lastSizes  = {};
  updateStatsGrid({});
  showProgress();
  setStatus("Re-sorting photos inside Smart Photo Organizer…", "active");

  try {
    const res = await sendMessage("RESORT_SMART_ORGANIZER");
    hideProgress();

    if (!res?.ok) {
      setStatus(`Re-sort failed: ${res?.error || "Unknown error"}`, "error");
      sortBtn.disabled   = false;
      resortBtn.disabled = false;
      return;
    }

    const s = res.summary || {};
    setStatus(
      `Re-sort complete — ${s.movedCount ?? 0} photos re-organised inside Smart Photo Organizer.`,
      "done"
    );
    if (res.folders)  renderFolderLinks(res.folders);
    if (res.summary) {
      const f = res.folders ?? {};
      const folderUrls = {
        Human:   f.human   ? `https://drive.google.com/drive/folders/${f.human.id}`   : null,
        Group:   f.group   ? `https://drive.google.com/drive/folders/${f.group.id}`   : null,
        Animals: f.animals ? `https://drive.google.com/drive/folders/${f.animals.id}` : null,
        Junk:    f.junk    ? `https://drive.google.com/drive/folders/${f.junk.id}`    : null,
        Videos:  f.videos  ? `https://drive.google.com/drive/folders/${f.videos.id}`  : null,
        Unsure:  f.unsure  ? `https://drive.google.com/drive/folders/${f.unsure.id}`  : null,
      };
      updateStatsGrid(res.summary.categoryCounts ?? {}, folderUrls, res.summary.categorySizes ?? {});
    }
    sortBtn.disabled   = false;
    resortBtn.disabled = false;
    try { setSortRunning(false); } catch (_) {}
    autoLaunchUnsureReview();
    return;
  } catch (err) {
    hideProgress();
    setStatus(`Error: ${err?.message || err}`, "error");
  }

  sortBtn.disabled   = false;
  resortBtn.disabled = false;
  try { setSortRunning(false); } catch (_) {}
});

// ── Scan Faces ────────────────────────────────────────────────────────────────
scanFacesBtn.addEventListener("click", async () => {
  scanFacesBtn.disabled = true;
  scanFacesBtn.textContent = "⏳ Scanning…";
  showProgress();
  setStatus("Scanning faces in Human & Group folders — this may take a while…", "active");

  const res = await sendMessage("SCAN_FACES");
  if (!res?.ok) {
    hideProgress();
    setStatus(`Face scan failed: ${res?.error || "Unknown error"}`, "error");
    scanFacesBtn.disabled = false;
    scanFacesBtn.textContent = "🔍 Scan Faces";
  }
  // Scan runs in background — completion handled by PROGRESS_UPDATE listener below
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "PROGRESS_UPDATE" || msg?.operation !== "faces") return;
  if (msg.stage === "done") {
    hideProgress();
    setStatus(`Face scan complete — ${msg.indexed ?? "?"} faces indexed.`, "done");
    scanFacesBtn.disabled = false;
    scanFacesBtn.textContent = "🔍 Scan Faces";
    refreshOrgIndexBanner();
  } else if (msg.stage === "error") {
    hideProgress();
    setStatus(msg.message || "Face scan failed.", "error");
    scanFacesBtn.disabled = false;
    scanFacesBtn.textContent = "🔍 Scan Faces";
  }
});

// ── Sign out ──────────────────────────────────────────────────────────────────
signOutBtn.addEventListener("click", async () => {
  signOutBtn.disabled = true;
  await sendMessage("AUTH_SIGN_OUT");
  _lastCounts = {};
  _lastSizes  = {};
  updateStatsGrid({});
  showSignedOut();
  signOutBtn.disabled = false;
});

// ── Copy token ────────────────────────────────────────────────────────────────
copyTokenBtn.addEventListener("click", async () => {
  const res = await sendMessage("GET_AUTH_TOKEN");
  if (!res?.ok || !res.token) { setStatus(`Could not get token`, "error"); return; }
  try {
    await navigator.clipboard.writeText(res.token);
    setStatus("Token copied!", "done");
  } catch (_) {
    setStatus(`Token: ${res.token.slice(0, 20)}…`, "idle");
  }
});

// ── Review flow ───────────────────────────────────────────────────────────────
const reviewPrompt      = document.getElementById("reviewPrompt");
const reviewPromptCount = document.getElementById("reviewPromptCount");
const reviewPromptBtn   = document.getElementById("reviewPromptBtn");
const reviewPromptClose = document.getElementById("reviewPromptClose");
const reviewOverlay     = document.getElementById("reviewOverlay");
const reviewProgress    = document.getElementById("reviewProgress");
const reviewProgBar     = document.getElementById("reviewProgBar");
const reviewImg         = document.getElementById("reviewImg");
const reviewImgPlaceholder = document.getElementById("reviewImgPlaceholder");
const reviewPhotoName   = document.getElementById("reviewPhotoName");
const reviewCloseBtn    = document.getElementById("reviewCloseBtn");
const reviewSkipBtn     = document.getElementById("reviewSkipBtn");

let _reviewQueue    = [];
let _reviewIndex    = 0;
let _correctedCount = 0;

// Called automatically after sort — fetches ALL Unsure folder images.
// For large folders this may take several seconds (Drive paginates 100 at a time),
// so we show a live loading count while the request is in flight.
async function autoLaunchUnsureReview() {

  // Show a "loading…" state in the prompt banner immediately
  reviewPromptCount.textContent = "loading…";
  reviewPrompt.classList.remove("hidden");

  // Listen for incremental progress from background pagination
  let loadProgressListener = null;
  const progressCleanup = new Promise(resolve => {
    loadProgressListener = (msg) => {
      if (msg.type !== "UNSURE_LOAD_PROGRESS") return;
      reviewPromptCount.textContent =
        msg.done
          ? `${msg.loaded} photo${msg.loaded !== 1 ? "s" : ""}`
          : `loading… ${msg.loaded} found`;
      if (msg.done) resolve();
    };
    chrome.runtime.onMessage.addListener(loadProgressListener);
  });

  const res = await sendMessage("GET_UNSURE_FILES");

  // Detach the progress listener
  if (loadProgressListener) chrome.runtime.onMessage.removeListener(loadProgressListener);

  if (!res?.ok || !res.files?.length) {
    reviewPrompt.classList.add("hidden");
    return;
  }

  _reviewQueue    = res.files;
  _reviewIndex    = 0;
  _correctedCount = 0;
  reviewPromptCount.textContent =
    `${res.files.length} photo${res.files.length !== 1 ? "s" : ""}`;
  // Prompt stays visible — user clicks "Review Now" to open the modal
}

function openReviewModal() {
  reviewPrompt.classList.add("hidden");
  _reviewIndex    = 0;
  _correctedCount = 0;
  showReviewCard();
  reviewOverlay.classList.remove("hidden");
}

function closeReviewModal() {
  reviewOverlay.classList.add("hidden");
  if (_correctedCount > 0) {
    setStatus(
      `✅ ${_correctedCount} photo${_correctedCount !== 1 ? "s" : ""} sorted — AI will remember your choices on the next sort.`,
      "done"
    );
  }
}

function showReviewCard() {
  const file = _reviewQueue[_reviewIndex];
  if (!file) { closeReviewModal(); return; }

  // Update progress
  const total = _reviewQueue.length;
  reviewProgress.textContent = `${_reviewIndex + 1} / ${total}`;
  reviewProgBar.style.width  = `${Math.round((_reviewIndex / total) * 100)}%`;

  // File name
  reviewPhotoName.textContent = file.name;

  // Show image
  if (file.thumbnailUrl) {
    reviewImg.classList.add("loading");
    reviewImgPlaceholder.classList.remove("hidden");
    reviewImg.onload = () => {
      reviewImg.classList.remove("loading");
      reviewImgPlaceholder.classList.add("hidden");
    };
    reviewImg.onerror = () => {
      reviewImgPlaceholder.classList.remove("hidden");
    };
    reviewImg.src = file.thumbnailUrl;
  } else {
    reviewImg.src = "";
    reviewImgPlaceholder.classList.remove("hidden");
  }
}

function advanceReview() {
  _reviewIndex++;
  if (_reviewIndex >= _reviewQueue.length) {
    closeReviewModal();
  } else {
    showReviewCard();
  }
}

reviewOverlay.addEventListener("click", async (e) => {
  const btn = e.target.closest(".review-cat-btn");
  if (!btn) return;
  const file = _reviewQueue[_reviewIndex];
  if (!file) return;

  // Disable buttons during async operation
  reviewOverlay.querySelectorAll(".review-cat-btn").forEach(b => b.disabled = true);
  const res = await sendMessage("APPLY_CORRECTION", { fileId: file.id, correctedLabel: btn.dataset.cat });
  reviewOverlay.querySelectorAll(".review-cat-btn").forEach(b => b.disabled = false);

  _correctedCount++;
  advanceReview();
});


reviewSkipBtn    .addEventListener("click", () => advanceReview());
reviewCloseBtn   .addEventListener("click", () => closeReviewModal());
reviewPromptBtn  .addEventListener("click", () => openReviewModal());
reviewPromptClose.addEventListener("click", () => reviewPrompt.classList.add("hidden"));

// ══════════════════════════════════════════════════════════════════════════════
// PEOPLE SECTION
// ══════════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════════
// ORGANISE BY PERSON
// ══════════════════════════════════════════════════════════════════════════════
// Up to 3 reference photos per person. Their embeddings are averaged into a
// centroid before matching — this pulls the reference away from family members
// who share similar-but-not-identical facial features.

const MAX_REF_PHOTOS = 3;

const orgPhotoInput    = document.getElementById("orgPhotoInput");
const orgPreview       = document.getElementById("orgPreview");
const orgNameInput     = document.getElementById("orgNameInput");
const orgFindBtn       = document.getElementById("orgFindBtn");
const orgResults       = document.getElementById("orgResults");
const orgIndexBanner   = document.getElementById("orgIndexBanner");
const orgIndexIcon     = document.getElementById("orgIndexIcon");
const orgIndexText     = document.getElementById("orgIndexText");
const orgIndexScanLink  = document.getElementById("orgIndexScanLink");
const orgIndexResetLink = document.getElementById("orgIndexResetLink");

// Load and display face index status whenever the Organise tab is shown
async function refreshOrgIndexBanner() {
  const status = await sendMessage("GET_FACE_INDEX_STATUS");
  const count  = status?.embeddingCount || 0;

  orgIndexBanner.classList.remove("org-index-banner--ready", "org-index-banner--warning");

  if (count > 0) {
    orgIndexBanner.classList.add("org-index-banner--ready");
    orgIndexIcon.textContent = "⚡";
    orgIndexText.textContent = `Face index ready — ${count} faces indexed. Search is instant.`;
    orgIndexScanLink.classList.add("hidden");
  } else {
    orgIndexBanner.classList.add("org-index-banner--warning");
    orgIndexIcon.textContent = "⚠️";
    orgIndexText.textContent = "No face index yet — search will scan all photos (slow).";
    orgIndexScanLink.classList.remove("hidden");
    orgIndexScanLink.onclick = (e) => {
      e.preventDefault();
      // Switch to Sort tab and trigger a face scan notification
      document.getElementById("tabSort")?.click();
      setStatus("Go to Organise tab → click Scan Faces to build the index first.", "idle");
    };
  }
}

orgIndexResetLink.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("This will delete all indexed face data. You will need to run Scan Faces again. Continue?")) return;
  await sendMessage("CLEAR_FACE_DB");
  await refreshOrgIndexBanner();
  setStatus("Face index cleared. Run Scan Faces to rebuild with ArcFace.", "idle");
});

// State — arrays, one entry per reference photo slot
let _orgEmbeddings   = [];   // [{embedding, thumbnailDataUrl}, ...]
let _orgActiveSlot   = 0;    // which slot the next file input targets

// ── Build / rebuild the multi-photo preview area ───────────────────────────
function renderOrgPreview() {
  orgPreview.innerHTML = "";

  for (let i = 0; i < MAX_REF_PHOTOS; i++) {
    const slot = document.createElement("div");
    slot.className = "org-slot" + (_orgEmbeddings[i] ? " org-slot--filled" : "");
    slot.dataset.slot = i;

    if (_orgEmbeddings[i]) {
      // Filled: show face thumbnail + remove ×
      const img = document.createElement("img");
      img.className = "org-slot-face";
      img.src = _orgEmbeddings[i].thumbnailDataUrl;
      slot.appendChild(img);

      const q = _orgEmbeddings[i].quality || "fair";
      const qBadge = document.createElement("div");
      qBadge.className = `org-quality-badge org-quality-badge--${q}`;
      qBadge.title = q === "good" ? "Good photo — face clearly visible"
                   : q === "fair" ? "Fair photo — try a closer selfie for better results"
                   : "Poor photo — face not clear, please replace";
      qBadge.textContent = q === "good" ? "✓" : q === "fair" ? "~" : "✗";
      slot.appendChild(qBadge);

      const rem = document.createElement("button");
      rem.className = "org-slot-remove";
      rem.textContent = "×";
      rem.title = "Remove this photo";
      rem.addEventListener("click", (e) => {
        e.stopPropagation();
        _orgEmbeddings.splice(i, 1);
        renderOrgPreview();
        updateOrgFindBtn();
      });
      slot.appendChild(rem);

      // Badge: photo number
      const badge = document.createElement("span");
      badge.className = "org-slot-badge";
      badge.textContent = i + 1;
      slot.appendChild(badge);

    } else if (i === _orgEmbeddings.length) {
      // Next empty slot: two source buttons — device upload OR Drive picker
      const uploadBtn = document.createElement("button");
      uploadBtn.className = "org-upload-btn";
      uploadBtn.textContent = i === 0 ? "📷 Device" : "📷";
      uploadBtn.title = "Upload from device";
      uploadBtn.addEventListener("click", () => {
        _orgActiveSlot = i;
        orgPhotoInput.value = "";
        orgPhotoInput.click();
      });
      slot.appendChild(uploadBtn);

      const driveBtn = document.createElement("button");
      driveBtn.className = "org-upload-btn org-drive-btn";
      driveBtn.textContent = i === 0 ? "📁 Drive" : "📁";
      driveBtn.title = "Pick from Google Drive";
      driveBtn.addEventListener("click", () => {
        _orgActiveSlot = i;
        openDrivePicker();
      });
      slot.appendChild(driveBtn);

      // Hint text under first slot
      if (i === 0) {
        const hint = document.createElement("span");
        hint.className = "org-slot-hint";
        hint.textContent = "Up to 3 photos";
        slot.appendChild(hint);
      }
    } else {
      // Locked future slot
      slot.classList.add("org-slot--locked");
      const lock = document.createElement("span");
      lock.className = "org-slot-lock";
      lock.textContent = "🔒";
      slot.appendChild(lock);
    }

    orgPreview.appendChild(slot);
  }

  // Photo count indicator
  const n = _orgEmbeddings.length;
  if (n > 0) {
    const countEl = document.createElement("div");
    countEl.className = "org-ref-count";
    countEl.textContent = n === 1
      ? "1 reference photo  •  add 1–2 more for better accuracy"
      : n === 2
        ? "2 reference photos  •  add 1 more for best accuracy"
        : "3 reference photos  ✓  best accuracy";
    orgPreview.appendChild(countEl);
  }
}

// Initialise
renderOrgPreview();

// ── Handle file selection ───────────────────────────────────────────────────
orgPhotoInput.addEventListener("change", async () => {
  const file = orgPhotoInput.files[0];
  if (!file) return;

  // Temporarily show spinner in that slot
  orgFindBtn.disabled   = true;
  orgFindBtn.textContent = "⏳ Detecting face…";

  const dataUrl = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(file);
  });

  const res = await sendMessage("EXTRACT_FACE_EMBEDDING", { imageDataUrl: dataUrl });

  if (!res?.ok) {
    orgFindBtn.textContent = "🔍 Find & Move Photos";
    updateOrgFindBtn();
    alert("No face detected in that photo.\nPlease use a clear, front-facing portrait.");
    return;
  }

  // Insert into the active slot position
  _orgEmbeddings.splice(_orgActiveSlot, 0, {
    embedding:        res.embedding,
    thumbnailDataUrl: res.thumbnailDataUrl,
    quality:          res.quality || "fair",
  });
  // Cap at MAX
  if (_orgEmbeddings.length > MAX_REF_PHOTOS) _orgEmbeddings.length = MAX_REF_PHOTOS;

  renderOrgPreview();
  orgFindBtn.textContent = "🔍 Find & Move Photos";
  updateOrgFindBtn();
});

orgNameInput.addEventListener("input", updateOrgFindBtn);

function updateOrgFindBtn() {
  orgFindBtn.disabled = !(_orgEmbeddings.length > 0 && orgNameInput.value.trim().length > 0);
}

// ── Compute centroid from all reference embeddings ─────────────────────────
// Averaging multiple embeddings then L2-normalising creates a more unique
// representation for this person vs family members who share similar geometry.
function computeCentroid(embeddings) {
  const len = embeddings[0].length;
  const sum = new Array(len).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < len; i++) sum[i] += emb[i];
  }
  // L2 normalise
  let norm = 0;
  for (let i = 0; i < len; i++) norm += sum[i] * sum[i];
  norm = Math.sqrt(norm);
  return sum.map(v => v / norm);
}

// ── People-tab own progress bar helpers ───────────────────────────────────────
const orgProgressWrap  = document.getElementById("orgProgressWrap");
const orgProgressLabel = document.getElementById("orgProgressLabel");
const orgProgressMeta  = document.getElementById("orgProgressMeta");
const orgProgressBar   = document.getElementById("orgProgressBar");
let _orgProgressStart  = 0;

function showOrgProgress() { orgProgressWrap.classList.remove("hidden"); _orgProgressStart = Date.now(); }
function hideOrgProgress() { orgProgressWrap.classList.add("hidden"); _orgProgressStart = 0; }
function setOrgProgress(message, processed, total) {
  const pct = Math.min(100, Math.round((Math.max(0, processed) / Math.max(1, total)) * 100));
  orgProgressLabel.textContent = message || `Progress ${pct}%`;
  orgProgressBar.style.width   = `${pct}%`;
  if (processed > 0 && _orgProgressStart > 0) {
    const sec  = Math.max(1, Math.round((Date.now() - _orgProgressStart) / 1000));
    const rate = Math.round((processed / sec) * 60);
    orgProgressMeta.textContent = `${processed}/${total} · ${rate}/min`;
  }
}

// Progress updates from background during find-person scan
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "PROGRESS_UPDATE") return;
  if (msg.operation !== "findPerson" && msg.operation !== "findPersonIndex") return;
  showOrgProgress();
  setOrgProgress(msg.message, msg.processed, msg.total);
});

orgFindBtn.addEventListener("click", async () => {
  const name = orgNameInput.value.trim();
  if (!_orgEmbeddings.length || !name) return;

  const allEmbeddings = _orgEmbeddings.map(e => e.embedding);

  orgFindBtn.disabled    = true;
  orgFindBtn.textContent = "⏳ Checking index…";
  showOrgProgress();
  setOrgProgress("Checking face index…", 0, 1);

  // ── Try index-based search first (instant) ────────────────────────────────
  const indexStatus = await sendMessage("GET_FACE_INDEX_STATUS");
  const hasIndex    = (indexStatus?.embeddingCount || 0) > 0;

  let res;
  if (hasIndex) {
    setOrgProgress(`Searching ${indexStatus.embeddingCount} indexed faces for ${name}…`, 0, 1);
    res = await sendMessage("FIND_PERSON_FROM_INDEX", {
      referenceEmbeddings: allEmbeddings,
      personName: name,
    });

    // Show top scores as debug info so we can calibrate threshold
    if (res?.topSims?.length) {
      console.log("[FaceSearch] Top similarity scores from index:", res.topSims.map(s => s.toFixed(3)).join(", "));
      alert(`[Debug] Top similarity scores:\n${res.topSims.map(s => s.toFixed(3)).join(", ")}\n\nMatched: ${res.matched ?? 0} photos\nModel: ${res.model ?? "unknown"}`);
    }

    // Only fall back to live scan if index truly has no data
    if (!res?.ok) {
      res = null;
    }
  }

  // ── Fall back to live scan if no index ────────────────────────────────────
  if (!res) {
    orgFindBtn.textContent = "⏳ Scanning…";
    setOrgProgress(`No index found — scanning all photos for ${name}… (this takes time)`, 0, 1);
    res = await sendMessage("FIND_AND_MOVE_PERSON_PHOTOS", {
      referenceEmbeddings: allEmbeddings,
      personName: name,
      refPhotoCount: _orgEmbeddings.length,
    });
  }

  hideOrgProgress();
  orgFindBtn.disabled    = false;
  orgFindBtn.textContent = "🔍 Find & Move Photos";

  if (!res?.ok) {
    alert(`Search failed: ${res?.error || "Unknown error"}`);
    return;
  }

  const moved   = res.moved   ?? res.movedCount ?? 0;
  const scanned = res.matched ?? res.scanned    ?? 0;
  const firstThumb = _orgEmbeddings[0]?.thumbnailDataUrl || null;

  if (res.topSims?.length) {
    console.info(`[FaceIndex] Top-5 scores: ${res.topSims.slice(0,5).map(s=>s.toFixed(3)).join(", ")} (threshold=0.55)`);
  }

  addOrgResultRow(name, firstThumb, moved, scanned, hasIndex ? `from ${indexStatus.embeddingCount} indexed faces` : null);

  _orgEmbeddings = [];
  _orgActiveSlot = 0;
  orgNameInput.value = "";
  orgFindBtn.disabled = true;
  orgPhotoInput.value = "";
  renderOrgPreview();
});

// ── Drive Photo Picker ─────────────────────────────────────────────────────────
const drivePickerOverlay = document.getElementById("drivePickerOverlay");
const drivePickerClose   = document.getElementById("drivePickerClose");
const drivePickerGrid    = document.getElementById("drivePickerGrid");
const drivePickerSearch  = document.getElementById("drivePickerSearch");

let _drivePickerFiles = [];   // all loaded files
let _drivePickerBusy  = false;

drivePickerClose.addEventListener("click", closeDrivePicker);
drivePickerOverlay.addEventListener("click", (e) => {
  if (e.target === drivePickerOverlay) closeDrivePicker();
});

drivePickerSearch.addEventListener("input", () => {
  const q = drivePickerSearch.value.toLowerCase().trim();
  renderDriveGrid(_drivePickerFiles.filter(f => !q || f.name.toLowerCase().includes(q)));
});

function openDrivePicker() {
  drivePickerOverlay.classList.remove("hidden");
  drivePickerSearch.value = "";
  if (_drivePickerFiles.length) {
    renderDriveGrid(_drivePickerFiles);
    return;
  }
  loadDrivePickerFiles();
}

function closeDrivePicker() {
  drivePickerOverlay.classList.add("hidden");
}

async function loadDrivePickerFiles() {
  if (_drivePickerBusy) return;
  _drivePickerBusy = true;
  drivePickerGrid.innerHTML = '<div class="drive-picker-loading">Loading photos from Human folder…</div>';

  const res = await sendMessage("LIST_DRIVE_IMAGES_FOR_PICKER", {});
  _drivePickerBusy = false;

  if (!res?.ok || !res.files?.length) {
    drivePickerGrid.innerHTML = '<div class="drive-picker-loading">No photos found in Human folder.</div>';
    return;
  }
  _drivePickerFiles = res.files;
  renderDriveGrid(_drivePickerFiles);
}

function renderDriveGrid(files) {
  drivePickerGrid.innerHTML = "";

  if (!files.length) {
    drivePickerGrid.innerHTML = '<div class="drive-picker-loading">No results.</div>';
    return;
  }

  for (const file of files) {
    const cell = document.createElement("div");
    cell.className = "drive-picker-cell";
    cell.title = file.name;

    if (file.thumbnailLink) {
      // Use a larger thumbnail (Drive supports sz parameter)
      const thumbUrl = file.thumbnailLink.replace(/=s\d+/, "=s160");
      const img = document.createElement("img");
      img.src = thumbUrl;
      img.alt = file.name;
      img.loading = "lazy";
      cell.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "drive-picker-cell-ph";
      ph.textContent = "🖼️";
      cell.appendChild(ph);
    }

    cell.addEventListener("click", () => selectDrivePhoto(file));
    drivePickerGrid.appendChild(cell);
  }
}

async function selectDrivePhoto(file) {
  closeDrivePicker();

  orgFindBtn.disabled   = true;
  orgFindBtn.textContent = "⏳ Downloading from Drive…";

  // Download the full image from Drive
  const dlRes = await sendMessage("DOWNLOAD_DRIVE_IMAGE_BASE64", {
    fileId:   file.id,
    mimeType: file.mimeType,
  });

  if (!dlRes?.ok) {
    orgFindBtn.textContent = "🔍 Find & Move Photos";
    updateOrgFindBtn();
    alert(`Could not download "${file.name}" from Drive.\n${dlRes?.error || ""}`);
    return;
  }

  orgFindBtn.textContent = "⏳ Detecting face…";

  // Extract face embedding
  const embRes = await sendMessage("EXTRACT_FACE_EMBEDDING", { imageDataUrl: dlRes.dataUrl });

  orgFindBtn.textContent = "🔍 Find & Move Photos";

  if (!embRes?.ok) {
    updateOrgFindBtn();
    alert("No face detected in that Drive photo.\nPlease choose a clear, front-facing portrait.");
    return;
  }

  _orgEmbeddings.splice(_orgActiveSlot, 0, {
    embedding:        embRes.embedding,
    thumbnailDataUrl: embRes.thumbnailDataUrl,
    quality:          embRes.quality || "fair",
  });
  if (_orgEmbeddings.length > MAX_REF_PHOTOS) _orgEmbeddings.length = MAX_REF_PHOTOS;

  renderOrgPreview();
  updateOrgFindBtn();
}

// ── Result row ────────────────────────────────────────────────────────────────
function addOrgResultRow(name, thumbnailUrl, matched, scanned, indexHint = null) {
  orgResults.classList.remove("hidden");

  const row = document.createElement("div");
  row.className = "org-result-row";

  if (thumbnailUrl) {
    const img = document.createElement("img");
    img.className = "org-result-avatar";
    img.src = thumbnailUrl;
    row.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "org-result-avatar-ph";
    ph.textContent = "🙂";
    row.appendChild(ph);
  }

  const meta = indexHint
    ? `Found ${scanned} matches ${indexHint} · moved ${matched}`
    : `Scanned ${scanned} · moved ${matched}`;

  const info = document.createElement("div");
  info.className = "org-result-info";
  info.innerHTML = `
    <div class="org-result-name">${name}</div>
    <div class="org-result-meta">${meta}</div>
  `;
  row.appendChild(info);

  const badge = document.createElement("span");
  badge.className = "org-result-badge";
  badge.textContent = `${matched} moved`;
  row.appendChild(badge);

  orgResults.insertBefore(row, orgResults.firstChild);
}

// ── Startup ───────────────────────────────────────────────────────────────────
(async function init() {
  const res = await sendMessage("GET_AUTH_STATUS");
  if (!res?.isSignedIn) { showSignedOut(); return; }

  showSignedIn();

  // ── Restore last sort summary so the user sees their previous results
  //    immediately on every re-open, without needing to sort again. ────────────
  const info = await sendMessage("GET_MODEL_INFO");
  if (info?.lastSortSummary) {
    const s  = info.lastSortSummary;
    const c  = s.categoryCounts ?? {};
    const sz = s.categorySizes  ?? {};
    const f  = s.folders        ?? {};

    // Rebuild folder URLs from saved folder IDs
    const folderUrls = {};
    const urlMap = { human:"Human", group:"Group", animals:"Animals",
                     junk:"Junk", videos:"Videos", unsure:"Unsure" };
    for (const [key, label] of Object.entries(urlMap)) {
      if (f[key]?.id) folderUrls[label] = `https://drive.google.com/drive/folders/${f[key].id}`;
    }

    updateStatsGrid(c, folderUrls, sz);
    renderFolderLinks(f);

    // Show a contextual status reflecting when the last sort happened
    const ago    = s.timestamp ? timeSince(s.timestamp) : null;
    const moved  = s.movedCount    ?? 0;
    const unsure = c.unsure ?? 0;
    const stopped = s.wasStopped;

    if (stopped) {
      setStatus(`Sort paused ${ago ? ago + " ago" : ""} · ${moved} moved — click Sort to continue.`, "idle");
      sortBtnLabel.textContent = "▶ Resume Sort";
    } else {
      setStatus(
        `Last sort${ago ? " " + ago + " ago" : ""} · ${moved} moved` +
        (unsure ? ` · ${unsure} in Unsure` : "") +
        " · Sort anytime to process new photos.",
        "done"
      );
    }
  }

  // ── Always check for pending Unsure photos on every open,
  //    not just right after a sort. ────────────────────────────────────────────
  autoLaunchUnsureReview();
  refreshOrgIndexBanner();

})();

// ══════════════════════════════════════════════════════════════════════════
//  GOOGLE PHOTOS TAB
// ══════════════════════════════════════════════════════════════════════════

const gpOpenBtn      = document.getElementById("gpOpenBtn");
const gpRefreshBtn   = document.getElementById("gpRefreshBtn");
const gpPeopleList   = document.getElementById("gpPeopleList");
const gpEmptyHint    = document.getElementById("gpEmptyHint");
const gpProgressWrap = document.getElementById("gpProgressWrap");
const gpProgressLabel= document.getElementById("gpProgressLabel");
const gpProgressMeta = document.getElementById("gpProgressMeta");
const gpProgressBar  = document.getElementById("gpProgressBar");
const gpResult       = document.getElementById("gpResult");

gpOpenBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://photos.google.com/people" });
});

gpRefreshBtn.addEventListener("click", () => gpRefreshPeopleList());

async function gpRefreshPeopleList() {
  gpRefreshBtn.textContent = "↻ Loading…";
  gpRefreshBtn.disabled = true;
  try {
    const res = await sendMessage("GPHOTO_GET_STATE");
    if (!res?.ok) {
      console.error("[GPhoto] GPHOTO_GET_STATE failed:", res);
      gpEmptyHint.textContent = "Error loading data: " + (res?.error || "unknown");
      gpEmptyHint.classList.remove("hidden");
      return;
    }
    renderGpPeople(res.people || []);
  } catch (e) {
    console.error("[GPhoto] refresh error:", e);
    gpEmptyHint.textContent = "Error: " + e.message;
    gpEmptyHint.classList.remove("hidden");
  } finally {
    gpRefreshBtn.textContent = "↻ Refresh";
    gpRefreshBtn.disabled = false;
  }
}

function renderGpPeople(people) {
  const visible = people.filter(p => p.filenameCount > 0 || p.name || p.thumbnailUrl);

  // Clear existing person cards only (keep gpEmptyHint in the DOM)
  Array.from(gpPeopleList.children).forEach(child => {
    if (child !== gpEmptyHint) child.remove();
  });
  gpEmptyHint.classList.toggle("hidden", visible.length > 0);

  for (const person of visible) {
    const card = document.createElement("div");
    card.className = "gp-person-card";

    // Thumbnail
    if (person.thumbnailUrl) {
      const img = document.createElement("img");
      img.className = "gp-person-thumb";
      img.src = person.thumbnailUrl;
      img.alt = person.name || "Person";
      card.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "gp-person-thumb-placeholder";
      ph.textContent = "👤";
      card.appendChild(ph);
    }

    // Info
    const info = document.createElement("div");
    info.className = "gp-person-info";
    const nameEl = document.createElement("div");
    nameEl.className = "gp-person-name";
    nameEl.textContent = person.name || `Person (${person.id.slice(0, 8)}…)`;
    const countEl = document.createElement("div");
    countEl.className = "gp-person-count";
    countEl.textContent = person.filenameCount > 0
      ? `${person.filenameCount} photos captured from Google Photos`
      : "Browse their page in Google Photos to capture photos";
    info.appendChild(nameEl);
    info.appendChild(countEl);
    card.appendChild(info);

    // Actions
    const actions = document.createElement("div");
    actions.className = "gp-person-actions";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "gp-person-name-input";
    nameInput.placeholder = "Drive folder name";
    nameInput.value = person.name || "";
    nameInput.maxLength = 40;

    const moveBtn = document.createElement("button");
    moveBtn.className = "btn-gp-move";
    moveBtn.textContent = "Move to Drive";
    moveBtn.disabled = person.filenameCount === 0;
    moveBtn.addEventListener("click", () => gpStartMove(person.id, nameInput.value.trim() || nameEl.textContent));

    actions.appendChild(nameInput);
    actions.appendChild(moveBtn);
    card.appendChild(actions);

    gpPeopleList.appendChild(card);
    if (!gpEmptyHint.classList.contains("hidden")) gpEmptyHint.classList.add("hidden");
  }
}

async function gpStartMove(personId, folderName) {
  if (!folderName) { alert("Please enter a folder name."); return; }

  gpProgressWrap.classList.remove("hidden");
  gpResult.classList.add("hidden");
  gpProgressLabel.textContent = "Searching Drive…";
  gpProgressMeta.textContent = "";
  gpProgressBar.style.width = "0%";

  const res = await sendMessage("GPHOTO_MATCH_AND_MOVE", { personId, folderName });

  gpProgressWrap.classList.add("hidden");

  if (!res?.ok) {
    gpResult.textContent = "Error: " + (res?.error || "Unknown error");
    gpResult.style.background = "#fee2e2";
    gpResult.style.borderColor = "#fca5a5";
    gpResult.style.color = "#991b1b";
    gpResult.classList.remove("hidden");
    return;
  }

  gpResult.style.background = "#d1fae5";
  gpResult.style.borderColor = "#6ee7b7";
  gpResult.style.color = "#065f46";
  gpResult.textContent = `Done! Searched ${res.filenameCount} filenames → found ${res.matched} in Drive → moved ${res.moved} photos to "${folderName}/" folder.`;
  gpResult.classList.remove("hidden");
  gpRefreshPeopleList();
}

// Listen for progress updates from background for gpMatch operation
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "PROGRESS_UPDATE" || msg?.operation !== "gpMatch") return;
  const pct = msg.total > 0 ? Math.round((msg.processed / msg.total) * 100) : 0;
  gpProgressLabel.textContent = msg.message || "Working…";
  gpProgressMeta.textContent = `${msg.processed}/${msg.total}`;
  gpProgressBar.style.width = pct + "%";
});

// Returns a human-readable "5 minutes", "2 hours", "3 days" etc.
function timeSince(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)            return "just now";
  if (sec < 3600)          return `${Math.floor(sec / 60)} min`;
  if (sec < 86400)         return `${Math.floor(sec / 3600)} hr`;
  if (sec < 86400 * 30)    return `${Math.floor(sec / 86400)} day${Math.floor(sec/86400)!==1?"s":""}`;
  if (sec < 86400 * 365)   return `${Math.floor(sec / (86400*30))} month${Math.floor(sec/(86400*30))!==1?"s":""}`;
  return `${Math.floor(sec / (86400 * 365))} year${Math.floor(sec/(86400*365))!==1?"s":""}`;
}
