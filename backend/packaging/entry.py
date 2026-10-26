"""Entry point for the frozen (PyInstaller) orthoviz-segment binary."""

import multiprocessing
import sys

if __name__ == "__main__":
    # nnU-Net starts worker processes with "spawn"; in a frozen app those re-run this
    # executable, and freeze_support() routes them to the worker code instead of main().
    multiprocessing.freeze_support()

    from orthoviz_backend.cli import main

    sys.exit(main())
