# Deploy & Release

## PWA (web) → caption.guru
Hosted on **Cloudflare** as a Worker with static assets (`wrangler.jsonc`,
`packages/pwa/worker/index.js`). Live at **https://caption.guru**.

- **Auto-deploys on push to `main`** (Cloudflare build connected to the repo).
  - Build: `pnpm --filter @captions/pwa build`
  - Deploy: `npx wrangler deploy`
- The Worker also **proxies Whisper models same-origin** via `/hf/*` (server-side fetch
  from Hugging Face). This avoids cross-origin CORS failures — **do not re-add COOP/COEP**
  headers without first self-hosting models same-origin.
- SPA fallback + cache headers via `not_found_handling` + `packages/pwa/public/_headers`.
- Custom domain is managed in the Cloudflare dashboard.

## Desktop releases (GitHub Releases)
PyInstaller one-folder bundles, zipped per platform. `torch` is excluded; models download
on first run. Builds require **Python 3.11/3.12** (no faster-whisper/MLX wheels on 3.14).

**Main platforms** — tag `vX.Y.Z` → `.github/workflows/release.yml` builds **Windows x64,
Linux x64, macOS Apple Silicon** and attaches zips to a GitHub Release:
```bash
git tag v0.1.1 && git push origin v0.1.1
```

**macOS Intel** (split out — `macos-13` runners are scarce/being deprecated) — tag
`vX.Y.Z-intel` → `.github/workflows/release-intel.yml` → its own release:
```bash
git tag v0.1.1-intel && git push origin v0.1.1-intel
```

## Local build
```bash
pnpm --filter @captions/display build      # frontend the desktop app serves
cd desktop && python packaging/build.py     # -> desktop/dist/live-captions-<target>.zip
```

## Manual release (fallback when a runner is unavailable)
The build artifacts are downloadable from the workflow run even before the Release publishes:
```bash
gh run download <run-id> --dir ./artifacts
gh release create vX.Y.Z --notes "..." ./artifacts/**/*.zip
```

## Run notes
- macOS bundles are **unsigned**: right-click → Open, or `xattr -dr com.apple.quarantine live-captions/`.
- No native window? `live-captions serve --no-open`, then open `http://127.0.0.1:8765/?source=ws`.
- Low-spec hardware: `live-captions serve --model tiny.en`.
