"""Locate the built shared frontend (@captions/display dist) to serve."""

from __future__ import annotations

from pathlib import Path
from typing import Optional


def find_web_dir(override: Optional[str] = None) -> Optional[Path]:
    here = Path(__file__).resolve().parent
    candidates = [
        Path(override) if override else None,
        here / "web",  # bundled by PyInstaller (M8)
        here.parents[1] / "packages" / "display" / "dist",  # monorepo dev
    ]
    for c in candidates:
        if c and c.is_dir() and (c / "index.html").exists():
            return c
    return None
