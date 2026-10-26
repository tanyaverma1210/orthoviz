"""Download one RSNA 2022 Cervical Spine Fracture Detection study from Kaggle, slice by slice.

The full dataset is hundreds of GB; this fetches just train_images/<study>/1.dcm, 2.dcm, ...
until the slices run out. Requires a Kaggle account that has accepted the competition rules,
with credentials in ~/.kaggle/, and the kaggle package (not a backend dependency):

    uv venv /tmp/kaggle-venv && uv pip install --python /tmp/kaggle-venv kaggle
    /tmp/kaggle-venv/bin/python tools/fetch_rsna_study.py 1.2.826.0.1.3680043.1363 ../dicom_samples/patient_fracture2

Kaggle rate-limits downloads (HTTP 429) after several hundred files; the script waits and
retries, so a large study can take a while.
"""
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from kaggle.api.kaggle_api_extended import KaggleApi

COMPETITION = "rsna-2022-cervical-spine-fracture-detection"
BATCH = 48


def fetch(api, study, dest, n):
    """Download slice n; True if it is now on disk. Waits out rate limiting (HTTP 429)."""
    target = dest / f"{n}.dcm"
    for _ in range(60):
        if target.exists():
            return True
        try:
            api.competition_download_file(COMPETITION, f"train_images/{study}/{n}.dcm", path=str(dest), quiet=True)
        except Exception as e:  # the Kaggle client raises plain HTTP errors
            if "429" not in str(e):
                return False  # e.g. 404: no such slice
            time.sleep(60)
    return target.exists()


def main(study, dest):
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    api = KaggleApi()
    api.authenticate()
    start = 1
    with ThreadPoolExecutor(2) as pool:
        while True:
            ok = list(pool.map(lambda n: fetch(api, study, dest, n), range(start, start + BATCH)))
            print(f"slices {start}-{start + BATCH - 1}: {sum(ok)} downloaded", flush=True)
            if not all(ok):
                first_missing = ok.index(False)
                if any(ok[first_missing:]):
                    sys.exit(f"gap at slice {start + first_missing} but later slices exist: incomplete download")
                break
            start += BATCH
    print("total files:", len(list(dest.glob("*.dcm"))))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
