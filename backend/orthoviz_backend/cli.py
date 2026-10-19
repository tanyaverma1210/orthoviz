"""Command-line entry point: orthoviz-segment <dicom_folder> <output_dir>"""

from __future__ import annotations

import argparse
import logging
import sys

from .dicom_loader import DicomLoadError
from .pipeline import process_scan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Segment a CT scan (folder of DICOM files) with TotalSegmentator.")
    parser.add_argument("dicom_folder", help="Folder containing one patient's CT DICOM files")
    parser.add_argument("output_dir", help="Folder to write ct.nii.gz, segmentation.nii.gz and metadata into")
    parser.add_argument("--device", default="auto", choices=["auto", "mps", "gpu", "cpu"],
                        help="Compute device for TotalSegmentator (default: auto = mps > gpu > cpu)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    try:
        info = process_scan(args.dicom_folder, args.output_dir, device=args.device)
    except DicomLoadError as e:
        logging.error("Could not load DICOM folder: %s", e)
        return 2

    print(f"Done. Segmentation written to {args.output_dir} "
          f"(segmentation took {info['timing_seconds']['segmentation']} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
