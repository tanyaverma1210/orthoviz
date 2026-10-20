import test from "node:test";
import assert from "node:assert";
import { describe, vertebraInfo } from "../../src/renderer/anatomy.js";

test("vertebrae get a short code and a plain-language description", () => {
  assert.deepStrictEqual(
    [describe("vertebrae_C3").tag, describe("vertebrae_C3").detail],
    ["C3", "3rd neck vertebra (cervical)"],
  );
  assert.strictEqual(describe("vertebrae_C1").detail, "1st neck vertebra (cervical), the atlas");
  assert.strictEqual(describe("vertebrae_T12").detail, "12th upper-back vertebra (thoracic)");
  assert.strictEqual(describe("vertebrae_L4").detail, "4th lower-back vertebra (lumbar)");
  assert.strictEqual(vertebraInfo("skull"), null);
});

test("other structures get everyday names and sensible groups", () => {
  const cases = {
    clavicula_left: ["Left collarbone", "bones"],
    rib_right_3: ["Right rib 3", "bones"],
    trachea: ["Windpipe (trachea)", "organs"],
    common_carotid_artery_right: ["Right carotid artery", "vessels"],
    brachiocephalic_vein_left: ["Left brachiocephalic vein", "vessels"],
    autochthon_left: ["Left deep back muscles", "muscles"],
    lung_upper_lobe_right: ["Right lung, upper lobe", "organs"],
    spinal_cord: ["Spinal cord", "cord"],
    kidney_cyst_left: ["Left kidney cyst", "organs"], // unknown label: humanized fallback
  };
  for (const [name, [display, group]] of Object.entries(cases)) {
    assert.deepStrictEqual([describe(name).display, describe(name).group], [display, group], name);
  }
});

test("the spine sorts top to bottom and paired structures sort together", () => {
  const sorted = ["vertebrae_T1", "vertebrae_C7", "vertebrae_L1", "vertebrae_C1", "vertebrae_T10"]
    .map(describe).sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((d) => d.tag);
  assert.deepStrictEqual(sorted, ["C1", "C7", "T1", "T10", "L1"]);
  const ribs = ["rib_left_10", "rib_right_2", "rib_left_2"].map(describe)
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map((d) => d.display);
  assert.deepStrictEqual(ribs, ["Left rib 2", "Right rib 2", "Left rib 10"]);
});
