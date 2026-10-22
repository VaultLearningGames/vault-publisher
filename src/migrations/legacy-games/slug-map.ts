// Which portal listing a games.json entry belongs to.
//
// games.json is keyed by the catalog slug (the listing's slug) — checked against the snapshot on
// 2026-10-21: the key is the listing slug, and its `path` is the game's old Squarespace address (the URL the
// site serves). The card's list of the 12 "path != slug" games is written long→short
// (wisdom-or-madness-of-crowds → crowds), i.e. catalog slug → legacy path; the definition plan's "legacy path
// → catalog slug" direction is inverted for this data, which the matcher detects and reports per game
// (match 'inverted') rather than assuming.
import type { LegacyGame } from './types.ts';

// Catalog slug → legacy path, the 12 games whose page address differs from the listing slug (measured in
// vault-site production 1883287). A file whose key is a listing slug but whose `path` differs from it is
// matched against this map: a missing entry or a different path is a warning (the import still uses the
// file's `path` — the file is the data, the map is the cross-check).
export const SLUG_TO_LEGACY_PATH: Record<string, string> = {
  'wisdom-or-madness-of-crowds': 'crowds',
  'plastic-pipeline': 'the-plastic-pipeline',
  'fiscal-ship': 'the-fiscal-ship',
  'pearl-diver': 'pearl',
  'counties-work': 'counties',
  'branches-of-power': 'branches',
  'convene-the-council': 'convene-council',
  'jo-wilder-and-the-capitol-case': 'jowilder',
  'lost-at-the-forever-mine': 'forever-mine',
  'wake-tales-from-the-aqualab': 'wake',
  'the-legend-of-the-lost-emerald': 'legend-of-the-lost-emerald',
  'bloom-the-saga-of-the-poop-economy': 'bloom',
};

export interface LegacyMatch {
  // The listing slug the entry imports into (the games.json key — or, 'inverted', the `path`).
  slug: string;
  // The legacy path (the old page address): the entry's `path`, or — inverted — the key.
  path: string;
  match: 'exact' | 'mapped' | 'inverted' | 'unmatched';
  warnings: string[];
}

// Match one games.json entry to a portal listing. `hasListing` is the portal's listings (db.listing).
//   exact:    the key is a listing and its `path` equals (or is absent for) it — the slug is the address.
//   mapped:   the key is a listing and its `path` differs — the 12; cross-checked against SLUG_TO_LEGACY_PATH.
//   inverted: the key is not a listing but its `path` is — the file's key/path direction is the opposite of
//             what this map assumes; reported, and the match still holds (the slug is the `path`).
//   unmatched: neither is a listing. The import never creates a listing, so the entry is skipped (a warning).
export function matchLegacyEntry(key: string, entry: LegacyGame, hasListing: (slug: string) => boolean): LegacyMatch {
  const rawPath = typeof entry.path === 'string' ? entry.path.trim().toLowerCase() : '';
  const warnings: string[] = [];

  if (hasListing(key)) {
    if (!rawPath || rawPath === key) {
      if (!rawPath) warnings.push(`no “path” in the snapshot: the page address is its slug (${key}).`);
      return { slug: key, path: rawPath || key, match: rawPath && rawPath !== key ? 'mapped' : 'exact', warnings };
    }
    const mapped = SLUG_TO_LEGACY_PATH[key];
    if (mapped === undefined) warnings.push(`the path “${rawPath}” differs from the slug, but the slug is not in the 12 known path≠slug games.`);
    else if (mapped !== rawPath) warnings.push(`the path “${rawPath}” differs from the slug, but the known map says “${mapped}”.`);
    return { slug: key, path: rawPath, match: 'mapped', warnings };
  }

  if (rawPath && hasListing(rawPath)) {
    return {
      slug: rawPath, path: key, match: 'inverted',
      warnings: [`the snapshot key “${key}” is not a listing but its path “${rawPath}” is: the file's key/path direction is inverted for this game; matched on the path.`],
    };
  }

  return { slug: key, path: rawPath || key, match: 'unmatched', warnings: [`no portal listing for “${key}” (the import never creates games).`] };
}
