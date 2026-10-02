// Featured games: the games in the "Featured Games" section of vaultlearninggames.org's home page. Vault release
// managers tick them on Vault → Game Catalog. They're stored as one JSON value in the settings table and published with
// the catalog (GET /v1/catalog → "featured"), so the site build picks them up with everything else.
//
// Each entry is a site listing (by its page slug), a sequence number (the home page shows them in ascending sequence,
// ties by title) and optional home-page overrides: a blurb (short Markdown, so a title can be *italic*) and an image.
// Without them the site uses the listing's short description and hero image. The image is a path on the site
// (images/featured/x.webp, in the website repo) or an absolute https URL of one uploaded to the Vault CDN
// (STUDIO/GAME/_vault-assets/featured-HASH.EXT; see assets.ts. Older uploads are at _site/featured/ and still work).
//
// Unticking a game parks its entry in `unfeatured`, so ticking it again brings its blurb and image back.
import type { Db } from './db.ts';
import { isListingSlug } from './listings.ts';

export const FEATURED_KEY = 'site_featured';
export const MAX_FEATURED = 9;                 // the section shows them three to a row
const MAX_PARKED = 200;
const MAX_SEQUENCE = 9999;

export interface FeaturedEntry {
  slug: string;
  blurb: string;
  image: string;
  sequence: number;
}
export interface Featured {
  games: FeaturedEntry[];
  unfeatured: FeaturedEntry[];
  updated_by: string | null;
  updated_at: string | null;
}
export type FeaturedLists = Pick<Featured, 'games' | 'unfeatured'>;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Clean up a list from storage or a request: known shape, valid slugs, no duplicates, at most `cap`. Entries stored
// before sequence numbers existed were an ordered list; they get their position (1, 2, 3...) as their sequence.
export function normalizeFeatured(v: unknown, cap = MAX_FEATURED): FeaturedEntry[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: FeaturedEntry[] = [];
  for (const [i, raw] of v.entries()) {
    const e = (typeof raw === 'string' ? { slug: raw } : raw) as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') continue;
    const slug = str(e.slug, 100).toLowerCase();
    if (!isListingSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const sequence = Number.isInteger(e.sequence) ? Math.max(0, Math.min(MAX_SEQUENCE, e.sequence as number)) : i + 1;
    out.push({ slug, blurb: str(e.blurb, 600), image: str(e.image, 500), sequence });
    if (out.length === cap) break;
  }
  return out;
}

export function readFeatured(db: Db): Featured {
  const raw = db.setting(FEATURED_KEY);
  const none: Featured = { games: [], unfeatured: [], updated_by: null, updated_at: null };
  if (!raw) return none;
  try {
    const v = JSON.parse(raw);
    return { games: normalizeFeatured(v.games), unfeatured: normalizeFeatured(v.unfeatured, MAX_PARKED), updated_by: v.updated_by ?? null, updated_at: v.updated_at ?? null };
  } catch {
    return none;
  }
}

export function saveFeatured(db: Db, lists: FeaturedEntry[] | FeaturedLists, actor: string): Featured {
  const l = Array.isArray(lists) ? { games: lists, unfeatured: [] } : lists;
  const f: Featured = { games: normalizeFeatured(l.games), unfeatured: normalizeFeatured(l.unfeatured, MAX_PARKED), updated_by: actor, updated_at: new Date().toISOString() };
  db.setSetting(FEATURED_KEY, JSON.stringify(f));
  return f;
}

// Home-page order: ascending sequence, then title (titleOf gives the listing's title; the slug otherwise).
export function sortFeatured<T extends { slug: string; sequence: number }>(games: T[], titleOf: (slug: string) => string | undefined = () => undefined): T[] {
  const t = (e: T) => titleOf(e.slug) || e.slug;
  return [...games].sort((a, b) => a.sequence - b.sequence || t(a).localeCompare(t(b)));
}

// Edits the portal makes. Each returns the new lists, or an error message.
export type FeaturedEdit =
  | { op: 'feature'; slug: string; on: boolean }
  | { op: 'set'; slug: string; sequence?: unknown; blurb?: string; image?: string };

export function applyFeaturedEdit(f: FeaturedLists, edit: FeaturedEdit, isPublished: (slug: string) => boolean): FeaturedLists | string {
  const games = f.games.map((e) => ({ ...e }));
  const unfeatured = f.unfeatured.filter((e) => e.slug !== edit.slug);
  const at = games.findIndex((e) => e.slug === edit.slug);
  if (edit.op === 'feature') {
    if (!edit.on) {
      if (at < 0) return { games, unfeatured: f.unfeatured };                    // already off: nothing to do
      const [e] = games.splice(at, 1);
      return { games, unfeatured: [e, ...unfeatured] };
    }
    if (at >= 0) return { games, unfeatured };
    if (!isPublished(edit.slug)) return 'Only games that are on the site can be featured.';
    if (games.length >= MAX_FEATURED) return `The home page shows at most ${MAX_FEATURED} featured games. Untick one first.`;
    const parked = f.unfeatured.find((e) => e.slug === edit.slug);
    const sequence = games.reduce((m, e) => Math.max(m, e.sequence), 0) + 1;   // last, until someone renumbers it
    games.push({ slug: edit.slug, blurb: parked?.blurb ?? '', image: parked?.image ?? '', sequence: Math.min(sequence, MAX_SEQUENCE) });
    return { games, unfeatured };
  }
  if (at < 0) return 'That game isn’t featured.';
  const e = games[at];
  if (edit.sequence !== undefined) {
    const n = typeof edit.sequence === 'string' && edit.sequence.trim() !== '' ? Number(edit.sequence) : edit.sequence;
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > MAX_SEQUENCE) return `The sequence number should be a whole number from 0 to ${MAX_SEQUENCE}.`;
    e.sequence = n as number;
  }
  if (edit.blurb !== undefined) e.blurb = str(edit.blurb, 600);
  if (edit.image !== undefined) {
    if (edit.image && !/^(https:\/\/|\/?[a-z0-9][\w./-]*$)/i.test(edit.image)) return 'The image should be a path on the site (images/…) or an https:// address.';
    e.image = str(edit.image, 500);
  }
  return { games, unfeatured: f.unfeatured };
}

// What the catalog publishes: featured games that are still on the site, in home-page order.
export function catalogFeatured(f: Featured, titleOf: (slug: string) => string | undefined): FeaturedEntry[] {
  return sortFeatured(f.games.filter((e) => titleOf(e.slug) !== undefined), titleOf)
    .map((e) => ({ slug: e.slug, blurb: e.blurb, image: e.image, sequence: e.sequence }));
}
