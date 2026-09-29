// Game availability checks: does every game on the Vault site still load? scripts/check-games.ts fetches each
// catalog game's play URL (the network part); this module decides what the result means, so it can be tested
// without a network. The daily check-games.yml workflow posts each run to POST /v1/admin/game-checks, and Vault
// staff see it on Vault → Game availability.
//
// ok: loads. warn: loads, but something is worth a look (slow, moved to another site, only on retry, bot
// protection answered). fail: players can't get it (unreachable, an error status, or it refuses to be framed by
// the site while the site shows it in its in-page player).

export type Level = 'ok' | 'warn' | 'fail';
export const LEVELS: readonly Level[] = ['fail', 'warn', 'ok']; // worst first, the order reports use

export const SLOW_MS = 5000;

// What the checker saw when it fetched a play URL (following redirects itself).
export interface Probe {
  status: number | null;              // the final response's status; null when no response arrived
  final_url: string | null;
  redirects: string[];                // every URL redirected to, in order
  ms: number | null;                  // time to the final response's headers, all hops included
  attempts: number;
  headers: Record<string, string>;    // the final response's headers, lowercased names
  error: { code: string; message: string } | null;
}

export interface Framing { allowed: boolean; reason: string }

export interface GameCheck {
  slug: string;
  title: string;
  studio: string;                     // studio slug, for the portal link
  url: string;                        // the play URL from the catalog
  source: 'url' | 'cdn';
  embed: boolean;                     // true: the site plays it in its in-page player (an iframe)
  status: number | null;
  final_url: string | null;
  redirects: string[];
  ms: number | null;
  attempts: number;
  error: string | null;
  framing: Framing | null;            // for in-page games that answered
  level: Level;
  problems: string[];                 // why it isn't ok, most serious first
}

export interface GameCheckRun {
  checked_at: string;
  site: string;                       // the site origin framing was checked against
  source: string | null;              // the GitHub Actions run that made it
  counts: Record<Level, number>;
  games: GameCheck[];
}

// ---------- errors ----------
// Node's fetch reports DNS, TLS and connection failures as a TypeError whose `cause` has a code.
export function errorKind(code: string): 'dns' | 'tls' | 'timeout' | 'connection' | 'redirects' | 'other' {
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|ENODATA)$/.test(code)) return 'dns';
  if (/^(TimeoutError|AbortError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|ETIMEDOUT)$/.test(code)) return 'timeout';
  if (/CERT|SSL|TLS|^UNABLE_TO_|SELF_SIGNED|^EPROTO$/.test(code)) return 'tls';
  if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)) return 'connection';
  if (code === 'TOO_MANY_REDIRECTS') return 'redirects';
  return 'other';
}

function errorText(e: { code: string; message: string }, timeoutMs: number): string {
  switch (errorKind(e.code)) {
    case 'dns': return `DNS lookup failed (${e.code}): the site's name doesn't resolve`;
    case 'timeout': return `No response within ${Math.round(timeoutMs / 1000)} s`;
    case 'tls': return `HTTPS certificate problem (${e.code})`;
    case 'connection': return `Connection failed (${e.code})`;
    case 'redirects': return 'Too many redirects';
    default: return `Request failed: ${e.message || e.code}`;
  }
}

// ---------- framing ----------
// Whether a page at docUrl, answering with these headers, may be framed by siteOrigin. CSP frame-ancestors wins
// when present; otherwise X-Frame-Options, following the HTML spec's rules (so ALLOW-FROM and other unknown values
// are ignored, as browsers do).
export function framingFor(headers: Record<string, string>, docUrl: string, siteOrigin: string): Framing {
  const site = new URL(siteOrigin);
  const doc = new URL(docUrl);
  // Several CSP headers arrive joined by ", "; each is a policy, and every policy must allow the site.
  const policies = (headers['content-security-policy'] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  let sawFrameAncestors = false;
  for (const policy of policies) {
    const directive = policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0]?.toLowerCase() === 'frame-ancestors');
    if (!directive) continue;
    sawFrameAncestors = true;
    const sources = directive.slice(1);
    if (!sources.some((s) => sourceMatches(s, site, doc))) {
      return { allowed: false, reason: `Content-Security-Policy: frame-ancestors ${sources.join(' ') || "'none'"}` };
    }
  }
  if (sawFrameAncestors) return { allowed: true, reason: 'CSP frame-ancestors allows the site' };

  const xfo = new Set((headers['x-frame-options'] ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
  if (xfo.size === 0) return { allowed: true, reason: 'no framing restrictions' };
  const raw = headers['x-frame-options'];
  if (xfo.size > 1) {
    return ['deny', 'sameorigin', 'allowall'].some((v) => xfo.has(v))
      ? { allowed: false, reason: `X-Frame-Options: ${raw} (conflicting values)` }
      : { allowed: true, reason: `X-Frame-Options: ${raw} (ignored by browsers)` };
  }
  const [only] = xfo;
  if (only === 'deny') return { allowed: false, reason: `X-Frame-Options: ${raw}` };
  if (only === 'sameorigin') {
    return site.origin === doc.origin ? { allowed: true, reason: 'X-Frame-Options: SAMEORIGIN (same origin)' } : { allowed: false, reason: `X-Frame-Options: ${raw}` };
  }
  return { allowed: true, reason: `X-Frame-Options: ${raw} (ignored by browsers)` };
}

// One CSP source expression against the framing site's origin (CSP3 "does url match expression").
function sourceMatches(expr: string, site: URL, doc: URL): boolean {
  const e = expr.toLowerCase();
  const secureUpgrade = (want: string, have: string) => want === have || (want === 'http:' && have === 'https:') || (want === 'ws:' && have === 'wss:');
  if (e === "'none'") return false;
  if (e === '*') return /^(https?|wss?):$/.test(site.protocol);
  if (e === "'self'") return site.host === doc.host && secureUpgrade(doc.protocol, site.protocol);
  if (/^[a-z][a-z0-9+.-]*:$/.test(e)) return secureUpgrade(e, site.protocol);
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?(?:\/.*)?$/.exec(e);
  if (!m) return false;
  const [, scheme, host, port] = m;
  if (scheme ? !secureUpgrade(`${scheme}:`, site.protocol) : !secureUpgrade(doc.protocol, site.protocol)) return false;
  const siteHost = site.hostname.toLowerCase();
  if (host === '*') { /* any host */ }
  else if (host.startsWith('*.')) { if (!siteHost.endsWith(host.slice(1))) return false; }
  else if (host !== siteHost) return false;
  if (port === '*') return true;
  if (port) return port === (site.port || (site.protocol === 'https:' ? '443' : '80'));
  return !site.port; // no port in the expression: the site must be on its scheme's default port
}

// ---------- classification ----------
const siteKey = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '');

export function classify(game: { url: string; embed: boolean }, probe: Probe | null, opts: { siteOrigin: string; timeoutMs?: number; slowMs?: number }): { level: Level; problems: string[]; framing: Framing | null } {
  const fails: string[] = [], warns: string[] = [];
  const done = (framing: Framing | null = null) => ({ level: (fails.length ? 'fail' : warns.length ? 'warn' : 'ok') as Level, problems: [...fails, ...warns], framing });
  let start: URL;
  try { start = new URL(game.url); } catch { fails.push(game.url ? `Not a valid play URL: ${game.url}` : 'No play URL'); return done(); }
  if (!/^https?:$/.test(start.protocol)) { fails.push(`Not a web address: ${game.url}`); return done(); }
  const siteHttps = new URL(opts.siteOrigin).protocol === 'https:';
  if (start.protocol === 'http:' && siteHttps) {
    // Browsers block an http:// page inside an https:// site before even requesting it.
    (game.embed ? fails : warns).push(game.embed ? 'Plays from http://, which browsers block inside the https site' : 'Plays from http:// (not https)');
  }
  if (!probe) { fails.push('Not checked'); return done(); }
  if (probe.error) { fails.push(errorText(probe.error, opts.timeoutMs ?? 15000)); return done(); }

  const status = probe.status ?? 0;
  // Bot protection (Cloudflare's challenge, or its 403 for clients it doesn't trust) and rate limits turn the
  // checker away without saying anything about browsers, so they're a warning to look at, not a failure.
  const botWall = !!probe.headers['cf-mitigated'] || (status === 403 && /cloudflare|captcha/i.test(probe.headers['server'] ?? ''));
  if (status >= 400) {
    if (botWall) warns.push(`Bot protection turned the checker away (HTTP ${status}); check it loads in a browser`);
    else if (status === 429) warns.push('Rate limited the checker (HTTP 429); check it loads in a browser');
    else fails.push(`HTTP ${status}${statusText(status)}`);
  } else if (status >= 300) {
    fails.push(`HTTP ${status} without a usable redirect`);
  }

  const final = probe.final_url ? new URL(probe.final_url) : start;
  let framing: Framing | null = null;
  if (status > 0 && status < 400) {
    if (game.embed) {
      if (final.protocol === 'http:' && siteHttps && start.protocol !== 'http:') fails.push(`Redirects to http:// (${final.host}), which browsers block inside the https site`);
      framing = framingFor(probe.headers, final.href, opts.siteOrigin);
      if (!framing.allowed) fails.push(`Refuses to load in the site's player (${framing.reason})`);
    }
    if (siteKey(final) !== siteKey(start)) warns.push(`Redirects to another site: ${final.host}`);
    else if (start.pathname.replace(/\/+$/, '') !== '' && final.pathname.replace(/\/+$/, '') === '') warns.push("Redirects to the site's home page; the game may have moved");
  }
  if (probe.ms !== null && probe.ms > (opts.slowMs ?? SLOW_MS)) warns.push(`Slow: ${(probe.ms / 1000).toFixed(1)} s to respond`);
  if (probe.attempts > 1 && !fails.length && status > 0 && status < 400) warns.push('Loaded only on the second try');
  return done(framing);
}

function statusText(status: number): string {
  const t: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 500: 'Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
  return t[status] ? ` ${t[status]}` : '';
}

// Whether a probe is worth one retry (a transient-looking failure).
export function shouldRetry(p: Probe): boolean {
  if (p.error) return errorKind(p.error.code) !== 'dns' && errorKind(p.error.code) !== 'tls' && errorKind(p.error.code) !== 'redirects';
  return p.status !== null && (p.status >= 500 || p.status === 429);
}

// ---------- runs ----------
export function countLevels(games: { level: Level }[]): Record<Level, number> {
  const counts: Record<Level, number> = { ok: 0, warn: 0, fail: 0 };
  for (const g of games) counts[g.level]++;
  return counts;
}

// Failing games first, then warnings, then the rest; by title within each.
export function sortForReport<T extends { level: Level; title: string; slug: string }>(games: T[]): T[] {
  return [...games].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || (a.title || a.slug).localeCompare(b.title || b.slug));
}

const MAX_GAMES = 2000;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A run as posted to the portal (the checker's --out JSON). Returns an error message for anything unusable;
// fields are trimmed to sane sizes, and the counts are recomputed from the games.
export function parseRun(body: Record<string, unknown>): GameCheckRun | string {
  if (!Array.isArray(body.games)) return 'games must be an array';
  if (body.games.length > MAX_GAMES) return `at most ${MAX_GAMES} games`;
  const checkedAt = text(body.checked_at, 40);
  if (!checkedAt || Number.isNaN(Date.parse(checkedAt))) return 'checked_at must be a date';
  const site = text(body.site, 300);
  if (!/^https?:\/\//.test(site)) return 'site must be the site origin, e.g. https://vaultlearninggames.org';
  const source = text(body.source, 500);
  if (source && !/^https:\/\//.test(source)) return 'source must be an https link (the workflow run)';
  const games: GameCheck[] = [];
  for (const [i, raw] of body.games.entries()) {
    const g = (raw ?? {}) as Record<string, unknown>;
    if (!text(g.slug, 200)) return `games[${i}].slug is missing`;
    if (!LEVELS.includes(g.level as Level)) return `games[${i}].level must be ok, warn or fail`;
    const framing = g.framing && typeof g.framing === 'object' ? g.framing as Record<string, unknown> : null;
    games.push({
      slug: text(g.slug, 200), title: text(g.title, 300), studio: text(g.studio, 200), url: text(g.url, 2000),
      source: g.source === 'cdn' ? 'cdn' : 'url', embed: g.embed !== false,
      status: num(g.status), final_url: text(g.final_url, 2000) || null,
      redirects: Array.isArray(g.redirects) ? g.redirects.slice(0, 10).map((r) => text(r, 2000)) : [],
      ms: num(g.ms), attempts: num(g.attempts) ?? 1, error: text(g.error, 500) || null,
      framing: framing ? { allowed: framing.allowed === true, reason: text(framing.reason, 500) } : null,
      level: g.level as Level,
      problems: Array.isArray(g.problems) ? g.problems.slice(0, 10).map((p) => text(p, 500)) : [],
    });
  }
  return { checked_at: new Date(checkedAt).toISOString(), site, source: source || null, counts: countLevels(games), games };
}
