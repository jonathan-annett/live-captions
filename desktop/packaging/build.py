"""Build the desktop bundle and zip it for release.

Runs PyInstaller against captions.spec, then zips the one-folder bundle into
dist/caption-guru-<target>.zip. Used locally and by the release CI matrix.

The frontend must already be built (pnpm --filter @captions/display build).
"""

from __future__ import annotations

import argparse
import platform
import subprocess
import sys
from pathlib import Path

DESKTOP = Path(__file__).resolve().parents[1]
BUNDLE_PARENT = DESKTOP / "dist" / "bundle"
BUNDLE = BUNDLE_PARENT / "caption-guru"


def detect_target() -> str:
    system = platform.system().lower()
    mach = platform.machine().lower()
    if system == "windows":
        return "windows-x64"
    if system == "darwin":
        return "macos-arm64" if mach in ("arm64", "aarch64") else "macos-intel"
    return "linux-x64"


def build() -> None:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "packaging/captions.spec",
            "--distpath",
            "dist/bundle",
            "--workpath",
            "dist/build",
            "--noconfirm",
        ],
        cwd=DESKTOP,
        check=True,
    )


def zip_bundle(target: str) -> Path:
    out = DESKTOP / "dist" / f"caption-guru-{target}.zip"
    if out.exists():
        out.unlink()
    if platform.system() == "Windows":
        # Compress-Archive preserves the (irrelevant) perms fine on Windows.
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"Compress-Archive -Path '{BUNDLE}' -DestinationPath '{out}' -Force",
            ],
            check=True,
        )
    else:
        # `zip -y` keeps symlinks (mac frameworks) and the executable bit, which
        # Python's zipfile would flatten/strip.
        subprocess.run(
            ["zip", "-r", "-y", "-q", str(out), "caption-guru"],
            cwd=BUNDLE_PARENT,
            check=True,
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=None, help="override target tag")
    ap.add_argument("--skip-build", action="store_true", help="zip an existing bundle")
    args = ap.parse_args()

    target = args.target or detect_target()
    if not args.skip_build:
        build()
    if not BUNDLE.is_dir():
        raise SystemExit(f"bundle not found at {BUNDLE}")
    out = zip_bundle(target)
    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"wrote {out} ({size_mb:.0f} MB)")


if __name__ == "__main__":
    main()
