# OrthoViz — Python backend

Loads a folder of CT DICOM files, stacks it into a 3D volume, and runs
TotalSegmentator on it at full resolution (`fast=False`; the 3 mm fast mode looks too blocky).

## Setup

Requires [uv](https://docs.astral.sh/uv/). TotalSegmentator/PyTorch need Python 3.10–3.12.

```sh
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv -e ".[dev]"
```

Model weights are read from `~/.totalsegmentator`. If the `total`
task weights (Datasets 291–295) are missing, TotalSegmentator downloads them on first run.

## Device

`--device auto` (default) uses Apple's GPU backend (MPS) when available. Avoid `cpu`
on Apple Silicon: PyTorch's macOS CPU build does 3D convolutions in a way that needed
~17 GB of memory and swapped heavily on a 16 GB M1 Mac, whereas MPS segmented the
`patient_fracture1` sample in ~8 minutes with a 7.5 GB peak.

## Usage

```sh
.venv/bin/orthoviz-segment ../dicom_samples/patient1 ../output/patient1
# or: .venv/bin/python -m orthoviz_backend <dicom_folder> <output_dir> [--device auto|mps|gpu|cpu]
```

Output folder:

| File | Contents |
|---|---|
| `ct.nii.gz` | Stacked input volume (Hounsfield units, RAS+) |
| `segmentation.nii.gz` | Multi-label segmentation, same voxel grid as `ct.nii.gz` |
| `labels.json` | `{label value: structure name}` for every structure found |
| `fractures.json` | Phase 2 fracture check: C3–C7 vertebral body height loss (Genant grades); C1/C2 listed as not assessed. Flagged vertebrae include a `marker` (measured vs healthy height and where it was measured) for the viewer's height comparison |
| `run_info.json` | Source study/series UIDs, volume geometry, loader warnings, timings |

TotalSegmentator's usage-statistics upload is disabled inside this process so
no network calls are made at runtime.

## Fracture check (Phase 2)

`orthoviz_backend/fracture.py` screens C3–C7 for loss of vertebral body height after
segmentation (rule-based, after Inigo et al. 2024, https://arxiv.org/abs/2412.17258; Genant thresholds: flag at 25%, severe
at 40%). C1 and C2 are excluded. It only detects body height loss, not fractures of the arch.

```sh
.venv/bin/python -m orthoviz_backend.fracture ../output/patient1          # re-run on an existing result
.venv/bin/python tools/plot_fracture_measurements.py ../output/patient1 check.png   # see what was measured
```

`tools/fetch_rsna_study.py` downloads one RSNA 2022 study from Kaggle (instructions inside).

## Freezing for the app

The packaged app ships a PyInstaller build of `orthoviz-segment` (no Python needed on the user's Mac):

```sh
uv pip install --python .venv -e ".[build]"
cd ../app && npm run build:backend     # -> backend/build/dist/orthoviz-segment/ (~1.4 GB)
```

See `packaging/orthoviz-segment.spec` for what is collected and why (nnU-Net's dynamic
trainer lookup, GDCM's native library for compressed DICOM, torchvision's native ops).

## Tests

```sh
.venv/bin/python -m pytest tests
```
