// The site checks engine: looks at the Vault website (pages, resources, links, games, spelling, widths) and hands
// what it saw to src/site-checks.ts, which decides what is wrong. This file only gathers and routes; it holds no
// thresholds or wording about findings.
import type { Browser, BrowserContext } from 'playwright';
import { assetFindings, CHECKS, finishRun, LIMITS, performanceFindings, responsiveFindings, gameFindings, SERVICES } from '../site-checks.ts';
import type { CheckName, CheckResult, Engine, GameLoad, PageText, RawFinding, RunOptions, SiteCheckRun } from '../site-checks.ts';
import { launchBrowser, makeHostGuard, NO_BROWSER, newContext } from './browser.ts';
import type { HostGuard } from './browser.ts';
import { readSitemap } from './discover.ts';
import { openGame } from './games.ts';
import type { GameCandidate } from './games.ts';
import { checkLinks } from './links.ts';
import { checkServices } from './services.ts';
import { errorOf, makeConnection, makeGetter, OfflineError } from './net.ts';
import { checkSpelling } from './spelling.ts';
import { normalisePath, pagePathOf, runPool, templateOf } from './util.ts';
import { newLaptopContext, newPhoneContext, timePage, visitPage, visitPhone } from './visit.ts';
import type { Visit } from './visit.ts';

const DEFAULT_LIMIT = 1500;
const RETIMED_PAGES = 24;

export const runSiteChecks: Engine = async (options) => {
  const started = Date.now();
  const checks = CHECKS.filter((c) => options.checks.includes(c));
  const base = { site: options.site, checks, started_at: new Date(started).toISOString(), source: options.source ?? null, started_by: options.startedBy ?? 'cli', pages: 0, games: 0 };
  const results: CheckResult[] = [];
  const stop = (error: string): SiteCheckRun => finishRun(base, results, error);

  let origin: string;
  try { origin = new URL(options.site).origin; } catch { return stop(`${options.site} isn't a web address`); }
  base.site = origin;
  const wants = (c: CheckName) => checks.includes(c);
  const guard = !!options.guard;
  const aborted = () => options.signal?.aborted === true;
  const get = makeGetter(guard);
  const connection = makeConnection(get, origin, options.signal);

  // The game services first: they live on other sites, so they are worth knowing about even when this one can't be
  // reached. Plain requests; a run of only this check needs neither the site nor a browser.
  if (wants('services')) {
    const t = Date.now();
    try { results.push({ check: 'services', status: 'done', ...(await checkServices(get, options.services ?? SERVICES, options.signal)), ms: Date.now() - t }); }
    catch (e) { results.push({ check: 'services', status: 'error', note: e instanceof Error ? e.message : String(e), checked: 0, ms: Date.now() - t, findings: [] }); }
    if (aborted()) return stop('cancelled');
  }
  if (!checks.some((c) => c !== 'services')) return finishRun(base, results);

  // The front door first: a site that can't be reached is one error, not a thousand failing pages.
  try {
    const res = await get(`${origin}/`, 20_000, options.signal);
    res.close();
  } catch (e) {
    return stop(aborted() ? 'cancelled' : `The site couldn't be reached: ${errorOf(e).message}`);
  }

  let browser: Browser | null = null;
  const onAbort = () => { browser?.close().catch(() => {}); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // ---------- which pages ----------
    const cap = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    const discover = !options.paths;
    const known = new Set<string>();
    const queue: string[] = [];
    const enqueue = (path: string) => { if (!known.has(path)) { known.add(path); queue.push(path); } };
    let sitemapUrls: string[] = [];
    if (options.paths) options.paths.forEach((p) => enqueue(normalisePath(p)));
    else {
      enqueue('/');
      const { urls } = await readSitemap(get, origin, options.signal);
      for (const url of urls) { const p = pagePathOf(url, origin); if (p) enqueue(p); }
      sitemapUrls = urls.slice(0, cap);
    }
    if (aborted()) return stop('cancelled');

    try { browser = await launchBrowser(); } catch { return stop(NO_BROWSER); }
    const hostGuard: HostGuard | null = guard ? makeHostGuard() : null;
    const deep = checks.some((c) => c !== 'games' && c !== 'services');
    const phone: BrowserContext | null = wants('responsive') ? await newPhoneContext(browser, hostGuard) : null;
    const laptop = await newLaptopContext(browser, hostGuard);
    const env = { browser, guard: hostGuard, origin, deep, responsive: wants('responsive'), laptop, phone, known: new Map() };

    // ---------- the visit pass ----------
    const visitStart = Date.now();
    const visits = new Map<string, Visit>();
    let inflight = 0;
    const worker = async () => {
      while (!aborted()) {
        if (visits.size + inflight >= cap) return;
        const path = queue.shift();
        if (path === undefined) { if (inflight === 0) return; await new Promise((r) => setTimeout(r, 25)); continue; }
        inflight++;
        try {
          let visit = await visitPage(env, path);
          // A page that didn't answer at all gets a second go, once the checker's own connection is known to be up.
          if (visit.load.status === null) { await connection.wait(); visit = await visitPage(env, path); }
          if (phone && visit.load.status !== null && visit.load.status < 400) visit.views.push(...(await visitPhone({ ...env, phone }, path)));
          visits.set(path, visit);
          if (discover) {
            for (const l of visit.links) if (l.kind === 'link') { const p = pagePathOf(l.url, origin); if (p) enqueue(p); }
          }
        } catch (e) { if (e instanceof OfflineError) throw e; /* any other page that can't be visited is left out */ }
        finally { inflight--; }
        options.onProgress?.({ phase: 'pages', done: visits.size, total: Math.min(cap, visits.size + inflight + queue.length) });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 3) }, worker));
    await phone?.close().catch(() => {});
    await laptop.close().catch(() => {});
    if (aborted()) return stop('cancelled');
    base.pages = visits.size;
    const all = [...visits.values()];

    // Honest timings, judged on a classroom-like connection: pages are loaded again one at a time with an empty
    // cache on emulated Slow 4G, and only that time is judged. First the heaviest page of each kind (home, a game
    // page, /game-cards/, /about/, …), then pages that looked slow or are heavy, heaviest first; only so many, as
    // each takes several seconds.
    if (wants('performance')) {
      const loaded = all.filter((v) => v.load.status !== null && v.load.status < 400 && !v.load.error && v.load.resources.length > 0);
      const weight = (v: Visit) => v.load.resources.reduce((sum, r) => sum + (r.inFrame ? 0 : r.bytes ?? 0), 0);
      const firstWeight = (v: Visit) => v.load.resources.reduce((sum, r) => sum + (r.inFrame || !r.firstView ? 0 : r.bytes ?? 0), 0);
      const byWeight = loaded.map((v) => ({ v, bytes: weight(v) })).sort((a, b) => b.bytes - a.bytes || a.v.load.path.localeCompare(b.v.load.path));
      const again: Visit[] = [];
      const kinds = new Set<string>();
      for (const { v } of byWeight) {
        const kind = templateOf(v.load.path, v.plays.wired.length + v.plays.newTab.length > 0);
        if (!kinds.has(kind)) { kinds.add(kind); again.push(v); }
      }
      // The visit pass is on a fast connection: these are a fraction of the throttled limits.
      const looksSlow = ({ load: { timing: t } }: Visit) => (t.lcp ?? 0) > LIMITS.lcpWarnMs / 3 || (t.load ?? 0) > LIMITS.loadWarnMs / 3;
      for (const { v, bytes } of byWeight) {
        if (again.length >= RETIMED_PAGES) break;
        if (!again.includes(v) && (looksSlow(v) || bytes > LIMITS.pageWarnBytes || firstWeight(v) > LIMITS.firstViewWarnBytes)) again.push(v);
      }
      again.splice(RETIMED_PAGES);
      let done = 0;
      for (const v of again) {
        if (aborted()) break;
        options.onProgress?.({ phase: 'timing pages on Slow 4G', done: done++, total: again.length });
        const alone = await timePage(env, v.load.path);
        if (alone) v.load.timing = alone;
      }
    }
    if (aborted()) return stop('cancelled');
    const visitMs = Date.now() - visitStart;

    const run = async (check: CheckName, work: () => Promise<Omit<CheckResult, 'check' | 'ms' | 'status'> & { note?: string }>, extraMs = 0) => {
      const t = Date.now();
      try { results.push({ check, status: 'done', ...(await work()), ms: Date.now() - t + extraMs }); }
      catch (e) { if (aborted() || e instanceof OfflineError) throw e; results.push({ check, status: 'error', note: e instanceof Error ? e.message : String(e), checked: 0, ms: Date.now() - t, findings: [] }); }
    };
    if (wants('assets')) await run('assets', async () => ({ checked: all.length, findings: all.flatMap((v) => assetFindings(v.load, origin)) }), visitMs);
    if (wants('performance')) await run('performance', async () => ({ checked: all.length, findings: all.flatMap((v) => performanceFindings(v.load, origin)) }), visitMs);
    if (wants('responsive')) {
      await run('responsive', async () => {
        const views = all.flatMap((v) => v.views);
        return { checked: views.length, findings: views.flatMap(responsiveFindings) };
      }, visitMs);
    }
    if (wants('links')) {
      await run('links', () => checkLinks({ origin, guard, signal: options.signal, progress: options.onProgress, connection }, visits, sitemapUrls), visitMs);
    }
    if (wants('spelling')) {
      await run('spelling', async () => {
        const pages: PageText[] = all.filter((v) => v.text && v.load.status !== null && v.load.status < 400).map((v) => ({ path: v.load.path, text: v.text }));
        options.onProgress?.({ phase: 'spelling', done: 0, total: pages.length });
        const out = await checkSpelling(pages, options.allowWords ?? []);
        options.onProgress?.({ phase: 'spelling', done: pages.length, total: pages.length });
        return { checked: out.words, findings: out.findings };
      }, visitMs);
    }
    if (aborted()) return stop('cancelled');

    // ---------- the games pass ----------
    if (wants('games')) {
      await run('games', async () => {
        const candidates: GameCandidate[] = [];
        const tabUrls = new Set<string>();
        // A game is opened once, from its own page rather than from a listing that also has its Play button: pages
        // nearest the top of the site first, and the game-cards pages last.
        const depth = (p: string) => p.split('/').length + (p.startsWith('/game-cards/') ? 100 : 0);
        const playerUrls = new Set<string>();
        for (const v of [...all].sort((a, b) => depth(a.load.path) - depth(b.load.path) || a.load.path.localeCompare(b.load.path))) {
          const url = v.plays.wired[0];
          if (url !== undefined && !(url && playerUrls.has(url))) { if (url) playerUrls.add(url); candidates.push({ embed: true, page: v.load.path, title: v.title }); }
          for (const url of v.plays.newTab) if (!tabUrls.has(url)) { tabUrls.add(url); candidates.push({ embed: false, page: v.load.path, title: v.title, url }); }
        }
        const scratchCtx = await newContext(browser!, {}, null);
        try {
          const scratch = await scratchCtx.newPage();
          const loads: GameLoad[] = [];
          let done = 0;
          options.onProgress?.({ phase: 'games', done, total: candidates.length });
          await runPool(candidates, options.concurrency ?? 3, async (c) => {
            if (aborted()) return;
            let game = await openGame({ browser: browser!, guard: hostGuard, origin, scratch }, c);
            // A network error gets a second go (some hosts reset the odd connection), after making sure the checker's
            // own connection is up. A game that refuses to be framed is refusing, not failing: no second go.
            if (game.error && !/refused to be shown/.test(game.error)) { await connection.wait(); game = await openGame({ browser: browser!, guard: hostGuard, origin, scratch }, c); }
            // The same game from two pages is one game.
            if (!(game.embed && game.url && loads.some((l) => l.embed && l.url === game.url))) loads.push(game);
            options.onProgress?.({ phase: 'games', done: ++done, total: candidates.length });
          });
          base.games = loads.filter((g) => g.opened).length;
          const findings: RawFinding[] = loads.flatMap(gameFindings);
          return { checked: loads.length, findings };
        } finally { await scratchCtx.close().catch(() => {}); }
      });
    }
    if (aborted()) return stop('cancelled');

    // Results in the order the checks were asked for.
    results.sort((a, b) => checks.indexOf(a.check) - checks.indexOf(b.check));
    return finishRun(base, results);
  } catch (e) {
    return stop(aborted() ? 'cancelled' : `The run stopped: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => {});
  }
};
