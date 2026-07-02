"""Per-user application-data directories (session recordings, webview storage…).

One place for the per-OS base so recordings, the webview data store, etc. all
live under a single ``CaptionGuru/`` app dir.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def app_data_base() -> Path:
    """The per-OS user application-data base (NOT created)."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def app_data_dir(*parts: str) -> Path:
    """A stable per-user dir under ``<base>/CaptionGuru/<parts…>``, created."""
    d = app_data_base().joinpath("CaptionGuru", *parts)
    d.mkdir(parents=True, exist_ok=True)
    return d


def sessions_dir() -> Path:
    """Where hi-fi session recordings (post-production bundles) are written."""
    return app_data_dir("sessions")
