import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSET_CACHE, FIXED_CACHE, PAGE_CACHE, MAX_STATIC_REDIRECTS, cacheFor, canonicalPath, headersFile, linkedPath, listFiles,
  redirectsFile, robotsFile, writeHostingFiles,
} from '../src/site-hosting.ts';

function build(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-hosting-test-'));
  for (const k of files) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), k); }
  return dir;
}
const CARDS = [{ from: '/game-cards/pearl-diver', to: '/pearl' }, { from: '/game-cards/blog-post-title-one-kma9a', to: '/wake' }];
const SITE = ['index.html', '404.html', 'wake/index.html', 'pearl/index.html', 'game-cards/index.html', 'sitemap.xml',
  'game-cards/category/Dev:+Field+Day+Lab/index.html', 'game-cards/category/Grades+9-12/index.html',
  'game-cards/tag/Subject:+Family/Consumer+Science/index.html',
  'sq/css/vault-sq.css', 'sq/css/fonts.css', 'sq/js/vault-sq.js',
  'sq/img/site/key-to-vault-min-fc73a9.png', 'sq/img/site/vault-tv-wide-48947b.jpg', 'sq/img/games/wake/wake-thumb-72ece9.jpg',
  'sq/img/site/vault-game-library.png', 'sq/fonts/archivo-500-latin.woff2', 'sq/fonts/montserrat-300-latin.woff2',
  'files/keys-to-the-vault.pdf', 'favicon.ico'].sort();

// The header rules as { path: { header: value } }, applied the way the hosting does: every matching rule in file
// order, "! Header" removing what earlier rules set.
function headersAt(text: string, host: string, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let applies = false;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      const rule = line.startsWith('https://') ? line : `https://${host}${line}`;
      const target = `https://${host}${path}`;
      applies = rule.endsWith('*') ? target.startsWith(rule.slice(0, -1)) : target === rule;
    } else if (applies) {
      const l = line.trim();
      if (l.startsWith('! ')) delete out[l.slice(2).toLowerCase()];
      else out[l.slice(0, l.indexOf(':')).toLowerCase()] = l.slice(l.indexOf(':') + 1).trim();
    }
  }
  return out;
}

describe('the static hosting files of the site', () => {
  test('cache lifetimes: pages a minute, fixed files a month, the rest an hour', () => {
    assert.equal(cacheFor('wake/index.html'), PAGE_CACHE);
    assert.equal(cacheFor('sitemap.xml'), PAGE_CACHE);
    assert.equal(cacheFor('sq/css/vault-sq.css'), ASSET_CACHE);
    assert.equal(cacheFor('sq/img/site/key-to-vault-min-fc73a9.png'), FIXED_CACHE);
    assert.equal(cacheFor('sq/img/site/vault-game-library.png'), ASSET_CACHE);
    assert.equal(cacheFor('sq/fonts/archivo-500-latin.woff2'), FIXED_CACHE);
    assert.equal(cacheFor('files/keys-to-the-vault.pdf'), ASSET_CACHE);
    assert.equal(PAGE_CACHE, 'public, max-age=60');
    assert.equal(FIXED_CACHE, 'public, max-age=2592000');
    assert.equal(ASSET_CACHE, 'public, max-age=3600');
  });

  test('_headers gives every file its lifetime, in a few rules', () => {
    const text = headersFile(SITE);
    for (const key of SITE) {
      const path = '/' + (key === 'index.html' ? '' : key.endsWith('/index.html') ? linkedPath(key.slice(0, -'/index.html'.length)) : canonicalPath(key));
      const h = headersAt(text, 'vaultlearninggames-staging.org', path);
      assert.equal(h['cache-control'], cacheFor(key), path);
      assert.equal(h['access-control-allow-origin'], '*', path);
      assert.equal(h['x-robots-tag'], 'noindex', path);
    }
    // An address that doesn't exist is the 404 page: a page's lifetime.
    assert.equal(headersAt(text, 'x.org', '/nope/')['cache-control'], PAGE_CACHE);
    assert.deepEqual(text.split('\n').filter((l) => l.startsWith('/')), ['/*', '/favicon.ico', '/files/*', '/sq/*', '/sq/css/*', '/sq/img/site/vault-game-library.png', '/sq/js/*']);
    // A header set twice would be sent twice: every later Cache-Control removes the earlier one first.
    assert.equal(text.match(/! Cache-Control/g)?.length, text.match(/Cache-Control: /g)!.length - 1);
  });

  test('X-Robots-Tag: noindex everywhere, except at the one hostname to index', () => {
    assert.ok(!headersFile(SITE).includes('https://'));
    assert.ok(!headersFile(SITE).includes('X-Robots-Tag: all'));
    const text = headersFile(SITE, { indexHost: 'vaultlearninggames.org' });
    assert.equal(headersAt(text, 'vaultlearninggames.org', '/wake/')['x-robots-tag'], 'all');
    assert.equal(headersAt(text, 'vaultlearninggames.org', '/nope/')['x-robots-tag'], 'all');
    assert.equal(headersAt(text, 'vaultlearninggames.org', '/sq/css/vault-sq.css')['cache-control'], ASSET_CACHE);
    for (const host of ['www.vaultlearninggames.org', 'static.vaultlearninggames.org', 'vaultlearninggames-staging.org', 'vault-site.example.workers.dev']) {
      assert.equal(headersAt(text, host, '/wake/')['x-robots-tag'], 'noindex', host);
    }
    assert.throws(() => headersFile(SITE, { indexHost: 'vaultlearninggames.org/*' }), /isn't a hostname/);
  });

  test('more rules than Cloudflare allows fails the build', () => {
    const many = Array.from({ length: 120 }, (_, i) => `odd${i}.bin`);
    assert.throws(() => headersFile([...SITE, ...many]), /_headers would need \d+ rules; Cloudflare allows 100/);
  });

  test('the two spellings of an address', () => {
    assert.equal(linkedPath('game-cards/category/Dev:+Field+Day+Lab'), 'game-cards/category/Dev%3A+Field+Day+Lab');
    assert.equal(canonicalPath('game-cards/category/Dev:+Field+Day+Lab'), 'game-cards/category/Dev%3A%2BField%2BDay%2BLab');
    // A "/" inside a filter's value is two folders in the build and "%2F" in the address, as Squarespace spelled it.
    assert.equal(linkedPath('game-cards/tag/Subject:+Family/Consumer+Science'), 'game-cards/tag/Subject%3A+Family%2FConsumer+Science');
    assert.equal(canonicalPath('game-cards/tag/Subject:+Family/Consumer+Science'), 'game-cards/tag/Subject%3A%2BFamily/Consumer%2BScience');
    assert.equal(linkedPath("game-cards/tag/Topic:+People's+(Pie)"), 'game-cards/tag/Topic%3A+People%27s+%28Pie%29');
    assert.equal(linkedPath('wake'), canonicalPath('wake'));
  });

  test('_redirects: the PDF, the Game Card addresses, the filter addresses served at once, a 301 from each page\'s slash', () => {
    const r = redirectsFile(SITE, CARDS);
    const lines = r.text.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(lines[0], '/s/keys-to-the-vault.pdf /files/keys-to-the-vault.pdf 301');
    assert.deepEqual(lines.slice(1, 3), ['/cart / 301', '/search / 301'], 'Squarespace’s own pages go to the home page');
    assert.deepEqual(lines.slice(3, 5), ['/game-cards/blog-post-title-one-kma9a /wake 301', '/game-cards/pearl-diver /pearl 301']);
    assert.deepEqual(lines.filter((l) => l.endsWith(' 200')), [
      '/game-cards/category/Dev%3A+Field+Day+Lab /game-cards/category/Dev%3A%2BField%2BDay%2BLab 200',
      '/game-cards/category/Grades+9-12 /game-cards/category/Grades%2B9-12 200',
      '/game-cards/tag/Subject%3A+Family%2FConsumer+Science /game-cards/tag/Subject%3A%2BFamily/Consumer%2BScience 200',
    ]);
    // No page is served with a trailing slash: the slash is a 301 to the page (and to the game, for a card).
    assert.ok(lines.includes('/wake/ /wake 301'));
    assert.ok(lines.includes('/game-cards/ /game-cards 301'));
    assert.ok(lines.includes('/game-cards/category/Grades+9-12/ /game-cards/category/Grades+9-12 301'));
    assert.ok(lines.includes('/game-cards/tag/Subject%3A+Family%2FConsumer+Science/ /game-cards/tag/Subject%3A+Family%2FConsumer+Science 301'));
    assert.ok(lines.includes('/game-cards/pearl-diver/ /pearl 301'));
    assert.ok(!lines.some((l) => / \/[^ ]*\/ \d+$/.test(l)), 'no redirect ends at an address with a slash');
    assert.deepEqual([r.cards, r.rewrites, r.slashes, r.skippedSlashes], [2, 3, 8, false]);
    // Three parts a line, and nothing Cloudflare would read as a placeholder (":name", "*") in an address.
    for (const l of lines) {
      const parts = l.split(' ');
      assert.equal(parts.length, 3, l);
      assert.ok(!/[:*]/.test(parts[0]), l);
    }
    // The home page and files get no line; no address is the source of two lines.
    assert.ok(!lines.some((l) => l.startsWith('/ ') || l.startsWith('/404') || l.startsWith('/sq')));
    assert.equal(new Set(lines.map((l) => l.split(' ')[0])).size, lines.length);
  });

  test('a Game Card redirect must be a card address, to a page of the build, and not over a page', () => {
    assert.throws(() => redirectsFile(SITE, [{ from: '/game-cards/x', to: '/nope' }]), /the build has no such page/);
    assert.throws(() => redirectsFile(SITE, [{ from: '/wake', to: '/pearl' }]), /not a \/game-cards\/<card> address/);
    assert.throws(() => redirectsFile(SITE, [{ from: '/game-cards/a b', to: '/pearl' }]), /not a \/game-cards\/<card> address/);
    assert.throws(() => redirectsFile([...SITE, 'game-cards/pearl-diver/index.html'], CARDS), /the build has a page at that address/);
  });

  test('more pages than Cloudflare allows redirects for: the slash 301s are left to the hosting, the rest stays', () => {
    const pages = Array.from({ length: MAX_STATIC_REDIRECTS }, (_, i) => `g${i}/index.html`);
    const r = redirectsFile([...SITE, ...pages], CARDS);
    assert.deepEqual([r.cards, r.rewrites, r.slashes, r.skippedSlashes], [2, 3, 0, true]);
    assert.equal(r.text.split('\n').filter((l) => l.startsWith('/')).length, 8);
  });

  test('robots.txt: everything may be crawled; only the build that is indexed names its sitemap', () => {
    assert.equal(robotsFile({ indexHost: 'vaultlearninggames.org' }), 'User-agent: *\nDisallow:\n\nSitemap: https://vaultlearninggames.org/sitemap.xml\n');
    // Not indexed is said by the X-Robots-Tag header, which a crawler must be allowed to fetch the page to see.
    assert.equal(robotsFile(), 'User-agent: *\nDisallow:\n');
    assert.ok(!/Disallow: *\S/.test(robotsFile()) && !/Disallow: *\S/.test(robotsFile({ indexHost: 'vaultlearninggames.org' })));
  });

  test('writes the files into the build, and refuses a build that isn\'t the site', async () => {
    const dir = build(SITE);
    writeFileSync(join(dir, '.DS_Store'), 'x');
    writeFileSync(join(dir, 'card-redirects.json'), JSON.stringify(CARDS));
    const withRobots = [...SITE, 'robots.txt'].sort();
    const r = await writeHostingFiles(dir, { indexHost: 'vaultlearninggames.org' });
    assert.deepEqual(r, { files: withRobots.length, headerRules: 8, cards: 2, rewrites: 3, slashes: 8, skippedSlashes: false });
    assert.equal(readFileSync(join(dir, '_headers'), 'utf8'), headersFile(withRobots, { indexHost: 'vaultlearninggames.org' }));
    assert.equal(readFileSync(join(dir, '_redirects'), 'utf8'), redirectsFile(withRobots, CARDS).text);
    assert.equal(readFileSync(join(dir, 'robots.txt'), 'utf8'), robotsFile({ indexHost: 'vaultlearninggames.org' }));
    // The list of card redirects is read, and never published.
    assert.equal(readFileSync(join(dir, '.assetsignore'), 'utf8'), 'card-redirects.json\n.DS_Store\n');
    // A second run sees the same site: the hosting's own files are not part of it.
    assert.deepEqual(await listFiles(dir), withRobots);
    assert.deepEqual(await writeHostingFiles(dir, { indexHost: 'vaultlearninggames.org' }), r);
    // Another build of the same folder for a system that is not indexed: no sitemap line left behind.
    await writeHostingFiles(dir);
    assert.equal(readFileSync(join(dir, 'robots.txt'), 'utf8'), 'User-agent: *\nDisallow:\n');
    await assert.rejects(writeHostingFiles(build(['wake/index.html', '404.html'])), /the build has no index\.html/);
    await assert.rejects(writeHostingFiles(build(['index.html'])), /the build has no 404\.html/);
    // A build without the list (Hugo didn't write one) has no card redirects, and still works.
    assert.equal((await writeHostingFiles(build(SITE))).cards, 0);
  });

  test('the hosting configuration: two Workers, files only, no hostname for a deploy to change', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'cloudflare', 'site', 'wrangler.jsonc'), 'utf8');
    const config = JSON.parse(text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'));
    assert.deepEqual(config.env, { staging: { name: 'vault-site-staging' }, production: { name: 'vault-site' } });
    assert.deepEqual(config.assets, { directory: '../../site/public', not_found_handling: '404-page', html_handling: 'drop-trailing-slash' });
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.ok(!('main' in config), 'no script');
    assert.ok(!/"routes?"|custom_domain/.test(text), 'no hostname');
    const pin = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'cloudflare', 'site', 'package.json'), 'utf8'));
    assert.match(pin.devDependencies.wrangler, /^\d+\.\d+\.\d+$/, 'wrangler is pinned to one version');
  });
});
