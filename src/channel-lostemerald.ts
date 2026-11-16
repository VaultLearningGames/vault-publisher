// Analytics.3b: Lost Emerald keeps its page_referrer, and takes the channel from the shared snippet.
//
// The Legend of the Lost Emerald (`the-legend-of-the-lost-emerald`, served from `fieldday/lostemerald/`) is the
// other hand-written wrapper. Where Jo Wilder's copy carries the WHOLE channel logic (Analytics.3a), Lost Emerald's
// carries half of it: it reads `?vault_src` and reports it as GA's `page_referrer`, and that is all. It never looks
// at `?vault_ch`, and it has no `vault` default — so a partner's play (`?vault_ch=pbswi`) and a native play through
// the Vault's own player both land in `(direct)`.
//
// This module is the rule for reconciling that per-game layer with the shared snippet (src/cdn/vault-channel.js),
// and it is deliberately narrow:
//
//   * the `page_referrer`-from-`vault_src` behaviour is KEPT, exactly as it is — same parameter, same decoding, and
//     the same absence behaviour (no `vault_src`, no `page_referrer`). The game team may rely on it, and this card
//     may not change what it reports;
//   * any GAME-SPECIFIC channel setting (`dimension1`, `utm_source`/`utm_medium`, campaign fields, a `gtag('config',
//     <id>)` or `ga('send','pageview')` of its own) is removed, or guarded so it stands down once the shared snippet
//     has run, so the channel — and the single config/pageview — comes from the shared snippet alone;
//   * no `vault` default is added here: the shared snippet provides it, for every game, and duplicating it is how
//     two layers come to report one play twice.
//
// What is NOT this card's: the shared snippet, the shared wrapper template, and Jo Wilder. A difference that would
// have to be fixed in one of those is reported, never patched. Everything here is pure — the wrapper and the snippet
// are passed in as text — so the rules are testable with no build, no CDN and no browser.
import { markedBlock, MARKER_END, MARKER_START, type BlockDiff } from './channel-edge-cases.ts';
import {
  alreadyDefers, comparableBlock, inlineChannelScript, pageSharedReports, sharedReports, SHARED_SENTINEL,
  SHARED_SNIPPET_CARD, TEMPLATE_CARD, type InlineScript,
} from './channel-jowilder.ts';
import { CHANNEL_PARAM, REFERRER_PARAM } from './channel-runtime.ts';
import { LEGACY_REFERRER_PARAM } from './channel-forwarding.ts';
import {
  blockOf, findFirst, innerPaths, overridePaths, SNIPPET_PATH, type FileReader, type FoundFile,
} from './channel-wrappers.ts';

/** The game this card is about, by catalog slug and CDN folder. */
export const LOSTEMERALD = { slug: 'the-legend-of-the-lost-emerald', cdn: 'fieldday/lostemerald' } as const;

/** The GA field Lost Emerald's wrapper sets from `?vault_src`, and the analytics.js field that is the same thing. */
export const REFERRER_FIELD = 'page_referrer';
export const LEGACY_REFERRER_FIELD = 'referrer';

/** Where the verification-only outcome is recorded when Lost Emerald has no override of its own (plan step 2b). */
export const VERIFICATION_DOC = 'docs/verification/analytics-3b-lost-emerald.md';

// ---------- reading the wrapper's own script ----------

/** Lost Emerald's inline script lines, classified so the two halves can be told apart. */
export type LineKind =
  | 'referrer'   // reads vault_src / sets page_referrer: kept, untouched
  | 'channel'    // sets the channel (dimension1, utm_*, campaign_*) or issues its own config/pageview: the shared snippet's job now
  | 'other';     // everything else in the script (the game's own code)

/** One line of the script, with what it does and whether it can be lifted out on its own. */
export interface ScriptLine {
  text: string;
  kind: LineKind;
  /** Whether this line is a whole statement at its own brace depth, so removing it cannot break the syntax. */
  isolable: boolean;
}

const REFERRER_SIGNS: readonly RegExp[] = [
  new RegExp(`\\b${REFERRER_PARAM}\\b`),
  new RegExp(`\\b${LEGACY_REFERRER_PARAM}\\b`),
  new RegExp(`\\b${REFERRER_FIELD}\\b`),
  /\bdocument\s*\.\s*referrer\b/,
];

/**
 * What a game-specific line does that the shared snippet now does too: naming the channel parameter, setting the
 * "Play source" dimension or the campaign tags, or sending a page view / config of its own. `gtag('set', {...})` on
 * its own is not channel setting — Lost Emerald's page_referrer is exactly that call — so the dimension and utm
 * names, not the call style, are what classify a line.
 */
const CHANNEL_SIGNS: readonly RegExp[] = [
  new RegExp(`\\b${CHANNEL_PARAM}\\b`),
  /\bdimension\d+\b/,
  /\butm_(?:source|medium|campaign|content)\b/,
  /\bcampaign_(?:source|medium|name)\b/,
  /\bgtag\s*\(\s*['"]config['"]/,
  /\bga\s*\(\s*['"]send['"]\s*,\s*['"]pageview['"]/,
  /\bgtag\s*\(\s*['"]event['"]\s*,\s*['"]page_view['"]/,
];

/** Whether a line is the page_referrer half (and so kept verbatim). */
export const isReferrerLine = (line: string) => REFERRER_SIGNS.some((re) => re.test(line));
/** Whether a line sets the channel / sends a hit the shared snippet now owns. */
export const isChannelLine = (line: string) => CHANNEL_SIGNS.some((re) => re.test(line));

const depthDelta = (line: string) => {
  // Brackets inside strings and comments would mis-count a depth, so the obvious ones are stripped first.
  const bare = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '')
    .replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/`(?:\\.|[^`\\])*`/g, '``');
  let delta = 0;
  for (const ch of bare) {
    if (ch === '(' || ch === '[' || ch === '{') delta++;
    else if (ch === ')' || ch === ']' || ch === '}') delta--;
  }
  return delta;
};

/**
 * The script's lines, each classified and marked isolable when it is balanced on its own (so lifting it out leaves
 * the rest of the script syntactically whole). A line that opens a block it does not close is never isolable: this
 * card removes statements, it does not rewrite a game's code.
 */
export function scriptLines(body: string): ScriptLine[] {
  return body.replace(/\r\n/g, '\n').split('\n').map((text) => {
    const referrer = isReferrerLine(text);
    // A line doing both (one call carrying page_referrer and a dimension) counts as referrer: it is kept, and the
    // double report it would cause is reported rather than silently half-edited.
    const kind: LineKind = referrer ? 'referrer' : isChannelLine(text) ? 'channel' : 'other';
    return { text, kind, isolable: depthDelta(text) === 0 };
  });
}

/** The lines that set the channel today, as the report lists them. */
export const channelLines = (body: string) => scriptLines(body).filter((l) => l.kind === 'channel');
/** The lines that carry the page_referrer behaviour this card must preserve. */
export const referrerLines = (body: string) => scriptLines(body).filter((l) => l.kind === 'referrer');

/** Whether the script reports a page_referrer from `vault_src` at all (what must still be true afterwards). */
export const setsPageReferrer = (body: string) =>
  new RegExp(`\\b${REFERRER_PARAM}\\b|\\b${LEGACY_REFERRER_PARAM}\\b`).test(body)
  && new RegExp(`\\b${REFERRER_FIELD}\\b|['"]${LEGACY_REFERRER_FIELD}['"]`).test(body);

/** Whether every channel line can be lifted out on its own (else the whole block is guarded instead). */
export const channelLinesIsolable = (body: string) => channelLines(body).every((l) => l.isolable);

// ---------- where page_referrer must sit ----------

/**
 * Whether the page_referrer is set BEFORE the shared block runs. GA keeps the fields set on it and applies them to
 * the next `config`/page view, so a page_referrer set after the shared snippet has already reported would miss the
 * hit it was meant to ride on. When the page carries no shared block yet there is nothing to be before: null.
 */
export function referrerBeforeShared(html: string): boolean | null {
  const marker = html.indexOf(MARKER_START);
  if (marker === -1) return null;
  const re = new RegExp(`\\b${REFERRER_FIELD}\\b|['"]${LEGACY_REFERRER_FIELD}['"]`);
  const match = re.exec(html);
  if (!match) return null;
  return match.index < marker;
}

export const STRIP_START = 'VAULT_CHANNEL_STRIP_START';
export const STRIP_END = 'VAULT_CHANNEL_STRIP_END';

/**
 * Whether a stand-down guard would actually see the shared snippet: the guard tests for the snippet's globals when
 * it RUNS, so it can only stand down if the shared block runs first. A guard above the shared block in the page
 * reports the channel itself and the shared block reports it again — the very double report this card removes — so
 * the order is checked and reported rather than assumed. Null when the page has no guard or no shared block.
 */
export function guardRunsAfterShared(html: string): boolean | null {
  const guard = html.indexOf(STRIP_START);
  const shared = html.indexOf(MARKER_START);
  if (guard === -1 || shared === -1) return null;
  return guard > shared;
}

// ---------- the resolution ----------

/** The note left where a game-specific channel line was removed, so the next reader knows what happened and why. */
export function stripNote(indent: string, what: readonly string[]): string {
  return [
    `${indent}/* ${STRIP_START} — Analytics.3b: Lost Emerald's own channel setting is gone (${what.length} line(s)):`,
    `${indent}   the shared snippet (src/cdn/vault-channel.js), which every wrapper now includes, resolves and reports`,
    `${indent}   the channel for every game — the alias table, utm_source/utm_medium, dimension1 and the 'vault'`,
    `${indent}   default — so one play is reported once, from one layer. The page_referrer read from ?${REFERRER_PARAM} above`,
    `${indent}   is untouched: it is this wrapper's own behaviour and the game team relies on it. ${STRIP_END} */`,
  ].join('\n');
}

/** The channel lines kept but made to stand down once the shared snippet has run (when they cannot be lifted out). */
export function guardBody(body: string, indent = '  '): string {
  const inner = body.replace(/\r\n/g, '\n').split('\n')
    .map((l) => (l.trim() === '' ? '' : `${indent}  ${l}`)).join('\n');
  return [
    `${indent}/* ${STRIP_START} — Analytics.3b: this block sets the channel itself, and could not be lifted out`,
    `${indent}   line by line without rewriting Lost Emerald's code, so it stands down when the shared snippet`,
    `${indent}   (src/cdn/vault-channel.js) has already reported the channel. Guarded where it sat: everything around`,
    `${indent}   it — the page_referrer read from ?${REFERRER_PARAM} among it — is untouched and still runs on every load. */`,
    `${indent}(function () {`,
    `${indent}  if (${SHARED_SENTINEL}) return;`,
    inner.replace(/\n+$/, ''),
    `${indent}}());`,
    `${indent}/* ${STRIP_END} */`,
  ].join('\n');
}

export type Resolution =
  | 'no-override'              // Lost Emerald receives the shared template: a verification card, no code change
  | 'already-resolved'         // a re-run: the channel setting is already gone or already guarded
  | 'referrer-only'            // the override only sets page_referrer: nothing conflicts, the channel is the snippet's
  | 'strip-channel'            // its channel lines are lifted out; page_referrer stays exactly as it was
  | 'guard-channel'            // its channel setting could not be lifted out, so it stands down at runtime
  | 'guard-unsafe'             // it could be neither lifted out nor guarded without moving code: reported, not touched
  | 'shared-does-not-report';  // the shared layer reports nothing yet: removing anything would silence the game

/** What was decided about Lost Emerald's page, the rewritten page when it changed, and why. */
export interface ResolutionResult {
  resolution: Resolution;
  reason: string;
  /** The page as it should now be; the input unchanged when nothing had to change. */
  html: string;
  changed: boolean;
  /** The game-specific channel lines that were found (removed, or guarded). */
  channel: string[];
  /** The page_referrer lines that were preserved. */
  referrer: string[];
}

const trimmed = (lines: readonly ScriptLine[]) => lines.map((l) => l.text.trim()).filter(Boolean);

/** Whether the script has already been through this card (its channel lines stripped or guarded). */
export const alreadyResolved = (body: string) => body.includes(STRIP_START) || alreadyDefers(body);

/**
 * Signs a script IS the shared layer and so may never be edited by this card: the markers the template wraps the
 * shared block in, or the globals the shared snippet declares. The shared block reads `vault_src` and sets
 * `dimension1` and the utm tags itself, so without this test it would look exactly like the game-specific channel
 * code this card removes — and the card would strip the shared snippet instead of the override. That is the one
 * mistake here that would be invisible afterwards, so it is tested for first, everywhere a script is chosen.
 *
 * Declarations and calls, never a bare mention: the stand-down guard below NAMES those globals in a `typeof` test,
 * and a guarded override must still be recognised as the override on a second run (so this card is idempotent).
 */
export const SHARED_SIGNS: readonly RegExp[] = [
  new RegExp(MARKER_START),
  new RegExp(MARKER_END),
  /function\s+vaultResolveChannel\b/,
  /function\s+vaultReportChannel\b/,
  /\bvaultResolveChannel\s*\(/,
  /\bvaultReportChannel\s*\(/,
  /\bVAULT_CHANNELS\s*=/,
  /\bVAULT_CHANNEL_ALIASES\s*=/,
  /\bVAULT_PARTNER_CHANNELS\s*=/,
];

/** Whether this script is the shared snippet's layer (the template's block), not Lost Emerald's own code. */
export const isSharedScript = (body: string) => SHARED_SIGNS.some((re) => re.test(body));

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

const scriptAt = (html: string, match: RegExpExecArray | RegExpMatchArray): InlineScript => {
  const [element, , body] = match;
  const start = match.index ?? 0;
  const lineStart = html.lastIndexOf('\n', start) + 1;
  return {
    element, body, start, end: start + element.length,
    indent: /^[ \t]*/.exec(html.slice(lineStart, start))?.[0] ?? '',
  };
};

/**
 * Lost Emerald's own script, or null when its page has none. The page_referrer script is NOT channel code by
 * src/channel-jowilder.ts's test (it reads vault_src but reports no channel), which is the whole difference between
 * the two games, so it is looked for on its own terms: an inline script that reads vault_src or sets page_referrer —
 * and that is NOT the shared block, which reads the same parameter and is not this card's to touch.
 */
export function inlineReferrerScript(html: string): InlineScript | null {
  let found: InlineScript | null = null;
  let channel: InlineScript | null = null;
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const [, attrs, body] = match;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (isSharedScript(body)) continue;
    if (isReferrerLine(body)) found = scriptAt(html, match);
    else if (isChannelLine(body)) channel ??= scriptAt(html, match);
  }
  // A page whose own script sets a channel but no page_referrer is still this card's to reconcile.
  return found ?? channel ?? (() => {
    const only = inlineChannelScript(html);
    return only && !isSharedScript(only.body) ? only : null;
  })();
}

/**
 * The smallest run of whole lines that contains every channel line AND is brace-balanced, so guarding it in place
 * cannot break the syntax around it: the first and last channel line, widened outwards until the slice closes
 * everything it opens (the `if (…) {` a channel call sits inside comes with its `}`). Null when no such run stops
 * short of the whole body, in which case nothing is guessed and the body is left alone.
 */
export function channelRange(lines: readonly ScriptLine[]): { from: number; to: number } | null {
  const marks = lines.map((l, i) => (l.kind === 'channel' ? i : -1)).filter((i) => i >= 0);
  if (!marks.length) return null;
  const balanced = (from: number, to: number) => {
    let depth = 0;
    for (let i = from; i <= to; i++) {
      depth += depthDelta(lines[i].text);
      if (depth < 0) return false;
    }
    return depth === 0;
  };
  // Never widen over a line this card must preserve: a guarded page_referrer would stop running.
  const keeps = (from: number, to: number) => {
    for (let i = from; i <= to; i++) if (lines[i].kind === 'referrer') return false;
    return true;
  };
  let from = marks[0], to = marks[marks.length - 1];
  while (from >= 0) {
    for (let end = to; end < lines.length; end++) {
      if (keeps(from, end) && balanced(from, end)) return { from, to: end };
    }
    from--;
    if (from >= 0 && lines[from].kind === 'referrer') return null;
  }
  return null;
}

/** Rewrites one script body: channel lines out (or guarded in place), every other line byte-for-byte as it was. */
export function rewriteBody(body: string, indent: string): { body: string; stripped: string[]; guarded: boolean } {
  const lines = scriptLines(body);
  const channel = lines.filter((l) => l.kind === 'channel');
  if (!channel.length) return { body, stripped: [], guarded: false };
  if (channel.every((l) => l.isolable)) {
    const kept: string[] = [];
    let noted = false;
    for (const line of lines) {
      if (line.kind !== 'channel') { kept.push(line.text); continue; }
      if (!noted) { kept.push(stripNote(indent, trimmed(channel))); noted = true; }
    }
    return { body: kept.join('\n'), stripped: trimmed(channel), guarded: false };
  }
  // Not liftable line by line (a channel call inside the game's own `if`): the channel part is kept and made to
  // stand down, guarded exactly where it sits. Nothing is hoisted or re-ordered — the lines before and after it,
  // the page_referrer among them and the declarations it reads, stay where they are and run on every load.
  const range = channelRange(lines);
  if (!range) return { body, stripped: [], guarded: false };
  const guarded = guardBody(lines.slice(range.from, range.to + 1).map((l) => l.text).join('\n'), indent);
  return {
    body: [
      ...lines.slice(0, range.from).map((l) => l.text),
      guarded,
      ...lines.slice(range.to + 1).map((l) => l.text),
    ].join('\n'),
    stripped: trimmed(channel),
    guarded: true,
  };
}

/**
 * Resolves Lost Emerald's own layer. `html` is its per-game override (or inner frame) and `shared` the shared
 * snippet; the shared snippet is only ever read.
 */
export function resolveLostEmerald(html: string, shared: string): ResolutionResult {
  const script = inlineReferrerScript(html);
  if (!script) {
    return {
      resolution: 'no-override', changed: false, html, channel: [], referrer: [],
      reason: 'Lost Emerald carries no inline script of its own here: it receives the shared template, so there is '
        + 'no game-specific channel setting to remove and no page_referrer of its own to preserve. This card is then '
        + `the verification of the built wrapper's behaviour, recorded in \`${VERIFICATION_DOC}\` — not a code change.`,
    };
  }
  const channel = trimmed(channelLines(script.body));
  const referrer = trimmed(referrerLines(script.body));
  if (alreadyResolved(script.body)) {
    return {
      resolution: 'already-resolved', changed: false, html, channel, referrer,
      reason: 'Lost Emerald\'s own channel setting has already been removed or guarded; its page_referrer is in place '
        + 'and nothing is left to change.',
    };
  }
  if (!channel.length) {
    return {
      resolution: 'referrer-only', changed: false, html, channel, referrer,
      reason: `Lost Emerald's script sets ${REFERRER_FIELD} from ?${REFERRER_PARAM} and nothing else: it never reads `
        + `?${CHANNEL_PARAM}, sets no dimension and sends no config of its own, so there is nothing that conflicts with or `
        + 'doubles the shared snippet. The channel (dimension1, utm_source/utm_medium, the `vault` default) comes from '
        + 'the shared snippet, and the page_referrer behaviour is left exactly as it is.',
    };
  }
  // The one case where doing nothing is the only safe answer: the shared layer resolves the channel but reports
  // nothing yet (Analytics.1b/2 own that). Removing Lost Emerald's own setting now would leave nothing reporting.
  if (!sharedReports(shared) && !pageSharedReports(html, script)) {
    return {
      resolution: 'shared-does-not-report', changed: false, html, channel, referrer,
      reason: `the shared snippet (${SNIPPET_PATH}) resolves the channel but makes no report of its own yet, so `
        + 'removing Lost Emerald\'s channel setting would stop the channel being reported at all. Left exactly as it '
        + `is until the shared reporting lands (**${SHARED_SNIPPET_CARD}** and its 1b sibling own that); Lost `
        + 'Emerald\'s observable behaviour is unchanged.',
    };
  }
  const rewritten = rewriteBody(script.body, script.indent);
  if (!rewritten.stripped.length) {
    return {
      resolution: 'guard-unsafe', changed: false, html, channel, referrer,
      reason: `Lost Emerald's channel setting (${channel.length} line(s)) is written so that it can neither be lifted `
        + 'out line by line nor guarded without moving code this card must preserve, and rewriting the game\'s own '
        + 'script is not this card\'s to do. Left exactly as it is, and reported: the lines above are the ones a '
        + 'person must reconcile with the shared snippet by hand.',
    };
  }
  const element = script.element.replace(script.body, rewritten.body);
  return {
    resolution: rewritten.guarded ? 'guard-channel' : 'strip-channel', changed: true,
    html: `${html.slice(0, script.start)}${element}${html.slice(script.end)}`,
    channel, referrer,
    reason: rewritten.guarded
      ? `Lost Emerald's channel setting (${channel.length} line(s)) could not be lifted out without rewriting its `
        + 'code, so it is kept and made to stand down once the shared snippet has reported; the page_referrer lines '
        + 'are hoisted above the guard and still run on every load.'
      : `Lost Emerald's own channel setting (${channel.length} line(s)) is removed — the shared snippet reports the `
        + `channel for every game — and the ${REFERRER_FIELD}-from-?${REFERRER_PARAM} behaviour is kept verbatim.`,
  };
}

/**
 * Whether a rewrite kept the page_referrer behaviour: every referrer line of the original override is still there,
 * verbatim. Read from the override's own script, never from the whole page — the shared block reads the same
 * parameter, and counting its lines as Lost Emerald's would call a rewrite faithful that had dropped the game's.
 */
export function referrerPreserved(before: string, after: string): boolean {
  const script = inlineReferrerScript(before);
  const want = trimmed(referrerLines(script?.body ?? before));
  const got = new Set((inlineReferrerScript(after)?.body ?? after).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()));
  return want.every((line) => got.has(line));
}

/** Whether a rewrite left no game-specific channel setting running unguarded. */
export function channelLeftToShared(after: string): boolean {
  const script = inlineReferrerScript(after);
  if (!script) return true;
  const lines = channelLines(script.body);
  if (!lines.length) return true;
  // Everything still there must sit inside the stand-down guard.
  const guardStart = script.body.indexOf(STRIP_START);
  if (guardStart === -1) return false;
  return lines.every((l) => script.body.indexOf(l.text) > guardStart);
}

// ---------- the whole check, as the card reports it ----------

/** Everything the card needs from the worktree, or the reason it cannot be done yet. */
export interface LostEmeraldCheck {
  snippet: FoundFile;
  /** Lost Emerald's per-game outer page, if it has one. */
  outer: FoundFile;
  /** Lost Emerald's inner frame (the built iframe.html), if it has one. */
  inner: FoundFile;
  /** The marker-block diff of the built inner frame against the shared snippet (the shared block must be intact). */
  block: BlockDiff;
  /** The decision about Lost Emerald's own layer. */
  plan: ResolutionResult | null;
  /** Whether page_referrer is set before the shared block runs (null: one of the two isn't in the page). */
  referrerFirst: boolean | null;
  /** Whether a stand-down guard, if one was needed, sits after the shared block so it can see it (null: no guard). */
  guardOrder: boolean | null;
  /** Whether the shared snippet maps the short keys and defaults to `vault` (the precondition this card gates on). */
  snippetReady: { aliases: boolean; vaultDefault: boolean; reports: boolean };
  /** Why no decision could be made (which sibling card has not landed), or null. */
  gate: string | null;
}

/** The shared snippet's precondition, read out of its text: the pbswi alias, the `vault` default, a report at all. */
export function snippetReadiness(snippet: string | null): { aliases: boolean; vaultDefault: boolean; reports: boolean } {
  const text = snippet ?? '';
  const block = markedBlock(text) ?? text;
  return {
    aliases: /pbswi\s*:\s*['"]pbswisconsineducation\.org['"]/.test(block),
    vaultDefault: /['"]vault['"]/.test(block),
    reports: snippet === null ? false : sharedReports(block),
  };
}

/** Reads the snippet, Lost Emerald's override and its built inner frame, and decides what this card must do. */
export function checkLostEmerald(read: FileReader): LostEmeraldCheck {
  const snippet = findFirst(read, [SNIPPET_PATH]);
  const outer = findFirst(read, overridePaths(LOSTEMERALD.cdn));
  const inner = findFirst(read, innerPaths(LOSTEMERALD.cdn));
  const block = blockOf(inner, snippet);
  const snippetReady = snippetReadiness(snippet.text);
  const reasons: string[] = [];
  if (snippet.text === null) {
    reasons.push(`The shared snippet \`${SNIPPET_PATH}\` is not in this worktree: it is written by **${SHARED_SNIPPET_CARD}**, `
      + 'which this card is serialized after and must not re-implement.');
  } else {
    if (!snippetReady.aliases) {
      reasons.push(`The shared snippet does not map the partner short key \`pbswi\` to \`pbswisconsineducation.org\`, so a `
        + 'wrapper that defers to it would report no channel for a partner play. That mapping belongs to '
        + `**${SHARED_SNIPPET_CARD}** (and the 'Channel values' card), not here: the snippet is not edited by this card.`);
    }
    if (!snippetReady.vaultDefault) {
      reasons.push('The shared snippet has no `vault` default for a play inside the Vault player, so deferring to it '
        + `would leave native plays in \`(direct)\`. That default belongs to **${SHARED_SNIPPET_CARD}**, not here.`);
    }
  }
  const page = outer.text ?? inner.text;
  const plan = snippet.text !== null && page !== null ? resolveLostEmerald(page, snippet.text) : null;
  if (page === null) {
    reasons.push(`Lost Emerald has no wrapper in this worktree (looked in ${[...outer.tried, ...inner.tried].map((p) => `\`${p}\``).join(', ')}). `
      + `The template that emits the \`${MARKER_START}\` block is written by **${TEMPLATE_CARD}**, which has not landed on this branch, `
      + 'and this game has no per-game override of its own here: there is nothing to edit, and the acceptance behaviour '
      + `is verified against the built output and recorded in \`${VERIFICATION_DOC}\`.`);
  }
  return {
    snippet, outer, inner, block,
    plan,
    referrerFirst: page === null ? null : referrerBeforeShared(page),
    guardOrder: page === null ? null : guardRunsAfterShared(plan?.html ?? page),
    snippetReady,
    gate: reasons.length ? reasons.join('\n\n') : null,
  };
}

/** Whether this card's own work is done and still holds: page_referrer kept, no second channel setter left. */
export function resolutionHolds(check: LostEmeraldCheck): boolean {
  const plan = check.plan;
  const page = check.outer.text ?? check.inner.text;
  if (!plan || page === null) return false;
  if (plan.resolution === 'shared-does-not-report' || plan.resolution === 'guard-unsafe') return false;
  // A guard that runs before the shared block cannot stand down, so the channel would still be set twice.
  if (guardRunsAfterShared(plan.html) === false) return false;
  return referrerPreserved(page, plan.html) && channelLeftToShared(plan.html);
}

/** 1 when the card's own check failed; a missing dependency is reported, not failed. */
export const checkFails = (check: LostEmeraldCheck) =>
  (check.outer.text ?? check.inner.text) !== null && check.plan !== null && !resolutionHolds(check);
