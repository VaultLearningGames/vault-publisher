// Small pure helpers for the site-checks engine: addresses, concurrency, timeouts, pixel sampling.

// A current browser's name with the checker's own after it. The name is deliberately bland: one publisher's firewall
// (ssec.si.edu) resets any connection whose User-Agent contains "SiteCheck", which made its four games look broken.
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 VaultCheck/1 (+https://vaultlearninggames.org)';
export const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 VaultCheck/1 (+https://vaultlearninggames.org)';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Rejects when the work takes longer than `ms`; the work itself is left to finish (or fail) on its own.
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// Playwright's errors are long and multi-line ("page.goto: net::ERR_X at https://…\nCall log: …"); a person wants the first useful line.
export function shortError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const net = /net::ERR_[A-Z_]+/.exec(text)?.[0];
  if (net) return net;
  if (/timeout \d+ms exceeded/i.test(text)) return 'took too long to load (timed out)';
  return text.split('\n')[0].replace(/^[\w.]+: /, '').slice(0, 200);
}

// ---------- addresses ----------
// A site path the way pages are known here: '/wake/' for a page, '/files/a.pdf' for a file.
export function normalisePath(path: string): string {
  let p = path.split('#')[0].split('?')[0] || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/index\.html?$/i, '/');
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (last && !last.includes('.')) p += '/';
  return p;
}

// Which kind of page a path is, so the throttled timing covers every kind: the home page, each page of its own at
// the top (/about/, /game-cards/), a game's page (one with a Play button), and pages under a section by section
// ('/game-cards/*', '/game-cards/tag/*').
export function templateOf(path: string, hasPlay: boolean): string {
  const parts = normalisePath(path).split('/').filter(Boolean);
  if (!parts.length) return 'home';
  if (parts.length > 1) return `/${parts.slice(0, -1).join('/')}/*`;
  return hasPlay ? 'a game page' : `/${parts[0]}/`;
}

// Whether a link's target looks like a page of the site (so it is worth visiting): no query, and no file extension
// but .html.
export function isPageUrl(u: URL): boolean {
  if (u.search) return false;
  const last = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
  return !last.includes('.') || /\.html?$/i.test(last);
}

// The page path of a same-origin address, or null for another site or something that isn't a page.
export function pagePathOf(raw: string, origin: string): string | null {
  let u: URL;
  try { u = new URL(raw, origin); } catch { return null; }
  if (u.origin !== origin || !isPageUrl(u)) return null;
  return normalisePath(u.pathname);
}

// YouTube's watch page answers 200 for a removed video, so videos are asked of oEmbed instead (404/401/403 when gone).
export function youtubeWatchUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let id: string | null | undefined = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/embed\/([\w-]+)/.exec(u.pathname)?.[1];
  }
  if (!id || id === 'videoseries' || !/^[\w-]{6,}$/.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}
export const oembedUrl = (watchUrl: string) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`;

// ---------- concurrency ----------
// At most `max` of the functions given to run() work at once; the rest wait their turn.
export function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => { while (active < max && waiting.length) { active++; waiting.shift()!(); } };
  return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    waiting.push(() => { fn().then(resolve, reject).finally(() => { active--; next(); }); });
    next();
  });
}

// Runs fn over every item, `n` at a time.
export async function runPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- pixels ----------
// Whether a sample of RGBA pixels is (nearly) all one colour: at least `share` of them within `tolerance` (summed
// difference in red, green and blue) of the most common colour. Used to tell a game that drew nothing from one that did.
export function isFlat(rgba: ArrayLike<number>, share = 0.995, tolerance = 24): boolean {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return false;
  const buckets = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const key = ((rgba[i * 4] >> 3) << 10) | ((rgba[i * 4 + 1] >> 3) << 5) | (rgba[i * 4 + 2] >> 3);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let top = 0, topCount = -1;
  for (const [key, count] of buckets) if (count > topCount) { top = key; topCount = count; }
  const r = ((top >> 10) << 3) + 4, g = (((top >> 5) & 31) << 3) + 4, b = ((top & 31) << 3) + 4;
  let near = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(rgba[i * 4] - r) + Math.abs(rgba[i * 4 + 1] - g) + Math.abs(rgba[i * 4 + 2] - b) <= tolerance) near++;
  }
  return near / n >= share;
}
