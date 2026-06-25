// Shared export pipeline — the single code path used by BOTH the CLI (export.mjs)
// and the web app (server.mjs). Everything funnels through a `log` callback so the
// web server can stream progress to the browser while the CLI just prints it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';

import { ROOT, DEFAULT_SCALE, designs as ALL_DESIGNS, REQUIRED_FONTS } from '../designs.config.mjs';
import { startServer } from './server.mjs';
import { selfHostFonts } from './fonts.mjs';
import { localizeImages } from './localize.mjs';
import { captureDesign } from './capture.mjs';
import { buildPdf } from './pdf.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = path.join(LIB_DIR, '..');
export const DEFAULT_OUT = path.join(PROJECT_DIR, 'out');

// Raster formats we can emit. PNG is always the master (captured by Playwright); the
// rest are converted from the PNG buffers via sharp.
export const RASTER_FORMATS = ['png', 'jpg', 'webp', 'avif'];
const sharpFmt = (fmt) => (fmt === 'jpg' ? 'jpeg' : fmt);
function abortIf(signal) {
  if (signal?.aborted) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
}

/** Convert each master PNG into the requested extra raster formats (jpg/webp/avif). */
async function convertFormats({ pngs, designDir, formats, id, log, signal }) {
  for (const fmt of formats) {
    if (fmt === 'png') continue;
    const dir = path.join(designDir, fmt);
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < pngs.length; i++) {
      abortIf(signal);
      const out = path.join(dir, `slide-${i + 1}.${fmt}`);
      try {
        const buf = await fs.readFile(pngs[i]);
        await sharp(buf).toFormat(sharpFmt(fmt), { quality: 90 }).toFile(out);
        log(`FMT ${fmt} ${i + 1} ${pngs.length} ${id}`);
      } catch (err) {
        log(`FMT err ${fmt} ${id}`);
        log(`  ⚠ ${fmt} conversion failed (${id} slide ${i + 1}): ${err.message}`);
      }
    }
  }
}

/** Resolve a list of design ids (or `['all']`) to preset objects. */
export function resolveDesigns({ ids, designs } = {}) {
  if (designs?.length) return designs;
  if (!ids || ids.includes('all')) return ALL_DESIGNS;
  const found = ALL_DESIGNS.filter((d) => ids.includes(d.id));
  if (!found.length) {
    throw new Error(`No matching designs for: ${ids.join(', ')}. Available: ${ALL_DESIGNS.map((d) => d.id).join(', ')}`);
  }
  return found;
}

/** Allocate the next `run-NNN` folder inside baseOut (runs are never overwritten). */
export async function nextRunDir(baseOut) {
  let max = 0;
  try {
    for (const name of await fs.readdir(baseOut)) {
      const m = name.match(/^run-(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* baseOut doesn't exist yet → start at run-001 */ }
  return path.join(baseOut, `run-${String(max + 1).padStart(3, '0')}`);
}

/** Source hardening: self-host fonts + localize Drive images. */
export async function runPrepare({ root = ROOT } = {}, log = console.log) {
  log(`Preparing source: ${root}`);
  await selfHostFonts(root, log);
  await localizeImages(root, log);
  log('Done. Source is now export-safe (offline fonts + local images).');
  return { root };
}

/** Full export: capture every requested design's slides → PNG + per-design PDF. */
export async function runExport(opts = {}, log = console.log) {
  const {
    root = ROOT, ids, designs, scale = DEFAULT_SCALE, pdf = true,
    formats, allowFallback = false, baseOut = DEFAULT_OUT, signal,
  } = opts;

  // Decide outputs. The web app sends `formats` (e.g. ['png','jpg','pdf']); the CLI
  // sends none → fall back to PNG + the `pdf` boolean. PNG is always captured as the
  // master (it's the conversion source and what the PDF embeds); if it isn't in the
  // requested set we delete it again after the conversions + PDF are built.
  const requested = (formats && formats.length) ? formats : ['png', ...(pdf ? ['pdf'] : [])];
  const fmtSet = new Set(requested.map((f) => String(f).toLowerCase()));
  let rasterFormats = RASTER_FORMATS.filter((f) => fmtSet.has(f));
  if (!rasterFormats.length) rasterFormats = ['png']; // never produce nothing
  const keepPng = rasterFormats.includes('png');
  const extraFormats = rasterFormats.filter((f) => f !== 'png');
  const wantPdf = fmtSet.has('pdf');

  const targets = resolveDesigns({ ids, designs });
  const runDir = await nextRunDir(baseOut);
  const runName = path.basename(runDir);

  abortIf(signal);
  log(`RUN start ${targets.length} ${scale} ${runName}`);

  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    throw new Error(`Failed to launch Chromium. Try \`npx playwright install chromium\`.\n${err.message}`);
  }

  // Group designs by their own source root — presets share ROOT, imported designs
  // each have their own upload folder — so we serve the right files for each.
  const groups = new Map();
  for (const d of targets) {
    const r = d.root || root;
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(d);
  }

  const results = [];
  try {
    for (const [groupRoot, groupDesigns] of groups) {
      abortIf(signal);
      const server = await startServer(groupRoot);
      log(`SRV up ${path.basename(groupRoot)}`);
      try {
        for (const design of groupDesigns) {
          abortIf(signal);
          log(`DSN start ${design.id} ${design.width} ${design.height}`);
          const designDir = path.join(runDir, design.id);
          const pngDir = path.join(designDir, 'png');
          const r = await captureDesign(browser, {
            serverUrl: server.url, design, scale, pngDir,
            requiredFonts: design.requiredFonts ?? REQUIRED_FONTS, allowFallback, log, signal,
          });

          if (extraFormats.length) {
            await convertFormats({ pngs: r.pngs, designDir, formats: extraFormats, id: design.id, log, signal });
          }

          let pdfPath = null;
          if (wantPdf) {
            pdfPath = path.join(designDir, `${design.id}.pdf`);
            await buildPdf({ pngs: r.pngs, width: design.width, height: design.height, outPath: pdfPath });
            log(`PDF ${design.id} ${r.pngs.length}`);
          }

          // PNG not requested → drop the master dir now that conversions + PDF are done.
          if (!keepPng) await fs.rm(pngDir, { recursive: true, force: true });

          results.push({ id: design.id, width: design.width, height: design.height, slides: r.pngs.length, formats: rasterFormats, pdf: !!pdfPath });
          log(`DSN done ${design.id} ${r.pngs.length}`);
        }
      } finally {
        await server.close();
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') log(`CANCEL ${runName}`); // partial output is kept
    throw err;
  } finally {
    await browser?.close();
  }

  const totalPngs = results.reduce((n, r) => n + r.slides, 0);
  const pdfCount = results.filter((r) => r.pdf).length;
  log(`RUN done ${totalPngs} ${pdfCount} ${runName}`);
  return { runName, runDir, results };
}

/** Read the out/ tree into a structure the web gallery can render (newest first). */
export async function listRuns(baseOut = DEFAULT_OUT) {
  const runs = [];
  let entries = [];
  try {
    entries = (await fs.readdir(baseOut)).filter((n) => /^run-\d+$/.test(n)).sort().reverse();
  } catch {
    return runs;
  }
  for (const run of entries) {
    const runPath = path.join(baseOut, run);
    const designDirs = (await fs.readdir(runPath, { withFileTypes: true })).filter((e) => e.isDirectory());
    const designs = [];
    for (const d of designDirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const id = d.name;
      const formats = {};
      for (const fmt of RASTER_FORMATS) {
        try {
          const files = (await fs.readdir(path.join(runPath, id, fmt)))
            .filter((f) => f.toLowerCase().endsWith(`.${fmt}`))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map((f) => `/out/${run}/${id}/${fmt}/${f}`);
          if (files.length) formats[fmt] = files;
        } catch { /* no dir for this format */ }
      }
      let pdf = null;
      try {
        await fs.access(path.join(runPath, id, `${id}.pdf`));
        pdf = `/out/${run}/${id}/${id}.pdf`;
      } catch { /* no pdf */ }
      designs.push({ id, formats, pngs: formats.png || [], pdf, zip: `/api/runs/${run}/${id}/zip` });
    }
    runs.push({ run, designs, zip: `/api/runs/${run}/zip` });
  }
  return runs;
}
