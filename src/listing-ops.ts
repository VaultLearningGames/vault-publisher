// Site listing operations shared by the portal's handlers (a signed-in person, src/portal/listings.ts and
// src/portal/image-migration.ts) and the admin tasks (a workflow's OIDC token, src/admin-tasks.ts): one
// implementation of import, save/publish, move to another studio and the image migration, whoever asks.
import { fail } from './app.ts';
import type { Db, Listing, Studio } from './db.ts';
import { migrateListingImages, type MigrationResult } from './image-migration.ts';
import { importListings, type ExportedPage, type ImportResult, type Override } from './listings-import.ts';
import { changedFields, problems, type ListingFields } from './listings.ts';
import type { Storage } from './storage.ts';

export type ListingRow = Listing & { studio_slug: string; studio_name: string };

// A site (or other) base address, without its trailing slash.
export function baseUrl(v: unknown, message = 'The site address should start with https://.'): string {
  const base = String(v ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(base)) fail(400, message);
  return base;
}

// ---------- import ----------
// `pages` is vault-rebuild's migration/games-export.json and `overrides` its migration/import-overrides.json
// ({ overrides, studios }), each as parsed JSON or as the text of the file.
export function importFromExport(db: Db, pages: unknown, overrides: unknown, actor: string, opts: { only?: string[]; dryRun?: boolean } = {}): ImportResult {
  const parse = (v: unknown, what: string) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { fail(400, `${what} isn’t valid JSON.`); } };
  const list = parse(pages, 'games-export.json') as ExportedPage[];
  const ov = (overrides ? parse(overrides, 'import-overrides.json') : {}) as { overrides?: Record<string, Override>; studios?: Record<string, string> };
  if (!Array.isArray(list)) fail(400, 'games-export.json should be a list of pages.');
  return importListings(db, list, ov?.overrides ?? {}, actor, ov?.studios ?? {}, opts);
}

// ---------- save, publish ----------
export const cdnReady = (db: Db, l: { game_id: number | null }) => !!(l.game_id && db.currentRelease(l.game_id));

// What stops this draft from being saved (or, with forPublish, from going on the site).
export function draftProblems(db: Db, l: { game_id: number | null }, draft: ListingFields, forPublish: boolean): string[] {
  return problems(draft, { forPublish, cdnReady: cdnReady(db, l) });
}

// Save a checked draft, then publish it (Vault), submit it for review (a studio) or leave it a draft.
export function saveListing(db: Db, l: ListingRow, draft: ListingFields, actor: string, then: 'publish' | 'submit' | 'save') {
  const target = `${l.studio_slug}:${l.slug}`;
  db.saveListingDraft(l.id, draft, actor);
  db.audit(actor, 'listing.save', target, { fields: changedFields(l.draft, draft) });
  if (then === 'publish') { db.publishListing(l.id, actor); db.audit(actor, 'listing.publish', target, { fields: changedFields(l.published, draft) }); }
  else if (then === 'submit') { db.setListingReview(l.id, 'submitted', actor, null); db.audit(actor, 'listing.submit', target); }
}

// Publish the draft as it stands.
export function publishListing(db: Db, l: ListingRow, actor: string) {
  const bad = draftProblems(db, l, l.draft, true);
  if (bad.length) fail(400, bad.join(' '));
  db.publishListing(l.id, actor);
  db.audit(actor, 'listing.publish', `${l.studio_slug}:${l.slug}`, { fields: changedFields(l.published, l.draft) });
}

// ---------- move to another studio ----------
// The listing's CDN link is dropped (CDN games belong to a studio), so a listing hosted on the CDN can't move.
export function moveListingToStudio(db: Db, l: ListingRow, from: Studio, to: Studio, actor: string, opts: { dryRun?: boolean } = {}) {
  if (to.id === from.id) fail(400, `${l.draft.title || l.slug} already belongs to ${from.name}.`);
  if (l.game_id && (l.draft.play_source === 'cdn' || l.published?.play_source === 'cdn'))
    fail(400, `It is hosted on ${from.name}’s Vault CDN game. Switch it back to its web address first.`);
  // "Made by" that just named the old studio follows the game; anything else (co-makers, a person) is kept.
  const rename = (f: ListingFields): ListingFields => (f.makers.length === 1 && f.makers[0] === from.name ? { ...f, makers: [to.name] } : f);
  const draft = rename(l.draft), published = l.published ? rename(l.published) : null;
  const unlinked = l.game_id ? { unlinked_game: l.game_id } : {};
  if (!opts.dryRun) {
    db.moveListing(l.id, to.id, draft, published, actor);
    db.audit(actor, 'listing.move', l.slug, { from: from.slug, to: to.slug, ...unlinked });
  }
  return { slug: l.slug, from: from.slug, to: to.slug, makers: { from: (l.published ?? l.draft).makers, to: (published ?? draft).makers }, ...unlinked };
}

// ---------- copy site images to the Vault CDN ----------
export const LAST_MIGRATION_KEY = 'listing_image_migration';
const migrating = new WeakSet<Db>();

// One run at a time per database. A real run's result is kept in settings (Vault → Site games shows it).
export async function copySiteImages(deps: { db: Db; production: Storage | null; prodPublicUrl: string; fetch?: typeof fetch }, base: string, actor: string,
  opts: { dryRun?: boolean; budgetMs?: number } = {}): Promise<MigrationResult> {
  const { db } = deps;
  if (!deps.production) fail(503, 'The Vault CDN storage isn’t configured here, so images can’t be copied.');
  if (migrating.has(db)) fail(409, 'A copy is already running; try again in a minute.');
  migrating.add(db);
  try {
    const r = await migrateListingImages({ db, production: deps.production, prodPublicUrl: deps.prodPublicUrl, base, actor, fetch: deps.fetch, ...opts });
    if (!opts.dryRun) db.setSetting(LAST_MIGRATION_KEY, JSON.stringify(r));
    return r;
  } finally {
    migrating.delete(db);
  }
}
