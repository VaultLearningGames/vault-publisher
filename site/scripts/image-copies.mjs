#!/usr/bin/env node
// AVIF copies of a transparent theme image, made once and committed beside it:
//   node site/scripts/image-copies.mjs site/themes/vault-squarespace/static/sq/img/site/NAME.png
// writes NAME-480w.avif … (up to the image's own width, at most 1920px), which partials/sq/srcset.html then offers
// first (<picture><source type="image/avif">), before the WebP copies Hugo makes. Hugo's WebP encoder keeps an
// image's transparency lossless, which for a glowing, grainy transparent picture is several times the size of the
// picture itself (key-to-vault-min: 300 KB at 960px); lossy WebP transparency bands the glow, while AVIF keeps it
// smooth at a fraction of the size (45 KB at 800px). Opaque images don't need this: Hugo's copies are fine.
import sharp from 'sharp';

const WIDTHS = [480, 640, 800, 960, 1280, 1920];
for (const file of process.argv.slice(2)) {
  const { width } = await sharp(file).metadata();
  const base = file.replace(/\.[^.]+$/, '');
  const widths = [...new Set([...WIDTHS.filter((w) => w < width), Math.min(width, 1920)])];
  for (const w of widths) {
    const out = `${base}-${w}w.avif`;
    const info = await sharp(file).resize(w).avif({ quality: 45, effort: 6 }).toFile(out);
    console.log(`${out}: ${Math.round(info.size / 1024)} KB`);
  }
}
