"""Phase 2: rule-based screening for vertebral body height loss, C3–C7 only.

Approach (after Inigo et al. 2024, "An Intrinsically Explainable Approach to Detecting
Vertebral Compression Fractures in CT Scans via Neurosymbolic Modeling",
https://arxiv.org/abs/2412.17258): take the
TotalSegmentator segmentation, measure each vertebral body's height at the front, middle
and back, and apply simple threshold rules. No model training. Unlike the paper's fitted
thresholds (calibrated on a different dataset), the cut-offs are the standard Genant
height-loss grades.

Per vertebra:
  1. Local frame: "up" follows the spine (direction from the vertebra below to the one
     above), "left-right" is the patient's, "front" completes the frame. This undoes the
     neck's curvature.
  2. In a thin slab at the midline, the vertebra appears as body | spinal canal | arch.
     The front-most continuous piece is the vertebral body; the arch is ignored.
  3. Heights across the body: anterior (Ha) and posterior (Hp) at the body's edges, from a
     line fitted to the height profile; middle (Hm) measured directly at the centre.
  4. Height loss is the worst of three ratios, each compared with the same ratio in the
     patient's other C3–C7 vertebrae (median), like a radiologist comparing with adjacent
     levels (and the paper's reference vertebra):
       wedge      Ha/Hp     (front collapsed)
       biconcave  Hm/Hp     (middle collapsed)
       crush      Hp        (whole body flattened)
     Comparing with the patient's own neighbours matters in the neck: healthy cervical
     bodies are naturally "waisted" (Hm/Hp around 0.75-0.85), which raw Genant ratios,
     defined for the thoracolumbar spine, would read as 20-25% height loss. With fewer
     than two other measurable vertebrae, the raw ratios are used (crush is skipped).
  5. Genant grading: >= 25% flagged (grade 2, moderate), >= 40% severe (grade 3);
     20-25% recorded as borderline (grade 1) but not flagged.

C1 (ring-shaped, no body) and C2 (body fused with the dens) don't fit this height model
and are reported as not assessed.

This is a screening aid for visualization, not a diagnosis. It only sees fractures that
reduce vertebral body height; fractures of the arch or processes are not detectable this way.

    python -m orthoviz_backend.fracture <output_dir>   # (re)analyse an existing result
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

log = logging.getLogger(__name__)

METHOD_VERSION = 2  # 2: flagged vertebrae carry a 3D marker for the viewer
ASSESSED_LEVELS = ["C3", "C4", "C5", "C6", "C7"]
NOT_ASSESSED_LEVELS = {
    "C1": "C1 (the atlas) is a ring with no vertebral body, so height-loss rules don't apply.",
    "C2": "C2 (the axis) has the dens fused to its body, so height-loss rules don't apply.",
}
# Order of vertebrae along the spine, used to find neighbours for the local "up" direction.
SPINE_ORDER = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "T1", "T2"]

BORDERLINE = 0.20  # Genant grade 1 (mild): recorded, not flagged
FRACTURE = 0.25    # Genant grade 2 (moderate): flagged
SEVERE = 0.40      # Genant grade 3 (severe): flagged

SLAB_HALF_WIDTH_MM = 3.0     # half-width of the midline slab used for measurement
BIN_MM = 0.5                 # resolution of the local measurement grid
CANAL_GAP_MM = 1.5           # an empty stretch at least this long separates body from arch
BODY_DEPTH_RANGE_MM = (8.0, 30.0)
# Front and back heights come from a straight line fitted to the height profile over this
# part of the body (fractions of depth from the front edge), read off at the edges: Genant
# defines them at the margins, but the rims themselves are rounded and would read low.
PROFILE_FIT = (0.10, 0.90)
# The middle height is measured directly here, so a dip in the middle still shows.
MIDDLE_ZONE = (0.40, 0.60)


def analyze(segmentation: nib.Nifti1Image, labels: dict[int, str]) -> dict:
    """Return the fracture report for a segmentation and its {label: name} map."""
    data = np.asarray(segmentation.dataobj)
    affine = segmentation.affine
    by_level = {name.removeprefix("vertebrae_"): int(value)
                for value, name in labels.items() if name.startswith("vertebrae_")}

    # Voxel indices of each vertebra, found inside its bounding box (one pass over the volume).
    boxes = ndimage.find_objects(data)
    voxels = {}
    for level, value in by_level.items():
        if level in SPINE_ORDER and value <= len(boxes) and boxes[value - 1] is not None:
            box = boxes[value - 1]
            voxels[level] = np.argwhere(data[box] == value) + [sl.start for sl in box]
    centroids = {level: _to_world(affine, idx.mean(axis=0))[0] for level, idx in voxels.items()}

    measured = {}
    geometry = {}
    results = {}
    for level in ASSESSED_LEVELS:
        if level not in voxels:
            results[level] = _not_assessed(level, "Not in the scan.")
            continue
        idx = voxels[level]
        if _touches_edge(idx, data.shape):
            results[level] = _not_assessed(level, "Only partly inside the scan, so its height can't be measured.")
            continue
        try:
            measured[level], geometry[level] = _measure(level, idx, affine, centroids)
        except MeasurementError as e:
            results[level] = _not_assessed(level, str(e))

    # Compare each vertebra's ratios with the median of the other measured vertebrae.
    shape = {lv: {"wedge": m["anterior"] / m["posterior"], "biconcave": m["middle"] / m["posterior"],
                  "crush": m["posterior"]} for lv, m in measured.items()}
    for level, m in measured.items():
        others = [shape[lv] for lv in measured if lv != level]
        if len(others) >= 2:
            reference = {k: float(np.median([o[k] for o in others])) for k in shape[level]}
        else:
            reference = {"wedge": 1.0, "biconcave": 1.0}  # raw Genant ratios, no crush check
        results[level] = _grade(level, m, shape[level], reference, geometry[level])

    vertebrae = [results[lv] for lv in ASSESSED_LEVELS]
    for level, reason in NOT_ASSESSED_LEVELS.items():
        vertebrae.insert(SPINE_ORDER.index(level), _not_assessed(level, reason, scope="excluded"))

    return {
        "method": "vertebral body height loss (Genant grading), after Inigo et al. 2024",
        "method_version": METHOD_VERSION,
        "scope": ASSESSED_LEVELS,
        "thresholds": {"borderline": BORDERLINE, "fracture": FRACTURE, "severe": SEVERE},
        "disclaimer": "Screening aid for visualization, not a diagnosis. Detects loss of vertebral "
                      "body height only; fractures of the arch or processes are not detected.",
        "vertebrae": vertebrae,
        "flagged": [v["level"] for v in vertebrae if v["status"] == "fracture"],
    }


class MeasurementError(Exception):
    pass


def _to_world(affine, ijk):
    """Voxel indices (N, 3) -> RAS millimetres (N, 3)."""
    return np.atleast_2d(np.asarray(ijk, dtype=float)) @ affine[:3, :3].T + affine[:3, 3]


def _touches_edge(idx, shape):
    return bool((idx.min(axis=0) == 0).any() or (idx.max(axis=0) == np.array(shape) - 1).any())


def _local_frame(level, centroids):
    """Unit vectors (lateral, anterior, superior) in RAS for this vertebra."""
    i = SPINE_ORDER.index(level)
    above = next((centroids[lv] for lv in reversed(SPINE_ORDER[:i]) if lv in centroids), None)
    below = next((centroids[lv] for lv in SPINE_ORDER[i + 1:] if lv in centroids), None)
    here = centroids[level]
    if above is not None and below is not None:
        up = above - below
    elif above is not None:
        up = above - here
    elif below is not None:
        up = here - below
    else:
        up = np.array([0.0, 0.0, 1.0])
    lateral = np.array([1.0, 0.0, 0.0])                # patient right (RAS +x)
    up = up - up.dot(lateral) * lateral                # keep "up" in the sagittal plane
    up /= np.linalg.norm(up)
    if up[2] < 0:
        up = -up
    anterior = np.cross(up, lateral)
    if anterior[1] < 0:
        anterior = -anterior
    return lateral, anterior, up


def _measure(level, idx, affine, centroids, debug=None):
    """Anterior/middle/posterior body heights (mm) of one vertebra, and where they were measured.

    Returns (heights, geometry). `geometry` locates the measurement in RAS millimetres so the
    viewer can draw it: the levelled "up" direction, the body's bottom edge at the front,
    middle and back, and its half-width. If `debug` is a dict, it receives the aligned body
    points and edges (for plotting).
    """
    lateral, anterior, up = _local_frame(level, centroids)
    pts = _to_world(affine, idx)                       # (N, 3) in mm
    center = pts.mean(axis=0)
    rel = pts - center
    u_all, a_all, h_all = rel @ lateral, rel @ anterior, rel @ up
    u0 = float(np.median(u_all))                       # midline
    u, a, h = u_all, a_all, h_all

    slab = np.abs(u - u0) <= SLAB_HALF_WIDTH_MM
    if slab.sum() < 50:
        raise MeasurementError("Too little of the vertebra at the midline to measure.")
    u, a, h = u[slab], a[slab], h[slab]

    # 1. Keep the body: the front-most continuous piece, before the spinal canal gap.
    body = a >= _canal_front(a)
    u, a, h = u[body], a[body], h[body]

    # 2. Rotate (in the sagittal plane) so the endplates are level; the spine-based "up"
    #    is only approximate because vertebra centroids include the arch.
    voxel_extent = float(np.abs(affine[:3, :3].T @ up).max())  # one voxel's size along "up"
    theta = 0.0
    for _ in range(3):
        angle = _endplate_tilt(u, a, h, voxel_extent)
        c, s = np.cos(angle), np.sin(angle)
        a, h = c * a + s * h, -s * a + c * h
        theta += angle

    # 3. Body edges: where it reaches substantial height, so a lip or bone spur at the
    #    rim doesn't count as the edge.
    col_a, col_height, col_bottom = _column_heights(u, a, h, voxel_extent)
    bins = np.floor(col_a / BIN_MM).astype(int)
    profile = {b: np.median(col_height[bins == b]) for b in np.unique(bins)}
    typical = np.median(list(profile.values()))
    full = sorted(b for b, v in profile.items() if v >= 0.5 * typical)
    a_front, a_back = (full[-1] + 1) * BIN_MM, full[0] * BIN_MM
    depth = a_front - a_back
    if not BODY_DEPTH_RANGE_MM[0] <= depth <= BODY_DEPTH_RANGE_MM[1]:
        raise MeasurementError(f"Could not separate the vertebral body (depth {depth:.1f} mm).")

    # 4. Front/back heights from a line through the height profile, read at the edges;
    #    middle height measured directly.
    from_front = (a_front - col_a) / depth             # 0 at the front edge, 1 at the back
    fit = (from_front >= PROFILE_FIT[0]) & (from_front <= PROFILE_FIT[1])
    middle = (from_front >= MIDDLE_ZONE[0]) & (from_front <= MIDDLE_ZONE[1])
    if fit.sum() < 10 or middle.sum() < 3:
        raise MeasurementError("Too few height measurements across the vertebral body.")
    slope, intercept = np.polyfit(from_front[fit], col_height[fit], 1)
    heights = {
        "anterior": float(intercept),
        "middle": float(np.median(col_height[middle])),
        "posterior": float(intercept + slope),
        "depth": float(depth),
    }
    if min(heights["anterior"], heights["posterior"]) <= 0:
        raise MeasurementError("Implausible height profile.")

    # 5. Where the heights were measured, back in RAS: the body's bottom edge (from a line
    #    through the column bottoms, like the heights) at the front, middle and back.
    b_slope, b_intercept = np.polyfit(from_front[fit], col_bottom[fit], 1)
    c, s = np.cos(theta), np.sin(theta)

    def to_ras(u_, a_, h_):                            # undo the levelling rotation, then the frame
        return center + u_ * lateral + (c * a_ - s * h_) * anterior + (s * a_ + c * h_) * up

    a_all_r, h_all_r = c * a_all + s * h_all, -s * a_all + c * h_all
    in_body = (a_all_r >= a_back) & (a_all_r <= a_front)
    geometry = {
        "up": -s * anterior + c * up,                  # levelled "up", perpendicular to the endplates
        "anterior": c * anterior + s * up,
        "lateral": lateral,
        "bases": {
            "anterior": to_ras(u0, a_front, b_intercept),
            "middle": to_ras(u0, a_front - 0.5 * depth, b_intercept + 0.5 * b_slope),
            "posterior": to_ras(u0, a_back, b_intercept + b_slope),
        },
        "half_width": float(np.percentile(np.abs(u_all[in_body] - u0), 95)) if in_body.any() else 10.0,
    }

    if debug is not None:
        debug.update(a=a, h=h, a_front=a_front, a_back=a_back)
    return heights, geometry


def _canal_front(a):
    """Front-to-back position where the spinal canal gap begins behind the body."""
    a_bin = np.floor(a / BIN_MM).astype(int)
    bins = np.arange(a_bin.min(), a_bin.max() + 1)
    occupied = np.isin(bins, np.unique(a_bin))
    gap_bins = int(round(CANAL_GAP_MM / BIN_MM))
    back, empty_run = len(bins) - 1, 0
    for k in range(len(bins) - 1, -1, -1):             # walk backwards from the front edge
        if occupied[k]:
            back, empty_run = k, 0
        else:
            empty_run += 1
            if empty_run >= gap_bins:
                break
    return bins[back] * BIN_MM


def _column_heights(u, a, h, voxel_extent):
    """Every (lateral, front-back) column: (front-back position, height, bottom)."""
    cols = np.stack([np.floor(u / BIN_MM), np.floor(a / BIN_MM)], axis=1).astype(int)
    order = np.lexsort((cols[:, 1], cols[:, 0]))
    cols, hs = cols[order], h[order]
    starts = np.flatnonzero(np.r_[True, (np.diff(cols, axis=0) != 0).any(axis=1)])
    col_a = (cols[starts, 1] + 0.5) * BIN_MM
    bottom = np.minimum.reduceat(hs, starts) - voxel_extent / 2
    return col_a, np.maximum.reduceat(hs, starts) - np.minimum.reduceat(hs, starts) + voxel_extent, bottom


def _endplate_tilt(u, a, h, voxel_extent):
    """Angle (radians) of the mean endplate slope, from the central 60% of the body."""
    a_bin = np.floor(a / BIN_MM).astype(int)
    lo, hi = np.percentile(a, [20, 80])
    centers, tops, bottoms = [], [], []
    for b in np.unique(a_bin):
        center = (b + 0.5) * BIN_MM
        if lo <= center <= hi:
            sel = a_bin == b
            centers.append(center)
            tops.append(h[sel].max())
            bottoms.append(h[sel].min())
    if len(centers) < 5:
        return 0.0
    slope = (np.polyfit(centers, tops, 1)[0] + np.polyfit(centers, bottoms, 1)[0]) / 2
    return float(np.arctan(slope))


# Which height each collapse pattern compares, and how its healthy value follows from the
# reference (the median of the patient's other C3–C7 vertebrae): loss = 1 - measured / healthy.
PATTERN_LOCATION = {"wedge": "anterior", "biconcave": "middle", "crush": "posterior"}
MARKER_GAP_MM = 3.0  # keep the marker just clear of the bone surface


def _marker(m, pattern, reference, geometry):
    """Viewer marker for a flagged vertebra: the measured vs healthy height, placed where measured."""
    location = PATTERN_LOCATION[pattern]
    measured = m[location]
    healthy = reference["crush"] if pattern == "crush" else m["posterior"] * reference[pattern]
    base = geometry["bases"][location]
    if location == "anterior":                         # just in front of the front edge
        base = base + MARKER_GAP_MM * geometry["anterior"]
    else:                                              # beside the body, on the patient's left
        base = base - (geometry["half_width"] + MARKER_GAP_MM) * geometry["lateral"]
    return {
        "location": location,
        "measured_mm": round(float(measured), 2),
        "healthy_mm": round(float(healthy), 2),
        "base_ras": [round(float(v), 2) for v in base],
        "up_ras": [round(float(v), 4) for v in geometry["up"]],
    }


def _grade(level, m, shape, reference, geometry=None):
    losses = {k: 1 - shape[k] / reference[k] for k in reference}
    pattern, loss = max(losses.items(), key=lambda kv: kv[1])
    loss = max(loss, 0.0)

    if loss >= SEVERE:
        status, grade = "fracture", "severe (Genant grade 3)"
    elif loss >= FRACTURE:
        status, grade = "fracture", "moderate (Genant grade 2)"
    elif loss >= BORDERLINE:
        status, grade = "borderline", "borderline (Genant grade 1)"
    else:
        status, grade = "normal", None

    return {
        "level": level,
        "name": f"vertebrae_{level}",
        "scope": "assessed",
        "status": status,
        "grade": grade,
        "height_loss": round(loss, 3),
        "pattern": pattern if status != "normal" else None,
        "heights_mm": {k: round(v, 1) for k, v in m.items()},
        "losses": {k: round(v, 3) for k, v in losses.items()},
        "ratios": {"anterior_posterior": round(shape["wedge"], 3), "middle_posterior": round(shape["biconcave"], 3)},
        "reference": {k: round(v, 3) for k, v in reference.items()},
        "marker": _marker(m, pattern, reference, geometry) if status == "fracture" and geometry else None,
    }


def _not_assessed(level, reason, scope="assessed"):
    return {"level": level, "name": f"vertebrae_{level}", "scope": scope,
            "status": "not_assessed", "reason": reason}


def analyze_output_dir(output_dir: str | Path) -> dict:
    """Analyse an existing backend result folder and write fractures.json into it."""
    output_dir = Path(output_dir)
    labels = {int(k): v for k, v in json.loads((output_dir / "labels.json").read_text()).items()}
    report = analyze(nib.load(str(output_dir / "segmentation.nii.gz")), labels)
    (output_dir / "fractures.json").write_text(json.dumps(report, indent=2))
    return report


def summarize(report: dict) -> str:
    parts = []
    for v in report["vertebrae"]:
        if v["scope"] == "excluded":
            continue
        if v["status"] == "not_assessed":
            parts.append(f"{v['level']} not assessed")
        else:
            parts.append(f"{v['level']} {v['status']} ({v['height_loss']:.0%})")
    return "; ".join(parts)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    result = analyze_output_dir(sys.argv[1])
    print(summarize(result))
    print("flagged:", ", ".join(result["flagged"]) or "none")
