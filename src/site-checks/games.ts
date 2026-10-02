// The games pass: opens each game the way a visitor does (Play in the site's player, or its own tab) and reports
// what happened as a GameLoad.
import type { Browser, Frame, Page } from 'playwright';
import { VIEWPORTS } from '../site-checks.ts';
import type { GameLoad } from '../site-checks.ts';
import { inFrame, newContext, watchRequests } from './browser.ts';
import type { HostGuard, Seen } from './browser.ts';
import { hasVisibleContent } from './inpage.ts';
import { UA, isFlat, shortError, sleep, withTimeout } from './util.ts';

export type GameCandidate =
  | { embed: true; page: string; title: string }
  | { embed: false; page: string; title: string; url: string };

export interface GameEnv {
  browser: Browser;
  guard: HostGuard | null;
  origin: string;
  scratch: Page;                        // an about:blank page, for reading screenshots' pixels
}

const LOAD_MS = 30_000;
const SETTLE_MS = 4000;
const laptop = VIEWPORTS.find((v) => v.name === 'laptop')!;
const REFUSED = 'refused to be shown inside another site (net::ERR_BLOCKED_BY_RESPONSE)';

const blank = (c: GameCandidate, url = ''): GameLoad => ({
  page: c.page, title: c.title, url, embed: c.embed, opened: false, status: null, error: null, hasContent: false, blank: null, ms: null, resources: [],
});

// What Chromium says when a frame's own document could not be shown, in words for a person.
function failureText(errorText: string): string {
  return /ERR_BLOCKED_BY_RESPONSE/.test(errorText) ? REFUSED : errorText;
}

// The game document's navigation outcome among the requests its frame made: the last document request wins (redirects).
function documentOutcome(seen: Seen[], root: Frame | null): { status: number | null; error: string | null } {
  const docs = seen.filter((s) => s.navigation && s.frame === root && s.res.type === 'document');
  const last = docs[docs.length - 1];
  if (!last) return { status: null, error: null };
  return last.res.status === null ? { status: null, error: failureText(last.res.error ?? 'failed') } : { status: last.res.status, error: null };
}

// Whether the screenshot is one flat colour: drawn, without smoothing, onto a 64x64 canvas in the scratch page.
async function isBlank(scratch: Page, png: Buffer): Promise<boolean | null> {
  try {
    const pixels = await withTimeout(scratch.evaluate((dataUrl) => new Promise<number[]>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const c = canvas.getContext('2d')!;
        c.imageSmoothingEnabled = false;
        c.drawImage(img, 0, 0, 64, 64);
        resolve(Array.from(c.getImageData(0, 0, 64, 64).data));
      };
      img.onerror = () => reject(new Error('screenshot unreadable'));
      img.src = dataUrl;
    }), `data:image/png;base64,${png.toString('base64')}`), 15_000, 'reading the screenshot');
    return isFlat(pixels);
  } catch { return null; }
}

// Polls until `done()` is true or `ms` pass; resolves with whether it became true. `stop.now = true` ends it early.
async function until(done: () => boolean, ms: number, stop: { now: boolean }): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end && !stop.now;) {
    if (done()) return true;
    await sleep(50);
  }
  return false;
}

async function openInPlayer(env: GameEnv, c: Extract<GameCandidate, { embed: true }>): Promise<GameLoad> {
  const game = blank(c);
  const ctx = await newContext(env.browser, { viewport: { width: laptop.width, height: laptop.height }, userAgent: UA }, env.guard);
  try {
    const page = await ctx.newPage();
    const watch = watchRequests(page);
    try { await page.goto(env.origin + c.page, { timeout: LOAD_MS, waitUntil: 'load' }); } catch (e) { return { ...game, error: `the page ${c.page} didn't load: ${shortError(e)}` }; }
    const button = page.locator('a[data-vault-play]').first();
    if (!(await button.count())) return game;
    const clicked = Date.now();
    try { await button.click({ timeout: 5000 }); } catch { await button.evaluate((el) => (el as HTMLElement).click()).catch(() => {}); }
    const handle = await page.waitForSelector('.vault-player.is-open iframe.vault-player__frame', { state: 'attached', timeout: 5000 }).catch(() => null);
    if (!handle) return game;
    game.opened = true;
    game.url = await handle.evaluate((el) => (el as HTMLIFrameElement).src).catch(() => '');
    const frame = await handle.contentFrame();
    if (frame) {
      const stop = { now: false };
      const failure = () => documentOutcome(watch.seen, frame).error !== null || frame.url().startsWith('chrome-error:');
      const loaded = frame.waitForLoadState('load', { timeout: LOAD_MS }).then(() => 'load', () => 'timeout');
      const failed = until(failure, LOAD_MS, stop).then((f) => (f ? 'failed' : 'timeout'));
      const outcome = await Promise.race([loaded, failed]);
      stop.now = true;
      game.ms = outcome === 'load' ? Date.now() - clicked : null;
      await sleep(SETTLE_MS);
      await watch.settle();
      const result = documentOutcome(watch.seen, frame);
      game.status = result.status;
      game.error = result.error ?? (frame.url().startsWith('chrome-error:') ? REFUSED : null);
      if (game.error) game.ms = null;
      game.resources = watch.seen.filter((s) => inFrame(s.frame, frame)).map((s) => ({ ...s.res, inFrame: false }));
      if (!game.error) {
        // Two ways of seeing whether the game shows anything: its document, and a picture of it. A busy game may not
        // answer the first in time, and an odd one (an SVG with no box of its own) may answer no while plainly
        // drawing; so it is empty only when its document says so and the picture agrees, or neither could be had.
        const dom = await withTimeout(frame.evaluate(hasVisibleContent), 10_000, 'looking at the game').catch(() => null);
        const shot = await page.locator('.vault-player__stage').screenshot({ timeout: 10_000 }).catch(() => null);
        game.blank = shot ? await isBlank(env.scratch, shot) : null;
        game.hasContent = dom === true || game.blank === false || (dom === null && game.blank === null);
      }
    }
    return game;
  } catch (e) {
    return { ...game, error: game.opened ? game.error : shortError(e) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function openInTab(env: GameEnv, c: Extract<GameCandidate, { embed: false }>): Promise<GameLoad> {
  const game = blank(c, c.url);
  const ctx = await newContext(env.browser, { viewport: { width: laptop.width, height: laptop.height }, userAgent: UA }, env.guard);
  try {
    const page = await ctx.newPage();
    const watch = watchRequests(page);
    const started = Date.now();
    try {
      const response = await page.goto(c.url, { timeout: LOAD_MS, waitUntil: 'load' });
      game.opened = true;
      game.status = response?.status() ?? null;
      game.ms = Date.now() - started;
    } catch (e) {
      game.error = shortError(e);
      await watch.settle();
      game.resources = watch.seen.map((s) => ({ ...s.res, inFrame: false }));
      return game;
    }
    await sleep(SETTLE_MS);
    await watch.settle();
    game.hasContent = await withTimeout(page.evaluate(hasVisibleContent), 10_000, 'looking at the game').catch(() => true);
    game.resources = watch.seen.map((s) => ({ ...s.res, inFrame: false }));
    return game;
  } catch (e) {
    return { ...game, error: shortError(e) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export const openGame = (env: GameEnv, c: GameCandidate): Promise<GameLoad> => (c.embed ? openInPlayer(env, c) : openInTab(env, c));
