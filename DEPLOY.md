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

## Release channels — stable vs. the next major (`vN.caption.guru`)

A standing convention for **all** major-version work:

- **Stable** lives on the apex **`caption.guru`** (auto-deploys from `main`, as above).
- **The next major in development** lives on a **`vN.caption.guru`** subdomain — e.g.
  `v2.caption.guru` while v1 is the apex. This is the bleeding-edge, tester-facing channel.
- We use a **subdomain (separate origin), not a `/v2` path**, for full containment: its own
  service-worker scope, PWA install identity, and storage — so a broken beta can never poison
  the stable origin. The subdomain Worker serves its **own `/hf`** proxy, so model fetches stay
  same-origin within it.
- **Promotion = cutover.** When `vN` ships, its build becomes the apex `caption.guru` (the new
  stable), and **`vN.caption.guru` is retired with a 301 redirect to `https://caption.guru`** —
  so testers who revisit bookmarked beta URLs are automatically moved onto the new norm. Then
  `v(N+1).caption.guru` spins up as the next beta channel.

Containment trade-offs to remember: separate origins mean tester **settings don't carry across**
(use the planned export/import), and the `caption-room` WebSocket is **cross-origin** from the beta
(the room Worker validates the `Origin` header rather than relying on CORS).

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
cd desktop && python packaging/build.py     # -> desktop/dist/caption-guru-<target>.zip
```

## Manual release (fallback when a runner is unavailable)
The build artifacts are downloadable from the workflow run even before the Release publishes:
```bash
gh run download <run-id> --dir ./artifacts
gh release create vX.Y.Z --notes "..." ./artifacts/**/*.zip
```

## Run notes
- macOS bundles are **unsigned**: right-click → Open, or `xattr -dr com.apple.quarantine caption-guru/`.
- No native window? `caption-guru serve --no-open`, then open `http://127.0.0.1:8765/?source=ws`.
- Low-spec hardware: `caption-guru serve --model tiny.en`.
