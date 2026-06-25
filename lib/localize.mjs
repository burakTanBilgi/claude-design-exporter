// Source hardening: download Google-Drive-hotlinked hero images into assets/ and
// rewrite the <img src> values to local relative paths. Drive hotlinks rate-limit,
// can require auth, and add latency that worsens the font-timing race — local files
// are stable and offline-safe. Reversible (.orig backup) and idempotent.

import fs from 'node:fs/promises';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Matches lh3 Drive hotlinks like:  https://lh3.googleusercontent.com/d/<id>=w1400
const DRIVE_RE = /https:\/\/lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]+)(?:=[^"'\s)]*)?/g;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Localize Drive hero images for a campaign directory.
 * Scans ROOT/designs/*.html, downloads each unique Drive id into ROOT/assets/,
 * and rewrites references to ../assets/hero-<id>.jpg.
 * @param {string} root absolute path to the design root
 * @param {(msg:string)=>void} [log] progress sink (defaults to console.log)
 */
export async function localizeImages(root, log = console.log) {
  const designsDir = path.join(root, 'designs');
  const assetsDir = path.join(root, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const htmlFiles = (await fs.readdir(designsDir)).filter((f) => f.endsWith('.html'));

  // Pass 1: collect every unique Drive id across all files.
  const ids = new Set();
  const fileContents = new Map();
  for (const f of htmlFiles) {
    const p = path.join(designsDir, f);
    const html = await fs.readFile(p, 'utf8');
    fileContents.set(f, html);
    for (const m of html.matchAll(DRIVE_RE)) ids.add(m[1]);
  }

  if (ids.size === 0) {
    log('  images: no Drive hotlinks found (already localized?) — skipping.');
    return;
  }

  // Pass 2: download each id (higher res for 2x headroom).
  let downloaded = 0, reused = 0;
  for (const id of ids) {
    const dest = path.join(assetsDir, `hero-${id}.jpg`);
    if (await exists(dest)) { reused++; continue; }
    const url = `https://lh3.googleusercontent.com/d/${id}=w2160`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Drive image download failed (${res.status}): ${id}`);
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    downloaded++;
  }
  log(`  images: ${ids.size} heroes (${downloaded} downloaded, ${reused} cached) → assets/`);

  // Pass 3: rewrite each HTML file (back up originals once).
  for (const [f, html] of fileContents) {
    if (!html.includes('lh3.googleusercontent.com')) continue;
    const p = path.join(designsDir, f);
    const origPath = `${p}.orig`;
    if (!(await exists(origPath))) await fs.copyFile(p, origPath);
    const rewritten = html.replace(DRIVE_RE, (_full, id) => `../assets/hero-${id}.jpg`);
    await fs.writeFile(p, rewritten);
    log(`  images: rewrote Drive links in designs/${f}`);
  }
}
