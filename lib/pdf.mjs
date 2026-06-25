// Assemble already-correct slide PNGs into a multi-page PDF — one full-bleed image
// per page at the slide's logical size. There is no text to re-render, so nothing can
// reflow or fall back. (pdf-lib page units are points; we map 1 design px → 1 pt so
// the page is sized to the slide; the high-DPI PNG keeps it crisp.)

import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

/**
 * Build a PDF from a design's PNG slides.
 * @param {object} opts
 * @param {string[]} opts.pngs    ordered PNG paths (one per page)
 * @param {number} opts.width     logical slide width (px → pt)
 * @param {number} opts.height    logical slide height (px → pt)
 * @param {string} opts.outPath   destination .pdf path
 * @returns {Promise<string>} outPath
 */
export async function buildPdf({ pngs, width, height, outPath }) {
  const doc = await PDFDocument.create();
  for (const pngPath of pngs) {
    const img = await doc.embedPng(await fs.readFile(pngPath));
    const page = doc.addPage([width, height]);
    page.drawImage(img, { x: 0, y: 0, width, height });
  }
  await fs.writeFile(outPath, await doc.save());
  return outPath;
}
