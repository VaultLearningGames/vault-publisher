// Analytics.3a: running Jo Wilder's wrapper with a stubbed gtag/ga, to count how many times one load reports the
// channel. src/channel-jowilder.ts decides what Jo Wilder's layer must look like; this proves the effect of the
// decision — a reconciled wrapper reports the channel exactly ONCE per load, for ?vault_ch=pbswi, for a vault_src
// alias case, and for no parameters at all (where the answer is 'vault').
//
// It reuses the sandbox src/channel-forward-run.ts built for the forwarding check (no DOM beyond what a wrapper
// touches, no network, no file system, no process), with gtag, ga and dataLayer.push replaced by recorders. The
// counting rule is src/channel-runtime.ts's channelReportCount, so "once" means here exactly what it means in the
// staging runtime verification: one (event, channel, document) report.
//
// Pure in the same sense as its siblings: the wrapper is passed in as text, so the check runs with no build, no CDN
// and no browser.
import { createContext, runInContext } from 'node:vm';
import { inlineScripts } from './channel-forward-run.ts';
import {
  channelInParams, channelReportCount, expectedChannel, reportedChannels, VAULT_CHANNEL,
  type ChannelCall,
} from './channel-runtime.ts';

/** Where the inner frame lives when it is run, so `location` looks like the CDN serving it. */
export const INNER_BASE = 'https://cdn.vaultlearninggames-staging.org/fieldday/jowilder/iframe.html';

/** A `gtag('set'|'event', …)`-style call as the recorder captured it, before it is read as a channel report. */
export interface RecordedCall {
  /** 'gtag' | 'ga' | 'dataLayer' — which stub took it. */
  via: 'gtag' | 'ga' | 'dataLayer';
  /** The arguments, as given. */
  args: unknown[];
}

/** What one load of a wrapper did: every analytics call, and whatever went wrong. */
export interface WrapperLoad {
  url: string;
  calls: RecordedCall[];
  /** The calls read as channel reports, the way the runtime check reads them. */
  channelCalls: ChannelCall[];
  /** Why the load could not be judged (its script threw), or null. */
  error: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The custom-dimension keys a legacy wrapper reports the channel under, beside the event parameters. */
export const DIMENSION_KEYS = [/^dimension\d+$/, /^utm_source$/, /^campaign_source$/];

/**
 * The channel a captured call carries, or null when it carries none. A gtag call's parameters are read with the
 * runtime check's own rule first (source_channel / vault_ch / channel), then the custom dimensions a hand-written
 * wrapper uses ('dimension1' is Jo Wilder's "Play source"), so a legacy report counts as a report.
 */
export function channelOfCall(call: RecordedCall): { event: string | null; channel: string | null } {
  const [first, second, third] = call.args;
  const name = typeof first === 'string' ? first : null;
  // ga('set', 'dimension1', value) and gtag('set', {dimension1: value}) both set a dimension.
  if (name === 'set' && typeof second === 'string' && DIMENSION_KEYS.some((re) => re.test(second))) {
    return { event: null, channel: third == null ? '' : String(third).trim() };
  }
  for (const params of [asRecord(second), asRecord(third), asRecord(first)]) {
    if (!params) continue;
    const known = channelInParams(params);
    if (known !== null) return { event: name === 'event' && typeof second === 'string' ? second : name, channel: known };
    for (const [key, value] of Object.entries(params)) {
      if (DIMENSION_KEYS.some((re) => re.test(key))) {
        return { event: name === 'event' && typeof second === 'string' ? second : name, channel: value == null ? '' : String(value).trim() };
      }
    }
  }
  return { event: name, channel: null };
}

/**
 * Runs a wrapper's inline scripts over `?query` with recording analytics stubs, and reports what it reported. The
 * document is the inner frame (embedded: `parent !== self`, as the player serves it), so a wrapper's "am I in the
 * Vault player" test answers the way it does in a real play.
 */
export function loadWrapper(html: string, query = '', base = INNER_BASE, embedded = true): WrapperLoad {
  const calls: RecordedCall[] = [];
  const url = query ? `${base}?${query}` : base;
  const record = (via: RecordedCall['via']) => (...args: unknown[]) => { calls.push({ via, args }); };
  type Handler = (event?: unknown) => void;
  const handlers: { type: string; fn: Handler }[] = [];

  const element = (tagName: string) => {
    const attrs = new Map<string, string>();
    return {
      tagName: tagName.toUpperCase(),
      setAttribute(name: string, value: string) { attrs.set(String(name).toLowerCase(), String(value)); },
      getAttribute(name: string) { return attrs.get(String(name).toLowerCase()) ?? null; },
      removeAttribute(name: string) { attrs.delete(String(name).toLowerCase()); },
      appendChild: (c: unknown) => c,
      insertBefore: (c: unknown) => c,
      removeChild: (c: unknown) => c,
      addEventListener: () => {},
      removeEventListener: () => {},
      style: {}, dataset: {}, children: [], childNodes: [], parentNode: null,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      click() {}, focus() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      src: '', innerHTML: '', textContent: '',
      contentWindow: null,
    };
  };

  const anyElement = element('div');
  const loc = new URL(url);
  const document = {
    readyState: 'loading',
    referrer: '',
    title: 'Jo Wilder',
    cookie: '',
    documentElement: anyElement,
    head: anyElement,
    body: anyElement,
    createElement: (tag: string) => element(tag),
    createTextNode: () => ({}),
    getElementById: () => anyElement,
    querySelector: () => anyElement,
    querySelectorAll: () => [],
    getElementsByTagName: () => [anyElement],
    getElementsByClassName: () => [anyElement],
    addEventListener: (type: string, fn: Handler) => { handlers.push({ type: String(type), fn }); },
    removeEventListener: () => {},
    write: () => {}, writeln: () => {},
    location: { href: url, search: loc.search, origin: loc.origin, pathname: loc.pathname },
  };

  const sandbox: Record<string, unknown> = {
    document,
    location: {
      href: url, search: loc.search, origin: loc.origin, protocol: loc.protocol, host: loc.host,
      hostname: loc.hostname, pathname: loc.pathname, hash: '',
      replace() {}, assign() {}, reload() {}, toString: () => url,
    },
    URL, URLSearchParams, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, parseInt, parseFloat, isNaN,
    setTimeout: (fn: () => void) => { try { fn(); } catch { /* a timer the page never needed */ } return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn: () => void) => { try { fn(); } catch { /* ditto */ } return 0; },
    cancelAnimationFrame: () => {},
    addEventListener: (type: string, fn: Handler) => { handlers.push({ type: String(type), fn }); },
    removeEventListener: () => {},
    navigator: { userAgent: 'vault-jowilder-check', language: 'en-US', sendBeacon: () => true },
    screen: { width: 1280, height: 800 }, innerWidth: 1280, innerHeight: 800,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    frameElement: embedded ? { tagName: 'IFRAME' } : null,
  };
  // The stubs under test: every report the wrapper makes is recorded, and nothing leaves this sandbox.
  sandbox.gtag = record('gtag');
  sandbox.ga = record('ga');
  sandbox.dataLayer = { push: (...args: unknown[]) => { calls.push({ via: 'dataLayer', args }); return args.length; } };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // An inner frame IS embedded: `parent !== self` and `top !== self`, which is how a wrapper knows it is in the player.
  sandbox.parent = embedded ? { postMessage: () => {} } : sandbox;
  sandbox.top = embedded ? { postMessage: () => {} } : sandbox;
  (document as unknown as Record<string, unknown>).defaultView = sandbox;

  const context = createContext(sandbox);
  let error: string | null = null;
  for (const [i, script] of inlineScripts(html).entries()) {
    try {
      runInContext(script, context, { filename: `jowilder-inline-${i}.js`, timeout: 5000 });
    } catch (err) {
      error ??= (err as Error).message.split('\n')[0];
    }
  }
  (document as { readyState: string }).readyState = 'complete';
  for (const { type, fn } of [...handlers]) {
    if (!/^(DOMContentLoaded|load|readystatechange|pageshow)$/i.test(type)) continue;
    try { fn.call(sandbox, { type }); } catch (err) { error ??= (err as Error).message.split('\n')[0]; }
  }

  const channelCalls: ChannelCall[] = [];
  for (const call of calls) {
    const { event, channel } = channelOfCall(call);
    if (channel === null) continue;
    channelCalls.push({ via: call.via === 'ga' ? 'gtag' : call.via === 'dataLayer' ? 'dataLayer' : 'gtag', event, channel, frameUrl: url });
  }
  return { url, calls, channelCalls, error };
}

/**
 * How many times one load reported the channel.
 *
 * src/channel-runtime.ts's channelReportCount deliberately DEDUPES by (event, channel, document), because there a
 * gtag call and the GA collect hit it causes are one report. That rule cannot see this card's failure: two identical
 * copies of the same block in the same document make two identical calls, which dedupe to one. So the calls are
 * counted here instead, folded the other way round — one layer's `gtag('set', {dimension1})` plus the
 * `gtag('event', 'play_start', …)` it rides on is ONE report, and a layer that sends play_start and a heartbeat is
 * still one — by taking the largest number of times any single (event, channel) was sent. One layer gives 1, two
 * copies of it give 2, which is exactly the question "reported once per load, or once per layer?".
 */
export function reportCount(load: WrapperLoad): number {
  const events = new Map<string, number>();
  const sets = new Map<string, number>();
  for (const call of load.channelCalls) {
    const bucket = call.event === null ? sets : events;
    const key = `${call.event ?? 'set'}\u0000${call.channel}`;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  // A load that only sets a dimension still reported the channel: the next hit carries it.
  const counts = [...(events.size ? events : sets).values()];
  return counts.length ? Math.max(...counts) : 0;
}

/** The same count as src/channel-runtime.ts reports it, for the report to print both side by side. */
export const dedupedReportCount = (load: WrapperLoad) => channelReportCount(load.channelCalls);

/** The distinct channels one load reported. */
export const channelsOf = (load: WrapperLoad) => reportedChannels(load.channelCalls);

/** The cases AC2 asks for, each with the channel the load must report. */
export const CASES: readonly { what: string; query: string; expected: string }[] = [
  { what: 'a partner short key', query: 'vault_ch=pbswi', expected: 'pbswisconsineducation.org' },
  { what: 'a partner source origin', query: 'vault_src=https%3A%2F%2Fwww.pbskids.org%2Fsome%2Fpath', expected: 'pbskids.org' },
  { what: 'an unknown https source', query: 'vault_src=https%3A%2F%2Fexample.org%2F', expected: 'other' },
  { what: 'no parameters at all', query: '', expected: VAULT_CHANNEL },
];

export type CaseVerdict = 'pass' | 'wrong-channel' | 'double-report' | 'not-reported' | 'error';

/** One case's result: the channel reported and how many times. */
export interface CaseResult {
  what: string;
  query: string;
  expected: string;
  channels: string[];
  count: number;
  verdict: CaseVerdict;
  error: string | null;
}

/** Runs one case against a wrapper. */
export function runCase(html: string, c: { what: string; query: string; expected: string }, base = INNER_BASE): CaseResult {
  const load = loadWrapper(html, c.query, base);
  const channels = channelsOf(load);
  const count = reportCount(load);
  const verdict: CaseVerdict = load.error && !channels.length
    ? 'error'
    : !channels.length
      ? 'not-reported'
      : channels.length > 1 || channels[0] !== c.expected
        ? 'wrong-channel'
        : count === 1 ? 'pass' : 'double-report';
  return { what: c.what, query: c.query, expected: c.expected, channels, count, verdict, error: load.error };
}

/** Every case AC2 asks for, against one wrapper. */
export const runCases = (html: string, cases: readonly { what: string; query: string; expected: string }[] = CASES, base = INNER_BASE) =>
  cases.map((c) => runCase(html, c, base));

/** Whether a wrapper reports the channel exactly once, with the right value, in every case. */
export const reportsOnce = (results: readonly CaseResult[]) => results.length > 0 && results.every((r) => r.verdict === 'pass');

/** The utm tags and the channel one load produced, as AC3 compares them before and after the change. */
export interface ChannelOutputs {
  /** The channel values reported, sorted. */
  channels: string[];
  /** Every utm / dimension value the load set, as `key=value`, sorted — the alias normalisation's visible output. */
  tags: string[];
}

const TAG_KEYS = /^(?:utm_[a-z]+|dimension\d+|campaign_source|campaign_medium|source_channel|vault_ch|channel)$/;

/** What a load set, as comparable output: the same inputs must produce the same outputs before and after this card. */
export function outputsOf(load: WrapperLoad): ChannelOutputs {
  const tags = new Set<string>();
  for (const call of load.calls) {
    const [first, second, third] = call.args;
    if (first === 'set' && typeof second === 'string' && TAG_KEYS.test(second)) tags.add(`${second}=${third == null ? '' : String(third)}`);
    for (const params of [asRecord(second), asRecord(third), asRecord(first)]) {
      if (!params) continue;
      for (const [key, value] of Object.entries(params)) {
        if (TAG_KEYS.test(key)) tags.add(`${key}=${value == null ? '' : String(value)}`);
      }
    }
  }
  return { channels: channelsOf(load).slice().sort(), tags: [...tags].sort() };
}

/** One wrapper's outputs for every case, keyed by the query — what AC3's before/after comparison is made on. */
export function outputsByCase(html: string, cases: readonly { query: string }[] = CASES, base = INNER_BASE): Record<string, ChannelOutputs> {
  const out: Record<string, ChannelOutputs> = {};
  for (const c of cases) out[c.query] = outputsOf(loadWrapper(html, c.query, base));
  return out;
}

/** Whether two runs of the same wrapper (before and after this card) produced identical outputs for every case. */
export function outputsUnchanged(before: Record<string, ChannelOutputs>, after: Record<string, ChannelOutputs>): boolean {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.every((k) => JSON.stringify(before[k] ?? null) === JSON.stringify(after[k] ?? null));
}

/** The channel a case's query must report, from the shared rule, so the expectations are never hand-maintained. */
export const expectedFor = (query: string, base = INNER_BASE) =>
  expectedChannel(query ? `${base}?${query}` : base, (origin) => {
    const known: Record<string, string> = {
      'https://pbskids.org': 'pbskids.org', 'https://www.pbskids.org': 'pbskids.org',
      'https://pbswisconsineducation.org': 'pbswisconsineducation.org',
      'https://www.pbswisconsineducation.org': 'pbswisconsineducation.org',
      'https://pbslearningmedia.org': 'pbslearningmedia.org', 'https://www.pbslearningmedia.org': 'pbslearningmedia.org',
      'https://sciencegamecenter.org': 'sciencegamecenter.org', 'https://www.sciencegamecenter.org': 'sciencegamecenter.org',
    };
    return known[origin] ?? null;
  });
