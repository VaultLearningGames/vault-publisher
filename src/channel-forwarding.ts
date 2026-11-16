// Analytics.3c: do Jo Wilder's and Lost Emerald's wrappers forward the SAME parameters to their inner frame as the
// shared template does?
//
// The chain a play's acquisition source travels (src/channel-runtime.ts has the whole of it) has a link that is easy
// to break per game: the outer click-to-play page, STUDIO/GAME/index.html, builds the <iframe src> for
// STUDIO/GAME/iframe.html and has to copy the parameters it was itself opened with onto it. Lose ?vault_ch there and
// the inner frame resolves 'vault' for a partner's play; lose ?utm_source and the studio's own analytics calls the
// visit Direct. Jo Wilder's and Lost Emerald's wrappers were hand-written before the shared template existed, so the
// two of them (and the template) are the three copies of that forwarding code that can drift apart.
//
// This module is the judgement, kept away from any file reading or browsing so it is testable without a build, a
// network or a browser: given the HTML of a wrapper it says WHICH parameter names that wrapper forwards
// (`forwardedParams`), and given the template's set and the games' it says whether they agree and, when they don't,
// exactly which names one side drops, renames or adds (`compareForwarding`, `forwardingReport`).
//
// How the set is read out of a wrapper: executing the page's script is the honest way, so `forwardedParams` runs it,
// in a sandbox with no DOM and no network (src/channel-forward-run.ts), over a probe query carrying every parameter
// the set could contain plus decoys that must NOT be forwarded; what comes out on the iframe's src is the answer.
// `declaredForwarding` is the fallback for a wrapper whose script cannot run in isolation: the names and prefixes
// written in its source. A reader of either is told which it got, because a static read can be wrong in ways an
// execution can't.
//
// Nothing here patches anything, and the fix for a drifted game belongs in that game's own override: the shared
// snippet (src/cdn/vault-channel.js) and the shared template are not this card's to edit.

/** The parameter carrying the partner channel; the inner frame cannot resolve a partner play without it. */
export const CHANNEL_PARAM = 'vault_ch';
/** The parameter carrying the exact origin the visitor came from. */
export const REFERRER_PARAM = 'vault_src';
/** The older spelling of REFERRER_PARAM, still on links in the wild, so a wrapper may forward both. */
export const LEGACY_REFERRER_PARAM = 'vault_referrer';
/** Campaign tags belong to the studio's own analytics: forwarded by prefix, never named one by one. */
export const UTM_PREFIX = 'utm_';

/**
 * The parameters every wrapper must forward, whatever else it also forwards: Analytics.2's set. `utm_*` is a prefix,
 * so the probe below carries the four tags src/vault-attribution.ts actually puts on a launch address.
 */
export const REQUIRED_PARAMS: readonly string[] = [CHANNEL_PARAM, REFERRER_PARAM];
export const REQUIRED_UTM: readonly string[] = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];

/**
 * Parameters a correct wrapper must NOT forward, used as decoys in the probe. A wrapper that copies the whole query
 * blindly looks identical to a correct one on the required set alone; these tell the two apart, which matters because
 * `gclid` and friends on an inner frame's address make a studio's analytics start a second session for one play.
 */
export const DECOY_PARAMS: readonly string[] = ['gclid', 'fbclid', 'foo'];

/** A probe value per parameter name, distinct so a renamed parameter is visible and not just a missing one. */
export function probeValue(name: string): string {
  if (name === CHANNEL_PARAM) return 'pbswi';
  if (name === REFERRER_PARAM || name === LEGACY_REFERRER_PARAM) return 'https://example.org';
  return `probe-${name}`;
}

/** The query a wrapper is probed with: every parameter it should forward, plus the decoys it should not. */
export function probeQuery(extra: readonly string[] = []): string {
  const names = [...REQUIRED_PARAMS, ...REQUIRED_UTM, LEGACY_REFERRER_PARAM, ...extra, ...DECOY_PARAMS];
  const search = new URLSearchParams();
  for (const name of [...new Set(names)]) search.set(name, probeValue(name));
  return search.toString();
}

/** The acceptance criteria's own probe, asserted verbatim: ?vault_ch=pbswi&vault_src=https://example.org&utm_source=x */
export const AC_QUERY = 'vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x';

// ---------- what a wrapper says it forwards (static) ----------

/**
 * The parameter names and prefixes a wrapper's source names, read as text. Used to report WHERE a wrapper's set comes
 * from, and as the fallback for a wrapper whose script cannot be executed. Deliberately generous: anything quoted
 * beside a get/has/set/append call, plus any quoted 'utm_'-style prefix, because a missed name here would be reported
 * as drift against an executed set, and a name too many only widens the fallback's set.
 */
export interface DeclaredForwarding {
  /** Exact names the source mentions ('vault_ch', 'utm_source'). */
  names: string[];
  /** Prefixes the source tests for ('utm_'), so 'utm_anything' is forwarded. */
  prefixes: string[];
}

const QUOTED = /['"]([A-Za-z_][A-Za-z0-9_]{0,63})['"]/g;
const PARAM_CALL = /\.(?:get|has|set|append|delete)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]{0,63})['"]/g;
const PREFIX_TEST = /['"]([a-z]{2,8}_)['"]\s*(?=\)|,|\s*\)|\s*===|\s*==)/g;
const STARTS_WITH = /(?:startsWith|indexOf|lastIndexOf|slice|substr|substring)\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]{0,16}_)['"]/g;

export function declaredForwarding(source: string): DeclaredForwarding {
  const names = new Set<string>();
  const prefixes = new Set<string>();
  for (const [, name] of source.matchAll(PARAM_CALL)) names.add(name);
  for (const [, name] of source.matchAll(QUOTED)) {
    if (name === CHANNEL_PARAM || name === REFERRER_PARAM || name === LEGACY_REFERRER_PARAM) names.add(name);
    if (name.startsWith(UTM_PREFIX) && name.length > UTM_PREFIX.length) names.add(name);
  }
  for (const re of [PREFIX_TEST, STARTS_WITH]) {
    for (const [, prefix] of source.matchAll(re)) if (prefix.endsWith('_')) prefixes.add(prefix);
  }
  // A prefix covers its own names, so a source naming both doesn't report 'utm_source' as something extra.
  for (const name of [...names]) if ([...prefixes].some((p) => name.startsWith(p))) names.delete(name);
  return { names: [...names].sort(), prefixes: [...prefixes].sort() };
}

/** The names a declaration forwards out of a given query: the exact names, plus everything under a prefix. */
export function declaredMatch(declared: DeclaredForwarding, query: string): string[] {
  const out = new Set<string>();
  for (const name of new URLSearchParams(query).keys()) {
    if (declared.names.includes(name)) out.add(name);
    else if (declared.prefixes.some((p) => name.startsWith(p))) out.add(name);
  }
  return [...out].sort();
}

// ---------- the forwarded set of one wrapper ----------

/** How a wrapper's forwarded set was established, so a reader is never told a static guess was an observation. */
export type ForwardingSource = 'executed' | 'declared';

/** What one wrapper forwards, and from what. */
export interface Forwarding {
  /** What this is: 'the shared template', 'jo-wilder'. */
  what: string;
  /** The parameter names the wrapper put on the inner frame's address, sorted. */
  params: string[];
  /** The whole iframe address observed, '' when the set was only declared. */
  iframeSrc: string;
  how: ForwardingSource;
  /** Why the script could not be executed (so the set is declared, not observed), or null. */
  note: string | null;
}

/** The forwarded set as a comparable value: sorted, de-duplicated, case kept (a renamed parameter is a difference). */
export const paramSet = (names: readonly string[]) => [...new Set(names)].sort();

/** The parameter names on an address's query, sorted — what an observed iframe src is read as. */
export function paramsOf(url: string): string[] {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  return paramSet([...new URLSearchParams(query).keys()]);
}

// ---------- comparing the three copies ----------

export type ForwardingVerdict = 'identical' | 'drift' | 'not-forwarding';

/** How one game's set differs from the template's, in the words the report needs. */
export interface ForwardingDiff {
  what: string;
  verdict: ForwardingVerdict;
  /** Parameters the template forwards that this wrapper does not: the ones that break a play's attribution. */
  dropped: string[];
  /** Parameters this wrapper forwards that the template does not (a rename shows up as one of each). */
  added: string[];
  /** The required parameters this wrapper fails to forward, whatever the template does. */
  missingRequired: string[];
  /** Decoys this wrapper forwarded: a blind copy of the whole query. */
  leaked: string[];
  reason: string;
}

const list = (names: readonly string[]) => names.map((n) => `\`${n}\``).join(', ');

/** The required set as names, given the query that was probed (so `utm_*` is judged on the tags actually probed). */
export function requiredIn(query: string): string[] {
  const names = [...new URLSearchParams(query).keys()];
  return paramSet([
    ...REQUIRED_PARAMS.filter((p) => names.includes(p)),
    ...names.filter((n) => n.startsWith(UTM_PREFIX)),
  ]);
}

/** One wrapper against the template, both probed with the same `query`. */
export function compareForwarding(template: Forwarding, game: Forwarding, query = probeQuery()): ForwardingDiff {
  const want = paramSet(template.params);
  const got = paramSet(game.params);
  const dropped = want.filter((p) => !got.includes(p));
  const added = got.filter((p) => !want.includes(p));
  const missingRequired = requiredIn(query).filter((p) => !got.includes(p));
  const leaked = DECOY_PARAMS.filter((p) => got.includes(p));
  const parts: string[] = [];
  if (dropped.length) parts.push(`drops ${list(dropped)}`);
  if (added.length) parts.push(`adds ${list(added)}`);
  if (leaked.length) parts.push(`forwards the decoy ${list(leaked)} (it copies the whole query)`);
  if (!got.length) {
    return {
      what: game.what, verdict: 'not-forwarding', dropped, added, missingRequired, leaked,
      reason: 'forwards nothing at all to its iframe: the inner frame can resolve no channel',
    };
  }
  if (!parts.length) return { what: game.what, verdict: 'identical', dropped, added, missingRequired, leaked, reason: `forwards the same ${got.length} parameter(s) as the shared template` };
  return { what: game.what, verdict: 'drift', dropped, added, missingRequired, leaked, reason: parts.join('; ') };
}

/** Whether every wrapper compared agrees with the template (and so with each other). */
export const forwardingMatches = (diffs: readonly ForwardingDiff[]) => diffs.every((d) => d.verdict === 'identical');

/** The whole check: the template, the games, and the query they were all probed with. */
export interface ForwardingRun {
  at: string;
  query: string;
  template: Forwarding;
  games: Forwarding[];
  /** The marker-block diff per game (AC3: Analytics.3a/3b's regression check), by game name. */
  blocks?: Record<string, { verdict: string; reason: string; diff: string }>;
  /** Why the run could not be made (the template or an override is missing), or null. */
  gate: string | null;
}

/** Every game's comparison with the template, in the order the games were given. */
export const runDiffs = (run: ForwardingRun) => run.games.map((g) => compareForwarding(run.template, g, run.query));

/**
 * Whether the games agree with EACH OTHER as well (AC1 asks for one set across all three). They can only disagree
 * with each other if at least one disagrees with the template, so this is a plain restatement — reported separately
 * because that is the sentence the card asks for.
 */
export function gamesAgree(run: ForwardingRun): boolean {
  const sets = run.games.map((g) => paramSet(g.params).join(','));
  return new Set([...sets, paramSet(run.template.params).join(',')]).size <= 1;
}

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** The run as Markdown: the report the card's completion comment is written from. */
export function forwardingReport(run: ForwardingRun): string {
  const lines: string[] = [];
  lines.push('# Analytics.3c — Jo Wilder and Lost Emerald forward the template\'s parameter set', '');
  lines.push(`Run: ${run.at}`, `Probe: \`?${run.query}\``, '');
  if (run.gate) {
    lines.push('## Not run', '', run.gate, '', 'No comparison below was attempted.', '');
    return `${lines.join('\n')}\n`;
  }
  lines.push(`Template forwards: ${run.template.params.length ? list(paramSet(run.template.params)) : '(nothing)'} (${run.template.how})`, '');
  lines.push(row(['Wrapper', 'How', 'Forwards', 'Verdict', 'Difference']));
  lines.push(row(['---', '---', '---', '---', '---']));
  for (const diff of runDiffs(run)) {
    const game = run.games.find((g) => g.what === diff.what)!;
    lines.push(row([diff.what, game.how, cell(list(paramSet(game.params)) || '(nothing)'), diff.verdict, cell(diff.reason)]));
  }
  lines.push('');
  if (run.blocks && Object.keys(run.blocks).length) {
    lines.push('## The VAULT_CHANNEL_LOGIC block (3a/3b held)', '');
    lines.push(row(['Wrapper', 'Verdict', 'Reason']));
    lines.push(row(['---', '---', '---']));
    for (const [what, block] of Object.entries(run.blocks)) lines.push(row([what, block.verdict, cell(block.reason)]));
    lines.push('');
    for (const [what, block] of Object.entries(run.blocks)) if (block.diff) lines.push(`### ${what}`, '```diff', block.diff, '```', '');
  }
  const diffs = runDiffs(run);
  if (forwardingMatches(diffs) && gamesAgree(run)) {
    lines.push('## Result', '', `All three copies forward the identical set: ${list(paramSet(run.template.params))}.`, '');
  } else {
    lines.push('## Differences to fix (in that game\'s own override only)', '');
    for (const d of diffs) if (d.verdict !== 'identical') lines.push(`* **${d.what}**: ${d.reason}`);
    lines.push('', 'The shared snippet and the shared template are not this card\'s to edit.', '');
  }
  return `${lines.join('\n')}\n`;
}

/** 1 when any wrapper disagrees with the template (or the run was gated), 0 when all three agree. */
export const runFails = (run: ForwardingRun) => Boolean(run.gate) || !forwardingMatches(runDiffs(run)) || !gamesAgree(run);
