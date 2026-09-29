// Building the public catalog's pieces (GET /v1/catalog), shared with listing previews (listing-preview.ts), so a
// preview shows a game exactly as the site build would.
import type { Db, Listing } from './db.ts';
import { catalogEntry, type ListingFields } from './listings.ts';

type Row = Listing & { studio_slug: string; studio_name: string; studio_website?: string | null };

// The catalog entry for listing `l` with fields `f` (its published fields, or a draft for a preview). A listing that
// plays from the Vault CDN gets its game's current release URL.
export function catalogGame(db: Db, prodPublicUrl: string, l: Row, f: ListingFields) {
  let cdn: { url: string; release: string } | null = null;
  if (f.play_source === 'cdn' && l.game_id) {
    const game = db.gameById(l.game_id);
    const current = game && db.currentRelease(game.id);
    if (game && current) cdn = { url: `${prodPublicUrl}/${l.studio_slug}/${game.slug}/`, release: current.version };
  }
  return catalogEntry(l, f, cdn);
}

// Every studio of these listings with its website, by name.
export function catalogStudios(rows: Row[]) {
  return [...new Map(rows.map((l) => [l.studio_slug, { slug: l.studio_slug, name: l.studio_name, url: l.studio_website || null }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}
