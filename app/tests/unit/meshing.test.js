const test = require("node:test");
const assert = require("node:assert");
const { buildMeshes, signedVolume } = require("../../src/main/meshing");

function sphereVolume(n, radius, { spacing = [1, 1, 1], affine } = {}) {
  const data = new Uint8Array(n * n * n);
  const c = (n - 1) / 2;
  let voxels = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const inside = (x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2 <= radius ** 2;
    if (inside) { data[x + n * (y + n * z)] = 7; voxels++; }
  }
  affine ??= [[spacing[0], 0, 0, 0], [0, spacing[1], 0, 0], [0, 0, spacing[2], 0], [0, 0, 0, 1]];
  return { volume: { dims: [n, n, n], spacing, affine, data }, voxels };
}

function edgeUseCounts(indices) {
  const counts = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e], b = indices[t + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

test("a voxel sphere becomes a closed, outward-facing mesh of the right size", () => {
  const { volume } = sphereVolume(40, 15);
  const [mesh] = buildMeshes(volume, { 7: "ball" }, { targetSpacing: 1 });
  assert.strictEqual(mesh.name, "ball");
  const vol = signedVolume(mesh.positions, mesh.indices);
  const expected = (4 / 3) * Math.PI * 15 ** 3;
  assert.ok(vol > 0, "normals should face outward");
  assert.ok(Math.abs(vol - expected) / expected < 0.05, `volume ${vol} vs ${expected}`);
  for (const n of edgeUseCounts(mesh.indices).values()) assert.strictEqual(n, 2, "mesh should be watertight");
});

test("mirrored (negative-determinant) affines keep normals outward", () => {
  const affine = [[-1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]];
  const { volume } = sphereVolume(30, 10, { affine });
  const [mesh] = buildMeshes(volume, { 7: "ball" }, { targetSpacing: 1 });
  assert.ok(signedVolume(mesh.positions, mesh.indices) > 0);
});

test("anisotropic voxels are downsampled toward the target spacing and placed in mm", () => {
  const { volume } = sphereVolume(60, 25, { spacing: [0.25, 0.25, 0.5] });
  const [mesh] = buildMeshes(volume, { 7: "ball" }, { targetSpacing: 1 });
  const xs = mesh.positions.filter((_, i) => i % 3 === 0);
  const zs = mesh.positions.filter((_, i) => i % 3 === 2);
  // Sphere of radius 25 voxels -> 6.25 mm across x, 12.5 mm across z (an ellipsoid in mm).
  assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) / 2 - 6.25) < 1, "x radius");
  assert.ok(Math.abs((Math.max(...zs) - Math.min(...zs)) / 2 - 12.5) < 1, "z radius");
});

test("labels too small to mesh are skipped", () => {
  const data = new Uint8Array(10 * 10 * 10);
  data[5 + 10 * (5 + 10 * 5)] = 3;
  const volume = { dims: [10, 10, 10], spacing: [1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], data };
  assert.deepStrictEqual(buildMeshes(volume, { 3: "speck" }), []);
});
