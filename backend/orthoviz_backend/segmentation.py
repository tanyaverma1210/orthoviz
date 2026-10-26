"""Run TotalSegmentator on a loaded CT volume."""

from __future__ import annotations

import logging
from pathlib import Path

import nibabel as nib
import numpy as np

log = logging.getLogger(__name__)


def _disable_usage_stats() -> None:
    """Stop TotalSegmentator from POSTing run metadata to stats.totalsegmentator.com.

    OrthoViz is meant to run fully offline. This patches only this process and
    leaves the user's ~/.totalsegmentator/config.json untouched.
    """
    import totalsegmentator.python_api as api

    api.send_usage_stats = lambda *args, **kwargs: None


def resolve_device(device: str = "auto") -> str:
    """Pick a TotalSegmentator device. "auto" prefers Apple's MPS, then CUDA, then CPU.

    On Apple Silicon, PyTorch's CPU build has no oneDNN, so 3D convolutions fall back
    to a path that needed ~17 GB and swapped heavily on a 16 GB M1; MPS ran the same
    scan in ~8 min with a 7.5 GB peak.
    """
    if device != "auto":
        return device
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "gpu"
    return "cpu"


def run_totalsegmentator(ct_path: Path, output_path: Path, device: str = "mps") -> dict[int, str]:
    """Segment `ct_path` (NIfTI) at full resolution and write a multi-label NIfTI.

    Returns the label map {label_value: structure_name} for labels present in the result.
    """
    from totalsegmentator.map_to_binary import class_map
    from totalsegmentator.python_api import totalsegmentator

    _disable_usage_stats()

    # fast=False: the 3mm fast model is too blocky for patient-facing display.
    totalsegmentator(
        str(ct_path),
        str(output_path),
        ml=True,
        fast=False,
        task="total",
        device=device,
    )

    seg = nib.load(str(output_path))
    present = np.unique(np.asarray(seg.dataobj)).astype(int)
    names = class_map["total"]
    return {int(v): names[int(v)] for v in present if v != 0}
