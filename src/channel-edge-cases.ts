// The two edge cases of the channel snippet's rollout, judged from what staging actually serves:
//
//   (a) a CDN game with NO analytics tag must stay silent — the snippet resolves the channel and reports nothing,
//       so loading such a game through the player leaves the console empty: no errors, no warnings, and above all
//       no "gtag is not defined" from a report that fired with no tag to receive it;
//   (b) Jo Wilder's wrapper, whose deployed copy the shared snippet was taken FROM, must now carry that snippet
//       back verbatim: the block between the VAULT_CHANNEL_LOGIC markers in
//       cdn/fieldday/jowilder/iframe.html must be byte-identical to src/cdn/vault-channel.js's, and the reconciled
//       wrapper must report the channel once per load, not once per layer.
//
// The card this answers is "Analytics.4d: verify no-tag game stays silent and fieldday/jowilder/iframe.html matches
// the shared snippet on staging"; scripts/verify-channel-edge-cases.ts is the command that does the fetching and the
// browsing, and this module holds the rules, so what counts as silent, as identical and as a single report is
// testable without a browser or the network.
//
// Nothing here patches anything: a noisy console, a drifted marker block or a double report is named as a blocker
// against the reconcile card (RECONCILE_CARD below), because the fix belongs to the wrapper that drifted and not to
// the verification that found it.
import {
  channelReportCount, reportedChannels, type ChannelCall, type LoadResult,
} from './channel-runtime.ts';

/** The card a failure here belongs to: the wrappers are hers to change, never this verification's. */
export const RECONCILE_CARD = 'Analytics: reconcile Jo Wilder and Lost Emerald wrappers with the shared snippet';
/** The card that cuts the staging release this one verifies; a missing release is a blocker against it. */
export const RELEASE_CARD = 'Analytics.4a: gate on sibling work in origin/staging and cut the staging release';

// ---------- (a) the no-tag game stays silent ----------

/** One line the browser printed, in whichever document printed it. */
export interface ConsoleLine {
  /** Playwright's message type ('error', 'warning', 'log', …), or 'pageerror' for an uncaught exception. */
  type: string;
  text: string;
  /** The document that printed it, so an inner wrapper's line isn't blamed on the player page. */
  frameUrl: string;
}

/**
 * Console text that can only have come from the channel snippet or from a report it made. "gtag is not defined" and
 * "ga is not defined" are the whole point of the check: a wrapper with no tag must not call either.
 */
export const SNIPPET_CONSOLE: readonly RegExp[] = [
  /\bgtag\b[^\n]*\b(?:is not defined|is not a function|undefined)/i,
  /\bga\b[^\n]*\b(?:is not defined|is not a function)/i,
  /\bdataLayer\b[^\n]*\b(?:is not defined|is not a function)/i,
  /vaultResolveChannel/,
  /vaultReportChannel/,
  /vaultForwardParams/,
  /VAULT_CHANNEL/,
  /vault-channel\.js/,
  /\bvault_ch\b/,
  /\bvault_src\b/,
];

/** The message types that are console output even when nobody named the snippet: an error or a warning. */
export const PROBLEM_TYPES: readonly string[] = ['error', 'warning', 'pageerror'];

/** Whether this line names the snippet (or a report it would have made), so it is the snippet's to answer for. */
export const fromSnippet = (line: ConsoleLine) => SNIPPET_CONSOLE.some((re) => re.test(line.text));

/** Whether a line counts as console output at all: an error, a warning, or anything the snippet printed. */
export const isConsoleProblem = (line: ConsoleLine) => PROBLEM_TYPES.includes(line.type) || fromSnippet(line);

/** The lines the snippet is answerable for (the blocker), and the rest of the noise (reported, not a blocker). */
export const snippetLines = (lines: ConsoleLine[]) => lines.filter(fromSnippet);
export const otherProblemLines = (lines: ConsoleLine[]) => lines.filter((l) => !fromSnippet(l) && isConsoleProblem(l));

export type ConsoleVerdict = 'silent' | 'snippet-output' | 'other-output';

/**
 * What one load's console proved. 'silent' is the expected result: nothing at all. 'snippet-output' is the blocker
 * the card is looking for. 'other-output' is a legacy game's own logging (a missing font, its own 404): recorded in
 * the report so the console is never claimed to be empty when it wasn't, but not the snippet's fault.
 */
export function consoleVerdict(lines: ConsoleLine[]): ConsoleVerdict {
  if (snippetLines(lines).length) return 'snippet-output';
  return otherProblemLines(lines).length ? 'other-output' : 'silent';
}

/** One load of a no-tag game: what it printed and what, if anything, it reported. */
export interface SilentLoad {
  url: string;
  /** Every line printed, in order, from every frame. */
  console: ConsoleLine[];
  /** Any analytics call seen; a game with no tag is expected to make none. */
  calls: ChannelCall[];
  /** Why the load couldn't be judged (no browser, the page never loaded), or null. */
  error: string | null;
}

export type SilentVerdict = 'pass' | 'console' | 'reported' | 'noted' | 'error';

/** What a no-tag load proved: silent and reporting nothing is the only pass. */
export function silentVerdict(load: SilentLoad): SilentVerdict {
  if (load.error) return 'error';
  const verdict = consoleVerdict(load.console);
  if (verdict === 'snippet-output') return 'console';
  if (load.calls.some((c) => c.channel !== null)) return 'reported';
  return verdict === 'other-output' ? 'noted' : 'pass';
}

/** The console as the completion comment wants it: "empty", or the lines themselves. */
export function consoleSummary(load: SilentLoad): string {
  if (load.error) return `not observed (${load.error})`;
  if (!load.console.length) return 'empty';
  const shown = load.console.slice(0, 6).map((l) => `${l.type}: ${l.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  const more = load.console.length - shown.length;
  return `${load.console.length} line(s): ${shown.join(' / ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

// ---------- (b) the deployed marker block matches the shared snippet ----------

export const MARKER_START = 'VAULT_CHANNEL_LOGIC_START';
export const MARKER_END = 'VAULT_CHANNEL_LOGIC_END';

/**
 * The lines between the two markers, markers excluded, or null when the file has neither or only one. The markers are
 * matched as text anywhere on their line (they are comments: `/* VAULT_CHANNEL_LOGIC_START *&#47;` in the snippet,
 * possibly `//`-style in a wrapper), so the block is whatever a person diffing the two files would call the block.
 */
export function markedBlock(source: string): string | null {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.includes(MARKER_START));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.includes(MARKER_END));
  if (end === -1) return null;
  return lines.slice(start + 1, end).join('\n');
}

/** Why this file's marker block can't be compared, or null when it can be. */
export function markerProblem(source: string | null, what: string): string | null {
  if (source === null) return `${what} could not be read`;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = lines.some((l) => l.includes(MARKER_START));
  const end = lines.some((l) => l.includes(MARKER_END));
  if (!start && !end) return `${what} has no ${MARKER_START} marker at all: the shared snippet is not in it`;
  if (!start) return `${what} has ${MARKER_END} but no ${MARKER_START}`;
  if (!end) return `${what} has ${MARKER_START} but no ${MARKER_END}`;
  return null;
}

/**
 * The block as it is compared when indentation is set aside: CRLF to LF, trailing spaces gone, every line shifted
 * left by the block's own smallest indent, and the blank lines at either end dropped. A wrapper inlines the block one
 * or two levels deeper than the standalone file does, so this tells "the same code, indented differently" apart from
 * real drift, which the report says plainly instead of printing a diff of spaces.
 */
export function normaliseBlock(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indents = lines.filter((l) => l.trim() !== '').map((l) => (/^[ \t]*/.exec(l)?.[0] ?? '').length);
  const shift = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(shift))).join('\n');
}

/** A minimal line diff: every line that differs, with its side ('-' deployed, '+' the snippet). */
export function unifiedDiff(a: string, b: string, aName = 'deployed', bName = 'snippet'): string {
  const left = a.split('\n'), right = b.split('\n');
  // Longest common subsequence over lines; the blocks are tens of lines, so the plain table is fine.
  const n = left.length, m = right.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: string[] = [`--- ${aName}`, `+++ ${bName}`];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) { out.push(`  ${left[i]}`); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push(`- ${left[i++]}`);
    else out.push(`+ ${right[j++]}`);
  }
  while (i < n) out.push(`- ${left[i++]}`);
  while (j < m) out.push(`+ ${right[j++]}`);
  return out.join('\n');
}

export type BlockVerdict = 'identical' | 'indentation-only' | 'drift' | 'missing';

export interface BlockDiff {
  verdict: BlockVerdict;
  /** The sentence the completion comment quotes ("no diff", or what drifted). */
  reason: string;
  /** The diff itself, empty when there is none. */
  diff: string;
  /** How many lines each side's block has, for the report. */
  deployedLines: number;
  snippetLines: number;
}

/** Comparing the deployed wrapper's marker block with the shared snippet's. `null` means the file couldn't be read. */
export function compareBlocks(deployed: string | null, snippet: string | null, deployedName = 'the deployed wrapper', snippetName = 'src/cdn/vault-channel.js'): BlockDiff {
  const problem = markerProblem(deployed, deployedName) ?? markerProblem(snippet, snippetName);
  const deployedBlock = deployed === null ? null : markedBlock(deployed);
  const snippetBlock = snippet === null ? null : markedBlock(snippet);
  const count = (s: string | null) => (s === null ? 0 : s.split('\n').filter((l) => l.trim() !== '').length);
  if (problem || deployedBlock === null || snippetBlock === null) {
    return { verdict: 'missing', reason: problem ?? 'the marker block is missing', diff: '', deployedLines: count(deployedBlock), snippetLines: count(snippetBlock) };
  }
  const sizes = { deployedLines: count(deployedBlock), snippetLines: count(snippetBlock) };
  if (deployedBlock === snippetBlock) return { verdict: 'identical', reason: 'no diff: byte-for-byte identical', diff: '', ...sizes };
  const a = normaliseBlock(deployedBlock), b = normaliseBlock(snippetBlock);
  if (a === b) {
    return { verdict: 'indentation-only', reason: 'identical but for indentation and trailing whitespace (inlined at a different depth)', diff: '', ...sizes };
  }
  const diff = unifiedDiff(a, b, deployedName, snippetName);
  const changed = diff.split('\n').filter((l) => l.startsWith('-') || l.startsWith('+')).length - 2;
  return { verdict: 'drift', reason: `the blocks differ on ${changed} line(s)`, diff, ...sizes };
}

/** Whether a comparison is an acceptable match (identical, or identical but for the indent it was inlined at). */
export const blockMatches = (d: BlockDiff) => d.verdict === 'identical' || d.verdict === 'indentation-only';

// ---------- the run ----------

/** The no-tag game under test, and why it qualifies. */
export interface NoTagGame {
  slug: string;
  title: string;
  /** The CDN wrapper (STUDIO/GAME/), as the catalog gives it. */
  cdnUrl: string;
  /** Its page in the staging player. */
  playerUrl: string;
  /** What was searched for and not found, for the comment ('no gtag/analytics.js/G- id in index.html or iframe.html'). */
  evidence: string;
}

/** Jo Wilder's half of the card: the marker block, and the two loads through the player. */
export interface JoWilderResult {
  /** The wrapper fetched (…/fieldday/jowilder/iframe.html). */
  url: string;
  /** The snippet it was compared with, named by the commit it was read at. */
  snippetRef: string;
  diff: BlockDiff;
  playerUrl: string | null;
  partner: LoadResult | null;
  noParam: LoadResult | null;
}

export interface EdgeCaseRun {
  site: string;
  cdn: string;
  at: string;
  /** The staging release this was run against, and how it was identified. */
  release: { sha: string | null; how: string };
  /** Why the checks could not be run at all (no release, the release predates the wrapper work), or null. */
  gate: string | null;
  noTag: { game: NoTagGame; loads: SilentLoad[] } | null;
  jowilder: JoWilderResult | null;
}

/** What one of Jo Wilder's loads proved: the expected channel, reported exactly once. */
export function jowilderVerdict(load: LoadResult | null): 'pass' | 'wrong-channel' | 'double-report' | 'not-reported' | 'error' | 'not-run' {
  if (!load) return 'not-run';
  if (load.error) return 'error';
  const seen = reportedChannels(load.calls);
  if (!seen.length) return 'not-reported';
  if (seen.length > 1 || seen[0] !== load.expected) return 'wrong-channel';
  return channelReportCount(load.calls) === 1 ? 'pass' : 'double-report';
}

/** A load as the comment wants it: the channel observed and how many times. */
export function loadLine(load: LoadResult | null): string {
  if (!load) return 'not run';
  if (load.error) return `not observed (${load.error})`;
  const seen = reportedChannels(load.calls);
  if (!seen.length) return `no channel reported (${load.calls.length} analytics call(s) seen)`;
  return `${seen.map((c) => `'${c}'`).join(', ')} — reported ${channelReportCount(load.calls)}× (expected '${load.expected}', 1×)`;
}

/** Every blocker this run found, in words, each already naming the card it belongs to. */
export function runBlockers(run: EdgeCaseRun): string[] {
  const out: string[] = [];
  if (run.gate) {
    out.push(`**${RELEASE_CARD}**: ${run.gate}`);
    return out;
  }
  if (run.noTag) {
    for (const load of run.noTag.loads) {
      const verdict = silentVerdict(load);
      if (verdict === 'console') out.push(`**${RECONCILE_CARD}**: ${run.noTag.game.slug} has no analytics tag, yet ${load.url} printed ${snippetLines(load.console).map((l) => `${l.type}: ${l.text.replace(/\s+/g, ' ').slice(0, 160)}`).join(' / ')}`);
      if (verdict === 'reported') out.push(`**${RECONCILE_CARD}**: ${run.noTag.game.slug} has no analytics tag, yet ${load.url} made an analytics call carrying a channel`);
    }
  }
  const jw = run.jowilder;
  if (jw) {
    if (!blockMatches(jw.diff)) out.push(`**${RECONCILE_CARD}**: ${jw.url}'s marker block has drifted from ${jw.snippetRef} — ${jw.diff.reason}`);
    for (const [what, load] of [['?vault_ch=pbswi', jw.partner], ['no-param', jw.noParam]] as const) {
      const verdict = jowilderVerdict(load);
      if (verdict === 'double-report') out.push(`**${RECONCILE_CARD}**: Jo Wilder's ${what} load reported the channel ${channelReportCount(load!.calls)}× — the reconciled wrapper double-reports alongside the outer layer`);
      if (verdict === 'wrong-channel') out.push(`**${RECONCILE_CARD}**: Jo Wilder's ${what} load reported ${reportedChannels(load!.calls).map((c) => `'${c}'`).join(', ')} instead of '${load!.expected}'`);
      if (verdict === 'not-reported') out.push(`**${RECONCILE_CARD}**: Jo Wilder's ${what} load reported no channel at all`);
    }
  }
  return out;
}

/** 1 when the run found a blocker (or could not be run), 0 when both edge cases passed. */
export const runFails = (run: EdgeCaseRun) => runBlockers(run).length > 0;

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** The run as Markdown: the report the card's completion comment is written from. */
export function edgeCaseMarkdown(run: EdgeCaseRun): string {
  const lines: string[] = [];
  lines.push('# Analytics.4d — no-tag game silent, Jo Wilder matches the shared snippet (staging)', '');
  lines.push(`Site: ${run.site}`, `CDN: ${run.cdn}`, `Run: ${run.at}`, `Release: ${run.release.sha ?? 'none found'} (${run.release.how})`, '');

  if (run.gate) {
    lines.push('## Not run', '', `${run.gate}`, '', `Blocker against "${RELEASE_CARD}". No check below was attempted.`, '');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## (a) A CDN game with no analytics tag stays silent', '');
  if (!run.noTag) lines.push('No CDN game without an analytics tag was found in the catalog: nothing to check.', '');
  else {
    const g = run.noTag.game;
    lines.push(`Game: **${g.title}** (\`${g.slug}\`)`, `CDN wrapper: ${g.cdnUrl}`, `Player: ${g.playerUrl}`, `No tag: ${g.evidence}`, '');
    lines.push(row(['Load', 'Console', 'Analytics calls', 'Verdict']));
    lines.push(row(['---', '---', '---', '---']));
    for (const load of run.noTag.loads) {
      lines.push(row([cell(load.url), cell(consoleSummary(load)), load.calls.length, silentVerdict(load)]));
    }
    lines.push('');
  }

  lines.push('## (b) fieldday/jowilder/iframe.html matches the shared snippet', '');
  if (!run.jowilder) lines.push('Not checked.', '');
  else {
    const jw = run.jowilder;
    lines.push(`Wrapper: ${jw.url}`, `Snippet: ${jw.snippetRef}`, `Diff: **${jw.diff.verdict}** — ${jw.diff.reason} (${jw.diff.deployedLines} vs ${jw.diff.snippetLines} code lines)`, '');
    if (jw.diff.diff) lines.push('```diff', jw.diff.diff, '```', '');
    lines.push(row(['Load', 'Channel reported', 'Verdict']));
    lines.push(row(['---', '---', '---']));
    for (const [what, load] of [['?vault_ch=pbswi', jw.partner], ['no params', jw.noParam]] as const) {
      lines.push(row([cell(`${jw.playerUrl ?? 'the staging player'} (${what})`), cell(loadLine(load)), jowilderVerdict(load)]));
    }
    lines.push('');
  }

  const blockers = runBlockers(run);
  if (blockers.length) {
    lines.push('## Blockers', '');
    for (const b of blockers) lines.push(`* ${b}`);
    lines.push('', 'Not hand-patched: the wrappers, the templates and the snippet belong to the cards named above.', '');
  } else {
    lines.push('## Result', '', 'Both edge cases pass: the no-tag game printed nothing and Jo Wilder reports the expected channel exactly once from a marker block identical to the shared snippet.', '');
  }
  return `${lines.join('\n')}\n`;
}
