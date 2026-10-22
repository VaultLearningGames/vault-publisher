// Every portal image field, in one table: the shape its crop is locked to, the largest and smallest width it's stored
// at, the compression it starts at and how low it may go, and the most bytes it may have. The listing editor hands
// each field's row to the browser's image tool (public/portal-image-tool.js: crop, then WebP, else JPEG, or PNG for
// fields that keep transparency, compressed until it fits), and the upload API (listing-assets.ts) refuses any file
// that doesn't match it. A new image field only adds a row here; once the listing model has a field of its name
// (EMPTY_LISTING), it can be uploaded (listing-assets.ts).
//
// The ratios: vault-site's templates draw each Squarespace image at its own ratio (--ratio in
// themes/vault-squarespace/static/sq/css/vault-sq.css, from data/squarespace/games.json), and no hero, card or
// screenshot container has a fixed aspect-ratio, so these are the defaults the new templates are built to.
import { readImageHeader, type ImageHeader } from '../image-header.ts';

export type ImageFieldKey = 'hero_image' | 'thumb_image' | 'screenshots' | 'hero_background' | 'logo_image';

export interface ImageFieldSpec {
  label: string;
  // The upload URL's last segment (…/images/KIND) and the stored file's name prefix (assets.ts).
  kind: 'hero' | 'thumb' | 'screenshot' | 'hero-background' | 'logo';
  // Width : height the crop is locked to; null: free-form (the whole image).
  aspect: { w: number; h: number } | null;
  maxWidth: number;
  minWidth: number;
  // Encoder quality (0–1) to start at, and the lowest the tool may step down to before it makes the image narrower.
  quality: number;
  minQuality: number;
  maxBytes: number;
  // opaque: WebP, else JPEG. alpha: keeps transparency, WebP, else PNG.
  format: 'opaque' | 'alpha';
  multiple?: boolean;
}

export const IMAGE_FIELDS: Record<ImageFieldKey, ImageFieldSpec> = {
  // default: the standard layout's cover image, 16:9.
  hero_image: { label: 'Hero image', kind: 'hero', aspect: { w: 16, h: 9 }, maxWidth: 1920, minWidth: 960, quality: 0.82, minQuality: 0.5, maxBytes: 400_000, format: 'opaque' },
  // default: the Game Card thumbnail, 16:9.
  thumb_image: { label: 'Thumbnail', kind: 'thumb', aspect: { w: 16, h: 9 }, maxWidth: 1200, minWidth: 480, quality: 0.8, minQuality: 0.5, maxBytes: 200_000, format: 'opaque' },
  // default: every screenshot slot, 16:9.
  screenshots: { label: 'Screenshot', kind: 'screenshot', aspect: { w: 16, h: 9 }, maxWidth: 1920, minWidth: 960, quality: 0.8, minQuality: 0.5, maxBytes: 400_000, format: 'opaque', multiple: true },
  // default: the hero layout's full-width background, 21:9 (card B).
  hero_background: { label: 'Hero background', kind: 'hero-background', aspect: { w: 21, h: 9 }, maxWidth: 2560, minWidth: 1280, quality: 0.8, minQuality: 0.5, maxBytes: 500_000, format: 'opaque' },
  // default: the hero layout's logo art, any shape, transparent (card B).
  logo_image: { label: 'Logo art', kind: 'logo', aspect: null, maxWidth: 1200, minWidth: 200, quality: 0.9, minQuality: 0.6, maxBytes: 300_000, format: 'alpha' },
};

export function getImageFieldSpec(key: string): ImageFieldSpec {
  if (!Object.hasOwn(IMAGE_FIELDS, key)) throw new Error(`unknown image field: ${key}`);
  return IMAGE_FIELDS[key as ImageFieldKey];
}

// The field whose upload URL ends in KIND, if any.
export function imageFieldByKind(kind: string): { key: ImageFieldKey; spec: ImageFieldSpec } | null {
  for (const [key, spec] of Object.entries(IMAGE_FIELDS) as [ImageFieldKey, ImageFieldSpec][]) if (spec.kind === kind) return { key, spec };
  return null;
}

// The types a field accepts: what the browser tool makes (WebP, or its fallback where the browser can't encode WebP).
export const ACCEPTED_TYPES: Record<ImageFieldSpec['format'], ImageHeader['type'][]> = { opaque: ['webp', 'jpeg'], alpha: ['webp', 'png'] };

export const formatKB = (n: number) => `${Math.round(n / 1000)} KB`;
// "16:9": a crop's shape as people say it (the editor's crop hints, listing-fields.ts, and the upload errors).
export const ratio = (a: { w: number; h: number }) => `${a.w}:${a.h}`;

// Whether `body` may be stored for the field: its type (by content), pixel size, shape and byte size. The height may be
// a pixel off the exact ratio (the tool rounds it).
export function validateFieldImage(spec: ImageFieldSpec, body: Uint8Array):
  { ok: true; header: ImageHeader } | { ok: false; status: 400 | 413; error: string } {
  const no = (error: string, status: 400 | 413 = 400) => ({ ok: false as const, status, error });
  const name = spec.label.toLowerCase();
  if (!body.length) return no('Choose an image to upload.');
  if (body.length > spec.maxBytes) return no(`The image is too big: the ${name} can be at most ${formatKB(spec.maxBytes)}.`, 413);
  const header = readImageHeader(body);
  if (!header) return no('That isn’t a PNG, JPEG or WebP image.');
  const types = ACCEPTED_TYPES[spec.format];
  if (!types.includes(header.type)) return no(`The ${name} must be ${types.map((t) => (t === 'webp' ? 'WebP' : t.toUpperCase())).join(' or ')}: choose the image again and the portal converts it.`);
  const size = `${header.width} × ${header.height}`;
  if (header.width > spec.maxWidth) return no(`The ${name} is ${size} px: at most ${spec.maxWidth} px wide.`);
  if (header.width < spec.minWidth) return no(`The ${name} is ${size} px: at least ${spec.minWidth} px wide.`);
  if (spec.aspect && Math.abs(header.height * spec.aspect.w - header.width * spec.aspect.h) > spec.aspect.w) {
    return no(`The ${name} is ${size} px: it must be ${ratio(spec.aspect)}.`);
  }
  if (!spec.aspect && header.height > spec.maxWidth * 4) return no(`The ${name} is ${size} px: at most ${spec.maxWidth * 4} px tall.`);
  return { ok: true, header };
}

// What the browser tool needs of a field (data-image-spec on its picker).
export function imageSpecJson(spec: ImageFieldSpec): string {
  const { label, aspect, maxWidth, minWidth, quality, minQuality, maxBytes, format } = spec;
  return JSON.stringify({ label, aspect, maxWidth, minWidth, quality, minQuality, maxBytes, format });
}
