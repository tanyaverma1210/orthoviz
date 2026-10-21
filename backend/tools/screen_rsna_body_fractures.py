"""Find RSNA 2022 patients whose C3-C7 fracture is in the vertebral BODY (in front of the
spinal canal) rather than the arch, rank them, and package the top 3 studies.

Runs as a private Kaggle notebook next to the competition data, so only one results archive
is downloaded (Kaggle has no per-study download, and slice-by-slice downloads hit its rate
limit). Used for neeru004/orthoviz-phase-2-candidate-screening:

    kernel-metadata.json: {"id": "<user>/orthoviz-phase-2-candidate-screening", "code_file": "<this file>",
                           "language": "python", "kernel_type": "script", "is_private": true,
                           "enable_internet": true,
                           "competition_sources": ["rsna-2022-cervical-spine-fracture-detection"]}
    kaggle kernels push -p <folder with this file + kernel-metadata.json>
    kaggle kernels output <user>/orthoviz-phase-2-candidate-screening -p <dir>

Outputs: candidates.csv (all screened patients), summary.json, top10.png (boxed slices for
checking by eye), top3_studies.zip. For a local dry run, set SCREEN_DATA (a folder laid out
like the competition data) and SCREEN_OUT.

Method: on each boxed axial slice, the spinal canal is found as the largest soft-tissue hole
enclosed by bone; the box's share lying in front of the canal's front edge decides
body (>= 0.6) / arch (<= 0.2) / mixed. Body cases are ranked single-level first, then by
fracture size (box extent x area).
"""
import csv, glob, json, os, subprocess, sys, zipfile
from collections import defaultdict

import importlib

import numpy as np

# GDCM must be installed BEFORE pydicom is imported: pydicom decides which decoders are
# available when it loads.
try:
    import gdcm  # noqa: F401  JPEG Lossless decoding
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "python-gdcm"], check=True)
    importlib.invalidate_caches()
    import gdcm  # noqa: F401
try:
    import pydicom
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pydicom"], check=True)
    importlib.invalidate_caches()
    import pydicom

DATA = os.environ.get("SCREEN_DATA") or glob.glob("/kaggle/input/**/train_bounding_boxes.csv", recursive=True)[0].rsplit("/", 1)[0]
OUT = os.environ.get("SCREEN_OUT", "/kaggle/working")
LEVELS = ["C3", "C4", "C5", "C6", "C7"]
from scipy import ndimage

BONE_HU = 200
CANAL_AREA_MM2 = (60, 500)   # cervical canal ~150-300 mm2; vertebral-artery holes are ~20-40
WINDOW_MM = 90


def box_vs_canal(hu, pixel_mm, box):
    """box = (x, y, width, height) in pixels. Returns dict or None if no canal was found."""
    x, y, w, h = box
    cx, cy = x + w / 2, y + h / 2
    half = int(WINDOW_MM / 2 / pixel_mm)
    r0, r1 = max(0, int(cy) - half), min(hu.shape[0], int(cy) + half)
    c0, c1 = max(0, int(cx) - half), min(hu.shape[1], int(cx) + half)
    win = hu[r0:r1, c0:c1]
    bone = ndimage.binary_closing(win > BONE_HU, iterations=1)
    holes = ndimage.binary_fill_holes(bone) & ~bone
    labels, n = ndimage.label(holes)
    best = None
    for i in range(1, n + 1):
        comp = labels == i
        area = comp.sum() * pixel_mm ** 2
        if not CANAL_AREA_MM2[0] <= area <= CANAL_AREA_MM2[1]:
            continue
        if win[comp].mean() > 120:          # marrow inside the body, not canal contents
            continue
        rows, cols = np.nonzero(comp)
        dist = np.hypot(rows.mean() + r0 - cy, cols.mean() + c0 - cx) * pixel_mm
        if best is None or area > best["area_mm2"]:
            best = {"area_mm2": area, "front_row": rows.min() + r0, "center_row": rows.mean() + r0,
                    "center_col": cols.mean() + c0, "dist_mm": dist}
    if best is None:
        return None
    # Share of the box lying in front of the canal's front edge, and the box centre's offset.
    rows_in_front = np.clip(best["front_row"] - y, 0, h)
    return {
        "front_fraction": float(rows_in_front / h),
        "center_offset_mm": float((best["front_row"] - cy) * pixel_mm),  # + = box centre in front of canal
        "canal_area_mm2": float(best["area_mm2"]),
    }


def load_hu(path):
    d = pydicom.dcmread(path)
    return d.pixel_array * float(getattr(d, "RescaleSlope", 1)) + float(getattr(d, "RescaleIntercept", 0)), float(d.PixelSpacing[0]), d


def slice_spacing(study_dir):
    # Slice numbering doesn't always start at 1: use the first two files that exist.
    first_two = sorted(glob.glob(f"{study_dir}/*.dcm"), key=lambda p: int(os.path.basename(p)[:-4]))[:2]
    a, b = (pydicom.dcmread(p, stop_before_pixels=True) for p in first_two)
    return abs(float(a.ImagePositionPatient[2]) - float(b.ImagePositionPatient[2])) or float(getattr(a, "SliceThickness", 1))


rows = list(csv.DictReader(open(f"{DATA}/train.csv")))
cand = {r["StudyInstanceUID"]: [l for l in LEVELS if r[l] == "1"] for r in rows
        if r["patient_overall"] == "1" and r["C1"] == "0" and r["C2"] == "0" and any(r[l] == "1" for l in LEVELS)}
boxes = defaultdict(list)
for b in csv.DictReader(open(f"{DATA}/train_bounding_boxes.csv")):
    if b["StudyInstanceUID"] in cand:
        boxes[b["StudyInstanceUID"]].append(b)
print(f"{len(cand)} C3-C7-only fracture patients, {len(boxes)} with boxes", flush=True)

# Fail fast if compressed slices can't be decoded (instead of screening 142 studies with errors).
_uid, _bs = next(iter(sorted(boxes.items())))
load_hu(f"{DATA}/train_images/{_uid}/{int(_bs[0]['slice_number'])}.dcm")
print("decoding OK", flush=True)

results = []
for i, (uid, bs) in enumerate(sorted(boxes.items())):
    study_dir = f"{DATA}/train_images/{uid}"
    fracs, offsets, areas = [], [], []
    for b in bs:
        n = int(b["slice_number"])
        box = tuple(float(b[k]) for k in ("x", "y", "width", "height"))
        try:
            hu, ps, _ = load_hu(f"{study_dir}/{n}.dcm")
        except Exception as e:
            print(uid, n, "read error", e, flush=True)
            continue
        areas.append(box[2] * box[3] * ps * ps)
        r = box_vs_canal(hu, ps, box)
        for dn in (1, -1, 2, -2, 3, -3):          # ring open at this level: use a neighbouring slice
            if r is not None:
                break
            p = f"{study_dir}/{n + dn}.dcm"
            if os.path.exists(p):
                r = box_vs_canal(load_hu(p)[0], ps, box)
        if r is not None:
            fracs.append(r["front_fraction"])
            offsets.append(r["center_offset_mm"])
    if not areas:
        continue
    sp = slice_spacing(study_dir)
    front = float(np.median(fracs)) if fracs else None
    results.append({
        "uid": uid, "levels": "+".join(cand[uid]), "single_level": len(cand[uid]) == 1,
        "box_slices": len(bs), "extent_mm": round(len(bs) * sp, 1), "mean_box_area_mm2": round(float(np.mean(areas)), 1),
        "slices_with_canal": len(fracs), "front_fraction": None if front is None else round(front, 2),
        "center_offset_mm": None if not offsets else round(float(np.median(offsets)), 1),
        "location": "unknown" if front is None else "body" if front >= 0.6 else "arch" if front <= 0.2 else "mixed",
        "n_slices": len(glob.glob(f"{study_dir}/*.dcm")),
    })
    if i % 20 == 0:
        print(f"{i}/{len(boxes)} screened", flush=True)

# Rank body cases: single level first, then bigger fracture (extent x box area), then how far in front.
body = [r for r in results if r["location"] == "body"]
body.sort(key=lambda r: (r["single_level"], r["extent_mm"] * r["mean_box_area_mm2"], r["front_fraction"]), reverse=True)
for rank, r in enumerate(body, 1):
    r["rank"] = rank

with open(f"{OUT}/candidates.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(results[0].keys()) + ["rank"])
    w.writeheader()
    for r in sorted(results, key=lambda r: r.get("rank", 10**6)):
        w.writerow(r)

summary = {"candidates": len(cand), "with_boxes": len(boxes), "screened": len(results),
           "by_location": {k: sum(r["location"] == k for r in results) for k in ("body", "mixed", "arch", "unknown")},
           "top": body[:10]}
json.dump(summary, open(f"{OUT}/summary.json", "w"), indent=2)
print(json.dumps(summary["by_location"]), flush=True)

# Pictures of the top 10 for checking by eye: middle box slice, box in red, canal edge line in cyan.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
top = body[:10]
if top:
    fig, axes = plt.subplots(2, 5, figsize=(25, 10))
    for ax, r in zip(axes.flat, top):
        bs = sorted(boxes[r["uid"]], key=lambda b: int(b["slice_number"]))
        b = bs[len(bs) // 2]
        hu, ps, _ = load_hu(f"{DATA}/train_images/{r['uid']}/{int(b['slice_number'])}.dcm")
        x, y, w, h = (float(b[k]) for k in ("x", "y", "width", "height"))
        ax.imshow(np.clip(hu, -200, 1200), cmap="gray")
        ax.add_patch(plt.Rectangle((x, y), w, h, fill=False, color="red", lw=1.5))
        ax.set_xlim(x - 60, x + w + 60); ax.set_ylim(y + h + 80, y - 60)
        ax.set_title(f"#{r['rank']} {r['uid'].split('.')[-1]} {r['levels']} front {r['front_fraction']}\n"
                     f"extent {r['extent_mm']} mm, box {r['mean_box_area_mm2']:.0f} mm2", fontsize=10)
        ax.axis("off")
    fig.tight_layout()
    fig.savefig(f"{OUT}/top10.png", dpi=70)

# Package the top 3 studies' images into one archive.
with zipfile.ZipFile(f"{OUT}/top3_studies.zip", "w", zipfile.ZIP_STORED) as z:
    for r in body[:3]:
        for p in glob.glob(f"{DATA}/train_images/{r['uid']}/*.dcm"):
            z.write(p, f"{r['uid']}/{os.path.basename(p)}")
print("done; top 3:", [(r["uid"], r["levels"]) for r in body[:3]], flush=True)
