# OrthoViz — Electron app

Electron shell + Three.js UI (design doc §3, §9): Import screen → Processing screen → 3D viewer.
The viewer has a structure panel (grouped list with colour swatches, show/hide toggles,
and Everything / Bones / Spine quick filters), click-to-name (click a vertebra to highlight
it and label it, e.g. "C3 — 3rd neck vertebra (cervical)"), and Front / Side / Top views.

## Setup

Requires Node.js (`brew install node`) and the backend set up per [../backend/README.md](../backend/README.md).

```sh
cd app
npm install
npm start                                   # full app
npm start -- --result=../output/patient1    # open an existing backend result in the viewer
```

`npm start` clears `ELECTRON_RUN_AS_NODE`, which VS Code's integrated terminal sets
and which would otherwise make Electron start as plain Node.

## Building the macOS app

```sh
npm run build:backend   # freeze the Python backend with PyInstaller (~3 min)
npm run dist            # stage weights + licenses, build dist/OrthoViz-<version>-arm64.dmg
npm run dist:dir        # same, but only the unpacked dist/mac-arm64/OrthoViz.app (faster)
```

`npm run build:resources` (part of `dist`) stages into `build-resources/`:
- the five model folders used by full-resolution `total` (Datasets 291–295), from
  `~/.totalsegmentator/nnunet/results` or `TOTALSEG_WEIGHTS_SOURCE`. Not `config.json`,
  which holds the developer's own TotalSegmentator ID.
- `licenses/`: NOTICE with the TotalSegmentator attribution, its Apache-2.0 license, and the
  license text of every bundled Python package.

In the packaged app (`Contents/Resources/`): `backend/orthoviz-segment/`, `totalsegmentator-weights/`,
`licenses/`. On each scan, the app first copies any missing model folders into
`~/.totalsegmentator/nnunet/results` (atomically, via a temp folder), so TotalSegmentator never
downloads. The About dialog shows the attribution and opens the licenses folder.

The build is ad-hoc signed, not notarized (no Apple Developer ID). On another Mac, open it
the first time with right-click → Open.

## How it fits together

```
src/main/main.js         window, IPC handlers
src/main/backend.js      runs backend/.venv/bin/orthoviz-segment, parses progress from its output
src/main/mesh-worker.js  worker thread: segmentation.nii.gz -> one mesh per structure
src/main/meshing.js      surface extraction (Gaussian-smoothed surface nets + Taubin smoothing)
src/main/nifti.js        minimal NIfTI-1 reader
src/main/weights.js      first-use install of the bundled model weights
src/main/preload.js      the API exposed to the UI (window.orthoviz)
src/renderer/app.js      screen flow: Import -> Processing -> Viewer
src/renderer/viewer.js   Three.js viewer: picking, selection label, preset views
src/renderer/panel.js    structure list with toggles and quick filters
src/renderer/anatomy.js  plain-language names, groups and colours for TotalSegmentator labels
```

- Each run writes to `~/Library/Application Support/OrthoViz/results/<folder>-<timestamp>/`
  (override with `ORTHOVIZ_RESULTS_DIR`), including the backend's full `backend.log`.
- The backend path can be overridden with `ORTHOVIZ_BACKEND` (dev and packaged builds alike).
- Meshes are built from `segmentation.nii.gz` + `labels.json`; `ct.nii.gz` is not read yet.
- TotalSegmentator labels are 1.5 mm blocks, so each structure's mask is blurred (σ = 1 mm)
  before surface extraction to give smooth, non-terraced surfaces.

## Tests

```sh
npm test            # unit tests: progress parsing, meshing, NIfTI reading, anatomy names, CSP
npm run test:viewer # viewer interactions on ../output/patient1 (no backend run, ~15 s)
npm run test:packaged -- <path/to/OrthoViz.app>  # offline first-launch test of a build (~4 min)
npm run test:e2e    # real backend on dicom_samples/patient1 (~3 min); screenshots in tests/e2e/output/
```
