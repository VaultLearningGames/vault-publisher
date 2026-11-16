// Analytics.3a: Jo Wilder's own channel block defers to the shared snippet, so one play is reported once.
//
// Jo Wilder (`jo-wilder`, served from `fieldday/jowilder/`) is the reference game: the shared snippet
// (src/cdn/vault-channel.js) was copied OUT of its deployed wrapper, so its wrapper already carries that logic
// inline — the vault_ch/vault_src read, the alias normalisation, utm_source/utm_medium, the "Play source"
// dimension, the default `vault`. The moment the shared template includes the snippet as well, Jo Wilder's wrapper
// carries the logic TWICE, and the same play is reported from two layers.
//
// This module is the rule for resolving that, in the game-specific layer only:
//
//   (a) the inline block has no LOGIC difference from the shared snippet -> delete the duplicate inline block from
//       Jo Wilder's own override, leaving everything else in it untouched;
//   (b) it differs in a NON-LOGIC way (identifier names, comments, formatting, where it sits in the page, gtag vs
//       ga call style) -> keep it and make it no-op when the shared snippet has already run, guarded by the
//       sentinel the shared snippet necessarily leaves behind (its own globals);
//   (c) Jo Wilder has no per-game override at all -> there is nothing to resolve, and the card is the diff and the
//       single-report check. That is reported as such, not as a pass of work never done.
//
// Nothing here edits the shared snippet or the shared template: they belong to Analytics.1/Analytics.2, and a
// difference that would have to be fixed there is reported, never patched. Everything is pure — the HTML and the
// snippet are passed in as text — so the rules are testable without the CDN, the network or a browser.
import {
  blockMatches, compareBlocks, markedBlock, MARKER_START, normaliseBlock, type BlockDiff,
} from './channel-edge-cases.ts';
import { CHANNEL_PARAM, REFERRER_PARAM } from './channel-runtime.ts';
import { LEGACY_REFERRER_PARAM } from './channel-forwarding.ts';
import { findFirst, innerPaths, overridePaths, SNIPPET_PATH, type FileReader, type FoundFile } from './channel-wrappers.ts';

/** The game this card is about, by catalog slug and CDN folder. */
export const JOWILDER = { slug: 'jo-wilder', cdn: 'fieldday/jowilder' } as const;

/** The cards that own what this one must not touch, named in every report so a blocker lands on the right card. */
export const SHARED_SNIPPET_CARD = 'Analytics.1a: vault-channel.js core';
export const TEMPLATE_CARD = 'Analytics.2: include vault-channel.js in both CDN wrapper layers';

// ---------- what the inline block is, as logic ----------

/**
 * The logic of a channel block, reduced to the values that decide what gets reported. Two blocks with the same
 * facts here report the same channel for the same address however differently they are written; two blocks that
 * differ here are a real difference, and the card may not "simplify" one into the other.
 */
export interface ChannelLogic {
  /** The query parameters the block reads ('vault_ch', 'vault_src', 'vault_referrer'), sorted. */
  params: string[];
  /** The short-key alias table, key -> reported hostname. */
  aliases: Record<string, string>;
  /** The source-origin table, origin -> reported hostname. */
  origins: Record<string, string>;
  /** Analytics dimensions the block sets ('dimension1'), sorted. */
  dimensions: string[];
  /** The utm tags the block sets ('utm_medium', 'utm_source'), sorted. */
  utm: string[];
  /** The medium values it reports ('referral', 'vault-player'), sorted. */
  mediums: string[];
  /** Whether it falls back to 'vault' inside the player. */
  defaultsToVault: boolean;
  /** Whether an unknown https source is reported as 'other'. */
  fallsBackToOther: boolean;
}

const PAIR = /(?:(['"])([^'"\n]+)\1|([A-Za-z_$][\w$]*))\s*:\s*(['"])([^'"\n]+)\4/g;
const QUOTED_ALL = /['"]([^'"\n]{1,120})['"]/g;

/** Every `key: 'value'` pair in a source, in the order written (both tables are plain object literals). */
export function stringPairs(source: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [, , quoted, bare, , value] of source.matchAll(PAIR)) out.push([quoted ?? bare ?? '', value]);
  return out;
}

const quotedStrings = (source: string) => [...source.matchAll(QUOTED_ALL)].map(([, s]) => s);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * The logic of one channel block, read out of its source. Deliberately name-blind: the tables are recognised by
 * what is IN them (an origin key is an https:// address, an alias key is a short key) and not by the variable they
 * are assigned to, so renaming `VAULT_CHANNEL_ALIASES` is correctly seen as a non-logic difference.
 */
export function channelLogic(source: string): ChannelLogic {
  const aliases: Record<string, string> = {};
  const origins: Record<string, string> = {};
  for (const [key, value] of stringPairs(source)) {
    if (/^https?:\/\//i.test(key)) origins[key] = value;
    else if (/^[a-z][a-z0-9_.-]*$/i.test(key) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) aliases[key] = value;
  }
  const strings = quotedStrings(source);
  return {
    params: sorted(strings.filter((s) => [CHANNEL_PARAM, REFERRER_PARAM, LEGACY_REFERRER_PARAM].includes(s))),
    aliases,
    origins,
    dimensions: sorted(strings.filter((s) => /^dimension\d+$/.test(s))),
    utm: sorted(strings.filter((s) => /^utm_[a-z]+$/.test(s))),
    mediums: sorted(strings.filter((s) => s === 'referral' || s === 'vault-player')),
    defaultsToVault: strings.includes('vault'),
    fallsBackToOther: strings.includes('other'),
  };
}

// ---------- classifying a difference ----------

export type DiffKind = 'logic' | 'non-logic';

/** One classified difference between Jo Wilder's inline block and the shared snippet. */
export interface ChannelDifference {
  kind: DiffKind;
  /** What differs ('the alias table', 'the dimension set'). */
  what: string;
  /** Jo Wilder's side, then the shared snippet's, as the report prints them. */
  inline: string;
  shared: string;
}

const show = (value: unknown): string => {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, string>).sort(([a], [b]) => a.localeCompare(b));
    return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(', ') : '(none)';
  }
  return String(value);
};

const same = (a: unknown, b: unknown) => show(a) === show(b);

/**
 * The fields the SHARED SNIPPET actually owns, and so the only ones a difference against it can be read from. The
 * snippet is the resolution core: the two tables, the medium rule and the defaults. It deliberately contains no
 * gtag/ga reporting and does not read the query itself (`vaultResolveChannel` takes the values as arguments), so
 * comparing a wrapper's reporting or its parameter reading against the snippet would report a "difference" that is
 * only the snippet's documented scope, and would push every game into a needless rewrite.
 */
export const RESOLUTION_FIELDS: readonly [keyof ChannelLogic, string][] = [
  ['aliases', 'the alias table'],
  ['origins', 'the source-origin table'],
  ['mediums', 'the medium values reported'],
  ['defaultsToVault', "the default 'vault' inside the player"],
  ['fallsBackToOther', "the 'other' fallback for an unknown https source"],
];

/**
 * The fields the CALLING LAYER owns — which parameters are read, which dimension carries the channel, which utm
 * tags are set. The shared snippet has none of these, so they are compared against the shared LAYER of the page
 * (the template's own block), never against the snippet file.
 */
export const REPORTING_FIELDS: readonly [keyof ChannelLogic, string][] = [
  ['params', 'the query parameters read'],
  ['dimensions', 'the analytics dimensions set'],
  ['utm', 'the utm tags set'],
];

/** Every difference in the resolution core: a different alias entry, origin entry, medium value or default. */
export function logicDifferences(inline: string, shared: string): ChannelDifference[] {
  const a = channelLogic(inline), b = channelLogic(shared);
  const out: ChannelDifference[] = [];
  for (const [field, what] of RESOLUTION_FIELDS) {
    if (!same(a[field], b[field])) out.push({ kind: 'logic', what, inline: show(a[field]), shared: show(b[field]) });
  }
  return out;
}

/**
 * Whether the shared layer reports everything Jo Wilder's inline block reports: the same dimension, the same utm
 * tags, from the same parameters. Only then can the inline block be deleted outright — otherwise deleting it would
 * drop a tag Jo Wilder sets today, and the block is kept and deferred instead.
 */
export function reportingCovered(inline: string, sharedLayer: string | null): { covered: boolean; differences: ChannelDifference[] } {
  const a = channelLogic(inline);
  if (sharedLayer === null) {
    return {
      covered: false,
      differences: REPORTING_FIELDS.filter(([f]) => show(a[f]) !== '(none)').map(([field, what]) => ({
        kind: 'non-logic' as DiffKind, what,
        inline: show(a[field]), shared: 'not in the shared snippet (it resolves only; the reporting layer is its caller)',
      })),
    };
  }
  const b = channelLogic(sharedLayer);
  const differences: ChannelDifference[] = [];
  for (const [field, what] of REPORTING_FIELDS) {
    if (!same(a[field], b[field])) differences.push({ kind: 'logic', what, inline: show(a[field]), shared: show(b[field]) });
  }
  return { covered: differences.length === 0, differences };
}

/**
 * The whole classification: the resolution-core differences and the reporting ones, plus — when the two are the
 * same logic written differently — one non-logic entry saying so. The card turns on exactly this list: no `logic`
 * entry means the inline block is a true duplicate and may be deleted; a `logic` entry means it must be kept and
 * deferred instead, never rewritten.
 */
export function classifyDifferences(inline: string, shared: string, sharedLayer: string | null = null): ChannelDifference[] {
  const logic = [...logicDifferences(inline, shared), ...reportingCovered(inline, sharedLayer).differences];
  if (logic.length) return logic;
  if (normaliseBlock(inline) === normaliseBlock(shared)) return [];
  return [{
    kind: 'non-logic',
    what: 'how the same logic is written (identifier names, comments, formatting, call style)',
    inline: `${normaliseBlock(inline).split('\n').length} line(s)`,
    shared: `${normaliseBlock(shared).split('\n').length} line(s)`,
  }];
}

export const hasLogicDifference = (diffs: readonly ChannelDifference[]) => diffs.some((d) => d.kind === 'logic');

// ---------- the inline block in Jo Wilder's own page ----------

/** An inline `<script>` in a wrapper, with where it sits in the HTML so it can be edited in place. */
export interface InlineScript {
  /** The script element, opening tag to closing tag. */
  element: string;
  /** Its body, without the tags. */
  body: string;
  /** Where the element starts and ends in the HTML. */
  start: number;
  end: number;
  /** The indent the element is written at, so a rewrite keeps the page's shape. */
  indent: string;
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** Signs a script is channel code: it reads one of the parameters and reports a channel or a source dimension. */
const READS_PARAM = new RegExp(`\\b(?:${[CHANNEL_PARAM, REFERRER_PARAM, LEGACY_REFERRER_PARAM].join('|')})\\b`);
const REPORTS = /\bdimension\d+\b|\butm_(?:source|medium)\b|\bgtag\s*\(|\bga\s*\(|dataLayer\s*\.\s*push/;

/** Whether this script body is channel code at all. */
export const isChannelScript = (body: string) => READS_PARAM.test(body) && REPORTS.test(body);

/**
 * Jo Wilder's inline channel script, or null when its page has none. The LAST such script is taken: a page that
 * includes the shared snippet with `<script src>` and then its own inline block is the case this card exists for,
 * and `src` scripts are never candidates (nothing is fetched here).
 */
export function inlineChannelScript(html: string): InlineScript | null {
  let found: InlineScript | null = null;
  for (const match of html.matchAll(SCRIPT)) {
    const [element, attrs, body] = match;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (!isChannelScript(body)) continue;
    const start = match.index ?? 0;
    const lineStart = html.lastIndexOf('\n', start) + 1;
    found = {
      element, body, start, end: start + element.length,
      indent: /^[ \t]*/.exec(html.slice(lineStart, start))?.[0] ?? '',
    };
  }
  return found;
}

/**
 * The block of the inline script this card compares with the shared snippet: what is between the markers when the
 * wrapper carries them, else the whole body (Jo Wilder's deployed copy predates the markers).
 */
export const comparableBlock = (body: string) => markedBlock(body) ?? body;

// ---------- the deferral guard ----------

export const DEFER_START = 'VAULT_CHANNEL_DEFER_START';
export const DEFER_END = 'VAULT_CHANNEL_DEFER_END';

/**
 * How the inline block knows the shared snippet has already run. The shared snippet declares its resolution core as
 * globals (`vaultResolveChannel`, `VAULT_CHANNEL_ALIASES`), so its presence is testable without adding a flag to
 * it — which this card may not do. `__vaultChannelReported` is honoured as well, for a snippet that later sets one.
 */
export const SHARED_SENTINEL =
  "typeof vaultResolveChannel === 'function' || typeof VAULT_CHANNEL_ALIASES !== 'undefined' " +
  "|| (typeof window !== 'undefined' && window.__vaultChannelReported)";

/** Whether this source has already been made to defer (so applying the resolution twice changes nothing). */
export const alreadyDefers = (source: string) => source.includes(DEFER_START) || source.includes(SHARED_SENTINEL);

/** The inline block wrapped so it does nothing when the shared snippet has already reported the channel. */
export function deferBody(body: string, indent = '  '): string {
  const inner = body.replace(/\r\n/g, '\n').split('\n')
    .map((l) => (l.trim() === '' ? '' : `${indent}  ${l}`)).join('\n');
  return [
    `${indent}/* ${DEFER_START} — Analytics.3a: the shared snippet (src/cdn/vault-channel.js) now carries this`,
    `${indent}   logic for every game, so Jo Wilder's own copy stands down when it has already run and the channel`,
    `${indent}   is reported once per load, not once per layer. Kept, not deleted: it differs from the shared`,
    `${indent}   snippet in how it is written, and rewriting Jo Wilder's logic is not this card's to do. */`,
    `${indent}(function () {`,
    `${indent}  if (${SHARED_SENTINEL}) return;`,
    inner.replace(/\n+$/, ''),
    `${indent}}());`,
    `${indent}/* ${DEFER_END} */`,
  ].join('\n');
}

// ---------- the resolution ----------

/**
 * Whether the shared snippet REPORTS the channel, or only resolves it. As Analytics.1a landed it, vault-channel.js
 * is the resolution core alone: its own header says the gtag/ga calls are deliberately left out for Analytics.1b.
 * This matters more than anything else in this file — an inline block made to stand down for a snippet that reports
 * nothing would report nothing either, and Jo Wilder would silently stop reporting its channel, which is exactly
 * the behaviour change this card may not make.
 */
export const REPORTING_SIGNS: readonly RegExp[] = [
  /\bgtag\s*\(/,
  /\bga\s*\(/,
  /dataLayer\s*\.\s*push/,
  /\bdimension\d+\b/,
  /\butm_(?:source|medium)\b/,
];

/** Whether the shared snippet reports anything at all (not merely resolves). */
export const sharedReports = (shared: string) => REPORTING_SIGNS.some((re) => re.test(shared));

/**
 * Whether the SHARED layer of this page reports the channel — the page with Jo Wilder's own inline block cut out,
 * carrying the markers and a report of its own. That, and not the snippet file alone, is what decides whether Jo
 * Wilder's block can safely stand down: the template may wrap the resolution core in its own reporting (that is
 * Analytics.1b/2's job), in which case there IS a second reporter and the duplicate must go.
 */
export function pageSharedReports(html: string, inline?: InlineScript | null): boolean {
  const rest = inline ? `${html.slice(0, inline.start)}${html.slice(inline.end)}` : html;
  return rest.includes(MARKER_START) && sharedReports(rest);
}

export type Resolution =
  | 'no-override'              // (c) Jo Wilder receives the shared template: nothing to resolve
  | 'already-resolved'         // the override already defers (a re-run)
  | 'delete-duplicate'         // (a) same logic: the inline copy goes
  | 'defer-to-shared'          // (b) written differently: the inline copy stands down at runtime
  | 'shared-does-not-report';  // the shared snippet only resolves: standing down would silence Jo Wilder

/** What was decided about Jo Wilder's page, the rewritten page when it changed, and why. */
export interface ResolutionResult {
  resolution: Resolution;
  reason: string;
  /** The page as it should now be; the input unchanged when nothing had to change. */
  html: string;
  changed: boolean;
  /** The classified differences the decision was made on. */
  differences: ChannelDifference[];
}

/**
 * Resolves the duplication in Jo Wilder's own page. `html` is Jo Wilder's per-game override (or inner frame) and
 * `shared` the shared snippet; the shared snippet is only ever read.
 */
export function resolveJoWilder(html: string, shared: string): ResolutionResult {
  const script = inlineChannelScript(html);
  if (!script) {
    return {
      resolution: 'no-override', changed: false, html, differences: [],
      reason: 'Jo Wilder carries no inline channel script of its own here: it receives the shared template, so there '
        + 'is no duplicate to remove and no code change to make. The diff and the single-report check are the card.',
    };
  }
  if (alreadyDefers(script.body)) {
    return {
      resolution: 'already-resolved', changed: false, html,
      differences: classifyDifferences(comparableBlock(script.body), comparableBlock(shared)),
      reason: 'Jo Wilder\'s inline block already defers to the shared snippet; nothing to change.',
    };
  }
  const differences = classifyDifferences(comparableBlock(script.body), comparableBlock(shared));
  // The one case where doing nothing is the only correct answer: the shared snippet resolves the channel but does
  // not report it yet (Analytics.1b owns the reporting). Removing or deferring Jo Wilder's block now would leave
  // NOTHING reporting the channel for the reference game, so the duplication is reported and left in place.
  if (!sharedReports(shared) && !pageSharedReports(html, script)) {
    return {
      resolution: 'shared-does-not-report', changed: false, html, differences,
      reason: `the shared snippet (${SNIPPET_PATH}) resolves the channel but makes no gtag/ga report of its own yet, `
        + 'so there is no double report to remove: deleting or deferring Jo Wilder\'s inline block would stop the '
        + `channel being reported at all. Left exactly as it is until the shared reporting lands (**${SHARED_SNIPPET_CARD}** `
        + 'and its 1b sibling own that); Jo Wilder\'s observable behaviour is unchanged.',
    };
  }
  if (!hasLogicDifference(differences)) {
    const before = html.slice(0, script.start).replace(/[ \t]+$/, '');
    const note = `${script.indent}<!-- Analytics.3a: Jo Wilder's inline channel block is gone: it was the same logic as the\n`
      + `${script.indent}     shared snippet (src/cdn/vault-channel.js), which every wrapper now includes, and two copies\n`
      + `${script.indent}     reported the same play twice. Nothing else in this page changed. -->`;
    return {
      resolution: 'delete-duplicate', changed: true,
      html: `${before}${note}${html.slice(script.end)}`,
      differences,
      reason: differences.length
        ? 'the inline block is the shared snippet\'s logic written differently in no way that changes what is '
          + 'reported, so the duplicate is deleted and the shared snippet reports the channel'
        : 'the inline block is the shared snippet\'s logic, so the duplicate is deleted and the shared snippet '
          + 'reports the channel',
    };
  }
  const guarded = script.element.replace(script.body, `\n${deferBody(script.body.replace(/^\n/, ''), script.indent)}\n${script.indent}`);
  return {
    resolution: 'defer-to-shared', changed: true,
    html: `${html.slice(0, script.start)}${guarded}${html.slice(script.end)}`,
    differences,
    reason: `the inline block differs from the shared snippet in ${differences.filter((d) => d.kind === 'logic').length} `
      + 'way(s) that change what is reported, so it is kept exactly as it is and made to stand down when the shared '
      + 'snippet has already run — Jo Wilder\'s own logic is not rewritten here',
  };
}

// ---------- the whole check, as the card reports it ----------

/** Everything the card needs from the worktree, or the reason it cannot be done yet. */
export interface JoWilderCheck {
  snippet: FoundFile;
  /** Jo Wilder's per-game outer page, if it has one. */
  outer: FoundFile;
  /** Jo Wilder's inner frame (the built iframe.html), if it has one. */
  inner: FoundFile;
  /** The marker-block diff of the built inner frame against the shared snippet (AC1). */
  block: BlockDiff;
  /** The decision about Jo Wilder's own layer (AC's "resolve in the game-specific layer only"). */
  plan: ResolutionResult | null;
  /** Why no decision could be made (which sibling card has not landed), or null. */
  gate: string | null;
}

/** Reads the snippet, Jo Wilder's override and its built inner frame, and decides what this card must do. */
export function checkJoWilder(read: FileReader): JoWilderCheck {
  const snippet = findFirst(read, [SNIPPET_PATH]);
  const outer = findFirst(read, overridePaths(JOWILDER.cdn));
  const inner = findFirst(read, innerPaths(JOWILDER.cdn));
  const block = compareBlocks(inner.text, snippet.text, inner.path ?? `${JOWILDER.cdn}/iframe.html`, SNIPPET_PATH);
  const reasons: string[] = [];
  if (snippet.text === null) {
    reasons.push(`The shared snippet \`${SNIPPET_PATH}\` is not in this worktree: it is written by **${SHARED_SNIPPET_CARD}**, `
      + 'which this card is serialized after and must not re-implement.');
  }
  if (inner.text === null) {
    reasons.push(`Jo Wilder has no built \`iframe.html\` in this worktree (looked in ${inner.tried.map((p) => `\`${p}\``).join(', ')}), `
      + `so the ${'VAULT_CHANNEL_LOGIC_START'}/END block cannot be diffed against the shared snippet. The wrapper template that emits `
      + `those markers is written by **${TEMPLATE_CARD}**, which has not landed on this branch.`);
  }
  const page = outer.text ?? inner.text;
  const plan = snippet.text !== null && page !== null ? resolveJoWilder(page, snippet.text) : null;
  return { snippet, outer, inner, block, plan, gate: reasons.length ? reasons.join('\n\n') : null };
}

/** Whether the built inner frame still carries the shared snippet's block unchanged (AC1's pass). */
export const blockHeld = (check: JoWilderCheck) => blockMatches(check.block);

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** The check as Markdown: the report the card's completion comment is written from. */
export function joWilderReport(check: JoWilderCheck): string {
  const lines: string[] = [];
  lines.push('# Analytics.3a — Jo Wilder\'s inline channel block defers to the shared snippet', '');
  lines.push(`Shared snippet: ${check.snippet.path ?? 'not found'}`);
  lines.push(`Jo Wilder's override: ${check.outer.path ?? 'none (it receives the shared template)'}`);
  lines.push(`Jo Wilder's built inner frame: ${check.inner.path ?? 'not built in this worktree'}`, '');

  lines.push('## The marker block against the shared snippet', '');
  lines.push(`Verdict: **${check.block.verdict}** — ${check.block.reason} (${check.block.deployedLines} vs ${check.block.snippetLines} code lines)`, '');
  if (check.block.diff) lines.push('```diff', check.block.diff, '```', '');

  lines.push('## The inline block, difference by difference', '');
  if (!check.plan) lines.push('Not classified: there is nothing to compare yet (see below).', '');
  else if (!check.plan.differences.length) lines.push('No difference at all: the inline block is the shared snippet\'s logic, byte for byte.', '');
  else {
    lines.push(row(['Kind', 'What', 'Jo Wilder', 'Shared snippet']));
    lines.push(row(['---', '---', '---', '---']));
    for (const d of check.plan.differences) lines.push(row([d.kind.toUpperCase(), cell(d.what), cell(d.inline), cell(d.shared)]));
    lines.push('');
  }

  lines.push('## What this card does to Jo Wilder\'s layer', '');
  if (check.plan) lines.push(`**${check.plan.resolution}** — ${check.plan.reason}`, '');
  if (check.gate) {
    lines.push('## Not fully checkable yet', '', check.gate, '',
      'Neither the shared snippet nor the shared template was touched to work around this.', '');
  }
  return `${lines.join('\n')}\n`;
}

/** 1 when the card's own check failed (the block drifted); a missing dependency is reported, not a drift. */
export const checkFails = (check: JoWilderCheck) => check.inner.text !== null && !blockHeld(check);
