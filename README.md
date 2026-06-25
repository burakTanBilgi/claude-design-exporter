# Claude Design Exporter

Turn Claude-made, fixed-size HTML design slides into **pixel-perfect images**
(PNG / JPG / WEBP / AVIF) and a **multi-page PDF** that match the browser exactly — every
time, on any machine.

It fixes the four things that corrupt naive design exports: fonts that load late from a CDN,
fragile relative/CDN asset paths, lossy DOM-rasterizers, and PDFs without fixed page geometry.
The approach: serve the design over HTTP, **self-host the fonts** and wait for
`document.fonts.ready`, capture with **real Chromium** (Playwright) at an exact viewport + scale,
and build the PDF from those correct images (one full-bleed image per page).

> **A design is a folder, not a file.** A lone `.html` renders unstyled once it's separated from
> its CSS, fonts and images — so the app imports whole **folders**. Need a correct one? The app
> ships a copyable **prompt** that gets Claude to package any design into a self-contained,
> import-ready folder for you (see [The prompt](#get-an-import-ready-folder-the-prompt)).

## Quick start (web app)

```bash
npm install
npx playwright install chromium   # only if the browser binary is missing
npm run web                       # http://localhost:4178
```

The whole app fits one screen (no scrolling) and **starts empty** — you bring your own designs.
It's a three-column dashboard:

1. **01 Input** — import a folder via the dashed tile (**Choose Folder** or drag-and-drop). The
   folder structure is preserved, so `../style.css`, `assets/…` and fonts resolve. The slide
   selector + artboard size are auto-detected (from the HTML *and* any linked CSS); a page with no
   `.slide`/`.post` is captured whole as one slide. (Loose files are rejected — import the folder.)
2. **02 Options** + a live **Transmission** log — select the imported tiles, pick a **scale** and one
   or more **formats** (**PNG** default, **JPG**, **WEBP**, **AVIF**, **PDF**) as toggle buttons,
   then **Export**. A loading bar tracks progress and the console streams a structured log (one
   `▓▓░░` bar per slide). While a run is in progress the inputs **lock** and a **Cancel ✕** button
   stops it, keeping any partial output.
3. **03 Output** — pick a run, then grab **⤓ ALL ZIP** (the whole run), a per-design **⤓ ZIP**, the
   **PDF**, or click a thumbnail for the full-size image.

### Get an import-ready folder (the prompt)

A design's HTML pulls in CSS, fonts and images that must travel with it. To package any design into
a self-contained, import-ready **folder**, open **? HOW IT WORKS / GET PROMPT** in the app and copy
the **prompt** (also at [`prompts/prepare-design-prompt.md`](prompts/prepare-design-prompt.md),
served at `GET /api/prompt`). Paste it to Claude alongside your design; Claude self-hosts the fonts
(incl. Turkish/latin-ext glyphs), localizes the images, keeps the relative paths intact, and hands
back a `.zip`. Unzip it and **import the folder** in the web app.

## CLI

The web app is imports-only; the config presets are **CLI-only**. Point `ROOT` at your own design
folder via the `DESIGN_ROOT` env var (or `--root`), and edit the presets in
[`designs.config.mjs`](designs.config.mjs) to your filenames.

```bash
# 1) One-time source hardening: self-host fonts (incl. Turkish/latin-ext) and localize
#    Google-Drive hero images in your design folder. Idempotent; backs up originals to *.orig.
DESIGN_ROOT=/path/to/your/designs node export.mjs prepare

# 2) Export all presets → out/run-NNN/<id>/png/slide-N.png + out/run-NNN/<id>/<id>.pdf
DESIGN_ROOT=/path/to/your/designs node export.mjs export --design all
```

| Flag | Default | Meaning |
|---|---|---|
| `--design <id\|all>` | `all` | Which preset to export. |
| `--scale <n>` | `2` | deviceScaleFactor. `2` → 2160×2700 etc. Use `1` for exact 1080×H. |
| `--out <dir>` | `<project>/out` | Base output directory (each run lands in `<dir>/run-NNN/`). |
| `--root <dir>` | `$DESIGN_ROOT` or `./designs` | Override the design source folder. |
| `--no-pdf` | off | PNG only, skip PDF assembly. |
| `--allow-fallback` | off | Warn instead of failing when brand fonts aren't loaded. |

Ad-hoc export of any file:

```bash
node export.mjs export --file designs/x.html --slide ".slide" \
  --width 1080 --height 1350 --hide ".nav,#tw-root" --id x
```

## Deploy

The app is a **persistent Node server** that runs headless Chromium, streams SSE, and writes to
disk — so it needs a container/VM host, **not** a static/serverless platform. A `Dockerfile` and a
Render blueprint are included.

**Render (one-click-ish):** push this repo to GitHub → in Render: **New → Blueprint** → pick the
repo → it reads [`render.yaml`](render.yaml) → set `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` → **Create**.
(Free tier sleeps after ~15 min idle and has an ephemeral disk — exported runs don't persist across
restarts.)

**Any Docker host:**

```bash
docker build -t claude-design-exporter .
docker run -p 4178:4178 \
  -e HOST=0.0.0.0 -e PORT=4178 \
  -e BASIC_AUTH_USER=admin -e BASIC_AUTH_PASS=change-me \
  claude-design-exporter
```

## Security

This is a **local-first tool with no built-in user accounts.** Read before exposing it:

- **Bind:** it binds `127.0.0.1` by default (local-only). Set `HOST=0.0.0.0` only to expose it (e.g.
  in a container), and **only behind authentication.**
- **Auth:** set `BASIC_AUTH_USER` + `BASIC_AUTH_PASS` to require an HTTP Basic password on every
  request (the `/healthz` probe is exempt). Leave them unset for open local use. **Always set them on
  any public/exposed deploy.**
- **Drive-by protection:** state-changing endpoints reject cross-origin (`Sec-Fetch-Site`) requests.
- **Outbound fetches:** `prepare` downloads fonts from Google Fonts (`fonts.gstatic.com`, host-allowlisted)
  and hero images from `lh3.googleusercontent.com` only. It rewrites files **in place** in the target
  design folder (originals backed up as `*.orig`).
- **Uploads:** capped at 25 MB/file, 60 files; paths are traversal-guarded.

## How it stays correct

- **Fonts**: `prepare` fetches the real woff2 (all subsets, incl. `latin-ext` → İ Ğ Ş Ç Ö Ü ı),
  rewrites the CDN `@import` to a local `fonts.css`, and capture force-loads + asserts each brand
  face before shooting (fails loudly on fallback for presets; imports render with whatever they ship).
- **Paths**: rendered through a temporary local static server rooted at the design folder — never `file://`.
- **Engine**: element screenshots use the real Chromium renderer, so `-webkit-text-stroke`,
  `backdrop-filter` blur, gradients and hard shadows are exact.
- **Geometry**: preview `transform: scale()` is reset to `none` and chrome (`.nav`, `#tw-root`)
  removed, so each slide rasterizes at its native size. PDF pages are sized to the slide (1px → 1pt).
- **Deterministic**: animations/transitions are frozen, so re-runs are byte-identical.
- **Formats**: PNG is always the master capture; JPG/WEBP/AVIF are converted from it with
  [`sharp`](https://sharp.pixelplumbing.com/) and the PDF embeds the PNGs. Per-run and per-design
  ZIPs are streamed with [`archiver`](https://www.archiverjs.com/).

## Project layout

```
server.mjs                       web app server (Express + SSE + multer; auth gate, ZIP, /api/cancel)
web/index.html                   3-column browser UI (input · options+transmission · output)
export.mjs                       CLI (prepare / export)
designs.config.mjs               ROOT (env-driven) + CLI presets + REQUIRED_FONTS
prompts/prepare-design-prompt.md the copyable prompt (served at /api/prompt; shown in the help overlay)
lib/pipeline.mjs                 shared engine (runExport: formats + AbortSignal; listRuns; runPrepare)
lib/server.mjs                   static file server for the design source
lib/fonts.mjs                    self-host fonts + rewrite CSS
lib/localize.mjs                 download Drive images + rewrite <img src>
lib/capture.mjs                  Playwright per-slide capture (PNG master; abort between slides)
lib/pdf.mjs                      image-per-page PDF (pdf-lib)
Dockerfile · render.yaml         container image + Render blueprint
```

## Third-party notice

The optional `sharp` image conversion links **libvips**, licensed under **LGPL-3.0-or-later**. Using
sharp from npm (source/dependency install) carries no obligation; if you later ship a self-contained
binary or a redistributed image that statically embeds libvips, include its LGPL notice and keep the
library replaceable. All other dependencies are permissive (MIT/Apache/ISC/BSD).

## License

[MIT](LICENSE) © burakTanBilgi
