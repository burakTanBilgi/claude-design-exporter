# Safely Exporting Claude-Made HTML Designs to PNG / PDF

A spec + problem analysis for a small **local export app** (built with Claude Code).

---

## 1. What we're trying to do

We design social-media graphics as **self-contained HTML files** (fixed-size "slides" —
e.g. 1080×1350 feed posts, 1080×1920 stories, 1080×1080 squares). Each file may contain
several slides shown one at a time. We need to turn each slide into a **pixel-perfect raster
image (PNG/JPEG)** and/or a **multi-page PDF** that looks *exactly* like the design renders in
a real browser — reliably, every time, on any machine.

Today the outputs come out **wrong**: text in the wrong font, reflowed, overlapping, clipped,
or mis-sized. This happens across **all three** outputs — the standalone HTML, the PNG, and
the PDF. This document explains *why* and proposes the architecture for a small local tool that
fixes it for good.

---

## 2. Symptoms we actually saw

- Headlines render in a **generic sans-serif** instead of the brand display face (Big Shoulders),
  so they **reflow** and **change width**.
- Two-line knockout headings (solid line + outlined line) **collide** with the content below
  because the substitute font has different metrics → layout overflows its box.
- Turkish characters (**İ Ğ Ş Ç Ö Ü ı**) sometimes render as **tofu boxes** or wrong glyphs.
- `-webkit-text-stroke` outline text, `backdrop-filter` blur, hard-offset shadows, and CSS
  gradients render differently (or not at all) depending on how the image was captured.
- Opening the **HTML file directly** (double-click → `file://`) looks broken: missing fonts,
  missing CSS, missing images.

---

## 3. Root-cause analysis

There are **four independent failure modes**, and our files hit all of them. A reliable
exporter has to neutralize every one.

### 3.1 Fonts load asynchronously from a CDN (the #1 cause)
Our stylesheet pulls the brand fonts over the network:

```css
@import url('https://fonts.googleapis.com/css2?family=Big+Shoulders:...&family=Hanken+Grotesk:...&display=swap');
```

Two problems:
1. **Timing.** The font arrives *after* first paint. Any tool that rasterizes before the font
   is ready captures the **fallback** font. Layout computed on fallback metrics then "sticks,"
   so text reflows/overlaps. `display=swap` *guarantees* a fallback is shown first.
2. **Availability.** If the export environment is offline, throttled, or the CDN is blocked,
   the real font **never** loads. `file://` pages and some headless contexts also fail here.
3. **Subsetting.** A CDN font request may return a Latin-only subset; the Turkish
   Latin-Extended glyphs then fall back → tofu / wrong glyphs.

**Fix:** **self-host the font files** (`.woff2`) and declare them with local `@font-face`
(no network). Then **block capture until `await document.fonts.ready`**. Ship the full
character set (Latin + Latin-Extended) so Turkish glyphs are covered.

### 3.2 Relative paths + external resources break outside the authoring context
The slides reference assets relatively and via hotlinks:

```html
<link rel="stylesheet" href="../colors_and_type.css">
<img src="../assets/logo.png">
<img src="https://lh3.googleusercontent.com/d/<driveId>=w1400">   <!-- Google Drive hotlink -->
```

- Opened as `file://`, the `../` paths and any fetch-based logic fail.
- Google Drive hotlinks are **not stable** for production — they rate-limit, can require auth,
  and may stop resolving. They also add network latency that worsens the timing race in 3.1.

**Fix:** render through a **local HTTP server** (not `file://`) rooted at the project, *or*
**bundle the file self-contained first** (inline CSS, fonts as base64, images as data URIs).
Download Drive images to local files for production.

### 3.3 DOM-rasterizers (html2canvas / html-to-image / dom-to-image) are lossy
If the "export to PNG" path uses a JS DOM-rasterizer, it **re-implements** CSS in JS and gets
many things wrong: webfonts, `-webkit-text-stroke`, `backdrop-filter`/blur, complex gradients,
`mix-blend-mode`, `clip-path`, CSS `zoom`, and sub-pixel text layout. Our designs use several
of these (knockout stroke text, blur, hard-offset shadows, gradient bands, `zoom`-based scaling),
so this route will *always* look subtly-to-badly wrong.

**Fix:** capture with a **real browser engine** (Playwright/Puppeteer `page.screenshot`), which
rasterizes with the actual rendering pipeline — identical to what you see on screen.

### 3.4 PDF generated without fixed page geometry / embedded fonts
Print-to-PDF "looks completely wrong" usually because:
- No `@page { size: <w> <h>; margin: 0 }` → the renderer paginates at A4/Letter, scaling and
  slicing the slide.
- Print CSS / `@media print` differs from screen, or browser print margins are applied.
- Fonts aren't embedded (same async issue as 3.1) → fallback substitution in the PDF.

**Fix:** either (a) generate the PDF with a headless browser's `page.pdf({ width, height,
printBackground: true, pageRanges })` after fonts are ready, with `@page` size matching the
slide exactly; or (b) **assemble the PDF from already-correct raster images** (one full-bleed
image per page) so there is no text to re-render in the PDF at all — the most bulletproof option.

---

## 4. The reliable architecture (recommended)

A tiny **local Node app** driving a **headless Chromium** via Playwright. This is the single
most reliable approach because it uses the real rendering engine and gives us total control over
timing, viewport, fonts, and output geometry.

```
design.html ──▶ [local static server] ──▶ [Playwright Chromium]
                                              │  set viewport WxH, deviceScaleFactor=N
                                              │  goto(http://localhost/…)
                                              │  inject self-hosted @font-face
                                              │  await document.fonts.ready
                                              │  hide chrome (nav, tweaks panel)
                                              │  show exactly one slide
                                              ├─▶ page.screenshot()  → PNG/JPEG (per slide)
                                              └─▶ images → assemble multi-page PDF
```

### Why Playwright/Puppeteer over everything else
- Uses the **actual Chromium renderer** → `-webkit-text-stroke`, blur, gradients, shadows all correct.
- `deviceScaleFactor` lets us render at **2×/3×** for crisp output, then downscale — no upscaling blur.
- Deterministic: we control when the screenshot fires (after fonts + layout settle).
- Can emit **both** PNG and a true vector PDF from the same page.

### Core capture sequence (the part that must be exactly right)
```js
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });

// Render from a LOCAL SERVER, never file://, so relative paths + fetch work.
await page.goto('http://localhost:5173/designs/carousel.html',
                { waitUntil: 'networkidle' });

// Force the exact slide size.
await page.setViewportSize({ width: 1080, height: 1350 });

// THE KEY LINE — do not capture until every font face is loaded & ready.
await page.evaluate(async () => { await document.fonts.ready; });

// Hide authoring chrome and isolate one slide (project-specific helpers).
await page.evaluate(() => {
  document.querySelector('.nav')?.remove();
  document.getElementById('tw-root')?.remove();
  // show only slide N, position it at 0,0 at natural size, etc.
});

// Real-engine raster. clip to the exact box.
await page.screenshot({ path: 'slide-1.png', clip: { x:0, y:0, width:1080, height:1350 } });
```

### PDF: two viable routes
- **A — image-per-page (most robust).** Capture each slide to PNG as above, then stitch into a
  PDF where each page is one full-bleed image at the slide's pixel size (e.g. with `pdf-lib`).
  No fonts in the PDF → cannot reflow/corrupt. This is what finally worked for us by hand.
- **B — native `page.pdf`.** `await page.pdf({ width:'1080px', height:'1350px', printBackground:true })`
  with `@page{size:1080px 1350px;margin:0}` and `document.fonts.ready` first. Vector text, smaller
  files, but more sensitive to print-CSS differences. Use only if you need selectable text.

---

## 5. Pre-flight: make the *source* export-safe

Independent of the tool, fixing the source removes whole classes of failure:

1. **Self-host fonts.** Download Big Shoulders + Hanken Grotesk `.woff2` (OFL-licensed, from
   Google Fonts / the `google/fonts` repo), drop them in `fonts/`, and replace the CDN `@import`
   with local `@font-face` rules. Include Latin-Extended for Turkish.
2. **Add a fonts-ready signal** the exporter can await (`document.fonts.ready`, optionally set a
   `data-fonts-loaded` flag on `<body>`).
3. **Localize images.** Download Google-Drive-hotlinked photos into `assets/` and reference them
   relatively.
4. **Provide a clean "export mode"** in the HTML: a query param or JS hook that hides nav/Tweaks
   chrome and renders exactly one slide at natural size (so the exporter isn't reverse-engineering
   the layout with brittle DOM surgery).
5. **Optionally pre-bundle** to a single self-contained `.html` (inline CSS, base64 fonts + images).
   A self-contained file renders correctly even on `file://` and is the easiest thing to archive.

---

## 6. Suggested shape of the local app

```
claude-export/
  package.json            # playwright, pdf-lib, a static server (sirv/express)
  export.mjs              # CLI: input html + slide specs → PNGs + PDF
  fonts/                  # self-hosted .woff2 (copied alongside designs)
  out/                    # generated PNGs + PDFs
```

CLI sketch:
```
node export.mjs ./designs/carousel.html \
  --slides ".slide" --width 1080 --height 1350 --scale 2 \
  --hide ".nav,#tw-root" --pdf out/carousel.pdf --png-dir out/
```

Responsibilities:
- Boot a static server rooted at the project (handles `../` paths).
- For each slide selector: set viewport, `document.fonts.ready`, isolate slide, screenshot at scale.
- Assemble the PNGs into a PDF (image-per-page).
- Validate: assert rendered text isn't using a fallback (e.g. check `document.fonts.check('700 100px "Big Shoulders"')`).

---

## 7. Acceptance checklist

- [ ] Fonts are **self-hosted** and `document.fonts.check(...)` is true before capture.
- [ ] Turkish glyphs (İ Ğ Ş Ç Ö Ü ı) render correctly, not tofu.
- [ ] Rendered through **http(s) / local server**, never `file://`.
- [ ] Capture uses a **real browser engine**, not a DOM-rasterizer.
- [ ] Output dimensions are **exactly** 1080×1350 / 1080×1920 / 1080×1080 (no scaling/letterbox).
- [ ] `-webkit-text-stroke`, blur, gradients, hard shadows look identical to the on-screen design.
- [ ] PDF page size matches the slide; background prints; one slide per page; nothing reflows.
- [ ] Nav / Tweaks chrome is hidden in exports.
- [ ] Re-running the export is **deterministic** (same bytes-ish every time).

---

## 8. TL;DR

The corruption is **not** random — it's almost entirely a **font-timing/availability** problem,
compounded by **relative-path/CDN fragility** and, for images, by **DOM-rasterizers that can't
reproduce real CSS**. The fix is a small **Playwright-based local app** that (1) serves the design
over HTTP, (2) uses **self-hosted fonts** and waits for `document.fonts.ready`, (3) captures with
the **real Chromium renderer** at an exact viewport + scale, and (4) builds the PDF from those
correct images (one per page). Get those four things right and HTML, PNG, and PDF all match the
design exactly.
