// The visit pass: loads each page the way a visitor would and reports what it saw as the contract's plain records.
import type { Browser, BrowserContext, Page } from 'playwright';
import { LIMITS, VIEWPORTS } from '../site-checks.ts';
import type { LinkSeen, PageLoad, ViewportName, ViewSeen } from '../site-checks.ts';
import { newContext, watchRequests } from './browser.ts';
import type { HostGuard, KnownSizes } from './browser.ts';
import { collectPage, LCP_SCRIPT, measureView, navigationTiming, PLAY_SCRIPT, scrollThrough, waitForImages } from './inpage.ts';
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
    if (env.deep) {
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
    const resources = watch.seen.map((s) => ({ ...s.res, inFrame: s.frame !== main }));
    // Files the browser took from its cache without asking (an image another page already showed) still belong to
    // this page's weight.
    const asked = new Set(resources.map((r) => r.url));
    const used = await withTimeout(page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name)), 10_000, 'reading what the page used').catch(() => [] as string[]);
    for (const url of new Set(used)) {
      const first = env.known.get(url);
      if (first && !asked.has(url)) resources.push({ ...first, ms: null, inFrame: false });
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

// One page loaded by itself with an empty cache, as a first-time visitor gets it, for its timings only. The visit
// pass loads several pages at once with a shared cache, so its timings are only a first look: too slow when pages
// compete for the connection, too quick when another page already fetched this one's images.
export async function timePage(env: VisitEnv, path: string): Promise<PageLoad['timing'] | null> {
  const laptop = viewport('laptop');
  const ctx = await newContext(env.browser, { viewport: { width: laptop.width, height: laptop.height }, userAgent: UA }, env.guard);
  try {
    const page = await ctx.newPage();
    await page.addInitScript(LCP_SCRIPT);
    const response = await page.goto(env.origin + path, { timeout: NAV_TIMEOUT, waitUntil: 'load' });
    if (!response || response.status() >= 400) return null;
    await sleep(300);
    return await withTimeout(page.evaluate(navigationTiming), 10_000, 'reading timings');
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
