// Stages everything electron-builder copies into OrthoViz.app/Contents/Resources:
//   build-resources/totalsegmentator-weights/  the model weights the app needs, for offline use
//   build-resources/licenses/                  third-party notices
// and checks the frozen backend (backend/build/dist/orthoviz-segment) exists.
//
// Weights come from TOTALSEG_WEIGHTS_SOURCE, or ~/.totalsegmentator/nnunet/results.
// Only the models used by full-resolution task "total" are staged (see
// totalsegmentator/map_tasks_config.py: total -> default -> task_id 291-295); not config.json,
// which holds the developer's own TotalSegmentator ID and settings.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REQUIRED_MODELS = [
  "Dataset291_TotalSegmentator_part1_organs_1559subj",
  "Dataset292_TotalSegmentator_part2_vertebrae_1532subj",
  "Dataset293_TotalSegmentator_part3_cardiac_1559subj",
  "Dataset294_TotalSegmentator_part4_muscles_1559subj",
  "Dataset295_TotalSegmentator_part5_ribs_1559subj",
];

const appDir = path.resolve(import.meta.dirname, "..");
const backendDir = path.resolve(appDir, "..", "backend");
const stage = path.join(appDir, "build-resources");
const fail = (msg) => { console.error(`prepare-resources: ${msg}`); process.exit(1); };

// 1. Frozen backend
const backendBinary = path.join(backendDir, "build", "dist", "orthoviz-segment", "orthoviz-segment");
if (!fs.existsSync(backendBinary)) fail(`frozen backend missing at ${backendBinary}; run "npm run build:backend" first`);

// 2. Weights
const source = process.env.TOTALSEG_WEIGHTS_SOURCE || path.join(os.homedir(), ".totalsegmentator", "nnunet", "results");
const weightsOut = path.join(stage, "totalsegmentator-weights");
fs.rmSync(weightsOut, { recursive: true, force: true });
for (const model of REQUIRED_MODELS) {
  const from = path.join(source, model);
  const trainer = fs.existsSync(from) && fs.readdirSync(from).find((d) => d.includes("__nnUNetPlans__3d_fullres"));
  if (!trainer || !fs.existsSync(path.join(from, trainer, "fold_0", "checkpoint_final.pth"))) {
    fail(`model ${model} missing or incomplete in ${source}`);
  }
  fs.cpSync(from, path.join(weightsOut, model), {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE, // APFS clone: no extra disk space
    filter: (src) => !path.basename(src).startsWith("."), // .DS_Store, ._ AppleDouble files
  });
}
console.log(`staged ${REQUIRED_MODELS.length} models from ${source}`);

// 3. Licenses
const licensesOut = path.join(stage, "licenses");
fs.rmSync(licensesOut, { recursive: true, force: true });
execFileSync(path.join(backendDir, ".venv", "bin", "python"), [path.join(backendDir, "packaging", "collect_licenses.py"), licensesOut], { stdio: "inherit" });
fs.copyFileSync(path.join(appDir, "node_modules", "three", "LICENSE"), path.join(licensesOut, "three.js-LICENSE.txt"));
console.log(`staged licenses in ${licensesOut}`);
