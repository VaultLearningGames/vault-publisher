// The site checks engine against a tiny fixture site on 127.0.0.1 (and a second server playing the game host),
// in a real headless Chromium. Skipped when Chromium isn't installed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { deflateSync, crc32 } from 'node:zlib';
import { parseSitemap } from '../src/site-checks/discover.ts';
import { runSiteChecks } from '../src/site-checks/run.ts';
import { isFlat, isPageUrl, normalisePath, oembedUrl, pagePathOf, youtubeWatchUrl } from '../src/site-checks/util.ts';
import type { Finding, Service, SiteCheckRun } from '../src/site-checks.ts';

// ---------- pure helpers ----------
describe('site-checks helpers', () => {
  test('page paths are normalised', () => {
    assert.equal(normalisePath('/wake'), '/wake/');
    assert.equal(normalisePath('/wake/?x=1#top'), '/wake/');
    assert.equal(normalisePath('/a/index.html'), '/a/');
    assert.equal(normalisePath('/files/a.pdf'), '/files/a.pdf');
    assert.equal(normalisePath(''), '/');
  });
  test('page-like addresses', () => {
    assert.equal(isPageUrl(new URL('https://x.org/wake/')), true);
    assert.equal(isPageUrl(new URL('https://x.org/a.html')), true);
    assert.equal(isPageUrl(new URL('https://x.org/a.pdf')), false);
    assert.equal(isPageUrl(new URL('https://x.org/a/?page=2')), false);
    assert.equal(pagePathOf('/wake#x', 'https://x.org'), '/wake/');
    assert.equal(pagePathOf('https://other.org/wake/', 'https://x.org'), null);
  });
  test('YouTube addresses map to oEmbed', () => {
    const watch = 'https://www.youtube.com/watch?v=abcdefghijk';
    assert.equal(youtubeWatchUrl('https://www.youtube.com/watch?v=abcdefghijk&t=3'), watch);
    assert.equal(youtubeWatchUrl('https://youtu.be/abcdefghijk?si=1'), watch);
    assert.equal(youtubeWatchUrl('https://www.youtube.com/embed/abcdefghijk'), watch);
    assert.equal(youtubeWatchUrl('https://www.youtube-nocookie.com/embed/abcdefghijk?rel=0'), watch);
    assert.equal(youtubeWatchUrl('https://www.youtube.com/embed/videoseries?list=PL1'), null);
    assert.equal(youtubeWatchUrl('https://www.youtube.com/@channel'), null);
    assert.equal(youtubeWatchUrl('https://example.com/watch?v=abcdefghijk'), null);
    assert.equal(oembedUrl(watch), `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`);
  });
  test('flat pixel samples', () => {
    const flat: number[] = new Array(64 * 64 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 10));
    assert.equal(isFlat(flat), true);
    const some = flat.slice();
    for (let i = 0; i < 200; i++) { some[i * 4] = 255; some[i * 4 + 1] = 200; }   // 200 of 4096 pixels differ
    assert.equal(isFlat(some), false);
    const few = flat.slice();
    for (let i = 0; i < 10; i++) { few[i * 4] = 255; few[i * 4 + 1] = 200; }      // 10 of 4096: under half a percent
    assert.equal(isFlat(few), true);
    assert.equal(isFlat([]), false);
  });
  test('sitemaps and sitemap indexes', () => {
    assert.deepEqual(parseSitemap('<urlset><url><loc>https://x.org/a/?b=1&amp;c=2</loc></url><url><loc> https://x.org/b/ </loc></url></urlset>'),
      { index: false, urls: ['https://x.org/a/?b=1&c=2', 'https://x.org/b/'] });
    assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://x.org/s1.xml</loc></sitemap></sitemapindex>').index, true);
  });
});

// ---------- the fixture site ----------
let chromium = false;
try {
  const pw = await import('playwright');
  const b = await pw.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  await b.close();
  chromium = true;
} catch { /* skipped below */ }

const FIXTURES = new URL('./fixtures/site-checks/', import.meta.url);
const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};
// A real PNG of random noise (it doesn't compress): about 720 KB.
function bigPng(): Buffer {
  const w = 600, h = 400, rows: Buffer[] = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w * 3 }, () => Math.floor(Math.random() * 256)))]));
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

// ---------- game services ----------
// Plain HTTP, no browser: runs everywhere. The site itself isn't asked for when only this check runs.
describe('the services check', () => {
  let server: http.Server, base = '';
  const asked: string[] = [];
  before(async () => {
    server = http.createServer((req, res) => {
      asked.push(req.url ?? '');
      if (req.url === '/player/') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"val": ["MeltedHit"], "status": "SUCCESS"}'); return; }
      if (req.url === '/log.php') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('No session_id'); return; }
      if (req.url === '/broken/') { res.writeHead(500); res.end('Internal Server Error'); return; }
      res.writeHead(404); res.end('no');
    });
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => { server.close(); });

  test('each service is asked once; what is wrong is a finding; no site, no browser', async () => {
    const services: Service[] = [
      { name: 'Player codes', url: `${base}/player/`, expect: /"status"\s*:\s*"SUCCESS"/, expected: 'a player code' },
      { name: 'Logger', url: `${base}/log.php`, expect: /No session_id/, expected: '"No session_id"' },
      { name: 'Broken', url: `${base}/broken/`, expect: /ok/, expected: 'ok' },
      { name: 'Gone', url: 'http://127.0.0.1:1/', expect: /ok/, expected: 'ok' },
    ];
    // Port 1 on 127.0.0.1: nothing answers, so a run that asked the site first would have stopped.
    const run = await runSiteChecks({ site: 'http://127.0.0.1:1', checks: ['services'], services, guard: false });
    assert.equal(run.status, 'done');
    assert.equal(run.error, null);
    assert.deepEqual(run.checks, ['services']);
    assert.deepEqual(run.summaries.map((s) => [s.check, s.status, s.checked, s.fail, s.warn]), [['services', 'done', 4, 2, 0]]);
    assert.deepEqual(run.findings.map((f) => `${f.code} ${f.target}`).sort(), [`service.down ${base}/broken/`, 'service.down http://127.0.0.1:1/'].sort());
    assert.deepEqual(asked, ['/player/', '/log.php', '/broken/']);   // an answer, even a 500, is never asked again
    assert.equal(run.pages, 0);
  });
});

describe('site checks engine', { skip: chromium ? false : 'Chromium is not installed (npx playwright install chromium-headless-shell)' }, () => {
  let site: http.Server, games: http.Server, origin = '', gamePort = 0;
  let run: SiteCheckRun;
  const png = bigPng();

  before(async () => {
    games = http.createServer((req, res) => {
      const path = req.url?.split('?')[0];
      const canvasPage = '<!doctype html><title>g</title><body style="margin:0"><canvas id=c width=400 height=300 style="width:100%;height:100vh"></canvas><script>var c=document.getElementById("c").getContext("2d");for(var i=0;i<12;i++){c.fillStyle="hsl("+i*30+",80%,50%)";c.fillRect(i*30,i*20,60,60)}</script></body>';
      if (path === '/denied/') { res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' }); res.end(canvasPage); return; }
      if (path === '/game/' || path === '/tab/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(canvasPage); return; }
      res.writeHead(404); res.end('no');
    });
    gamePort = await listen(games);
    site = http.createServer(async (req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/img/bad.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('this is not a png'); return; }
      if (path === '/img/big.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
      let file = path === '/' ? 'index.html' : path.endsWith('/') ? `${path.slice(1)}index.html` : path.slice(1);
      if (!/^[\w./-]+$/.test(file) || file.includes('..')) file = '';
      try {
        const body = (await readFile(new URL(file, FIXTURES), 'utf8')).replaceAll('{{GAME}}', String(gamePort)).replaceAll('{{SITE}}', origin);
        const type = file.endsWith('.xml') ? 'application/xml' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
        res.writeHead(200, { 'content-type': type }); res.end(body);
      } catch { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not found</h1>'); }
    });
    origin = `http://127.0.0.1:${await listen(site)}`;
    run = await runSiteChecks({ site: origin, checks: ['games', 'assets', 'links', 'spelling', 'performance', 'responsive'], concurrency: 2, guard: false });
    if (process.env.SITE_CHECKS_DEBUG) console.log(JSON.stringify(run, null, 1));
  });
  after(() => { site?.close(); games?.close(); site?.closeAllConnections(); games?.closeAllConnections(); });

  const has = (check: string, code: string, pred: (f: SiteCheckRun['findings'][number]) => boolean = () => true) =>
    run.findings.some((f) => f.check === check && f.code === code && pred(f));

  test('the run finishes with a summary for every check', () => {
    assert.equal(run.status, 'done', run.error ?? '');
    assert.deepEqual(run.summaries.map((s) => [s.check, s.status]), [['games', 'done'], ['assets', 'done'], ['links', 'done'], ['spelling', 'done'], ['performance', 'done'], ['responsive', 'done']]);
    assert.equal(run.pages, 10);                    // home, 7 pages, /ghost/ from the sitemap and /nope/ from a link (both 404)
    assert.ok(run.summaries.find((s) => s.check === 'responsive')!.checked >= 4 * 8);
  });

  test('assets: a missing stylesheet, a broken image and a page that is gone', () => {
    assert.ok(has('assets', 'asset.missing', (f) => f.target.endsWith('/css/missing.css') && f.page === '/broken/' && f.level === 'fail'));
    assert.ok(has('assets', 'asset.missing', (f) => f.target.endsWith('/img/missing.png') && f.page === '/broken/'));
    assert.ok(has('assets', 'asset.broken-image', (f) => f.target.endsWith('/img/bad.png') && f.page === '/broken/'));   // arrives, but isn't a picture
    assert.ok(has('assets', 'page.failed', (f) => f.page === '/ghost/'));
  });

  test('links: a missing page, a missing anchor, a sitemap entry that is gone', () => {
    assert.ok(has('links', 'link.broken', (f) => f.target.endsWith('/nope/') && f.page === '/broken/'));
    assert.ok(has('links', 'link.missing-anchor', (f) => f.target.endsWith('/#nowhere') && f.page === '/broken/'));
    assert.ok(has('links', 'link.broken', (f) => f.target.endsWith('/ghost/') && f.page === ''));
    assert.ok(!has('links', 'link.missing-anchor', (f) => f.target.endsWith('/spelling/#here')));
    assert.ok(!has('links', 'link.broken', (f) => f.target.endsWith('/tab/')));   // found by following links, not the sitemap
  });

  test('spelling: the misspelled word, not the correct ones', () => {
    assert.ok(has('spelling', 'spelling.unknown', (f) => f.target === 'sceince' && f.page === '/spelling/'));
    assert.ok(!has('spelling', 'spelling.unknown', (f) => ['sentence', 'written', 'correctly', 'learning'].includes(f.target)));
  });

  test('responsive: sideways scrolling and small text at phone width', () => {
    assert.ok(has('responsive', 'responsive.overflow', (f) => f.page === '/narrow/' && f.target.startsWith('phone') && f.target.includes('div.wide')));
    assert.ok(has('responsive', 'responsive.small-text', (f) => f.page === '/narrow/' && f.target.includes('p.tiny')));
    assert.ok(has('responsive', 'responsive.small-target', (f) => f.page === '/narrow/' && f.target.includes('a.mini')));
    assert.ok(!has('responsive', 'responsive.overflow', (f) => f.page === '/spelling/'));
  });

  test('performance: the large image', () => {
    assert.ok(has('performance', 'perf.large-file', (f) => f.target.endsWith('/img/big.png') && f.page === '/big/'));
    assert.ok(has('performance', 'perf.oversized-image', (f) => f.target.endsWith('/img/big.png')));
  });

  test('games: one opens in the player, one refuses framing, one opens in a new tab', () => {
    assert.equal(run.games, 3);                     // the player opened for /game/ and /noframe/ (empty), and /tab/ in its own tab
    assert.ok(has('games', 'game.failed', (f) => f.page === '/noframe/' && /refused to be shown/.test(f.message)));
    assert.ok(!run.findings.some((f) => f.check === 'games' && (f.page === '/game/' || f.page === '/tab/')), JSON.stringify(run.findings.filter((f) => f.check === 'games')));
    assert.equal(run.summaries.find((s) => s.check === 'games')!.checked, 3);
  });

  test('every finding keeps the details the portal’s tables show', () => {
    assert.equal(run.detail_version, 2);
    const find = (check: string, code: string, pred: (f: Finding) => boolean) => run.findings.find((f) => f.check === check && f.code === code && pred(f));
    const css = find('assets', 'asset.missing', (f) => f.target.endsWith('/css/missing.css'))!;
    assert.deepEqual([css.detail?.status, css.detail?.type, css.detail?.element], [404, 'stylesheet', 'link rel=stylesheet']);
    assert.deepEqual(css.pages, ['/broken/']);
    const png = find('assets', 'asset.missing', (f) => f.target.endsWith('/img/missing.png'))!;
    assert.deepEqual([png.detail?.status, png.detail?.element], [404, 'img']);
    assert.equal(find('assets', 'asset.broken-image', (f) => f.target.endsWith('/img/bad.png'))!.detail?.element, 'img');
    assert.equal(find('assets', 'page.failed', (f) => f.page === '/ghost/')!.detail?.status, 404);
    const nope = find('links', 'link.broken', (f) => f.target.endsWith('/nope/'))!;
    assert.deepEqual([nope.detail?.status, nope.detail?.kind, nope.detail?.text], [404, 'link', 'A page that is gone']);
    assert.equal(find('links', 'link.missing-anchor', (f) => f.target.endsWith('/#nowhere'))!.detail?.text, 'an anchor that is not there');
    const game = find('games', 'game.failed', (f) => f.page === '/noframe/')!;
    assert.deepEqual([game.detail?.game, game.detail?.embed], ['Fixture No Frame', true]);
    assert.match(String(game.detail?.error), /refused to be shown/);
    assert.match(String(find('spelling', 'spelling.unknown', (f) => f.target === 'sceince')!.detail?.context), /sceince/);
    const wide = find('responsive', 'responsive.overflow', (f) => f.page === '/narrow/' && f.target.startsWith('phone'))!;
    assert.deepEqual([wide.detail?.viewport, wide.detail?.width, wide.detail?.selector], ['phone', 360, 'div.wide']);
    assert.equal(find('responsive', 'responsive.small-text', (f) => f.page === '/narrow/')!.detail?.selector, 'p.tiny');
    const big = find('performance', 'perf.large-file', (f) => f.target.endsWith('/img/big.png'))!;
    assert.equal(big.detail?.element, 'img');
    assert.ok(Number(big.detail?.bytes) > 500_000);
  });

  test('only the requested checks run, on the requested paths', async () => {
    const quick = await runSiteChecks({ site: origin, checks: ['links'], paths: ['/broken/'], guard: false });
    assert.equal(quick.status, 'done');
    assert.equal(quick.pages, 1);
    assert.equal(quick.games, 0);
    assert.deepEqual(quick.summaries.map((s) => s.check), ['links']);
    assert.ok(quick.findings.some((f) => f.code === 'link.broken' && f.target.endsWith('/nope/')));
  });

  test('a site that cannot be reached is a run error, and a cancelled run says so', async () => {
    const down = await runSiteChecks({ site: 'http://127.0.0.1:9', checks: ['assets'], guard: false });
    assert.equal(down.status, 'error');
    assert.match(down.error ?? '', /couldn't be reached/);
    const ctl = new AbortController();
    ctl.abort();
    const stopped = await runSiteChecks({ site: origin, checks: ['assets'], guard: false, signal: ctl.signal });
    assert.equal(stopped.status, 'error');
    assert.equal(stopped.error, 'cancelled');
  });

  test('the guard keeps the browser and the probes off loopback addresses', async () => {
    const guarded = await runSiteChecks({ site: origin, checks: ['assets'], guard: true });
    assert.equal(guarded.status, 'error');
    assert.match(guarded.error ?? '', /couldn't be reached/);
  });
});
