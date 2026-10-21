// UI flow: Import screen -> Processing screen -> 3D viewer.

import { Viewer } from "./viewer.js";
import { StructurePanel } from "./panel.js";

const api = window.orthoviz;
const $ = (id) => document.getElementById(id);

const SCREENS = ["import", "processing", "viewer"];
const appInfo = api.appInfo();
let viewer = null;
let panel = null;

function show(screen) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== screen;
  document.body.dataset.screen = screen;
}

// --- Import ------------------------------------------------------------------

function showImportError(message) {
  $("import-error").textContent = message;
  $("import-error").hidden = !message;
}

$("choose-folder").addEventListener("click", async () => {
  const folder = await api.selectFolder();
  if (folder) beginProcessing(folder);
});

const dropZone = $("drop-zone");
// Prevent the window from navigating to a file dropped anywhere outside the zone.
for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());
dropZone.addEventListener("dragenter", () => dropZone.classList.add("dragging"));
dropZone.addEventListener("dragover", (e) => {
  e.dataTransfer.dropEffect = "copy";
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", (e) => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("dragging");
});
dropZone.addEventListener("drop", async (e) => {
  dropZone.classList.remove("dragging");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const folder = api.pathForDroppedFile(file);
  const check = await api.checkFolder(folder);
  if (!check.ok) return showImportError(check.message);
  beginProcessing(folder);
});

// --- Processing ----------------------------------------------------------------

const STAGE_TEXT = {
  starting: () => "Starting…",
  preparing: (p) => `Getting ready for first use — installing AI models (${Math.min(p.done + 1, p.total)} of ${p.total})`,
  loading: (p) => (p.slices ? `Reading scan files (${p.slices} images)` : "Reading scan files"),
  segmenting: (p) => `Identifying bones and tissues — step ${Math.max(p.part, 1)} of ${p.parts}`,
  saving: () => "Saving results",
  checking: () => "Checking the neck vertebrae (C3–C7) for loss of height",
  meshing: () => "Creating the 3D model",
};

const processing = {
  folder: null,
  outputDir: null,
  progress: null,
  partStarts: [], // partStarts[k] = time model part k+1 started, for the estimate
  timer: null,
};

async function beginProcessing(folder) {
  showImportError("");
  Object.assign(processing, { folder, outputDir: null, progress: null, partStarts: [] });
  $("processing-folder").textContent = folder;
  $("processing-active").hidden = false;
  $("processing-failed").hidden = true;
  $("cancel-processing").disabled = false;
  setProgress({ stage: "starting", fraction: 0, startedAt: Date.now() });
  show("processing");

  try {
    const { outputDir } = await api.startProcessing(folder);
    processing.outputDir = outputDir;
  } catch (e) {
    return showProcessingError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "");
  }
  clearInterval(processing.timer);
  processing.timer = setInterval(renderTime, 1000);
}

function setProgress(p) {
  if (p.stage === "segmenting" && p.part > processing.partStarts.length) {
    processing.partStarts[p.part - 1] = Date.now();
  }
  processing.progress = p;
  const pct = Math.round(p.fraction * 100);
  $("processing-stage").textContent = STAGE_TEXT[p.stage](p);
  $("progress-fill").style.width = `${pct}%`;
  $("progress-percent").textContent = `${pct}%`;
  document.querySelector(".progress").setAttribute("aria-valuenow", String(pct));
  renderTime();
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Counts down from the duration of the last finished model part. Steadier than a rate
 * from the bar, which moves in coarse jumps. The first part includes model warm-up, so
 * the first estimate tends to run long, which is the safer direction for a patient.
 */
function remainingSeconds() {
  const p = processing.progress;
  const starts = processing.partStarts;
  if (!p || p.stage !== "segmenting" || starts.length < 2) return null;
  const k = starts.length; // current part (1-based)
  const partSeconds = (starts[k - 1] - starts[k - 2]) / 1000;
  const inCurrent = (Date.now() - starts[k - 1]) / 1000;
  return Math.max(partSeconds * (p.parts - k + 1) - inCurrent, 0) + 5; // + a few seconds to save
}

function renderTime() {
  const p = processing.progress;
  if (!p) return;
  const elapsed = formatDuration((Date.now() - p.startedAt) / 1000);
  const left = remainingSeconds();
  let text = `Elapsed ${elapsed}`;
  if (left !== null) {
    text += left < 60 ? " · Less than a minute left" : ` · About ${Math.ceil(left / 60)} min left`;
  }
  $("progress-time").textContent = text;
}

function showProcessingError(message, details) {
  clearInterval(processing.timer);
  $("processing-active").hidden = true;
  $("processing-failed").hidden = false;
  $("processing-error").textContent = message;
  $("processing-details").textContent = details || "";
  $("processing-details-box").hidden = !details;
}

api.onProgress((p) => setProgress(p));

api.onFinished(async (result) => {
  clearInterval(processing.timer);
  if (result.cancelled) return show("import");
  if (!result.ok) return showProcessingError(result.message, result.details);
  setProgress({ ...processing.progress, stage: "meshing", fraction: 0.97 });
  await openResult(result.outputDir, processing.folder);
});

$("cancel-processing").addEventListener("click", () => {
  $("cancel-processing").disabled = true;
  $("processing-stage").textContent = "Cancelling…";
  api.cancelProcessing();
});

$("processing-back").addEventListener("click", () => show("import"));

// --- Viewer --------------------------------------------------------------------

async function openResult(outputDir, sourceFolder) {
  let model;
  try {
    model = await api.buildModel(outputDir);
  } catch (e) {
    show("processing");
    return showProcessingError("The scan was processed, but the 3D model could not be created.", e.message);
  }

  show("viewer");
  if (!viewer) createViewer();
  viewer.setModel(model);
  panel.render(model.fractures);
  const name = (sourceFolder || outputDir).split("/").filter(Boolean).pop();
  const flagged = model.fractures?.flagged ?? [];
  $("viewer-title").textContent = `${name} · ${model.meshes.length} structures`
    + (flagged.length ? ` · possible fracture: ${flagged.join(", ")}` : "");
  document.body.dataset.meshCount = String(model.meshes.length);
}

function createViewer() {
  viewer = new Viewer($("viewport"), { onSelect: (label) => panel?.showSelection(label) });
  panel = new StructurePanel({
    list: $("structure-list"),
    findings: $("findings"),
    filterButtons: [...document.querySelectorAll(".segmented button")],
    viewer,
  });
  for (const button of document.querySelectorAll(".view-presets button")) {
    button.addEventListener("click", () => viewer.setView(button.dataset.view));
  }
  // Handle for the e2e tests (tests/e2e/viewer-interactions.mjs); never exposed in the packaged app.
  appInfo.then(({ isPackaged }) => {
    if (!isPackaged) window.__orthovizViewer = viewer;
  });
}

$("viewer-new-scan").addEventListener("click", () => show("import"));

// --- About ----------------------------------------------------------------------

for (const button of document.querySelectorAll("[data-open-about]")) {
  button.addEventListener("click", () => $("about-dialog").showModal());
}
$("about-licenses").addEventListener("click", () => api.openLicenses());
$("about-close").addEventListener("click", () => $("about-dialog").close());
appInfo.then(({ version }) => ($("about-version").textContent = `Version ${version}`));

// Dev shortcut: `npm start -- --result=<output dir>` skips straight to the viewer.
api.startupResult().then((dir) => {
  if (dir) openResult(dir, null);
});
