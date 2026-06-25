#!/usr/bin/env node
// Claude Design Exporter — local web app server.
// Serves the browser UI, accepts uploaded ("imported") designs, and drives the SAME
// export pipeline as the CLI, streaming live progress over Server-Sent Events.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';

import { designs as PRESETS, DEFAULT_SCALE, ROOT } from './designs.config.mjs';
import { runPrepare, runExport, listRuns, DEFAULT_OUT, PROJECT_DIR } from './lib/pipeline.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(PROJECT_DIR, 'uploads');
const PROMPT_FILE = path.join(APP_DIR, 'prompts', 'prepare-design-prompt.md');
const PORT = Number(process.env.PORT) || 4178;
// Bind loopback by default (local-only is what makes the no-auth design safe). Set
// HOST=0.0.0.0 to expose it (e.g. in a container) — ONLY behind your own auth/proxy.
const HOST = process.env.HOST || '127.0.0.1';

// ── imported designs registry (in-memory; repopulated from disk on boot) ──────
const imports = new Map(); // id -> { id, file, slide, width, height, root, kind, requiredFonts, hide, batch }

const baseId = (rel) =>
  (path.basename(rel).replace(/\.html?$/i, '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'design');
function uniqueId(id) {
  if (!imports.has(id) && !PRESETS.some((p) => p.id === id)) return id;
  let n = 2; while (imports.has(`${id}-${n}`) || PRESETS.some((p) => p.id === `${id}-${n}`)) n++;
  return `${id}-${n}`;
}

// Heuristic: figure out the slide selector + slide size from the HTML source.
function detect(html) {
  // Prefer a rule that sets width AND height together (an artboard), else first of each.
  let w, h;
  const pair = html.match(/width:\s*(\d{3,4})px\s*;[^{}]*?height:\s*(\d{3,4})px/)
    || html.match(/height:\s*(\d{3,4})px\s*;[^{}]*?width:\s*(\d{3,4})px/);
  if (pair) { if (/^width/.test(pair[0])) { w = pair[1]; h = pair[2]; } else { h = pair[1]; w = pair[2]; } }
  w = w || (html.match(/width:\s*(\d{3,4})px/) || [])[1];
  h = h || (html.match(/height:\s*(\d{3,4})px/) || [])[1];
  const n = (re) => (html.match(re) || []).length;
  const slide = n(/class="[^"]*\bpost\b/g) > n(/class="[^"]*\bslide\b/g) ? '.post' : '.slide';
  return { slide, width: Number(w) || 1080, height: Number(h) || 1350 };
}

function walkHtml(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(p, out);
    else if (/\.html?$/i.test(e.name)) out.push(p);
  }
  return out;
}

// Find local (relative) files the HTML references but that weren't uploaded —
// the usual reason an imported design renders unstyled (missing ../css, fonts, images).
function findMissing(absHtml, html) {
  const refs = new Set();
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]);
  for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) refs.add(m[1]);
  const baseDir = path.dirname(absHtml);
  const missing = [];
  for (const ref of refs) {
    if (/^[a-z]+:/i.test(ref) || ref.startsWith('//') || ref.startsWith('data:') || ref.startsWith('#')) continue;
    const target = path.resolve(baseDir, ref.split(/[?#]/)[0]);
    if (!fs.existsSync(target)) missing.push(ref);
  }
  return missing;
}

// HTML plus the text of any local CSS it links (1–2 levels deep), so the size/selector
// detection works even when the artboard rule lives in an external stylesheet rather
// than an inline <style> block (common in prompt-prepared, multi-file designs).
function gatherStyleText(absHtml, html) {
  const cssRefs = (src) => {
    const refs = new Set();
    for (const m of src.matchAll(/<link[^>]+href\s*=\s*["']([^"']+\.css[^"']*)["']/gi)) refs.add(m[1]);
    for (const m of src.matchAll(/@import\s+(?:url\()?\s*["']?([^"')]+\.css[^"')]*)["']?/gi)) refs.add(m[1]);
    return [...refs];
  };
  let text = html;
  const seen = new Set();
  const visit = (absFrom, src, depth) => {
    if (depth > 2) return;
    for (const ref of cssRefs(src)) {
      if (/^[a-z]+:/i.test(ref) || ref.startsWith('//') || ref.startsWith('data:')) continue;
      const target = path.resolve(path.dirname(absFrom), ref.split(/[?#]/)[0]);
      if (seen.has(target) || !fs.existsSync(target)) continue;
      seen.add(target);
      let css = ''; try { css = fs.readFileSync(target, 'utf8'); } catch { continue; }
      text += '\n' + css;
      visit(target, css, depth + 1);
    }
  };
  visit(absHtml, html, 1);
  return text;
}

async function registerHtml(absPath, batchDir, batch) {
  const html = await fsp.readFile(absPath, 'utf8');
  const rel = path.relative(batchDir, absPath).split(path.sep).join('/');
  const det = detect(gatherStyleText(absPath, html));
  const id = uniqueId(baseId(rel));
  // Default-hide common authoring chrome (nav bar / tweaks panel), like the presets do.
  const desc = { id, file: rel, ...det, root: batchDir, kind: 'import', requiredFonts: [], hide: ['.nav', '#tw-root'], batch, missing: findMissing(absPath, html) };
  imports.set(id, desc);
  return desc;
}

async function scanUploads() {
  let batches = [];
  try { batches = await fsp.readdir(UPLOADS_DIR, { withFileTypes: true }); } catch { return; }
  for (const b of batches) {
    if (!b.isDirectory()) continue;
    const batchDir = path.join(UPLOADS_DIR, b.name);
    for (const html of walkHtml(batchDir)) await registerHtml(html, batchDir, b.name);
  }
}
const publicImport = (d) => ({ id: d.id, width: d.width, height: d.height, slide: d.slide, kind: 'import', missing: d.missing || [] });

// ── upload handling (preserves relative paths, guards traversal) ──────────────
const safeRel = (name) => path.normalize(name).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
function assignBatch(req, _res, next) {
  req.batch = crypto.randomUUID().slice(0, 8);
  req.batchDir = path.join(UPLOADS_DIR, req.batch);
  fs.mkdirSync(req.batchDir, { recursive: true });
  next();
}
// Multipart strips directories from the filename, so the client sends each file's
// relative path in a parallel `paths` field and we rebuild the tree from memory.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 60 } });

// ── express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check (unauthenticated, registered before the auth gate) so platform probes
// like Render's health check succeed even when Basic Auth is enabled.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Optional HTTP Basic Auth gate — enabled only when BOTH env vars are set, so local
// `npm run web` stays open while a public/exposed deploy can require a password.
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  const eq = (a, b) => {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  };
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (eq(u || '', AUTH_USER) && eq(p || '', AUTH_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Claude Design Exporter"').status(401).send('Authentication required.');
  });
}

// Reject cross-origin (drive-by) requests to state-changing endpoints. Browsers set
// Sec-Fetch-Site automatically; same-origin/same-site/none (user-initiated) pass through,
// a malicious third-party page (cross-site) is blocked.
function sameOrigin(req, res, next) {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }
  next();
}

app.use('/out', express.static(DEFAULT_OUT));
app.use('/web', express.static(path.join(APP_DIR, 'web')));
app.get('/', (_req, res) => res.sendFile(path.join(APP_DIR, 'web', 'index.html')));

// The prompt the user pastes to Claude to get a prepared, import-ready design folder.
// Served as markdown so the in-app "Copy prompt" reads it and "Download" saves it.
app.get('/api/prompt', async (_req, res) => {
  try {
    const text = await fsp.readFile(PROMPT_FILE, 'utf8');
    res.type('text/markdown; charset=utf-8').send(text);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/designs', (_req, res) => {
  res.json({
    root: ROOT,
    defaultScale: DEFAULT_SCALE,
    designs: PRESETS.map((d) => ({ id: d.id, width: d.width, height: d.height })),
    imports: [...imports.values()].map(publicImport),
  });
});

app.get('/api/runs', async (_req, res) => {
  try { res.json(await listRuns()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve a run (and optional design) folder safely under DEFAULT_OUT, or null.
function safeRunDir(run, design) {
  if (!/^run-\d+$/.test(String(run))) return null;
  if (design !== undefined && !/^[a-z0-9_-]+$/i.test(String(design))) return null;
  const dir = design === undefined
    ? path.join(DEFAULT_OUT, run)
    : path.join(DEFAULT_OUT, run, design);
  const resolved = path.resolve(dir);
  if (resolved !== DEFAULT_OUT && !resolved.startsWith(DEFAULT_OUT + path.sep)) return null;
  return resolved;
}
// Stream a folder as a zip download.
function streamZip(res, dir, name) {
  if (!dir || !fs.existsSync(dir)) return res.status(404).json({ error: 'Not found.' });
  res.attachment(`${name}.zip`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', () => { try { res.status(500).end(); } catch { /* already streaming */ } });
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
}
app.get('/api/runs/:run/zip', (req, res) => {
  streamZip(res, safeRunDir(req.params.run), req.params.run);
});
app.get('/api/runs/:run/:design/zip', (req, res) => {
  streamZip(res, safeRunDir(req.params.run, req.params.design), `${req.params.run}-${req.params.design}`);
});

app.post('/api/upload', sameOrigin, assignBatch, upload.array('files'), async (req, res) => {
  try {
    const files = req.files || [];
    const paths = [].concat(req.body?.paths || []); // aligned with files by index
    // Folder import is mandatory: every file must carry a directory in its path. A
    // lone .html (no parent folder) can't bring its ../css/fonts/assets along.
    const cameFromFolder = paths.length && paths.every((p) => /[/\\]/.test(String(p)));
    if (!cameFromFolder) {
      return res.status(400).json({ error: 'Import the whole FOLDER (e.g. the prepared folder from the prompt), not individual files.' });
    }
    for (let i = 0; i < files.length; i++) {
      const rel = safeRel(paths[i] || files[i].originalname);
      const dest = path.join(req.batchDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, files[i].buffer);
    }
    const htmlPaths = walkHtml(req.batchDir);
    if (!htmlPaths.length) {
      await fsp.rm(req.batchDir, { recursive: true, force: true }).catch(() => {});
      return res.status(400).json({ error: 'No .html file found in the upload.' });
    }
    const created = [];
    for (const abs of htmlPaths) created.push(publicImport(await registerHtml(abs, req.batchDir, req.batch)));
    res.json({ imports: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/import/:id', sameOrigin, async (req, res) => {
  const d = imports.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Unknown import.' });
  imports.delete(d.id);
  const stillUsed = [...imports.values()].some((x) => x.batch === d.batch);
  if (!stillUsed) await fsp.rm(path.join(UPLOADS_DIR, d.batch), { recursive: true, force: true }).catch(() => {});
  res.json({ ok: true });
});

// Clear ALL imports (registry + uploaded files).
app.delete('/api/imports', sameOrigin, async (_req, res) => {
  imports.clear();
  await fsp.rm(UPLOADS_DIR, { recursive: true, force: true }).catch(() => {});
  res.json({ ok: true });
});

// Clear ALL exported runs.
app.delete('/api/runs', sameOrigin, async (_req, res) => {
  try {
    for (const n of await fsp.readdir(DEFAULT_OUT).catch(() => [])) {
      if (/^run-\d+$/.test(n)) await fsp.rm(path.join(DEFAULT_OUT, n), { recursive: true, force: true });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Build export targets from a list of ids (presets and/or imports).
function buildTargets(ids) {
  if (ids.length === 1 && ids[0] === 'all') return PRESETS.map((d) => ({ ...d, root: ROOT }));
  return ids.map((id) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) return { ...preset, root: ROOT };
    return imports.get(id) || null;
  }).filter(Boolean);
}

// ── SSE-driven jobs (one at a time, cancellable) ───────────────────────────────
let busy = false;
let currentController = null;
function sse(res, task) {
  if (busy) { res.status(409).json({ error: 'A job is already running.' }); return; }
  busy = true;
  const controller = new AbortController();
  currentController = controller;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log = (msg) => send('log', { msg: String(msg) });
  // If the browser disconnects, abort the running job (don't keep burning Chromium).
  res.on('close', () => { if (!controller.signal.aborted) controller.abort(); });
  Promise.resolve().then(() => task(log, controller.signal))
    .then((result) => send('done', result ?? {}))
    .catch((err) => {
      if (err?.name === 'AbortError') send('cancelled', { msg: 'Export cancelled — partial output kept.' });
      else send('error', { msg: err?.message || String(err) });
    })
    .finally(() => { busy = false; currentController = null; res.end(); });
}

// Cancel the in-flight job (Cancel button). Partial output is kept on disk.
app.post('/api/cancel', sameOrigin, (_req, res) => {
  if (!busy || !currentController) return res.status(409).json({ error: 'No job running.' });
  if (!currentController.signal.aborted) currentController.abort();
  res.json({ ok: true });
});

app.get('/api/prepare', sameOrigin, (_req, res) => {
  // Always the configured ROOT — never an attacker-supplied path. To prepare a
  // different folder, use the CLI: `node export.mjs prepare --root <dir>`.
  sse(res, (log, signal) => runPrepare({ signal }, log));
});

app.get('/api/export', sameOrigin, (req, res) => {
  const ids = String(req.query.designs || '').split(',').map((s) => s.trim()).filter(Boolean);
  const targets = buildTargets(ids);
  const scale = req.query.scale ? Number(req.query.scale) : undefined;
  const formats = String(req.query.formats || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowFallback = req.query.allowFallback === 'true';
  if (!targets.length) { sse(res, () => { throw new Error('No designs selected.'); }); return; }
  sse(res, (log, signal) => runExport({ designs: targets, scale, formats: formats.length ? formats : ['png', 'pdf'], allowFallback, signal }, log));
});

await scanUploads();
app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? `0.0.0.0:${PORT} (exposed — ensure it's behind auth)` : `http://localhost:${PORT}`;
  console.log(`\n  Claude Design Exporter — web UI`);
  console.log(`  ▶  ${shown}\n`);
  console.log(`  Source root: ${ROOT}`);
  console.log(`  Output:      ${DEFAULT_OUT}`);
  console.log(`  Imports:     ${imports.size} registered\n  (Ctrl+C to stop)\n`);
});
