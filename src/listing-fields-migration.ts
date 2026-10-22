// One-time (and safely repeatable) backfill of the listing's card and SEO fields from the Squarespace snapshot
// (vault-site's data/squarespace/games.json, keyed by the listing's slug): the card's title and excerpt, its
// categories and tags (reconciled from the old "Grades 5-8" / "Dev: Field Day Lab" / "Subject: Science" /
// "Topic: Civics" strings onto the portal's option lists, listing-enums.ts), the SEO title and description, the
// old page addresses that 301 to the listing (the entries whose path differs from the slug), and the listing's
// date (the record's created date; the site sorts the cards newest-first by it).
//
// - It only fills fields that are empty: a card a person has already written is never overwritten, which is also
//   what makes a second run a no-op. The date is set from the snapshot while it differs; after the run it matches.
// - Unmatched strings (a "Dev: …" with no such studio, a tag with no kind) are reported, never guessed: they go
//   to docs/listing-enum-reconciliation.md for review, and the card is left empty where nothing matched.
// - A dry run (`dryRun`) reports what would change and writes nothing. The result is kept in settings, like card
//   A's image migration.
import type { Db } from './db.ts';
import { fail } from './app.ts';
import { normalize, type ListingFields } from './listings.ts';
import { CARD_CATEGORY_KINDS, CARD_TAG_KINDS, normalizeEnumValue, parseCardString, reconcile, studioOptions, type CardTag, type CardTagKind, type EnumOption } from './portal/listing-enums.ts';

// One game of the snapshot (the fields this migration reads; the rest — sections, card_image, … — belong to the
// site's own cards work).
interface SquarespaceGame {
  path?: unknown;
  date?: unknown;
  card_title?: unknown;
  card_excerpt?: unknown;
  card_categories?: unknown;
  card_tags?: unknown;
  seo_title?: unknown;
  seo_description?: unknown;
}

export interface FieldMigrationItem {
  slug: string;
  fields: string[];      // the fields the run fills (card_title, card_excerpt, card_categories, card_tags, seo_title, seo_description, aliases)
  date?: { from: string; to: string };
}
export interface FieldMigrationResult {
  ran_at: string;
  by: string;
  updated: FieldMigrationItem[];
  unchanged: number;
  no_listing: number;    // snapshot entries with no listing here (a game not on the portal's site)
  unmatched: { string: string; games: string[] }[];
  dry_run?: boolean;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

// The old card strings of one kind onto the option list: each matched string becomes a { kind, value } tag (in the
// card's own order); the unmatched ones are reported, per string, with the games that carried them.
function tagsFrom(strings: string[], kinds: readonly CardTagKind[], opts: { studios?: EnumOption[] }, unmatched: Map<string, string[]>, slug: string): CardTag[] {
  const out: CardTag[] = [];
  for (const s of strings) {
    const { kind, value } = parseCardString(s);
    const k = kind ?? kinds.find((c) => normalizeEnumValue(c, value, opts) !== null) ?? null;
    const v = k ? normalizeEnumValue(k, value, opts) : null;
    if (k === null || v === null || !kinds.includes(k)) {
      unmatched.set(s, [...(unmatched.get(s) ?? []), slug]);
      continue;
    }
    if (!out.some((t) => t.kind === k && t.value === v)) out.push({ kind: k, value: v });
  }
  return out;
}

export function migrateListingFields(db: Db, gamesIn: unknown, actor: string, opts: { dryRun?: boolean } = {}): FieldMigrationResult {
  const games = (typeof gamesIn === 'string' ? (() => { try { return JSON.parse(gamesIn); } catch { fail(400, 'games isn’t valid JSON.'); } })() : gamesIn);
  const root = games && typeof games === 'object' && !Array.isArray(games) && games.games && typeof games.games === 'object' && !Array.isArray(games.games) ? games.games : games;
  if (!root || typeof root !== 'object' || Array.isArray(root)) fail(400, 'games should be data/squarespace/games.json (its “games” object: slug → entry).');

  const studios = studioOptions(db);
  const updated: FieldMigrationItem[] = [];
  const unmatched = new Map<string, string[]>();
  let unchanged = 0, noListing = 0;

  for (const [slug, entryIn] of Object.entries(root).sort(([a], [b]) => a.localeCompare(b))) {
    const e = (entryIn ?? {}) as SquarespaceGame;
    const l = db.listing(slug);
    if (!l) { noListing++; continue; }

    const changes: Partial<ListingFields> = {};
    const cardTitle = str(e.card_title, 200);
    const cardExcerpt = str(e.card_excerpt, 600);
    const seoTitle = str(e.seo_title, 300);
    const seoDescription = str(e.seo_description, 600);
    if (cardTitle && !l.draft.card_title) changes.card_title = cardTitle;
    if (cardExcerpt && !l.draft.card_excerpt) changes.card_excerpt = cardExcerpt;
    if (seoTitle && !l.draft.seo_title) changes.seo_title = seoTitle;
    if (seoDescription && !l.draft.seo_description) changes.seo_description = seoDescription;
    if (!(l.draft.card_categories ?? []).length) {
      const tags = tagsFrom(strList(e.card_categories), CARD_CATEGORY_KINDS, { studios }, unmatched, slug);
      if (tags.length) changes.card_categories = tags;
    }
    if (!(l.draft.card_tags ?? []).length) {
      const tags = tagsFrom(strList(e.card_tags), CARD_TAG_KINDS, { studios }, unmatched, slug);
      if (tags.length) changes.card_tags = tags;
    }
    const path = str(e.path, 200).toLowerCase();
    if (!(l.draft.aliases ?? []).length && path && path !== slug) changes.aliases = [path];

    const dateTo = str(e.date, 40);
    const date = dateTo && !Number.isNaN(Date.parse(dateTo)) ? new Date(Date.parse(dateTo)).toISOString() : null;
    const dateChange = date && l.created_at !== date ? { from: l.created_at, to: date } : undefined;

    if (!Object.keys(changes).length && !dateChange) { unchanged++; continue; }
    const item: FieldMigrationItem = { slug, fields: Object.keys(changes).sort(), ...(dateChange ? { date: dateChange } : {}) };
    updated.push(item);
    if (!opts.dryRun) {
      // Drafts and published listings get the same backfill (like card A's images): the same card, so no new review.
      // Old listings saved before the fields existed normalize to the same values a save would keep.
      const base = normalize({}, l.draft);
      const newDraft = { ...base, ...changes } as ListingFields;
      const newPublished = l.published ? ({ ...normalize({}, l.published), ...changes } as ListingFields) : null;
      db.setListingContent(l.id, newDraft, newPublished);
      if (dateChange) db.setListingDate(l.id, dateChange.to);
      db.audit(actor, 'listing.migrate-fields', slug, { fields: item.fields, date: dateChange ?? null, via: 'fields migration' });
    }
  }

  return {
    ran_at: new Date().toISOString(),
    by: actor,
    updated,
    unchanged,
    no_listing: noListing,
    unmatched: [...unmatched.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([s, games]) => ({ string: s, games: [...new Set(games)].sort() })),
    ...(opts.dryRun ? { dry_run: true } : {}),
  };
}
