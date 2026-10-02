import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSET_CACHE, FIXED_CACHE, PAGE_CACHE, listFiles, planSync, siteHeaders, syncSite } from '../src/site-sync.ts';
import { FakeStorage } from './portal-harness.ts';

function build(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vault-sync-test-'));
  for (const [k, v] of Object.entries(files)) { mkdirSync(join(dir, k, '..'), { recursive: true }); writeFileSync(join(dir, k), v); }
  return dir;
}
const SITE = { 'index.html': '<h1>home</h1>', '404.html': 'nope', 'wake/index.html': 'wake', 'sitemap.xml': '<x/>',
  'game-cards/category/Dev:+Field+Day+Lab/index.html': 'cards', 'sq/css/vault-sq.css': 'body{}', 'sq/js/vault-sq.js': '1',
  'sq/img/site/key-to-vault-min-fc73a9.png': 'png', 'sq/img/site/vault-game-library.png': 'png', 'sq/fonts/archivo-500-latin.woff2': 'f',
  'files/keys-to-the-vault.pdf': '%PDF', 'favicon.ico': 'i' };

describe('publishing the site to its bucket', () => {
  test('types and cache lifetimes: pages a minute, fixed files a month, the rest an hour', () => {
    assert.deepEqual(siteHeaders('wake/index.html'), { contentType: 'text/html; charset=utf-8', cacheControl: PAGE_CACHE });
    assert.deepEqual(siteHeaders('sitemap.xml'), { contentType: 'application/xml', cacheControl: PAGE_CACHE });
    assert.deepEqual(siteHeaders('sq/css/vault-sq.css'), { contentType: 'text/css; charset=utf-8', cacheControl: ASSET_CACHE });
    assert.deepEqual(siteHeaders('sq/js/vault-sq.js'), { contentType: 'text/javascript; charset=utf-8', cacheControl: ASSET_CACHE });
    assert.deepEqual(siteHeaders('sq/img/site/key-to-vault-min-fc73a9.png'), { contentType: 'image/png', cacheControl: FIXED_CACHE });
    assert.deepEqual(siteHeaders('sq/img/site/vault-game-library.png'), { contentType: 'image/png', cacheControl: ASSET_CACHE });
    assert.deepEqual(siteHeaders('sq/fonts/archivo-500-latin.woff2'), { contentType: 'font/woff2', cacheControl: FIXED_CACHE });
    assert.deepEqual(siteHeaders('files/keys-to-the-vault.pdf'), { contentType: 'application/pdf', cacheControl: ASSET_CACHE });
    assert.deepEqual(siteHeaders('favicon.ico'), { contentType: 'image/x-icon', cacheControl: ASSET_CACHE });
    assert.equal(PAGE_CACHE, 'public, max-age=60');
  });

  test('uploads everything, pages last, then deletes what the build no longer has', async () => {
    const dir = build(SITE);
    const bucket = new FakeStorage();
    bucket.objects.set('old-game/index.html', 3);
    bucket.objects.set('index.html', 1);
    const order: string[] = [];
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, body, size, h) => { order.push(key); await put(key, body, size, h); };
    const logs: string[] = [];
    const r = await syncSite(dir, bucket, { concurrency: 1, log: (l) => logs.push(l) });
    assert.equal(r.uploaded, 12);
    assert.deepEqual(r.deleted, ['old-game/index.html']);
    assert.deepEqual([...bucket.objects.keys()].sort(), Object.keys(SITE).sort());
    assert.equal(new TextDecoder().decode(bucket.data.get('index.html')), '<h1>home</h1>');
    assert.deepEqual(bucket.headers.get('game-cards/category/Dev:+Field+Day+Lab/index.html'), { contentType: 'text/html; charset=utf-8', cacheControl: PAGE_CACHE });
    const firstPage = order.findIndex((k) => /\.(html|xml)$/.test(k));
    assert.equal(firstPage, 7, 'the seven assets go first');
    assert.ok(order.slice(firstPage).every((k) => /\.(html|xml)$/.test(k)));
    assert.match(logs[0], /^12 files \(0\.0 MB\) to upload, 1 to delete, 2 in the bucket now$/);
    assert.deepEqual(await listFiles(dir), Object.keys(SITE).sort());
  });

  test('a dry run changes nothing', async () => {
    const bucket = new FakeStorage();
    bucket.objects.set('old/index.html', 3);
    const logs: string[] = [];
    const r = await syncSite(build(SITE), bucket, { dryRun: true, log: (l) => logs.push(l) });
    assert.deepEqual(r, { uploaded: 0, bytes: 0, deleted: [] });
    assert.deepEqual([...bucket.objects.keys()], ['old/index.html']);
    assert.deepEqual(logs.slice(1), ['would delete old/index.html']);
  });

  test('refuses a build that isn’t the site, and a sync that would empty the bucket', async () => {
    assert.throws(() => planSync(['wake/index.html', '404.html'], []), /the build has no index\.html/);
    assert.throws(() => planSync(['index.html'], []), /the build has no 404\.html/);
    const remote = Array.from({ length: 40 }, (_, i) => `g${i}/index.html`);
    assert.throws(() => planSync(['index.html', '404.html'], remote), /would delete 40 of the bucket's 40 objects/);
    assert.equal(planSync(['index.html', '404.html'], remote, { allowMassDelete: true }).deletes.length, 40);
    assert.equal(planSync(['index.html', '404.html', ...remote.slice(0, 30)], remote).deletes.length, 10);
    const bucket = new FakeStorage();
    for (const k of remote) bucket.objects.set(k, 1);
    await assert.rejects(syncSite(build({ 'index.html': 'x', '404.html': 'y' }), bucket), /would delete 40/);
    assert.equal(bucket.objects.size, 40, 'nothing uploaded or deleted');
  });
});
