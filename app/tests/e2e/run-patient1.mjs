// End-to-end test against the real backend: Import -> Processing -> Viewer on dicom_samples/patient1.
//
//   node tests/e2e/run-patient1.mjs [screenshot dir]
//
// The folder dialog is stubbed to return the sample folder; everything else is real.
// Also checks that Cancel stops the backend and all of TotalSegmentator's worker processes.

import { _electron as electron } from "playwright-core";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..", "..");
const sampleFolder = path.resolve(appDir, "..", "dicom_samples", "patient1");
const shotDir = path.resolve(process.argv[2] || path.join(appDir, "tests", "e2e", "output"));
fs.mkdirSync(shotDir, { recursive: true });
const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orthoviz-e2e-"));

// VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
const app = await electron.launch({ args: [appDir], cwd: appDir, env: { ...env, ORTHOVIZ_RESULTS_DIR: resultsDir } });
const page = await app.firstWindow();
const problems = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
const backendProcesses = () => {
  try { return execSync(`pgrep -f "orthoviz-segment ${sampleFolder}"`).toString().trim().split("\n").filter(Boolean); }
  catch { return []; }
};
const workerProcesses = () => {
  try { return execSync(`pgrep -f "multiprocessing" | xargs ps -o pid=,command= -p | grep "${path.resolve(appDir, "..", "backend")}"`).toString().trim().split("\n").filter(Boolean); }
  catch { return []; }
};
const shot = async (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) });

await app.evaluate(({ dialog }, folder) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
}, sampleFolder);

await page.waitForSelector('body[data-screen="import"]');
await shot("1-import");
log("Import screen shown");

// --- Cancel: start, wait until the models are running, cancel, confirm nothing is left behind.
await page.click("#choose-folder");
await page.waitForSelector('body[data-screen="processing"]');
await page.waitForFunction(() => document.getElementById("processing-stage").textContent.startsWith("Identifying"), null, { timeout: 120_000 });
log(`Cancel test: backend running (${backendProcesses().length} process), clicking Cancel`);
await page.click("#cancel-processing");
await page.waitForSelector('body[data-screen="import"]', { timeout: 30_000 });
await page.waitForTimeout(3000);
const leftovers = [...backendProcesses(), ...workerProcesses()];
log(leftovers.length ? `Cancel test FAILED, still running:\n${leftovers.join("\n")}` : "Cancel test passed: back on Import screen, no backend processes left");

// --- Full run.
await page.click("#choose-folder");
await page.waitForSelector('body[data-screen="processing"]');
log("Processing screen shown");

let lastText = "";
let midShotTaken = false;
const deadline = Date.now() + 20 * 60_000;
while (Date.now() < deadline) {
  const screen = await page.getAttribute("body", "data-screen");
  if (screen === "viewer") break;
  if (await page.isVisible("#processing-failed")) {
    log(`FAILED: ${await page.textContent("#processing-error")}`);
    await shot("error");
    break;
  }
  const text = [
    await page.textContent("#processing-stage"),
    await page.textContent("#progress-percent"),
    await page.textContent("#progress-time"),
  ].join(" | ").replace(/Elapsed \d+:\d+/, "");
  if (text !== lastText) {
    log(text);
    lastText = text;
  }
  if (text.includes("step 1 of") && !(await fileExists("2-processing-start"))) await shot("2-processing-start");
  if (!midShotTaken && text.includes("min left")) {
    await shot("3-processing-estimate");
    midShotTaken = true;
  }
  await page.waitForTimeout(1000);
}

if ((await page.getAttribute("body", "data-screen")) === "viewer") {
  await page.waitForTimeout(1500);
  await shot("4-viewer");
  log(`Viewer shown: ${await page.textContent("#viewer-title")}`);
}

console.log(problems.length ? `Console problems:\n${problems.join("\n")}` : "No console errors or warnings");
console.log(`Screenshots: ${shotDir}`);
await app.close();
fs.rmSync(resultsDir, { recursive: true, force: true });

async function fileExists(name) {
  return fs.existsSync(path.join(shotDir, `${name}.png`));
}
