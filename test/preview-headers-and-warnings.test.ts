import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { PREVIEW_HEADERS } from '../src/portal/site-preview.ts';
import { portalHarness } from './portal-harness.ts';

const get = (port: number, path: string) => new Promise<{ status: number; len: number | undefined; got: number }>((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path, agent: false }, (r) => {
    let got = 0;
    r.on('data', (d) => (got += d.length));
    r.on('end', () => resolve({ status: r.statusCode ?? 0, len: r.headers['content-length'] ? Number(r.headers['content-length']) : undefined, got }));
    r.on('error', reject);
  }).on('error', reject);
});

test('preview answers of different sizes are not truncated by a stale Content-Length (the 502)', async () => {
  const t = portalHarness({});
  const srv = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const bad = '/_preview/short/';
    const unknown = '/_preview/' + 'a'.repeat(43) + '/';
    for (const p of [bad, unknown, bad, unknown, bad]) {
      const r = await get(port, p);
      assert.equal(r.status, 404, p);
      assert.equal(r.got, r.len, `${p}: body is ${r.got} bytes, Content-Length ${r.len}`);
    }
    assert.ok(!Object.keys(PREVIEW_HEADERS).some((k) => k.toLowerCase() === 'content-length'), 'shared headers must not gain Content-Length');
  } finally {
    srv.close();
  }
});

test('portal warns next to addresses that will not work while the game is unpublished', async () => {
  const t = portalHarness({});
  const boss = t.as('boss', 'release_manager');
  const L = '/portal/api/s/fieldday/listings';
  assert.equal((await boss.post(L, { slug: 'wake', title: 'Wake' })).status, 200);
  const page = async () => (await (await boss.get('/s/fieldday/g/wake')).text());
  assert.match(await page(), /Not published yet/);
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', short_description: 'x.', publish: true })).status, 200);
  assert.doesNotMatch(await page(), /Not published yet/);
});
