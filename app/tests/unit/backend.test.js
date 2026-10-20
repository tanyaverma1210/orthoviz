const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ProgressParser, lineSplitter, friendlyError } = require("../../src/main/backend");

// Real output from `orthoviz-segment dicom_samples/patient1 ...` (tqdm redraws use "\r").
const LOG = fs.readFileSync(path.join(__dirname, "..", "fixtures", "backend-patient1.log"), "utf8");

function feedAll(text) {
  const parser = new ProgressParser();
  const history = [];
  const split = lineSplitter((line) => {
    if (parser.feed(line)) history.push(parser.snapshot());
  });
  // Feed in awkward chunk sizes to exercise line reassembly.
  for (let i = 0; i < text.length; i += 37) split(text.slice(i, i + 37));
  return { parser, history };
}

test("progress over a real backend log is monotonic and covers all five model parts", () => {
  const { parser, history } = feedAll(LOG);
  const fractions = history.map((h) => h.fraction);
  for (let i = 1; i < fractions.length; i++) assert.ok(fractions[i] >= fractions[i - 1]);
  assert.deepStrictEqual([...new Set(history.map((h) => h.stage))], ["loading", "segmenting", "saving"]);
  assert.strictEqual(parser.slices, 429);
  assert.strictEqual(parser.part, 5);
  assert.ok(Math.abs(parser.fraction - 0.95) < 1e-9);
  // Every part contributes: progress just after part 1 ends is about one fifth of the way through prediction.
  const afterPart1 = history.find((h) => h.part === 2);
  assert.ok(afterPart1.fraction > 0.2 && afterPart1.fraction < 0.3, String(afterPart1.fraction));
});

test("repeated 100% bar lines do not advance to the next part", () => {
  const parser = new ProgressParser();
  parser.feed("INFO Running TotalSegmentator (full resolution, device=mps)...");
  for (const l of ["0/8 [00:00", "8/8 [01:31", "8/8 [01:31"]) parser.feed(` ${l}`);
  assert.strictEqual(parser.part, 1);
  parser.feed("  0/8 [00:00");
  assert.strictEqual(parser.part, 2);
});

test("DICOM load errors become a plain-language message", () => {
  const msg = friendlyError(["2026-10-19 ERROR Could not load DICOM folder: No DICOM image files found in /x"], 2, null);
  assert.match(msg, /doesn't look like a CT scan.*No DICOM image files found/);
});
