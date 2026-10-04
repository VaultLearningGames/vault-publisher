// The headless browser: launching it, keeping it away from private addresses, and recording what a page requests.
import { lookup } from 'node:dns/promises';
import type { Browser, BrowserContext, Frame, Page, Request } from 'playwright';
import { blockedAddress, checkUrl } from '../net-guard.ts';
import type { ResourceSeen } from '../site-checks.ts';

export const NO_BROWSER = 'No browser: run `npx playwright install chromium-headless-shell`';

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
}

// ---------- the guard ----------
// Whether the browser may request from a host name; decided once per name. (Chromium resolves the name again itself,
// so this can't stop a name that changes its answer between the two; the portal's network is the other half of the guard.)
export type HostGuard = (hostname: string) => Promise<boolean>;

export function makeHostGuard(): HostGuard {
  const decided = new Map<string, Promise<boolean>>();
  return (hostname) => {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    let verdict = decided.get(host);
    if (!verdict) {
      verdict = (async () => {
        try {
          checkUrl(new URL(`http://${hostname}/`));
          const addresses = await lookup(host, { all: true });
          return addresses.length > 0 && addresses.every((a) => !blockedAddress(a.address));
        } catch { return false; }
      })();
      decided.set(host, verdict);
    }
    return verdict;
  };
}

type ContextOptions = NonNullable<Parameters<Browser['newContext']>[0]>;

export async function newContext(browser: Browser, options: ContextOptions, guard: HostGuard | null): Promise<BrowserContext> {
  // Service workers would answer requests before the guard sees them.
  const ctx = await browser.newContext({ ...options, serviceWorkers: 'block' });
  if (guard) {
    await ctx.route('**/*', async (route) => {
      let host = '';
      try {
        const u = new URL(route.request().url());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return await route.continue();
        host = u.hostname;
      } catch { return await route.continue(); }
      try {
        if (await guard(host)) await route.continue(); else await route.abort('blockedbyclient');
      } catch { /* the page closed while it was deciding */ }
    });
  }
  return ctx;
}

// ---------- what a page requests ----------
export interface Seen { res: ResourceSeen; frame: Frame | null; navigation: boolean }

const frameOf = (req: Request): Frame | null => { try { return req.frame(); } catch { return null; } };

// What each address weighed the first time it came over the network. Pages share one browser cache (a run that
// downloaded every page's files afresh would take an hour and pull a gigabyte), and a file answered from the cache
// reports no size, so a page's weight is counted from what its files weighed when they were first fetched.
export type KnownSizes = Map<string, ResourceSeen>;

// Records every request the page makes, with the frame that made it. Call settle() before reading `seen`: the
// response details arrive asynchronously. `asked` has every address as it is asked for, finished or not.
export function watchRequests(page: Page, known?: KnownSizes): { seen: Seen[]; asked: Set<string>; settle(): Promise<void> } {
  const seen: Seen[] = [];
  const asked = new Set<string>();
  page.on('request', (req) => { asked.add(req.url()); });
  const pending = new Set<Promise<void>>();
  const track = (work: Promise<void>) => { pending.add(work); work.finally(() => pending.delete(work)); };
  page.on('requestfinished', (req) => track((async () => {
    try {
      const response = await req.response();
      const sizes = await req.sizes();
      const headers = response?.headers() ?? {};
      const total = Math.max(0, sizes.responseBodySize) + Math.max(0, sizes.responseHeadersSize);
      const end = req.timing().responseEnd;
      const res: ResourceSeen = {
        url: req.url(), type: req.resourceType(), status: response?.status() ?? null, error: null,
        bytes: total > 0 ? total : null, mime: (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
        encoding: (headers['content-encoding'] ?? '').toLowerCase(), ms: end >= 0 ? Math.round(end) : null, inFrame: false,
      };
      const first = known?.get(res.url);
      if (first && (first.bytes ?? 0) > (res.bytes ?? 0)) res.bytes = first.bytes;
      else if (known && res.status !== null && res.status < 400 && res.bytes !== null) known.set(res.url, res);
      seen.push({ frame: frameOf(req), navigation: req.isNavigationRequest(), res });
    } catch { /* the page closed first */ }
  })()));
  // Chromium also reports a request as failed when it received an answer it refuses to use (a 404 page where a
  // stylesheet should be is cancelled as net::ERR_ABORTED). The answer, when there was one, is what matters.
  page.on('requestfailed', (req) => track((async () => {
    const response = await req.response().catch(() => null);
    const status = response?.status() ?? null;
    seen.push({
      frame: frameOf(req), navigation: req.isNavigationRequest(),
      res: { url: req.url(), type: req.resourceType(), status, error: status === null ? req.failure()?.errorText ?? 'failed' : null, bytes: null, mime: '', encoding: '', ms: null, inFrame: false },
    });
  })()));
  return { seen, asked, settle: async () => { await Promise.allSettled([...pending]); } };
}

// Whether `frame` is `root` or inside it.
export function inFrame(frame: Frame | null, root: Frame | null): boolean {
  for (let f = frame; f; f = f.parentFrame()) if (f === root) return true;
  return false;
}
