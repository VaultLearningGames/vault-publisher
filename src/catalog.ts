// Building the public catalog's pieces (GET /v1/catalog), shared with listing previews (listing-preview.ts), so a
// preview shows a game exactly as the site build would.
import type { Db, Listing, Studio } from './db.ts';
import { catalogFeatured, readFeatured } from './featured.ts';
import { catalogEntry, type ListingFields } from './listings.ts';

type Row = Listing & { studio_slug: string; studio_name: string; studio_website?: string | null };

// The catalog entry for listing `l` with fields `f` (its published fields, or a draft for a preview). A listing that
// is hosted on the Vault CDN gets its game's current release URL.
export function catalogGame(db: Db, prodPublicUrl: string, l: Row, f: ListingFields) {
  let cdn: { url: string; release: string } | null = null;
  if (f.play_source === 'cdn' && l.game_id) {
    const game = db.gameById(l.game_id);
    const current = game && db.currentRelease(game.id);
    if (game && current) cdn = { url: `${prodPublicUrl}/${l.studio_slug}/${game.slug}/`, release: current.version };
  }
  return catalogEntry(l, f, cdn);
}

// Every studio of these listings with its website, by name; and, from `all`, every other studio that one of `games`
// names as a maker (matched like the site does: trimmed, any capitalization), so the site can link that name too.
export function catalogStudios(rows: Row[], all: Studio[] = [], games: { makers: string[] }[] = []) {
  const key = (name: string) => name.trim().toLowerCase();
  const named = new Set(games.flatMap((g) => g.makers.map(key)));
  const out = new Map(rows.map((l) => [l.studio_slug, { slug: l.studio_slug, name: l.studio_name, url: l.studio_website || null }]));
  for (const s of all) if (!out.has(s.slug) && named.has(key(s.name))) out.set(s.slug, { slug: s.slug, name: s.name, url: s.website || null });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Everything GET /v1/catalog publishes: every published site listing, the studios, and the home page's featured
// games in ascending sequence, ties by title (only games that are on the site). The site build and the portal's own
// listing previews (portal/site-preview.ts) both start from this.
export function buildCatalog(db: Db, prodPublicUrl: string) {
  const published = db.listings({ published: true });
  const games = published.map((l) => catalogGame(db, prodPublicUrl, l, l.published!));
  const titles = new Map(games.map((g) => [g.slug, g.title]));
  const featured = catalogFeatured(readFeatured(db), (slug) => titles.get(slug));
  const studios = catalogStudios(published, db.studios(), games);
  return { version: 1, generated_at: new Date().toISOString(), featured, studios, games };
}
