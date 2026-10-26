const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readNifti } = require("../../src/main/nifti");

function makeNifti({ dims, datatype, bitpix, values, srow, littleEndian = true }) {
  const voxOffset = 352;
  const buf = Buffer.alloc(voxOffset + values.length * (bitpix / 8));
  const w16 = (o, v) => (littleEndian ? buf.writeInt16LE(v, o) : buf.writeInt16BE(v, o));
  const wf = (o, v) => (littleEndian ? buf.writeFloatLE(v, o) : buf.writeFloatBE(v, o));
  littleEndian ? buf.writeInt32LE(348, 0) : buf.writeInt32BE(348, 0);
  w16(40, 3); dims.forEach((d, i) => w16(42 + 2 * i, d)); w16(48, 1);
  w16(70, datatype); w16(72, bitpix);
  wf(76, 1); wf(80, Math.hypot(...srow[0].slice(0, 3))); wf(84, Math.hypot(...srow[1].slice(0, 3))); wf(88, Math.hypot(...srow[2].slice(0, 3)));
  wf(108, voxOffset);
  w16(254, 1);
  srow.forEach((row, r) => row.forEach((v, c) => wf(280 + 16 * r + 4 * c, v)));
  buf.write("n+1\0", 344, "latin1");
  values.forEach((v, i) => (bitpix === 8 ? buf.writeUInt8(v, voxOffset + i)
    : littleEndian ? buf.writeInt16LE(v, voxOffset + 2 * i) : buf.writeInt16BE(v, voxOffset + 2 * i)));
  return buf;
}

const SROW = [[-0.5, 0, 0, 10], [0, -0.5, 0, 20], [0, 0, 2, -30]];

test("reads a gzipped uint8 volume with its sform affine", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nii-")), "seg.nii.gz");
  fs.writeFileSync(file, zlib.gzipSync(makeNifti({ dims: [2, 3, 4], datatype: 2, bitpix: 8, values: Array.from({ length: 24 }, (_, i) => i), srow: SROW })));
  const vol = readNifti(file);
  assert.deepStrictEqual(vol.dims, [2, 3, 4]);
  assert.deepStrictEqual(vol.spacing, [0.5, 0.5, 2]);
  assert.deepStrictEqual(vol.affine, [...SROW, [0, 0, 0, 1]]);
  assert.ok(vol.data instanceof Uint8Array);
  assert.strictEqual(vol.data[23], 23);
});

test("reads big-endian int16 data", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nii-")), "ct.nii");
  fs.writeFileSync(file, makeNifti({ dims: [2, 2, 2], datatype: 4, bitpix: 16, values: [-1024, 0, 1, 2, 3, 4, 5, 3000], srow: SROW, littleEndian: false }));
  const vol = readNifti(file);
  assert.deepStrictEqual(Array.from(vol.data), [-1024, 0, 1, 2, 3, 4, 5, 3000]);
});
