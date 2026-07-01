"""Render a downloadable "scan to join" QR PNG for the desktop room.

The browser control panel composes a titled 1920×1080 slide via a <canvas>
(``qrSlidePngBlob`` in ``@captions/display``). Server-side we don't have a
canvas or Pillow, so this writes a large, crisp QR PNG using ``segno`` alone
(pure Python, no Pillow). It's the file the operator can drop into slide gear
in lieu of the live chroma overlay.
"""

from __future__ import annotations

import segno


def write_qr_slide_png(
    url: str,
    path: str,
    *,
    title: str = "Scan to follow live captions",
) -> None:
    """Write a full-frame QR PNG for ``url`` to ``path``.

    A large centered QR on a white background with its own quiet zone. ``title``
    is accepted for API symmetry with the browser slide, but segno cannot render
    text without Pillow, so it is not composited — the QR itself is the payload.
    """
    del title  # segno-only: no text compositing without Pillow
    qr = segno.make(url, error="m")
    # scale=20 + a 4-module quiet zone yields a ~600px+ PNG that scans across a
    # room and prints cleanly; kind="png" is inferred from the .png extension.
    qr.save(path, scale=20, border=4, light="#ffffff", dark="#000000")
