# Post-production pipeline — implementation plan

The "post-production" tier of the v2 roadmap (decided 2026-07-02 as a **cutover
blocker** — build before promoting v2→apex). Desktop-centric. Sequence: **P1 → P2 → P3**,
then the archive/replay tier consumes the bundles.

## The key finding
The desktop **already captures at 16 kHz** — `sd.InputStream(samplerate=self.sample_rate)`
with `sample_rate=16000` (`streaming.py:133,263-271`). There is **no native-rate audio
anywhere** today. So P1 is not "add a recorder"; it's **invert the capture**: open at the
device's *native* rate and **downsample to 16 kHz for ASR**, making the ASR feed a *tee off*
the native capture (exactly the roadmap wording), so both share one clock.

## Integration points (streaming.py = the whole live path)
- **Tee point** = the sounddevice callback `streaming.py:257-261` (`indata` — PortAudio's
  high-prio thread; no blocking work here).
- **ASR worker** `_run` `streaming.py:289-301` pulls `self._frames` (Queue(256), `:254`),
  runs `EnergyVAD`, decodes at `:386`.
- **Session clock** is a sample counter `_sample_count` (`:320`); seg times = `_utter_start/
  rate`, `_sample_count/rate` (`:383-384`). **Two drift sources vs a wall-continuous file:**
  `_catch_up` drops queued silence but advances the counter (`:315`); the callback drops
  frames on `queue.Full` WITHOUT advancing (`:260-261`).
- **Canonical segments** live in `CaptionHub._finals` (`hub.py:39`), read via `history()`
  (`hub.py:63-66`), upsert-by-id (`hub.py:96-102`). `CaptionSegment` has id/text/start/end/
  words + locked/join_next/keep_repeats.
- **Start/stop** `streaming.py:228/276`, driven from `server.py:167-173`, autostart
  `server.py:56-57`. **Gotcha:** `set_model`/`set_device` (`:196-209,:216-223`) call
  `stop()`+`start()` internally → a naive one-file-per-start shatters a session on every
  model/mic swap. `_sample_count` is NOT reset in `start()`, so the clock stays monotonic
  across a swap.
- **Background-pass pattern to copy** = `RefinementPass` (`refine.py`): daemon thread, bounded
  deque fed via `submit()`, own engine, started/stopped with capture (`streaming.py:251-252,
  285-286`). The recorder writer thread mirrors this.
- **MLX thread-safety**: `_MLX_LOCK` (`engines/mlx.py:22,:119`) serializes Metal decodes.
  Recorder = pure disk I/O, orthogonal. But P2 WhisperX (torch/wav2vec2) is a separate heavy
  path — offline only, never concurrent with a live MLX session.
- **Export today**: `export.py:15-39` `to_srt`/`to_vtt`/`export_transcript` on `join_segments`
  (`render.py:58`), served at `/export` (`server.py:78-85`). TS mirror `packages/protocol/
  src/export.ts`. P2 reuses these.
- **No persistence / no session object today** — hub is in-memory 30-min rolling
  (`hub.py:35,:104-108`). P1 introduces the session bundle + a log dump at stop.
- **Data-dir helper** already exists `window.py:29-36` (per-OS appdata under `CaptionGuru/`) —
  reuse for `CaptionGuru/sessions/`.

## P1 — Hi-fi capture (BUILD FIRST)
1. **Native rate**: in `start()` query `sd.query_devices(device)["default_samplerate"]`, open the
   stream at native; keep `self.sample_rate=16000` as the ASR rate, add `self._capture_rate`.
2. **Downsample tee in the callback** (`:257`): copy native frame → recorder queue; `soxr` (or
   `scipy.resample_poly`) native→16k → `self._frames`. Callback stays non-blocking; downstream
   VAD/utterance logic sees 16k unchanged → **live latency + caption behavior untouched**.
   - *Fallback* (if in-callback resample too costly): a 2nd independent native `InputStream`
     for the recorder only — but two handles on one device fail on many backends + independent
     clocks drift. Prefer the single-stream tee.
   - **Risk-isolation option:** only invert to native+downsample when `--record` is active;
     otherwise keep today's 16k-direct path byte-identical. Decide during build.
3. **`SessionRecorder`** (new `recorder.py`, modeled on `refine.py`): Queue + daemon thread,
   incremental `soundfile.SoundFile(mode="w").write(block)`. Never write from the callback.
4. **Session vs internal restart**: `_internal_restart` flag — `set_model`/`set_device` set it
   around their stop/start so the recording continues seamlessly; mint session id + bundle dir
   + open file only on a *fresh* start, close only on an *operator* stop. Device change may
   change native rate → roll `audio.001.flac` + note in manifest.
5. **Bundle**: `<appdata>/CaptionGuru/sessions/<YYYYMMDD-HHMMSS>-<uuid8>/` with `audio.flac`
   (native, mono, lossless, seekable; WAV fallback) + `session.json` manifest
   `{id,started_at,capture_rate,asr_rate,model,refine_model,device,format}`.
6. **Persist canonical log at stop**: dump `hub.history()` → `segments.json`
   (`model_dump(by_alias=True, exclude_none=True)`, same as `server.py:75`). **This is the
   missing live→post link** that P2/P3 consume.
7. **Disk**: 48k mono float32 ≈690 MB/hr; int16 ≈345; FLAC ≈250-350. Add free-space preflight +
   optional `--record-max-hours`.
8. **CLI**: `serve --record [DIR]` (opt-in, default OFF); wire `cli.py:136,:189-198`.

**Deliverable**: every operator session → `{audio.flac, segments.json, session.json}`, zero
live-latency/behavior change.

## P2 — WhisperX forced alignment (offline)
- New `whisperx` dep (new `postprocess` extra). Post-session only (torch/MPS, not MLX).
- New subcommand `captions postprocess <dir> --align` (2nd subparser by `serve`, `cli.py:20`).
  Load `audio.flac`→16k, `segments.json`; feed WhisperX `align()` the canonical segments as
  `[{start,end,text}]`; map word timings back **by id/order** into `CaptionSegment.words`.
- Align the **operator-corrected** text (respect `locked`) — WhisperX aligns given text to
  audio, don't re-transcribe. Keep mapping keyed on our ids so corrections/`join_next` survive.
- Reuse `export.py` `to_srt`/`to_vtt`; add `to_word_json` (camelCase `CaptionSegment[]`). Write
  `transcript.srt/.vtt/.words.json`.

## P3 — VAD-guided loudness leveling (offline two-pass)
- The VAD/silence timeline is **already in `segments.json`** (each seg start/end = a VAD speech
  chunk; gaps = silence) — same VAD clock as captions. No re-run needed.
- Deps: `pyloudnorm` (BS.1770 LUFS), `soundfile`, `soxr`/numpy; Opus needs libsndfile-Opus or
  an `ffmpeg` shell-out (flag ffmpeg).
- **Pass 1 measure**: per-segment integrated LUFS → `gain_dB = target - measured` (target ≈
  −16 LUFS), clamp max boost (≈+12 dB) so near-silence isn't amplified into noise.
- **Pass 2 apply**: dB gain envelope — hold each seg's gain, **linearly interpolate gain in dB
  across silent gaps** (no jumps), apply, then a **true-peak limiter** (4× oversample, −1 dBTP).
  Write `audio.leveled.flac`/`.opus`.
- CLI: `postprocess <dir> --level --target-lufs -16 --true-peak -1 --max-boost 12`.

## Cross-cutting
- **Deps/extras** (`pyproject.toml:24-45`): P1 → `soundfile`+`soxr` in **`audio`** (or a lean
  `record` extra). P2/P3 → new **`postprocess`** extra (`whisperx`,`pyloudnorm`,…) so the live
  server never installs torch just to caption.
- **TS protocol untouched** — word-JSON is just camelCase `CaptionSegment[]` (alias generator
  already round-trips); **no `PROTOCOL_VERSION` bump** unless we add a live "record on/off" WS
  toggle later.
- **Archive/replay hand-off**: one self-describing bundle dir per session; the archive tier
  uploads it wholesale to object storage; the historical "tap-a-line-to-hear-it" viewer reads
  `words.json` + Opus and reuses the shared `CaptionSegment` schema.

## Riskiest unknowns (most→least)
1. **Timeline agreement**: ASR `_sample_count` clock compresses dropped silence (`:315`) + lags
   on callback drops (`:260`), while the recording is wall-continuous → times may not land on
   the audio. **Make-or-break for P2.** Mitigation: single-stream tee timestamps recorded blocks
   from the *same* counter; validate segs land on speech in `audio.flac`.
2. In-callback resample cost/aliasing on low-end boxes; per-device native rate. `soxr` fast+
   anti-aliased; keep dual-stream fallback.
3. Session vs internal-restart fragmentation (`set_model`/`set_device`) → `_internal_restart`.
4. WhisperX/torch weight on Apple Silicon (MPS wav2vec2, install size); mapping words back to
   locked/edited segs by id.
5. True-peak limiting + Opus toolchain (libsndfile-Opus vs ffmpeg).

## New files
- `desktop/captions_desktop/recorder.py` — P1 `SessionRecorder` (modeled on `refine.py`).
- `desktop/captions_desktop/postprocess.py` — P2/P3 offline alignment + leveling.
