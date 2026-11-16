// Runtime verification that a game's deployed CDN wrapper really resolves and reports the acquisition channel
// (?vault_ch=pbswi → pbswisconsineducation.org; no source params → vault), observed in a browser rather than read
// out of the source. The card this answers is "Analytics.4c: runtime-verify channel value (pbswi vs no-param) in
// the staging player"; scripts/verify-channel-runtime.ts is the command, docs/analytics.md the background.
//
// Everything here is pure: the browser work lives in the script, so the rules (what channel a load must report,
// what counts as a call, and what makes a game a blocker) are unit-testable without a browser or the network.
//
// The chain under test, per game:
//   1. the site's player (vault-site partials/vault-player.html) reads ?vault_ch / vault_src / document.referrer and
//      puts vault_ch on the <iframe src> it builds (withReferrer);
//   2. the CDN wrapper (STUDIO/GAME/index.html, the click-to-play page) forwards it to its inner iframe.html;
//   3. the shared snippet in those wrappers resolves the channel and reports it with the play events as
//      source_channel (src/analytics/reports.ts DIM_SOURCE).
// A failure at step 1 or 2 is as much a blocker as a wrong value in step 3, so the result records which layer was
// reached: the report can say "the player did not forward the param" instead of blaming the snippet.
import { canonicalSourceChannel } from './analytics/reports.ts';

/** The channel a play through the Vault's own site reports when no partner sent the visitor. */
export const VAULT_CHANNEL = 'vault';
/** The query parameter a partner link carries (PBS Wisconsin's "Play the game" button hardcodes ?vault_ch=pbswi). */
export const CHANNEL_PARAM = 'vault_ch';
/** The parameter naming the exact origin a visitor came from, set beside the channel. */
export const REFERRER_PARAM = 'vault_src';
/** Event parameter keys that carry the channel in a gtag call or a GA collect hit (`ep.` prefix stripped). */
export const CHANNEL_KEYS = ['source_channel', 'vault_ch', 'channel'];
/** The play events the channel rides on; only these are expected to report it. */
export const CHANNEL_EVENTS = ['play_start', 'play_heartbeat', 'play_end'];

/** A game to verify: its page on the site and the CDN wrapper the player is expected to open. */
export interface GameTarget {
  /** The catalog slug, as the report names it. */
  slug: string;
  /** The game's page on the site, a path ('/jo-wilder-and-the-capitol-case/'). */
  page: string;
  /** The CDN wrapper the listing plays, or null when the listing isn't CDN-hosted. */
  cdnUrl: string | null;
}

/** One recorded analytics call: a gtag/dataLayer call in some frame, or a GA collect request. */
export interface ChannelCall {
  /** 'gtag' | 'dataLayer' | 'collect' — how it was captured. */
  via: 'gtag' | 'dataLayer' | 'collect';
  /** The event name, when the call named one. */
  event: string | null;
  /** The channel value the call carried, '' when it carried the key with an empty value, null when it had no channel key. */
  channel: string | null;
  /** The document that made the call, so an outer/inner duplicate is attributable. */
  frameUrl: string;
}

/** What one load (one URL) observed. */
export interface LoadResult {
  /** The address loaded, exactly as given to the browser. */
  url: string;
  /** The channel this load must report. */
  expected: string;
  /** Every call seen, in order. */
  calls: ChannelCall[];
  /** How the calls were captured, for the completion comment ('stubbed gtag + network'). */
  method: string;
  /** Why the load could not be judged (no browser, the page never loaded), or null. */
  error: string | null;
}

// ---------- what a load must report ----------

/** The channel a load of `url` must report: the canonical form of its vault_ch, else the partner origin's, else 'vault'. */
export function expectedChannel(url: string, sourceChannelOf: (origin: string) => string | null = () => null): string {
  let params: URLSearchParams;
  try { params = new URL(url).searchParams; } catch { return VAULT_CHANNEL; }
  const given = canonicalSourceChannel((params.get(CHANNEL_PARAM) ?? '').trim().toLowerCase());
  if (given) return given;
  const src = (params.get(REFERRER_PARAM) ?? '').trim();
  if (src) {
    try { return sourceChannelOf(new URL(src).origin) ?? 'other'; } catch { /* not an address: fall through */ }
  }
  return VAULT_CHANNEL;
}

/** The channel value in a gtag call's parameters, or null when none of the known keys is there. */
export function channelInParams(params: Record<string, unknown> | null | undefined): string | null {
  if (!params || typeof params !== 'object') return null;
  for (const key of CHANNEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const value = (params as Record<string, unknown>)[key];
      return value == null ? '' : String(value).trim();
    }
  }
  return null;
}

/** The channel a GA4 collect request reports (its `ep.source_channel` query parameter), or null. */
export function channelInCollectUrl(url: string): string | null {
  let search: URLSearchParams;
  try { search = new URL(url).searchParams; } catch { return null; }
  for (const key of CHANNEL_KEYS) {
    for (const name of [`ep.${key}`, key]) {
      const value = search.get(name);
      if (value !== null) return value.trim();
    }
  }
  return null;
}

/** Whether a collect request's URL is a GA4 hit (so a page's own analytics isn't mistaken for a game's). */
export const isCollectUrl = (url: string) =>
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:google-analytics\.com|analytics\.google\.com)\/(?:[a-z]\/|mp\/)?collect\b/i.test(url);

// ---------- judging a load ----------

/** The calls that actually carried a channel (a play event's, or any call with a channel key). */
export const channelCalls = (calls: ChannelCall[]) => calls.filter((c) => c.channel !== null);

/** The distinct channel values a load reported, in the order first seen. */
export function reportedChannels(calls: ChannelCall[]): string[] {
  const out: string[] = [];
  for (const c of channelCalls(calls)) if (c.channel !== null && !out.includes(c.channel)) out.push(c.channel);
  return out;
}

/**
 * How many times the channel was reported for one load. A gtag call and the GA collect hit it causes are ONE report,
 * so the count is per (event, channel, frame) rather than per captured call: the card asks whether the outer and
 * inner wrapper layers both report, which shows up as the same event reported from two different documents.
 */
export function channelReportCount(calls: ChannelCall[]): number {
  const keys = new Set(channelCalls(calls).map((c) => `${c.event ?? ''}\u0000${c.channel}\u0000${c.frameUrl}`));
  return keys.size;
}

export type LoadVerdict = 'pass' | 'wrong-channel' | 'duplicate' | 'not-reported' | 'error';

/** What one load proved, or failed to. */
export function loadVerdict(load: LoadResult): LoadVerdict {
  if (load.error) return 'error';
  const seen = reportedChannels(load.calls);
  if (!seen.length) return 'not-reported';
  if (seen.length > 1 || seen[0] !== load.expected) return 'wrong-channel';
  return channelReportCount(load.calls) === 1 ? 'pass' : 'duplicate';
}

/** A sentence for the report: the channel observed and how often, or why nothing could be judged. */
export function loadSummary(load: LoadResult): string {
  if (load.error) return `not verified (${load.error})`;
  const seen = reportedChannels(load.calls);
  const count = channelReportCount(load.calls);
  if (!seen.length) return `no channel reported (${load.calls.length} analytics call${load.calls.length === 1 ? '' : 's'} seen)`;
  return `${seen.map((c) => `'${c}'`).join(', ')} — reported ${count}×`;
}

// ---------- a game ----------

/** A game's two loads, or the reason it was skipped. */
export interface GameResult {
  slug: string;
  /** The CDN wrapper under test, for the report. */
  cdnUrl: string | null;
  /** Null when the game was skipped (`skipped` says why). */
  partner: LoadResult | null;
  noParam: LoadResult | null;
  /** Why this game was not verified here (e.g. Analytics.4b found no snippet), or null. */
  skipped: string | null;
}

export type GameVerdict = 'pass' | 'blocker' | 'skipped';

/** A game passes only when both loads pass; anything judged is otherwise a blocker, and a skip stays a skip. */
export function gameVerdict(game: GameResult): GameVerdict {
  if (game.skipped) return 'skipped';
  const loads = [game.partner, game.noParam].filter((l): l is LoadResult => l !== null);
  if (loads.length < 2) return 'blocker';
  return loads.every((l) => loadVerdict(l) === 'pass') ? 'pass' : 'blocker';
}

/** Why a game is a blocker, in words, or null when it isn't one. */
export function blockerReason(game: GameResult): string | null {
  if (gameVerdict(game) !== 'blocker') return null;
  const parts: string[] = [];
  const say = (what: string, load: LoadResult | null) => {
    if (!load) return parts.push(`the ${what} load was not run`);
    const verdict = loadVerdict(load);
    if (verdict === 'pass') return;
    const detail = {
      'wrong-channel': `the ${what} load reported ${reportedChannels(load.calls).map((c) => `'${c}'`).join(', ')} instead of '${load.expected}'`,
      duplicate: `the ${what} load reported '${load.expected}' ${channelReportCount(load.calls)}× (duplicate: outer and inner layers both report)`,
      'not-reported': `the ${what} load reported no channel at all`,
      error: `the ${what} load could not be verified: ${load.error}`,
    }[verdict];
    parts.push(detail);
  };
  say(`?${CHANNEL_PARAM}=pbswi`, game.partner);
  say('no-param', game.noParam);
  return parts.join('; ') || 'not verified';
}

// ---------- the report ----------

/** The whole run, as the completion comment needs it. */
export interface RunResult {
  site: string;
  /** When the run finished, ISO. */
  at: string;
  games: GameResult[];
}

const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
const fence = (s: string) => s.replace(/\|/g, '\\|');

/** The run as Markdown: a table per game plus the named blockers, ready to paste into the card. */
export function runMarkdown(run: RunResult): string {
  const lines: string[] = [];
  lines.push('# Analytics.4c — runtime channel verification (staging player)', '');
  lines.push(`Site: ${run.site}`, `Run: ${run.at}`, '');
  const verdicts = run.games.map((g) => gameVerdict(g));
  const n = (v: GameVerdict) => verdicts.filter((x) => x === v).length;
  lines.push(`Verified ${n('pass')} of ${run.games.length} games — ${n('blocker')} blocker(s), ${n('skipped')} skipped.`, '');
  lines.push(row(['Game', 'Player URL', 'Capture', `?${CHANNEL_PARAM}=pbswi`, 'No-param', 'Calls', 'Verdict']));
  lines.push(row(['---', '---', '---', '---', '---', '---', '---']));
  for (const game of run.games) {
    const verdict = gameVerdict(game);
    if (verdict === 'skipped') {
      lines.push(row([game.slug, '—', '—', '—', '—', '—', `skipped: ${fence(game.skipped ?? '')}`]));
      continue;
    }
    const counts = [game.partner, game.noParam].map((l) => (l ? channelReportCount(l.calls) : '—')).join(' / ');
    lines.push(row([
      game.slug,
      fence(game.partner?.url ?? game.noParam?.url ?? '—'),
      fence(game.partner?.method ?? game.noParam?.method ?? '—'),
      fence(game.partner ? loadSummary(game.partner) : '—'),
      fence(game.noParam ? loadSummary(game.noParam) : '—'),
      counts,
      verdict,
    ]));
  }
  const blockers = run.games.map((g) => [g, blockerReason(g)] as const).filter((p): p is readonly [GameResult, string] => p[1] !== null);
  lines.push('');
  if (blockers.length) {
    lines.push('## Blockers against "Analytics: shared vault_ch reader for all 23 CDN games"', '');
    for (const [game, reason] of blockers) lines.push(`* **${game.slug}** (${game.cdnUrl ?? 'no CDN wrapper'}): ${reason}`);
    lines.push('', 'Not hand-patched: these belong to the snippet card.');
  } else {
    lines.push('No blockers: every verified game reported the expected channel exactly once per load.');
  }
  return `${lines.join('\n')}\n`;
}

/** Exit status for the command: 0 when every game that was not skipped passed, 1 when any is a blocker. */
export const runFails = (run: RunResult) => run.games.some((g) => gameVerdict(g) === 'blocker');
