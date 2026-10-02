// The site's 404 Worker (cloudflare/site-404/handler.ts): the bucket's answers pass through; a missing page address
// gets /404.html with status 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, wantsPage, NOT_FOUND_CACHE } from '../cloudflare/site-404/handler.ts';

// A stand-in for the bucket behind its custom domain: exact keys only, R2's plain 404 otherwise.
function bucket(objects: Record<string, string>, opts: { failOn?: string } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: Request | string | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (opts.failOn === path) throw new Error('network');
    const body = objects[path];
    if (body === undefined) return new Response('Object not found', { status: 404, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', etag: '"abc"' } });
  }) as typeof fetch;
  return { fetcher, calls };
}
const site = { '/index.html': 'home', '/lakeland/index.html': 'lakeland', '/404.html': '<h1>Nothing on this channel</h1>' };
const get = (path: string, method = 'GET') => new Request(`https://vaultlearninggames-staging.org${path}`, { method });

test('wantsPage: page addresses, not files', () => {
  for (const p of ['/', '/nope/', '/a/b/c', '/nope/index.html', '/game-cards/category/Dev:+Field+Day+Lab/index.html', '/old.htm']) assert.equal(wantsPage('GET', p), true, p);
  for (const p of ['/sq/img/site/nope.jpg', '/favicon.ico', '/sitemap.xml', '/files/x.pdf', '/robots.txt']) assert.equal(wantsPage('GET', p), false, p);
  assert.equal(wantsPage('HEAD', '/nope/'), true);
  assert.equal(wantsPage('POST', '/nope/'), false);
});

test('an existing page passes through untouched, with one request to the bucket', async () => {
  const b = bucket(site);
  const r = await handle(get('/lakeland/index.html'), b.fetcher);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'lakeland');
  assert.equal(r.headers.get('etag'), '"abc"');
  assert.deepEqual(b.calls, ['GET /lakeland/index.html']);
});

test('a missing page, at any depth, gets the site page with status 404', async () => {
  for (const path of ['/nope/index.html', '/a/b/c/index.html', '/a/b/c']) {
    const b = bucket(site);
    const r = await handle(get(path), b.fetcher);
    assert.equal(r.status, 404, path);
    assert.match(await r.text(), /Nothing on this channel/);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), NOT_FOUND_CACHE);
    assert.deepEqual(b.calls, [`GET ${path}`, 'GET /404.html']);
  }
});

test('HEAD: status 404, the page type, no body', async () => {
  const r = await handle(get('/nope/index.html', 'HEAD'), bucket(site).fetcher);
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await r.text(), '');
});

test('a missing file, or anything but GET and HEAD, keeps the bucket\'s answer', async () => {
  for (const [path, method] of [['/sq/img/nope.jpg', 'GET'], ['/nope/', 'POST']] as const) {
    const b = bucket(site);
    const r = await handle(get(path, method), b.fetcher);
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'Object not found');
    assert.equal(b.calls.length, 1);
  }
});

test('no 404.html in the bucket, or it can\'t be fetched: the bucket\'s answer, never an error', async () => {
  const empty = await handle(get('/nope/'), bucket({ '/index.html': 'home' }).fetcher);
  assert.equal(empty.status, 404);
  assert.equal(await empty.text(), 'Object not found');
  const broken = await handle(get('/nope/'), bucket(site, { failOn: '/404.html' }).fetcher);
  assert.equal(broken.status, 404);
  assert.equal(await broken.text(), 'Object not found');
  // /404.html itself missing must not ask for itself again.
  const b = bucket({});
  await handle(get('/404.html'), b.fetcher);
  assert.deepEqual(b.calls, ['GET /404.html']);
});
