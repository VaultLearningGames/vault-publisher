// Where the three copies of the wrapper live, and whether they are all there yet.
//
// Analytics.3c compares the shared template's outer page with Jo Wilder's and Lost Emerald's per-game overrides. Those
// files are written by sibling cards (Analytics.2 the template, 3a and 3b the two overrides), so this module knows the
// paths to look in and — just as importantly — says plainly when one of them is not there yet, so the check reports a
// missing dependency instead of silently comparing nothing and calling it a pass.
//
// Pure: every path is resolved against a reader the caller supplies, so the search is testable without those files
// existing and without touching the repository.
import { blockMatches, compareBlocks, type BlockDiff } from './channel-edge-cases.ts';

/** Reads a repository path, or null when it isn't there. Never throws. */
export type FileReader = (path: string) => string | null;

/** The shared snippet every wrapper's inner frame carries (Analytics.1a; the only one of the four that exists today). */
export const SNIPPET_PATH = 'src/cdn/vault-channel.js';

/** The games this card reconciles, by catalog slug, with the CDN folder each is served from. */
export const GAMES = [
  { slug: 'jo-wilder', cdn: 'fieldday/jowilder', aka: ['jowilder', 'jo-wilder-and-the-capitol-case'] },
  { slug: 'the-legend-of-the-lost-emerald', cdn: 'fieldday/lostemerald', aka: ['lostemerald', 'lost-emerald', 'legend-of-the-lost-emerald'] },
] as const;

export type GameSlug = (typeof GAMES)[number]['slug'];

/** Where Analytics.2's shared template may have been put, most likely first. */
export const TEMPLATE_PATHS = [
  'src/cdn/templates/index.html',
  'src/cdn/templates/wrapper/index.html',
  'src/cdn/template/index.html',
  'src/cdn/wrapper/index.html',
  'src/cdn/index.html',
];

/** Where a game's own override of the outer page may have been put, most likely first. */
export function overridePaths(cdn: string): string[] {
  return [
    `src/cdn/games/${cdn}/index.html`,
    `src/cdn/overrides/${cdn}/index.html`,
    `src/cdn/${cdn}/index.html`,
    `cdn/${cdn}/index.html`,
  ];
}

/** Where a game's inner frame may have been put (for the marker-block regression check). */
export function innerPaths(cdn: string): string[] {
  return overridePaths(cdn).map((p) => p.replace(/index\.html$/, 'iframe.html'));
}

/** A file that was looked for: what was found and where, or every path tried. */
export interface FoundFile {
  path: string | null;
  text: string | null;
  tried: string[];
}

/** The first of `paths` that exists. */
export function findFirst(read: FileReader, paths: string[]): FoundFile {
  for (const path of paths) {
    const text = read(path);
    if (text !== null) return { path, text, tried: paths };
  }
  return { path: null, text: null, tried: paths };
}

/** Everything the check needs, or the reason it cannot run. */
export interface Located {
  snippet: FoundFile;
  template: FoundFile;
  games: { slug: GameSlug; cdn: string; outer: FoundFile; inner: FoundFile }[];
  /** Why the comparison cannot be made (which dependency is missing), or null. */
  gate: string | null;
}

/** The missing-dependency sentence for a file that wasn't found. */
const missing = (what: string, card: string, file: FoundFile) =>
  `${what} is not in this worktree (looked in ${file.tried.map((p) => `\`${p}\``).join(', ')}). ` +
  `It is written by **${card}**, which has not landed on this branch yet: this card is serialized after it and must not re-implement it.`;

/** Finds the snippet, the template and both games' overrides, and gates when any is missing. */
export function locateWrappers(read: FileReader): Located {
  const snippet = findFirst(read, [SNIPPET_PATH]);
  const template = findFirst(read, TEMPLATE_PATHS);
  const games = GAMES.map((g) => ({
    slug: g.slug,
    cdn: g.cdn,
    outer: findFirst(read, overridePaths(g.cdn)),
    inner: findFirst(read, innerPaths(g.cdn)),
  }));
  const reasons: string[] = [];
  if (snippet.text === null) reasons.push(missing('The shared snippet `src/cdn/vault-channel.js`', 'Analytics.1a: vault-channel.js core', snippet));
  if (template.text === null) reasons.push(missing('The shared wrapper template', 'Analytics.2: include vault-channel.js in the generated wrappers', template));
  for (const game of games) {
    const card = game.slug === 'jo-wilder'
      ? 'Analytics.3a: Jo Wilder: make the per-game inline channel block defer to the shared snippet'
      : 'Analytics.3b: Lost Emerald: keep page_referrer from vault_src, take the channel from the shared snippet';
    if (game.outer.text === null) reasons.push(missing(`${game.slug}'s per-game outer wrapper (\`${game.cdn}/index.html\`)`, card, game.outer));
  }
  return { snippet, template, games, gate: reasons.length ? reasons.join('\n\n') : null };
}

/**
 * The marker-block comparison of one game's inner frame against the shared snippet: AC3's regression check that
 * 3a/3b held. Analytics.4d's compareBlocks does the diffing, so "no diff" means exactly here what it means there
 * (identical, or identical but for the indent the block is inlined at).
 */
export function blockOf(inner: FoundFile, snippet: FoundFile): BlockDiff {
  return compareBlocks(inner.text, snippet.text, inner.path ?? `the override (looked in ${inner.tried.join(', ')})`, SNIPPET_PATH);
}

/** Whether a game's inner frame still carries the shared snippet's block unchanged. */
export const blockHeld = (diff: BlockDiff) => blockMatches(diff);
