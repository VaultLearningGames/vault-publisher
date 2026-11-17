// Analytics.4a: the gate on sibling work in origin/staging, and the staging release cut once it passes.
//
// This card cuts ONE thing — a staging release id that already contains the shared channel work — and it may only
// cut it when that work is demonstrably on `origin/staging`. Three artifacts must be there:
//
//   (a) the shared snippet, `src/cdn/vault-channel.js`, carrying the VAULT_CHANNEL_LOGIC block;
//   (b) the template inclusion: the CDN game wrapper templates, OUTER (a game's `index.html`) and INNER
//       (`iframe.html`), either carrying the marker block themselves or including the shared include template
//       that carries it;
//   (c) the two hand-written wrappers reconciled with the snippet: `fieldday/jowilder/iframe.html` and the Lost
//       Emerald wrapper, each containing the marker block.
//
// Everything here is PURE: the ref's file list and a reader for it are passed in, so the gate is decided from what
// a given commit contains and can be tested without git, the network or a release. The release and the smoke check
// are described here (their addresses, their ids, what counts as a pass) and performed by
// scripts/cut-channel-staging-release.ts.
//
// Two rules this module exists to enforce:
//   * `releaseAllowed` is false unless EVERY check passed. A failed gate produces a blocker naming the missing
//     artifact and the sibling card that owns it — never a patched template, never a release cut anyway.
//   * staging only. `stagingOnlyProblem` refuses any address that is not a staging host, so this card can never
//     promote to production; production releases are the human-approved `.github/workflows/release.yml`.
//
// One honest note the report carries, from Analytics.2a/2b: the publisher generates no wrapper HTML of its own — a
// build brings its own index.html/iframe.html and the hosting step ships `vault-channel.js` next to them. So check
// (b) searches for a wrapper template in the repository, and says exactly which paths it looked in when there is
// none, rather than quietly treating "no template" as "nothing to include".
import { MARKER_END, MARKER_START, RECONCILE_CARD } from './channel-edge-cases.ts';
import {
  findFirst, GAMES, innerPaths, overridePaths, SNIPPET_PATH, TEMPLATE_PATHS, type FileReader, type FoundFile,
} from './channel-wrappers.ts';

/** The ref the gate is always decided from: not a local branch, not a PR head. */
export const GATE_REF = 'origin/staging';

/** The sibling card that owns the snippet and its inclusion in the wrapper templates — checks (a) and (b). */
export const SNIPPET_CARD = 'Analytics: shared vault_ch reader for all 23 CDN games';
/** The sibling card that owns Jo Wilder's and Lost Emerald's wrappers — check (c). */
export const WRAPPER_CARD = RECONCILE_CARD;

/** Staging's CDN base (`CDN_PUBLIC_URL` on the staging service; src/config.ts, docs/setup.md). */
export const STAGING_CDN_BASE = 'https://cdn.vaultlearninggames-staging.org';
/** Staging's portal, which cuts the release (docs/setup.md). */
export const STAGING_PORTAL = 'https://portal.vaultlearninggames-staging.org';

/** Where this card's outcome — the release id, or the blocker — is recorded, beside its sibling's. */
export const VERIFICATION_DOC = 'docs/verification/analytics-4a-staging-release.md';

/** Where the marker block lives when the wrapper templates include it instead of inlining it. */
export const INCLUDE_TEMPLATE_PATH = 'src/cdn/templates/vault-channel-include.html';

/** The inner (`iframe.html`) counterparts of the shared template's possible paths. */
export const templateInnerPaths = (): string[] => TEMPLATE_PATHS.map((p) => p.replace(/index\.html$/, 'iframe.html'));

/** The deployed wrapper paths the card names outright, which a reconciled wrapper may also live at in the repo. */
export const JOWILDER_INNER = 'fieldday/jowilder/iframe.html';
export const LOSTEMERALD_INNER = 'fieldday/lostemerald/iframe.html';

// ---------- counting marker hits the way `git grep -c` does ----------

/**
 * How many LINES of a file mention the start marker — `git grep -c VAULT_CHANNEL_LOGIC_START` counts matching
 * lines, so the number the report prints is the number the command in the card prints.
 */
export function markerHits(text: string | null): number {
  if (text === null) return 0;
  return text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.includes(MARKER_START)).length;
}

/** Whether a file carries a whole marker block (both markers, start before end). */
export function hasMarkerBlock(text: string | null): boolean {
  if (text === null) return false;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.includes(MARKER_START));
  if (start === -1) return false;
  return lines.findIndex((l, i) => i > start && l.includes(MARKER_END)) !== -1;
}

/** Whether a template defers to the shared include template rather than inlining the block. */
export function includesSharedInclude(text: string | null): boolean {
  if (text === null) return false;
  return text.includes(INCLUDE_TEMPLATE_PATH) || /vault-channel-include/.test(text);
}

/** One file the gate looked at: its path and its marker-line count. */
export interface MarkerFile {
  path: string;
  hits: number;
}

/** Everything a ref contains, as the gate sees it: its paths, and a reader for them. */
export interface Tree {
  /** Every path at the ref (`git ls-tree -r --name-only`). */
  paths: string[];
  /** Reads one path at the ref, or null when it isn't there. */
  read: FileReader;
}

/** Every file under `prefix` that mentions the marker, with its hit count — the `git grep -c … -- prefix` answer. */
export function markerHitsInTree(tree: Tree, prefix: string): MarkerFile[] {
  const out: MarkerFile[] = [];
  for (const path of tree.paths) {
    if (!path.startsWith(prefix)) continue;
    const hits = markerHits(tree.read(path));
    if (hits > 0) out.push({ path, hits });
  }
  return out;
}

// ---------- the three checks ----------

export type CheckName = 'snippet' | 'templates' | 'wrappers';

/** One gate check: what it looked for, whether it passed, and every file (with hit count) it matched. */
export interface GateCheck {
  name: CheckName;
  /** The artifact, as the completion comment names it. */
  what: string;
  pass: boolean;
  /** The files that matched, with `git grep -c`-style hit counts. */
  files: MarkerFile[];
  /** Every path looked in, so a blocker says where it searched. */
  tried: string[];
  /** The sentence the report quotes: what was found, or what is missing. */
  reason: string;
  /** The sibling card that owns this artifact, named in a blocker. */
  card: string;
}

/** (a) the shared snippet exists at the ref and carries the marker block. */
export function checkSnippet(tree: Tree): GateCheck {
  const found = findFirst(tree.read, [SNIPPET_PATH]);
  const hits = markerHits(found.text);
  const block = hasMarkerBlock(found.text);
  const files: MarkerFile[] = found.path ? [{ path: found.path, hits }] : [];
  const reason = found.text === null
    ? `\`${SNIPPET_PATH}\` is not at ${GATE_REF}`
    : !block
      ? `\`${SNIPPET_PATH}\` is there but has no ${MARKER_START}…${MARKER_END} block (${hits} marker line(s))`
      : `\`${SNIPPET_PATH}\`: ${hits} ${MARKER_START} line(s), with a closing ${MARKER_END}`;
  return { name: 'snippet', what: 'the shared snippet', pass: block && hits >= 1, files, tried: [SNIPPET_PATH], reason, card: SNIPPET_CARD };
}

/** How one wrapper layer gets the block: inlined, through the shared include, or not at all. */
export type LayerVia = 'direct' | 'include' | null;

/** One wrapper layer of the shared template (outer `index.html`, inner `iframe.html`). */
export interface TemplateLayer {
  layer: 'outer' | 'inner';
  file: FoundFile;
  hits: number;
  via: LayerVia;
}

/** How a layer carries the block, given the include template's own marker count. */
export function layerVia(text: string | null, includeHits: number): LayerVia {
  if (text === null) return null;
  if (hasMarkerBlock(text)) return 'direct';
  if (includesSharedInclude(text) && includeHits >= 1) return 'include';
  return null;
}

/** (b) both wrapper template layers carry the marker block, directly or through the shared include. */
export function checkTemplates(tree: Tree): GateCheck {
  const include = findFirst(tree.read, [INCLUDE_TEMPLATE_PATH]);
  const includeHits = markerHits(include.text);
  const found: { layer: 'outer' | 'inner'; file: FoundFile }[] = [
    { layer: 'outer', file: findFirst(tree.read, TEMPLATE_PATHS) },
    { layer: 'inner', file: findFirst(tree.read, templateInnerPaths()) },
  ];
  const layers: TemplateLayer[] = found.map((l) => ({
    ...l, hits: markerHits(l.file.text), via: layerVia(l.file.text, includeHits),
  }));
  const inTree = markerHitsInTree(tree, 'src/cdn');
  const files: MarkerFile[] = [
    ...layers.filter((l) => l.file.path !== null).map((l) => ({ path: l.file.path as string, hits: l.hits })),
    ...(include.path ? [{ path: include.path, hits: includeHits }] : []),
    ...inTree.filter((f) => f.path !== SNIPPET_PATH),
  ];
  const tried = [...TEMPLATE_PATHS, ...templateInnerPaths(), INCLUDE_TEMPLATE_PATH];
  const missing = layers.filter((l) => l.via === null);
  const pass = inTree.length > 0 && missing.length === 0;
  const reason = pass
    ? layers.map((l) => `the ${l.layer} template \`${l.file.path}\` carries the block ${l.via === 'include' ? `through \`${INCLUDE_TEMPLATE_PATH}\`` : 'directly'} (${l.hits} marker line(s))`).join('; ')
    : missing.map((l) => (l.file.path === null
      ? `no ${l.layer} CDN wrapper template at ${GATE_REF} (looked in ${l.file.tried.map((p) => `\`${p}\``).join(', ')})`
      : `the ${l.layer} template \`${l.file.path}\` neither contains ${MARKER_START} nor includes \`${INCLUDE_TEMPLATE_PATH}\``)).join('; ')
      + (inTree.length === 0 ? `; no file under \`src/cdn\` other than the snippet mentions ${MARKER_START}` : '');
  return { name: 'templates', what: 'the template inclusion (outer and inner CDN wrapper templates)', pass, files, tried, reason, card: SNIPPET_CARD };
}

/** One hand-written wrapper the reconcile card owns. */
export interface WrapperFile {
  slug: string;
  file: FoundFile;
  hits: number;
  block: boolean;
}

/** Every path a game's reconciled inner wrapper may be at, the one the card names first. */
export function wrapperPaths(cdn: string): string[] {
  const named = `${cdn}/iframe.html`;
  return [named, ...innerPaths(cdn).filter((p) => p !== named), ...overridePaths(cdn)];
}

/** (c) Jo Wilder's and Lost Emerald's wrappers exist at the ref and contain the marker block. */
export function checkWrappers(tree: Tree): GateCheck {
  const wrappers: WrapperFile[] = GAMES.map((g) => {
    const file = findFirst(tree.read, wrapperPaths(g.cdn));
    return { slug: g.slug, file, hits: markerHits(file.text), block: hasMarkerBlock(file.text) };
  });
  const files = wrappers.filter((w) => w.file.path !== null).map((w) => ({ path: w.file.path as string, hits: w.hits }));
  const tried = GAMES.flatMap((g) => wrapperPaths(g.cdn));
  const bad = wrappers.filter((w) => !w.block);
  const reason = bad.length === 0
    ? wrappers.map((w) => `\`${w.file.path}\`: ${w.hits} marker line(s)`).join('; ')
    : bad.map((w) => (w.file.path === null
      ? `${w.slug}'s wrapper is not at ${GATE_REF} (looked in ${w.file.tried.map((p) => `\`${p}\``).join(', ')})`
      : `${w.slug}'s wrapper \`${w.file.path}\` has no ${MARKER_START}…${MARKER_END} block`)).join('; ');
  return { name: 'wrappers', what: 'the Jo Wilder / Lost Emerald reconciliation', pass: bad.length === 0, files, tried, reason, card: WRAPPER_CARD };
}

/** The three checks, in the card's order. */
export const gateChecks = (tree: Tree): GateCheck[] => [checkSnippet(tree), checkTemplates(tree), checkWrappers(tree)];

/** The checks that failed, i.e. the artifacts missing from the ref. */
export const failedChecks = (checks: GateCheck[]): GateCheck[] => checks.filter((c) => !c.pass);

/**
 * Whether a release may be cut. The only way this is true is every check passing: a missing artifact is a blocker
 * against the sibling card, never something this card works around.
 */
export const releaseAllowed = (checks: GateCheck[]): boolean => checks.length === 3 && checks.every((c) => c.pass);

/** The blocker sentence for the edge-case report's gate (src/channel-edge-cases.ts), or null when the gate passed. */
export function gateSentence(checks: GateCheck[], sha: string | null): string | null {
  const bad = failedChecks(checks);
  if (!bad.length) return null;
  return `No staging release was cut from ${GATE_REF}${sha ? ` ${sha}` : ''}: `
    + bad.map((c) => `${c.what} is missing — ${c.reason} (**${c.card}**)`).join('; ')
    + '.';
}

// ---------- staging only ----------

/** Why one of these addresses may not be used by this card (it is not staging's), or null. */
export function stagingOnlyProblem(urls: string[]): string | null {
  for (const url of urls) {
    let host: string;
    try { host = new URL(url).hostname; } catch { return `\`${url}\` is not an address`; }
    if (!/staging/i.test(host)) {
      return `\`${url}\` is not a staging host: this card cuts the STAGING release only, and production is released `
        + 'by .github/workflows/release.yml behind its required approval.';
    }
  }
  return null;
}

// ---------- the release ----------

/** What the documented procedure is asked to do for one game (docs/setup.md "Release"; src/app.ts publish). */
export interface ReleaseRequest {
  publisher: string;
  studio: string;
  game: string;
  /** The release name, e.g. `channel-<sha12>`: a release id that says which commit it carries. */
  version: string;
  /** The build ref being released (the gate SHA, or a tag of it). */
  ref: string;
  /** Whether the release also becomes the one players get at STUDIO/GAME/ (default true). */
  promote?: boolean;
}

/** The publisher endpoint the documented procedure posts to. */
export const publishUrl = (publisher: string): string => `${publisher.replace(/\/+$/, '')}/v1/admin/releases/publish`;

/** The pre-flight check endpoint, which says what would be released before anything is. */
export const releaseCheckUrl = (publisher: string, studio: string, game: string): string =>
  `${publisher.replace(/\/+$/, '')}/v1/releases/${studio}/${game}/check`;

/** A release name that names the commit it was cut from, so the release id and the gate SHA can never drift apart. */
export const releaseVersionFor = (sha: string, prefix = 'channel'): string => `${prefix}-${sha.slice(0, 12)}`;

/** The release that was cut: the id this card produces, and the commit it came from. */
export interface StagingRelease {
  /** The release id: the version name the portal now holds it under. */
  id: string;
  /** The `origin/staging` commit it was cut from. */
  sha: string;
  studio: string;
  game: string;
  publisher: string;
  approved: boolean;
  promoted: boolean;
  /** Where the release plays. */
  url: string;
}

/** Where a released game plays on a CDN base. */
export const playUrl = (cdn: string, studio: string, game: string): string =>
  `${cdn.replace(/\/+$/, '')}/${studio}/${game}/`;

/** The one URL the smoke check fetches: a CDN game's OUTER page. */
export const smokeUrl = (cdn: string, studio: string, game: string): string =>
  `${playUrl(cdn, studio, game)}index.html`;

// ---------- the smoke check ----------

export type SmokeVerdict = 'pass' | 'bad-status' | 'no-marker' | 'error';

/** The one fetch this card makes: HTTP status, and whether the served page carries the marker. */
export interface SmokeResult {
  url: string;
  status: number | null;
  hits: number;
  verdict: SmokeVerdict;
  error: string | null;
}

/** Judging that fetch: 200 and the marker present, or exactly which of the two failed. */
export function judgeSmoke(url: string, status: number | null, body: string | null, error: string | null = null): SmokeResult {
  const hits = markerHits(body);
  const verdict: SmokeVerdict = error !== null || status === null
    ? 'error'
    : status !== 200
      ? 'bad-status'
      : hits < 1
        ? 'no-marker'
        : 'pass';
  return { url, status, hits, verdict, error };
}

/** The sentence the completion comment quotes for the smoke check. */
export function smokeLine(s: SmokeResult): string {
  if (s.verdict === 'error') return `${s.url}: not fetched — ${s.error ?? 'no response'}`;
  if (s.verdict === 'bad-status') return `${s.url}: HTTP ${s.status} (expected 200)`;
  if (s.verdict === 'no-marker') return `${s.url}: HTTP ${s.status}, but no ${MARKER_START} in the served page`;
  return `${s.url}: HTTP ${s.status}, ${MARKER_START} × ${s.hits}`;
}

// ---------- the run, and the comment it produces ----------

/** Everything one run of this card observed. */
export interface ReleaseRun {
  ref: string;
  sha: string | null;
  cdn: string;
  checks: GateCheck[];
  /** The release cut, or null when the gate blocked it (or it was a dry run). */
  release: StagingRelease | null;
  /** The release id/revision that was live before, for rollback. */
  previous: string | null;
  smoke: SmokeResult | null;
  /** Why no release was cut although the gate passed (a dry run, a missing token), or null. */
  notCut: string | null;
}

/** Whether the gate blocked this run. */
export const runBlocked = (run: ReleaseRun): boolean => !releaseAllowed(run.checks);

/** Whether the run failed: the gate blocked it, or the release/smoke check did not come out right. */
export const runFails = (run: ReleaseRun): boolean =>
  runBlocked(run) || run.notCut !== null || run.release === null || run.smoke === null || run.smoke.verdict !== 'pass';

const checkLine = (c: GateCheck): string =>
  `* ${c.pass ? '✅' : '❌'} **${c.what}** — ${c.reason}`
  + (c.files.length ? `\n  * ${c.files.map((f) => `\`${f.path}\`: ${f.hits}`).join('\n  * ')}` : '');

/** The gate's three results, as the completion (or blocker) comment lists them. */
export function gateMarkdown(run: ReleaseRun): string {
  const lines = [
    `## Gate checks on \`${run.ref}\` ${run.sha ?? '(no SHA)'}`,
    '',
    ...run.checks.map(checkLine),
    '',
  ];
  return lines.join('\n');
}

/** The blocker comment: the SHA, the commands, the missing artifact and the sibling card that owns it. */
export function blockerMarkdown(run: ReleaseRun, commands: string[]): string {
  const bad = failedChecks(run.checks);
  const lines = [
    `# Blocked: no staging release cut from \`${run.ref}\``,
    '',
    `\`${run.ref}\` = ${run.sha ?? 'unknown'}`,
    '',
    'Missing from the gate ref:',
    '',
    ...bad.map((c) => `* **${c.what}** — ${c.reason}\n  * owner: **${c.card}**\n  * looked in: ${c.tried.map((p) => `\`${p}\``).join(', ')}`),
    '',
    gateMarkdown(run),
    '## Commands run',
    '',
    '```sh',
    ...commands,
    '```',
    '',
    'No release was cut, nothing was promoted, and no template, snippet or wrapper was patched: the missing artifacts '
    + 'belong to the sibling cards named above.',
    '',
  ];
  return lines.join('\n');
}

/** The completion comment: the SHA, the three results, the release id, and the one smoke-check URL. */
export function completionMarkdown(run: ReleaseRun): string {
  const lines = [
    '# Staging release cut',
    '',
    `* \`${run.ref}\` SHA: \`${run.sha ?? 'unknown'}\``,
    `* release id: ${run.release ? `\`${run.release.id}\` (${run.release.studio}/${run.release.game}, cut from \`${run.release.sha}\`${run.release.promoted ? ', promoted' : ', approved only'})` : `none — ${run.notCut ?? 'not cut'}`}`,
    `* previously live: ${run.previous ?? 'nothing recorded'}`,
    `* staging CDN: ${run.cdn}`,
    '',
    gateMarkdown(run),
    '## Smoke check (one CDN game\'s outer index.html)',
    '',
    run.smoke ? `* ${run.smoke.verdict === 'pass' ? '✅' : '❌'} ${smokeLine(run.smoke)}` : '* not run',
    '',
    'Full per-game verification is the sibling card\'s; production was not touched.',
    '',
  ];
  return lines.join('\n');
}

/** The report for a run, whichever way it went. */
export const reportMarkdown = (run: ReleaseRun, commands: string[]): string =>
  runBlocked(run) ? blockerMarkdown(run, commands) : completionMarkdown(run);
