// Worker thread: reads the backend's segmentation and builds meshes off the main thread.

const fs = require("node:fs");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
const { readNifti } = require("./nifti");
const { buildMeshes } = require("./meshing");

try {
  const started = Date.now();
  const volume = readNifti(workerData.segmentationPath);
  const labels = JSON.parse(fs.readFileSync(workerData.labelsPath, "utf8"));
  const meshes = buildMeshes(volume, labels);
  // Phase 2 result; absent for results made before fracture screening existed.
  const fracturesPath = path.join(path.dirname(workerData.labelsPath), "fractures.json");
  const fractures = fs.existsSync(fracturesPath) ? JSON.parse(fs.readFileSync(fracturesPath, "utf8")) : null;

  const transfer = meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer]);
  parentPort.postMessage(
    {
      model: {
        meshes,
        fractures,
        triangleCount: meshes.reduce((n, m) => n + m.indices.length / 3, 0),
        buildSeconds: (Date.now() - started) / 1000,
      },
    },
    transfer,
  );
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
