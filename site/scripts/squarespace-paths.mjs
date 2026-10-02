#!/usr/bin/env node
// After `hugo`: move the /game-cards/category|tag pages (built under public/game-cards/_filters/) to the folders that
// serve their Squarespace URLs, e.g. /game-cards/category/Dev%3A+Field+Day+Lab -> public/game-cards/category/Dev:+Field+Day+Lab/.
// The folder names use ":" "/" and "+" (what the address means once %3A and %2F are decoded, "+" kept); the hosting's
// _redirects (src/site-hosting.ts) serves each at the address the site links to.
import { readdir, readFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const pub = join(import.meta.dirname, '..', 'public');
const src = join(pub, 'game-cards', '_filters');
let n = 0;
for (const d of await readdir(src).catch(() => [])) {
  const html = await readFile(join(src, d, 'index.html'), 'utf8');
  const m = html.match(/<meta name="sq-path" content="([^"]+)">/);
  if (!m) continue;
  const path = m[1].replace(/&#43;/g, '+').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  const dest = join(pub, ...path.split('/'));
  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { recursive: true, force: true });
  await rename(join(src, d), dest);
  n++;
}
await rm(src, { recursive: true, force: true });
// The sitemap lists each page at its Squarespace address already (layouts/sitemap.xml): nothing to rewrite.
const xml = await readFile(join(pub, 'sitemap.xml'), 'utf8').catch(() => '');
if (/\/game-cards\/_filters\//.test(xml)) throw new Error('squarespace-paths: the sitemap lists a /game-cards/_filters/ page');
console.log(`squarespace-paths: ${n} /game-cards filter pages`);
