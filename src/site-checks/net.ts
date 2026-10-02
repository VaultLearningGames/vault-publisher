// Plain HTTP for the engine: the sitemap, the site's front door, and link probes. With the guard on, every request
// goes through net-guard's guardedFetcher (public addresses only); with it off, plain fetch.
import type { Readable } from 'node:stream';
import { BlockedUrlError, guardedFetcher } from '../net-guard.ts';
import type { LinkProbe } from '../site-checks.ts';
import { limiter, sleep, UA } from './util.ts';

export interface GotUrl { status: number; finalUrl: string; text(max?: number): Promise<string>; close(): void }
export type Getter = (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<GotUrl>;

const HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

// Error codes the way src/game-checks.ts's errorKind() reads them.
export function errorOf(err: unknown): { code: string; message: string } {
  if (err instanceof BlockedUrlError) {
    return /redirects too many/i.test(err.message) ? { code: 'TOO_MANY_REDIRECTS', message: 'too many redirects' } : { code: 'BLOCKED', message: err.message };
  }
  const e = err as Error & { code?: string; cause?: Error & { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { code: 'TimeoutError', message: 'timed out' };
  const cause = e?.cause;
  const message = cause?.message ?? e?.message ?? String(err);
  if (/redirect count exceeded|too many redirects/i.test(message)) return { code: 'TOO_MANY_REDIRECTS', message: 'too many redirects' };
  return { code: cause?.code ?? e?.code ?? e?.name ?? 'Error', message };
}

async function readStream(body: Readable, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size >= max) break;
  }
  body.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

export function makeGetter(guard: boolean): Getter {
  if (guard) {
    const fetcher = guardedFetcher();
    return async (url, timeoutMs, signal) => {
      const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await fetcher(url, { headers: HEADERS, signal: abort });
      return { status: res.status, finalUrl: res.url, text: (max = 5_000_000) => readStream(res.body, max), close: () => { res.body.destroy(); } };
    };
  }
  return async (url, timeoutMs, signal) => {
    const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { redirect: 'follow', signal: abort, headers: HEADERS });
    return { status: res.status, finalUrl: res.url, text: () => res.text(), close: () => { res.body?.cancel().catch(() => {}); } };
  };
}

// Whether the checker itself can still reach the site. When the checker's own connection drops, every page, link and
// game "fails"; those failures say nothing about the site, so the engine asks here before believing a network error,
// waits for the connection to return, and tries again. A connection that stays away stops the run instead.
export class OfflineError extends Error {}
export interface Connection { ok(): Promise<boolean>; wait(): Promise<void> }
export function makeConnection(get: Getter, origin: string, signal?: AbortSignal, maxWaitMs = 3 * 60_000): Connection {
  let last: { at: number; ok: Promise<boolean> } | null = null;
  const ask = () => get(`${origin}/`, 10_000, signal).then((r) => { r.close(); return true; }, () => false);
  // One answer serves everyone who asks within a few seconds.
  const ok = () => { if (!last || Date.now() - last.at > 5000) last = { at: Date.now(), ok: ask() }; return last.ok; };
  return {
    ok,
    async wait() {
      for (const end = Date.now() + maxWaitMs; ;) {
        if (signal?.aborted || (await ok())) return;
        if (Date.now() > end) throw new OfflineError(`The checker lost its connection to ${origin} and it didn't come back`);
        await sleep(5000);
      }
    },
  };
}

// One address, asked for once and again after 2 s when the answer may be a passing problem (a network error, 5xx, 429).
export async function probe(get: Getter, url: string, signal?: AbortSignal): Promise<LinkProbe> {
  let last: LinkProbe = { status: null, error: null, finalUrl: null, attempts: 0, anchorFound: null };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await get(url, 15_000, signal);
      res.close();
      last = { status: res.status, error: null, finalUrl: res.finalUrl, attempts: attempt, anchorFound: null };
      if (res.status < 500 && res.status !== 429) return last;
    } catch (err) {
      const error = errorOf(err);
      last = { status: null, error, finalUrl: null, attempts: attempt, anchorFound: null };
      if (error.code === 'BLOCKED' || signal?.aborted) return last;
    }
    if (attempt === 1) await sleep(2000);
  }
  return last;
}

// Probes with at most `total` requests at once and `perHost` to any one host.
export function makeProber(get: Getter, total = 8, perHost = 2, signal?: AbortSignal, connection?: Connection): (url: string) => Promise<LinkProbe> {
  // A network error while the checker itself is offline is asked again once it is back.
  const careful = async (url: string) => {
    const first = await probe(get, url, signal);
    if (!first.error || first.error.code === 'BLOCKED' || !connection || (await connection.ok())) return first;
    await connection.wait();
    return probe(get, url, signal);
  };
  const all = limiter(total);
  const hosts = new Map<string, ReturnType<typeof limiter>>();
  return (url) => {
    let host = '';
    try { host = new URL(url).host; } catch { /* probed as is; the request reports it */ }
    let lane = hosts.get(host);
    if (!lane) { lane = limiter(perHost); hosts.set(host, lane); }
    // The host's slot first, so waiting on one slow host never holds a global slot.
    return lane(() => all(() => careful(url)));
  };
}
