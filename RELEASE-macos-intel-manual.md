# Manual release: macOS Intel

The macOS Intel bundle is built by `.github/workflows/release-intel.yml` on a
`macos-13` (Intel) runner. Those runners are **scarce / being deprecated** — a
run can sit queued for a day (the `v0.1.0-intel` build stalled ~22 h waiting for
a worker). This runbook reproduces that job **by hand on a real Intel Mac** and
publishes the artifact to the same release. Everything here mirrors the CI job
exactly, so the output is byte-for-byte equivalent to what the runner would make.

> **You must run this on an actual Intel (x86_64) Mac.** Building on Apple Silicon
> produces an `arm64` bundle (the wrong target). The macOS Intel target is exactly
> what the i9 MacBook is for.

## 0. Prerequisites (one-time)

- **An Intel Mac.** Verify:
  ```bash
  python3 -c "import platform; print(platform.machine())"   # must print: x86_64
  ```
- **Python 3.12** — *not* 3.13/3.14 (this project's native deps have no wheels for
  newer Pythons). `python3.12 --version` should work; install via Homebrew if
  missing: `brew install python@3.12`.
- **Node 20 + pnpm via corepack**: `corepack enable` (Node 20 recommended).
- **`zip`** (system default is fine — it preserves symlinks/exec bit; do **not**
  zip via Finder).
- **GitHub CLI authed with repo write**: `gh auth status` (needs push/`contents:write`
  on `jonathan-annett/caption-guru`).

## 1. Get the exact source for the release

Check out the **same commit/tag** the release is cut from (currently `v0.1.0`;
the Intel artifact ships under the sibling tag `v0.1.0-intel`):

```bash
git clone https://github.com/jonathan-annett/caption-guru.git
cd caption-guru
git checkout v0.1.0        # or the tag/commit being released
```

## 2. Build the shared frontend

The desktop app bundles the built display frontend as `web/`. Build it first:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @captions/display build
```

This must produce `packages/display/dist/` — the spec **hard-fails** if it's missing.

## 3. Create a Python 3.12 env and install desktop + packaging deps

```bash
python3.12 -m venv .venv-intel
source .venv-intel/bin/activate
python -m pip install --upgrade pip
python -m pip install -e "./desktop[server,audio,asr,desktop,package]"
```

**Extras note:** `server,audio,asr,desktop,package` — the **same set the CI uses for
Intel**. Do **not** add `mlx` (Apple-Silicon only; there is no MLX on Intel).

## 4. Build the bundle + zip

```bash
python desktop/packaging/build.py
```

- On an Intel Mac, `build.py` auto-detects the target as `macos-intel`
  (`--target macos-intel` if you want to be explicit).
- It runs PyInstaller against `desktop/packaging/captions.spec` (a one-folder
  bundle; `torch` is intentionally excluded — `mlx-whisper` declares it but never
  loads it for transcription, saving ~2 GB), then zips with `zip -r -y` to keep
  mac framework symlinks + the executable bit.
- Output: **`desktop/dist/caption-guru-macos-intel.zip`** (it prints the path + size).

## 5. Smoke-test the bundle before publishing

```bash
cd desktop/dist
rm -rf _smoke && mkdir _smoke && cd _smoke
unzip -q ../caption-guru-macos-intel.zip
./caption-guru/caption-guru --help
./caption-guru/caption-guru serve --list-devices   # should list Core Audio inputs
cd ../../..
```

If it launches and lists devices, the bundle is good. (It's **unsigned /
unnotarized**, like the other Mac builds — Gatekeeper will quarantine it; see the
note below. That's expected and not a build failure.)

## 6. Publish to the `-intel` release

The Intel artifact lives on its **own release** (`vX.Y.Z-intel`), separate from the
main multi-platform release. Upload the zip, creating the release if it doesn't
exist yet:

```bash
TAG=v0.2.0-beta-intel   # match the version being released (e.g. v0.2.0-beta → -intel)

# If the release doesn't exist yet:
gh release create "$TAG" \
  --title "$TAG (macOS Intel)" \
  --notes "macOS Intel bundle, built manually (macos-13 runners deprecated). See RELEASE-macos-intel-manual.md." \
  desktop/dist/caption-guru-macos-intel.zip

# If the release already exists (or to replace a partial upload):
gh release upload "$TAG" desktop/dist/caption-guru-macos-intel.zip --clobber
```

Then confirm the asset is attached: `gh release view "$TAG"`.

If the stalled CI run is still queued, cancel it so it doesn't later overwrite the
manual artifact:
```bash
gh run list --workflow release-intel.yml --limit 5
gh run cancel <run-id>
```

## Gotchas / notes

- **Wrong arch is the #1 failure.** Re-check `platform.machine()` is `x86_64`. A
  Rosetta/arm64 Python will silently build an arm64 bundle.
- **Python must be 3.12.** 3.14 (and often 3.13) lack wheels for the native deps and
  the install/build will fail or produce a broken bundle.
- **Zip with the tool, not Finder.** `build.py` uses `zip -y` to preserve the
  framework symlinks and exec bit; Finder's "Compress" flattens them and the app
  won't launch.
- **Unsigned / unnotarized.** End users must clear quarantine on first run
  (right-click → Open, or `xattr -dr com.apple.quarantine caption-guru`). Same as
  the other Mac artifacts — signing/notarization is a separate roadmap item.
- **`torch` excluded** by the spec on purpose — don't "fix" a missing-torch warning.
- The whole flow is CI-parity: same frontend build, same Python 3.12, same extras,
  same `build.py`. If CI is later un-stuck you can go back to just tagging
  `vX.Y.Z-intel`.
