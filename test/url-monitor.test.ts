// URL monitors: finding a hosted game's files, copying them into a test build, and noticing changes.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { Db } from '../src/db.ts';
import { BlockedUrlError, type Fetcher } from '../src/net-guard.ts';
import {
  checkMonitor, checkMonitors, cssRefs, fileListUrl, findFiles, gameFolderUrl, htmlRefs, monitorById, monitoredBuilds, MONITOR_LIMITS,
  parseFileList, pathInside, saveMonitor, type UrlMonitorRow,
} from '../src/url-monitor.ts';
import { FakeStorage } from './portal-harness.ts';

// A pretend web site: path → body (and optional headers / status). Answers 304 to a matching If-None-Match.
type Page = string | Buffer | { body?: string | Buffer; status?: number; headers?: Record<string, string>; noLength?: boolean; redirect?: string };
class Site {
  pages = new Map<string, Page>();
  requests: { url: string; headers: Record<string, string> }[] = [];
  etags = true;
  set(files: Record<string, Page>) { for (const [k, v] of Object.entries(files)) this.pages.set(k, v); return this; }
  fetcher: Fetcher = async (url, opts = {}) => {
    this.requests.push({ url, headers: opts.headers ?? {} });
    const u = new URL(url);
    if (opts.origin && u.origin !== opts.origin) throw new BlockedUrlError(`${url} redirects to another site (${u.origin}).`);
    const page = this.pages.get(decodeURIComponent(u.pathname.endsWith('/') ? `${u.pathname}index.html` : u.pathname));
    const p = typeof page === 'string' || Buffer.isBuffer(page) ? { body: page } : page;
    if (!p) return { url, status: 404, headers: {}, body: Readable.from([]) };
    if (p.redirect) throw new BlockedUrlError(`${url} redirects to another site (${new URL(p.redirect).origin}).`);
    const body = Buffer.from(p.body ?? '');
    const etag = `"${createHash('md5').update(body).digest('hex')}"`;
    const headers: Record<string, string> = { ...(this.etags ? { etag } : {}), ...(p.noLength ? {} : { 'content-length': String(body.length) }), ...p.headers };
    if (this.etags && opts.headers?.['If-None-Match'] === etag) return { url, status: 304, headers, body: Readable.from([]) };
    return { url, status: p.status ?? 200, headers, body: Readable.from([body]) };
  };
  gets(path: string) { return this.requests.filter((r) => new URL(r.url).pathname === path).length; }
}

let db: Db, staging: FakeStorage, site: Site, monitor: UrlMonitorRow;
const BASE = 'https://games.example.org/tide/';
const PREFIX = 'fieldday/tide/web-copy/';
const stored = () => [...staging.objects.keys()].sort();
const text = (key: string) => Buffer.from(staging.data.get(key)!).toString();
const check = async () => { const r = await checkMonitor({ db, staging, fetcher: site.fetcher }, monitorById(db, monitor.id)!); monitor = monitorById(db, monitor.id)!; return r; };

function setup(filesFrom: 'list' | 'crawl') {
  db = new Db(':memory:');
  db.syncStudios([{ slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' }]);
  const game = db.createGame(db.studioBySlug('fieldday')!.id, 'tide', '', 'vault:fieldday/tide');
  staging = new FakeStorage();
  site = new Site();
  monitor = saveMonitor(db, { game_id: game.id, url: BASE, files_from: filesFrom, list_url: filesFrom === 'list' ? `${BASE}files.txt` : null, by: 'user:mia' });
  return game;
}

describe('addresses', () => {
  test('the game’s folder, however it was typed', () => {
    assert.equal(gameFolderUrl('https://games.example.org/tide').href, BASE);
    assert.equal(gameFolderUrl(' https://games.example.org/tide/index.html?x=1#top ').href, BASE);
    assert.equal(gameFolderUrl('https://games.example.org').href, 'https://games.example.org/');
    assert.throws(() => gameFolderUrl('https://games.example.org/tide/game.zip'), /folder/);
    assert.throws(() => gameFolderUrl('games.example.org/tide'), /full web address/);
    assert.throws(() => gameFolderUrl(''), /Enter the web address/);
  });
  test('private and non-web addresses are refused before anything is fetched', () => {
    for (const bad of ['http://localhost:8080/game/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/', 'http://10.0.0.4/game/', 'http://[::1]/', 'ftp://example.org/game/', 'file:///etc/', 'https://me:pw@example.org/game/', 'http://intranet/game/']) {
      assert.throws(() => gameFolderUrl(bad), BlockedUrlError, bad);
    }
  });
  test('the file list must be on the game’s own site', () => {
    const base = new URL(BASE);
    assert.equal(fileListUrl('files.txt', base).href, `${BASE}files.txt`);
    assert.equal(fileListUrl('https://games.example.org/lists/tide.json', base).href, 'https://games.example.org/lists/tide.json');
    assert.throws(() => fileListUrl('https://elsewhere.example.com/files.txt', base), /same site/);
    assert.throws(() => fileListUrl('http://169.254.169.254/files.txt', base), BlockedUrlError);
    assert.throws(() => fileListUrl('', base), /file list/);
  });
  test('links and list entries only count inside the game’s folder', () => {
    const base = new URL(BASE);
    assert.equal(pathInside(base, 'Build/game.wasm'), 'Build/game.wasm');
    assert.equal(pathInside(base, './style.css?v=3#x'), 'style.css');
    assert.equal(pathInside(base, 'My%20Level.json'), 'My Level.json');
    assert.equal(pathInside(base, '/tide/img/a.png'), 'img/a.png');
    assert.equal(pathInside(base, 'https://games.example.org/tide/levels/'), 'levels/index.html');
    assert.equal(pathInside(base, '../a.png', new URL(`${BASE}css/site.css`)), 'a.png');
    for (const out of ['../other/a.png', '/etc/passwd', 'https://cdn.example.com/lib.js', '//cdn.example.com/lib.js', 'http://games.example.org/tide/a.js', 'data:image/png;base64,AAAA',
      'javascript:void(0)', 'mailto:a@b.c', 'a/..%2f..%2f..%2fsecret', '%2e%2e/%2e%2e/secret', 'bad%zz']) {
      assert.equal(pathInside(base, out), null, out);
    }
  });
});

describe('finding the files', () => {
  test('a file list as text or JSON', () => {
    assert.deepEqual(parseFileList('# my game\nindex.html\n\n  Build/game.wasm  \r\nBuild/game.data\n'), ['index.html', 'Build/game.wasm', 'Build/game.data']);
    assert.deepEqual(parseFileList('["index.html", "a.js"]'), ['index.html', 'a.js']);
    assert.deepEqual(parseFileList('{ "files": [{ "path": "index.html" }, { "url": "a.js" }] }'), ['index.html', 'a.js']);
    assert.throws(() => parseFileList('[1, 2]'), /must be a path/);
    assert.throws(() => parseFileList('{ "nope": 1 }'), /array of paths/);
    assert.throws(() => parseFileList('<!doctype html><html>'), /web page/);
  });

  test('links in HTML and CSS', () => {
    assert.deepEqual(htmlRefs(`<link rel=stylesheet href="css/site.css"><script src='game.js'></script><img src=logo.png srcset="a.png 1x, b.png 2x">
      <video poster="p.jpg"><source src="v.mp4"></video><a href="credits.html?x=1&amp;y=2">Credits</a><div style="background:url('bg.png')"></div>
      <style>@import "more.css"; .x { background: url(tile.gif) }</style><!-- <script src="old.js"></script> -->`),
      ['css/site.css', 'game.js', 'logo.png', 'p.jpg', 'v.mp4', 'credits.html?x=1&y=2', 'a.png', 'b.png', 'bg.png', 'more.css', 'tile.gif']);
    assert.deepEqual(cssRefs(`@import 'base.css'; a { background: url( "x.png" ) } @font-face { src: url(f.woff2) format("woff2") }`), ['base.css', 'x.png', 'f.woff2']);
  });

  test('following links from index.html: pages and style sheets are read, other sites and folders are left alone', async () => {
    setup('crawl');
    site.set({
      '/tide/index.html': '<link href="css/site.css" rel="stylesheet"><script src="game.js"></script><script src="https://cdn.example.com/lib.js"></script><a href="credits.html">c</a><a href="../other/">o</a><img src="missing.png">',
      '/tide/css/site.css': 'body { background: url(../img/bg.png) } @import "extra.css";',
      '/tide/css/extra.css': '.a { background: url(/tide/img/tile.png) }',
      '/tide/credits.html': '<a href="index.html">back</a><img src="img/team.jpg">',
      '/tide/game.js': 'fetch("levels/1.json")', // loaded by code: can't be found
    });
    const { paths } = await findFiles({ fetcher: site.fetcher }, monitor);
    assert.deepEqual(paths, ['credits.html', 'css/extra.css', 'css/site.css', 'game.js', 'img/bg.png', 'img/team.jpg', 'img/tile.png', 'index.html', 'missing.png']);
    assert.equal(site.gets('/tide/game.js'), 0); // scripts aren't read for links
  });

  test('a file list that names something outside the game’s folder is refused', async () => {
    setup('list');
    for (const bad of ['../secret.txt', '/etc/passwd', 'https://elsewhere.example.com/a.js']) {
      site.set({ '/tide/files.txt': `index.html\n${bad}\n` });
      await assert.rejects(findFiles({ fetcher: site.fetcher }, monitor), /isn’t a file inside/, bad);
    }
    site.set({ '/tide/files.txt': Array.from({ length: MONITOR_LIMITS.files + 1 }, (_, i) => `f${i}.js`).join('\n') });
    await assert.rejects(findFiles({ fetcher: site.fetcher }, monitor), /more than 2000 files/);
  });
});

describe('copying a monitored game', () => {
  beforeEach(() => {
    setup('list');
    site.set({ '/tide/files.txt': 'index.html\nBuild/game.js\nBuild/game.wasm.br\n', '/tide/index.html': '<h1>v1</h1>', '/tide/Build/game.js': 'js v1',
      '/tide/Build/game.wasm.br': { body: Buffer.from([1, 2, 3, 4]), headers: { 'content-encoding': 'br' } } });
  });

  test('the first check copies everything into a test build', async () => {
    const r = await check();
    assert.equal(r.status, 'changed');
    assert.match(r.message, /Copied 3 files/);
    assert.deepEqual(stored(), [`${PREFIX}Build/game.js`, `${PREFIX}Build/game.wasm.br`, `${PREFIX}index.html`]);
    assert.equal(text(`${PREFIX}index.html`), '<h1>v1</h1>');
    assert.deepEqual([...staging.data.get(`${PREFIX}Build/game.wasm.br`)!], [1, 2, 3, 4]); // precompressed files are kept as they are
    assert.equal(staging.headers.get(`${PREFIX}Build/game.wasm.br`)!.contentEncoding, 'br');
    assert.equal(staging.headers.get(`${PREFIX}index.html`)!.cacheControl, 'no-cache');
    const build = db.build(monitor.game_id, 'web-copy')!;
    assert.deepEqual([build.status, build.ref_type, build.file_count, build.total_bytes, build.actor], ['live', 'branch', 3, 20, 'url-monitor']);
    assert.match(build.commit_sha, /^url:[0-9a-f]{16}$/);
    assert.equal(monitor.last_status, 'changed');
    assert.ok(monitor.last_changed_at);
    assert.equal(db.recentAudit(1)[0].action, 'preview.publish');
  });

  test('an unchanged game isn’t downloaded again (ETag), and nothing is written', async () => {
    await check();
    const puts = staging.puts, changedAt = monitor.last_changed_at;
    site.requests = [];
    const r = await check();
    assert.equal(r.status, 'unchanged');
    assert.match(r.message, /No changes \(3 files checked\)/);
    assert.equal(staging.puts, puts);
    assert.equal(monitor.last_changed_at, changedAt);
    assert.equal(site.requests.filter((q) => q.headers['If-None-Match']).length, 3);
  });

  test('without ETags it compares contents, and still writes nothing when they’re the same', async () => {
    site.etags = false;
    await check();
    const before = new Map(staging.data);
    assert.equal((await check()).status, 'unchanged');
    assert.deepEqual(stored().filter((k) => k.includes('~incoming')), []);
    assert.deepEqual(new Map(staging.data).get(`${PREFIX}index.html`), before.get(`${PREFIX}index.html`));
  });

  test('a changed file, a new file and a removed file update the test build', async () => {
    await check();
    const first = db.build(monitor.game_id, 'web-copy')!.commit_sha;
    site.set({ '/tide/files.txt': 'index.html\nBuild/game.wasm.br\nlevels/1.json\n', '/tide/index.html': '<h1>v2</h1>', '/tide/levels/1.json': '{}' });
    const r = await check();
    assert.equal(r.status, 'changed');
    assert.deepEqual([r.changed, r.removed, r.files], [2, 1, 3]);
    assert.deepEqual(stored(), [`${PREFIX}Build/game.wasm.br`, `${PREFIX}index.html`, `${PREFIX}levels/1.json`]);
    assert.equal(text(`${PREFIX}index.html`), '<h1>v2</h1>');
    assert.notEqual(db.build(monitor.game_id, 'web-copy')!.commit_sha, first);
    assert.equal(site.gets('/tide/Build/game.wasm.br'), 2); // asked twice, downloaded once (304 the second time)
  });

  test('a failed check leaves the test build exactly as it was', async () => {
    await check();
    site.set({ '/tide/index.html': '<h1>v2</h1>', '/tide/Build/game.js': { status: 500 } });
    const r = await check();
    assert.equal(r.status, 'error');
    assert.match(r.message, /Build\/game\.js answered 500.*wasn’t changed/);
    assert.equal(text(`${PREFIX}index.html`), '<h1>v1</h1>');
    assert.deepEqual(stored(), [`${PREFIX}Build/game.js`, `${PREFIX}Build/game.wasm.br`, `${PREFIX}index.html`]);
    assert.equal(monitor.last_status, 'error');
    // and the next good check picks the change up
    site.set({ '/tide/Build/game.js': 'js v2' });
    assert.equal((await check()).status, 'changed');
    assert.equal(text(`${PREFIX}index.html`), '<h1>v2</h1>');
  });

  test('a file missing from the list’s site, a redirect to another site and an unreachable list are errors, not partial copies', async () => {
    site.pages.delete('/tide/Build/game.js');
    assert.match((await check()).message, /Build\/game\.js answered 404/);
    site.set({ '/tide/Build/game.js': { redirect: 'https://evil.example.net/x.js' } });
    assert.match((await check()).message, /redirects to another site \(https:\/\/evil\.example\.net\)/);
    site.pages.delete('/tide/files.txt');
    assert.match((await check()).message, /file list .* answered 404/);
    assert.deepEqual(stored(), []);
    assert.equal(db.build(monitor.game_id, 'web-copy'), undefined);
  });

  test('a game bigger than the limit isn’t copied', async () => {
    site.set({ '/tide/Build/game.js': { body: 'x', headers: { 'content-length': String(MONITOR_LIMITS.totalBytes + 1) } } });
    const r = await check();
    assert.match(r.message, /bigger than 1024\.0 MB/);
    assert.deepEqual(stored(), []);
  });

  test('a server that compresses although asked not to, or gives no size, is still copied correctly', async () => {
    site.set({ '/tide/Build/game.js': { body: gzipSync('js v1 gz'), headers: { 'content-encoding': 'gzip' } }, '/tide/index.html': { body: '<h1>nolen</h1>', noLength: true } });
    assert.equal((await check()).status, 'changed');
    assert.equal(text(`${PREFIX}Build/game.js`), 'js v1 gz');
    assert.equal(text(`${PREFIX}index.html`), '<h1>nolen</h1>');
  });

  test('if the test build’s files went missing, they’re copied again even though the site is unchanged', async () => {
    await check();
    await staging.deleteKeys([`${PREFIX}Build/game.js`]);
    const r = await check();
    assert.equal(r.status, 'changed');
    assert.equal(text(`${PREFIX}Build/game.js`), 'js v1');
  });

  test('changing what is monitored starts from scratch; saving the same thing keeps what’s known', async () => {
    await check();
    const again = saveMonitor(db, { game_id: monitor.game_id, url: BASE, files_from: 'list', list_url: `${BASE}files.txt`, by: 'user:mia' });
    assert.equal(Object.keys(again.files).length, 3);
    const moved = saveMonitor(db, { game_id: monitor.game_id, url: 'https://games.example.org/tide2/', files_from: 'crawl', list_url: null, by: 'user:mia' });
    assert.equal(moved.id, monitor.id);
    assert.deepEqual(moved.files, {});
  });
});

describe('following links, end to end', () => {
  test('broken links are left out and reported; index.html itself must load', async () => {
    setup('crawl');
    site.set({ '/tide/index.html': '<script src="game.js"></script><img src="gone.png">', '/tide/game.js': 'js' });
    const r = await check();
    assert.equal(r.status, 'changed');
    assert.match(r.message, /Copied 2 files.*1 linked file couldn’t be fetched and was left out: gone\.png/);
    assert.deepEqual(stored(), [`${PREFIX}game.js`, `${PREFIX}index.html`]);
    site.pages.delete('/tide/index.html');
    assert.match((await check()).message, /games\.example\.org\/tide\/ answered 404/);
    assert.equal(site.gets('/tide/index.html'), 0); // the page is fetched at the folder address, as players load it
  });
});

describe('the scheduled check', () => {
  test('checks every monitor, never-checked ones first, and keeps monitored builds out of the cleanup', async () => {
    const game = setup('list');
    site.set({ '/tide/files.txt': 'index.html', '/tide/index.html': 'hi' });
    const out = await checkMonitors({ db, staging, fetcher: site.fetcher }, 60_000);
    assert.deepEqual(out.checked.map((c) => [c.game, c.status]), [['fieldday/tide', 'changed']]);
    assert.equal(out.left, 0);
    assert.deepEqual([...monitoredBuilds(db)], ['fieldday/tide/web-copy']);
    assert.equal((await checkMonitors({ db, staging, fetcher: site.fetcher }, 1_000)).left, 1); // no time left: nothing started
    db.deleteGame(game.id); // the monitor goes with its game
    assert.equal(monitorById(db, monitor.id), undefined);
  });
});
