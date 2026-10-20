// Minimal NIfTI-1 reader (.nii / .nii.gz) — enough for the backend's outputs.

const fs = require("node:fs");
const zlib = require("node:zlib");

const DATATYPES = {
  2: Uint8Array,
  4: Int16Array,
  8: Int32Array,
  16: Float32Array,
  64: Float64Array,
  256: Int8Array,
  512: Uint16Array,
  768: Uint32Array,
};

/**
 * Returns {dims: [nx, ny, nz], spacing: [dx, dy, dz], affine: 4x4 row-major array, data: TypedArray}.
 * `affine` maps voxel indices (i, j, k) to RAS world millimetres.
 */
function readNifti(filePath) {
  let buf = fs.readFileSync(filePath);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return parseNifti(buf);
}

function parseNifti(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let le = true;
  if (view.getInt32(0, true) !== 348) {
    if (view.getInt32(0, false) !== 348) throw new Error("Not a NIfTI-1 file");
    le = false;
  }
  const i16 = (o) => view.getInt16(o, le);
  const f32 = (o) => view.getFloat32(o, le);

  const ndim = i16(40);
  if (ndim < 3) throw new Error(`Expected a 3D volume, got ${ndim} dimension(s)`);
  const dims = [i16(42), i16(44), i16(46)];
  const extra = Array.from({ length: ndim - 3 }, (_, k) => i16(48 + 2 * k));
  if (extra.some((d) => d > 1)) throw new Error("4D NIfTI volumes are not supported");

  const datatype = i16(70);
  const Type = DATATYPES[datatype];
  if (!Type) throw new Error(`Unsupported NIfTI datatype ${datatype}`);

  const qfac = f32(76) < 0 ? -1 : 1;
  const spacing = [f32(80), f32(84), f32(88)].map(Math.abs);
  const voxOffset = Math.round(f32(108));

  const affine = i16(254) > 0 ? sformAffine(f32) : qformAffine(f32, spacing, qfac);

  const count = dims[0] * dims[1] * dims[2];
  const bytes = buf.subarray(voxOffset, voxOffset + count * Type.BYTES_PER_ELEMENT);
  if (bytes.length < count * Type.BYTES_PER_ELEMENT) throw new Error("NIfTI file is truncated");

  // Copy into an aligned buffer, swapping bytes if the file is big-endian.
  const data = new Type(count);
  const out = new Uint8Array(data.buffer);
  out.set(bytes);
  if (!le && Type.BYTES_PER_ELEMENT > 1) swapBytes(out, Type.BYTES_PER_ELEMENT);

  return { dims, spacing, affine, data };
}

function sformAffine(f32) {
  const row = (o) => [f32(o), f32(o + 4), f32(o + 8), f32(o + 12)];
  return [row(280), row(296), row(312), [0, 0, 0, 1]];
}

function qformAffine(f32, [dx, dy, dz], qfac) {
  const b = f32(256), c = f32(260), d = f32(264);
  const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
  const R = [
    [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
    [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
    [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
  ];
  const offset = [f32(268), f32(272), f32(276)];
  return [0, 1, 2].map((r) => [R[r][0] * dx, R[r][1] * dy, R[r][2] * dz * qfac, offset[r]]).concat([[0, 0, 0, 1]]);
}

function swapBytes(bytes, size) {
  for (let i = 0; i < bytes.length; i += size) {
    for (let a = i, b = i + size - 1; a < b; a++, b--) {
      const t = bytes[a];
      bytes[a] = bytes[b];
      bytes[b] = t;
    }
  }
}

module.exports = { readNifti, parseNifti };
