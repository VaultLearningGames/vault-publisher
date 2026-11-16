// Analytics.3b: running Lost Emerald's wrapper with a stubbed gtag/ga, to see what one load reports.
//
// src/channel-lostemerald.ts decides what Lost Emerald's layer must look like; this proves the effect — the three
// things the acceptance criteria ask for, observed rather than read out of the source:
//
//   1. `?vault_ch=pbswi` reports the channel `pbswisconsineducation.org`;
//   2. framed with no parameters at all it reports `vault`;
//   3. `?vault_src=<url>` still sets `page_referrer` to that value, and the channel is set exactly ONCE per load.
//
// It reuses the sandbox and the recorders src/channel-jowilder-run.ts built (no DOM beyond what a wrapper touches,
// no network, no file system, no process), so "reported once" means here exactly what it means there, and the two
// games' results are comparable line for line. Pure in the same sense: the wrapper is passed in as text, so the
// check runs with no build, no CDN and no browser.
import {
  channelsOf, loadWrapper, reportCount, type RecordedCall, type WrapperLoad,
} from './channel-jowilder-run.ts';
import { LEGACY_REFERRER_FIELD, REFERRER_FIELD } from './channel-lostemerald.ts';
import { REFERRER_PARAM, VAULT_CHANNEL } from './channel-runtime.ts';

/** Where the inner frame lives when it is run, so `location` looks like the CDN serving it. */
export const INNER_BASE = 'https://cdn.vaultlearninggames-staging.org/fieldday/lostemerald/iframe.html';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The page_referrer values one call set, in the two forms a wrapper can set them: gtag's
 * `gtag('set', {page_referrer: v})` (also inside a `config`'s parameters) and analytics.js's
 * `ga('set', 'referrer', v)`.
 */
export function referrersOfCall(call: RecordedCall): string[] {
  const out: string[] = [];
  const [first, second, third] = call.args;
  if (first === 'set' && second === LEGACY_REFERRER_FIELD && third != null) out.push(String(third));
  if (first === 'set' && second === REFERRER_FIELD && third != null) out.push(String(third));
  for (const params of [asRecord(second), asRecord(third), asRecord(first)]) {
    if (!params) continue;
    for (const field of [REFERRER_FIELD, LEGACY_REFERRER_FIELD]) {
      const value = params[field];
      if (value != null) out.push(String(value));
    }
  }
  return out;
}

/** Every page_referrer one load set, in order (a load that set none gives an empty list). */
export const referrersOf = (load: WrapperLoad) => load.calls.flatMap(referrersOfCall);

/** How many times one load set a page_referrer — AC3's "exactly once", for the referrer half. */
export const referrerSetCount = (load: WrapperLoad) => referrersOf(load).length;

/** The distinct `gtag('config', …)` / `ga('send','pageview')` hits one load sent, so a doubled page view is visible. */
export function pageViewCount(load: WrapperLoad): number {
  let n = 0;
  for (const call of load.calls) {
    const [first, second] = call.args;
    if (first === 'config') n++;
    else if (first === 'send' && second === 'pageview') n++;
    else if (first === 'event' && second === 'page_view') n++;
  }
  return n;
}

/** One case of the acceptance criteria: the query, the channel it must report, and the referrer it must keep. */
export interface EmeraldCase {
  what: string;
  query: string;
  /** The channel the load must report. */
  expected: string;
  /** The page_referrer the load must set, or null when it must set none. */
  referrer: string | null;
  /** Whether the document is framed (the player serves the inner frame in an iframe). */
  embedded?: boolean;
}

/** The source origin AC3 uses, as the partner link carries it. */
export const SOURCE_URL = 'https://www.pbswisconsineducation.org/lost-emerald/';

/** The three cases the acceptance criteria ask for, in their order. */
export const CASES: readonly EmeraldCase[] = [
  { what: 'a partner short key', query: 'vault_ch=pbswi', expected: 'pbswisconsineducation.org', referrer: null },
  { what: 'framed with no parameters', query: '', expected: VAULT_CHANNEL, referrer: null },
  {
    what: 'a source origin, page_referrer kept',
    query: `${REFERRER_PARAM}=${encodeURIComponent(SOURCE_URL)}`,
    expected: 'pbswisconsineducation.org',
    referrer: SOURCE_URL,
  },
];

export type CaseVerdict =
  | 'pass'
  | 'wrong-channel'
  | 'double-report'
  | 'not-reported'
  | 'referrer-lost'
  | 'referrer-doubled'
  | 'error';

/** One case's result: the channel reported, how many times, and what page_referrer was set. */
export interface CaseResult {
  what: string;
  query: string;
  expected: string;
  channels: string[];
  count: number;
  /** Every page_referrer the load set. */
  referrers: string[];
  /** The page_referrer the case requires, or null. */
  wantReferrer: string | null;
  pageViews: number;
  verdict: CaseVerdict;
  error: string | null;
}

/** Runs one case against a wrapper. */
export function runCase(html: string, c: EmeraldCase, base = INNER_BASE): CaseResult {
  const load = loadWrapper(html, c.query, base, c.embedded ?? true);
  const channels = channelsOf(load);
  const count = reportCount(load);
  const referrers = referrersOf(load);
  const verdict: CaseVerdict = load.error && !channels.length
    ? 'error'
    : !channels.length
      ? 'not-reported'
      : channels.length > 1 || channels[0] !== c.expected
        ? 'wrong-channel'
        : count !== 1
          ? 'double-report'
          : c.referrer !== null && !referrers.includes(c.referrer)
            ? 'referrer-lost'
            : c.referrer !== null && referrers.length > 1
              ? 'referrer-doubled'
              : 'pass';
  return {
    what: c.what, query: c.query, expected: c.expected, channels, count, referrers,
    wantReferrer: c.referrer, pageViews: pageViewCount(load), verdict, error: load.error,
  };
}

/** Every case the acceptance criteria ask for, against one wrapper. */
export const runCases = (html: string, cases: readonly EmeraldCase[] = CASES, base = INNER_BASE) =>
  cases.map((c) => runCase(html, c, base));

/** Whether every case passed: the right channel, once per load, with the page_referrer still set. */
export const acceptancePasses = (results: readonly CaseResult[]) =>
  results.length > 0 && results.every((r) => r.verdict === 'pass');

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** The runtime half as Markdown: the table the card's completion comment (and the verification doc) quotes. */
export function casesTable(results: readonly CaseResult[]): string {
  const lines: string[] = [];
  lines.push(row(['Case', 'Query', 'Channel', 'Expected', 'Times', 'page_referrer', 'Page views', 'Verdict']));
  lines.push(row(['---', '---', '---', '---', '---', '---', '---', '---']));
  for (const r of results) {
    lines.push(row([
      r.what, `\`?${r.query || '(none)'}\``, cell(r.channels.join(', ') || 'none'), cell(r.expected), r.count,
      cell(r.referrers.join(', ') || '(none)'), r.pageViews, r.verdict,
    ]));
  }
  return lines.join('\n');
}

// ---------- observing the acceptance behaviour before the template lands ----------

/**
 * Lost Emerald's page_referrer half, as its deployed wrapper does it: read `?vault_src` and set it as GA's
 * `page_referrer`, decoded by URLSearchParams, and set NOTHING when the parameter is absent. This is the behaviour
 * the card must preserve, written out once so the check and the wrapper cannot drift apart in wording.
 */
export const REFERRER_SCRIPT = [
  "    // Lost Emerald's own behaviour, kept: the origin the play came from, as GA's page_referrer. Set before the",
  '    // shared block below so the config/page view it sends carries it. No ?vault_src, no page_referrer.',
  '    (function () {',
  '      try {',
  `        var src = new URLSearchParams(location.search).get('${REFERRER_PARAM}');`,
  `        if (src && typeof window.gtag === 'function') window.gtag('set', { ${REFERRER_FIELD}: src });`,
  '      } catch (e) {}',
  '    }());',
].join('\n');

/**
 * The caller the shared wrapper template provides (Analytics.2): read the parameters off this document, resolve the
 * channel and report it, once. Written here ONLY so this card's acceptance behaviour can be observed before that
 * template lands — the template is not this card's to write, and when it exists the check runs against the built
 * file instead (`--html`).
 */
export const SHARED_CALLER = [
  '    (function () {',
  '      try {',
  '        var q = new URLSearchParams(location.search);',
  `        var resolved = vaultResolveChannel((q.get('vault_ch') || '').trim().toLowerCase(), (q.get('${REFERRER_PARAM}') || '').trim(), parent !== self);`,
  '        vaultReportChannel(resolved.channel);',
  '      } catch (e) {}',
  '    }());',
].join('\n');

/**
 * The inner frame as the shared template will serve it for Lost Emerald once this card's shape is in place: this
 * worktree's own snippet inlined between the markers, the shared caller, and Lost Emerald's page_referrer script
 * before it — and no game-specific channel setting at all. A RECONSTRUCTION, and labelled as one everywhere it is
 * reported: the channel logic in it is the real snippet's text, not a copy, so what it reports is what the snippet
 * reports, but the surrounding template is Analytics.2's and may differ in ways only the built file can show.
 */
export function reconstructedInnerFrame(snippet: string, referrerScript = REFERRER_SCRIPT): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <title>The Legend of the Lost Emerald</title>',
    '  <script>',
    referrerScript,
    '  </script>',
    '  <script>',
    snippet.replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '').trim(),
    SHARED_CALLER,
    '  </script>',
    '</head>',
    '<body><canvas id="unity-canvas"></canvas></body>',
    '</html>',
  ].join('\n');
}
