# OrthoViz

A macOS desktop app that turns a cervical-spine CT scan (a folder of DICOM files) into an
interactive 3D model, so patients can see and understand their own neck anatomy. Everything
runs locally on the Mac — no data leaves the computer.

**OrthoViz is a visualization and education tool, not a medical device, and does not make diagnoses.**

## What it does

1. **Import** a folder of CT DICOM files (button or drag-and-drop).
2. **Process** it on-device: the scan is segmented into anatomical structures with
   [TotalSegmentator](https://github.com/wasserth/TotalSegmentator) at full resolution, on
   the Mac's GPU. Progress, stages and a time estimate are shown; it takes a few minutes.
3. **Explore** the 3D model:
   - rotate, zoom, and Front / Side / Top views;
   - a side panel listing every structure (vertebrae, spinal cord, other bones, vessels,
     organs, muscles) with show/hide toggles and *Everything / Bones / Spine* filters;
   - click a vertebra to highlight it and name it in plain language (e.g. "C5 — 5th neck
     vertebra").
4. **Fracture check (C3–C7):** each vertebral body's front, middle and back height is
   measured and compared with the patient's other neck vertebrae; height loss of 25% or more
   is flagged in red (Genant grading: 25–40% moderate, over 40% severe). Selecting a flagged
   vertebra shows its current height against the healthy height (e.g. "75% lost").
   - Only detects loss of vertebral *body* height; breaks in the vertebral arch, or cracks
     that don't change the body's shape, are not detected.
   - C1 and C2 are not checked (their shape doesn't fit this method).
   - Can misread steeply slanted vertebrae.

## Project layout

```
app/       Electron + Three.js desktop app (UI, 3D viewer, packaging)
backend/   Python backend: DICOM loading, TotalSegmentator segmentation, fracture check
```

See [app/README.md](app/README.md) and [backend/README.md](backend/README.md) for details.

## Requirements

- A Mac with Apple Silicon (M1 or later), 16 GB memory recommended
- [Homebrew](https://brew.sh), then `brew install uv node`
- Internet once, to install dependencies and download TotalSegmentator's model weights
  (about 1.2 GB, into `~/.totalsegmentator` on first run)

## Setup

```sh
# Backend (Python 3.12 is fetched by uv)
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv -e ".[dev,build]"

# App
cd ../app
npm install
```

## Run

```sh
# Process a scan from the command line
cd backend
.venv/bin/orthoviz-segment <folder of DICOM files> <output folder>

# Start the app
cd app
npm start
npm start -- --result=<output folder>   # open an existing result straight in the viewer
```

## Test

```sh
cd backend && .venv/bin/python -m pytest tests                  # backend
cd app && npm test                                              # app unit tests
cd app && npm run test:viewer -- <output folder>                # viewer interactions
cd app && npm run test:e2e                                      # full app + backend run
```

The end-to-end tests expect sample scans in `dicom_samples/` (see below).

## Build the installable app

```sh
cd app
npm run build:backend    # freeze the Python backend with PyInstaller
npm run dist             # build dist/OrthoViz-<version>-arm64.dmg
npm run test:packaged -- dist/mac-arm64/OrthoViz.app            # offline first-launch test
```

The `.dmg` bundles the backend, the TotalSegmentator model weights and third-party licenses,
and runs fully offline. It is ad-hoc signed (not notarized): on another Mac, open it the
first time with right-click → Open.

## Sample data

Scans are not included in this repository. Development and testing used CT scans from the
[RSNA 2022 Cervical Spine Fracture Detection](https://www.kaggle.com/competitions/rsna-2022-cervical-spine-fracture-detection)
dataset (Kaggle account and acceptance of the competition rules required), placed in
`dicom_samples/<case>/`. `backend/tools/fetch_rsna_study.py` downloads a single study.

## Credits

- **TotalSegmentator** (Apache License 2.0) performs the anatomical segmentation:
  Wasserthal J. et al., "TotalSegmentator: Robust Segmentation of 104 Anatomic Structures in
  CT Images", *Radiology: Artificial Intelligence*, 2023,
  [doi:10.1148/ryai.230024](https://doi.org/10.1148/ryai.230024). Built on nnU-Net (Apache License 2.0).
- The fracture check follows the approach of Inigo B. et al., "An Intrinsically Explainable
  Approach to Detecting Vertebral Compression Fractures in CT Scans via Neurosymbolic
  Modeling", [arXiv:2412.17258](https://arxiv.org/abs/2412.17258), 2024.
- 3D rendering with [three.js](https://threejs.org) (MIT); desktop shell with
  [Electron](https://www.electronjs.org) (MIT).
- Full third-party licenses are bundled in the app (`Contents/Resources/licenses/`).
