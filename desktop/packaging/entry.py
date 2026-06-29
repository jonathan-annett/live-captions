"""Frozen-app entry point. Double-clicking (no args) starts `serve`; otherwise
passes CLI args straight through to the captions CLI."""

import multiprocessing
import sys

from captions_desktop.cli import main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # safe no-op; guards bundled subprocesses
    argv = sys.argv[1:] or ["serve"]
    main(argv)
