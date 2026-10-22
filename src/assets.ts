// Images uploaded in the portal (a site listing's hero image, thumbnail and screenshots; a featured game's home-page
// image). They go to the release (CDN) bucket next to the game, at
//   STUDIO/GAME/_vault-assets/KIND-HASH.EXT
// where STUDIO is the listing's studio, GAME the listing's page slug and HASH the first 16 hex digits of the file's
// SHA-256, so every upload is a new, immutable object. Replaced images are never deleted: drafts, published listings
// and live site builds may still point at them. Switching releases leaves _vault-assets/ alone (see releases.ts).
import { createHash } from 'node:crypto';
import { fail } from './app.ts';
import { ASSETS_DIR } from './releases.ts';
import type { Storage } from './storage.ts';

export { ASSETS_DIR };
export const IMAGE_CACHE = 'public, max-age=31536000, immutable';
const MB = 1024 * 1024;

// A listing's image fields are checked against their row in portal/image-fields.ts (storeImage's `check`); the featured
// image only by type and MAX_ASSET_BYTES.
export type AssetKind = 'hero' | 'thumb' | 'screenshot' | 'hero-background' | 'logo' | 'featured';
export const MAX_ASSET_BYTES = { featured: 2 * MB };

// The image type from the file's first bytes (not its name or the Content-Type the browser sent).
export function sniffImage(b: Uint8Array): { ext: 'png' | 'jpg' | 'webp'; contentType: string } | null {
  const at = (i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', contentType: 'image/png' };
  if (at(0, [0xff, 0xd8, 0xff])) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return { ext: 'webp', contentType: 'image/webp' };
  return null;
}

export function assetKey(studio: string, game: string, kind: AssetKind, b: Uint8Array, ext: string): string {
  return `${studio}/${game}/${ASSETS_DIR}${kind}-${createHash('sha256').update(b).digest('hex').slice(0, 16)}.${ext}`;
}

// A field's own check of an upload (portal/image-fields.ts): its byte cap, and the file's type or why it's refused.
export interface ImageCheck {
  maxBytes: number;
  tooBig: string;
  check(body: Uint8Array): { ext: 'png' | 'jpg' | 'webp'; contentType: string } | { status: 400 | 413; error: string };
}

// Reads an uploaded image from the request body, checks it (by `check`, else by type and MAX_ASSET_BYTES) and stores
// it. Returns its public URL. Throws HTTP errors (via fail) that the portal shows as they are.
export async function storeImage(
  req: Request,
  cdn: { production: Storage | null; prodPublicUrl: string },
  studio: string,
  game: string,
  kind: AssetKind,
  check?: ImageCheck,
): Promise<{ url: string; bytes: number }> {
  if (!cdn.production) fail(503, 'The Vault CDN storage isn’t configured here, so images can’t be uploaded.');
  const max = check?.maxBytes ?? MAX_ASSET_BYTES.featured;
  const body = await readCapped(req, max);
  if (body === 'too big') fail(413, check?.tooBig ?? `The image is too big: at most ${max / MB} MB.`);
  if (!body.length) fail(400, 'Choose an image to upload.');
  const type = check ? check.check(body) : sniffImage(body);
  if (!type) fail(400, 'That isn’t a PNG, JPEG or WebP image.');
  if ('error' in type) fail(type.status, type.error);
  const key = assetKey(studio, game, kind, body, type.ext);
  await cdn.production.put(key, body, body.length, { contentType: type.contentType, cacheControl: IMAGE_CACHE });
  return { url: `${cdn.prodPublicUrl}/${key}`, bytes: body.length };
}

// The request body, or 'too big' as soon as it passes max bytes (without reading the rest).
async function readCapped(req: Request, max: number): Promise<Uint8Array | 'too big'> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return 'too big';
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) return 'too big';
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
