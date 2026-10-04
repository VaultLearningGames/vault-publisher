// The visit pass: loads each page the way a visitor would and reports what it saw as the contract's plain records.
import type { Browser, BrowserContext, Page } from 'playwright';
import { LIMITS, THROTTLE, VIEWPORTS } from '../site-checks.ts';
import type { LinkSeen, PageLoad, ViewportName, ViewSeen } from '../site-checks.ts';
import { newContext, watchRequests } from './browser.ts';
import type { HostGuard, KnownSizes } from './browser.ts';
import { collectPage, firstView, LCP_SCRIPT, measureView, navigationTiming, PLAY_SCRIPT, scrollThrough, waitForImages } from './inpage.ts';
import { UA, UA_MOBILE, shortError, sleep, withTimeout } from './util.ts';

export interface Visit {
  load: PageLoad;
  links: LinkSeen[];
  ids: Set<string>;                     // every id and anchor name on the page, for #fragment checks
  text: string;                         // what a reader reads, for spelling
  title: string;                        // the page's h1, or its title
  plays: { wired: string[]; newTab: string[] };
  views: ViewSeen[];
}

export interface VisitEnv {
  browser: Browser;
  guard: HostGuard | null;
  origin: string;
  deep: boolean;                        // scroll, settle and collect everything (false: only look for Play buttons)
  responsive: boolean;
  laptop: BrowserContext;               // shared across pages, like `phone`, so files are downloaded once
  phone: BrowserContext | null;
  known: KnownSizes;                    // what each file weighed when it was first fetched
}

const viewport = (name: ViewportName) => VIEWPORTS.find((v) => v.name === name)!;
const NAV_TIMEOUT = 30_000;
const emptyLoad = (path: string, status: number | null, error: string | null): PageLoad =>
  ({ path, status, error, resources: [], images: [], scriptErrors: [], timing: { ttfb: null, domContentLoaded: null, load: null, lcp: null } });

async function measure(page: Page, path: string, name: ViewportName): Promise<ViewSeen> {
  const seen = await withTimeout(page.evaluate(measureView, { width: viewport(name).width, smallTextPx: LIMITS.smallTextPx, tapTargetPx: LIMITS.tapTargetPx, overflowPx: LIMITS.overflowPx }), 20_000, 'measuring the page');
  return { path, viewport: name, width: viewport(name).width, ...seen };
}

async function resize(page: Page, name: ViewportName) {
  const v = viewport(name);
  await page.setViewportSize({ width: v.width, height: v.height });
  await sleep(300);
}

// Waits for the network to go quiet, but not for long: pages with a poller never do.
const quiet = (page: Page, ms: number) => page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});

export async function visitPage(env: VisitEnv, path: string): Promise<Visit> {
  const empty = (load: PageLoad): Visit => ({ load, links: [], ids: new Set(), text: '', title: '', plays: { wired: [], newTab: [] }, views: [] });
  const page = await env.laptop.newPage();
  let visit: Visit;
  try {
    await page.addInitScript(LCP_SCRIPT);
    await page.addInitScript(PLAY_SCRIPT);
    const scriptErrors: string[] = [];
    page.on('pageerror', (e) => scriptErrors.push(e.message));
    const watch = watchRequests(page, env.known);
    let status: number | null = null, error: string | null = null;
    try { status = (await page.goto(env.origin + path, { timeout: NAV_TIMEOUT, waitUntil: 'load' }))?.status() ?? null; } catch (e) { error = shortError(e); }
    if (error || (status !== null && status >= 400)) {
      await watch.settle();
      return empty({ ...emptyLoad(path, status, error), resources: watch.seen.map((s) => s.res) });
    }
    // A page that sends the visitor on (a meta refresh, as the old Squarespace addresses do) has nothing of its own
    // to check: it is recorded as a link to where it leads, which is then visited and link-checked like any other.
    await sleep(250);
    await page.waitForLoadState('load', { timeout: NAV_TIMEOUT }).catch(() => {});
    const landed = new URL(page.url());
    const key = (p: string) => p.replace(/\/+$/, '');
    if (landed.origin !== env.origin || key(landed.pathname) !== key(path)) {
      landed.hash = '';
      return { ...empty(emptyLoad(path, status, null)), links: [{ page: path, url: landed.href, fragment: '', raw: landed.href, text: 'redirect', kind: 'link' }] };
    }
    const timing = await withTimeout(page.evaluate(navigationTiming), 10_000, 'reading timings').catch(() => emptyLoad(path, 200, null).timing);
    // The first view: what the page has asked for once it has loaded and the network has gone quiet, before any
    // scrolling, less the lazy images below the fold.
    let first: Set<string> | null = null;
    if (env.deep) {
      await quiet(page, 4000);
      const fv = await withTimeout(page.evaluate(firstView), 10_000, 'reading the first view').catch(() => null);
      if (fv) {
        first = new Set([...watch.asked, ...fv.used]);
        for (const src of fv.lazyBelow) first.delete(src);
      }
      await withTimeout(page.evaluate(scrollThrough), 10_000, 'scrolling').catch(() => {});
      await quiet(page, 4000);
      await withTimeout(page.evaluate(waitForImages, 6000), 8000, 'waiting for images').catch(() => {});
    }
    await watch.settle();
    const data = await withTimeout(page.evaluate(collectPage), 20_000, 'reading the page');
    const views: ViewSeen[] = [];
    if (env.responsive) {
      try {
        views.push(await measure(page, path, 'laptop'));
        await resize(page, 'wide');
        views.push(await measure(page, path, 'wide'));
      } catch { /* a page that can't be measured just has no view */ }
    }
    const main = page.mainFrame();
    const inFirst = (url: string) => (first ? { firstView: first.has(url) } : {});
    const resources = watch.seen.map((s) => ({ ...s.res, inFrame: s.frame !== main, ...inFirst(s.res.url) }));
    // Files the browser took from its cache without asking (an image another page already showed) still belong to
    // this page's weight.
    const asked = new Set(resources.map((r) => r.url));
    const used = await withTimeout(page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name)), 10_000, 'reading what the page used').catch(() => [] as string[]);
    for (const url of new Set(used)) {
      const known = env.known.get(url);
      if (known && !asked.has(url)) resources.push({ ...known, ms: null, inFrame: false, ...inFirst(url) });
    }
    visit = {
      load: { path, status, error: null, timing, images: data.images, scriptErrors, resources, refs: data.refs },
      links: data.links.map((l) => ({ ...l, page: path })),
      ids: new Set(data.ids), text: data.text, title: data.heading || data.title, plays: data.plays, views,
    };
  } catch (e) {
    return empty(emptyLoad(path, null, shortError(e)));
  } finally {
    await page.close().catch(() => {});
  }
  return visit;
}

export async function newLaptopContext(browser: Browser, guard: HostGuard | null): Promise<BrowserContext> {
  const v = viewport('laptop');
  return newContext(browser, { viewport: { width: v.width, height: v.height }, userAgent: UA }, guard);
}

// One page loaded by itself with an empty cache, as a first-time visitor gets it, on an emulated Slow 4G connection
// (THROTTLE), for its timings only. The visit pass loads several pages at once with a shared cache on the runner's
// fast connection, so its timings are only a first look. A page that hasn't finished loading when the wait runs out
// still reports what it reached (its paint, its first byte), and the wait as its load time.
const THROTTLED_TIMEOUT = 60_000;
export async function timePage(env: VisitEnv, path: string): Promise<PageLoad['timing'] | null> {
  const laptop = viewport('laptop');
  const ctx = await newContext(env.browser, { viewport: { width: laptop.width, height: laptop.height }, userAgent: UA }, env.guard);
  try {
    const page = await ctx.newPage();
    await page.addInitScript(LCP_SCRIPT);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: THROTTLE.latencyMs,
      downloadThroughput: THROTTLE.downloadBitsPerSec / 8, uploadThroughput: THROTTLE.uploadBitsPerSec / 8,
    });
    let finished = true;
    const response = await page.goto(env.origin + path, { timeout: THROTTLED_TIMEOUT, waitUntil: 'load' }).catch(() => { finished = false; return null; });
    if (finished && (!response || response.status() >= 400)) return null;
    // The largest paint can come after the load event (an image a script adds); give it a moment.
    if (finished) await quiet(page, 3000);
    const timing = await withTimeout(page.evaluate(navigationTiming), 10_000, 'reading timings');
    if (!finished && timing.ttfb === null) return null;
    // Not loaded within the wait: at least that long.
    return { ...timing, load: finished ? timing.load : THROTTLED_TIMEOUT, throttled: true };
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => {});
  }
}

// The same page on a phone and then a tablet. Returns no views when the page doesn't load.
export async function visitPhone(env: VisitEnv & { phone: BrowserContext }, path: string): Promise<ViewSeen[]> {
  const page = await env.phone.newPage();
  try {
    const response = await page.goto(env.origin + path, { timeout: NAV_TIMEOUT, waitUntil: 'load' });
    if (!response || response.status() >= 400) return [];
    await quiet(page, 3000);
    const views = [await measure(page, path, 'phone')];
    await resize(page, 'tablet');
    views.push(await measure(page, path, 'tablet'));
    return views;
  } catch {
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

export async function newPhoneContext(browser: Browser, guard: HostGuard | null): Promise<BrowserContext> {
  const v = viewport('phone');
  return newContext(browser, { viewport: { width: v.width, height: v.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA_MOBILE }, guard);
}
