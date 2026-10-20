// Turns a multi-label segmentation volume into one smooth triangle mesh per structure.
//
// TotalSegmentator predicts on a 1.5 mm grid and the backend resamples labels back to
// scan resolution, so every boundary is a staircase of 1.5 mm blocks. Method:
//   1. downsample the label grid to roughly `targetSpacing` mm (finer adds triangles, not detail);
//   2. per structure, blur its binary mask with a Gaussian of `blurSigma` mm, which
//      dissolves the block steps;
//   3. extract the 0.5 level with surface nets, interpolating vertex positions;
//   4. finish with light Taubin smoothing (smooths without shrinking).

const DEFAULTS = { targetSpacing: 0.75, blurSigma: 1.0, smoothIterations: 6, minVoxels: 8 };
const ISO = 0.5;

/**
 * @param volume {dims, spacing, affine, data} from readNifti
 * @param labelNames {value: name}
 * @returns [{label, name, positions: Float32Array (RAS mm), indices: Uint32Array}]
 */
function buildMeshes(volume, labelNames, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { grid, gridDims, stride, boxes } = downsampleLabels(volume, opts.targetSpacing);
  const sigmaCells = volume.spacing.map((s, a) => opts.blurSigma / (s * stride[a]));
  const pad = Math.ceil(3 * Math.max(...sigmaCells)) + 1;

  const meshes = [];
  for (const [value, box] of boxes) {
    if (box.count < opts.minVoxels) continue;
    const { field, dims, origin } = extractMask(grid, gridDims, value, box, pad);
    if (opts.blurSigma > 0) gaussianBlur(field, dims, sigmaCells);
    const { positions, quads } = surfaceNets(field, dims, ISO);
    if (quads.length === 0) continue;

    toWorld(positions, origin, stride, volume.affine);
    taubinSmooth(positions, quads, opts.smoothIterations);
    const flip = determinant3(volume.affine) < 0;
    meshes.push({
      label: value,
      name: labelNames[value] || `label_${value}`,
      positions,
      indices: triangulate(quads, flip),
    });
  }
  return meshes;
}

function downsampleLabels({ dims, spacing, data }, targetSpacing) {
  const stride = spacing.map((s) => Math.max(1, Math.round(targetSpacing / s)));
  const gridDims = dims.map((d, a) => Math.ceil(d / stride[a]));
  const [gx, gy, gz] = gridDims;
  const grid = new Uint16Array(gx * gy * gz);
  const boxes = new Map();

  const [nx, ny] = dims;
  let g = 0;
  for (let z = 0; z < gz; z++) {
    const zOff = z * stride[2] * nx * ny;
    for (let y = 0; y < gy; y++) {
      const yzOff = zOff + y * stride[1] * nx;
      for (let x = 0; x < gx; x++, g++) {
        const v = data[yzOff + x * stride[0]];
        if (v === 0) continue;
        grid[g] = v;
        let b = boxes.get(v);
        if (!b) boxes.set(v, (b = { min: [x, y, z], max: [x, y, z], count: 0 }));
        b.count++;
        if (x < b.min[0]) b.min[0] = x; else if (x > b.max[0]) b.max[0] = x;
        if (y < b.min[1]) b.min[1] = y; else if (y > b.max[1]) b.max[1] = y;
        if (z < b.min[2]) b.min[2] = z; else if (z > b.max[2]) b.max[2] = z;
      }
    }
  }
  return { grid, gridDims, stride, boxes };
}

/**
 * 0/1 mask of one label inside its bounding box, as floats, padded by `pad` empty voxels
 * on every side (enough that blurring never reaches the outer layer).
 */
function extractMask(grid, [gx, gy], value, box, pad = 1) {
  const dims = [0, 1, 2].map((a) => box.max[a] - box.min[a] + 1 + 2 * pad);
  const [X, Y] = dims;
  const [bx, by, bz] = [0, 1, 2].map((a) => box.max[a] - box.min[a] + 1);
  const field = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < bz; z++) {
    for (let y = 0; y < by; y++) {
      const src = box.min[0] + gx * ((box.min[1] + y) + gy * (box.min[2] + z));
      const dst = pad + X * ((y + pad) + Y * (z + pad));
      for (let x = 0; x < bx; x++) {
        if (grid[src + x] === value) field[dst + x] = 1;
      }
    }
  }
  // Grid coordinate of padded index 0.
  const origin = box.min.map((m) => m - pad);
  return { field, dims, origin };
}

/** Separable Gaussian blur in place; `sigmas` are per-axis, in voxels. */
function gaussianBlur(field, dims, sigmas) {
  const steps = [1, dims[0], dims[0] * dims[1]];
  const line = new Float32Array(Math.max(...dims));
  for (let axis = 0; axis < 3; axis++) {
    const sigma = sigmas[axis];
    if (sigma < 0.2) continue;
    const radius = Math.ceil(3 * sigma);
    const kernel = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += (kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma)));
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

    const n = dims[axis];
    const step = steps[axis];
    const [o1, o2] = [0, 1, 2].filter((a) => a !== axis);
    for (let j = 0; j < dims[o2]; j++) {
      for (let i = 0; i < dims[o1]; i++) {
        const base = i * steps[o1] + j * steps[o2];
        for (let k = 0; k < n; k++) line[k] = field[base + k * step];
        for (let k = 0; k < n; k++) {
          let acc = 0;
          const lo = Math.max(0, k - radius), hi = Math.min(n - 1, k + radius);
          for (let t = lo; t <= hi; t++) acc += line[t] * kernel[t - k + radius];
          field[base + k * step] = acc;
        }
      }
    }
  }
}

// Cube corners k = 0..7 sit at offset (k & 1, (k >> 1) & 1, (k >> 2) & 1).
const CUBE_EDGES = [];
for (let a = 0; a < 8; a++) {
  for (let bit = 0; bit < 3; bit++) if (!(a & (1 << bit))) CUBE_EDGES.push([a, a | (1 << bit)]);
}

/**
 * Surface nets on a scalar field whose border voxels are all below `iso`.
 * "Inside" means field > iso. Returns vertex positions in grid coordinates and quads
 * (4 indices each) wound so that, with a right-handed frame, normals point outward.
 */
function surfaceNets(field, [X, Y, Z], iso = ISO) {
  const inside = new Uint8Array(field.length);
  for (let i = 0; i < field.length; i++) inside[i] = field[i] > iso ? 1 : 0;
  const XY = X * Y;
  const steps = [1, X, XY];
  const corner = Array.from({ length: 8 }, (_, k) => (k & 1) + ((k >> 1) & 1) * X + ((k >> 2) & 1) * XY);
  const cellVertex = new Int32Array(X * Y * Z).fill(-1);
  const pos = [];

  // One vertex per cell that straddles the surface, at the mean of the points where
  // its edges cross the iso level (linearly interpolated along each edge).
  for (let z = 0; z < Z - 1; z++) {
    for (let y = 0; y < Y - 1; y++) {
      for (let x = 0; x < X - 1; x++) {
        const base = x + X * y + XY * z;
        let mask = 0;
        for (let k = 0; k < 8; k++) if (inside[base + corner[k]]) mask |= 1 << k;
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of CUBE_EDGES) {
          if (((mask >> a) & 1) === ((mask >> b) & 1)) continue;
          const fa = field[base + corner[a]], fb = field[base + corner[b]];
          const t = (iso - fa) / (fb - fa);
          sx += (a & 1) + t * ((b & 1) - (a & 1));
          sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          n++;
        }
        cellVertex[base] = pos.length / 3;
        pos.push(x + sx / n, y + sy / n, z + sz / n);
      }
    }
  }

  // One quad per voxel edge that crosses the surface, joining the four cells around it.
  // Edges starting in the padding layer count too; a crossing edge never lies in a
  // padding plane of the other two axes, so the neighbouring cells always exist.
  const quads = [];
  for (let z = 0; z < Z - 1; z++) {
    for (let y = 0; y < Y - 1; y++) {
      for (let x = 0; x < X - 1; x++) {
        const v = x + X * y + XY * z;
        const a = inside[v];
        for (let d = 0; d < 3; d++) {
          if (a === inside[v + steps[d]]) continue;
          const su = steps[(d + 1) % 3];
          const sw = steps[(d + 2) % 3];
          const c0 = cellVertex[v], c1 = cellVertex[v - su], c2 = cellVertex[v - su - sw], c3 = cellVertex[v - sw];
          if (a) quads.push(c0, c1, c2, c3);
          else quads.push(c0, c3, c2, c1);
        }
      }
    }
  }

  return { positions: new Float32Array(pos), quads: new Uint32Array(quads) };
}

function toWorld(positions, origin, stride, A) {
  for (let i = 0; i < positions.length; i += 3) {
    const vi = (positions[i] + origin[0]) * stride[0];
    const vj = (positions[i + 1] + origin[1]) * stride[1];
    const vk = (positions[i + 2] + origin[2]) * stride[2];
    positions[i] = A[0][0] * vi + A[0][1] * vj + A[0][2] * vk + A[0][3];
    positions[i + 1] = A[1][0] * vi + A[1][1] * vj + A[1][2] * vk + A[1][3];
    positions[i + 2] = A[2][0] * vi + A[2][1] * vj + A[2][2] * vk + A[2][3];
  }
}

/** Taubin λ|μ smoothing over the quad mesh's vertex neighbourhoods (in place). */
function taubinSmooth(positions, quads, iterations, lambda = 0.5, mu = -0.53) {
  if (iterations <= 0) return;
  const nVerts = positions.length / 3;

  // Neighbour lists in CSR form, from quad edges.
  const degree = new Uint32Array(nVerts);
  for (let q = 0; q < quads.length; q += 4) {
    for (let e = 0; e < 4; e++) {
      degree[quads[q + e]]++;
      degree[quads[q + ((e + 1) & 3)]]++;
    }
  }
  const start = new Uint32Array(nVerts + 1);
  for (let i = 0; i < nVerts; i++) start[i + 1] = start[i] + degree[i];
  const neighbours = new Uint32Array(start[nVerts]);
  const fill = start.slice(0, nVerts);
  for (let q = 0; q < quads.length; q += 4) {
    for (let e = 0; e < 4; e++) {
      const a = quads[q + e], b = quads[q + ((e + 1) & 3)];
      neighbours[fill[a]++] = b;
      neighbours[fill[b]++] = a;
    }
  }

  const next = new Float32Array(positions.length);
  for (let pass = 0; pass < 2 * iterations; pass++) {
    const f = pass % 2 === 0 ? lambda : mu;
    for (let v = 0; v < nVerts; v++) {
      const s = start[v], e = start[v + 1];
      const i = 3 * v;
      if (s === e) {
        next[i] = positions[i]; next[i + 1] = positions[i + 1]; next[i + 2] = positions[i + 2];
        continue;
      }
      let mx = 0, my = 0, mz = 0;
      for (let k = s; k < e; k++) {
        const j = 3 * neighbours[k];
        mx += positions[j]; my += positions[j + 1]; mz += positions[j + 2];
      }
      const inv = 1 / (e - s);
      next[i] = positions[i] + f * (mx * inv - positions[i]);
      next[i + 1] = positions[i + 1] + f * (my * inv - positions[i + 1]);
      next[i + 2] = positions[i + 2] + f * (mz * inv - positions[i + 2]);
    }
    positions.set(next);
  }
}

function triangulate(quads, flip) {
  const tris = new Uint32Array((quads.length / 4) * 6);
  for (let q = 0, t = 0; q < quads.length; q += 4, t += 6) {
    const [a, b, c, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
    if (flip) tris.set([a, c, b, a, d, c], t);
    else tris.set([a, b, c, a, c, d], t);
  }
  return tris;
}

function determinant3(A) {
  return A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
    - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
    + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
}

/** Signed volume enclosed by a triangle mesh (positive when normals face outward). */
function signedVolume(positions, indices) {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
    const [ax, ay, az] = [positions[a], positions[a + 1], positions[a + 2]];
    const [bx, by, bz] = [positions[b], positions[b + 1], positions[b + 2]];
    const [cx, cy, cz] = [positions[c], positions[c + 1], positions[c + 2]];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}

module.exports = { buildMeshes, surfaceNets, taubinSmooth, signedVolume, downsampleLabels };
