// Fetching addresses that people type into the portal (URL monitors) without letting them reach anything private.
// Only http(s); no credentials in the address; the host must resolve to public addresses only. The address check
// runs inside the connection's own DNS lookup, so the address that was checked is the address that is connected to
// (a name can't answer "public" for the check and "private" for the connection). Redirects are followed by hand, and
// every hop goes through the same checks.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';

export class BlockedUrlError extends Error {}

function v4Blocked(a: number, b: number, c: number): string | null {
  if (a === 0) return 'an unspecified address';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'a private network address';
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-private address';
  if (a === 127) return 'a loopback address';
  if (a === 169 && b === 254) return 'a link-local address';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'a reserved address';
  if ((a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'a reserved address';
  if (a >= 224) return 'a multicast or reserved address';
  return null;
}

// The 8 groups of an IPv6 address, or null if it isn't one. Handles "::" and a dotted IPv4 tail.
function v6Groups(ip: string): number[] | null {
  let s = ip.replace(/%.*$/, ''); // zone id
  const tail = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = s.slice(0, tail.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]), rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + rest.length > 7) return null;
  return [...head, ...Array(8 - head.length - rest.length).fill(0), ...rest];
}

// Why an IP address may not be fetched (null: it's a public address).
export function blockedAddress(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return v4Blocked(a, b, c);
  }
  if (family !== 6) return 'not an IP address';
  const g = v6Groups(ip);
  if (!g) return 'not an IP address';
  const embedded = () => v4Blocked(g[6] >> 8, g[6] & 255, g[7] >> 8);
  if (g.slice(0, 6).every((x) => x === 0)) {
    if (g[6] === 0 && g[7] === 0) return 'an unspecified address';
    if (g[6] === 0 && g[7] === 1) return 'a loopback address';
    return embedded() ?? 'a reserved address';                                     // ::a.b.c.d (deprecated)
  }
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded();   // ::ffff:a.b.c.d (IPv4-mapped)
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded();                        // 64:ff9b::a.b.c.d (NAT64)
  if ((g[0] & 0xfe00) === 0xfc00) return 'a private network address';             // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return 'a link-local address';                  // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return 'a multicast address';
  if (g[0] === 0x2002) return 'a 6to4 address';                                    // wraps an IPv4 address
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'a reserved address';
  if (g[0] === 0x2001 && g[1] === 0) return 'a Teredo address';
  return null;
}

const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

// Checks an address before anything is sent to it: scheme, no credentials, and a host that isn't obviously private.
// (Names are checked again, by address, when the connection is made.)
export function checkUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError('Only http:// and https:// addresses can be used.');
  if (url.username || url.password) throw new BlockedUrlError('The address can’t contain a username or password.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedUrlError('The address has no host name.');
  if (isIP(host)) {
    const why = blockedAddress(host);
    if (why) throw new BlockedUrlError(`${host} is ${why}; only public web addresses can be used.`);
  } else if (PRIVATE_NAME.test(host) || !host.includes('.')) {
    throw new BlockedUrlError(`${host} isn’t a public web address.`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;
export type Lookup = (hostname: string, options: { all?: boolean; family?: number | string } & Record<string, unknown>, callback: LookupCallback) => void;

// A DNS lookup for http(s).request that refuses names resolving to any non-public address.
export const publicLookup: Lookup = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true } as { all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as LookupAddress[];
    const bad = list.map((a) => blockedAddress(a.address)).find(Boolean);
    if (bad || !list.length) return callback(Object.assign(new BlockedUrlError(`${hostname} resolves to ${bad ?? 'nothing'}; only public web addresses can be used.`), { code: 'EBLOCKED' }));
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

export interface FetchResult {
  url: string;                                   // after redirects
  status: number;
  headers: Record<string, string | undefined>;
  body: Readable;                                // the caller reads it or calls body.destroy()
}
export interface FetchOptions {
  headers?: Record<string, string>;
  // When set, every hop (the address itself and each redirect) must be on this origin.
  origin?: string;
  signal?: AbortSignal;
}
export type Fetcher = (url: string, opts?: FetchOptions) => Promise<FetchResult>;

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 30_000;

function get(url: URL, headers: Record<string, string>, lookup: Lookup, signal?: AbortSignal): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    // agent: false → a new connection per request, so every request's lookup is checked.
    const req = mod.request(url, { method: 'GET', headers, agent: false, lookup: lookup as never, signal, timeout: IDLE_TIMEOUT_MS }, (res) => {
      const out: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(', ') : v;
      resolve({ url: url.href, status: res.statusCode ?? 0, headers: out, body: res });
    });
    req.on('timeout', () => req.destroy(new Error(`${url.host} stopped answering`)));
    req.on('error', reject);
    req.end();
  });
}

// GET with the checks above on the address and on every redirect. `lookup` is replaced only in tests.
export function guardedFetcher(lookup: Lookup = publicLookup): Fetcher {
  return async (start, opts = {}) => {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      checkUrl(url);
      if (opts.origin && url.origin !== opts.origin) throw new BlockedUrlError(`${start} redirects to another site (${url.origin}).`);
      const res = await get(url, opts.headers ?? {}, lookup, opts.signal);
      const location = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.location : undefined;
      if (!location) return res;
      res.body.destroy();
      if (hop >= MAX_REDIRECTS) throw new BlockedUrlError(`${start} redirects too many times.`);
      try { url = new URL(location, url); } catch { throw new BlockedUrlError(`${start} redirects to an invalid address.`); }
    }
  };
}
