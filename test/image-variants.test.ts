import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { isOriginalKey, keyOfUrl, variantKey, variantWidths, webpWidth } from '../src/image-variants.ts';
import { portalHarness } from './portal-harness.ts';

const adminId: GitHubIdentity = {
  owner: 'VaultLearningGames', ownerId: '1', repository: 'VaultLearningGames/vault-publisher', repositoryId: '900',
  ref: 'refs/heads/main', sha: 'abc', actor: 'octo', eventName: 'workflow_dispatch', environment: 'production',
};
const verifier: Verifier = {
  async github(token) { if (token !== 'admin') throw new Error('bad signature'); return adminId; },
  async google() { throw new Error('no'); },
};
const L = '/portal/api/s/fieldday/listings';
const HERO = 'fieldday/wake/_vault-assets/hero-0123456789abcdef.png';
const SHOT = 'fieldday/wake/_vault-assets/screenshot-fedcba9876543210.jpg';
const URL_OF = (k: string) => `https://prod.test/${k}`;
const webp = (w: number) => sharp({ create: { width: w, height: Math.round(w / 2), channels: 3, background: '#3a6' } }).webp().toBuffer();

let t: ReturnType<typeof portalHarness>;
const call = (method: 'GET' | 'POST', body?: unknown, token = 'admin') => t.app.request('/v1/admin/image-variants', {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const variantsFor = async (width: number, widths = variantWidths(width)) => Promise.all(widths.map(async (w) => ({ width: w, webp: (await webp(w)).toString('base64') })));

beforeEach(async () => {
  t = portalHarness({ verifier });
  await t.production.put(HERO, new Uint8Array([1]), 1, { contentType: 'image/png', cacheControl: 'x' });
  const boss = t.as('boss', 'admin');
  await boss.post(L, { slug: 'wake', title: 'Wake' });
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', hero_image: URL_OF(HERO), screenshots: `${URL_OF(SHOT)}\nhttps://elsewhere.test/a.png`, publish: true })).status, 200);
});

describe('image variants', () => {
  test('widths, names and keys', () => {
    assert.deepEqual(variantWidths(2500), [320, 480, 640, 960, 1280, 1920]);
    assert.deepEqual(variantWidths(751), [320, 480, 640, 751]);
    assert.deepEqual(variantWidths(960), [320, 480, 640, 960]);
    assert.deepEqual(variantWidths(200), [200]);
    assert.equal(variantKey(HERO, 960), 'fieldday/wake/_vault-assets/hero-0123456789abcdef-960w.webp');
    assert.ok(isOriginalKey('_site/featured/wake-0123456789abcdef.webp'));
    assert.ok(!isOriginalKey(variantKey(HERO, 960)));
    assert.equal(keyOfUrl(URL_OF(HERO), 'https://prod.test/'), HERO);
    assert.equal(keyOfUrl('https://elsewhere.test/a.png', 'https://prod.test'), null);
  });

  test('webpWidth reads lossy and lossless WebP headers', async () => {
    assert.equal(webpWidth(await webp(321)), 321);
    assert.equal(webpWidth(await sharp({ create: { width: 77, height: 5, channels: 4, background: '#0000' } }).webp({ lossless: true }).toBuffer()), 77);
    assert.equal(webpWidth(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  });

  test('admins only', async () => {
    assert.equal((await call('GET', undefined, 'nobody')).status, 401);
  });

  test('lists, stores, records, and the catalog publishes them', async () => {
    let list = await (await call('GET')).json() as any;
    assert.deepEqual(list.images.map((i: any) => [i.url, i.done]), [[URL_OF(HERO), false], [URL_OF(SHOT), false]]);

    // A dry run checks and writes nothing.
    const variants = await variantsFor(1037);
    let res = await call('POST', { url: URL_OF(HERO), width: 1037, height: 854, variants, dry_run: true });
    assert.equal(res.status, 200);
    assert.equal(t.production.objects.size, 1);

    res = await call('POST', { url: URL_OF(HERO), width: 1037, height: 854, variants });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(t.production.headers.get(variantKey(HERO, 1037)), { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
    assert.equal(t.production.objects.size, 1 + 5);
    list = await (await call('GET')).json() as any;
    assert.deepEqual([list.count, list.missing], [2, 1]);

    const cat = await (await t.app.request('/v1/catalog')).json() as any;
    assert.deepEqual(cat.images, {
      [URL_OF(HERO)]: { width: 1037, height: 854, variants: [320, 480, 640, 960, 1037].map((w) => ({ width: w, url: URL_OF(variantKey(HERO, w)) })) },
    });
  });

  test('refuses what it can’t vouch for', async () => {
    const bad = async (body: unknown, status: number) => assert.equal((await call('POST', body)).status, status);
    await bad({ url: 'https://elsewhere.test/a.png', width: 500, height: 300, variants: await variantsFor(500) }, 400);
    await bad({ url: URL_OF(variantKey(HERO, 320)), width: 320, height: 160, variants: await variantsFor(320) }, 400);
    await bad({ url: URL_OF(HERO), width: 1037, height: 854, variants: await variantsFor(1037, [320, 480]) }, 400);           // not every width
    await bad({ url: URL_OF(HERO), width: 500, height: 300, variants: [{ width: 320, webp: Buffer.from('nope').toString('base64') }, { width: 480, webp: (await webp(480)).toString('base64') }, { width: 500, webp: (await webp(500)).toString('base64') }] }, 400);
    await bad({ url: URL_OF(HERO), width: 500, height: 300, variants: [{ width: 320, webp: (await webp(330)).toString('base64') }, { width: 480, webp: (await webp(480)).toString('base64') }, { width: 500, webp: (await webp(500)).toString('base64') }] }, 400);
    await bad({ url: URL_OF(SHOT), width: 500, height: 300, variants: await variantsFor(500) }, 404);                          // not on the CDN
    assert.equal(t.production.objects.size, 1);
  });
});
