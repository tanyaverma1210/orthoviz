"""Load a folder of DICOM files into a single 3D CT volume.

Handles two layouts:
  * one file per slice (the common case, e.g. the RSNA samples), and
  * a single multi-frame (Enhanced CT) file.

The result is returned as a NIfTI image in RAS+ orientation, which is what
TotalSegmentator consumes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import nibabel as nib
import numpy as np
import pydicom
from pydicom.errors import InvalidDicomError

log = logging.getLogger(__name__)

# Relative tolerance when checking that slices are evenly spaced.
SLICE_SPACING_TOLERANCE = 0.05


class DicomLoadError(Exception):
    """The folder does not contain a usable CT volume."""


@dataclass
class LoadedVolume:
    image: nib.Nifti1Image
    series_uid: str
    study_uid: str
    num_slices: int
    spacing_mm: tuple[float, float, float]
    warnings: list[str] = field(default_factory=list)


def load_dicom_folder(folder: str | Path) -> LoadedVolume:
    folder = Path(folder)
    if not folder.is_dir():
        raise DicomLoadError(f"Not a folder: {folder}")

    datasets = _read_headers(folder)
    if not datasets:
        raise DicomLoadError(f"No DICOM image files found in {folder}")

    warnings: list[str] = []

    # Group by series; if the folder mixes series, use the largest one.
    series: dict[str, list[pydicom.Dataset]] = {}
    for ds in datasets:
        series.setdefault(str(ds.get("SeriesInstanceUID", "unknown")), []).append(ds)
    series_uid, headers = max(series.items(), key=lambda kv: _frame_count(kv[1]))
    if len(series) > 1:
        msg = (f"Folder contains {len(series)} series; using {series_uid} "
               f"({_frame_count(headers)} frames) and ignoring the rest")
        log.warning(msg)
        warnings.append(msg)

    modality = headers[0].get("Modality")
    if modality and modality != "CT":
        raise DicomLoadError(f"Expected a CT series, got modality {modality!r}")

    if len(headers) == 1 and _frame_count(headers) > 1:
        volume, affine = _load_multiframe(headers[0], warnings)
    else:
        volume, affine = _load_single_frame_series(headers, warnings)

    image = nib.Nifti1Image(volume, affine)
    image.header.set_xyzt_units("mm")
    spacing = tuple(float(s) for s in image.header.get_zooms()[:3])

    return LoadedVolume(
        image=image,
        series_uid=series_uid,
        study_uid=str(headers[0].get("StudyInstanceUID", "")),
        num_slices=volume.shape[2],
        spacing_mm=spacing,
        warnings=warnings,
    )


def _read_headers(folder: Path) -> list[pydicom.Dataset]:
    """Read every DICOM file under `folder` that contains pixel data.

    Pixel data is loaded lazily later; non-DICOM files (e.g. .DS_Store) are skipped.
    """
    datasets = []
    for path in sorted(p for p in folder.rglob("*") if p.is_file()):
        if path.name.startswith("."):
            continue
        try:
            ds = pydicom.dcmread(path)
        except (InvalidDicomError, OSError):
            log.debug("Skipping non-DICOM file %s", path)
            continue
        if "PixelData" not in ds:
            continue
        datasets.append(ds)
    return datasets


def _frame_count(headers: list[pydicom.Dataset]) -> int:
    return sum(int(ds.get("NumberOfFrames", 1)) for ds in headers)


def _slice_normal(orientation) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    row_cos = np.array(orientation[:3], dtype=float)
    col_cos = np.array(orientation[3:], dtype=float)
    return row_cos, col_cos, np.cross(row_cos, col_cos)


def _load_single_frame_series(headers: list[pydicom.Dataset], warnings: list[str]):
    if len(headers) < 2:
        raise DicomLoadError("Need at least 2 slices to build a 3D volume")

    for ds in headers:
        for tag in ("ImagePositionPatient", "ImageOrientationPatient", "PixelSpacing"):
            if tag not in ds:
                raise DicomLoadError(f"Slice {ds.filename} is missing {tag}")

    orientation = [float(v) for v in headers[0].ImageOrientationPatient]
    shape = (int(headers[0].Rows), int(headers[0].Columns))
    for ds in headers:
        if not np.allclose([float(v) for v in ds.ImageOrientationPatient], orientation, atol=1e-4):
            raise DicomLoadError("Slices have inconsistent orientations (possibly a tilted/localizer series)")
        if (int(ds.Rows), int(ds.Columns)) != shape:
            raise DicomLoadError("Slices have inconsistent image sizes")

    # Sort by position along the slice normal (instance numbers are not reliable).
    row_cos, col_cos, normal = _slice_normal(orientation)
    headers = sorted(headers, key=lambda ds: float(np.dot(normal, [float(v) for v in ds.ImagePositionPatient])))
    positions = np.array([[float(v) for v in ds.ImagePositionPatient] for ds in headers])

    distances = positions @ normal
    gaps = np.diff(distances)
    if np.any(np.isclose(gaps, 0, atol=1e-3)):
        raise DicomLoadError("Folder contains duplicate slice positions")
    median_gap = float(np.median(gaps))
    irregular = np.abs(gaps - median_gap) > SLICE_SPACING_TOLERANCE * median_gap
    if irregular.any():
        msg = (f"{int(irregular.sum())} slice gap(s) deviate from the median spacing "
               f"of {median_gap:.3f} mm (min {gaps.min():.3f}, max {gaps.max():.3f}); "
               "the volume will assume uniform spacing")
        log.warning(msg)
        warnings.append(msg)

    # Stack as (columns, rows, slices) so that voxel index (i, j, k) follows
    # DICOM's convention: i along the row direction, j along the column direction.
    volume = np.empty((shape[1], shape[0], len(headers)), dtype=np.int16)
    for k, ds in enumerate(headers):
        volume[:, :, k] = _to_hu(ds.pixel_array, ds).T

    row_spacing, col_spacing = (float(v) for v in headers[0].PixelSpacing)
    slice_step = (positions[-1] - positions[0]) / (len(headers) - 1)
    affine = _lps_to_ras_affine(row_cos * col_spacing, col_cos * row_spacing, slice_step, positions[0])
    return volume, affine


def _load_multiframe(ds: pydicom.Dataset, warnings: list[str]):
    """Enhanced CT: one file, geometry stored in functional group sequences."""
    shared = ds.get("SharedFunctionalGroupsSequence", [None])[0]
    per_frame = ds.get("PerFrameFunctionalGroupsSequence")
    if per_frame is None:
        raise DicomLoadError("Multi-frame file lacks per-frame geometry (PerFrameFunctionalGroupsSequence)")

    def lookup(frame_group, seq_name, attr):
        for group in (frame_group, shared):
            if group is not None and seq_name in group:
                item = group[seq_name][0]
                if attr in item:
                    return item[attr].value
        raise DicomLoadError(f"Multi-frame file is missing {seq_name}.{attr}")

    orientation = [float(v) for v in lookup(per_frame[0], "PlaneOrientationSequence", "ImageOrientationPatient")]
    row_spacing, col_spacing = (float(v) for v in lookup(per_frame[0], "PixelMeasuresSequence", "PixelSpacing"))
    row_cos, col_cos, normal = _slice_normal(orientation)

    positions = np.array([[float(v) for v in lookup(f, "PlanePositionSequence", "ImagePositionPatient")]
                          for f in per_frame])
    order = np.argsort(positions @ normal)
    positions = positions[order]

    pixels = ds.pixel_array  # (frames, rows, cols)
    volume = np.empty((pixels.shape[2], pixels.shape[1], len(order)), dtype=np.int16)
    for k, idx in enumerate(order):
        frame = per_frame[idx]
        slope = intercept = None
        try:
            slope = float(lookup(frame, "PixelValueTransformationSequence", "RescaleSlope"))
            intercept = float(lookup(frame, "PixelValueTransformationSequence", "RescaleIntercept"))
        except DicomLoadError:
            pass
        volume[:, :, k] = _to_hu(pixels[idx], ds, slope, intercept).T

    gaps = np.diff(positions @ normal)
    median_gap = float(np.median(gaps))
    if np.any(np.abs(gaps - median_gap) > SLICE_SPACING_TOLERANCE * median_gap):
        warnings.append("Multi-frame slice spacing is irregular; assuming uniform spacing")

    slice_step = (positions[-1] - positions[0]) / (len(order) - 1)
    affine = _lps_to_ras_affine(row_cos * col_spacing, col_cos * row_spacing, slice_step, positions[0])
    return volume, affine


def _to_hu(pixels: np.ndarray, ds: pydicom.Dataset, slope=None, intercept=None) -> np.ndarray:
    slope = float(ds.get("RescaleSlope", 1)) if slope is None else slope
    intercept = float(ds.get("RescaleIntercept", 0)) if intercept is None else intercept
    hu = pixels.astype(np.float32) * slope + intercept
    return np.clip(np.round(hu), -32768, 32767).astype(np.int16)


def _lps_to_ras_affine(i_vec, j_vec, k_vec, origin) -> np.ndarray:
    """Build a voxel->world affine from DICOM (LPS) vectors, converted to NIfTI RAS."""
    affine = np.eye(4)
    affine[:3, 0] = i_vec
    affine[:3, 1] = j_vec
    affine[:3, 2] = k_vec
    affine[:3, 3] = origin
    affine[:2, :] *= -1  # LPS -> RAS: flip x and y
    return affine
