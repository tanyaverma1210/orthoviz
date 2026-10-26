const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWeights, userWeightsDir } = require("../../src/main/weights");

function makeModel(dir, name, files = { "plans.json": "{}", "fold_0/checkpoint_final.pth": "weights" }) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, name, "trainer", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weights-"));
  const bundled = path.join(root, "bundled");
  const target = path.join(root, "home", ".totalsegmentator", "nnunet", "results");
  makeModel(bundled, "Dataset291");
  makeModel(bundled, "Dataset292");
  return { bundled, target };
}

const read = (target, model) => fs.readFileSync(path.join(target, model, "trainer", "fold_0", "checkpoint_final.pth"), "utf8");

test("installs all bundled models on a fresh machine, then does nothing", async () => {
  const { bundled, target } = setup();
  const progress = [];
  assert.deepStrictEqual(await ensureWeights({ bundledDir: bundled, targetDir: target, onProgress: (p) => progress.push(p) }), ["Dataset291", "Dataset292"]);
  assert.strictEqual(read(target, "Dataset292"), "weights");
  assert.deepStrictEqual(progress.map((p) => p.done), [0, 1, 2]);
  assert.deepStrictEqual(fs.readdirSync(target).sort(), ["Dataset291", "Dataset292"], "no temp folders left");
  assert.deepStrictEqual(await ensureWeights({ bundledDir: bundled, targetDir: target }), []);
});

test("replaces an incomplete model folder but leaves a user's complete copy alone", async () => {
  const { bundled, target } = setup();
  makeModel(target, "Dataset291", { "plans.json": "{}" }); // interrupted download: no checkpoint
  makeModel(target, "Dataset292", { "plans.json": "{}", "fold_0/checkpoint_final.pth": "user's newer weights" });
  assert.deepStrictEqual(await ensureWeights({ bundledDir: bundled, targetDir: target }), ["Dataset291"]);
  assert.strictEqual(read(target, "Dataset291"), "weights");
  assert.strictEqual(read(target, "Dataset292"), "user's newer weights");
});

test("stops between models when cancelled", async () => {
  const { bundled, target } = setup();
  let calls = 0;
  const installed = await ensureWeights({ bundledDir: bundled, targetDir: target, isCancelled: () => calls++ > 0 });
  assert.strictEqual(fs.readdirSync(target).length, 1);
  assert.deepStrictEqual(installed, ["Dataset291"]); // the next run installs the rest
});

test("weights dir follows TotalSegmentator's environment variables", () => {
  assert.strictEqual(userWeightsDir({}, "/Users/a"), "/Users/a/.totalsegmentator/nnunet/results");
  assert.strictEqual(userWeightsDir({ TOTALSEG_HOME_DIR: "/data/ts" }, "/Users/a"), "/data/ts/nnunet/results");
  assert.strictEqual(userWeightsDir({ TOTALSEG_WEIGHTS_PATH: "/w" }, "/Users/a"), "/w");
});
