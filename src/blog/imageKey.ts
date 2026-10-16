// Blog images on the Vault CDN (the release bucket), named by content:
//   site/<post slug>/<sha-256 hex>.<ext>     served at <CDN>/site/<post slug>/<sha-256 hex>.<ext>
// The same bytes are always the same key, so uploading an image again stores nothing new. Pure functions.
import { createHash } from 'node:crypto';
import { isBlogSlug } from './slug.ts';

export type BlogImageExt = 'jpg' | 'png' | 'webp' | 'gif';
export interface BlogImageType { ext: BlogImageExt; contentType: string }

export const BLOG_IMAGE_DIR = 'site/';

// The image type from the file's first bytes, never its name or the Content-Type the browser sent. Anything that
// isn't JPEG, PNG, WebP or GIF (SVG, HEIC, PDF, text, HTML named .png, ...) is null.
export function sniffImageType(b: Uint8Array): BlogImageType | null {
  const at = (i: number, bytes: number[]) => b.length >= i + bytes.length && bytes.every((x, j) => b[i + j] === x);
  const ascii = (i: number, s: string) => at(i, [...s].map((ch) => ch.charCodeAt(0)));
  if (at(0, [0xff, 0xd8, 0xff])) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', contentType: 'image/png' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { ext: 'webp', contentType: 'image/webp' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { ext: 'gif', contentType: 'image/gif' };
  return null;
}

// Lowercase hex SHA-256 of the exact bytes.
export function contentHash(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

// The object key (no leading slash): site/<slug>/<hash>.<ext>. Throws on a slug, hash or extension that doesn't fit.
export function buildImageKey(slug: string, hash: string, ext: string): string {
  if (!isBlogSlug(slug)) throw new Error(`invalid blog slug "${slug}"`);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('hash must be 64 lowercase hex digits');
  if (!['jpg', 'png', 'webp', 'gif'].includes(ext)) throw new Error(`invalid image extension "${ext}"`);
  return `${BLOG_IMAGE_DIR}${slug}/${hash}.${ext}`;
}

// The image's address: the CDN's public base URL + "/" + key, or the root-relative path /<key> without one.
export function imageUrl(publicBase: string | undefined, key: string): string {
  const base = (publicBase ?? '').replace(/\/+$/, '');
  return `${base}/${key}`;
}
