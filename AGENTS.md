# AGENTS.md

Guidance for AI agents and contributors working in this repo. Keep changes small, match the
surrounding style, and preserve the invariants below — they are load-bearing for correctness.

## What this is

A tool that renders fixed-size HTML "slides" to pixel-perfect images (PNG/JPG/WEBP/AVIF) and a
per-design PDF, using real Chromium (Playwright). Two front-ends share **one** engine:

- **CLI** — `export.mjs` (`prepare`, `export`).
- **Web app** — `server.mjs` (Express + SSE + multer) serving `web/index.html`; `npm run web`.

Both call `lib/pipeline.mjs` (`runExport`, `runPrepare`, `listRuns`). Keep them in lockstep — fix
behavior in the shared engine, not in one front-end.

## Layout

```
server.mjs            web server: upload, detect(), SSE jobs, auth gate, ZIP, cancel
web/index.html        single-file 3-column UI (no build step)
export.mjs            CLI wrapper over the engine
designs.config.mjs    ROOT (env-driven) + CLI presets + REQUIRED_FONTS
lib/pipeline.mjs      shared engine; lib/{server,fonts,localize,capture,pdf}.mjs are its stages
prompts/prepare-design-prompt.md  the user-facing "package my design" prompt (served at /api/prompt)
```

## Run & verify

```bash
npm install
npx playwright install chromium      # if the browser is missing
npm run web                          # http://localhost:4178

node --check server.mjs              # syntax-check after edits (repeat per changed .mjs)
```

There is no test suite. After changing the server, boot it on a scratch port and curl the endpoints
(`/healthz`, `/`, `/api/designs`) to confirm it still serves. After changing capture/pipeline, run a
real export from the UI or `node export.mjs export` and check `out/run-NNN/`.

## Invariants — do not break

- **PNG is the master.** It is always captured; JPG/WEBP/AVIF are converted from the PNG buffers via
  sharp and the PDF embeds the PNGs. If PNG isn't requested, its dir is deleted *after* convert+PDF.
- **Folder import only.** Every uploaded file must carry a directory in its path; a lone `.html` is
  rejected. Relative paths must resolve from the HTML's own directory.
- **Detection is strict.** `detect()` reads the slide selector (`.slide`/`.post`, winner-take-all)
  and a literal 3–4-digit `px` artboard size from the HTML + linked CSS (≤2 `@import` levels), else
  falls back to 1080×1350. Keep `gatherStyleText` and the regexes in sync if you touch this.
- **Capture is static.** Animations/transitions are frozen; only `document.fonts.ready` + image
  `decode()` are awaited; `.nav`/`#tw-root` are stripped; `transform` reset to `none`. No interaction.
- **One job at a time.** `sse()` guards with a `busy` flag + an `AbortController` (also aborts on
  client disconnect); jobs are cancellable between slides and keep partial output. Runs are never
  overwritten (`run-NNN` increments).

## Security model — keep these intact

- Binds `127.0.0.1` by default; `HOST=0.0.0.0` is opt-in for containers only.
- No built-in auth; `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` enable an HTTP Basic gate (exempts `/healthz`).
- State-changing endpoints reject cross-origin requests via `Sec-Fetch-Site` (`sameOrigin`).
- Outbound fetches are host-allowlisted (Google Fonts / Google Drive only). **Do not** add endpoints
  that take an arbitrary filesystem path or URL from the request — confine paths under a base dir
  (see `safeRunDir`) and allowlist hosts.

## Repo hygiene (this is a public repo)

- **Never commit secrets** or real client/design assets. Example designs must be synthetic
  (placeholder brand, lorem copy, no real phone numbers, no private Drive IDs).
- `node_modules/`, `out/`, `uploads/`, `sketchbook/`, `.claude`, `.env`, `*.orig` are gitignored —
  keep it that way; don't force-add them.
- ESM throughout (`"type": "module"`). No transpile/build step; `web/index.html` is hand-authored.

## Deploy

`Dockerfile` (Node + Playwright Chromium + sharp) and `render.yaml` (Render Blueprint) are included.
The deploy must set `HOST=0.0.0.0` and the `BASIC_AUTH_*` pair.
