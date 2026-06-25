#!/usr/bin/env node
// Claude Design Exporter — CLI (thin wrapper over lib/pipeline.mjs).
//
//   node export.mjs prepare [--root <dir>]
//       Self-host fonts (incl. Turkish/latin-ext) and localize Drive images in the
//       source design folder. Run once per design folder; idempotent & reversible.
//
//   node export.mjs export [options]
//       Render slides to PNG (real Chromium, exact size) and assemble per-design PDFs.
//
// Export options:
//   --design <id|all>   which preset to export (default: all)        [carousel|square|story]
//   --scale <n>         deviceScaleFactor / raster multiplier (default: config DEFAULT_SCALE)
//   --out <dir>         base output directory (default: <project>/out; runs land in run-NNN/)
//   --root <dir>        override the design root from designs.config.mjs
//   --no-pdf            skip PDF assembly (PNG only)
//   --allow-fallback    warn instead of failing when brand fonts aren't loaded
//
// Generic (ad-hoc) export of any file not in the config:
//   --file <relpath> --slide <sel> --width <n> --height <n> [--hide a,b] [--id name] [--eb v]

import path from 'node:path';
import { designs } from './designs.config.mjs';
import { runPrepare, runExport } from './lib/pipeline.mjs';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;                 // boolean flag
    } else {
      opts[key] = next;                 // --key value
      i++;
    }
  }
  return opts;
}

function adHocDesign(opts) {
  return [{
    id: opts.id || path.basename(String(opts.file)).replace(/\.html?$/, ''),
    file: String(opts.file),
    slide: String(opts.slide || '.slide'),
    width: Number(opts.width),
    height: Number(opts.height),
    hide: opts.hide ? String(opts.hide).split(',').map((s) => s.trim()).filter(Boolean) : [],
    eb: opts.eb ? String(opts.eb) : undefined,
  }];
}

async function cmdExport(opts) {
  await runExport({
    root: opts.root ? String(opts.root) : undefined,
    baseOut: opts.out ? path.resolve(process.cwd(), String(opts.out)) : undefined,
    scale: opts.scale ? Number(opts.scale) : undefined,
    pdf: !opts['no-pdf'],
    allowFallback: Boolean(opts['allow-fallback']),
    ...(opts.file
      ? { designs: adHocDesign(opts) }
      : { ids: opts.design && opts.design !== true ? [String(opts.design)] : ['all'] }),
  });
}

function usage() {
  console.log(`Claude Design Exporter

Usage:
  node export.mjs prepare [--root <dir>]
  node export.mjs export  [--design <id|all>] [--scale <n>] [--out <dir>] [--no-pdf] [--allow-fallback]
  node export.mjs export  --file <relpath> --slide <sel> --width <n> --height <n> [--hide a,b] [--id name] [--eb v]

Presets: ${designs.map((d) => d.id).join(', ')}

Tip: \`npm run web\` launches the browser UI for all of this.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));

  if (cmd === 'prepare') return runPrepare({ root: opts.root ? String(opts.root) : undefined });
  if (cmd === 'export') return cmdExport(opts);
  usage();
  process.exitCode = cmd ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
});
