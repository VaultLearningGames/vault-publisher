// Smaller copies of the listing images on the Vault CDN, so the website sends each visitor an image about the size it
// is shown at instead of the studio's full-size upload (a 2-3 MB screenshot shown 300px wide).
//
// Next to each image STUDIO/GAME/_vault-assets/KIND-HASH.EXT (and the older featured images at _site/featured/) the
// CDN gets WebP copies at fixed widths:
//   STUDIO/GAME/_vault-assets/KIND-HASH-<W>w.webp      W in variantWidths(original width)
// the standard widths below the original's, and the original's own width (at most MAX_WIDTH). Originals are never
// changed or deleted. Like the originals, the copies are immutable (same name, same bytes, forever).
//
// The portal doesn't resize anything itself (no image library in the portal image): scripts/image-variants.ts, run by
// the admin task `image-variants` and by every site build (deploy.yml), asks GET /v1/admin/image-variants which
// images have no copies yet, makes them (sharp, a dev dependency) and sends them to POST /v1/admin/image-variants,
// which checks and stores them and records the image here. The record is the setting IMAGE_VARIANTS_KEY:
//   { "<key of the original>": { "w": 2400, "h": 1600, "widths": [320, 480, 640, 960, 1280, 1920] } }
// and GET /v1/catalog publishes it, for the images the catalog uses, as `images` (catalogImages): the site's
// templates (partials/sq/srcset.html) give such an image a srcset of its copies, and show any image without a record
// (a new upload before the next build, another host's image) as it is. So a new upload gets its copies in the next
// site build, and a record that was lost is made again by the next run (the objects are only written again).
import type { Db } from './db.ts';
import { ASSETS_DIR } from './assets.ts';
import { readFeatured } from './featured.ts';

export const IMAGE_VARIANTS_KEY = 'image_variants';
export const VARIANT_WIDTHS = [320, 480, 640, 960, 1280, 1920] as const;
export const MAX_WIDTH = 1920;
export const MAX_VARIANT_BYTES = 4 * 1024 * 1024;

export interface VariantRecord { w: number; h: number; widths: number[] }
export type VariantRecords = Record<string, VariantRecord>;

// An original listing image's key, never a copy's: STUDIO/GAME/_vault-assets/KIND-HASH16.EXT, or an older featured
// image's _site/featured/SLUG-HASH16.EXT (featured.ts).
const ORIGINAL_RE = new RegExp(`^(?:[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*/${ASSETS_DIR.replace(/\/$/, '')}/(?:hero|thumb|screenshot|featured)|_site/featured/[a-z0-9][a-z0-9-]*)-[0-9a-f]{16}\\.(?:png|jpg|webp)$`);
export const isOriginalKey = (key: string) => ORIGINAL_RE.test(key);

// The widths an image `width` px wide gets copies at: the standard ones below it, and its own (at most MAX_WIDTH).
export function variantWidths(width: number): number[] {
  if (!Number.isInteger(width) || width < 1) return [];
  const top = Math.min(width, MAX_WIDTH);
  return [...VARIANT_WIDTHS.filter((w) => w < top), top];
}

export const variantKey = (original: string, width: number) => `${original.replace(/\.[a-z]+$/, '')}-${width}w.webp`;

// The key of a CDN image URL of this system, or null for anything else.
export function keyOfUrl(url: string, publicUrl: string): string | null {
  const base = `${publicUrl.replace(/\/+$/, '')}/`;
  if (!url.startsWith(base)) return null;
  const key = url.slice(base.length);
  return isOriginalKey(key) ? key : null;
}

export function readVariants(db: Db): VariantRecords {
  try {
    const v = JSON.parse(db.setting(IMAGE_VARIANTS_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v as VariantRecords : {};
  } catch { return {}; }
}

export function recordVariants(db: Db, key: string, rec: VariantRecord) {
  db.setSetting(IMAGE_VARIANTS_KEY, JSON.stringify({ ...readVariants(db), [key]: rec }));
}

// Every listing image on this system's CDN that a listing (draft or published) or the featured list uses.
export function listingImageUrls(db: Db, publicUrl: string): string[] {
  const urls = new Set<string>();
  const add = (v: string | undefined) => { if (v && keyOfUrl(v, publicUrl)) urls.add(v); };
  for (const l of db.listings()) {
    for (const f of [l.draft, l.published]) {
      if (!f) continue;
      add(f.hero_image); add(f.thumb_image); f.screenshots.forEach(add);
    }
  }
  const featured = readFeatured(db);
  for (const e of [...featured.games, ...featured.unfeatured]) add(e.image);
  return [...urls].sort();
}

// The catalog's `images`: for each image URL in `catalog` that has copies, its size and the copies' URLs, narrowest
// first: { "<url>": { "width": 2400, "height": 1600, "variants": [{ "width": 320, "url": "…-320w.webp" }, …] } }.
export function catalogImages(db: Db, publicUrl: string, catalog: unknown) {
  const records = readVariants(db);
  const out: Record<string, { width: number; height: number; variants: { width: number; url: string }[] }> = {};
  const base = publicUrl.replace(/\/+$/, '');
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      const key = keyOfUrl(v, publicUrl);
      const rec = key ? records[key] : undefined;
      if (key && rec && !out[v]) out[v] = { width: rec.w, height: rec.h, variants: rec.widths.map((w) => ({ width: w, url: `${base}/${variantKey(key, w)}` })) };
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(catalog);
  return out;
}

// The first bytes of a WebP file, and its width (VP8, VP8L and VP8X headers), or null for anything else.
export function webpWidth(b: Uint8Array): number | null {
  const at = (i: number, s: string) => [...s].every((ch, j) => b[i + j] === ch.charCodeAt(0));
  if (b.length < 30 || !at(0, 'RIFF') || !at(8, 'WEBP')) return null;
  if (at(12, 'VP8 ')) return (b[26] | (b[27] << 8)) & 0x3fff;
  if (at(12, 'VP8L')) return 1 + (b[21] | ((b[22] & 0x3f) << 8));
  if (at(12, 'VP8X')) return 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
  return null;
}
