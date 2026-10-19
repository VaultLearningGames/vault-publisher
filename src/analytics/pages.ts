// A game's addresses on the website, for its page views in Google Analytics (docs/analytics.md, "History"). The site
// puts a listing's page at /<path>/, where path is the game's old Squarespace address from the temporary
// data/squarespace/games.json in vault-site (keyed by catalog slug; found by site-dir.ts), else its slug (vault-site's
// content/games/_content.gotmpl).
// Squarespace served the same page without the slash, and each game's Game Card at /game-cards/<card id> (now a 301
// to the page), so the property's years of history are under all of these.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSiteDir } from '../site-dir.ts';

export type Legacy = Record<string, { path?: string; card_id?: string }>;

// Without vault-site (or the file), every game is at its slug.
export function loadLegacy(file?: string): Legacy {
  try {
    const path = file ?? join(resolveSiteDir(), 'data', 'squarespace', 'games.json');
    return (JSON.parse(readFileSync(path, 'utf8')) as { games?: Legacy }).games ?? {};
  } catch { return {}; }
}

export function pagePaths(slug: string, legacy: Legacy): string[] {
  const g = legacy[slug], p = g?.path || slug;
  return [`/${p}`, `/${p}/`, ...(g?.card_id ? [`/game-cards/${g.card_id}`, `/game-cards/${g.card_id}/`] : [])];
}
