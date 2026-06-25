// Configuration for the Claude Design Exporter.
//
// ROOT is the directory the static server is rooted at (your own design source). The
// HTML slides live in ROOT/designs/ and reference shared assets via `../`
// (colors_and_type.css, system.css, assets/...), so the server must be rooted at ROOT
// — not at designs/. Override it with the DESIGN_ROOT env var or the CLI `--root` flag.
//
// The web app is imports-only; these presets are for the CLI. Point ROOT at your own
// design folder and adjust the presets to your filenames. Slide COUNT is detected at
// runtime (by counting matches of `slide`), so multi-slide files don't need it here.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.DESIGN_ROOT || path.join(HERE, 'designs');

// Default raster multiplier. 2 → crisp 2x output (e.g. 2160x2700). Use --scale 1
// for exact platform pixel dimensions (1080xH).
export const DEFAULT_SCALE = 2;

// Example presets — rename these to match your own design files under ROOT/designs/.
export const designs = [
  {
    id: 'carousel',
    file: 'designs/carousel.html',
    slide: '.slide',
    width: 1080,
    height: 1350,
    hide: ['.nav', '#tw-root'],
    // Eyebrow style normally set by a (removed) authoring panel. We set it
    // explicitly before capture. One of: 'pill' | 'shadow' | 'top'.
    eb: 'shadow',
  },
  {
    id: 'square',
    file: 'designs/square.html',
    slide: '.post',
    width: 1080,
    height: 1080,
    hide: ['.nav', '#tw-root'],
  },
  {
    id: 'story',
    file: 'designs/story.html',
    slide: '.post',
    width: 1080,
    height: 1920,
    hide: ['.nav', '#tw-root'],
  },
];

// Font faces the capture step asserts are loaded (not falling back). Keep in sync
// with your colors_and_type.css --font-display / --font-body.
export const REQUIRED_FONTS = [
  '700 100px "Big Shoulders"',
  '700 100px "Hanken Grotesk"',
];
