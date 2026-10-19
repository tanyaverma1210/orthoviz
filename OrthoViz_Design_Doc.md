# OrthoViz — Design Document

**Status:** Living document — expect to revise as decisions get made during development.
**Audience:** Claude Code (implementation), Tanya & Neeraj (project owners)
**Last updated:** 2026-10-16 (UI design added, Electron+Three.js and macOS-first confirmed)

---

## 1. What This Project Is

OrthoViz is a desktop application that takes a patient's CT scan (as DICOM files) and shows it as a clean, understandable 3D model — starting with the cervical spine. The motivating problem: patients often struggle to understand their own spine anatomy or injury when a doctor shows them a flat 2D scan. OrthoViz turns that scan into something a non-expert can actually look at and understand.

Built as a Congressional App Challenge submission (Georgia's 7th District).

## 2. Scope

### Phase 1 (building now)
- Installable desktop app (macOS `.app` first; Windows `.exe` later if time allows)
- Input: a folder of DICOM files (one patient's CT scan — a stack of slices)
- Internally runs automatic anatomical segmentation (identifies vertebrae and surrounding structures)
- Displays the result as a rotatable 3D model in the app's own UI
- Runs fully offline, locally, on one machine — no data leaves the device

### Phase 2 (deferred — not blocking Phase 1)
- Fracture detection: given the segmented vertebrae, flag which ones (if any) appear fractured
- Will be designed as a pluggable step that consumes Phase 1's segmentation output — Phase 1's pipeline should not need to be rearchitected to add this later

### Explicitly out of scope for this project
- Live clinical deployment / real patient use (would require FDA clearance as medical device software)
- PACS network integration (pulling scans automatically from a hospital's imaging system)
- Cloud processing or multi-user/multi-clinic deployment
- Any actual diagnostic claim — this is a visualization/comprehension tool, not a diagnostic device

## 3. Architecture

**Recommended approach:** a local web-tech UI (Three.js for the 3D rendering) packaged as an installable desktop app via Electron, talking to a local Python backend that does the actual image processing.

```
┌─────────────────────────────┐
│   Electron app (installable) │
│  ┌─────────────────────────┐ │
│  │  Three.js UI             │ │   <- renders the 3D model, handles
│  │  (upload scan, view,     │ │      user interaction
│  │   rotate, controls)      │ │
│  └───────────┬─────────────┘ │
│              │ local API call │
│  ┌───────────▼─────────────┐ │
│  │  Python backend          │ │   <- runs as a local subprocess /
│  │  (bundled, not visible   │ │      local server (e.g. FastAPI)
│  │   to the user)           │ │
│  │                           │ │
│  │  - DICOM loading (pydicom)│ │
│  │  - Segmentation           │ │
│  │    (TotalSegmentator)     │ │
│  │  - [Phase 2: fracture     │ │
│  │     detection]            │ │
│  └───────────────────────────┘ │
└─────────────────────────────┘
```

**✅ Decided:** Electron + Three.js. This reconciles two earlier framings (a "web app using Three.js" vs. an "installable .exe/.app") into one architecture. Three.js renders the 3D model; Electron packages the whole thing as an installable desktop app.

**Platform target: macOS first.** Electron makes the UI shell cross-platform almost for free, but the Python/TotalSegmentator backend bundling is real, separate work per OS, and a Windows build can't be properly tested without an actual Windows machine. Given the competition deadline, build and fully finish the Mac version first; treat Windows packaging as a stretch goal afterward, not parallel work.

### Why TotalSegmentator is bundled, not rebuilt
Writing a custom vertebra-segmentation model from scratch would take far longer than this project's timeline allows and would duplicate work TotalSegmentator already does well. TotalSegmentator is Apache 2.0 licensed — bundling it inside the app is permitted, provided its license/attribution notice ships with the app.

## 4. Data Pipeline

1. User provides a folder of DICOM files (one scan = many slice files, occasionally one multi-frame file)
2. App loads and validates the files (pydicom), stacks them into one 3D volume
3. Volume is passed to TotalSegmentator (**use normal/full resolution, not "fast" mode** — fast mode's 3mm downsampling produces visibly blocky results unsuitable for patient-facing display; see §5 for timing tradeoffs)
4. Segmentation result is rendered as a 3D model in the Three.js viewer
5. *(Phase 2)* Segmented vertebrae get passed to a fracture-classification step; results shown alongside the 3D view

### Development/test data
- Source: [RSNA 2022 Cervical Spine Fracture Detection](https://www.kaggle.com/competitions/rsna-2022-cervical-spine-fracture-detection) (Kaggle)
- `train.csv` has ground-truth fracture labels per patient (overall + per-vertebra C1–C7)
- `segmentations/*.nii` has pre-made ground-truth vertebra segmentations for some patients — useful for validating segmentation accuracy without needing an expert reviewer
- Already downloaded locally for testing: one non-fracture patient, one C1/C2-fracture patient (see `Tanya_Capstone/dicom_samples/`)

## 5. Performance Notes (measured, CPU-only, no GPU)

| Mode | Scope tested | Time |
|---|---|---|
| Fast mode | Neck-only volume | ~90 seconds |
| Normal/full mode | Neck-only volume | ~4.5 minutes |
| Normal/full mode | Volume extending into upper chest | ~13 minutes |

Takeaway: full resolution is the right default for anything shown to a person, but runtime scales with how much anatomy is in the scan — worth considering whether to crop input volumes to the cervical region before segmentation to keep runtime predictable, rather than processing whatever extent the input scan happens to cover.

## 6. Deployment Model

Standalone installable desktop app (Option 1 from earlier deployment discussion) — chosen over a local-server or cloud model because: no infrastructure needed, patient data never leaves the device, and it's the simplest path to something demo-able within the project timeline. Revisit if/when this moves beyond a capstone project.

## 7. Validation Plan

- Compare segmentation output against the dataset's pre-made ground-truth masks where available
- Once Phase 2 exists, compare fracture predictions against `train.csv` labels
- Clinic contacts are for informal feedback on de-identified output (does this look clinically sensible?) — not for installing/running the app on live clinic systems or real patient data

## 8. TotalSegmentator Dependency & Offline Setup

**How it's called in code** — via its Python API, not the CLI:
```python
from totalsegmentator.python_api import totalsegmentator
totalsegmentator(input_path, output_path, fast=False)
```

**Decision: bundle model weights, don't rely on internet at runtime.** TotalSegmentator normally downloads its pretrained model weights on first use. Depending on that at app-launch time is a real risk, not just a theoretical one — it conflicts with the "patient data never leaves the device" / fully-offline positioning in §6, real clinics often restrict outbound internet, and a live download is a demo-reliability risk right before the Congressional App Challenge deadline.

**Mechanism:** weights are cached in `~/.totalsegmentator` after first successful run. Since the app has already been run successfully during development (via 3D Slicer, this session), that folder likely already exists and already has the needed weights — confirm with `ls -la ~/.totalsegmentator`.

**Plan:**
1. Keep developing normally — let TotalSegmentator auto-download as it already has.
2. When building the installer, bundle the contents of `~/.totalsegmentator` and have the installer copy them into the same location on the user's machine during install.
3. Verify the packaged app runs a full segmentation with networking disabled, as a real test that no runtime download is happening.

## 9. UI Design (Phase 1)

Three screens — kept deliberately minimal for the project timeline, with the 3D viewer as the real focus:

1. **Import screen** — opening screen. Button or drag-and-drop to select a folder of DICOM files.
2. **Processing screen** — shown while TotalSegmentator runs (measured 1.5–13 min, see §5). Needs a visible progress indicator and a reassuring estimate, not a frozen-looking blank screen.
3. **3D viewer screen** — the core deliverable:
   - Large 3D viewport (Three.js canvas): drag to rotate, scroll to zoom
   - Side panel listing each visible structure (vertebrae, spinal cord, vessels, muscles) with a color swatch and a show/hide toggle, so the view can be simplified down to just the bones
   - Click a vertebra → it highlights and shows its name in plain language (e.g. "C3") — this is the core patient-comprehension feature
   - Preset view buttons (front/side/top) for someone unfamiliar with 3D navigation
   - Layout should leave room for a Phase 2 results panel (fracture flags per vertebra) to slot in later without a redesign

## 10. Open Questions / Decisions Needed

- [ ] Decide whether to crop scan volume before segmentation to bound processing time
- [ ] Repo/project structure for the Electron + Python backend split
- [ ] Confirm exact installer mechanism for placing the bundled `.totalsegmentator` weights folder on macOS
