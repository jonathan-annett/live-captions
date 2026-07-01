# Test plan — QR overlay redesign, runtime rooms, OBS link, mic picker

Covers the work landed on `v2-audience-layer` (protocol **v8** QR redesign + desktop
runtime room controls; **v9** audio-device picker + live mic hot-swap; the Copy-OBS-link
buttons). Two surfaces: the **PWA** (v2.caption.guru) and the **desktop app** (`/control`).

Audio for both: select **BlackHole 2ch** as the input and play a podcast through it
(a Multi-Output Device lets you also hear it).

---

## A. Desktop app

### Launch (idle, room controls enabled)
```bash
cd desktop && .venv/bin/python -m captions_desktop.cli serve \
  --viewer-base https://v2.caption.guru \
  --qr-png-path /tmp/caption-qr.png \
  --no-refine
```
- `--viewer-base` lets the panel **mint a cloud room at runtime** (starts idle — no room yet).
- `--qr-png-path` exercises the direct PNG-file write.
- `--no-refine` suits an 8 GB / single-GPU box (avoids live+refine GPU contention).
- Open `http://127.0.0.1:8765/control` and the native display window.

### A1. Mic picker + hot-swap (v9)
1. `--list-devices` sanity (separate quick run): `… cli serve --list-devices` prints the
   input device table (should show BlackHole at its index).
2. In `/control` → **Model** section → **Microphone** dropdown is populated.
3. Start captioning; while running, **switch the mic** in the dropdown → capture moves to
   the new device **without an engine reload** (no "loading" gap; captions continue).
4. "System default" option works.

### A2. Runtime room controls (v8 — the audit gap)
5. **Start room** → join URL appears, native display shows the **QR overlay**, captions
   relay to the cloud room.
6. Open the join URL on a phone → audience viewer shows live captions + history catch-up.
7. **Stop room** → QR overlay disappears; phone stops getting new finals.
8. **Restart room** → the **same** room reopens (phone that kept the link resumes).
9. New Start after a Stop → a **new** id supersedes.

### A3. QR overlay redesign (v8) on the native display
10. Toggle **Show join QR** off/on → overlay hides/shows.
11. **X/Y/Size** live-move/resize the overlay; try **solid** and **transparent** backgrounds
    (not just chroma — the whole point of the redesign).
12. Edit **QR label** → text beside the QR updates.
13. Toggle **Exclusive** → caption lines **hide** while the QR shows; untoggle → they return.

### A4. QR PNG + OBS link
14. **Download QR slide (PNG)** → saves a scannable slide.
15. **Copy OBS link** (new) → clipboard gets `…/display.html?source=room&room=<id>`;
    paste into a browser / OBS Browser Source → the on-air display renders (captions + look + QR).
16. `--qr-png-path`: after Start room, `/tmp/caption-qr.png` exists + scans to the join URL;
    **Restart / new Start rewrites the same file** (`ls -la /tmp/caption-qr.png` timestamp bumps).

### A5. Regression (pre-existing)
17. Look controls (bg/box/font/color), dictionary add, click-correction upsert — all still work.

---

## B. PWA (v2.caption.guru)

Open `https://v2.caption.guru/`, pick mic + model.

### B1. Mic hot-swap (v9)
1. Start captioning; while running, change the **Microphone** dropdown (no longer disabled) →
   input switches live, WebGPU model stays warm (no reload), captions continue.

### B2. QR overlay controls (v8)
2. **Start room**. In the room panel: toggle **enabled**, edit **label**, set **X/Y/Size**,
   toggle **Exclusive**. Watch the on-air display (open `display.html?source=room&room=<id>`
   in another tab/OBS) reflect each change; exclusive hides captions.
3. Prefs persist across reload (`cg.qr`).

### B3. Persistent QR PNG file (Chromium only)
4. **Set persistent PNG file…** → pick a file. Start / Restart a room → the file is **rewritten**
   on disk each time (point OBS/PowerPoint at it → auto-refresh). Firefox/Safari: the button is
   hidden with a note; the manual **Download QR slide (PNG)** still works.

### B4. Copy OBS link + web→OBS
5. **Copy OBS link** → clipboard gets `…/display.html?source=room&room=<id>`.
6. In **OBS**, add a Browser Source with that URL (1920×1080) → live captions render with the
   operator's look + QR overlay. History replays if OBS connects late.
7. For a clean key: set background **transparent** (OBS honors alpha) or **chroma** + a Color Key filter.

---

## Watch-outs
- **Start room no-ops on desktop** → you omitted `--viewer-base` (no base to mint against).
- **Captions lag on desktop** → confirm `--no-refine` (single-GPU can't run live + heavy refine).
- **B/A2/A4 need network** — room minting POSTs to `v2.caption.guru/r/new`.
- Use `display.html?source=room&room=…` for OBS — **not** `/room?<id>` (that's the phone viewer).
- A mic that briefly grabs an exclusive hardware lock may hiccup one frame on hot-swap (expected).
