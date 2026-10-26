// Installs the bundled TotalSegmentator model weights into the user's weights folder
// so segmentation never needs to download anything.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Where TotalSegmentator looks for weights (mirrors totalsegmentator.config.get_weights_dir). */
function userWeightsDir(env = process.env, home = os.homedir()) {
  if (env.TOTALSEG_WEIGHTS_PATH) return env.TOTALSEG_WEIGHTS_PATH;
  const totalsegDir = env.TOTALSEG_HOME_DIR || path.join(home, ".totalsegmentator");
  return path.join(totalsegDir, "nnunet", "results");
}

/** Relative path -> size for every file under `dir`. */
function listFiles(dir) {
  const files = new Map();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(dir, full), fs.statSync(full).size);
  }
  return files;
}

/**
 * True if `installed` has every file the bundled copy has. Sizes are not compared, so a
 * user's own (e.g. newer) copy of a model is left alone; only incomplete folders, which
 * TotalSegmentator would wrongly treat as present, get replaced.
 */
function isComplete(bundled, installed) {
  if (!fs.existsSync(installed)) return false;
  const have = listFiles(installed);
  return [...listFiles(bundled).keys()].every((f) => have.has(f));
}

/**
 * Copy any missing model folders from `bundledDir` into `targetDir`.
 * Each folder is copied to a temporary name and renamed into place, so an interrupted
 * copy never leaves a half-filled folder behind.
 * @returns names of the folders that were installed
 */
async function ensureWeights({ bundledDir, targetDir = userWeightsDir(), onProgress = () => {}, isCancelled = () => false }) {
  if (!fs.existsSync(bundledDir)) return [];
  const models = fs.readdirSync(bundledDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);
  const missing = models.filter((m) => !isComplete(path.join(bundledDir, m), path.join(targetDir, m)));
  if (missing.length === 0) return [];

  fs.mkdirSync(targetDir, { recursive: true });
  const installed = [];
  for (const [i, model] of missing.entries()) {
    if (isCancelled()) break;
    onProgress({ done: i, total: missing.length, model });
    const finalPath = path.join(targetDir, model);
    const tempPath = path.join(targetDir, `.${model}.partial-${process.pid}`);
    fs.rmSync(tempPath, { recursive: true, force: true });
    await fs.promises.cp(path.join(bundledDir, model), tempPath, { recursive: true });
    fs.rmSync(finalPath, { recursive: true, force: true }); // an incomplete earlier copy
    fs.renameSync(tempPath, finalPath);
    installed.push(model);
  }
  onProgress({ done: installed.length, total: missing.length });
  return installed;
}

module.exports = { ensureWeights, userWeightsDir, isComplete };
