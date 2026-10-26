// Electron main process: owns the window, the backend subprocess and mesh building.

const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");

const { BackendRun, backendCommand } = require("./backend");
const { ensureWeights } = require("./weights");

let mainWindow = null;
let currentRun = null;

function resultsRoot() {
  return process.env.ORTHOVIZ_RESULTS_DIR || path.join(app.getPath("userData"), "results");
}

/** Folder holding bundled resources: Contents/Resources when packaged, build staging in dev. */
function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..", "build-resources");
}

const ATTRIBUTION = [
  "Anatomical segmentation by TotalSegmentator (Apache License 2.0),",
  "Wasserthal et al., Radiology: Artificial Intelligence 2023, doi:10.1148/ryai.230024,",
  "built on nnU-Net (Apache License 2.0).",
  "Full third-party licenses: OrthoViz.app/Contents/Resources/licenses/",
].join("\n");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "OrthoViz",
    backgroundColor: "#101418",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// --- IPC ---------------------------------------------------------------------

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a folder of DICOM files",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("check-folder", async (_event, folder) => {
  try {
    const stat = fs.statSync(folder);
    if (!stat.isDirectory()) return { ok: false, message: "That is a file, not a folder. Please drop the folder that contains the scan." };
    const files = fs.readdirSync(folder).filter((f) => !f.startsWith("."));
    if (files.length === 0) return { ok: false, message: "That folder is empty." };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `Could not open that folder (${e.code || e.message}).` };
  }
});

ipcMain.handle("start-processing", async (_event, dicomFolder) => {
  if (currentRun) throw new Error("A scan is already being processed");

  const command = backendCommand({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  if (!fs.existsSync(command)) {
    throw new Error(`Backend not found at ${command}. See backend/README.md for setup.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(resultsRoot(), `${path.basename(dicomFolder)}-${stamp}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const run = new BackendRun({ command, dicomFolder, outputDir });
  currentRun = run;
  run.on("progress", (p) => send("processing-progress", p));
  run.on("finished", (result) => {
    currentRun = null;
    send("processing-finished", result);
  });

  // First use: install the bundled model weights so the backend never downloads them.
  prepareWeights(run)
    .then(() => {
      if (run.cancelled) return run.emit("finished", { ok: false, cancelled: true, message: "Processing was cancelled.", details: "" });
      run.start();
    })
    .catch((e) => run.emit("finished", {
      ok: false,
      cancelled: false,
      message: "OrthoViz could not set up its segmentation models on this computer.",
      details: e.stack || e.message,
    }));
  return { outputDir };
});

async function prepareWeights(run) {
  await ensureWeights({
    bundledDir: path.join(resourcesDir(), "totalsegmentator-weights"),
    isCancelled: () => run.cancelled,
    onProgress: ({ done, total }) => send("processing-progress", {
      stage: "preparing", fraction: 0, done, total, startedAt: run.startedAt,
    }),
  });
}

ipcMain.handle("cancel-processing", async () => {
  if (!currentRun) return;
  if (currentRun.child) currentRun.cancel();
  else currentRun.cancelled = true; // still installing weights; stops before the backend starts
});

ipcMain.handle("app-info", async () => ({ isPackaged: app.isPackaged, version: app.getVersion() }));

ipcMain.handle("open-licenses", async () => {
  const dir = path.join(resourcesDir(), "licenses");
  const error = await shell.openPath(fs.existsSync(dir) ? dir : resourcesDir());
  if (error) throw new Error(error);
});

ipcMain.handle("build-model", async (_event, outputDir) => buildModel(outputDir));

// Dev convenience: `npm start -- --result=<output dir>` opens a finished result directly.
ipcMain.handle("startup-result", async () => {
  const arg = process.argv.find((a) => a.startsWith("--result="));
  return arg ? path.resolve(arg.slice("--result=".length)) : null;
});

function buildModel(outputDir) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "mesh-worker.js"), {
      workerData: {
        segmentationPath: path.join(outputDir, "segmentation.nii.gz"),
        labelsPath: path.join(outputDir, "labels.json"),
      },
    });
    worker.once("message", (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.model)));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Mesh worker exited with code ${code}`));
    });
  });
}

// --- App lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: "OrthoViz", applicationVersion: app.getVersion(), credits: ATTRIBUTION });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  if (currentRun) currentRun.cancel();
});
