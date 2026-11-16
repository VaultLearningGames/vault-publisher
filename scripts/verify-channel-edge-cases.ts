// Analytics.4d: the two edge cases of the channel snippet, checked against what staging actually serves.
//
//   node scripts/verify-channel-edge-cases.ts \
//     [--portal https://portal.vaultlearninggames-staging.org] [--site https://vaultlearninggames-staging.org] \
//     [--cdn https://cdn.vaultlearninggames-staging.org] [--snippet src/cdn/vault-channel.js] \
//     [--release SHA] [--out report.md] [--json run.json] [--game SLUG] [--allow-any-host]
//
//   (a) a CDN game with NO analytics tag is loaded through the staging player, with and without ?vault_ch=pbswi,
//       and its console must be empty — no errors, no warnings, no "gtag is not defined";
//   (b) cdn/fieldday/jowilder/iframe.html's VAULT_CHANNEL_LOGIC block is diffed against the shared snippet
//       (src/cdn/vault-channel.js, by default as it is at origin/staging), and Jo Wilder is loaded through the player
//       both ways: 'pbswisconsineducation.org' with ?vault_ch=pbswi, 'vault' without, reported exactly once.
//
// Read-only, staging only (it refuses addresses without "staging" in the hostname unless --allow-any-host), and it
// patches nothing: src/channel-edge-cases.ts turns what was seen into blockers against the reconcile card, which
// owns the wrappers. Exits 0 when both cases pass, 1 when a blocker was found or the release gate failed,
// 2 on bad usage, 3 when there is no browser to observe with.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  edgeCaseMarkdown, runBlockers, runFails, type ConsoleLine, type EdgeCaseRun, type JoWilderResult, type NoTagGame,
  type SilentLoad,
} from '../src/channel-edge-cases.ts';
import {
  CHANNEL_PARAM, expectedChannel, isCollectUrl, channelInCollectUrl, channelInParams,
  type ChannelCall, type LoadResult,
} from '../src/channel-runtime.ts';

const { values: args } = parseArgs({
  options: {
    portal: { type: 'string' }, site: { type: 'string' }, cdn: { type: 'string' }, snippet: { type: 'string' },
    release: { type: 'string' }, out: { type: 'string' }, json: { type: 'string' }, game: { type: 'string' },
    'allow-any-host': { type: 'boolean' },
  },
});
const portal = (args.portal ?? 'https://portal.vaultlearninggames-staging.org').replace(/\/+$/, '');
const site = (args.site ?? 'https://vaultlearninggames-staging.org').replace(/\/+$/, '');
const cdn = (args.cdn ?? 'https://cdn.vaultlearninggames-staging.org').replace(/\/+$/, '');
const snippetPath = args.snippet ?? 'src/cdn/vault-channel.js';
const JOWILDER = 'fieldday/jowilder/iframe.html';
const LOAD_MS = 45_000;
const SETTLE_MS = 6000;

const isStaging = (u: string) => { try { return /staging/i.test(new URL(u).hostname); } catch { return false; } };
if (!args['allow-any-host'] && ![portal, site, cdn].every(isStaging)) {
  console.error('This check only ever runs against staging; pass --allow-any-host deliberately.');
  process.exit(2);
}

const say = (s = '') => console.log(s);

// ---------- the release gate ----------
// The staging release Analytics.4a cut, as far as this worktree can tell: the SHA given, else origin/staging's head.
// The deployed CDN carries no build stamp, so the artifacts cannot prove which SHA they came from; the report says so.
function releaseInfo(): { sha: string | null; how: string } {
  if (args.release) return { sha: args.release, how: 'given with --release' };
  try {
    const sha = execFileSync('git', ['rev-parse', 'origin/staging'], { encoding: 'utf8' }).trim();
    return { sha, how: 'origin/staging head (no release tag found; deploy SHA not verifiable from the artifact)' };
  } catch {
    return { sha: null, how: 'no origin/staging in this worktree' };
  }
}

// The shared snippet at the release's commit, else from the working tree.
function snippetSource(sha: string | null): { text: string | null; ref: string } {
  if (sha) {
    try {
      return { text: execFileSync('git', ['show', `${sha}:${snippetPath}`], { encoding: 'utf8' }), ref: `${snippetPath} at ${sha.slice(0, 12)}` };
    } catch { /* not in that commit: fall back to the working tree */ }
  }
  try {
    return { text: execFileSync('git', ['show', `HEAD:${snippetPath}`], { encoding: 'utf8' }), ref: `${snippetPath} at HEAD` };
  } catch {
    return { text: null, ref: `${snippetPath} (not found)` };
  }
}

// ---------- fetching ----------
async function get(url: string): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: `${(err as Error).message}` };
  }
}

// What an analytics tag looks like in a wrapper's HTML: a gtag/GTM include, the old analytics.js, or an id.
const TAG_SIGNS: [RegExp, string][] = [
  [/googletagmanager\.com\/gtag\/js/i, 'gtag.js include'],
  [/\bgtag\s*\(/, 'a gtag() call'],
  [/google-analytics\.com\/analytics\.js/i, 'analytics.js include'],
  [/\bga\s*\(\s*['"]create['"]/, "a ga('create') call"],
  [/\bUA-\d{4,}-\d+/, 'a UA- property id'],
  [/\bG-[A-Z0-9]{8,}\b/, 'a G- measurement id'],
  [/dataLayer\s*\.\s*push/, 'a dataLayer push'],
];
const tagsIn = (html: string) => TAG_SIGNS.filter(([re]) => re.test(html)).map(([, what]) => what);

interface CatalogGame {
  slug: string; title: string;
  play?: { url: string; source: string; embed: boolean } | null;
  page_address?: string | null;
}

// The staging player page for a catalog game: its page address, else its slug.
const playerUrl = (g: CatalogGame) => `${site}/${(g.page_address || g.slug).replace(/^\/+|\/+$/g, '')}/`;

// A CDN game whose wrapper layers carry no analytics tag at all: the first one found, in catalog order, so the
// choice is reproducible. Each candidate's index.html and iframe.html are both read (the tag may be in either).
async function findNoTagGame(games: CatalogGame[]): Promise<NoTagGame | null> {
  const cdnGames = games.filter((g) => g.play?.source === 'cdn' && g.play.url.startsWith(cdn));
  for (const g of cdnGames) {
    if (args.game && g.slug !== args.game) continue;
    const base = g.play!.url.replace(/\/*$/, '/');
    const index = await get(base);
    if (index.status !== 200) { say(`  ${g.slug}: wrapper answered ${index.status || 'nothing'} — skipped`); continue; }
    const inner = await get(`${base}iframe.html`);
    const found = [...tagsIn(index.text), ...(inner.status === 200 ? tagsIn(inner.text) : [])];
    if (found.length) { say(`  ${g.slug}: has ${[...new Set(found)].join(', ')} — not the no-tag game`); continue; }
    const where = inner.status === 200 ? 'index.html or iframe.html' : 'index.html (no iframe.html)';
    say(`  ${g.slug}: no analytics tag in ${where}`);
    return {
      slug: g.slug, title: g.title, cdnUrl: base, playerUrl: playerUrl(g),
      evidence: `no gtag.js/analytics.js include, no gtag()/ga('create') call and no UA-/G- id in ${where}`,
    };
  }
  return null;
}

// ---------- the browser ----------
// Every frame gets a gtag/ga/dataLayer that records instead of reporting, installed before the document's own
// scripts, so a call is captured whether or not a tag was ever loaded; GA collect hits are captured from the network
// as well, and answered 204 so staging's property records nothing.
const STUB = `(function () {
  var w = window; w.__vaultCalls = w.__vaultCalls || [];
  var note = function (via, args) { try { w.__vaultCalls.push({ via: via, args: Array.prototype.slice.call(args).map(function (a) {
    try { return typeof a === 'object' && a !== null ? JSON.parse(JSON.stringify(a)) : a; } catch (e) { return String(a); } }) }); } catch (e) {} };
  if (!w.gtag) w.gtag = function () { note('gtag', arguments); };
  if (!w.ga) { w.ga = function () { note('ga', arguments); }; w.ga.q = []; }
  w.dataLayer = w.dataLayer || [];
  var push = w.dataLayer.push.bind(w.dataLayer);
  w.dataLayer.push = function () { note('dataLayer', arguments); return push.apply(null, arguments); };
})();`;

type RawCall = { via: string; args: unknown[] };

// A recorded gtag/ga/dataLayer call read as a ChannelCall: gtag('event', NAME, PARAMS), ga('send', {...}).
function callOf(raw: RawCall, frameUrl: string): ChannelCall {
  const args = raw.args ?? [];
  const via: ChannelCall['via'] = raw.via === 'dataLayer' ? 'dataLayer' : 'gtag';
  let event: string | null = null;
  let params: Record<string, unknown> | null = null;
  for (const arg of args) {
    if (typeof arg === 'string' && !event && arg !== 'event' && arg !== 'send' && arg !== 'config' && arg !== 'js') event = arg;
    if (arg && typeof arg === 'object') {
      const obj = arg as Record<string, unknown>;
      params = { ...(params ?? {}), ...obj };
      if (!event && typeof obj.event === 'string') event = obj.event;
      if (!event && typeof obj.eventAction === 'string') event = obj.eventAction;
    }
  }
  return { via, event, channel: channelInParams(params), frameUrl };
}

interface Observation { console: ConsoleLine[]; calls: ChannelCall[]; error: string | null }

type Browser = Awaited<ReturnType<typeof launch>>;
// Headless Chromium. Playwright's default headless build is the separate chrome-headless-shell download, which a
// machine with only the full chromium installed doesn't have; the 'chromium' channel is that full build, so the
// check runs with either.
async function launch() {
  const { chromium } = await import('playwright');
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (err) {
    if (!/Executable doesn't exist/i.test((err as Error).message)) throw err;
    return await chromium.launch({ headless: true, channel: 'chromium', args });
  }
}

// One load: everything printed in any frame, and every analytics call made in any frame or over the network.
async function observe(browser: Browser, url: string): Promise<Observation> {
  const lines: ConsoleLine[] = [];
  const calls: ChannelCall[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  try {
    await ctx.addInitScript(STUB);
    // GA hits are answered empty: the channel is read off the request, and staging's property records no visit.
    await ctx.route(/\/(?:[a-z]\/|mp\/)?collect\b/i, async (route) => {
      const u = route.request().url();
      if (isCollectUrl(u)) calls.push({ via: 'collect', event: new URL(u).searchParams.get('en'), channel: channelInCollectUrl(u), frameUrl: route.request().frame()?.url() ?? '' });
      await route.fulfill({ status: 204, body: '' }).catch(() => {});
    });
    const page = await ctx.newPage();
    page.on('console', (msg) => lines.push({ type: msg.type(), text: msg.text(), frameUrl: (() => { try { return msg.location().url; } catch { return ''; } })() }));
    page.on('pageerror', (err) => lines.push({ type: 'pageerror', text: err.message, frameUrl: page.url() }));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: LOAD_MS });
    } catch (err) {
      return { console: lines, calls, error: (err as Error).message.split('\n')[0] };
    }
    // A click starts the click-to-play wrappers; the player's Play button is clicked when it is there.
    for (const name of ['Play', 'play']) {
      const button = page.locator(`a:has-text("${name}"), button:has-text("${name}")`).first();
      if (await button.count().then((n) => n > 0).catch(() => false)) {
        await button.click({ timeout: 4000 }).catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(SETTLE_MS);
    for (const frame of page.frames()) {
      const raw = await frame.evaluate(() => (window as unknown as { __vaultCalls?: RawCall[] }).__vaultCalls ?? []).catch(() => [] as RawCall[]);
      for (const call of raw as RawCall[]) calls.push(callOf(call, frame.url()));
    }
    return { console: lines, calls, error: null };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const silentLoad = async (browser: Browser, url: string): Promise<SilentLoad> => {
  const seen = await observe(browser, url);
  return { url, console: seen.console, calls: seen.calls, error: seen.error };
};

const channelLoad = async (browser: Browser, url: string): Promise<LoadResult> => {
  const seen = await observe(browser, url);
  return { url, expected: expectedChannel(url), calls: seen.calls, method: 'stubbed gtag/ga/dataLayer + GA collect requests', error: seen.error };
};

// ---------- the run ----------
const withParam = (url: string, value: string) => { const u = new URL(url); u.searchParams.set(CHANNEL_PARAM, value); return u.toString(); };

async function main(): Promise<number> {
  const release = releaseInfo();
  const snippet = snippetSource(release.sha);
  say(`Release: ${release.sha ?? 'none'} (${release.how})`);

  const run: EdgeCaseRun = {
    site, cdn, at: new Date().toISOString(), release,
    gate: release.sha ? null : `No staging release could be identified in this worktree: ${release.how}.`,
    noTag: null, jowilder: null,
  };

  if (!run.gate) {
    say('\nThe CDN catalog:');
    const catalog = await get(`${portal}/v1/catalog`);
    let games: CatalogGame[] = [];
    try { games = (JSON.parse(catalog.text) as { games: CatalogGame[] }).games ?? []; }
    catch { run.gate = `The staging portal's catalog could not be read (${portal}/v1/catalog answered ${catalog.status || 'nothing'}).`; }

    if (!run.gate) {
      const noTagGame = await findNoTagGame(games);
      const jwDeployed = await get(`${cdn}/${JOWILDER}`);
      const { compareBlocks } = await import('../src/channel-edge-cases.ts');
      const diff = compareBlocks(jwDeployed.status === 200 ? jwDeployed.text : null, snippet.text, `${cdn}/${JOWILDER}`, snippetPath);
      const jw = games.find((g) => g.play?.source === 'cdn' && /\/jowilder\/?$/.test(g.play.url.replace(/\/+$/, '/').slice(0, -1) + '/'))
        ?? games.find((g) => g.play?.source === 'cdn' && g.play.url.includes('/jowilder/'));
      say(`\nJo Wilder's marker block: ${diff.verdict} — ${diff.reason}`);

      let browser: Browser | null = null;
      try { browser = await launch(); }
      catch (err) { say(`No browser: ${(err as Error).message.split('\n')[0]}`); }

      const noBrowser = 'no browser: run `npx playwright install chromium`';
      if (noTagGame) {
        const urls = [noTagGame.playerUrl, withParam(noTagGame.playerUrl, 'pbswi')];
        run.noTag = {
          game: noTagGame,
          loads: browser
            ? await (async () => { const out: SilentLoad[] = []; for (const u of urls) { say(`  loading ${u}`); out.push(await silentLoad(browser!, u)); } return out; })()
            : urls.map((url) => ({ url, console: [], calls: [], error: noBrowser })),
        };
      }

      const jwPlayer = jw ? playerUrl(jw) : null;
      const jwResult: JoWilderResult = {
        url: `${cdn}/${JOWILDER}`, snippetRef: snippet.ref, diff, playerUrl: jwPlayer,
        partner: null, noParam: null,
      };
      if (jwPlayer) {
        const partnerUrl = withParam(jwPlayer, 'pbswi');
        if (browser) {
          say(`  loading ${partnerUrl}`);
          jwResult.partner = await channelLoad(browser, partnerUrl);
          say(`  loading ${jwPlayer}`);
          jwResult.noParam = await channelLoad(browser, jwPlayer);
        } else {
          jwResult.partner = { url: partnerUrl, expected: expectedChannel(partnerUrl), calls: [], method: '—', error: noBrowser };
          jwResult.noParam = { url: jwPlayer, expected: expectedChannel(jwPlayer), calls: [], method: '—', error: noBrowser };
        }
      }
      run.jowilder = jwResult;
      await browser?.close().catch(() => {});
      if (!browser && !args.out && !args.json) { say('\nNothing could be observed without a browser.'); }
    }
  }

  const markdown = edgeCaseMarkdown(run);
  say(`\n${markdown}`);
  if (args.out) writeFileSync(args.out, markdown);
  if (args.json) writeFileSync(args.json, `${JSON.stringify(run, null, 2)}\n`);
  const blockers = runBlockers(run);
  if (blockers.length) say(`${blockers.length} blocker(s) — named above, not patched here.`);
  return runFails(run) ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(3); });
