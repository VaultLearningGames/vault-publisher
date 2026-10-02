// Listing previews rendered by the portal (src/portal/site-preview.ts, routes in listing-preview.ts).
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog.ts';
import { loadConfig, parsePreviewSites } from '../src/config.ts';
import { PREVIEW_TTL_MS, PreviewStore, wantsJson } from '../src/portal/listing-preview.ts';
import { absolutize, BADGE, CACHE_MS, HUGO_TIMEOUT_MS, hugoRunner, MAX_BUILDS, mergeCatalog, PREVIEW_CSP, SitePreviewer, withBadge, type HugoRunner } from '../src/portal/site-preview.ts';
import { portalHarness } from './portal-harness.ts';

const L = '/portal/api/s/fieldday/listings';
const SITE = 'https://site.test';
const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="/sq/css/vault-sq.css?v=1"><link rel="icon" href='/favicon.ico'>
<script src="/sq/js/vault-sq.js" defer></script><script src="//cdn.test/x.js"></script></head>
<body><a href="#page">Skip</a><a href="/about">About</a><a href="https://example.org/x">Out</a>
<img src="/sq/img/a.png" srcset="/sq/img/a.png 1x, /sq/img/a@2x.png 2x, https://cdn.test/b.png 3x"><video poster="/sq/img/p.jpg"></video>
<div style="background:url(/sq/img/bg.jpg)"></div><form action="https://portal.test/v1/forms/newsletter"></form><h1>TITLE</h1></body></html>`;

// A stand-in for Hugo: writes what a preview build leaves behind (preview-map.json and each game's page, whose
// <h1> is the title it found in the catalog it was given), and records how it was called.
function fakeHugo(opts: { delayMs?: number; fail?: string; missing?: boolean } = {}) {
  const calls: { args: string[]; env: Record<string, string>; timeoutMs: number; catalog: any; files: string[] }[] = [];
  const state = { running: 0, peak: 0 };
  const run: HugoRunner = async (args, env, timeoutMs) => {
    const src = args[args.indexOf('--source') + 1], out = args[args.indexOf('--destination') + 1];
    const catalog = JSON.parse(readFileSync(join(src, 'data', 'catalog.json'), 'utf8'));
    calls.push({ args, env, timeoutMs, catalog, files: readdirSync(src, { recursive: true }).map(String).sort() });
    state.peak = Math.max(state.peak, ++state.running);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error(opts.fail);
      mkdirSync(out, { recursive: true });
      const games = opts.missing ? [] : catalog.games.map((g: any) => ({ slug: g.slug, path: `/${g.slug}/` }));
      writeFileSync(join(out, 'preview-map.json'), JSON.stringify({ games }));
      for (const g of catalog.games) {
        mkdirSync(join(out, g.slug), { recursive: true });
        writeFileSync(join(out, g.slug, 'index.html'), PAGE.replace('TITLE', g.title));
      }
    } finally { state.running--; }
  };
  return { run, calls, state };
}

// A site source like site/: config, data, a theme with a stylesheet and an image, and build output to leave behind.
function fakeSite(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-site-test-'));
  const put = (path: string, text = 'x') => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
  put('hugo.toml'); put('preview/hugo.preview.toml'); put('data/squarespace/games.json', '{}'); put('content/_index.md');
  put('themes/t/layouts/home.html'); put('themes/t/static/sq/css/site.css'); put('themes/t/static/sq/js/site.js');
  put('themes/t/static/sq/img/big.png'); put('static/files/big.pdf'); put('public/index.html'); put('scripts/x.mjs');
  return dir;
}

let t: ReturnType<typeof portalHarness>;
let hugo: ReturnType<typeof fakeHugo>;
let logs: string[];
let now: number;
const previewer = (h = hugo, more: Partial<ConstructorParameters<typeof SitePreviewer>[0]> = {}) => new SitePreviewer({
  siteDir: fakeSite(), siteUrl: `${SITE}/`, portalUrl: 'https://portal.test/', hugo: h.run,
  catalog: () => buildCatalog(t.db, 'https://prod.test'), log: (l) => logs.push(l), now: () => now, ...more,
});
async function token(fields: Record<string, unknown> = { title: 'Wake: The Deep' }, slug = 'wake'): Promise<string> {
  const res = await t.as('mia', 'none', 'maintainer').post(`${L}/${slug}/preview`, fields);
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  hugo = fakeHugo(); logs = []; now = Date.now();
  t = portalHarness({ previewSites: parsePreviewSites('Site=https://portal.test') });
  t.rebuild({ previewSites: parsePreviewSites('Site=https://portal.test'), sitePreview: previewer() });
  const boss = t.as('boss', 'release_manager');
  assert.equal((await boss.post(L, { slug: 'wake', title: 'Wake' })).status, 200);
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', short_description: 'Old.', publish: true })).status, 200);
  assert.equal((await boss.post(L, { slug: 'lakeland', title: 'Lakeland' })).status, 200);
  assert.equal((await boss.post(`${L}/lakeland`, { play_url: 'https://example.org/lakeland/', publish: true })).status, 200);
});

describe('the portal renders listing previews', () => {
  test('token → the game’s page with the unsaved edit, the badge, and no-store, noindex, sandboxed', async () => {
    const tk = await token();
    const res = await t.app.request(`/_preview/${tk}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    // The page gets an origin of its own: a studio's raw HTML can't act with the viewer's portal session.
    assert.equal(res.headers.get('content-security-policy'), PREVIEW_CSP);
    assert.match(PREVIEW_CSP, /^sandbox /);
    assert.doesNotMatch(PREVIEW_CSP, /allow-same-origin|allow-top-navigation/);
    const page = await res.text();
    assert.match(page, /<h1>Wake: The Deep<\/h1>/, 'the unsaved title, not the published one');
    assert.ok(page.includes(`${BADGE}</body>`), 'badge just before </body>');
    assert.match(BADGE, /Preview — not published/);
    assert.equal(t.db.listing('wake')!.published!.title, 'Wake', 'nothing saved');

    // Hugo ran once, on a copy of the site, with the published catalog and this game replaced in it.
    assert.equal(hugo.calls.length, 1);
    const call = hugo.calls[0];
    assert.deepEqual(call.catalog.games.map((g: any) => [g.slug, g.title]).sort(), [['lakeland', 'Lakeland'], ['wake', 'Wake: The Deep']]);
    assert.equal(call.catalog.version, 1);
    assert.equal(call.timeoutMs, HUGO_TIMEOUT_MS);
    assert.equal(HUGO_TIMEOUT_MS, 25_000);
    assert.deepEqual(call.args.slice(0, 4), ['--buildDrafts', '--logLevel', 'warn', '--noBuildLock']);
    assert.equal(call.args[call.args.indexOf('--config') + 1], 'hugo.toml,preview/hugo.preview.toml');
    // As the site build: the site's address, the forms posting to this portal; none of the portal's environment.
    assert.deepEqual(Object.keys(call.env).sort(), ['HOME', 'HUGO_BASEURL', 'HUGOxPARAMSxFORMSxNEWSLETTER', 'HUGOxPARAMSxFORMSxSUBMIT_GAME', 'PATH']);
    assert.equal(call.env.HUGO_BASEURL, 'https://site.test/');
    assert.equal(call.env.HUGOxPARAMSxFORMSxSUBMIT_GAME, 'https://portal.test/v1/forms/submit-game');
    // Copied: templates, data, stylesheets and scripts. Not copied: images, downloads, build output.
    for (const f of ['src/hugo.toml', 'src/preview/hugo.preview.toml', 'src/data/squarespace/games.json', 'src/themes/t/static/sq/css/site.css', 'src/themes/t/static/sq/js/site.js'])
      assert.ok(call.files.includes(f.slice(4)), f);
    for (const f of ['themes/t/static/sq/img/big.png', 'static/files/big.pdf', 'public/index.html', 'scripts/x.mjs']) assert.ok(!call.files.includes(f), f);
    // The temp folder is gone.
    assert.throws(() => readdirSync(call.args[call.args.indexOf('--source') + 1]));
  });

  test('assets and links are absolute to the site’s origin', async () => {
    const page = await (await t.app.request(`/_preview/${await token()}/`)).text();
    assert.match(page, /<link rel="stylesheet" href="https:\/\/site\.test\/sq\/css\/vault-sq\.css\?v=1">/);
    assert.match(page, /href='https:\/\/site\.test\/favicon\.ico'/);
    assert.match(page, /<script src="https:\/\/site\.test\/sq\/js\/vault-sq\.js" defer>/);
    assert.match(page, /<img src="https:\/\/site\.test\/sq\/img\/a\.png" srcset="https:\/\/site\.test\/sq\/img\/a\.png 1x, https:\/\/site\.test\/sq\/img\/a@2x\.png 2x, https:\/\/cdn\.test\/b\.png 3x">/);
    assert.match(page, /poster="https:\/\/site\.test\/sq\/img\/p\.jpg"/);
    assert.match(page, /url\(https:\/\/site\.test\/sq\/img\/bg\.jpg\)/);
    assert.match(page, /<a href="https:\/\/site\.test\/about">/);
    // Left alone: protocol-relative and absolute addresses, and links within the page.
    assert.match(page, /<script src="\/\/cdn\.test\/x\.js">/);
    assert.match(page, /<a href="#page">/);
    assert.match(page, /<a href="https:\/\/example\.org\/x">/);
    assert.match(page, /action="https:\/\/portal\.test\/v1\/forms\/newsletter"/);
    assert.doesNotMatch(page, /(src|href|poster|action)=["']\/[^/]/, 'no root-relative address is left');
  });

  test('absolutize, withBadge, mergeCatalog', () => {
    assert.equal(absolutize('<a href="/x"><img src=\'/y.png\'>', 'https://s.test/'), '<a href="https://s.test/x"><img src=\'https://s.test/y.png\'>');
    assert.equal(absolutize('<a href="//h/x" data-href="/keep">', 'https://s.test'), '<a href="//h/x" data-href="/keep">');
    assert.equal(withBadge('<p>no body tag'), `<p>no body tag${BADGE}`);
    const merged = mergeCatalog({ version: 1, games: [{ slug: 'a' }, { slug: 'b' }], studios: [{ slug: 's1' }] },
      { game: { slug: 'b', title: 'New' } as any, studios: [{ slug: 's1', name: 'One' } as any, { slug: 's2' }] });
    assert.deepEqual(merged, { version: 1, games: [{ slug: 'a' }, { slug: 'b', title: 'New' }], studios: [{ slug: 's1', name: 'One' }, { slug: 's2' }] });
    assert.deepEqual(mergeCatalog({ games: [] }, { game: { slug: 'new' } }).games, [{ slug: 'new' }], 'a game that isn’t on the site yet is added');
  });

  test('/v1/listing-previews/TOKEN is the same page; JSON only for a caller that asks for JSON', async () => {
    const tk = await token();
    const viaApi = await t.app.request(`/v1/listing-previews/${tk}`, { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.equal(viaApi.status, 200);
    assert.equal(viaApi.headers.get('cache-control'), 'no-store');
    assert.equal(viaApi.headers.get('content-security-policy'), PREVIEW_CSP);
    assert.equal(await viaApi.text(), await (await t.app.request(`/_preview/${tk}/`)).text());
    assert.match(await (await t.app.request(`/v1/listing-previews/${tk}`)).text(), /Preview — not published/, 'no Accept header: the page');
    // A site that renders its own previews (Accept: application/json) still gets the data.
    const json = await t.app.request(`/v1/listing-previews/${tk}`, { headers: { accept: 'application/json' } });
    assert.match(json.headers.get('content-type')!, /^application\/json/);
    assert.equal(json.headers.get('cache-control'), 'no-store');
    assert.equal(((await json.json()) as any).game.title, 'Wake: The Deep');
    assert.equal(wantsJson('application/json'), true);
    assert.equal(wantsJson('text/html, application/json'), false);
    assert.equal(wantsJson(undefined), false);
    assert.equal(hugo.calls.length, 1, 'both addresses share one build');
  });

  test('the editor’s Preview opens on the portal', async () => {
    const res = await t.as('mia', 'none', 'maintainer').post(`${L}/wake/preview`, {});
    const p = (await res.json()) as { token: string; urls: { label: string; url: string }[] };
    assert.deepEqual(p.urls, [{ label: 'Site', url: `https://portal.test/_preview/${p.token}/` }]);
  });

  test('a rendered page is kept per token for three minutes; another token builds again', async () => {
    assert.equal(CACHE_MS, 3 * 60_000);
    const a = await token(), b = await token({ title: 'Other' });
    for (let i = 0; i < 3; i++) assert.equal((await t.app.request(`/_preview/${a}/`)).status, 200);
    assert.equal(hugo.calls.length, 1);
    assert.match(await (await t.app.request(`/_preview/${b}/`)).text(), /<h1>Other<\/h1>/);
    assert.equal(hugo.calls.length, 2);
    now += CACHE_MS + 1;
    assert.equal((await t.app.request(`/_preview/${a}/`)).status, 200);
    assert.equal(hugo.calls.length, 3, 'built again once the cached page is older than three minutes');
  });

  test('at most two Hugo builds run at once; the rest wait their turn; one build per token', async () => {
    assert.equal(MAX_BUILDS, 2);
    hugo = fakeHugo({ delayMs: 40 });
    const p = previewer();
    t.rebuild({ previewSites: [], sitePreview: p });
    const store = [0, 1, 2, 3, 4].map((i) => ({ game: { slug: 'wake', title: `T${i}` } }));
    const pages = store.map((input, i) => p.page(`token-number-${i}-xxxxxxxx`, input));
    pages.push(p.page('token-number-0-xxxxxxxx', store[0]));          // the same token again: no second build
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(p.load, { running: 2, waiting: 3 });
    const done = await Promise.all(pages);
    assert.deepEqual(done.map((d) => d.status), [200, 200, 200, 200, 200, 200]);
    assert.equal(hugo.state.peak, 2);
    assert.equal(hugo.calls.length, 5);
    assert.deepEqual(p.load, { running: 0, waiting: 0 });
    assert.equal(done[5].body, done[0].body);
  });

  test('an expired or unknown token gets the expiry page, 404, without running Hugo', async () => {
    let clock = Date.now();
    const store = new PreviewStore(() => clock);
    const { token: tk } = store.put({ version: 1, game: { slug: 'wake', title: 'Wake' } as any, studios: [] });
    const p = previewer();
    assert.equal((await p.page(tk, store.get(tk)!)).status, 200);
    clock += PREVIEW_TTL_MS;
    assert.equal(store.get(tk), undefined);

    for (const path of [`/_preview/${'x'.repeat(43)}/`, `/v1/listing-previews/${'x'.repeat(43)}`]) {
      const res = await t.app.request(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.match(await res.text(), /<h1>This preview has expired<\/h1>.*click Preview again/);
    }
    assert.equal(hugo.calls.length, 1);
  });

  test('addresses: no trailing slash redirects; anything else under /_preview/ is a 404 page', async () => {
    const tk = await token();
    const bare = await t.app.request(`/_preview/${tk}`);
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), `/_preview/${tk}/`);
    for (const path of ['/_preview/', '/_preview/short/', `/_preview/${tk}/extra`, '/_preview/..%2F..%2Fetc/']) {
      const res = await t.app.request(path);
      assert.equal(res.status, 404, path);
      assert.match(await res.text(), /<h1>Not found<\/h1>/);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    assert.equal((await t.app.request(`/_preview/${tk}/`, { method: 'HEAD' })).status, 200);
    assert.equal(hugo.calls.length, 1);
  });

  test('Hugo failing → a short 500 page that says nothing about the failure, and the next request tries again', async () => {
    hugo = fakeHugo({ fail: 'hugo exited with 1: template: games/single.html:12: SECRET DETAIL' });
    t.rebuild({ previewSites: parsePreviewSites('Site=https://portal.test'), sitePreview: previewer() });
    const tk = await token();
    const res = await t.app.request(`/_preview/${tk}/`);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    const page = await res.text();
    assert.match(page, /<h1>The preview could not be built<\/h1>/);
    assert.ok(page.length < 800, 'short');
    assert.doesNotMatch(page, /SECRET DETAIL|template|hugo/i);
    assert.match(logs.join('\n'), /building wake failed: hugo exited with 1: .*SECRET DETAIL/, 'the reason is in the log');
    assert.equal((await t.app.request(`/_preview/${tk}/`)).status, 500);
    assert.equal(hugo.calls.length, 2, 'a failure isn’t cached');

    // The page Hugo should have written isn't there.
    hugo = fakeHugo({ missing: true });
    t.rebuild({ previewSites: parsePreviewSites('Site=https://portal.test'), sitePreview: previewer() });
    assert.equal((await t.app.request(`/_preview/${await token()}/`)).status, 500);
    assert.match(logs.join('\n'), /no page for wake in preview-map\.json/);
  });

  test('a Hugo that runs too long is stopped', async () => {
    const run = hugoRunner(process.execPath);                      // node, standing in for a hung hugo
    const t0 = Date.now();
    await assert.rejects(run(['-e', 'setTimeout(() => {}, 60000)'], { PATH: process.env.PATH ?? '' }, 150), /was stopped \(SIGKILL\) after 150 ms/);
    assert.ok(Date.now() - t0 < 5000);
    await assert.rejects(run(['-e', 'console.error("boom"); process.exit(3)'], { PATH: process.env.PATH ?? '' }, 5000), /exited with 3: boom/);
    await assert.rejects(hugoRunner('/nonexistent/hugo')([], {}, 1000), /ENOENT/);
  });

  test('a portal without the site source answers 503', async () => {
    t.rebuild({ previewSites: parsePreviewSites('Site=https://portal.test'), sitePreview: null });
    const res = await t.app.request(`/_preview/${await token()}/`);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /Previews aren’t available here/);
  });
});

describe('config', () => {
  test('SITE_DIR and HUGO_BIN default to the image’s site/ and hugo', () => {
    const keep = { ...process.env };
    try {
      Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_BUILDS_ACCESS_KEY_ID: 'k', R2_BUILDS_SECRET_ACCESS_KEY: 's', BUILDS_BUCKET: 'b',
        BUILDS_PUBLIC_URL: 'https://b.test', CDN_BUCKET: 'c', CDN_PUBLIC_URL: 'https://c.test', PORTAL_URL: 'https://p.test', TASK_INVOKER_EMAIL: 'x@y',
        SITE_URL: 'https://site.test/', PREVIEW_SITES: 'Site=https://p.test New=https://new.test' });
      delete process.env.SITE_DIR; delete process.env.HUGO_BIN;
      let c = loadConfig();
      assert.equal(c.siteDir, 'site');
      assert.equal(c.hugoBin, 'hugo');
      assert.equal(c.siteUrl, 'https://site.test');
      assert.deepEqual(c.previewSites, [{ label: 'Site', url: 'https://p.test' }, { label: 'New', url: 'https://new.test' }]);
      Object.assign(process.env, { SITE_DIR: ' /opt/site ', HUGO_BIN: '/usr/local/bin/hugo' });
      c = loadConfig();
      assert.equal(c.siteDir, '/opt/site');
      assert.equal(c.hugoBin, '/usr/local/bin/hugo');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });
});

// The real thing, when Hugo is installed (the deploy workflow installs it before the tests): site/ rendered with a
// previewed game, through the portal's route.
const hugoVersion = (() => { try { return execFileSync('hugo', ['version'], { encoding: 'utf8' }); } catch { return ''; } })();
describe('with Hugo and site/', { skip: hugoVersion ? false : 'hugo is not installed' }, () => {
  test('a new game’s page, with the site’s own templates', async () => {
    const real = new SitePreviewer({
      siteDir: new URL('../site/', import.meta.url).pathname, siteUrl: 'https://vaultlearninggames-staging.org', portalUrl: 'https://portal.test',
      catalog: () => buildCatalog(t.db, 'https://prod.test'), log: (l) => logs.push(l),
    });
    t.rebuild({ previewSites: parsePreviewSites('Site=https://portal.test'), sitePreview: real });
    const tk = await token({ title: 'Wake: Preview Edition', short_description: 'A **new** description.', about: 'About text.\n\n<script>window.x=1</script>' });
    const res = await t.app.request(`/_preview/${tk}/`);
    const page = await res.text();
    assert.equal(res.status, 200, logs.join('\n'));
    assert.match(page, /<title>[^<]*Wake: Preview Edition/);
    assert.match(page, /<link rel="stylesheet" href="https:\/\/vaultlearninggames-staging\.org\/sq\/css\/vault-sq\.css\?v=[0-9a-f]{8}">/, 'the stylesheet, with its hash, from the site');
    assert.match(page, /<script src="https:\/\/vaultlearninggames-staging\.org\/sq\/js\/vault-sq\.js\?v=[0-9a-f]{8}" defer>/);
    assert.match(page, /var LOGO = 'https:\\\/\\\/vaultlearninggames-staging\.org\\\/sq\\\/img\\\/site\\\/vault-game-library\.png'/, 'addresses built in scripts are absolute too');
    assert.match(page, /action="https:\/\/portal\.test\/v1\/forms\/newsletter"/);
    assert.doesNotMatch(page, /\s(src|href|poster|action)=["']\/[^/]/);
    assert.ok(page.includes(`${BADGE}</body>`));
    assert.match(logs.join('\n'), /built wake \(\/wake\/\) in \d+ ms/);
  });
});
