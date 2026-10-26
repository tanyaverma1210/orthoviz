# PyInstaller spec: freezes orthoviz-segment into dist/orthoviz-segment/ (onedir).
#   cd backend && .venv/bin/pyinstaller --noconfirm packaging/orthoviz-segment.spec
# onedir rather than onefile: onefile would unpack ~1 GB of torch to a temp dir on every run.

import os

from PyInstaller.utils.hooks import collect_all, collect_data_files, copy_metadata

BACKEND_DIR = os.path.dirname(SPECPATH)  # SPECPATH = this file's folder (packaging/)

datas, binaries, hiddenimports = [], [], []

# Packages that locate code or data at runtime (dynamic trainer/class lookup in nnU-Net,
# resource files in TotalSegmentator), so take them whole rather than by static analysis.
for pkg in ["totalsegmentator", "nnunetv2", "dynamic_network_architectures", "acvl_utils",
            "batchgenerators",
            # Imported via nnU-Net trainer discovery -> timm; its native ops (_C_stable.so)
            # are not picked up by the stock hook, which expects torchvision._C.
            "torchvision"]:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# GDCM (JPEG Lossless and other compressed DICOM): its native libraries are found by import
# analysis; its XML data tables live in the _gdcm package and must be added explicitly.
datas += collect_data_files("_gdcm", includes=["XML/*.xml"])

# importlib.metadata lookups: TotalSegmentator/nnU-Net read their own versions, and
# pydicom checks decoder availability by distribution.
for dist in ["python-gdcm", "TotalSegmentator", "nnunetv2", "pydicom", "nibabel", "torch"]:
    datas += copy_metadata(dist)

a = Analysis(
    [os.path.join(SPECPATH, "entry.py")],
    pathex=[BACKEND_DIR],  # absolute: does not depend on the cwd or how the package was installed
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + ["orthoviz_backend.cli"],
    excludes=["tkinter", "IPython", "jupyter", "notebook", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="orthoviz-segment",
    console=True,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="orthoviz-segment", upx=False)
