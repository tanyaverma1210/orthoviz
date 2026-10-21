# OrthoViz — As-Built Document

**What this is:** a plain-language record of what was actually built, how the pieces work together, and why things ended up the way they did. It complements the original [OrthoViz_Design_Doc.md](OrthoViz_Design_Doc.md), which is kept unchanged as the record of the original plan and decisions.

**Written:** 2026-10-20; updated 2026-10-21 for the first version of fracture detection (Phase 2), its real demo case, and the reference paper's citation.

**Fracture detection (Phase 2) is only partly there.** OrthoViz shows the spine as a 3D model and names each vertebra (Phase 1, complete). A first version of fracture detection now checks **C3–C7** for **loss of vertebral body height** and colours a flagged vertebra red. Its limits matter:
- it can only see fractures that make the vertebral body shorter (compression-type); breaks in the bony arch behind the spinal canal, or cracks that don't change the body's shape, are invisible to it;
- **C1 and C2 are not checked** — their shape doesn't fit the method (future work);
- on real scans it **caught all three body fractures tested** at the right level, including a clean demo case (`patient_fracture4`, a severe C7 fracture flagged on its own); but it also wrongly flagged two healthy vertebrae in one patient, where the vertebrae sit at a steep slant that its leveling step can't handle yet (future work). See §2 step 5, §6 and §7.

**How to read it:** sections 1–3 explain how the app works, in order. Section 4 explains how it becomes an installable app. Sections 5–7 cover decisions, testing and status. Section 8 is the hands-on "how to rebuild everything" guide. A glossary of technical terms is at the end; terms in *italics* the first time are defined there.

---

## Contents

1. [The big picture](#1-the-big-picture)
2. [Following one scan through the app](#2-following-one-scan-through-the-app)
3. [Speed and hardware](#3-speed-and-hardware)
4. [Packaging: how the installable app is made](#4-packaging-how-the-installable-app-is-made)
5. [Decisions made, and why](#5-decisions-made-and-why)
6. [How it was tested](#6-how-it-was-tested)
7. [Current status](#7-current-status)
8. [How to build, run, test and package from scratch](#8-how-to-build-run-test-and-package-from-scratch)
9. [Glossary](#9-glossary)

---

## 1. The big picture

OrthoViz is a Mac app. You give it a folder of CT scan files; a few minutes later it shows a 3D model of the neck and upper spine that you can rotate, simplify and click on to name each vertebra. Everything happens on the one computer — nothing is uploaded.

### The three parts

The app is three programs working together:

```
┌──────────────────────────── OrthoViz.app ─────────────────────────────┐
│                                                                        │
│  ① The window (what you see)                                           │
│     Import screen → Processing screen → 3D viewer                      │
│     Built with web technology (HTML, CSS, JavaScript, Three.js)        │
│            │  ▲                                                        │
│            │  │  a small, fixed set of requests ("choose a folder",    │
│            ▼  │  "start processing", "build the 3D model") and updates │
│                                                                        │
│  ② The coordinator (Electron's "main process")                         │
│     Opens the window, starts the backend, watches its progress,        │
│     turns the results into 3D shapes                                   │
│            │  ▲                                                        │
│  starts it │  │  reads its progress messages; picks up result files    │
│            ▼  │                                                        │
│                                                                        │
│  ③ The backend (a separate Python program: orthoviz-segment)           │
│     DICOM files → TotalSegmentator → C3–C7 fracture check → result files│
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

**① The window** is a web page that runs inside the app. It has no direct access to the computer's files; it can only ask the coordinator to do things through a short, fixed list of requests. That's a standard security practice — even if something went wrong in the page, it couldn't touch files on its own.

**② The coordinator** is the part of *Electron* that runs behind the window. It has full access to the computer. It starts the backend when you pick a scan, reads the backend's progress messages to drive the progress bar, and, when the backend is done, converts the result into 3D shapes for the window to display.

**③ The backend** is a separate Python program called `orthoviz-segment`. It knows nothing about windows or buttons: you give it a scan folder and an output folder, it does the heavy lifting (reading the scan, running the AI segmentation, checking C3–C7 for fractures) and writes its results as files. Because it's a standalone program, it can be run and tested on its own from the command line, too.

### How they talk to each other

- **Window ↔ coordinator:** through a small "bridge" file (`preload.js`) that lists exactly which requests the window may make. Progress updates flow the other way through the same bridge.
- **Coordinator → backend:** the coordinator *launches* the backend as a separate program, with two inputs: the scan folder and an output folder. It reads everything the backend prints (its log) as it happens and recognises progress messages in it. To cancel, it stops the backend and all of its helper processes.
- **Backend → coordinator:** through **files**. The backend writes its results into the output folder; once it exits successfully, the coordinator reads those files.

### What changed from the original design

| Original design (design doc §3) | As built | Why |
|---|---|---|
| Backend as "a local subprocess / local server (e.g. FastAPI)" | A plain subprocess, no server | Simpler: one scan at a time doesn't need a server. Progress comes from the backend's printed log, results come as files. A server can still be added later if needed. |
| 3D model built… (not specified) | 3D shapes built in the coordinator (JavaScript), not the backend | Keeps the backend's output simple (standard medical-imaging files) and lets the shape-building be tuned without rerunning the AI. Takes under a second. |
| DICOM loading with pydicom | Still pydicom, now with **GDCM** to decode compressed images | GDCM replaced a GPL-licensed decoder (see §5). |
| TotalSegmentator on CPU (timings in design doc §5) | Runs on the Mac's **GPU (MPS)** | On this Mac the CPU route needed ~17 GB of memory and stalled; the GPU route is fast and fits (see §3). |
| "Bundle `~/.totalsegmentator`" | Bundle **only the 5 models actually used**, never the personal settings file | Saves ~640 MB; the settings file contained a personal ID (see §4). |

---

## 2. Following one scan through the app

This section follows a scan from the moment you pick a folder to the moment you click on a vertebra. Each step names the files involved and what they do.

### Step 0 — Picking the scan (Import screen)

- **`app/src/renderer/index.html`** — the page itself: all three screens (Import, Processing, Viewer) plus the About dialog. Only one screen is visible at a time.
- **`app/src/renderer/app.js`** — the screen flow: what happens when you click "Choose folder…" or drop a folder, which screen to show, and how progress is displayed.
- **`app/src/main/preload.js`** — the bridge: the fixed list of requests the page can make (choose a folder, start processing, cancel, build the model, open licenses…).
- **`app/src/main/main.js`** — the coordinator. Shows the macOS folder picker, does a quick sanity check on dropped folders ("is this a folder? is it empty?"), creates a results folder, and starts the processing.

Each scan gets its own results folder: `~/Library/Application Support/OrthoViz/results/<scan folder name>-<date and time>/`.

### Step 1 — Getting ready (first use only)

- **`app/src/main/weights.js`** — makes sure TotalSegmentator's AI models ("weights") are on this computer before the backend starts.

TotalSegmentator looks for its models in a hidden folder in your home directory (`~/.totalsegmentator`). If they're not there, it would try to download them from the internet — exactly what we don't want (design doc §8). So before every scan, `weights.js` checks that folder against the copy bundled inside the app, and copies over any model that's missing. On a brand-new Mac this shows as **"Getting ready for first use — installing AI models (1 of 5)"** on the Processing screen; after that it's an instant no-op.

Two safety details:
- Each model is copied to a temporary name first and only renamed into place once complete. TotalSegmentator only checks whether a model *folder exists*, so a half-copied folder (say, if the app were quit mid-copy) would otherwise look valid and break segmentation.
- If a model folder already exists and has every file, it is left alone — so a user's own copy is never overwritten.

### Step 2 — Starting the backend and tracking progress

- **`app/src/main/backend.js`** — launches the backend program and turns its log into progress.

It decides *which* backend to run: the one bundled inside the app (in the installed app), the development copy in `backend/.venv` (when developing), or whatever the `ORTHOVIZ_BACKEND` setting points to (an override for testing).

While the backend runs, `backend.js` reads each line it prints and recognises milestones: "Loading DICOM files", "Loaded 429 slices", "Running TotalSegmentator", and TotalSegmentator's own progress bars — one per AI model, five in total. From these it calculates the percentage, the stage text ("Identifying bones and tissues — step 2 of 5") and, once the first model is done, a countdown estimate. It also saves the full log as `backend.log` in the results folder, and, if the backend fails, turns the error into a plain-language message (e.g. "This folder doesn't look like a CT scan OrthoViz can read").

One detail that mattered: Python normally holds printed text in a buffer and releases it in batches, which made progress appear only at the end. The backend is launched with buffering switched off so progress arrives live.

### Step 3 — Reading the scan (backend)

The backend is a small Python package in `backend/orthoviz_backend/`:

- **`cli.py`** — the front door: reads the two inputs (scan folder, output folder), runs the pipeline, reports errors.
- **`pipeline.py`** — the recipe: load → save the CT volume → segment → check for fractures → write the result files. Kept separate from the front door so a future server could reuse it.
- **`dicom_loader.py`** — turns a folder of DICOM files into one 3D volume.

A CT scan arrives as hundreds of separate image files, one per slice (patient1 has 429). `dicom_loader.py`:

1. reads every file in the folder, skipping anything that isn't a DICOM image (e.g. macOS's hidden `.DS_Store` files);
2. if the folder mixes several scans ("series"), uses the biggest one and notes a warning;
3. **sorts the slices by their actual position in the body**, not by file name or slice number (which can't be trusted);
4. checks the slices fit together: same orientation, same size, no duplicates, roughly even spacing (uneven spacing is allowed but recorded as a warning);
5. decodes each slice's pixels — the sample scans are compressed ("JPEG Lossless"), which **GDCM** decodes;
6. converts pixel values to *Hounsfield units* (the standard CT brightness scale, where bone is high and air is −1000);
7. works out exactly where the volume sits in the patient's body (left/right, front/back, head/foot) and records that with the volume.

It also handles the rarer case of a whole scan stored in one "multi-frame" file. (That path has no sample to test against, so it's untested.)

The result is saved as **`ct.nii.gz`** — the whole scan as a single 3D file in *NIfTI* format, which is what TotalSegmentator takes as input.

We wrote our own loader rather than letting TotalSegmentator read the DICOM folder itself, because TotalSegmentator's built-in reader crashed on the sample scans (they lack a "Modality" label that it requires).

### Step 4 — Segmentation (backend)

- **`segmentation.py`** — runs TotalSegmentator on `ct.nii.gz`.

*Segmentation* means labelling every voxel (3D pixel) of the scan with what it belongs to: "C3 vertebra", "spinal cord", "left carotid artery", and so on. TotalSegmentator does this with five AI models in a row (organs, vertebrae, heart/vessels, muscles, ribs) at full 1.5 mm resolution — not the blocky 3 mm "fast" mode (design doc §4).

Three settings matter:
- **Full resolution** (`fast=False`), as required by the design doc.
- **Runs on the Mac's GPU** ("MPS") when available — see §3 for why.
- **Usage statistics switched off.** TotalSegmentator normally sends a short anonymous report (task, version, platform — no images) to its developers' server after each run. The backend switches this off inside its own process, so no network call is made. Your global TotalSegmentator settings file is left untouched.

The backend writes:

| File | What it is |
|---|---|
| `ct.nii.gz` | The scan as one 3D volume (from step 3) |
| `segmentation.nii.gz` | Same 3D grid as the scan, but each voxel holds a structure number (0 = nothing) |
| `labels.json` | Which number means which structure, for the structures actually found (e.g. 41 for patient1) |
| `fractures.json` | The fracture check's result for C1–C7 (step 5) |
| `run_info.json` | Bookkeeping: which scan, its size and spacing, warnings, timings, settings |
| `backend.log` | The full log (written by the coordinator) |

### Step 5 — Checking for fractures, C3–C7 (backend)

- **`fracture.py`** — measures each vertebral body's height and applies simple rules. No AI training involved.

The approach follows this reference paper:

> Inigo B., Shen Y., Killeen B. D., Song M., Krieger A., Bradley C., Unberath M., "An Intrinsically Explainable Approach to Detecting Vertebral Compression Fractures in CT Scans via Neurosymbolic Modeling", arXiv:2412.17258, 2024 — https://arxiv.org/abs/2412.17258

(The PDF isn't stored in the repository, because its license doesn't permit redistribution; download it from the arXiv link. A local copy can be kept in `docs/papers/`, which git ignores.)

That is: use TotalSegmentator's segmentation, measure vertebral body heights, apply threshold rules. Because the paper's own numbers were tuned on a different dataset (lower-back vertebrae, osteoporosis), OrthoViz uses the standard **Genant** height-loss grades instead.

For each of C3, C4, C5, C6 and C7:

1. **Skip it if it's incomplete.** A vertebra cut off by the edge of the scan is marked "not checked".
2. **Turn it upright.** The neck is curved, so each vertebra is looked at in its own frame: "up" along the spine, then fine-tuned so its top and bottom surfaces (the endplates) are level.
3. **Separate the body from the arch.** Looking at a thin slice down the middle, a vertebra is: the body at the front, a gap (the spinal canal), then the arch behind. Only the body is measured.
4. **Measure three heights:** at the front, middle and back of the body. Small lips and bone spurs at the rim are ignored.
5. **Compare.** Three kinds of collapse are checked: the front lower than the back (*wedge*), the middle lower than the back (*biconcave*), or the whole body lower than its neighbours (*crush*). Each is compared with the same measure in the patient's **other** C3–C7 vertebrae — the way a radiologist compares with the levels next to it. This matters in the neck: healthy neck vertebrae are naturally a little "waisted", which raw Genant numbers would mistake for 20–25% height loss.
6. **Grade.** The largest height loss decides: **25% or more → flagged as a possible fracture** ("moderate", Genant grade 2); **40% or more → "severe"** (grade 3); 20–25% → recorded as "borderline" (grade 1) but not flagged.

C1 and C2 are listed as "not checked automatically": C1 is a ring with no body, and C2 has a peg (the dens) fused to its body, so "height loss" doesn't apply to them.

If the check itself fails for some reason, the scan still completes and the 3D model is still shown; the problem is recorded in `fractures.json`. It takes 1–2 seconds.

**Known weakness — slanted vertebrae.** Step 2 levels each vertebra by fitting lines to its top and bottom surfaces. When vertebrae start out at a steep slant in this frame (a strongly bent or turned neck), the leveling doesn't fully work: the body is measured as a tilted, parallelogram-like shape, and its heights come out wrong in either direction. This caused two false alarms in one test patient and an unreliable reading in another (§6). Fixing it means rethinking how each vertebra is oriented in 3D — left as future work.

### Step 6 — Building the 3D model (coordinator)

The window can't display "a grid of numbered voxels" directly; it needs surfaces made of triangles (a *mesh*), one per structure. This happens in the coordinator, in a background thread so the window never freezes:

- **`app/src/main/mesh-worker.js`** — the background job: reads the result files, builds the meshes, and passes along the fracture check result.
- **`app/src/main/nifti.js`** — a small reader for NIfTI files (the format of `segmentation.nii.gz`). Checked against the standard Python reader: identical.
- **`app/src/main/meshing.js`** — turns each structure's voxels into a smooth surface.

How `meshing.js` works, in four steps:

1. **Thin out the grid** to about 0.75 mm. TotalSegmentator works at 1.5 mm internally, so the full-resolution grid adds triangles but no real detail.
2. **Soften each structure's outline** with a slight blur (about 1 mm). This is the important step: TotalSegmentator's labels are built from 1.5 mm blocks, and without this the bones show visible terraces — the same "blocky" look the design doc warns against for fast mode.
3. **Trace the surface** where the softened outline crosses the halfway point, using a standard method called *surface nets*.
4. **Polish** with a gentle smoothing pass that removes remaining roughness without shrinking the shape.

Tiny scraps (fewer than a handful of voxels — e.g. a sliver of heart at the very edge of the scan) are skipped. For patient1 this produces 39 structures, about 820,000 triangles, in under a second.

### Step 7 — The 3D viewer (window)

- **`app/src/renderer/viewer.js`** — the 3D view, using the *Three.js* library: lighting, rotate/zoom, clicking on structures, the floating name label, and the preset views.
- **`app/src/renderer/panel.js`** — the side panel listing every structure, with show/hide checkboxes and quick filters.
- **`app/src/renderer/anatomy.js`** — the "translator": turns TotalSegmentator's internal names into plain language, groups and colours. For example `clavicula_left` → "Left collarbone"; `vertebrae_C3` → "C3 — 3rd neck vertebra (cervical)"; `vertebrae_C1` → "… the atlas". It also words the fracture check's results ("Possible fracture · 31% loss of height at the front — moderate").
- **`app/src/renderer/styles.css`** — the look of all screens.

What the viewer does:

- **Colours and see-through tissue.** Bones are a uniform ivory, the spinal cord yellow, arteries red, veins blue. Organs, vessels and muscles are partly transparent so the spine is always visible.
- **Side panel.** Structures grouped as Spine (listed top to bottom, C1 first), Spinal cord, Other bones, Blood vessels, Organs, Muscles. Each has a colour swatch and a checkbox; each group has a checkbox too. Quick filters: **Everything**, **Bones** (hides soft tissue — design doc §9's "simplify down to just the bones"), **Spine** (vertebrae and spinal cord). Filters zoom the camera to fit what's left.
- **Click to name.** Clicking a vertebra highlights it in blue and shows a label like **C5 — 5th neck vertebra (cervical)**. Clicks pass through see-through tissue to the bone behind. Dragging to rotate never changes the selection. Clicking a name in the panel does the same. Escape or clicking empty space clears it.
- **"(behind)" labels.** If the selected structure can't be seen from the current angle (e.g. C4 seen from above is hidden under the skull), the label turns dashed and says "(behind)", so it never seems to point at the wrong bone.
- **Preset views.** **Front**, **Side** (from the patient's left, face pointing left — like a standard side X-ray) and **Top**, each a smooth camera move framing whatever is visible.
- **Fracture check.** The top of the side panel lists C1–C7 with their result: "Possible fracture" (red), "Borderline" (amber), "No loss of height found", or "Not checked" with the reason. A summary line says which vertebrae (if any) are flagged, and always adds that C1 and C2 aren't checked, so a clean result never reads as "all clear". A note says it is a screening aid, not a diagnosis, and only detects loss of body height. A flagged vertebra is coloured **red** in the 3D view (the only use of red on bone — bones are otherwise one colour), and its name label adds the finding. Results made before fracture checking existed say "not available".
- **About dialog.** Explains what OrthoViz is (and that it is not a diagnostic device), credits TotalSegmentator with its citation, and opens the full license files.

---

## 3. Speed and hardware

All timings are on the development Mac (Apple M1, 16 GB memory).

| What | Time |
|---|---|
| Full app run, patient1 (429 slices, neck only), pick folder → 3D model | ~3 min |
| Segmentation only, patient1 | ~2.5–3 min |
| Segmentation only, patient_fracture1 (243 slices, but extends into the chest) | ~8.5 min |
| Fracture check (C3–C7) | 1–2 s |
| Building the 3D model from the result | < 1 s |
| First-use install of the AI models | a few seconds |
| Very first scan on a new Mac | ~30 s extra (a one-time font-cache setup inside a TotalSegmentator dependency) |

As the design doc predicted (§5), time depends on **how much of the body** the scan covers, not on the number of slices: the fracture sample has fewer slices than patient1 but takes three times as long.

**Why the GPU, not the CPU.** The first segmentation attempt ran on the CPU and used about 17 GB of memory on this 16 GB Mac, so the computer slowed to a crawl (20+ minutes, mostly waiting on memory). The cause is a quirk of the PyTorch version for Macs: it handles 3D image filters on Apple Silicon CPUs in a very memory-hungry way. On the Mac's GPU ("MPS") the same scan takes minutes with a peak around 7.5–8 GB. The backend now picks the GPU automatically (setting `--device auto`). This is why the design doc's CPU timings don't apply to this setup.

---

## 4. Packaging: how the installable app is made

### What you get

`app/dist/OrthoViz-0.1.0-arm64.dmg` (about 1.7 GB) — a standard Mac disk image containing `OrthoViz.app` (about 2.9 GB once installed). It runs on Apple Silicon Macs, with no Python, Node or internet needed.

### What's inside OrthoViz.app

| Part | Size | What it is | Why it's there |
|---|---|---|---|
| The app itself (Electron + our code + Three.js) | ~0.3 GB | The window, coordinator and 3D viewer | — |
| `Resources/backend/orthoviz-segment/` | ~1.4 GB | The backend, "frozen" into a self-contained program by *PyInstaller* — includes its own Python, PyTorch, TotalSegmentator, GDCM, etc. | So the user's Mac doesn't need Python or any setup |
| `Resources/totalsegmentator-weights/` | ~1.2 GB | The five AI models used for full-resolution segmentation (Datasets 291–295) | So nothing is downloaded at runtime (design doc §8) |
| `Resources/licenses/` | ~2 MB | NOTICE (with the TotalSegmentator attribution and citation), TotalSegmentator's Apache-2.0 license, license texts of all 117 bundled Python packages, Three.js license | Licence requirement (design doc §3) |

**What was deliberately left out of the weights:** three other models that happened to be in `~/.totalsegmentator` but that OrthoViz never uses (fast mode and two other tasks — ~640 MB), macOS clutter files, and `config.json`. That settings file holds the developer's personal TotalSegmentator ID; shipping it would have given every installed copy that same ID. TotalSegmentator creates a fresh one on each user's Mac.

### How it's built (three stages)

1. **Freeze the backend** (`npm run build:backend`). PyInstaller packs the Python backend and everything it needs into `backend/build/dist/orthoviz-segment/`. The recipe is `backend/packaging/orthoviz-segment.spec`; the program's starting point is `backend/packaging/entry.py`. It's built as a folder rather than a single file, because a single file would unpack ~1 GB to a temporary location on every run.
2. **Stage the extras** (`npm run build:resources`, run automatically by step 3). `app/scripts/prepare-resources.mjs` copies the five models into `app/build-resources/` (using an instant macOS "clone" copy, so no extra disk space), and runs `backend/packaging/collect_licenses.py` to gather the licence texts.
3. **Build the app and disk image** (`npm run dist`). *electron-builder* assembles `OrthoViz.app`, places the frozen backend, models and licences inside it, signs it (ad-hoc, see §5), and creates the `.dmg`. Its settings live in the `"build"` section of `app/package.json`.

### Problems found while packaging, and their fixes

Each of these was found by actually running the packaged result, not by inspection:

1. **Missing torchvision piece.** TotalSegmentator's underlying framework (nnU-Net) looks for its model "trainer" by loading every trainer it ships; one of those loads `timm`, which loads `torchvision`. The frozen build crashed because torchvision's compiled component wasn't included — this torchvision version named the file differently from what PyInstaller expected. **Fix:** the recipe now includes torchvision in full.
2. **Decoder found via package "metadata".** The original JPEG decoder (pylibjpeg) located its plugin through package metadata that freezing normally discards; without it, compressed scans would fail to load. **Fix at the time:** copy that metadata explicitly. **Since then** the decoder was replaced by GDCM (see §5); its native libraries are picked up automatically, and its data files are now added explicitly.
3. **Helper processes in a frozen program.** nnU-Net starts helper processes to speed things up. In a frozen program, each helper re-launches the program itself, which would start a whole new segmentation instead of helping. **Fix:** `entry.py` calls Python's `freeze_support()`, which routes helpers to their job.
4. **Viewer blank in the first packaged build.** electron-builder, by default, strips every folder named `examples/` from bundled libraries. Three.js keeps its rotate/zoom controls in `three/examples/jsm/`, so the viewer's code failed to load — which also stopped the buttons on the Import screen from working. **Fix:** that file is now copied in explicitly.
5. **"Damaged app" signature.** Electron ships with a signature; adding our files broke it, which on another Mac would show the misleading message "OrthoViz is damaged and can't be opened." **Fix:** the app is ad-hoc signed during the build, so its signature is valid.
6. **Fragile build path.** The PyInstaller recipe found our backend code through a folder path that only worked because of how the package happened to be installed in the development environment. **Fix:** paths are now anchored to the recipe file's own location.

Two development-only gotchas also came up: VS Code's built-in terminal sets a variable (`ELECTRON_RUN_AS_NODE`) that makes Electron start as plain Node and crash — `npm start` and the test scripts clear it; and Python's output buffering (see step 2 above).

### What happens on a user's Mac

1. They open the `.dmg` and drag OrthoViz to Applications.
2. First launch: right-click → **Open** (needed because the app isn't notarized by Apple — see §5).
3. First scan: the app installs the five models into `~/.totalsegmentator` (a few seconds), then proceeds normally. Later scans skip this.

---

## 5. Decisions made, and why

**Replace the GPL-licensed decoder with GDCM.** The sample scans are compressed with "JPEG Lossless", which needs a decoder. The first one used, `pylibjpeg-libjpeg`, is licensed GPL-3.0; shipping it inside the app would likely put the distributed app under GPL-3.0 obligations (such as making the source available). It was replaced by `python-gdcm` (GDCM library: BSD; its Python wrapper: Apache-2.0), which decodes the same format. Verified with no change in results: every slice of both samples decodes identically to before and to an independent reader (SimpleITK), and the segmentations of both samples are identical voxel for voxel — in the development setup and in the packaged backend. Remaining "share-alike"-style licences in the bundle are LGPL-3.0 (`connected-components-3d`, a TotalSegmentator dependency; the bundle keeps it as a separate replaceable library) and MPL-2.0 (`certifi`, `tqdm`; satisfied by shipping their notices).

**No Apple Developer ID signing or notarization.** A Developer ID costs money and notarization adds process; not worth it for a competition submission. The app is ad-hoc signed instead, which makes its signature valid; users open it the first time with right-click → Open.

**Bones stay one uniform colour.** Per-vertebra colours were considered and rejected. Click-to-name already covers telling vertebrae apart (the core comprehension feature, design doc §9), and colour is more valuable later for Phase 2: marking fractured vertebrae in red.

**Electron debugging switches stay unlocked until final submission.** The packaged app still accepts Electron's debugging switches. That's what lets the automated tests drive the packaged app (including the offline test). Locking them ("fuses") is one-way and would block further automated checks, so it is the **very last step** before the final submission.

**Phase 2 (fracture detection) as a separate, pluggable step.** As the design doc required, nothing in Phase 1 had to be rebuilt: the check is one extra step in `pipeline.py` after segmentation, writing its own results file (`fractures.json`), which the viewer reads if present.

**Fracture rules: Genant grades, not the paper's fitted numbers.** The thresholds in the reference paper (Inigo et al., [arXiv:2412.17258](https://arxiv.org/abs/2412.17258); full citation in §2 step 5) were fitted to a different dataset, so OrthoViz uses the standard Genant height-loss grades. One naming note: in Genant's scale, 20–25% is "mild" (grade 1), 25–40% "moderate" (grade 2) and over 40% "severe" (grade 3). OrthoViz flags at 25% (moderate) and labels 40%+ severe, and records 20–25% as borderline without flagging it.

**Compare each vertebra with its neighbours.** Healthy neck vertebrae are naturally waisted, so raw Genant ratios put healthy vertebrae right at the threshold (one healthy C5 measured 25%). Comparing each vertebra with the patient's other C3–C7 vertebrae removes that normal shape — the same idea as the "reference vertebra" in Inigo et al. ([arXiv:2412.17258](https://arxiv.org/abs/2412.17258)) and a radiologist's comparison with adjacent levels.

**C1 and C2 excluded from automatic checking (future work).** Their shapes don't fit a body-height model: C1 has no body, C2 has the dens. They still display correctly and can be clicked and named; the fracture check simply says "not checked automatically". Detecting C1/C2 fractures would need a different approach (for example, looking for breaks in the ring of C1 or at the base of the dens) — future work.

**Other implementation decisions:**

- **Run on the Mac's GPU, not the CPU** — the CPU route ran out of memory (§3).
- **Our own DICOM loader** — TotalSegmentator's built-in reader crashed on the samples; ours is checked against SimpleITK (identical).
- **Backend as a plain program, not a server** — simpler; one scan at a time.
- **3D shapes built in the coordinator** — fast, keeps backend output standard, tunable without rerunning the AI.
- **Only the five needed models bundled; no personal settings file** — smaller app, no shared personal ID.
- **Usage statistics switched off** — the app makes no network calls.
- **Backend frozen as a folder, not a single file** — avoids unpacking ~1 GB on every run.

---

## 6. How it was tested

### Automated tests in the repository

| Test | Command | What it proves |
|---|---|---|
| App unit tests (19) | `cd app && npm test` | Progress reading (against a real backend log, including the fracture-check stage), 3D shape building (closed, outward-facing, correct size and position), NIfTI reading, plain-language names, the security policy, backend path choice, first-use model installation (fresh machine, incomplete folder, user's own copy, cancel) |
| Backend unit tests (11) | `cd backend && .venv/bin/python -m pytest tests` | DICOM loader: slice sorting, positions, value conversion, duplicate/uneven-slice handling, the real sample. Fracture check on a synthetic spine with known answers: healthy (nothing flagged; C1/C2 excluded), wedge and crush fractures flagged with the right grade, a mild change marked borderline, a vertebra cut off by the scan not checked, a tilted neck not causing false alarms |
| Full app run | `cd app && npm run test:e2e` (~3 min) | Real app + real backend on patient1: Import → Processing → Viewer; Cancel stops everything, including helper processes |
| Viewer interactions | `cd app && npm run test:viewer` (~20 s) | Panel, filters, real mouse clicks naming vertebrae, drag doesn't select, preset views, "(behind)" labels, clearing selection, fracture check panel (C1/C2 "not checked", nothing red for healthy patient1) — on the saved patient1 result. Plus a **mock** result (patient1 with a made-up C5 flag) to check that a flagged vertebra turns red, is listed, and is explained in its label |
| Packaged app, offline, first launch | `cd app && npm run test:packaged -- <path to OrthoViz.app>` (~4 min) | See below |

### One-off validation checks (results)

- **DICOM loading:** both samples produce volumes identical to SimpleITK (an independent, widely-used reader), voxel for voxel, with matching position in the body.
- **Segmentation sanity:** all C1–C7 found in both samples; neighbouring vertebrae 12–21 mm apart (normal anatomy); bone densities sensible.
- **Packaged vs development backend:** identical segmentations on both samples.
- **GDCM vs the previous decoder:** identical decoding and identical segmentations on both samples.

### Fracture check on real scans

Seven patients from the RSNA 2022 dataset, with the correct answers from its `train.csv`. Numbers are measured height loss; ★ marks a vertebra that is truly fractured; flagging starts at 25%.

| Sample | RSNA study | Truly fractured | C3 | C4 | C5 | C6 | C7 | Flagged |
|---|---|---|---|---|---|---|---|---|
| patient1 | …10633 | none | 1% | 7% | 16% | 7% | 0% | none |
| patient_fracture1 | …6200 | C1, C2 | 0% | 15% | 3% | 21% (borderline) | 7% | none |
| patient_fracture2 | …1363 | C5 | 7% | 0% | 6% ★ | 7% | 0% | none |
| patient_fracture3 | …4859 | C6 | 15% | 13% | 7% | 2% ★ | 0% | none |
| **patient_fracture4 (demo)** | …1309 | C7 | 2% | 0% | 21% (borderline) | 3% | **75% ★ flagged** | **C7** |
| patient_fracture5 | …8043 | C7 | 6% | 1% | 3% | 5% | **25% ★ flagged** | C7 |
| patient_fracture6 | …15206 | C3 | **65% ★ flagged** | **46% flagged** | 12% | **30% flagged** | 9% | C3, C4, C6 |

What this shows:
- **Real demo case — patient_fracture4 (study 1309).** A severe fracture of the C7 body: the check flags C7 alone ("Possible fracture · 75% loss of height at the front — severe"), and the measurement plot confirms the front of the C7 body is genuinely collapsed. This is the official demonstration of Phase 2.
- **Body fractures: 3 of 3 flagged at the correct level** (patient_fracture4, 5 and 6).
- **Fractures that don't change body height: 0 of 2 flagged — expected, and out of reach of this method.** patient_fracture2's fracture is in C5's arch (the RSNA dataset's marking sits 13–18 mm behind the spinal cord); patient_fracture3's C6 body is full height.
- **False alarms: 2 of 30 healthy C3–C7 vertebrae**, both in patient_fracture6 (C4 and C6). The highest healthy reading elsewhere is 21% (borderline), close to the 25% line.
- **Leveling limitation (not fixed — future work), shown by two cases:**
  - *patient_fracture5 (study 8043):* the correct vertebra (C7) is flagged, but at exactly 25%, and its body still appears slanted after leveling, so the number isn't trustworthy — it could as easily have fallen below the line.
  - *patient_fracture6 (study 15206):* the real C3 fracture is flagged (the body is broken into pieces), but C5–C7 sit at a steep slant that leveling doesn't correct; their distorted heights produce false flags on C4 and C6.
  - A more robust leveling method was tried: it read patient_fracture5 more clearly but added two new false alarms (including one in patient_fracture1), so it was not kept.
- **patient_fracture1 (C1/C2 fractures): visualizes correctly, not yet flagged.** Its 3D model shows correctly and C1/C2 can be clicked and named; the fracture check lists them as "not checked automatically", by design.

### How the fracture cases were found

The first three fracture cases tried (studies 1363, 4859 and 24045, picked by fracture level alone) didn't work as demos: two turned out to be fractures that don't change body height, and the third couldn't be downloaded because Kaggle limits slice-by-slice downloads.

So candidates were screened properly. Of the 586 RSNA patients whose only fracture is in C3–C7, 142 have fracture locations marked (bounding boxes). A private Kaggle notebook (`neeru004/orthoviz-phase-2-candidate-screening`, script in `backend/tools/screen_rsna_body_fractures.py`) ran next to the data and, for each box, found the spinal canal on that CT slice and checked whether the box sits in front of it (the body) or behind it (the arch). Result: 37 body, 45 mixed, 50 arch, 10 undetermined. The body cases were ranked by fracture size (single-level first), the top 10 checked by eye, and the top 3 downloaded as one archive — these are patient_fracture4–6. The check was validated first on study 1363 (correctly placed behind the canal) and on a box drawn on a vertebral body (correctly placed in front).

### The offline test

The packaged app (run straight from the mounted `.dmg`) was started with an **empty home folder** — like a brand-new Mac with no `~/.totalsegmentator` — and with networking blocked **for the app only**, three ways at once:

1. a macOS sandbox rule blocking all outgoing connections except to the computer itself, with macOS logging any blocked attempt;
2. proxy settings pointing at a local "trap" that records any request and which site it was for;
3. a watch on every network connection the app's processes open.

Before trusting it, the sandbox was proven to work: a test download inside it was blocked and logged; outside it, it worked.

**Result:** the app installed the models, completed a full segmentation of patient1 with the bundled backend, and showed the 3D model — with **no network attempts of any kind** (nothing blocked, nothing trapped, no outside connections). The test also confirmed the test-only hook is absent from the packaged app. (One technical note: the browser engine's own internal sandbox had to be turned off for that test run, because macOS doesn't allow a sandbox inside a sandbox; this doesn't affect networking.)

---

## 7. Current status

**In one line:** Phase 1 (scan → 3D model → name the vertebrae) is complete, packaged and tested. **Phase 2, fracture detection, has a first version for C3–C7, with a real demo case (patient_fracture4, severe C7 fracture flagged on its own). It caught all 3 body fractures tested, but gives false alarms when vertebrae are steeply slanted (future work).**

### Done and tested

- Python backend: DICOM loading, full-resolution TotalSegmentator on the Mac's GPU, result files.
- App: Import screen (button and drag-and-drop), Processing screen (live progress, stages, estimate, cancel, plain-language errors), 3D viewer (panel, filters, click-to-name, "(behind)" labels, preset views), About dialog.
- Packaging: self-contained `.dmg`, bundled models installed on first use, licences included, ad-hoc signed, verified fully offline.
- Licensing: GPL decoder removed.
- Fracture check, first version: C3–C7 body height loss with Genant grades, red flagging and a findings panel in the viewer. On 7 real patients: 3/3 body fractures flagged at the right level, 2/30 healthy vertebrae wrongly flagged (one patient). Real demo case: patient_fracture4.

### Still open

- **Slanted-vertebra leveling (future work, not attempted yet).** The fracture check's leveling step fails on steeply slanted vertebrae, causing the false alarms in patient_fracture6 and the unreliable reading in patient_fracture5 (§6). Needs a better way of orienting each vertebra in 3D.
- **Fractures the check can't see.** Breaks in the vertebral arch or processes, and cracks without height loss — common in trauma, as both real RSNA cases here show — would need a different method.
- **C1 and C2 fracture detection (future work).** Excluded on purpose: their shapes don't fit a height-loss model. patient_fracture1 (C1/C2 fractures) **visualizes correctly but is not yet flagged** — the app says so rather than showing it as clear.
- **More test scans.** Seven patients is a small test set: with healthy readings up to 21% against a 25% threshold, more healthy and fractured cases are needed to know how reliable the check really is. The screening (§6) found 37 more body-fracture candidates.
- **Crop the scan to the neck before segmenting?** (design doc §10) Not decided. Scans that extend into the chest take ~3× longer (§3); cropping would make timing predictable but needs a reliable way to find the neck region first.
- **Drag-and-drop needs one manual test.** Real drags from Finder can't be automated; the button path is fully tested and drag-and-drop uses the standard Electron mechanism, but it should be tried once by hand.
- **Accuracy check against expert masks** (design doc §7). The RSNA dataset includes ground-truth vertebra masks for some patients, but none were among the downloaded samples, so this comparison hasn't been done.
- **App icon.** The app still uses Electron's default icon.
- **Windows build** — a stretch goal per the design doc; not started.

### The one remaining pre-submission step

**Lock the Electron debugging switches ("fuses")** — the very last thing before final submission, after all other work and testing is complete (see §5).

---

## 8. How to build, run, test and package from scratch

### What you need

- A Mac with Apple Silicon (M1 or later), ideally 16 GB memory.
- [Homebrew](https://brew.sh), then:
  ```sh
  brew install uv node
  ```
  (`uv` manages Python; Node runs the app tools. Python 3.12 itself is fetched by `uv` automatically — the Mac's own newer Python is too new for TotalSegmentator.)
- The sample scans in `dicom_samples/` (not stored in git): `patient1` (healthy), `patient_fracture1` (C1+C2 fractures, study …6200), `patient_fracture2` (C5 arch fracture, study …1363), `patient_fracture3` (C6 fracture, study …4859), `patient_fracture4` (**the Phase 2 demo**: severe C7 body fracture, study …1309), `patient_fracture5` (C7 body fracture, study …8043) and `patient_fracture6` (C3 body fracture, study …15206) — both leveling-limit examples — and `train.csv` (RSNA's correct answers).
- Internet access **once**, for downloading libraries and (if not already present) the TotalSegmentator models.

### 1. Set up the backend

```sh
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv -e ".[dev,build]"
```

Try it on a sample (this also downloads the five TotalSegmentator models into `~/.totalsegmentator` the first time, if they aren't there yet):

```sh
.venv/bin/orthoviz-segment ../dicom_samples/patient1 ../output/patient1
```

Results land in `output/patient1/` (not stored in git). To re-run only the fracture check on an existing result (e.g. one made before Phase 2): `.venv/bin/python -m orthoviz_backend.fracture ../output/patient1`.

To see what the fracture check measured: `.venv/bin/python tools/plot_fracture_measurements.py ../output/patient1 check.png` draws each vertebra's middle slice with the measured edges.

To download another RSNA patient: see the instructions at the top of `backend/tools/fetch_rsna_study.py` (needs a Kaggle account that has accepted the competition rules). Slice-by-slice downloads hit Kaggle's rate limit after a few hundred files; for several studies, use the Kaggle-notebook approach in `backend/tools/screen_rsna_body_fractures.py`, which packages studies into one download.

### 2. Set up and run the app (development)

```sh
cd app
npm install
npm start                                   # the full app
npm start -- --result=../output/patient1    # skip straight to the viewer with a saved result
```

### 3. Run the tests

```sh
cd backend && .venv/bin/python -m pytest tests     # backend
cd app && npm test                                 # app unit tests
cd app && npm run test:viewer                      # viewer interactions (needs output/patient1)
cd app && npm run test:e2e                         # full run with the real backend (~3 min)
```

### 4. Build the installable app

```sh
cd app
npm run build:backend    # freeze the backend (~3 min)
npm run dist             # stage models + licences, build and sign → dist/OrthoViz-0.1.0-arm64.dmg
```

(`npm run dist:dir` builds just `dist/mac-arm64/OrthoViz.app`, without the `.dmg` — quicker for testing.)

If the models live somewhere other than `~/.totalsegmentator/nnunet/results`, point to them with `TOTALSEG_WEIGHTS_SOURCE=<folder> npm run dist`.

### 5. Test the packaged app offline

```sh
cd app
npm run test:packaged -- dist/mac-arm64/OrthoViz.app
```

To test the actual `.dmg`, mount it (double-click) and pass `/Volumes/OrthoViz/OrthoViz.app` instead.

### Useful settings (environment variables)

| Setting | Effect |
|---|---|
| `ORTHOVIZ_BACKEND` | Use a different backend program (testing) |
| `ORTHOVIZ_RESULTS_DIR` | Put results somewhere other than `~/Library/Application Support/OrthoViz/results` |
| `TOTALSEG_WEIGHTS_SOURCE` | Where the build script takes the models from |

### Where things are

```
OrthoViz_Design_Doc.md     original design and decision record (unchanged)
OrthoViz_As_Built.md       this document
backend/                   Python backend
  orthoviz_backend/        cli.py, pipeline.py, dicom_loader.py, segmentation.py
  packaging/               PyInstaller recipe, entry point, licence collector
  tests/                   backend tests
app/                       Electron app
  src/main/                coordinator: main.js, backend.js, weights.js, mesh-worker.js, meshing.js, nifti.js, preload.js
  src/renderer/            window: index.html, app.js, viewer.js, panel.js, anatomy.js, styles.css
  scripts/                 build staging script
  tests/unit, tests/e2e    tests
dicom_samples/             sample scans (not in git)
output/                    saved results from development runs (not in git)
docs/papers/               local copies of reference papers (not in git; cited in this document)
```

---

## 9. Glossary

- **Ad-hoc signing** — giving an app a valid code signature without an Apple developer account. It proves the app hasn't been altered since signing, but Apple hasn't checked it, so macOS asks for confirmation (right-click → Open) the first time.
- **asar** — the single archive file inside the app that holds our JavaScript code.
- **DICOM** — the standard file format for medical scans; one file per slice is typical.
- **Electron** — a toolkit for building desktop apps with web technology. Has a "main process" (our coordinator) and "renderer" windows (our screens).
- **electron-builder** — the tool that packages an Electron app into a `.app` and `.dmg`.
- **Compression fracture** — a fracture that squashes the vertebral body, making it shorter; the kind the fracture check looks for.
- **Fuses** — switches baked into an Electron app that permanently disable certain features (such as debugging access) in the shipped build.
- **Genant grading** — the standard way to grade vertebral fractures by how much body height is lost: 20–25% mild (grade 1), 25–40% moderate (grade 2), over 40% severe (grade 3).
- **GDCM** — an open-source library for reading DICOM files, including compressed ones.
- **Hounsfield units (HU)** — the CT brightness scale: air ≈ −1000, water = 0, bone several hundred and up.
- **Mesh** — a 3D surface made of many small triangles; what the viewer actually draws.
- **MPS** — Apple's GPU computing system, used by PyTorch on Apple Silicon Macs.
- **NIfTI** — a common file format for a whole 3D medical volume in one file (`.nii.gz` when compressed).
- **nnU-Net** — the AI framework TotalSegmentator is built on.
- **PyInstaller** — a tool that "freezes" a Python program and all its libraries into a self-contained program that runs without Python installed.
- **PyTorch** — the AI library that runs TotalSegmentator's models.
- **Segmentation** — labelling every voxel of a scan with the structure it belongs to.
- **Surface nets** — a standard method for tracing a smooth surface around a labelled 3D region.
- **Three.js** — a JavaScript library for 3D graphics in a web page.
- **TotalSegmentator** — the open-source AI tool (Apache-2.0) that identifies over 100 anatomical structures in CT scans; OrthoViz bundles it rather than building its own model (design doc §3).
- **Voxel** — a 3D pixel: one small cube of the scan.
- **Weights** — the trained "knowledge" of an AI model, stored as files; TotalSegmentator's full-resolution mode uses five models (~1.2 GB total).
