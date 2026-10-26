"""End-to-end Phase 1 pipeline: DICOM folder -> CT volume -> segmentation on disk.

Kept separate from the CLI so a future local API server (for the Electron UI) and
the Phase 2 fracture step can call the same function.

Output folder layout:
    ct.nii.gz            the stacked input volume (HU, RAS+)
    segmentation.nii.gz  multi-label TotalSegmentator result, same grid as ct.nii.gz
    labels.json          {label_value: structure_name} for structures that were found
    fractures.json       Phase 2: C3–C7 vertebral body height-loss screening (see fracture.py)
    run_info.json        source series, timing and settings
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import nibabel as nib

from .dicom_loader import load_dicom_folder
from .fracture import analyze_output_dir, summarize
from .segmentation import resolve_device, run_totalsegmentator

log = logging.getLogger(__name__)


def process_scan(dicom_folder: str | Path, output_dir: str | Path, device: str = "auto") -> dict:
    dicom_folder = Path(dicom_folder)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    device = resolve_device(device)

    t0 = time.monotonic()
    log.info("Loading DICOM files from %s", dicom_folder)
    loaded = load_dicom_folder(dicom_folder)
    log.info("Loaded %d slices, shape %s, spacing %s mm",
             loaded.num_slices, loaded.image.shape, tuple(round(s, 3) for s in loaded.spacing_mm))

    ct_path = output_dir / "ct.nii.gz"
    nib.save(loaded.image, str(ct_path))
    load_seconds = time.monotonic() - t0

    log.info("Running TotalSegmentator (full resolution, device=%s)...", device)
    t1 = time.monotonic()
    seg_path = output_dir / "segmentation.nii.gz"
    labels = run_totalsegmentator(ct_path, seg_path, device=device)
    seg_seconds = time.monotonic() - t1
    log.info("Segmentation finished in %.1f s; %d structures found", seg_seconds, len(labels))

    (output_dir / "labels.json").write_text(json.dumps(labels, indent=2))

    # Phase 2: screen C3–C7 for vertebral body height loss. A failure here must not cost the
    # user their 3D model, so it is recorded in fractures.json instead of failing the run.
    log.info("Checking vertebrae C3-C7 for height loss...")
    t2 = time.monotonic()
    try:
        report = analyze_output_dir(output_dir)
        log.info("Fracture check: %s; flagged: %s", summarize(report), ", ".join(report["flagged"]) or "none")
    except Exception as e:  # noqa: BLE001 - report any analysis failure, keep the segmentation
        log.exception("Fracture check failed")
        (output_dir / "fractures.json").write_text(json.dumps({"error": f"Fracture check failed: {e}"}, indent=2))
    fracture_seconds = time.monotonic() - t2

    run_info = {
        "dicom_folder": str(dicom_folder.resolve()),
        "study_uid": loaded.study_uid,
        "series_uid": loaded.series_uid,
        "volume_shape": list(loaded.image.shape),
        "spacing_mm": list(loaded.spacing_mm),
        "warnings": loaded.warnings,
        "totalsegmentator": {"task": "total", "fast": False, "device": device},
        "timing_seconds": {"load": round(load_seconds, 1), "segmentation": round(seg_seconds, 1),
                           "fracture_check": round(fracture_seconds, 1)},
        "outputs": {"ct": ct_path.name, "segmentation": seg_path.name, "labels": "labels.json",
                    "fractures": "fractures.json"},
    }
    (output_dir / "run_info.json").write_text(json.dumps(run_info, indent=2))
    return run_info
