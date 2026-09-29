// Featured games: the ordered games in the "Featured Games" section of vaultlearninggames.org's home page.
// Vault release managers choose them in the portal (Vault → Featured games). They're stored as one JSON value in the
// settings table and published with the catalog (GET /v1/catalog → "featured"), so the site build picks them up
// with everything else.
//
// Each entry is a site listing (by its page slug) plus optional home-page overrides: a blurb (short Markdown, so a
// title can be *italic*) and an image. Without them the site uses the listing's short description and hero image.
import type { Db } from './db.ts';
import { isListingSlug } from './listings.ts';

export const FEATURED_KEY = 'site_featured';
export const MAX_FEATURED = 9;                 // the section shows them three to a row

export interface FeaturedEntry {
  slug: string;
  blurb: string;
  image: string;
}
export interface Featured {
  games: FeaturedEntry[];
  updated_by: string | null;
  updated_at: string | null;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Clean up a list from storage or a request: known shape, valid slugs, no duplicates, at most MAX_FEATURED.
export function normalizeFeatured(v: unknown): FeaturedEntry[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: FeaturedEntry[] = [];
  for (const raw of v) {
    const e = (typeof raw === 'string' ? { slug: raw } : raw) as Record<string, unknown> | null;
    if (!e || typeof e !== 'object') continue;
    const slug = str(e.slug, 100).toLowerCase();
    if (!isListingSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, blurb: str(e.blurb, 600), image: str(e.image, 500) });
    if (out.length === MAX_FEATURED) break;
  }
  return out;
}

export function readFeatured(db: Db): Featured {
  const raw = db.setting(FEATURED_KEY);
  if (!raw) return { games: [], updated_by: null, updated_at: null };
  try {
    const v = JSON.parse(raw);
    return { games: normalizeFeatured(v.games), updated_by: v.updated_by ?? null, updated_at: v.updated_at ?? null };
  } catch {
    return { games: [], updated_by: null, updated_at: null };
  }
}

export function saveFeatured(db: Db, games: FeaturedEntry[], actor: string): Featured {
  const f: Featured = { games: normalizeFeatured(games), updated_by: actor, updated_at: new Date().toISOString() };
  db.setSetting(FEATURED_KEY, JSON.stringify(f));
  return f;
}

// Edits the portal makes to the list. Each returns the new list, or an error message.
export type FeaturedEdit =
  | { op: 'add'; slug: string }
  | { op: 'remove'; slug: string }
  | { op: 'move'; slug: string; to: number }  // new 0-based position
  | { op: 'set'; slug: string; blurb: string; image: string };

export function applyFeaturedEdit(list: FeaturedEntry[], edit: FeaturedEdit, isPublished: (slug: string) => boolean): FeaturedEntry[] | string {
  const at = list.findIndex((e) => e.slug === edit.slug);
  const next = list.map((e) => ({ ...e }));
  switch (edit.op) {
    case 'add':
      if (at >= 0) return 'That game is already featured.';
      if (!isPublished(edit.slug)) return 'Only games that are on the site can be featured.';
      if (list.length >= MAX_FEATURED) return `The home page shows at most ${MAX_FEATURED} featured games. Remove one first.`;
      next.push({ slug: edit.slug, blurb: '', image: '' });
      return next;
    case 'remove':
      if (at < 0) return 'That game isn’t featured.';
      next.splice(at, 1);
      return next;
    case 'move': {
      if (at < 0) return 'That game isn’t featured.';
      const to = Math.max(0, Math.min(next.length - 1, Math.trunc(edit.to)));
      const [e] = next.splice(at, 1);
      next.splice(to, 0, e);
      return next;
    }
    case 'set':
      if (at < 0) return 'That game isn’t featured.';
      if (edit.image && !/^(https:\/\/|\/?[a-z0-9][\w./-]*$)/i.test(edit.image)) return 'The image should be a path on the site (games/…/img/…) or an https:// address.';
      next[at] = { slug: edit.slug, blurb: str(edit.blurb, 600), image: str(edit.image, 500) };
      return next;
  }
}

// What the catalog publishes: featured games that are still on the site, in order.
export function catalogFeatured(f: Featured, isPublished: (slug: string) => boolean): FeaturedEntry[] {
  return f.games.filter((e) => isPublished(e.slug));
}
