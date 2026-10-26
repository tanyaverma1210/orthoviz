// Offline test of the packaged app, as on a fresh Mac:
//
//   node tests/e2e/packaged-offline.mjs [path/to/OrthoViz.app] [screenshot dir]
//
// - HOME is a new empty folder, so there is no ~/.totalsegmentator: the app must install
//   the bundled weights on first use.
// - Network is blocked for the app's whole process tree (not the machine) with a
//   sandbox-exec profile that denies outbound connections except to localhost; macOS logs
//   each denied attempt and the test collects them.
// - HTTP(S)_PROXY / ALL_PROXY and Chromium's --proxy-server point at a local trap that
//   records any proxied request and the host it was for.
// - lsof is polled for sockets to anything other than localhost.
// Then runs a full segmentation of dicom_samples/patient1 and reports every attempt seen.

import { _electron as electron } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..", "..");
const appBundle = path.resolve(process.argv[2] || path.join(appDir, "dist", "mac-arm64", "OrthoViz.app"));
const shotDir = path.resolve(process.argv[3] || path.join(appDir, "tests", "e2e", "output"));
const sampleFolder = path.resolve(appDir, "..", "dicom_samples", "patient1");
const executable = path.join(appBundle, "Contents", "MacOS", "OrthoViz");
assert.ok(fs.existsSync(executable), `no packaged app at ${appBundle}`);
fs.mkdirSync(shotDir, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), "orthoviz-offline-"));
const fakeHome = path.join(work, "home");
fs.mkdirSync(fakeHome);
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);

// --- 1. Proxy trap: accept, record what was asked for, close.
const proxyHits = [];
const trap = net.createServer((sock) => {
  sock.once("data", (buf) => {
    proxyHits.push(buf.toString("latin1").split("\r\n")[0]);
    sock.destroy();
  });
  sock.on("error", () => {});
});
await new Promise((r) => trap.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${trap.address().port}`;

// --- 2. Sandbox profile + wrapper so Playwright launches the app inside it.
const profile = path.join(work, "no-network.sb");
fs.writeFileSync(profile, `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
`);
const wrapper = path.join(work, "orthoviz-sandboxed");
fs.writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f "${profile}" "${executable}" "$@"\n`, { mode: 0o755 });

// Denied network attempts from the sandbox, as logged by macOS.
const sandboxDenials = [];
const logStream = spawn("/usr/bin/log", ["stream", "--style", "compact", "--predicate",
  'eventMessage CONTAINS[c] "deny" AND eventMessage CONTAINS[c] "network"']);
logStream.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (/network/i.test(line) && /deny/i.test(line) && /OrthoViz|orthoviz-segment/i.test(line)) sandboxDenials.push(line.trim());
  }
});

// --- 3. Socket watch.
const remoteSockets = new Set();
const appPids = () => {
  try { return execFileSync("pgrep", ["-f", appBundle]).toString().trim().split("\n").filter(Boolean); } catch { return []; }
};
// lsof NAME column, e.g. "127.0.0.1:5000->127.0.0.1:5001 (ESTABLISHED)" or "*:5000 (LISTEN)".
const isLocal = (name) => name.split(" ")[0].split("->")
  .every((endpoint) => /^(127\.0\.0\.1|\[::1\]|localhost|\*):\d+$/.test(endpoint));
const socketWatch = setInterval(() => {
  const pids = appPids();
  if (!pids.length) return;
  try {
    const out = execFileSync("lsof", ["-nP", "-a", "-i", "-p", pids.join(",")], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    for (const line of out.split("\n").slice(1).filter(Boolean)) {
      const name = line.split(/\s+/).slice(8).join(" ");
      if (!isLocal(name)) remoteSockets.add(`${line.split(/\s+/)[0]}: ${name}`);
    }
  } catch { /* lsof exits 1 when there are no sockets */ }
}, 200);

// --- Launch the packaged app (clean env: no dev overrides).
const env = { ...process.env, HOME: fakeHome, ORTHOVIZ_RESULTS_DIR: path.join(work, "results") };
for (const k of ["ELECTRON_RUN_AS_NODE", "ORTHOVIZ_BACKEND", "TOTALSEG_HOME_DIR", "TOTALSEG_WEIGHTS_PATH", "NO_PROXY", "no_proxy"]) delete env[k];
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[k] = proxyUrl;

// --no-sandbox: Chromium's helpers can't set up their own macOS sandbox inside sandbox-exec
// (nested sandboxes aren't permitted). This only affects Chromium's process isolation for
// this test run; the outer sandbox-exec network block still covers every process.
const app = await electron.launch({ executablePath: wrapper, args: ["--no-sandbox", `--proxy-server=${proxyUrl}`], env });
const page = await app.firstWindow();
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(e.message));
await app.evaluate(({ dialog }, folder) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
}, sampleFolder);
await page.waitForSelector('body[data-screen="import"]');
log(`packaged app launched (sandboxed, HOME=${fakeHome})`);

const info = await page.evaluate(async () => ({ hook: typeof window.__orthovizViewer, packaged: (await window.orthoviz.appInfo()).isPackaged }));
assert.strictEqual(info.packaged, true);

await page.click("#choose-folder");
await page.waitForSelector('body[data-screen="processing"]');
const stages = [];
let lastStage = "";
let backendPath = null;
while (Date.now() - t0 < 20 * 60_000) {
  if ((await page.getAttribute("body", "data-screen")) === "viewer") break;
  if (await page.isVisible("#processing-failed")) {
    log(`FAILED: ${await page.textContent("#processing-error")}`);
    log(await page.textContent("#processing-details"));
    break;
  }
  const stage = await page.textContent("#processing-stage");
  if (stage !== lastStage) {
    log(stage);
    stages.push(stage);
    lastStage = stage;
  }
  if (!backendPath) {
    try { backendPath = execFileSync("pgrep", ["-fl", "orthoviz-segment"]).toString().split("\n").find((l) => l.includes(appBundle)); } catch {}
  }
  await page.waitForTimeout(500);
}

const reachedViewer = (await page.getAttribute("body", "data-screen")) === "viewer";
if (reachedViewer) {
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shotDir, "packaged-viewer.png") });
  log(`viewer: ${await page.textContent("#viewer-title")}`);
  const infoAfter = await page.evaluate(() => typeof window.__orthovizViewer);
  info.hook = infoAfter;
  info.findings = await page.$$eval(".findings li", (els) => els.map((e) => `${e.dataset.level}:${e.dataset.tone}`).join(" "));
  info.findingsSummary = await page.textContent(".findings-summary");
}
await app.close();
await new Promise((r) => setTimeout(r, 1500)); // let late log lines arrive
clearInterval(socketWatch);
logStream.kill();
trap.close();

const installed = fs.existsSync(path.join(fakeHome, ".totalsegmentator", "nnunet", "results"))
  ? fs.readdirSync(path.join(fakeHome, ".totalsegmentator", "nnunet", "results")) : [];

console.log("\n=== Results ===");
console.log(`Full segmentation completed:      ${reachedViewer ? "yes" : "NO"}`);
console.log(`Backend used:                     ${backendPath ? backendPath.replace(/^\d+\s+/, "").split(" ")[0] : "(not seen)"}`);
console.log(`First-use weight install shown:   ${stages.some((s) => s.startsWith("Getting ready")) ? "yes" : "no"}`);
console.log(`Weights installed in fake HOME:   ${installed.filter((n) => !n.startsWith(".")).join(", ") || "none"}`);
console.log(`window.__orthovizViewer:          ${info.hook}`);
console.log(`Fracture check (Phase 2):         ${info.findingsSummary ?? "(none)"} [${info.findings ?? ""}]`);
console.log(`Proxied requests (trap):          ${proxyHits.length ? proxyHits.join("; ") : "none"}`);
console.log(`Sandbox-denied connections:       ${sandboxDenials.length ? "\n  " + sandboxDenials.join("\n  ") : "none"}`);
console.log(`Non-local sockets seen (lsof):    ${remoteSockets.size ? [...remoteSockets].join("; ") : "none"}`);
console.log(`Console errors:                   ${problems.length ? problems.join("; ") : "none"}`);

assert.ok(reachedViewer, "segmentation did not complete");
assert.strictEqual(info.hook, "undefined", "test hook must not exist in the packaged app");
assert.strictEqual(installed.filter((n) => n.startsWith("Dataset")).length, 5, "weights not installed");
assert.strictEqual(info.findings?.split(" ").length, 7, "fracture check should list C1-C7");
fs.rmSync(work, { recursive: true, force: true });
