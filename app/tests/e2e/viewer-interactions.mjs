// Exercises the 3D viewer on an existing backend result (no backend run needed).
//
//   node tests/e2e/viewer-interactions.mjs [result dir] [screenshot dir]
//
// Uses real mouse clicks on the canvas, so picking goes through the actual raycasting path.

import { _electron as electron } from "playwright-core";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appDir = path.resolve(import.meta.dirname, "..", "..");
const resultDir = path.resolve(process.argv[2] || path.join(appDir, "..", "output", "patient1"));
const shotDir = path.resolve(process.argv[3] || path.join(appDir, "tests", "e2e", "output"));
fs.mkdirSync(shotDir, { recursive: true });

// VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
const app = await electron.launch({ args: [appDir, `--result=${resultDir}`], cwd: appDir, env });
const page = await app.firstWindow();
const problems = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

const shot = (name) => page.screenshot({ path: path.join(shotDir, `${name}.png`) });
const settle = () => page.waitForTimeout(700); // view animations take 450 ms
const step = (msg) => console.log(`✔ ${msg}`);

const selectedName = () => page.evaluate(() => {
  const v = window.__orthovizViewer;
  return v.selected === null ? null : v.structures.get(v.selected).info.name;
});
const tagText = () => page.evaluate(() => {
  const tag = document.querySelector(".tag");
  return tag.hidden ? null : tag.querySelector(".tag-code").textContent;
});
const isBehind = async () => { await page.waitForTimeout(300); return page.$eval(".tag", (t) => t.classList.contains("tag-behind")); };
const cameraDistance = () => page.evaluate(() => { const v = window.__orthovizViewer; return v.camera.position.distanceTo(v.controls.target); });
const labelOf = (name) => page.evaluate((n) => window.__orthovizViewer.listStructures().find((s) => s.info.name === n).label, name);
const screenPos = (name) => page.evaluate((n) => {
  const v = window.__orthovizViewer;
  return v.screenPositionOf(v.listStructures().find((s) => s.info.name === n).label);
}, name);
/**
 * Screen position of the structure's surface point nearest the camera. That point faces
 * the viewer, so a correct pick there must return this structure (unless something
 * solid is in front). A bounding-box centre is not good enough: for a vertebra it sits
 * in the spinal canal, and from the front a neighbour's body can be in the way.
 */
const nearestPointOnScreen = (name) => page.evaluate((n) => {
  const v = window.__orthovizViewer;
  const { mesh } = [...v.structures.values()].find((s) => s.info.name === n);
  const Vec = v.camera.position.constructor;
  const pos = mesh.geometry.attributes.position;
  let best = null, bestDist = Infinity;
  const w = new Vec();
  for (let i = 0; i < pos.count; i++) {
    w.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const d = w.distanceTo(v.camera.position);
    if (d < bestDist) { bestDist = d; best = w.clone(); }
  }
  const p = best.project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
}, name);

/** Click a structure where it faces the camera; returns what got selected. */
async function clickOn(name) {
  const p = await nearestPointOnScreen(name);
  await page.mouse.click(p.x, p.y);
  return selectedName();
}

await page.waitForSelector('body[data-screen="viewer"]', { timeout: 60_000 });
await page.waitForSelector(".structure-list .row");
await settle();

// --- Panel contents
const groups = await page.$$eval(".group-header", (els) => els.map((e) => `${e.querySelector(".group-title").textContent} (${e.querySelector(".group-count").textContent})`));
const spineOrder = await page.$$eval(".group:first-child .row-name", (els) => els.map((e) => e.textContent));
console.log("Groups:", groups.join(", "));
console.log("Spine order:", spineOrder.join(", "));
assert.deepStrictEqual(spineOrder.slice(0, 8), ["C1 vertebra", "C2 vertebra", "C3 vertebra", "C4 vertebra", "C5 vertebra", "C6 vertebra", "C7 vertebra", "T1 vertebra"]);
assert.strictEqual(await page.getAttribute('.segmented [data-filter="all"]', "aria-pressed"), "true");
await shot("v1-front");
step("panel lists structures by group, spine in anatomical order; 'Everything' filter active");

// --- Fracture check on the real result
const findings = await page.$$eval(".findings li", (els) => els.map((e) => [e.dataset.level, e.dataset.tone]));
console.log("Findings:", findings.map(([l, t]) => `${l}:${t}`).join(" "));
assert.deepStrictEqual(findings.map(([l]) => l), ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]);
assert.deepStrictEqual(findings.slice(0, 2).map(([, t]) => t), ["muted", "muted"], "C1/C2 not checked");
assert.ok(findings.every(([, t]) => t !== "fracture"), "healthy patient1: nothing flagged");
assert.match(await page.textContent(".findings-scope"), /C1 and C2 are not checked/);
const redMeshes = await page.evaluate(() => [...window.__orthovizViewer.structures.values()].filter((s) => s.mesh.material.color.getHex() === 0xd64541).length);
assert.strictEqual(redMeshes, 0);
step("fracture check: C1–C7 listed, C1/C2 'not checked', nothing flagged or red for the healthy patient");

// --- Click a vertebra in the 3D view (front view: through the see-through windpipe and vessels)
const pickedFront = await clickOn("vertebrae_C5");
assert.strictEqual(pickedFront, "vertebrae_C5");
assert.strictEqual(await tagText(), "C5");
assert.strictEqual(await page.getAttribute('.row[data-name="vertebrae_C5"]', "class"), "row selected");
console.log("  tag detail:", await page.textContent(".tag-detail"));
assert.strictEqual(await isBehind(), false, "C5 is visible from the front");
await shot("v2-click-c5");
step("clicking C5 highlights it, labels it 'C5', and selects its panel row");

// --- Dragging (rotating) must not change the selection
const p = await screenPos("vertebrae_C3");
await page.mouse.move(p.x, p.y);
await page.mouse.down();
await page.mouse.move(p.x + 60, p.y + 10, { steps: 5 });
await page.mouse.up();
assert.strictEqual(await selectedName(), "vertebrae_C5");
step("drag-to-rotate over another vertebra keeps the selection");

// --- Preset views
await page.click('[data-view="side"]');
await settle();
const camSide = await page.evaluate(() => window.__orthovizViewer.camera.position.toArray().map(Math.round));
assert.ok(camSide[0] > 0 && Math.abs(camSide[1]) < 1 && Math.abs(camSide[2]) < 1, `side camera at ${camSide}`);
assert.strictEqual(await clickOn("vertebrae_C2"), "vertebrae_C2");
assert.strictEqual(await tagText(), "C2");
await shot("v3-side-c2");
step("Side view: camera on the patient's left; clicking C2 labels it");

await page.click('[data-view="top"]');
await settle();
const camTop = await page.evaluate(() => window.__orthovizViewer.camera.position.toArray().map(Math.round));
assert.ok(camTop[1] > 0 && Math.abs(camTop[0]) < 1, `top camera at ${camTop}`);
// From above, C1 and C2 show through the opening in the skull base; C3 and below are hidden.
assert.strictEqual(await isBehind(), false, "C2 is visible through the foramen magnum");
await page.click('.row[data-name="vertebrae_C4"] .row-name');
assert.strictEqual(await isBehind(), true, "C4 is hidden under the skull from above");
await shot("v4-top");
step("Top view: camera above the patient; C2 counts as visible, C4's label is marked '(behind)'");

await page.click('[data-view="front"]');
await settle();

// --- Quick filters and toggles
const distAll = await cameraDistance();
await page.click('.segmented [data-filter="spine"]');
await settle();
const distSpine = await cameraDistance();
assert.ok(distSpine < distAll * 0.8, `camera should move in for the spine (${distAll.toFixed(0)} -> ${distSpine.toFixed(0)})`);
const visibleNames = () => page.evaluate(() => window.__orthovizViewer.listStructures().filter((s) => s.visible).map((s) => s.info.name));
const spineOnly = await visibleNames();
assert.ok(spineOnly.every((n) => n.startsWith("vertebrae_") || n === "spinal_cord"), spineOnly.join());
assert.strictEqual(await page.getAttribute('.segmented [data-filter="spine"]', "aria-pressed"), "true");
await shot("v5-spine-only");
step(`'Spine' filter shows only vertebrae and spinal cord (${spineOnly.length} structures) and zooms to fit (${distAll.toFixed(0)} -> ${distSpine.toFixed(0)} mm)`);

await page.click('.segmented [data-filter="bones"]');
await settle();
const bones = await visibleNames();
assert.ok(bones.includes("skull") && bones.includes("vertebrae_C1") && !bones.includes("spinal_cord") && !bones.includes("trachea"));
await shot("v6-bones");
step(`'Bones' filter shows all bones (${bones.length}) and hides soft tissue`);

// Hiding the selected structure clears the selection; the group checkbox goes indeterminate.
await page.click('.row[data-name="vertebrae_C3"] .row-name');
assert.strictEqual(await tagText(), "C3");
await page.click('.row[data-name="vertebrae_C3"] input[type="checkbox"]');
assert.strictEqual(await selectedName(), null);
assert.strictEqual(await tagText(), null);
assert.strictEqual(await page.$eval(".group:first-child .group-header input", (el) => el.indeterminate), true);
assert.strictEqual(await page.getAttribute('.segmented [data-filter="bones"]', "aria-pressed"), "false");
step("selecting from the panel labels C3; hiding it clears the label and the spine group shows partial");

// Clicking a hidden structure's name shows and selects it.
await page.click('.row[data-name="vertebrae_C3"] .row-name');
assert.strictEqual(await selectedName(), "vertebrae_C3");
assert.strictEqual(await page.$eval('.row[data-name="vertebrae_C3"] input', (el) => el.checked), true);
step("clicking a hidden structure's name shows and selects it");

// Group checkbox hides the whole group.
await page.click('.group:nth-child(2) .group-header input');
const afterGroupOff = await visibleNames();
console.log("  after unticking group 2:", afterGroupOff.length, "visible");

// --- Clearing the selection
await page.keyboard.press("Escape");
assert.strictEqual(await selectedName(), null);
await page.click('.row[data-name="vertebrae_C4"] .row-name');
const corner = await page.$eval("#viewport", (el) => { const r = el.getBoundingClientRect(); return { x: r.left + 40, y: r.bottom - 60 }; });
await page.mouse.click(corner.x, corner.y);
assert.strictEqual(await selectedName(), null);
step("Escape and clicking empty space both clear the selection");

await page.click('.segmented [data-filter="all"]');
await page.click('.row[data-name="vertebrae_C4"] .row-name');
await settle();
await shot("v7-everything-c4");

await app.close();

// --- Display of a flagged vertebra. MOCK DATA: patient1's real result with a fracture flag
// added to C5, only to check how the viewer shows a flag (no real scan is involved).
const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "orthoviz-mock-flag-"));
for (const f of ["segmentation.nii.gz", "labels.json"]) fs.copyFileSync(path.join(resultDir, f), path.join(mockDir, f));
const report = JSON.parse(fs.readFileSync(path.join(resultDir, "fractures.json"), "utf8"));
Object.assign(report.vertebrae.find((v) => v.level === "C5"),
  { status: "fracture", grade: "moderate (Genant grade 2)", height_loss: 0.31, pattern: "wedge" });
report.flagged = ["C5"];
fs.writeFileSync(path.join(mockDir, "fractures.json"), JSON.stringify(report));

const app2 = await electron.launch({ args: [appDir, `--result=${mockDir}`], cwd: appDir, env });
const page2 = await app2.firstWindow();
page2.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
await page2.waitForSelector('body[data-screen="viewer"]', { timeout: 60_000 });
await page2.waitForSelector(".findings li");
const c5Colour = await page2.evaluate(() => { const v = window.__orthovizViewer; return v.structures.get(v.labelForLevel("C5")).mesh.material.color.getHex(); });
assert.strictEqual(c5Colour, 0xd64541, "flagged C5 is red");
assert.match(await page2.textContent(".findings-summary"), /Possible fracture: C5/);
assert.strictEqual(await page2.getAttribute('.findings li[data-level="C5"]', "data-tone"), "fracture");
assert.match(await page2.textContent("#viewer-title"), /possible fracture: C5/);
await page2.click('.findings li[data-level="C5"] .finding-level');
assert.match(await page2.textContent(".tag-finding"), /Possible fracture · 31% loss of height at the front — moderate/);
// The mock flag has no marker data (like results made before markers existed): no comparison drawn.
assert.strictEqual(await page2.evaluate(() => window.__orthovizViewer.marker), null);
assert.strictEqual(await page2.isVisible(".marker-label"), false);
await page2.waitForTimeout(500);
await page2.screenshot({ path: path.join(shotDir, "v8-mock-flag-c5.png") });
await app2.close();
fs.rmSync(mockDir, { recursive: true, force: true });
step("(mock data) a flagged vertebra is red, listed in Findings, and its label explains the height loss; no marker without marker data");

// --- Height comparison on the real demo case (patient_fracture4: C7 flagged, 75% front height lost).
const demoDir = path.resolve(appDir, "..", "output", "patient_fracture4");
if (fs.existsSync(path.join(demoDir, "fractures.json"))) {
  const app3 = await electron.launch({ args: [appDir, `--result=${demoDir}`], cwd: appDir, env });
  const page3 = await app3.firstWindow();
  page3.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(`${m.type()}: ${m.text()}`); });
  page3.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page3.waitForSelector('body[data-screen="viewer"]', { timeout: 60_000 });
  await page3.waitForSelector(".findings li");
  const distBefore = await page3.evaluate(() => { const v = window.__orthovizViewer; return v.camera.position.distanceTo(v.controls.target); });
  await page3.click('[data-view="side"]');
  await page3.waitForTimeout(700);
  await page3.click('.findings li[data-level="C7"] .finding-level');
  await page3.waitForTimeout(800);
  const marker = await page3.evaluate(() => window.__orthovizViewer.marker?.group.children.length ?? 0);
  assert.ok(marker > 0, "marker drawn for flagged C7");
  assert.match(await page3.textContent(".marker-loss"), /^75% lost$/);
  assert.strictEqual(await page3.isVisible(".marker-label"), true);
  const distAfter = await page3.evaluate(() => { const v = window.__orthovizViewer; return v.camera.position.distanceTo(v.controls.target); });
  assert.ok(distAfter < distBefore * 0.6, `clicking C7 in the findings zooms in (${distBefore.toFixed(0)} -> ${distAfter.toFixed(0)})`);
  await page3.screenshot({ path: path.join(shotDir, "v9-demo-c7-height-comparison.png") });
  await page3.click('.findings li[data-level="C6"] .finding-level');   // healthy vertebra: no marker
  assert.strictEqual(await page3.evaluate(() => window.__orthovizViewer.marker), null);
  await page3.click('.findings li[data-level="C7"] .finding-level');
  await page3.keyboard.press("Escape");                                  // deselect: marker goes too
  assert.strictEqual(await page3.evaluate(() => window.__orthovizViewer.marker), null);
  assert.strictEqual(await page3.isVisible(".marker-label"), false);
  await app3.close();
  step("demo case: selecting flagged C7 zooms in and draws now-vs-healthy height with '75% lost'; healthy vertebra or Escape removes it");
} else {
  console.log("(skipped demo-case check: output/patient_fracture4 not present)");
}

console.log(problems.length ? `Console problems:\n${problems.join("\n")}` : "No console errors or warnings");
console.log(`Screenshots: ${shotDir}`);
if (problems.length) process.exit(1);
