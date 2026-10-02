#!/usr/bin/env node
// After `hugo`: move the /game-cards/category|tag pages (built under public/game-cards/_filters/) to the folders that
// serve their Squarespace URLs, e.g. /game-cards/category/Dev%3A+Field+Day+Lab -> public/game-cards/category/Dev:+Field+Day+Lab/.
// nginx decodes %3A and %2F before looking up files and keeps "+", so the folder names use ":" "/" and "+".
import { readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const pub = join(import.meta.dirname, '..', 'public');
const src = join(pub, 'game-cards', '_filters');
let n = 0;
const moved = new Map();   // '/game-cards/_filters/NAME/' → the address the page is served at
for (const d of await readdir(src).catch(() => [])) {
  const html = await readFile(join(src, d, 'index.html'), 'utf8');
  const m = html.match(/<meta name="sq-path" content="([^"]+)">/);
  if (!m) continue;
  const path = m[1].replace(/&#43;/g, '+').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  const dest = join(pub, ...path.split('/'));
  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(join(src, d), dest);
  // As a browser sends it: ":" "&" "/" inside a segment percent-encoded, "+" kept.
  moved.set(`/game-cards/_filters/${d}/`, '/' + path.split('/').map((seg) => encodeURIComponent(seg).replace(/%2B/g, '+')).join('/') + '/');
  n++;
}
await rm(src, { recursive: true, force: true });
// The sitemap was written before the move: point its entries at the pages' real addresses.
const sitemap = join(pub, 'sitemap.xml');
const xml = await readFile(sitemap, 'utf8').catch(() => null);
if (xml !== null) {
  const fixed = xml.replace(/(<loc>[^<]*?)(\/game-cards\/_filters\/[^/<]+\/)(<\/loc>)/g, (all, pre, from, post) => (moved.has(from) ? pre + moved.get(from) + post : all));
  if (/\/game-cards\/_filters\//.test(fixed)) throw new Error('squarespace-paths: the sitemap still lists a /game-cards/_filters/ page');
  await writeFile(sitemap, fixed);
}
console.log(`squarespace-paths: ${n} /game-cards filter pages`);
