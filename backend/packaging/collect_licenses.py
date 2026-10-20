"""Collect license notices for everything bundled with the frozen backend.

    .venv/bin/python packaging/collect_licenses.py <output dir>

Writes:
    NOTICE.txt                    OrthoViz notice with the TotalSegmentator attribution (design doc §3)
    TotalSegmentator-LICENSE.txt  TotalSegmentator's Apache-2.0 license text
    python-packages.txt           license text of every Python package in the backend's runtime
                                  dependency tree (walked from orthoviz-backend's requirements)
"""

from __future__ import annotations

import re
import sys
from importlib import metadata
from pathlib import Path

ROOT = "orthoviz-backend"
LICENSE_FILE = re.compile(r"(LICEN[CS]E|COPYING|NOTICE|AUTHORS)", re.IGNORECASE)

NOTICE = """\
OrthoViz
========

OrthoViz is a visualization tool, not a diagnostic device.

This application bundles TotalSegmentator, which performs the anatomical segmentation:

    TotalSegmentator {ts_version}
    Copyright Jakob Wasserthal and contributors
    Licensed under the Apache License, Version 2.0 (see TotalSegmentator-LICENSE.txt)
    https://github.com/wasserth/TotalSegmentator

    Wasserthal J., Breit H.-C., Meyer M.T., et al. "TotalSegmentator: Robust Segmentation
    of 104 Anatomic Structures in CT Images." Radiology: Artificial Intelligence, 2023.
    https://doi.org/10.1148/ryai.230024

TotalSegmentator is built on nnU-Net (Apache License 2.0):

    Isensee F., Jaeger P.F., Kohl S.A.A., et al. "nnU-Net: a self-configuring method for
    deep learning-based biomedical image segmentation." Nature Methods, 2021.

The bundled model weights are TotalSegmentator's pretrained "total" task models
(Datasets 291-295), distributed by the TotalSegmentator project.

Licenses of all other bundled Python packages are in python-packages.txt.
The 3D viewer uses three.js (MIT License, see three.js-LICENSE.txt).
The application shell is Electron (MIT License); Electron and Chromium notices ship
alongside the app as LICENSE.electron.txt and LICENSES.chromium.html.
"""


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def runtime_dependencies(root: str) -> list[metadata.Distribution]:
    """Distributions reachable from `root` through non-extra requirements."""
    seen: dict[str, metadata.Distribution] = {}
    stack = [root]
    while stack:
        name = normalize(stack.pop())
        if name in seen:
            continue
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        seen[name] = dist
        for req in dist.requires or []:
            if "extra ==" in req:
                continue
            marker = req.split(";", 1)[1] if ";" in req else ""
            if "sys_platform" in marker and "darwin" not in marker and "!=" not in marker:
                continue
            stack.append(re.split(r"[\s<>=!~;\[(]", req, maxsplit=1)[0])
    seen.pop(normalize(root), None)
    return sorted(seen.values(), key=lambda d: normalize(d.metadata["Name"]))


def license_texts(dist: metadata.Distribution) -> list[tuple[str, str]]:
    texts = []
    for f in dist.files or []:
        if LICENSE_FILE.search(f.name) and ".dist-info" in str(f) or "licenses/" in str(f):
            path = Path(dist.locate_file(f))
            if path.is_file():
                texts.append((f.name, path.read_text(errors="replace")))
    return texts


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    ts = metadata.distribution("TotalSegmentator")
    (out / "NOTICE.txt").write_text(NOTICE.format(ts_version=ts.version))
    ts_license = dict(license_texts(ts)).get("LICENSE")
    if not ts_license:
        sys.exit("TotalSegmentator LICENSE file not found in its dist-info")
    (out / "TotalSegmentator-LICENSE.txt").write_text(ts_license)

    sections, missing = [], []
    for dist in runtime_dependencies(ROOT):
        name, version = dist.metadata["Name"], dist.version
        declared = dist.metadata.get("License-Expression") or dist.metadata.get("License") or ""
        declared = declared if len(declared) < 200 else declared.splitlines()[0]
        header = f"{name} {version}" + (f" — {declared}" if declared else "")
        texts = license_texts(dist)
        if not texts:
            missing.append(name)
        body = "\n\n".join(f"--- {fname} ---\n{text.strip()}" for fname, text in texts) or "(no license file shipped; see the project's homepage)"
        sections.append(f"{'=' * 78}\n{header}\n{'=' * 78}\n{body}\n")

    (out / "python-packages.txt").write_text(
        "Python packages bundled in the OrthoViz backend\n\n" + "\n".join(sections)
    )
    print(f"{len(sections)} packages; {len(missing)} without license files: {', '.join(missing) or '-'}")


if __name__ == "__main__":
    main(sys.argv[1])
