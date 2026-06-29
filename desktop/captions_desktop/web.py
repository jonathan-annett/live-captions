"""Locate the built shared frontend (@captions/display dist) to serve."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional


def find_web_dir(override: Optional[str] = None) -> Optional[Path]:
    here = Path(__file__).resolve().parent
    # PyInstaller unpacks bundled data under sys._MEIPASS.
    meipass = getattr(sys, "_MEIPASS", None)
    candidates = [
        Path(override) if override else None,
        Path(meipass) / "web" if meipass else None,  # frozen bundle
        here / "web",  # bundled alongside the package
        here.parents[1] / "packages" / "display" / "dist",  # monorepo dev
    ]
    for c in candidates:
        if c and c.is_dir() and (c / "index.html").exists():
            return c
    return None
