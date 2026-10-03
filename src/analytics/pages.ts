// A game's addresses on the website, for its page views in Google Analytics (docs/analytics.md, "History"). The site
// puts a listing's page at /<path>/, where path is the game's old Squarespace address from the temporary
// site/data/squarespace/games.json (keyed by catalog slug), else its slug (site/content/games/_content.gotmpl).
// Squarespace served the same page without the slash, and each game's Game Card at /game-cards/<card id> (now a 301
// to the page), so the property's years of history are under all of these.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Legacy = Record<string, { path?: string; card_id?: string }>;
const GAMES_JSON = fileURLToPath(new URL('../../site/data/squarespace/games.json', import.meta.url));

export function loadLegacy(file = GAMES_JSON): Legacy {
  try { return (JSON.parse(readFileSync(file, 'utf8')) as { games?: Legacy }).games ?? {}; } catch { return {}; }
}

export function pagePaths(slug: string, legacy: Legacy): string[] {
  const g = legacy[slug], p = g?.path || slug;
  return [`/${p}`, `/${p}/`, ...(g?.card_id ? [`/game-cards/${g.card_id}`, `/game-cards/${g.card_id}/`] : [])];
}
