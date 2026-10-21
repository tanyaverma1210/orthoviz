import nibabel as nib
import numpy as np
import pytest

from orthoviz_backend.fracture import analyze

LEVELS = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "T1"]
LABELS = {10 + i: f"vertebrae_{lv}" for i, lv in enumerate(LEVELS)}
VALUE = {lv: v for v, lv in ((v, n.removeprefix("vertebrae_")) for v, n in LABELS.items())}

# Synthetic spine at 0.5 mm voxels. Axes: x = left-right, y = front-back (+ = anterior),
# z = up. Each vertebra: a box-shaped body (16 mm deep, 16 wide, 12 tall) in front, an
# 8 mm spinal canal gap, then an arch block behind it. 4 mm discs between vertebrae.
VOX = 0.5
BODY_H, DISC = 12.0, 4.0


def mm(v):
    return int(round(v / VOX))


def make_spine(body_heights=None, wedge=None, top_cut_mm=None, tilt_deg=0.0):
    """Label volume plus RAS affine. `wedge` = {level: anterior height}; `top_cut_mm` crops the top."""
    body_heights = body_heights or {}
    wedge = wedge or {}
    nz = mm(len(LEVELS) * (BODY_H + DISC) + 10)
    data = np.zeros((mm(40), mm(60), nz), dtype=np.uint8)
    x0, x1 = mm(12), mm(28)                       # body width 16 mm, centred
    body_front, body_back = mm(50), mm(34)        # body depth 16 mm
    arch_front, arch_back = mm(26), mm(14)        # arch behind an 8 mm canal
    z = mm(5)
    for level in reversed(LEVELS):                # build bottom (T1) to top (C1)
        hp = body_heights.get(level, BODY_H)
        ha = wedge.get(level, hp)
        for y in range(body_back, body_front):
            frac = (y - body_back) / (body_front - body_back)   # 0 at back, 1 at front
            height = hp + (ha - hp) * frac
            data[x0:x1, y, z:z + mm(height)] = VALUE[level]
        data[mm(17):mm(23), arch_back:arch_front, z + mm(2):z + mm(BODY_H - 2)] = VALUE[level]
        z += mm(max(hp, BODY_H) + DISC)
    if top_cut_mm is not None:
        data = data[:, :, :mm(top_cut_mm)]

    affine = np.diag([VOX, VOX, VOX, 1.0])
    if tilt_deg:                                  # tip the whole neck forward (flexion)
        t = np.radians(tilt_deg)
        rot = np.array([[1, 0, 0], [0, np.cos(t), -np.sin(t)], [0, np.sin(t), np.cos(t)]])
        affine[:3, :3] = rot @ affine[:3, :3]
    return nib.Nifti1Image(data, affine)


def by_level(report):
    return {v["level"]: v for v in report["vertebrae"]}


def test_healthy_spine_flags_nothing_and_excludes_c1_c2():
    report = analyze(make_spine(), LABELS)
    v = by_level(report)
    assert report["flagged"] == []
    assert [v[lv]["status"] for lv in ["C3", "C4", "C5", "C6", "C7"]] == ["normal"] * 5
    for lv in ["C1", "C2"]:
        assert v[lv]["status"] == "not_assessed" and v[lv]["scope"] == "excluded"
    assert v["C4"]["heights_mm"]["posterior"] == pytest.approx(BODY_H, abs=1.0)


def test_wedge_fracture_is_flagged():
    report = analyze(make_spine(wedge={"C5": 6.5}), LABELS)   # front collapsed to ~half
    c5 = by_level(report)["C5"]
    assert report["flagged"] == ["C5"]
    assert c5["pattern"] == "wedge" and c5["height_loss"] >= 0.40 and "severe" in c5["grade"]


def test_crush_fracture_is_flagged_against_neighbours():
    report = analyze(make_spine(body_heights={"C6": 8.5}), LABELS)  # whole body ~30% lower
    c6 = by_level(report)["C6"]
    assert report["flagged"] == ["C6"]
    assert c6["pattern"] == "crush" and 0.25 <= c6["height_loss"] < 0.40 and "moderate" in c6["grade"]


def test_mild_change_is_borderline_not_flagged():
    report = analyze(make_spine(wedge={"C4": 9.4}), LABELS)  # ~22% anterior loss
    assert report["flagged"] == []
    assert by_level(report)["C4"]["status"] == "borderline"


def test_vertebra_cut_off_by_the_scan_is_not_assessed():
    # Crop just above the bottom of C6's body region so C6 touches the scan edge... from below:
    full = make_spine()
    data = np.asarray(full.dataobj)
    c7_top = np.argwhere(data == VALUE["C7"])[:, 2].max()
    cropped = nib.Nifti1Image(data[:, :, c7_top - mm(4):], full.affine)  # cut through C7
    v = by_level(analyze(cropped, LABELS))
    assert v["C7"]["status"] == "not_assessed" and "partly" in v["C7"]["reason"]
    assert v["C5"]["status"] == "normal"


def test_tilted_neck_does_not_create_false_positives():
    report = analyze(make_spine(tilt_deg=20), LABELS)
    assert report["flagged"] == []
