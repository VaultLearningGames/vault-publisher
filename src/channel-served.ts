// Analytics.4b: the DEPLOYED staging CDN artifacts, grepped layer by layer.
//
// The question this answers is not "is the snippet in the repository" (Analytics.4a's gate did that against
// `origin/staging`) but "is the snippet in the bytes the staging CDN actually hands a browser": the deployed file is
// the evidence, never the template source. So every judgement here is made about a fetched document —
// `https://cdn.vaultlearninggames-staging.org/STUDIO/GAME/index.html`, the `iframe.html` that page frames, and any
// further hop that one frames — and three patterns are counted in each layer:
//
//   1. `VAULT_CHANNEL_LOGIC_START` — the marker the shared block is delimited by;
//   2. `vaultResolveChannel`      — the resolver itself;
//   3. the alias table, whose sentinel entry is `pbswi` → `pbswisconsineducation.org`.
//
// Plus one thing a grep cannot see on its own: that each layer forwards the source params to the next one UNCHANGED
// (the inner frame's `src` still carries `vault_ch` with the same value), because a wrapper that carries the snippet
// but drops the parameter reports the wrong channel just as surely as one with no snippet at all.
//
// Everything here is pure, or takes its fetching as an argument (`Fetcher`), so what counts as a layer, as a hit and
// as identical forwarding is testable without the network. Nothing in this module writes anything: a game whose
// deployed artifact lacks the snippet or the alias table at any layer becomes a named blocker against
// SNIPPET_CARD — the fix belongs to the card that ships the snippet to all 23 CDN games, never to this verification.
import { MARKER_START, RELEASE_CARD } from './channel-edge-cases.ts';
import { SNIPPET_CARD, STAGING_CDN_BASE } from './channel-release-gate.ts';
import { CHANNEL_PARAM, REFERRER_PARAM } from './channel-runtime.ts';
import { LEGACY_REFERRER_PARAM, UTM_PREFIX } from './channel-forwarding.ts';

export { MARKER_START, RELEASE_CARD, SNIPPET_CARD, STAGING_CDN_BASE };

/** Where this card's evidence is recorded, beside its siblings'. */
export const VERIFICATION_DOC = 'docs/verification/analytics-4b-staging-cdn-grep.md';

/** The catalog the publisher serves, which is the CDN game list this card reads from (never a hand-written one). */
export const CATALOG_PATH = '/v1/catalog';

// ---------- the CDN game list, from the publisher's own catalog ----------

/** A catalog entry, as `GET /v1/catalog` serves it (only the fields this card reads). */
export interface CatalogGame {
  slug: string;
  title?: string;
  play?: { url?: string | null; source?: string | null } | null;
}

/** A CDN-hosted game: the slug the report names it by, and the folder the publisher says it plays from. */
export interface CdnGame {
  slug: string;
  title: string;
  /** The folder, always ending in "/": "https://cdn…/fieldday/yardgames/bacteria/". */
  base: string;
  /** The path inside the CDN: "fieldday/yardgames/bacteria". */
  path: string;
  /** Whether this is one of The Yard's games (the list's own marker: the `yardgames` path segment). */
  yardgame: boolean;
}

/** The game the card names outright: it must be one of the three. */
export const REQUIRED_SLUG = 'the-legend-of-the-lost-emerald';
/** The CDN path segment that marks a game as The Yard's, as the publisher's own list spells it. */
export const YARDGAME_SEGMENT = 'yardgames';

/** The folder a CDN game plays from, as the catalog gives it: trailing slash, no query, no `index.html`. */
export function cdnFolder(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/(?:index|iframe)\.html$/i, '').replace(/\/*$/, '/');
  return parsed.toString();
}

/** The CDN path of a folder address ("fieldday/yardgames/bacteria"), or '' when it has none. */
export function cdnPathOf(base: string): string {
  try { return new URL(base).pathname.replace(/^\/+|\/+$/g, ''); } catch { return ''; }
}

/**
 * Every CDN-hosted game of the catalog, in catalog order: the ones the publisher says are played from `base`
 * (`play.source === 'cdn'`). A game played from a studio's own site is not this card's (and neither are the 80
 * external-studio games, which never appear here).
 */
export function cdnGames(games: readonly CatalogGame[], base = STAGING_CDN_BASE): CdnGame[] {
  const root = `${base.replace(/\/+$/, '')}/`;
  const out: CdnGame[] = [];
  for (const g of games) {
    if (g.play?.source !== 'cdn') continue;
    const folder = g.play?.url ? cdnFolder(g.play.url) : null;
    if (!folder || !folder.startsWith(root)) continue;
    const path = cdnPathOf(folder);
    out.push({ slug: g.slug, title: g.title ?? g.slug, base: folder, path, yardgame: path.split('/').includes(YARDGAME_SEGMENT) });
  }
  return out;
}

/** Whether a CDN game is an "ordinary" one: neither the named game nor one of The Yard's. */
export const isOrdinary = (g: CdnGame) => g.slug !== REQUIRED_SLUG && !g.yardgame;

/** The three roles the card's three games fill. */
export type Role = 'named' | 'yardgame' | 'ordinary';

/** What the report calls each role. */
export const ROLE_WHAT: Record<Role, string> = {
  named: `the game the card names (\`${REQUIRED_SLUG}\`)`,
  yardgame: 'one of The Yard\'s games (a `yardgames` path segment in the publisher\'s list)',
  ordinary: 'one further ordinary CDN game (neither of the above)',
};

/**
 * Every game in the list that could fill each role, in a reproducible order (alphabetical by slug), so the choice is
 * made FROM the list and a candidate whose artifact turns out not to be deployed at all can be stepped past —
 * reporting the one it stepped past, never hiding it.
 */
export function candidates(games: readonly CdnGame[]): Record<Role, CdnGame[]> {
  const alpha = [...games].sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    named: alpha.filter((g) => g.slug === REQUIRED_SLUG),
    yardgame: alpha.filter((g) => g.yardgame),
    ordinary: alpha.filter((g) => isOrdinary(g)),
  };
}

/** The three games chosen, or why they could not be. */
export interface Selection {
  games: CdnGame[];
  /** How each was chosen, in the report's words. */
  why: string[];
  /** A candidate the choice stepped past, and why — never silently dropped. */
  skipped: { game: CdnGame; role: Role; reason: string }[];
  /** Why the card's three could not be picked from the list, or null. */
  problem: string | null;
}

/**
 * The card's three games, picked FROM THE LIST and not by hand: Lost Emerald, one of The Yard's games, and one more
 * ordinary CDN game. The last two are the first alphabetically by slug, so a second run picks the same three.
 * `wanted` (from `--games`) overrides the choice, and is checked against the list all the same.
 */
export function pickGames(games: readonly CdnGame[], wanted: readonly string[] = []): Selection {
  if (!games.length) {
    return { games: [], why: [], skipped: [], problem: 'the publisher\'s CDN game list is empty: there is nothing to verify, and this card never hand-writes a list' };
  }
  const bySlug = new Map(games.map((g) => [g.slug, g]));
  if (wanted.length) {
    const missing = wanted.filter((s) => !bySlug.has(s));
    if (missing.length) {
      return { games: [], why: [], skipped: [], problem: `${missing.map((s) => `\`${s}\``).join(', ')} is not a CDN game in the publisher's list (${games.length} game(s) there)` };
    }
    const picked = wanted.map((s) => bySlug.get(s) as CdnGame);
    return { games: picked, why: picked.map((g) => `${g.slug}: named with --games`), skipped: [], problem: null };
  }
  const by = candidates(games);
  const problems: string[] = [];
  if (!by.named.length) problems.push(`\`${REQUIRED_SLUG}\` is not in the publisher's CDN game list, and the card requires it`);
  if (!by.yardgame.length) problems.push(`no game in the list has a \`${YARDGAME_SEGMENT}\` path segment, so no yardgame could be picked`);
  if (!by.ordinary.length) problems.push('the list has no further ordinary CDN game (one that is neither Lost Emerald nor a yardgame)');
  if (problems.length) return { games: [], why: [], skipped: [], problem: problems.join('; ') };
  const picked = (['named', 'yardgame', 'ordinary'] as Role[]).map((role) => by[role][0]);
  return {
    games: picked,
    why: picked.map((g, i) => `${g.slug}: ${ROLE_WHAT[(['named', 'yardgame', 'ordinary'] as Role[])[i]]}, first of ${by[(['named', 'yardgame', 'ordinary'] as Role[])[i]].length} in list order (\`${g.path}\`)`),
    skipped: [],
    problem: null,
  };
}

/** Whether a candidate's outer page is deployed at all; a 404 means the artifact to grep is not there. */
export type Probe = (game: CdnGame) => Promise<{ status: number | null; error: string | null }>;

/**
 * The card's three games, each the first candidate in list order whose OUTER page is actually served. A candidate
 * whose `index.html` 404s has no deployed artifact to grep: it is recorded in `skipped` (and reported as a blocker
 * by name, like any other missing artifact) and the choice moves to the next candidate of that role, so the card
 * still verifies three games that exist on the CDN instead of reporting three 404s and nothing else.
 */
export async function selectServedGames(games: readonly CdnGame[], probe: Probe): Promise<Selection> {
  const first = pickGames(games);
  if (first.problem) return first;
  const by = candidates(games);
  const roles: Role[] = ['named', 'yardgame', 'ordinary'];
  const picked: CdnGame[] = [];
  const why: string[] = [];
  const skipped: Selection['skipped'] = [];
  const problems: string[] = [];
  for (const role of roles) {
    let chosen: CdnGame | null = null;
    for (const candidate of by[role]) {
      if (picked.some((g) => g.base === candidate.base)) continue;
      const got = await probe(candidate);
      if (got.status === 200) { chosen = candidate; break; }
      skipped.push({
        game: candidate, role,
        reason: got.error ? `its outer page could not be fetched (${got.error})` : `its outer page answers HTTP ${got.status}: no deployed artifact to grep`,
      });
    }
    if (!chosen) {
      problems.push(`no ${ROLE_WHAT[role]} has a served outer page on the CDN (tried ${by[role].map((g) => `\`${g.slug}\``).join(', ') || 'none'})`);
      continue;
    }
    picked.push(chosen);
    why.push(`${chosen.slug}: ${ROLE_WHAT[role]}, first of ${by[role].length} in list order whose outer page is served (\`${chosen.path}\`)`);
  }
  return { games: picked, why, skipped, problem: problems.length ? problems.join('; ') : null };
}

// ---------- the three patterns, counted in the served bytes ----------

/** The resolver the shared snippet defines, and every wrapper layer is expected to have. */
export const RESOLVER_PATTERN = 'vaultResolveChannel';
/** The alias table's sentinel entry, which is how a table is told from a stray mention of a partner. */
export const ALIAS_KEY = 'pbswi';
export const ALIAS_VALUE = 'pbswisconsineducation.org';

/** `pbswi: 'pbswisconsineducation.org'`, quoted or bare on the key, in either direction. */
export const ALIAS_PATTERNS: readonly RegExp[] = [
  /['"]?pbswi['"]?\s*:\s*['"]pbswisconsineducation\.org['"]/g,
  /['"]?pbswisconsineducation\.org['"]?\s*:\s*['"]pbswi['"]/g,
];

/** How many times `needle` occurs in `text` (case-sensitive, overlapping occurrences not counted twice). */
export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) count++;
  return count;
}

/** How many times any of `patterns` matches: the alias table's hit count. */
export function countPatterns(text: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const re of patterns) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    count += [...text.matchAll(global)].length;
  }
  return count;
}

/** The three hit counts the card's table reports for one layer. */
export interface Hits {
  /** `VAULT_CHANNEL_LOGIC_START`. */
  marker: number;
  /** `vaultResolveChannel`. */
  resolver: number;
  /** The `pbswi` → `pbswisconsineducation.org` alias entry. */
  alias: number;
}

/** The three counts in one served document; a document that could not be read counts zero of each. */
export function hitsIn(text: string | null): Hits {
  if (text === null) return { marker: 0, resolver: 0, alias: 0 };
  return {
    marker: countOccurrences(text, MARKER_START),
    resolver: countOccurrences(text, RESOLVER_PATTERN),
    alias: countPatterns(text, ALIAS_PATTERNS),
  };
}

/** Whether a layer carries all three: the marker block, the resolver and the alias table. */
export const hasSnippet = (h: Hits) => h.marker >= 1 && h.resolver >= 1 && h.alias >= 1;

/** Which of the three a layer is missing, in the report's words. */
export function missingPatterns(h: Hits): string[] {
  const out: string[] = [];
  if (h.marker < 1) out.push(`\`${MARKER_START}\``);
  if (h.resolver < 1) out.push(`\`${RESOLVER_PATTERN}\``);
  if (h.alias < 1) out.push(`the alias table (\`${ALIAS_KEY}\` → \`${ALIAS_VALUE}\`)`);
  return out;
}

// ---------- the layers of one game, as served ----------

/** One document fetched from the CDN: what was asked for, what came back, and what it contained. */
export interface Layer {
  /** What this layer is: 'index.html', 'iframe.html', or 'hop 2' for a frame inside the frame. */
  kind: string;
  /** The full address fetched, exactly as it was requested. */
  url: string;
  /** The address the response came from, after any redirect. */
  finalUrl: string;
  status: number | null;
  /** The three grep counts. */
  hits: Hits;
  /** The parameters on this layer's own address, name → value. */
  params: Record<string, string>;
  /** The `src` of the frame this layer builds for the next layer, raw and as resolved, or null when it frames none. */
  framed: { raw: string; url: string } | null;
  /** How many bytes came back (so "empty 200" is visible), or null. */
  bytes: number | null;
  /** Why this layer could not be fetched, or null. */
  error: string | null;
}

/** What one fetch answered. */
export interface Fetched {
  status: number | null;
  text: string | null;
  finalUrl: string;
  error: string | null;
}

/** How the layers are fetched; injected so the walk is testable without the network. */
export type Fetcher = (url: string) => Promise<Fetched>;

/** How deep the walk ever goes (index → iframe → two more hops), so a wrapper chain cannot loop forever. */
export const MAX_DEPTH = 4;

/** Every `<iframe src>` in a document, in order, raw (quotes stripped, entities for `&` decoded). */
export function iframeSrcs(html: string): string[] {
  const out: string[] = [];
  for (const [, attrs] of html.matchAll(/<iframe\b([^>]*)>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const value = src ? (src[1] ?? src[2] ?? src[3] ?? '').trim() : '';
    if (value) out.push(value.replace(/&amp;/g, '&'));
  }
  // A wrapper that sets the address from script (`iframe.src = "iframe.html" + …`) frames nothing in its markup, so
  // the literal the script assigns counts too: it is what the browser will load.
  for (const [, value] of html.matchAll(/\.src\s*=\s*["']([^"']*iframe\.html[^"']*)["']/gi)) out.push(value.replace(/&amp;/g, '&'));
  return [...new Set(out)];
}

/** The address a framed `src` resolves to against the page that framed it, or null when it is not an address. */
export function resolveFramed(src: string, pageUrl: string): string | null {
  if (!src || /^(?:about:|javascript:|data:)/i.test(src)) return null;
  try { return new URL(src, pageUrl).toString(); } catch { return null; }
}

/** The parameters on an address, name → value (the first when a name repeats). */
export function paramsOn(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  let search: URLSearchParams;
  try { search = new URL(url).searchParams; } catch { return out; }
  for (const [name, value] of search) if (!(name in out)) out[name] = value;
  return out;
}

/** The parameters that carry a play's source, and so must survive every hop unchanged. */
export const SOURCE_PARAMS: readonly string[] = [CHANNEL_PARAM, REFERRER_PARAM, LEGACY_REFERRER_PARAM];

/** The source parameters of a query (the three named ones plus every `utm_*`), name → value. */
export function sourceParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (SOURCE_PARAMS.includes(name) || name.startsWith(UTM_PREFIX)) out[name] = value;
  }
  return out;
}

/** What a layer is called in the table, by how deep it is. */
export function layerKind(depth: number, url: string): string {
  if (depth === 0) return 'index.html';
  const name = (() => { try { return new URL(url).pathname.split('/').pop() || 'hop'; } catch { return 'hop'; } })();
  if (depth === 1) return /iframe\.html$/i.test(name) ? 'iframe.html' : `hop 1 (${name})`;
  return `hop ${depth} (${name})`;
}

/**
 * Walks one game's layers as the CDN serves them: the outer `index.html`, the frame it builds, and any further hop,
 * stopping when a layer frames nothing, when a layer cannot be read, at MAX_DEPTH, or on an address already seen.
 * `query` is carried on the outer address only — every deeper layer's address is the one the served page itself
 * builds, which is exactly what the forwarding check needs to look at.
 */
export async function walkLayers(base: string, fetcher: Fetcher, query = '', maxDepth = MAX_DEPTH): Promise<Layer[]> {
  const first = `${base.replace(/\/*$/, '/')}index.html${query ? `?${query.replace(/^\?/, '')}` : ''}`;
  const layers: Layer[] = [];
  const seen = new Set<string>();
  let url: string | null = first;
  for (let depth = 0; url !== null && depth < maxDepth; depth++) {
    const here: string = url;
    if (seen.has(here)) break;
    seen.add(here);
    const got = await fetcher(here);
    const from = got.finalUrl || here;
    const srcs = got.text === null ? [] : iframeSrcs(got.text);
    const next = srcs.map((s) => ({ raw: s, url: resolveFramed(s, from) }))
      .find((f): f is { raw: string; url: string } => f.url !== null && !seen.has(f.url)) ?? null;
    layers.push({
      kind: layerKind(depth, here),
      url: here,
      finalUrl: from,
      status: got.status,
      hits: hitsIn(got.text),
      params: paramsOn(here),
      framed: next,
      bytes: got.text === null ? null : got.text.length,
      error: got.error,
    });
    url = next?.url ?? null;
  }
  return layers;
}

// ---------- does every layer forward the source params identically? ----------

export type ForwardVerdict = 'identical' | 'dropped' | 'changed' | 'none-to-forward' | 'single-layer';

/** How one game's layers compared on forwarding. */
export interface Forwarding {
  verdict: ForwardVerdict;
  /** The sentence the table's last column quotes. */
  reason: string;
  /** The source parameters the outer layer was given, name → value. */
  given: Record<string, string>;
}

const quote = (o: Record<string, string>) =>
  Object.entries(o).map(([k, v]) => `\`${k}=${v}\``).join(', ') || '(none)';

/**
 * Whether every layer passed the source params to the next one UNCHANGED. The outer address is the one this card
 * asked for; every deeper one is what the served page built, so a dropped or rewritten `vault_ch` shows up here as
 * 'dropped' or 'changed'. With nothing to forward (no probe query) there is nothing to compare, which is said as
 * such rather than passed off as a pass.
 */
export function forwardingAcross(layers: readonly Layer[]): Forwarding {
  const given = layers.length ? sourceParams(layers[0].params) : {};
  if (layers.length < 2) {
    return {
      verdict: 'single-layer',
      reason: layers.length ? 'only one layer was served, so nothing was forwarded anywhere' : 'no layer was served',
      given,
    };
  }
  if (!Object.keys(given).length) {
    return { verdict: 'none-to-forward', reason: 'the outer page was fetched with no source params, so there was nothing to forward', given };
  }
  for (let i = 1; i < layers.length; i++) {
    const want = sourceParams(layers[i - 1].params);
    const got = sourceParams(layers[i].params);
    const dropped = Object.keys(want).filter((k) => !(k in got));
    const changed = Object.keys(want).filter((k) => k in got && got[k] !== want[k]);
    if (dropped.length) {
      return {
        verdict: 'dropped',
        reason: `${layers[i - 1].kind} → ${layers[i].kind} drops ${dropped.map((k) => `\`${k}\``).join(', ')} (it forwards ${quote(got)})`,
        given,
      };
    }
    if (changed.length) {
      return {
        verdict: 'changed',
        reason: `${layers[i - 1].kind} → ${layers[i].kind} rewrites ${changed.map((k) => `\`${k}\`: \`${want[k]}\` → \`${got[k]}\``).join(', ')}`,
        given,
      };
    }
  }
  return { verdict: 'identical', reason: `every layer carries ${quote(given)} through unchanged`, given };
}

/** Whether the forwarding check came out right (nothing to forward is not a pass, and is not a blocker either). */
export const forwardingHolds = (f: Forwarding) => f.verdict === 'identical';

// ---------- one game ----------

/** Everything observed about one game's deployed artifacts. */
export interface ServedGame {
  slug: string;
  title: string;
  base: string;
  yardgame: boolean;
  layers: Layer[];
  forwarding: Forwarding;
}

export type ServedVerdict = 'pass' | 'blocker' | 'not-served';

/** The layers that answered with a body at all. */
export const servedLayers = (g: ServedGame) => g.layers.filter((l) => l.status === 200);

/**
 * What one game's deployed artifacts proved. A layer that 404s or never answered is 'not-served' (the artifact is
 * not there to grep); a layer that is served but misses any of the three patterns, or a chain that does not forward
 * the params identically, is a 'blocker'.
 */
export function servedVerdict(game: ServedGame): ServedVerdict {
  if (!game.layers.length || game.layers.some((l) => l.status !== 200)) return 'not-served';
  if (!game.layers.every((l) => hasSnippet(l.hits))) return 'blocker';
  return forwardingHolds(game.forwarding) ? 'pass' : 'blocker';
}

/**
 * Why this game is reported against SNIPPET_CARD, or null when it isn't. Named by game and by layer, and never
 * hand-patched: the deployed artifact is the snippet card's to ship.
 */
export function servedBlocker(game: ServedGame): string | null {
  const verdict = servedVerdict(game);
  if (verdict === 'pass') return null;
  const parts: string[] = [];
  for (const layer of game.layers) {
    if (layer.error) { parts.push(`${layer.kind} (${layer.url}) could not be fetched: ${layer.error}`); continue; }
    if (layer.status !== 200) { parts.push(`${layer.kind} (${layer.url}) answered HTTP ${layer.status}`); continue; }
    const missing = missingPatterns(layer.hits);
    if (missing.length) parts.push(`${layer.kind} (${layer.url}) is served but carries none of ${missing.join(', ')}`);
  }
  if (!game.layers.length) parts.push('no layer was fetched at all');
  if (!forwardingHolds(game.forwarding) && game.forwarding.verdict !== 'none-to-forward' && game.forwarding.verdict !== 'single-layer') {
    parts.push(game.forwarding.reason);
  }
  return parts.length ? `**${game.slug}** (${game.base}): ${parts.join('; ')}` : null;
}

// ---------- step 1: is the served artifact the release Analytics.4a cut? ----------

/** A build stamp found in a served page: what kind it is and its value. */
export interface Stamp {
  what: string;
  value: string;
}

/** Every build stamp a served page carries: a build comment, a `data-build`, or a cache-busting asset hash. */
export function stampsIn(html: string | null): Stamp[] {
  if (html === null) return [];
  const out: Stamp[] = [];
  for (const [, value] of html.matchAll(/<!--\s*(?:build|release|version)\s*[:=]\s*([^\s->]+)[^>]*-->/gi)) out.push({ what: 'build comment', value });
  for (const [, value] of html.matchAll(/\bdata-(?:build|release|version)\s*=\s*["']([^"']+)["']/gi)) out.push({ what: 'data-build', value });
  for (const [, value] of html.matchAll(/[?&]v=([A-Za-z0-9._-]{6,})/g)) out.push({ what: 'asset ?v=', value });
  const seen = new Set<string>();
  return out.filter((s) => { const key = `${s.what}\u0000${s.value}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

export type ReleaseVerdict = 'no-release' | 'match' | 'mismatch' | 'unstamped';

/** The release this run was told to verify, and whether the served bytes can be shown to be from it. */
export interface ReleaseCheck {
  /** The release id from Analytics.4a, or null when that card has not produced one. */
  id: string | null;
  /** Where the id came from ('--release', the 4a report), or why there is none. */
  how: string;
  /** The stamps found in the served outer page. */
  stamps: Stamp[];
  verdict: ReleaseVerdict;
  reason: string;
}

/** The release id Analytics.4a's own report records, or null when it recorded a blocker instead. */
export function releaseIdIn(doc: string | null): string | null {
  if (doc === null) return null;
  if (/^#\s*Blocked\b/im.test(doc)) return null;
  const line = /^\s*\*\s*release id:\s*(.+)$/im.exec(doc);
  if (!line) return null;
  const id = /`([^`]+)`/.exec(line[1])?.[1]?.trim() ?? '';
  return id && !/^none\b/i.test(id) ? id : null;
}

/** Whether a stamp names the release (the id itself, or a commit prefix of it). */
export function stampNames(stamp: Stamp, release: string): boolean {
  const value = stamp.value.toLowerCase();
  const id = release.toLowerCase();
  if (value.includes(id) || id.includes(value)) return true;
  const sha = /([0-9a-f]{7,40})/.exec(id)?.[1];
  return Boolean(sha && (value.includes(sha) || sha.startsWith(value)) && value.length >= 7);
}

/**
 * Step 1 of the card, judged honestly. No release id is the card's STOP: a blocker against Analytics.4a. A release
 * id with no stamp in the served page is NOT a pass either — the artifact simply cannot prove which release it came
 * from, and the report says so rather than assuming the deploy is current.
 */
export function judgeRelease(id: string | null, how: string, outer: string | null): ReleaseCheck {
  const stamps = stampsIn(outer);
  if (!id) {
    return {
      id: null, how, stamps, verdict: 'no-release',
      reason: `no staging release id exists to verify against: **${RELEASE_CARD}** has not produced one, and this card does not cut, deploy or guess one`,
    };
  }
  const match = stamps.find((s) => stampNames(s, id)) ?? null;
  if (match) return { id, how, stamps, verdict: 'match', reason: `the served page carries ${match.what} \`${match.value}\`, which names release \`${id}\`` };
  if (!stamps.length) {
    return {
      id, how, stamps, verdict: 'unstamped',
      reason: `the served outer page carries no build stamp, asset hash or version comment, so the bytes cannot be tied to release \`${id}\`: the layers below are what the CDN serves now, not proof of that release`,
    };
  }
  return {
    id, how, stamps, verdict: 'mismatch',
    reason: `the served page's stamp(s) ${stamps.map((s) => `\`${s.value}\` (${s.what})`).join(', ')} do not name release \`${id}\`: the deploy may be stale — not re-deployed from this card`,
  };
}

// ---------- the run, and the report it produces ----------

/** Everything one run of this card observed. */
export interface ServedRun {
  cdn: string;
  catalog: string;
  at: string;
  release: ReleaseCheck;
  /** How the three games were chosen, from the publisher's list. */
  selection: Selection;
  /** The CDN game list the choice was made from. */
  listed: number;
  games: ServedGame[];
  /** The probe query the outer page was fetched with (''), for the forwarding column. */
  query: string;
  /** Why nothing was fetched (the release gate, an empty list), or null. */
  gate: string | null;
  /**
   * True when the layers below were fetched although step 1 found no release id (`--observe`): the table is then an
   * OBSERVATION of what the CDN serves today, not this card's evidence, and the step-1 blocker stands either way.
   */
  observeOnly: boolean;
}

/** Every blocker this run found, in the words the completion comment uses. */
export function runBlockers(run: ServedRun): string[] {
  const out: string[] = [];
  for (const game of run.games) {
    const blocker = servedBlocker(game);
    if (blocker) out.push(blocker);
  }
  // A candidate stepped past in step 2 is a missing deployed artifact too, and the card asks for it by name.
  for (const s of run.selection.skipped) out.push(`**${s.game.slug}** (${s.game.base}): ${s.reason}`);
  return out;
}

/** 1 when the run was gated or found a blocker, 0 when all three games' layers carry the snippet. */
export const runFails = (run: ServedRun) =>
  Boolean(run.gate) || run.release.verdict !== 'match' || runBlockers(run).length > 0 || !run.games.length;

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** The layer table the acceptance criteria asks for: a row per layer, per game. */
export function layerTable(games: readonly ServedGame[]): string[] {
  const lines = [
    row(['Game', 'Layer', 'Full URL', 'HTTP', MARKER_START, RESOLVER_PATTERN, `alias \`${ALIAS_KEY}\`→\`${ALIAS_VALUE}\``, 'Params forwarded identically']),
    row(['---', '---', '---', '---', '---', '---', '---', '---']),
  ];
  for (const game of games) {
    const forwarding = `${forwardingHolds(game.forwarding) ? 'yes' : game.forwarding.verdict}: ${game.forwarding.reason}`;
    if (!game.layers.length) {
      lines.push(row([game.slug, '—', cell(`${game.base}index.html`), 'not fetched', 0, 0, 0, cell(forwarding)]));
      continue;
    }
    for (const [i, layer] of game.layers.entries()) {
      lines.push(row([
        i === 0 ? game.slug : '',
        layer.kind,
        cell(layer.url),
        layer.error ? `error: ${cell(layer.error)}` : String(layer.status ?? '—'),
        layer.hits.marker,
        layer.hits.resolver,
        layer.hits.alias,
        i === 0 ? cell(forwarding) : '',
      ]));
    }
  }
  return lines;
}

/** The run as Markdown: the evidence the card's completion comment is written from. */
export function servedMarkdown(run: ServedRun): string {
  const lines: string[] = [];
  lines.push('# Analytics.4b — the snippet in the DEPLOYED staging CDN artifacts', '');
  const list = run.catalog.endsWith(CATALOG_PATH) ? run.catalog : `${run.catalog.replace(/\/+$/, '')}${CATALOG_PATH}`;
  lines.push(`CDN: ${run.cdn}`, `Game list: ${list} (${run.listed} CDN game(s))`, `Run: ${run.at}`);
  lines.push(`Probe: ${run.query ? `\`?${run.query}\`` : '(none: the outer page was fetched as the player opens it)'}`, '');

  lines.push('## Step 1 — the staging release', '');
  lines.push(`* release id: ${run.release.id ? `\`${run.release.id}\`` : 'none'} (${run.release.how})`);
  lines.push(`* served artifact: **${run.release.verdict}** — ${run.release.reason}`);
  if (run.release.stamps.length) lines.push(`* stamps found in the served outer page: ${run.release.stamps.map((s) => `\`${s.value}\` (${s.what})`).join(', ')}`);
  lines.push('');

  if (run.gate && !(run.observeOnly && run.games.length)) {
    lines.push('## Not run', '', run.gate, '', `Blocker against "${RELEASE_CARD}". No artifact was fetched, nothing was patched, nothing was promoted.`, '');
    return `${lines.join('\n')}\n`;
  }
  if (run.gate) {
    lines.push('## STOP — this card\'s step 1 is not satisfied', '', run.gate, '',
      `Blocker against "${RELEASE_CARD}". The layers below were fetched with \`--observe\` and are an OBSERVATION of `
      + 'what the staging CDN serves today — they are NOT evidence about a release, because there is no release id to '
      + 'be evidence about. Nothing was cut, deployed, patched or promoted.', '');
  }

  lines.push('## Step 2 — the three games, chosen from the publisher\'s CDN game list', '');
  for (const why of run.selection.why) lines.push(`* ${why}`);
  if (run.selection.problem) lines.push(`* **not chosen**: ${run.selection.problem}`);
  if (run.selection.skipped.length) {
    lines.push('', 'Stepped past (no deployed artifact to grep; each is a blocker below all the same):', '');
    for (const s of run.selection.skipped) lines.push(`* \`${s.game.slug}\` (${s.game.base}) — ${s.reason}`);
  }
  lines.push('');

  lines.push('## Steps 3 and 4 — every served layer, grepped', '');
  lines.push(...layerTable(run.games));
  lines.push('');

  const blockers = runBlockers(run);
  if (blockers.length) {
    lines.push(`## Blockers against "${SNIPPET_CARD}"`, '');
    for (const b of blockers) lines.push(`* ${b}`);
    lines.push('', 'Not hand-patched: the deployed wrapper layers are that card\'s to ship. No template, snippet, Unity source '
      + 'or build output was touched here, and nothing was promoted to production.', '');
  } else {
    lines.push('## Result', '', 'Every served layer of all three games carries the marker block, the resolver and the alias table, '
      + 'and forwards the source params through unchanged.', '');
  }
  return `${lines.join('\n')}\n`;
}
