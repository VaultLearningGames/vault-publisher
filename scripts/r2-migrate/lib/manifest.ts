// The migration manifest: one entry per no-pipeline game, checked in so the copy and the portal
// URL flip stay in one place. `status` is "pending" until a copy has been verified over the public
// URL; the portal entry for a game should only point at R2 only once its status is "verified".
import { readFile, writeFile } from 'node:fs/promises';
import { isSlug } from '../../../src/paths.ts';
import { keyFor } from './mapping.ts';

export type ManifestStatus = 'pending' | 'verified';

export interface ManifestGame {
  slug: string;                       // --game <slug>
  displayName: string;                // the name the card/portal uses
  doitUrl: string;                    // where the game plays from today (the URL copied from the portal data)
  r2Prefix: string;                   // the CDN key prefix, e.g. "fieldday/jowilder/doit"
  entryFile: string;                  // the page the play URL ends in (default "index.html")
  status: ManifestStatus;
}

// The manifest file is a JSON array of ManifestGame.
export function parseManifest(raw: unknown): ManifestGame[] {
  if (!Array.isArray(raw)) throw new Error('the manifest must be a JSON array of games');
  const seen = new Set<string>();
  return raw.map((g, i) => {
    if (typeof g !== 'object' || g === null) throw new Error(`manifest entry ${i} is not an object`);
    const e = g as Record<string, unknown>;
    for (const field of ['slug', 'displayName', 'doitUrl', 'r2Prefix', 'entryFile', 'status'] as const) {
      if (typeof e[field] !== 'string' || e[field] === '') throw new Error(`manifest entry ${i} is missing "${field}"`);
    }
    if (!isSlug(e.slug as string)) throw new Error(`manifest entry ${i} has a bad slug "${e.slug}"`);
    if (seen.has(e.slug as string)) throw new Error(`manifest has two entries for "${e.slug}"`);
    seen.add(e.slug as string);
    if (!/^https?:\/\//i.test(e.doitUrl as string)) throw new Error(`manifest "${e.slug}": doitUrl must be a http(s) URL`);
    if (e.status !== 'pending' && e.status !== 'verified') {
      throw new Error(`manifest "${e.slug}": status must be "pending" or "verified"`);
    }
    keyFor(e.r2Prefix as string, e.entryFile as string); // throws on bad prefix or entry file
    return {
      slug: e.slug as string,
      displayName: e.displayName as string,
      doitUrl: e.doitUrl as string,
      r2Prefix: (e.r2Prefix as string).replace(/\/+$/, ''),
      entryFile: e.entryFile as string,
      status: e.status as ManifestStatus,
    };
  });
}

export async function loadManifest(file: string): Promise<ManifestGame[]> {
  return parseManifest(JSON.parse(await readFile(file, 'utf8')));
}

export function findGame(games: ManifestGame[], slug: string): ManifestGame {
  const game = games.find((g) => g.slug === slug);
  if (!game) {
    throw new Error(`unknown game "${slug}" — the manifest has: ${games.map((g) => g.slug).join(', ')}`);
  }
  return game;
}

// The play URL the portal entry gets once the copy is verified: the public base URL, the prefix, the entry file.
export function playUrl(game: ManifestGame, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${keyFor(game.r2Prefix, game.entryFile)}`;
}

// Flip one game to "verified" in the manifest file (after its copy passed verification).
// Returns true when the file changed.
export async function markVerified(file: string, slug: string): Promise<boolean> {
  const games = await loadManifest(file);
  const game = findGame(games, slug);
  if (game.status !== 'verified') {
    game.status = 'verified';
    await writeFile(file, JSON.stringify(games, null, 2) + '\n', 'utf8');
    return true;
  }
  return false;
}
