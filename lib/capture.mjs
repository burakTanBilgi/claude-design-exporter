// The capture pipeline — the part that must be exactly right.
// Renders each slide of a design with real Chromium at an exact viewport + scale,
// after fonts are guaranteed loaded, with authoring chrome stripped and the preview
// transform neutralized so every slide rasterizes at its native pixel size.

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Capture every slide of one design to PNG.
 * @param {import('playwright').Browser} browser
 * @param {object} opts
 * @param {string} opts.serverUrl   base URL of the static server
 * @param {object} opts.design      a preset from designs.config.mjs
 * @param {number} opts.scale       deviceScaleFactor (raster multiplier)
 * @param {string} opts.pngDir      directory to write slide PNGs into
 * @param {string[]} opts.requiredFonts  font specs asserted via document.fonts.check
 * @param {boolean} [opts.allowFallback] if true, warn instead of throwing on missing fonts
 * @param {(msg:string)=>void} [opts.log] progress sink (defaults to console.log)
 * @param {AbortSignal} [opts.signal] abort the capture between slides
 * @returns {Promise<{id:string,width:number,height:number,scale:number,pngs:string[]}>}
 */
function abortIf(signal) {
  if (signal?.aborted) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
}

export async function captureDesign(browser, {
  serverUrl, design, scale, pngDir, requiredFonts = [], allowFallback = false, log = console.log, signal,
}) {
  const { id, file, slide, width, height, hide = [], eb } = design;
  const url = `${serverUrl}/${file}`;

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();

  try {
    // Render over HTTP. networkidle is ideal; fall back to `load` if a CDN (e.g. the
    // carousel's React/Babel tweaks panel) keeps the network from going idle.
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20_000 });
    } catch {
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    }

    // THE key line — never rasterize before every font face is ready.
    await page.evaluate(async () => { await document.fonts.ready; });

    // Guard against capturing fallback fonts (the #1 corruption cause). Self-hosted
    // faces load lazily (only when some text uses that exact weight), so we force-load
    // each asserted face first — this both triggers the load and validates the local
    // file is actually reachable — then confirm it's present.
    if (requiredFonts.length) {
      const missing = await page.evaluate(async (specs) => {
        await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => {})));
        return specs.filter((s) => !document.fonts.check(s));
      }, requiredFonts);
      if (missing.length) {
        const msg = `[${id}] required fonts not loaded: ${missing.join(', ')}`;
        if (allowFallback) { log(`FNT warn ${id} ${missing.join(',')}`); log(`  ⚠ ${msg} (continuing: --allow-fallback)`); }
        else throw new Error(`${msg}\n  Run \`node export.mjs prepare\` to self-host fonts, or pass --allow-fallback.`);
      } else {
        log(`FNT ok ${id}`);
      }
    } else {
      log(`FNT skip ${id}`);
    }

    // Ensure hero images are decoded/painted before we shoot.
    await page.evaluate(() => Promise.all(
      Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => {}))),
    ));

    // Strip authoring chrome (nav, tweaks panel).
    await page.evaluate((sels) => {
      for (const s of sels) document.querySelectorAll(s).forEach((n) => n.remove());
    }, hide);

    // Set the eyebrow style normally controlled by the (now-removed) tweaks panel.
    if (eb) await page.evaluate((v) => { document.body.dataset.eb = v; }, eb);

    // Freeze animations/transitions for deterministic, identical re-runs.
    await page.addStyleTag({ content:
      '*,*::before,*::after{animation:none !important;transition:none !important;}' });

    await fs.mkdir(pngDir, { recursive: true });
    const count = await page.$$eval(slide, (els) => els.length);

    const pngs = [];

    // Imported/arbitrary HTML with no matching slide selector → capture the whole
    // artboard (the viewport) as a single slide instead of failing.
    if (!count) {
      log(`  note: no "${slide}" elements — capturing full page as one slide`);
      abortIf(signal);
      const out = path.join(pngDir, 'slide-1.png');
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
      pngs.push(out);
      log(`SLD 1 1 ${id}`);
      return { id, width, height, scale, pngs };
    }

    for (let i = 0; i < count; i++) {
      abortIf(signal); // stop between slides → keep what's already written
      // Isolate slide i and kill the preview transform so it renders at native size.
      await page.$$eval(slide, (els, idx) => {
        els.forEach((el, j) => {
          el.classList.toggle('active', j === idx);
          el.style.transform = 'none';
        });
      }, i);

      const handle = (await page.$(`${slide}.active`)) || (await page.$$(slide))[i];
      const out = path.join(pngDir, `slide-${i + 1}.png`);
      await handle.screenshot({ path: out });
      pngs.push(out);
      log(`SLD ${i + 1} ${count} ${id}`);
    }

    return { id, width, height, scale, pngs };
  } finally {
    await context.close();
  }
}
