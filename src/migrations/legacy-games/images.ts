// Which of a game's images the import re-hosts, and how the listing's fields point at the results (decision 5: the
// migration runs on ALL existing images). Every image value a listing has — hero image, thumbnail, screenshots, hero
// background, logo art, in its draft and its published version — goes through card A's crop/compress config
// (portal/image-fields.ts, by compress.ts) to a new _vault-assets object; a field that is empty in both versions is
// filled from the old page (the card image, the cover, the four screenshots, the hero band and its title image).
//
// The record of what moved (from → to, per game and field) is what makes the run idempotent: a value that is a
// recorded "to" is done, a value that is a recorded "from" is rewritten without another upload, so a second run
// changes nothing. (The field writes are recorded too, so --rollback puts the "from" values back: run.ts.)
import { ASSETS_DIR } from '../../assets.ts';
import type { ListingFields } from '../../listings.ts';
import type { LegacyValues } from './legacy.ts';
import type { ImageJob, ImageRecord, LegacyImageField } from './types.ts';

export const IMAGE_FIELD_KEYS: LegacyImageField[] = ['hero_image', 'thumb_image', 'screenshots', 'hero_background', 'logo_image'];
const SINGLE: Exclude<LegacyImageField, 'screenshots'>[] = ['hero_image', 'thumb_image', 'hero_background', 'logo_image'];

// Originals are kept, byte for byte, under this prefix of the CDN bucket (outside the game's folder, so no release
// switch ever touches them): _legacy/STUDIO/GAME/KIND-HASH16.EXT.
export const BACKUP_PREFIX = '_legacy/';
export const backupKey = (studio: string, game: string, kind: string, hash16: string, ext: string) => `${BACKUP_PREFIX}${studio}/${game}/${kind}-${hash16}.${ext}`;

// What the image tool's upload would name the result (assets.ts): the listing's own asset prefix.
export const isOwnAsset = (v: string, publicUrl: string, studio: string, game: string) =>
  v.startsWith(`${publicUrl.replace(/\/+$/, '')}/${studio}/${game}/${ASSETS_DIR}`);

// A source as a URL to download: an http(s) link as it is, a site path ("games/x/img/hero.png", "/sq/img/…")
// against the site's address. null for anything else.
export function resolveSource(source: string, site: string): string | null {
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (!s || s.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  try { return new URL(s.replace(/^\/+/, ''), `${site.replace(/\/+$/, '')}/`).href; } catch { return null; }
}

const values = (f: ListingFields | null, field: LegacyImageField): string[] => {
  if (!f) return [];
  if (field === 'screenshots') return (f.screenshots ?? []).filter(Boolean);
  const v = f[field];
  return typeof v === 'string' && v ? [v] : [];
};

// The images to move for one listing, given what moved before. Pure; deterministic (field order, then value order).
export function imageJobs(slug: string, l: { draft: ListingFields; published: ListingFields | null }, lv: LegacyValues | null, records: ImageRecord[]): ImageJob[] {
  const out: ImageJob[] = [];
  const done = (field: LegacyImageField, v: string) => records.some((r) => r.field === field && (r.to === v || r.from === v));
  for (const field of IMAGE_FIELD_KEYS) {
    const current = [...new Set([...values(l.draft, field), ...values(l.published, field)])];
    for (const v of current) if (!done(field, v)) out.push({ slug, field, from: v, source: v, fromLegacy: false });
    if (current.length || !lv) continue;
    // Empty in both versions: the old page's image(s), when it had one.
    const legacy = field === 'screenshots' ? lv.shots
      : field === 'thumb_image' ? [lv.cardImage]
      : field === 'hero_image' ? [lv.cover]
      : field === 'hero_background' ? [lv.heroBackground]
      : [lv.logo];
    legacy.filter(Boolean).forEach((src, index) => {
      if (!records.some((r) => r.field === field && r.from === '' && r.source === src)) {
        out.push({ slug, field, from: '', source: src, fromLegacy: true, ...(field === 'screenshots' ? { index } : {}) });
      }
    });
  }
  return out;
}

// The listing's fields with every recorded move applied: a value that was moved becomes its new URL; a field that
// is empty takes the old page's images that were moved for it. Pure; applying it twice is applying it once.
export function applyImageRecords(f: ListingFields, records: ImageRecord[]): ListingFields {
  const out = { ...f, screenshots: [...(f.screenshots ?? [])] };
  const moved = (field: LegacyImageField, v: string) => records.find((r) => r.field === field && r.from === v && v !== '')?.to;
  const legacyFor = (field: LegacyImageField) => records.filter((r) => r.field === field && r.from === '').sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => r.to);
  for (const field of SINGLE) {
    const v = out[field];
    if (typeof v === 'string' && v) out[field] = moved(field, v) ?? v;
    else { const l = legacyFor(field)[0]; if (l) out[field] = l; }
  }
  if (out.screenshots.length) out.screenshots = [...new Set(out.screenshots.map((v) => moved('screenshots', v) ?? v))];
  else out.screenshots = [...new Set(legacyFor('screenshots'))];
  return out;
}

// How far the crop moved the picture: the share of the source image's area outside the field's shape (0: none).
export function cropLoss(inW: number, inH: number, aspect: { w: number; h: number } | null): number {
  if (!aspect || !inW || !inH) return 0;
  const a = aspect.w / aspect.h, r = inW / inH;
  return Math.round((1 - Math.min(a, r) / Math.max(a, r)) * 1000) / 1000;
}
