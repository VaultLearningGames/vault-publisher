// Site checks: a battery of tests the portal runs against the Vault website, in a headless browser and with plain
// requests. Six checks, each of which can run by itself:
//
//   games        every game opens in the site's player (or its own tab) and actually shows something
//   assets       no page asks for a file that doesn't arrive (images, stylesheets, scripts, fonts), no broken images
//   links        every link, frame, form and video on every page leads somewhere
//   spelling     words on the site that no dictionary knows
//   performance  large files, heavy or slow pages, images far bigger than they are shown, heavy or slow games
//   responsive   every page at phone, tablet, laptop and wide-screen widths: no sideways scrolling, readable text
//
// Who runs what: the engine (src/site-checks/) does the looking, on a GitHub Actions runner (the check-site workflow,
// through scripts/check-site.ts) or on a developer's machine. It loads pages and reports what it saw as the plain
// records below (PageLoad, ViewSeen, LinkSeen + LinkProbe, GameLoad, PageText). This module decides what those mean,
// so it can be tested without a browser or a network. The portal never looks at the site: it receives a finished run
// (POST /v1/admin/site-checks, checked by parseRun below), stores it and shows it on Vault → Site checks.
//
// warn: worth a look, or couldn't be verified. fail: visitors hit it.
import { errorKind } from './game-checks.ts';

export const CHECKS = ['games', 'assets', 'links', 'spelling', 'performance', 'responsive'] as const;
export type CheckName = (typeof CHECKS)[number];
export const CHECK_LABEL: Record<CheckName, string> = {
  games: 'Games load', assets: 'Missing assets', links: 'Broken links', spelling: 'Spelling',
  performance: 'Large files and slow loading', responsive: 'Responsive design',
};

export type FindingLevel = 'warn' | 'fail';

// One thing one page got wrong, as a check reports it.
export interface RawFinding {
  check: CheckName;
  level: FindingLevel;
  code: string;                       // what kind of problem, e.g. 'asset.missing'; stable, for filters and tests
  page: string;                       // the site path it was found on ('/wake/'); '' for the site as a whole
  target: string;                     // the thing itself: a file or link address, a word, an element, a viewport
  message: string;                    // one sentence for a person
  detail?: Record<string, string | number | boolean | null>;
}

// The same problem on many pages (a broken footer link) is one finding, with the pages it is on.
export interface Finding extends RawFinding {
  pages: string[];                    // up to MAX_PAGES_LISTED of the pages it is on, `page` first
  count: number;                      // how many pages it is on
}

export interface CheckSummary {
  check: CheckName;
  status: 'done' | 'skipped' | 'error';
  note: string;                       // why it was skipped or what went wrong; '' when done
  checked: number;                    // how many things it looked at (pages, links, words, games)
  warn: number;
  fail: number;
  ms: number;
  // Problems found but not listed in the run's findings (a check lists at most MAX_PER_CHECK, worst first); they are
  // included in warn and fail. Absent on runs recorded before the cap, and when nothing was left out.
  unlisted?: Record<FindingLevel, number>;
}

export type RunStatus = 'done' | 'error';

export interface SiteCheckRun {
  site: string;                       // the site origin that was checked
  status: RunStatus;
  checks: CheckName[];
  started_at: string;
  finished_at: string;
  source: string | null;              // the GitHub Actions run that made it
  started_by: string;                 // 'github:LOGIN' (set by the portal from the token that posted it) or 'cli'
  pages: number;                      // pages visited
  games: number;                      // games opened
  summaries: CheckSummary[];
  findings: Finding[];                // worst first
  counts: Record<FindingLevel, number>;
  error: string | null;               // why the run itself couldn't finish
  // DETAIL_VERSION when every finding carries its details (the element that asked for a missing file, a link's text,
  // the browser's error, …), for the portal's details tables. Absent on runs recorded before they did.
  detail_version?: number;
}

export interface Progress { phase: string; done: number; total: number }

// ---------- the engine's interface ----------
// What a caller gives the engine (src/site-checks/run.ts: runSiteChecks(options) → SiteCheckRun). The portal never
// imports it: it needs a browser, which only the workflow's runner and a developer's machine have.
export interface RunOptions {
  site: string;                       // origin, e.g. https://vaultlearninggames-staging.org
  checks: CheckName[];
  limit?: number;                     // visit at most this many pages (a quick run)
  paths?: string[];                   // visit only these site paths instead of discovering pages
  allowWords?: string[];              // names the spelling check should accept (game titles, studios)
  guard?: boolean;                    // true: never request private or loopback addresses (the workflow does)
  concurrency?: number;               // browser pages open at once
  source?: string | null;
  startedBy?: string;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
}
export type Engine = (options: RunOptions) => Promise<SiteCheckRun>;

// ---------- what the engine sees ----------
// A request made while a page or game loaded.
export interface ResourceSeen {
  url: string;
  type: string;                       // document, stylesheet, script, image, font, media, xhr, fetch, other
  status: number | null;              // null: no response arrived
  error: string | null;               // the browser's reason when it failed, e.g. 'net::ERR_NAME_NOT_RESOLVED'
  bytes: number | null;               // bytes over the network (compressed); null when unknown
  mime: string;
  encoding: string;                   // Content-Encoding, '' for none
  ms: number | null;
  inFrame: boolean;                   // asked for by an embedded frame (a video player), not by the page itself
}

export interface ImageSeen {
  src: string;                        // the address the browser chose (currentSrc)
  loaded: boolean;
  natural: [number, number];          // the file's pixels
  shown: [number, number];            // CSS pixels on the page at the laptop width
}

// One page, loaded at the laptop width with an empty cache.
export interface PageLoad {
  path: string;
  status: number | null;
  error: string | null;               // why the page itself didn't load
  resources: ResourceSeen[];
  images: ImageSeen[];
  scriptErrors: string[];             // uncaught exceptions
  refs?: Record<string, string>;      // address → the element on the page that asks for it ('img', 'script', 'link rel=stylesheet', …)
  timing: { ttfb: number | null; domContentLoaded: number | null; load: number | null; lcp: number | null };
}

export const VIEWPORTS = [
  { name: 'phone', width: 360, height: 740, mobile: true },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'laptop', width: 1280, height: 800, mobile: false },
  { name: 'wide', width: 1920, height: 1080, mobile: false },
] as const;
export type ViewportName = (typeof VIEWPORTS)[number]['name'];

// One page at one width.
export interface ViewSeen {
  path: string;
  viewport: ViewportName;
  width: number;                      // the viewport's width
  hasViewportMeta: boolean;
  scrollWidth: number;                // the document's full width; wider than `width` means sideways scrolling
  offenders: { selector: string; right: number }[];             // elements reaching past the right edge, widest first
  smallText: { selector: string; px: number; sample: string }[];   // visible text smaller than LIMITS.smallTextPx
  smallTargets: { selector: string; width: number; height: number; label: string }[]; // links and buttons too small to tap
}

export type LinkKind = 'link' | 'frame' | 'form' | 'video' | 'meta' | 'sitemap';
export interface LinkSeen {
  page: string;
  url: string;                        // absolute, as the browser resolved it, without its #fragment
  fragment: string;                   // the #fragment without the #, '' for none
  raw: string;                        // the attribute as written
  text: string;                       // the link's text, for the report
  kind: LinkKind;
}
export interface LinkProbe {
  status: number | null;
  error: { code: string; message: string } | null;   // code as Node reports it (ENOTFOUND, TimeoutError, …) or 'BLOCKED'
  finalUrl: string | null;
  attempts: number;
  anchorFound: boolean | null;        // for a link with a #fragment to a page of the site; null when not looked for
}

// One game, opened the way a visitor opens it.
export interface GameLoad {
  page: string;                       // the game's page on the site
  title: string;
  url: string;                        // the game's own address
  embed: boolean;                     // true: the site plays it in its in-page player; false: it opens in a new tab
  opened: boolean;                    // the player opened with the game's frame in it (embed), or the tab loaded
  status: number | null;              // the game document's status
  error: string | null;               // why the game's document didn't load (refused framing, DNS, …)
  hasContent: boolean;                // the game's document has something visible in it
  blank: boolean | null;              // after settling, the game's area is one flat colour; null when not measured
  ms: number | null;                  // until the game's document finished loading; null: it never did in time
  resources: ResourceSeen[];          // what the game asked for
}

export interface PageText { path: string; text: string }
export interface Dictionary { correct(word: string): boolean; suggest(word: string): string[] }

// ---------- limits ----------
export const LIMITS = {
  imageWarnBytes: 500_000, imageFailBytes: 2_000_000,
  fileWarnBytes: 1_000_000, fileFailBytes: 5_000_000,       // scripts, stylesheets, fonts, anything else
  mediaWarnBytes: 10_000_000,                               // video and audio
  pageWarnBytes: 3_000_000, pageFailBytes: 10_000_000,      // everything one page loads
  loadWarnMs: 3000, loadFailMs: 8000,
  lcpWarnMs: 2500, lcpFailMs: 4000,                         // largest contentful paint (web.dev's "good" and "poor")
  ttfbWarnMs: 800,
  uncompressedBytes: 20_000,                                // text files this big should be sent compressed
  oversizedFactor: 3, oversizedBytes: 100_000,              // an image with over 3x the pixels across that it is shown at
  gameLoadWarnMs: 15_000, gameWarnBytes: 50_000_000, gameFailBytes: 200_000_000,
  gameMissingListed: 5,
  smallTextPx: 12, tapTargetPx: 24, overflowPx: 2,
} as const;
export const MAX_PAGES_LISTED = 20;
// Each check lists at most this many findings (worst first, then the most widespread), so one bad run can't bloat the
// portal's database; the rest are counted (CheckSummary.unlisted).
export const MAX_PER_CHECK = 500;
export const MAX_FINDINGS = MAX_PER_CHECK * 6;
export const DETAIL_VERSION = 2;

const mb = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sameOrigin = (url: string, origin: string) => { try { return new URL(url).origin === new URL(origin).origin; } catch { return false; } };
const isWeb = (url: string) => /^https?:\/\//i.test(url);
const short = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// ---------- assets ----------
// Requests the browser gives up on by itself (a navigation away, a beacon) aren't missing files.
const cancelled = (r: ResourceSeen) => !!r.error && /ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(r.error);
const failed = (r: ResourceSeen) => (r.status === null ? !!r.error && !cancelled(r) : r.status >= 400);
const PAGE_PARTS = new Set(['document', 'stylesheet', 'script', 'image', 'font', 'media']);

// The element on the page that asked for an address, or the likeliest asker when no element names it (a font or a
// background image comes from a stylesheet; anything else from a script).
export function elementFor(page: Pick<PageLoad, 'refs'>, url: string, type: string): string {
  const named = page.refs?.[url];
  if (named) return named;
  if (type === 'font') return 'a stylesheet (@font-face)';
  if (type === 'image') return 'a stylesheet or a script';
  if (type === 'document') return 'the page itself';
  return 'a script';
}

export function assetFindings(page: PageLoad, siteOrigin: string): RawFinding[] {
  const out: RawFinding[] = [];
  const seen = new Set<string>();
  const add = (f: Omit<RawFinding, 'check' | 'page'>) => {
    if (seen.has(f.target)) return;
    seen.add(f.target);
    out.push({ check: 'assets', page: page.path, ...f });
  };
  if (page.error || (page.status !== null && page.status >= 400)) {
    add({ level: 'fail', code: 'page.failed', target: page.path, message: page.error ? `The page didn't load: ${page.error}` : `The page answers HTTP ${page.status}`, detail: { status: page.status, error: page.error, element: 'the page itself' } });
    return out;
  }
  for (const r of page.resources) {
    if (r.inFrame || !isWeb(r.url) || !failed(r)) continue;
    // What a page is made of, or anything from the site itself, is a failure; a third party's data request
    // (analytics, a font service's tracking call) only a warning.
    const serious = PAGE_PARTS.has(r.type) || sameOrigin(r.url, siteOrigin);
    add({
      level: serious ? 'fail' : 'warn', code: 'asset.missing', target: r.url,
      message: r.status === null ? `A ${r.type} didn't load (${r.error})` : `A ${r.type} answers HTTP ${r.status}`,
      detail: { status: r.status, error: r.status === null ? r.error : null, type: r.type, element: elementFor(page, r.url, r.type) },
    });
  }
  for (const img of page.images) {
    if (img.loaded || !isWeb(img.src)) continue;
    add({ level: 'fail', code: 'asset.broken-image', target: img.src, message: 'An image on the page is broken', detail: { status: null, error: 'the file is not an image the browser can show', type: 'image', element: page.refs?.[img.src] ?? 'img' } });
  }
  for (const e of page.scriptErrors) {
    add({ level: 'warn', code: 'asset.script-error', target: short(e, 200), message: 'A script on the page stopped with an error', detail: { error: short(e, 500), type: 'script', element: 'script' } });
  }
  return out;
}

// ---------- performance ----------
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|xhtml\+xml|manifest\+json)|image\/svg\+xml)/i;

export function performanceFindings(page: PageLoad): RawFinding[] {
  const out: RawFinding[] = [];
  if (page.error || (page.status !== null && page.status >= 400)) return out;
  const add = (f: Omit<RawFinding, 'check' | 'page'>) => out.push({ check: 'performance', page: page.path, ...f });
  let total = 0;
  for (const r of page.resources) {
    if (r.inFrame || r.bytes === null) continue;
    total += r.bytes;
    const [warn, fail, what] = r.type === 'image' ? [LIMITS.imageWarnBytes, LIMITS.imageFailBytes, 'image']
      : r.type === 'media' ? [LIMITS.mediaWarnBytes, Infinity, 'video or audio file']
      : [LIMITS.fileWarnBytes, LIMITS.fileFailBytes, r.type === 'other' ? 'file' : r.type];
    if (r.bytes > warn) {
      add({ level: r.bytes > fail ? 'fail' : 'warn', code: 'perf.large-file', target: r.url, message: `A ${mb(r.bytes)} ${what}`, detail: { bytes: r.bytes, type: r.type, element: elementFor(page, r.url, r.type) } });
    } else if (r.bytes > LIMITS.uncompressedBytes && !r.encoding && COMPRESSIBLE.test(r.mime)) {
      add({ level: 'warn', code: 'perf.uncompressed', target: r.url, message: `A ${mb(r.bytes)} ${what} is sent without compression`, detail: { bytes: r.bytes, type: r.type, element: elementFor(page, r.url, r.type) } });
    }
  }
  if (total > LIMITS.pageWarnBytes) {
    add({ level: total > LIMITS.pageFailBytes ? 'fail' : 'warn', code: 'perf.heavy-page', target: page.path, message: `The page loads ${mb(total)}`, detail: { bytes: total } });
  }
  const bytesOf = new Map(page.resources.map((r) => [r.url, r.bytes]));
  for (const img of page.images) {
    const bytes = bytesOf.get(img.src) ?? null;
    if (!img.loaded || img.shown[0] < 1 || bytes === null || bytes < LIMITS.oversizedBytes) continue;
    if (img.natural[0] > img.shown[0] * LIMITS.oversizedFactor) {
      add({ level: 'warn', code: 'perf.oversized-image', target: img.src, message: `A ${img.natural[0]}px-wide image (${mb(bytes)}) is shown ${Math.round(img.shown[0])}px wide`, detail: { bytes, natural: img.natural[0], shown: Math.round(img.shown[0]), type: 'image', element: 'img' } });
    }
  }
  const { load, lcp, ttfb } = page.timing;
  if (load !== null && load > LIMITS.loadWarnMs) {
    add({ level: load > LIMITS.loadFailMs ? 'fail' : 'warn', code: 'perf.slow-page', target: page.path, message: `The page takes ${secs(load)} to load`, detail: { ms: load } });
  } else if (lcp !== null && lcp > LIMITS.lcpWarnMs) {
    add({ level: lcp > LIMITS.lcpFailMs ? 'fail' : 'warn', code: 'perf.slow-paint', target: page.path, message: `The page's main content takes ${secs(lcp)} to appear`, detail: { ms: lcp } });
  } else if (ttfb !== null && ttfb > LIMITS.ttfbWarnMs) {
    add({ level: 'warn', code: 'perf.slow-server', target: page.path, message: `The server takes ${secs(ttfb)} to answer`, detail: { ms: ttfb } });
  }
  return out;
}

// ---------- responsive ----------
export function responsiveFindings(view: ViewSeen): RawFinding[] {
  const out: RawFinding[] = [];
  const add = (f: Omit<RawFinding, 'check' | 'page'>) => out.push({ check: 'responsive', page: view.path, ...f });
  const small = view.viewport === 'phone' || view.viewport === 'tablet';
  const at = `${view.viewport} (${view.width}px)`;
  if (!view.hasViewportMeta && view.viewport === 'phone') {
    add({ level: 'fail', code: 'responsive.no-viewport', target: 'meta viewport', message: 'The page has no viewport meta tag, so phones show it zoomed out', detail: { viewport: view.viewport, width: view.width, selector: 'meta[name=viewport]' } });
  }
  const over = view.scrollWidth - view.width;
  if (over > LIMITS.overflowPx) {
    const culprit = view.offenders[0]?.selector ?? 'the page';
    add({
      level: small ? 'fail' : 'warn', code: 'responsive.overflow', target: `${at}: ${culprit}`,
      message: `Scrolls sideways on a ${view.viewport}: the page is ${view.scrollWidth}px wide in a ${view.width}px window (${culprit} sticks out)`,
      detail: { viewport: view.viewport, width: view.width, scrollWidth: view.scrollWidth, selector: culprit, others: view.offenders.slice(1).map((o) => o.selector).join(', ') },
    });
  }
  if (view.viewport !== 'phone') return out;
  // One finding per kind of element, so a page with forty tiny captions is one line.
  const first = <T extends { selector: string }>(items: T[]) => [...new Map(items.map((i) => [i.selector, i] as const)).values()];
  for (const t of first(view.smallText)) {
    add({ level: 'warn', code: 'responsive.small-text', target: `${at}: ${t.selector}`, message: `Text is ${t.px}px on a phone: “${short(t.sample, 60)}”`, detail: { viewport: view.viewport, width: view.width, selector: t.selector, px: t.px, sample: short(t.sample, 60) } });
  }
  for (const t of first(view.smallTargets)) {
    add({ level: 'warn', code: 'responsive.small-target', target: `${at}: ${t.selector}`, message: `A ${Math.round(t.width)}×${Math.round(t.height)}px ${t.label ? `“${short(t.label, 40)}” ` : ''}link or button is hard to tap on a phone`, detail: { viewport: view.viewport, width: view.width, selector: t.selector, size: `${Math.round(t.width)}×${Math.round(t.height)}`, label: short(t.label, 40) } });
  }
  return out;
}

// ---------- links ----------
// What's wrong with an address before asking for it; null when it should be requested (http or https) or needs no
// check (a bare #fragment is checked against the page it is on by the engine).
export function hrefProblem(raw: string): { level: FindingLevel; message: string } | 'skip' | null {
  const href = raw.trim();
  if (href === '') return { level: 'warn', message: 'A link with an empty address' };
  if (href.startsWith('#')) return 'skip';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1].toLowerCase();
  if (!scheme || scheme === 'http' || scheme === 'https') return null;
  if (scheme === 'mailto') {
    const to = decodeURIComponent(href.slice(7).split('?')[0]);
    return to.split(',').every((a) => /^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(a.trim())) ? 'skip' : { level: 'fail', message: `Not a valid email address: ${to || '(none)'}` };
  }
  if (scheme === 'tel') return href.slice(4).replace(/\D/g, '').length >= 7 ? 'skip' : { level: 'fail', message: 'Not a valid phone number' };
  if (scheme === 'javascript') return { level: 'warn', message: 'A javascript: link (nothing to follow)' };
  return 'skip';
}

// Statuses sites give automated requests that they would not give a visitor.
const REFUSED = new Set([401, 403, 405, 406, 429, 999]);

export function linkFinding(link: LinkSeen, probe: LinkProbe, siteOrigin: string): RawFinding | null {
  const internal = sameOrigin(link.url, siteOrigin);
  const noun = link.kind === 'frame' ? 'An embedded frame' : link.kind === 'form' ? 'A form' : link.kind === 'video' ? 'A video'
    : link.kind === 'sitemap' ? 'A page in the sitemap' : link.kind === 'meta' ? 'An address in the page’s head' : `The link${link.text ? ` “${short(link.text, 50)}”` : ''}`;
  const f = (level: FindingLevel, code: string, message: string): RawFinding => ({
    check: 'links', level, code, page: link.page, target: link.url + (code === 'link.missing-anchor' ? `#${link.fragment}` : ''), message,
    detail: {
      status: probe.status, kind: link.kind, text: short(link.text, 120), error: probe.error ? `${probe.error.code}${probe.error.message && probe.error.message !== probe.error.code ? `: ${short(probe.error.message, 200)}` : ''}` : null,
      final: probe.finalUrl && probe.finalUrl !== link.url ? short(probe.finalUrl, 500) : null,
    },
  });
  if (probe.error) {
    const { code, message } = probe.error;
    if (code === 'BLOCKED') return f('warn', 'link.private', `${noun} points to a private address (${message})`);
    const kind = errorKind(code);
    if (kind === 'dns') return f('fail', 'link.broken', `${noun} goes to a site that no longer exists (${code})`);
    if (kind === 'tls') return f('fail', 'link.broken', `${noun} goes to a site with a broken HTTPS certificate (${code})`);
    if (kind === 'redirects') return f('fail', 'link.broken', `${noun} redirects in a loop`);
    // A site that doesn't answer a data centre may still answer a visitor.
    return internal ? f('fail', 'link.broken', `${noun} didn't answer (${code})`) : f('warn', 'link.unverified', `${noun} didn't answer the check (${code}); open it to be sure`);
  }
  const s = probe.status;
  if (s === null) return null;
  if (s === 404 || s === 410) return f('fail', 'link.broken', link.kind === 'video' ? `${noun} is no longer available` : `${noun} leads to a page that isn't there (HTTP ${s})`);
  if (!internal && REFUSED.has(s)) return f('warn', 'link.unverified', `${noun} refuses automated checks (HTTP ${s}); open it to be sure`);
  if (s >= 400) return f('fail', 'link.broken', `${noun} answers HTTP ${s}`);
  if (link.fragment && probe.anchorFound === false) return f('warn', 'link.missing-anchor', `${noun} points to #${link.fragment}, which isn't on that page`);
  return null;
}

// ---------- games ----------
export function gameFindings(game: GameLoad): RawFinding[] {
  const out: RawFinding[] = [];
  const add = (check: CheckName, f: Omit<RawFinding, 'check' | 'page'>) => out.push({ check, page: game.page, ...f });
  const name = game.title || game.page;
  const where = game.embed ? 'in the site’s player' : 'in its own tab';
  // What the details table shows for every game finding: which game, how it is opened, and what it answered.
  const about = { game: short(name, 120), embed: game.embed, status: game.status, error: game.error, ms: game.ms };
  const broken = (code: string, message: string) => { add('games', { level: 'fail', code, target: game.url || game.page, message, detail: about }); return out; };
  if (game.error) return broken('game.failed', `${name} doesn't load ${where}: ${game.error}`);
  // A game's site that refuses the checker (bot protection) may still let a visitor in.
  if (game.status !== null && REFUSED.has(game.status)) {
    add('games', { level: 'warn', code: 'game.unverified', target: game.url, message: `${name} refuses automated checks (HTTP ${game.status}); open it to be sure`, detail: about });
    return out;
  }
  if (game.status !== null && game.status >= 400) return broken('game.failed', `${name} answers HTTP ${game.status}`);
  if (!game.opened) return broken('game.no-player', game.embed ? `Play didn't open ${name} in the site’s player` : `${name} didn't open`);
  if (!game.hasContent) return broken('game.empty', `${name} opens ${where} but shows nothing`);

  if (game.blank) add('games', { level: 'warn', code: 'game.blank', target: game.url, message: `${name} is still a blank screen after loading`, detail: about });
  // The game's own files, wherever they are kept; not the calls it makes to someone else's statistics service.
  const missing = game.resources.filter((r) => isWeb(r.url) && failed(r) && (PAGE_PARTS.has(r.type) || sameOrigin(r.url, game.url)));
  for (const r of missing.slice(0, LIMITS.gameMissingListed)) {
    add('games', { level: 'warn', code: 'game.missing-file', target: r.url, message: `${name} asks for a ${r.type} that ${r.status === null ? `doesn't load (${r.error})` : `answers HTTP ${r.status}`}`, detail: { ...about, status: r.status, error: r.status === null ? r.error : null, type: r.type } });
  }
  if (missing.length > LIMITS.gameMissingListed) {
    add('games', { level: 'warn', code: 'game.missing-file', target: `${game.url} (+${missing.length - LIMITS.gameMissingListed} more)`, message: `${name} asks for ${missing.length} files that don't load`, detail: about });
  }
  if (game.ms === null) add('performance', { level: 'warn', code: 'game.slow', target: game.url, message: `${name} hadn't finished loading when the check stopped waiting`, detail: about });
  else if (game.ms > LIMITS.gameLoadWarnMs) add('performance', { level: 'warn', code: 'game.slow', target: game.url, message: `${name} takes ${secs(game.ms)} to load`, detail: about });
  const bytes = game.resources.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
  if (bytes > LIMITS.gameWarnBytes) {
    add('performance', { level: bytes > LIMITS.gameFailBytes ? 'fail' : 'warn', code: 'game.heavy', target: game.url, message: `${name} downloads ${mb(bytes)} before it can be played`, detail: { ...about, bytes } });
  }
  return out;
}

// ---------- spelling ----------
// The words of a page worth checking. Left out: addresses and emails, anything with a digit in it, single letters,
// short ALL-CAPS words (NGSS, STEM) and words with a capital inside (iCivics, PhET, YouTube), which are names.
export function wordsOf(text: string): string[] {
  const cleaned = text
    .replace(/[‘’]/g, "'")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')          // soft hyphens and zero-width marks sit inside words
    .replace(/[\p{L}']+(?=\.{3}|…)/gu, ' ')                      // a word cut short by "..." is half a word
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|edu|net|gov|io|co|us|uk|ca|tv|games)\b(?:\/\S*)?/gi, ' ');
  const out: string[] = [];
  for (const token of cleaned.split(/[^\p{L}\p{N}']+/u)) {
    if (/\p{N}/u.test(token)) continue;
    const word = token.replace(/^'+|'+$/g, '').replace(/'s$/i, '');
    if (word.length < 2 || word.includes("'") && !/^\p{L}+'\p{L}{1,2}$/u.test(word)) continue;
    if (word === word.toUpperCase() && word.length <= 6) continue;
    if (/\p{Ll}\p{Lu}/u.test(word)) continue;
    out.push(word);
  }
  return out;
}

// Words to accept, from names: every word in each name, whatever its case.
export function allowList(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) for (const w of n.replace(/[‘’]/g, "'").split(/[^\p{L}']+/u)) if (w) { out.add(w.toLowerCase()); out.add(w.toLowerCase().replace(/'s$/, '')); }
  return out;
}

// Unknown words across the site, one finding per word. Spelling only ever warns: a dictionary can't tell a typo from
// a name it hasn't met.
export function spellingFindings(pages: PageText[], dictionary: Dictionary, allow: Set<string>, maxSuggested = 300): { findings: RawFinding[]; words: number } {
  const where = new Map<string, { page: string; context: string }[]>();
  const known = new Map<string, boolean>();
  let words = 0;
  for (const p of pages) {
    const onPage = new Set<string>();
    for (const word of wordsOf(p.text)) {
      words++;
      const key = word.toLowerCase();
      if (onPage.has(key)) continue;
      onPage.add(key);
      let ok = known.get(key);
      if (ok === undefined) {
        ok = allow.has(key) || dictionary.correct(word) || dictionary.correct(key);
        known.set(key, ok);
      }
      if (ok) continue;
      // Where the word stands by itself, not inside a longer one ("concentra" cut off at the end of a summary).
      const i = p.text.replace(/[‘’]/g, "'").search(new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u'));
      const context = i < 0 ? word : p.text.slice(Math.max(0, i - 40), i + word.length + 40).replace(/\s+/g, ' ').trim();
      if (!where.has(key)) where.set(key, []);
      where.get(key)!.push({ page: p.path, context });
    }
  }
  const findings: RawFinding[] = [];
  let suggested = 0;
  for (const [word, hits] of where) {
    const suggestion = suggested++ < maxSuggested ? dictionary.suggest(word)[0] ?? null : null;
    for (const h of hits) {
      findings.push({ check: 'spelling', level: 'warn', code: 'spelling.unknown', page: h.page, target: word, message: `“${word}” isn't in the dictionary${suggestion ? ` (${suggestion}?)` : ''}: “…${h.context}…”`, detail: { suggestion, context: short(h.context, 200) } });
    }
  }
  return { findings, words };
}

// ---------- a run ----------
const WORST: readonly FindingLevel[] = ['fail', 'warn'];

// The same problem (check, code, target) on many pages becomes one finding; worst first, then the most widespread.
export function groupFindings(raw: RawFinding[]): Finding[] {
  const groups = new Map<string, Finding>();
  for (const r of raw) {
    const key = `${r.check}\n${r.code}\n${r.target}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...r, pages: [r.page], count: 1 }); continue; }
    if (g.pages.includes(r.page)) continue;
    g.count++;
    if (g.pages.length < MAX_PAGES_LISTED) g.pages.push(r.page);
    if (r.level === 'fail') g.level = 'fail';
  }
  return [...groups.values()].sort((a, b) =>
    WORST.indexOf(a.level) - WORST.indexOf(b.level) || CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check) || b.count - a.count || a.target.localeCompare(b.target));
}

export function countFindings(findings: { level: FindingLevel }[]): Record<FindingLevel, number> {
  const counts = { warn: 0, fail: 0 };
  for (const f of findings) counts[f.level]++;
  return counts;
}

export interface CheckResult { check: CheckName; status: CheckSummary['status']; note?: string; checked: number; ms: number; findings: RawFinding[] }

// Puts a run together from what each check found. A finding belongs to the check named on it (a game that is slow
// is reported by the games check but counted under performance), so the counts are taken from the findings.
// Each check lists at most MAX_PER_CHECK findings, its worst; the rest are counted in its summary's `unlisted`.
export function finishRun(base: Pick<SiteCheckRun, 'site' | 'checks' | 'started_at' | 'source' | 'started_by' | 'pages' | 'games'>, results: CheckResult[], error: string | null = null): SiteCheckRun {
  const all = groupFindings(results.flatMap((r) => r.findings).filter((f) => base.checks.includes(f.check)));
  const kept = new Set<Finding>();
  const summaries = base.checks.map((check): CheckSummary => {
    const r = results.find((x) => x.check === check);
    const mine = all.filter((f) => f.check === check);
    mine.slice(0, MAX_PER_CHECK).forEach((f) => kept.add(f));
    const summary: CheckSummary = {
      check, status: r?.status ?? 'skipped', note: r ? r.note ?? '' : 'It did not run', checked: r?.checked ?? 0, ms: r?.ms ?? 0,
      ...countFindings(mine),
    };
    if (mine.length > MAX_PER_CHECK) summary.unlisted = countFindings(mine.slice(MAX_PER_CHECK));
    return summary;
  });
  const findings = all.filter((f) => kept.has(f));
  return { ...base, status: error ? 'error' : 'done', finished_at: new Date().toISOString(), summaries, findings, counts: countFindings(all), error, detail_version: DETAIL_VERSION };
}

// The portal takes requests of at most 4 MB (bodyLimit on /v1/*). A run that would be bigger as JSON lists fewer
// findings: the check listing the most gives up its least serious ones (they become `unlisted`) until it fits.
export const MAX_POST_BYTES = 3_800_000;
export function fitRun(run: SiteCheckRun, maxBytes = MAX_POST_BYTES): SiteCheckRun {
  const size = (r: SiteCheckRun) => Buffer.byteLength(JSON.stringify(r));
  let out = run;
  while (out.findings.length && size(out) > maxBytes) {
    const per = new Map<CheckName, number>();
    for (const f of out.findings) per.set(f.check, (per.get(f.check) ?? 0) + 1);
    const [check, n] = [...per].sort((a, b) => b[1] - a[1])[0];
    const keep = Math.floor(n * 0.8);
    const mine = out.findings.filter((f) => f.check === check);
    const dropped = new Set(mine.slice(keep));
    const gone = countFindings([...dropped]);
    out = {
      ...out,
      findings: out.findings.filter((f) => !dropped.has(f)),
      summaries: out.summaries.map((s) => (s.check !== check ? s : { ...s, unlisted: { warn: (s.unlisted?.warn ?? 0) + gone.warn, fail: (s.unlisted?.fail ?? 0) + gone.fail } })),
    };
  }
  return out;
}

// ---------- starting a run ----------
export interface StartRequest { checks: CheckName[]; limit?: number; paths?: string[]; source: string | null }

// The body of POST /v1/admin/site-checks. Returns an error message for anything unusable.
export function parseStart(body: Record<string, unknown>): StartRequest | string {
  let checks: CheckName[] = [...CHECKS];
  if (body.checks !== undefined && body.checks !== null && body.checks !== '' && body.checks !== 'all') {
    const list = typeof body.checks === 'string' ? body.checks.split(',').map((s) => s.trim()).filter(Boolean) : body.checks;
    if (!Array.isArray(list) || list.length === 0) return `checks must be a list of: ${CHECKS.join(', ')}`;
    const unknown = list.filter((c) => !CHECKS.includes(c as CheckName));
    if (unknown.length) return `unknown check ${unknown.join(', ')}; the checks are ${CHECKS.join(', ')}`;
    checks = CHECKS.filter((c) => list.includes(c));
  }
  const out: StartRequest = { checks, source: null };
  if (body.limit !== undefined && body.limit !== null && body.limit !== '') {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1 || n > 5000) return 'limit must be a number of pages from 1 to 5000';
    out.limit = n;
  }
  if (body.paths !== undefined && body.paths !== null && body.paths !== '') {
    const list = typeof body.paths === 'string' ? body.paths.split(',').map((s) => s.trim()).filter(Boolean) : body.paths;
    if (!Array.isArray(list) || list.length === 0 || list.length > 500) return 'paths must be a list of up to 500 site paths';
    if (!list.every((p) => typeof p === 'string' && /^\/[^\s]*$/.test(p) && !p.startsWith('//'))) return 'each path must be a site path starting with /, e.g. /wake/';
    out.paths = list as string[];
  }
  if (typeof body.source === 'string' && body.source) {
    if (!/^https:\/\/\S+$/.test(body.source) || body.source.length > 500) return 'source must be an https link (the workflow run)';
    out.source = body.source;
  }
  return out;
}

// ---------- receiving a run ----------
const MAX_DETAIL_KEYS = 20;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const amount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const isoDate = (v: unknown) => { const t = text(v, 40); return t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : null; };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// A run as posted to the portal (scripts/check-site.ts --out). Returns an error message for anything unusable; every
// string is trimmed to a sane size, and the counts are never taken from the body: they are worked out from the
// findings. started_by is left empty, because the portal sets it from the token that posted the run.
export function parseRun(body: Record<string, unknown>): SiteCheckRun | string {
  const siteText = text(body.site, 300);
  let site: string;
  try {
    const u = new URL(siteText);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http');
    site = u.origin;
  } catch { return 'site must be the site origin, e.g. https://vaultlearninggames.org'; }
  if (body.status !== 'done' && body.status !== 'error') return 'status must be done or error';
  if (!Array.isArray(body.checks) || body.checks.length === 0) return `checks must be a list of: ${CHECKS.join(', ')}`;
  const unknown = body.checks.filter((c) => !CHECKS.includes(c as CheckName));
  if (unknown.length) return `unknown check ${unknown.map((c) => text(c, 40) || '?').join(', ')}; the checks are ${CHECKS.join(', ')}`;
  const checks = CHECKS.filter((c) => (body.checks as unknown[]).includes(c));
  const startedAt = isoDate(body.started_at);
  if (!startedAt) return 'started_at must be a date';
  const finishedAt = isoDate(body.finished_at);
  if (!finishedAt) return 'finished_at must be a date';
  const source = typeof body.source === 'string' ? body.source : '';
  if (source && (source.length > 500 || !/^https:\/\/\S+$/.test(source))) return 'source must be an https link (the workflow run), at most 500 characters';
  const pages = count(body.pages), games = count(body.games);
  if (pages === null) return 'pages must be a whole number, 0 or more';
  if (games === null) return 'games must be a whole number, 0 or more';
  if (body.error !== null && body.error !== undefined && (typeof body.error !== 'string' || body.error.length > 1000)) return 'error must be text of at most 1000 characters, or null';
  const error = typeof body.error === 'string' && body.error ? body.error : null;

  if (!Array.isArray(body.findings)) return 'findings must be an array';
  if (body.findings.length > MAX_FINDINGS) return `at most ${MAX_FINDINGS} findings`;
  const perCheck = new Map<unknown, number>();
  for (const f of body.findings) {
    const c = isObject(f) ? f.check : undefined;
    perCheck.set(c, (perCheck.get(c) ?? 0) + 1);
    if (perCheck.get(c)! > MAX_PER_CHECK) return `at most ${MAX_PER_CHECK} findings for each check`;
  }
  const findings: Finding[] = [];
  for (const [i, raw] of body.findings.entries()) {
    if (!isObject(raw)) return `findings[${i}] must be an object`;
    if (!CHECKS.includes(raw.check as CheckName) || !checks.includes(raw.check as CheckName)) return `findings[${i}].check must be one of the run's checks`;
    if (raw.level !== 'warn' && raw.level !== 'fail') return `findings[${i}].level must be warn or fail`;
    const code = text(raw.code, 100);
    if (!code) return `findings[${i}].code is missing`;
    const message = text(raw.message, 1000);
    if (!message) return `findings[${i}].message is missing`;
    if (raw.page !== undefined && typeof raw.page !== 'string') return `findings[${i}].page must be text`;
    if (raw.target !== undefined && typeof raw.target !== 'string') return `findings[${i}].target must be text`;
    const page = text(raw.page, 500);
    let listed: string[] = [page];
    if (raw.pages !== undefined) {
      if (!Array.isArray(raw.pages) || !raw.pages.every((p) => typeof p === 'string')) return `findings[${i}].pages must be a list of site paths`;
      listed = (raw.pages as string[]).slice(0, MAX_PAGES_LISTED).map((p) => text(p, 500));
      if (!listed.length) listed = [page];
    }
    const n = count(raw.count);
    if (n === null || n < 1) return `findings[${i}].count must be a whole number, 1 or more`;
    const finding: Finding = { check: raw.check as CheckName, level: raw.level, code, page, target: text(raw.target, 2000), message, pages: listed, count: Math.max(n, listed.length) };
    if (raw.detail !== undefined && raw.detail !== null) {
      if (!isObject(raw.detail)) return `findings[${i}].detail must be an object`;
      const entries = Object.entries(raw.detail);
      if (entries.length > MAX_DETAIL_KEYS) return `findings[${i}].detail has more than ${MAX_DETAIL_KEYS} keys`;
      const detail: Record<string, string | number | boolean | null> = {};
      for (const [k, v] of entries) {
        if (typeof v === 'string') detail[k.slice(0, 100)] = v.slice(0, 500);
        else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) detail[k.slice(0, 100)] = v;
        else return `findings[${i}].detail.${k.slice(0, 40)} must be text, a number, true, false or null`;
      }
      finding.detail = detail;
    }
    findings.push(finding);
  }

  if (!Array.isArray(body.summaries)) return 'summaries must be an array';
  if (body.summaries.length > checks.length) return 'at most one summary for each check';
  const summaries: CheckSummary[] = [];
  for (const [i, raw] of body.summaries.entries()) {
    if (!isObject(raw)) return `summaries[${i}] must be an object`;
    const check = raw.check as CheckName;
    if (!checks.includes(check)) return `summaries[${i}].check must be one of the run's checks`;
    if (summaries.some((s) => s.check === check)) return `summaries[${i}]: ${check} is summarised twice`;
    if (raw.status !== 'done' && raw.status !== 'skipped' && raw.status !== 'error') return `summaries[${i}].status must be done, skipped or error`;
    const checked = amount(raw.checked), ms = amount(raw.ms);
    if (checked === null) return `summaries[${i}].checked must be a number, 0 or more`;
    if (ms === null) return `summaries[${i}].ms must be a number, 0 or more`;
    const listed = countFindings(findings.filter((f) => f.check === check));
    const summary: CheckSummary = { check, status: raw.status, note: text(raw.note, 500), checked, ms, ...listed };
    // The findings left out of the list can only be counted, so these are the one count taken from the body.
    if (raw.unlisted !== undefined && raw.unlisted !== null) {
      const u = raw.unlisted;
      const warn = isObject(u) ? count(u.warn) : null, fail = isObject(u) ? count(u.fail) : null;
      if (warn === null || fail === null || warn > 1_000_000 || fail > 1_000_000) return `summaries[${i}].unlisted must be { warn, fail }: whole numbers, 0 or more`;
      if (warn + fail > 0) {
        summary.unlisted = { warn, fail };
        summary.warn += warn;
        summary.fail += fail;
      }
    }
    summaries.push(summary);
  }
  summaries.sort((a, b) => CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check));
  const counts = countFindings(findings);
  for (const s of summaries) if (s.unlisted) { counts.warn += s.unlisted.warn; counts.fail += s.unlisted.fail; }
  const run: SiteCheckRun = { site, status: body.status, checks, started_at: startedAt, finished_at: finishedAt, source: source || null, started_by: '', pages, games, summaries, findings, counts, error };
  if (body.detail_version !== undefined && body.detail_version !== null) {
    const v = count(body.detail_version);
    if (v === null || v > 1000) return 'detail_version must be a whole number';
    run.detail_version = v;
  }
  return run;
}

// ---------- reports ----------
const ICON = { fail: '❌', warn: '⚠️', ok: '✅', skipped: '⏭️' } as const;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const pagesOf = (f: Finding) => (f.count > 1 ? `${f.page || '(site)'} and ${f.count - 1} more` : f.page || '(site)');
const summaryIcon = (s: CheckSummary) => (s.status !== 'done' ? ICON.skipped : s.fail ? ICON.fail : s.warn ? ICON.warn : ICON.ok);

export type FailOn = 'fail' | 'warn' | 'never';
// Whether a run should fail the job that asked for it. A run that couldn't finish always does.
export function runFails(run: SiteCheckRun, failOn: FailOn): boolean {
  if (run.status !== 'done') return true;
  if (run.summaries.some((s) => s.status === 'error')) return true;
  if (failOn === 'never') return false;
  return run.counts.fail > 0 || (failOn === 'warn' && run.counts.warn > 0);
}

// The GitHub job summary.
export function runMarkdown(run: SiteCheckRun, portalPage?: string, maxPerCheck = 25): string {
  const out = [`## Site checks: ${run.site}`, ''];
  if (run.status !== 'done') out.push(`**The run did not finish (${run.status})${run.error ? `: ${run.error}` : ''}.**`, '');
  out.push(`${ICON.fail} **${run.counts.fail}** failing · ${ICON.warn} **${run.counts.warn}** worth a look, across ${run.pages} pages and ${run.games} games.${portalPage ? ` Everything: ${portalPage}` : ''}`, '');
  out.push('| | Check | Looked at | Failing | Worth a look | Time |', '|---|---|---|---|---|---|');
  for (const s of run.summaries) {
    out.push(`| ${summaryIcon(s)} | ${CHECK_LABEL[s.check]}${s.status !== 'done' ? ` (${s.status}: ${cell(s.note)})` : ''} | ${s.checked} | ${s.fail} | ${s.warn} | ${secs(s.ms)} |`);
  }
  for (const check of run.checks) {
    const mine = run.findings.filter((f) => f.check === check);
    if (!mine.length) continue;
    out.push('', `### ${CHECK_LABEL[check]}`, '', '| | Problem | What | Where |', '|---|---|---|---|');
    for (const f of mine.slice(0, maxPerCheck)) out.push(`| ${ICON[f.level]} | ${cell(f.message)} | ${cell(short(f.target, 100))} | ${cell(pagesOf(f))} |`);
    const u = run.summaries.find((s) => s.check === check)?.unlisted;
    const unlisted = u ? u.warn + u.fail : 0;
    if (mine.length > maxPerCheck) out.push('', `…and ${mine.length - maxPerCheck} more${portalPage ? ` in the portal` : ''}${unlisted ? ` (and ${unlisted} not listed)` : ''}.`);
    else if (unlisted) out.push('', `…and ${unlisted} more not listed.`);
  }
  return out.join('\n') + '\n';
}

// The tracking issue: what fails now, with a marker the workflow compares to notice when the set changes.
export function issueMarkdown(run: SiteCheckRun, portalPage?: string): string {
  const failing = run.findings.filter((f) => f.level === 'fail');
  const lines = [
    `These problems on ${run.site} fail the site checks. This issue is updated by each run and closed when nothing fails.`,
    '',
    `Last checked ${(run.finished_at ?? run.started_at).slice(0, 16).replace('T', ' ')} UTC${run.source ? ` ([run](${run.source}))` : ''}: ${run.counts.fail} failing, ${run.counts.warn} worth a look, across ${run.pages} pages and ${run.games} games.${portalPage ? ` Everything: ${portalPage}` : ''}`,
    '',
    '| Check | Problem | What | Where |', '|---|---|---|---|',
    ...failing.slice(0, 200).map((f) => `| ${CHECK_LABEL[f.check]} | ${cell(f.message)} | ${cell(short(f.target, 100))} | ${cell(pagesOf(f))} |`),
    ...(failing.length > 200 ? ['', `…and ${failing.length - 200} more.`] : []),
    '',
    `<!-- failing: ${fingerprint(failing)} -->`,
  ];
  return lines.join('\n') + '\n';
}

// A short stable name for a set of findings (which problems, not how they are worded).
export function fingerprint(findings: Finding[]): string {
  const keys = findings.map((f) => `${f.check}|${f.code}|${f.target}`).sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < keys.length; i++) { h ^= keys.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${findings.length}-${h.toString(16).padStart(8, '0')}`;
}

// ---------- the README's dashboard ----------
// Badges for the dashboard at the top of the README, in the shape shields.io's "endpoint" badge reads
// (https://shields.io/badges/endpoint-badge). The portal serves them from the latest run it was sent, publicly:
// they say how many problems each check found, never what they are.
export interface Badge { schemaVersion: 1; label: string; message: string; color: string; cacheSeconds: number }
const badge = (label: string, message: string, color: string): Badge => ({ schemaVersion: 1, label, message, color, cacheSeconds: 300 });
const tally = (fail: number, warn: number): [string, string] =>
  fail ? [`${fail} failing${warn ? ` · ${warn} to look at` : ''}`, 'red'] : warn ? [`${warn} to look at`, 'yellow'] : ['passing', 'brightgreen'];

// One check, from the most recent run that included it.
export function checkBadge(check: CheckName, summary: CheckSummary | undefined): Badge {
  const label = CHECK_LABEL[check].toLowerCase();
  if (!summary) return badge(label, 'no runs yet', 'lightgrey');
  if (summary.status !== 'done') return badge(label, summary.status === 'error' ? 'could not run' : 'did not run', 'lightgrey');
  return badge(label, ...tally(summary.fail, summary.warn));
}

// The latest run as a whole.
export function runBadge(run: SiteCheckRun | undefined): Badge {
  if (!run) return badge('site checks', 'no runs yet', 'lightgrey');
  if (run.status !== 'done') return badge('site checks', 'did not finish', 'orange');
  return badge('site checks', ...tally(run.counts.fail, run.counts.warn));
}

// When the latest run finished. A daily check that hasn't reported for two days is itself a problem.
export function whenBadge(run: SiteCheckRun | undefined, now = Date.now()): Badge {
  if (!run) return badge('last run', 'never', 'lightgrey');
  const at = Date.parse(run.finished_at);
  return badge('last run', `${run.finished_at.slice(0, 16).replace('T', ' ')} UTC`, now - at > 2 * 24 * 60 * 60 * 1000 ? 'orange' : 'blue');
}

// GitHub workflow commands: an ::error for each failure and a ::warning for each warning, up to GitHub's ten of
// each per step, with one line for the rest.
export function annotations(run: SiteCheckRun, max = 10): string[] {
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s: string) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const out: string[] = [];
  if (run.status !== 'done') out.push(`::error title=Site checks did not finish::${esc(run.error ?? run.status)}`);
  for (const s of run.summaries) if (s.status === 'error') out.push(`::error title=${prop(CHECK_LABEL[s.check])} could not run::${esc(s.note)}`);
  for (const [level, command] of [['fail', 'error'], ['warn', 'warning']] as const) {
    const mine = run.findings.filter((f) => f.level === level);
    const room = level === 'fail' ? max - out.length : max;
    const shown = mine.length > room ? Math.max(0, room - 1) : mine.length;
    for (const f of mine.slice(0, shown)) out.push(`::${command} title=${prop(`${CHECK_LABEL[f.check]}: ${pagesOf(f)}`)}::${esc(`${f.message} — ${f.target}`)}`);
    if (mine.length > shown) out.push(`::${command} title=${prop(`${mine.length - shown} more ${level === 'fail' ? 'failures' : 'warnings'}`)}::${esc('See the job summary or the portal for the full list.')}`);
  }
  return out;
}
