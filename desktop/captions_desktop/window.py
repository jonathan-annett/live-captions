"""Display output: a fullscreen pywebview window (primary HDMI path) with a
Chrome-kiosk fallback. All GUI imports are lazy so the server and tests install
and run without pywebview.

The window just renders the display page; the *background* (solid / chroma /
transparent) is painted by the page from the pushed DisplayConfig, so feeding a
switcher over HDMI vs keying is a config choice, not a code change.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional


def _webview_storage_dir() -> str:
    """A stable per-user dir so the native WebKit windows PERSIST localStorage
    (the operator's look / model / mic / QR prefs) across restarts.

    pywebview defaults to ``private_mode=True`` — an ephemeral WebKit data store
    that is wiped when the window closes, so every launch snapped those prefs back
    to defaults. Pointing ``storage_path`` at a stable dir (with private mode off)
    keeps them."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    d = base / "CaptionGuru" / "webview"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


# ---------------------------------------------------------------------------
# Monitors
# ---------------------------------------------------------------------------


def list_screens() -> list[dict]:
    """Return available monitors as dicts, or [] if pywebview is unavailable."""
    try:
        import webview
    except Exception:
        return []
    screens = []
    for i, s in enumerate(webview.screens):
        screens.append(
            {
                "index": i,
                "width": getattr(s, "width", None),
                "height": getattr(s, "height", None),
                "x": getattr(s, "x", None),
                "y": getattr(s, "y", None),
            }
        )
    return screens


# ---------------------------------------------------------------------------
# pywebview (primary)
# ---------------------------------------------------------------------------


def run_webview(
    url: str,
    *,
    fullscreen: bool = True,
    monitor: int = 0,
    transparent: bool = False,
    title: str = "Live Captions",
    control_url: Optional[str] = None,
    devtools: bool = False,
) -> None:
    """Open the display fullscreen on the chosen monitor. Blocks until all windows
    close. If ``control_url`` is given, also open the operator control panel in a
    second framed, resizable window (turnkey — no separate browser needed).
    ``devtools`` enables the WebKit inspector (right-click → Inspect Element).

    All windows must be created before ``webview.start()`` (it owns the main thread,
    esp. on macOS), so the control window can't be toggled at runtime — it's a
    launch-time choice.
    """
    import webview

    kwargs: dict = {
        "fullscreen": fullscreen,
        "frameless": fullscreen,
        "background_color": "#000000",
    }
    if transparent:
        kwargs["transparent"] = True
    screens = webview.screens
    if 0 <= monitor < len(screens):
        kwargs["screen"] = screens[monitor]

    webview.create_window(title, url, **kwargs)
    if control_url:
        webview.create_window(
            "Caption Guru — Control",
            control_url,
            width=1100,
            height=820,
            min_size=(720, 560),
        )
    # private_mode=False + a stable storage_path so the panel's localStorage
    # prefs (look / model / mic / QR) survive a restart — the default private
    # mode wiped them every launch.
    webview.start(debug=devtools, private_mode=False, storage_path=_webview_storage_dir())


def webview_available() -> bool:
    try:
        import webview  # noqa: F401

        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Chrome kiosk (fallback)
# ---------------------------------------------------------------------------

_CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
]


def find_chrome() -> Optional[str]:
    for c in _CHROME_CANDIDATES:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
        found = shutil.which(c)
        if found:
            return found
    return None


def chrome_kiosk_args(
    chrome: str,
    url: str,
    position: Optional[tuple[int, int]] = None,
    user_data_dir: Optional[str] = None,
) -> list[str]:
    """Build the Chrome command line for a borderless fullscreen caption output."""
    args = [
        chrome,
        f"--app={url}",
        "--kiosk",
        "--start-fullscreen",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-translate",
        "--autoplay-policy=no-user-gesture-required",
    ]
    if user_data_dir:
        args.append(f"--user-data-dir={user_data_dir}")
    if position is not None:
        args.append(f"--window-position={position[0]},{position[1]}")
    return args


def launch_chrome_kiosk(url: str, monitor: int = 0) -> Optional[subprocess.Popen]:
    chrome = find_chrome()
    if not chrome:
        return None
    position = None
    screens = list_screens()
    if 0 <= monitor < len(screens):
        s = screens[monitor]
        if s["x"] is not None and s["y"] is not None:
            position = (int(s["x"]), int(s["y"]))
    user_data_dir = tempfile.mkdtemp(prefix="caption-guru-kiosk-")
    args = chrome_kiosk_args(chrome, url, position=position, user_data_dir=user_data_dir)
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
