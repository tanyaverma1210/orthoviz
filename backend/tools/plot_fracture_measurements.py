"""Plot what the fracture check measured: the midline slice of each vertebra C3-C7, aligned to
its endplates, with the detected body edges (blue) and measurement zones shaded.

    .venv/bin/python tools/plot_fracture_measurements.py <output dir> <picture.png>

A development aid for checking measurements by eye; not part of the app.
"""
import json, sys
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib, numpy as np
from orthoviz_backend import fracture as F

out, png = sys.argv[1], sys.argv[2]
seg = nib.load(f"{out}/segmentation.nii.gz"); data = np.asarray(seg.dataobj)
labels = {int(k): v for k, v in json.load(open(f"{out}/labels.json")).items()}
by_level = {n.removeprefix("vertebrae_"): v for v, n in labels.items() if n.startswith("vertebrae_")}
cent = {lv: F._to_world(seg.affine, np.argwhere(data == v).mean(0))[0] for lv, v in by_level.items() if lv in F.SPINE_ORDER}
report = F.analyze(seg, labels)
fig, axes = plt.subplots(1, 5, figsize=(22, 5))
for ax, lv in zip(axes, F.ASSESSED_LEVELS):
    idx = np.argwhere(data == by_level[lv])
    dbg = {}
    try:
        F._measure(lv, idx, seg.affine, cent, debug=dbg)
        ax.scatter(dbg["a"], dbg["h"], s=0.3, c="k")
        for edge in (dbg["a_front"], dbg["a_back"]): ax.axvline(edge, c="b", lw=0.8)
        d = dbg["a_front"] - dbg["a_back"]
        for (f0, f1), col in ((F.PROFILE_FIT, "y"), (F.MIDDLE_ZONE, "g")):
            ax.axvspan(dbg["a_front"] - f1 * d, dbg["a_front"] - f0 * d, color=col, alpha=0.15)
    except F.MeasurementError as e:
        ax.text(0.1, 0.5, str(e), transform=ax.transAxes, fontsize=8)
    r = next(v for v in report["vertebrae"] if v["level"] == lv)
    title = f"{lv}: {r['status']}"
    if "heights_mm" in r:
        H = r["heights_mm"]; title += f" loss {r['height_loss']:.0%} ({r['pattern']})\nHa {H['anterior']} Hm {H['middle']} Hp {H['posterior']} depth {H['depth']}"
    ax.set_title(title, fontsize=9); ax.set_xlabel("anterior →  (mm)"); ax.set_aspect("equal"); ax.invert_xaxis()
fig.tight_layout(); fig.savefig(png, dpi=80)
