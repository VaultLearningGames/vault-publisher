import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { portalHarness } from './portal-harness.ts';

const L = '/portal/api/s/fieldday/listings';
const M = '/portal/api/vault/listings/migrate-images';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 20, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 7]);
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);

// The site: paths → files. Everything else is a 404.
const site: Record<string, Uint8Array> = {
  'https://site.test/games/wake/img/hero.png': PNG,
  'https://site.test/games/wake/img/thumb.webp': WEBP,
  'https://site.test/games/wake/img/1.jpg': JPEG,
  'https://site.test/games/wake/img/old.svg': new TextEncoder().encode('<svg/>'),
  'https://site.test/images/featured/wake.webp': WEBP,
};
let fetched: string[] = [];
const fakeFetch = (async (url: string | URL) => {
  fetched.push(String(url));
  const b = site[String(url)];
  return b ? new Response(b as Uint8Array<ArrayBuffer>) : new Response('nope', { status: 404 });
}) as typeof fetch;

let t: ReturnType<typeof portalHarness>;
type Result = { migrated: number; already: number; failed: number; external: number; objects_written: number };

beforeEach(async () => {
  fetched = [];
  t = portalHarness({ fetch: fakeFetch, siteUrl: 'https://vaultlearninggames.org' });
  const boss = t.as('boss', 'admin');
  await boss.post(L, { slug: 'wake', title: 'Wake' });
  // Published with site paths (as imported), then a draft edit that adds a screenshot.
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', hero_image: 'games/wake/img/hero.png', thumb_image: '/games/wake/img/thumb.webp',
    screenshots: 'games/wake/img/1.jpg\nhttps://youtube.test/still.png\ngames/wake/img/missing.png', publish: true })).status, 200);
  assert.equal((await boss.post(`${L}/wake`, { screenshots: 'games/wake/img/1.jpg\nhttps://youtube.test/still.png\ngames/wake/img/missing.png\ngames/wake/img/old.svg' })).status, 200);
  await boss.post('/portal/api/vault/featured', { op: 'feature', slug: 'wake', featured: true });
  await boss.post('/portal/api/vault/featured', { op: 'set', slug: 'wake', image: 'images/featured/wake.webp', blurb: 'Dive!' });
});

describe('copying site images to the Vault CDN', () => {
  test('site paths are downloaded, stored like uploads and relinked; external links left alone', async () => {
    const before = t.db.listing('wake')!;
    const boss = t.as('boss', 'admin');
    const res = await boss.post(M, { base: 'https://site.test/' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, migrated: 7, already: 0, failed: 3, external: 2, objects_written: 4 } satisfies Result & { ok: true });

    const cdn = (kind: string, b: Uint8Array, ext: string) => `https://prod.test/fieldday/wake/_vault-assets/${kind}-${hash(b)}.${ext}`;
    const after = t.db.listing('wake')!;
    assert.equal(after.published!.hero_image, cdn('hero', PNG, 'png'));
    assert.equal(after.published!.thumb_image, cdn('thumb', WEBP, 'webp'));
    assert.deepEqual(after.published!.screenshots, [cdn('screenshot', JPEG, 'jpg'), 'https://youtube.test/still.png', 'games/wake/img/missing.png']);
    assert.deepEqual(after.draft.screenshots, [cdn('screenshot', JPEG, 'jpg'), 'https://youtube.test/still.png', 'games/wake/img/missing.png', 'games/wake/img/old.svg']);
    assert.equal(after.draft.hero_image, after.published!.hero_image);
    // Same headers as an upload; one object per image.
    assert.deepEqual(t.production.headers.get(`fieldday/wake/_vault-assets/hero-${hash(PNG)}.png`), { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' });
    assert.equal(t.production.objects.size, 4);
    // Each distinct path is downloaded once.
    assert.equal(fetched.length, new Set(fetched).size);
    assert.ok(fetched.includes('https://site.test/games/wake/img/thumb.webp'), 'a leading / is still a path on the site');

    // Nothing else about the published listing changed, and it needs no new review.
    const { published: p0, draft: d0, ...rest0 } = before;
    const { published: p1, draft: d1, ...rest1 } = after;
    assert.deepEqual(rest1, rest0);
    for (const k of Object.keys(p0!) as (keyof typeof p0 & string)[]) if (!['hero_image', 'thumb_image', 'screenshots'].includes(k)) assert.deepEqual(p1![k], p0![k]);
    assert.ok(!(await (await boss.get('/s/fieldday/g/wake')).text()).includes('Not on the site yet:</b> Hero'));

    // Featured image too; catalog shows the new URLs.
    const cat = (await (await t.app.request('/v1/catalog')).json()) as any;
    assert.deepEqual(cat.featured[0], { slug: 'wake', blurb: 'Dive!', image: cdn('featured', WEBP, 'webp'), sequence: 1 });
    assert.equal(cat.games[0].hero_image, cdn('hero', PNG, 'png'));

    // The summary on the page, and one audit entry with counts.
    const page = await (await boss.get('/vault/listings')).text();
    assert.match(page, /<b>7<\/b> migrated \(4 new files\), <b>0<\/b> already on the CDN, <b>3<\/b> failed, <b>2<\/b> external links left alone/);
    assert.match(page, /HTTP 404 from https:\/\/site\.test\/games\/wake\/img\/missing\.png/);
    assert.match(page, /not a PNG, JPEG or WebP image/);
    const audits = t.db.auditFor(['listing.images.migrate'], 10);
    assert.equal(audits.length, 1);

    // Running it again changes nothing and writes nothing.
    const puts = t.production.puts;
    const snapshot = JSON.stringify(t.db.listing('wake'));
    const again = (await (await boss.post(M, { base: 'https://site.test' })).json()) as Result;
    assert.deepEqual({ ...again, failed: 0 }, { ok: true, migrated: 0, already: 7, failed: 0, external: 2, objects_written: 0 } as any);
    assert.equal(again.failed, 3, 'the missing ones are still reported');
    assert.equal(t.production.puts, puts);
    assert.equal(JSON.stringify(t.db.listing('wake')), snapshot);
  });

  test('an object that already exists isn’t written again (e.g. uploaded before)', async () => {
    const key = `fieldday/wake/_vault-assets/hero-${hash(PNG)}.png`;
    await t.production.put(key, PNG, PNG.length, { contentType: 'image/png', cacheControl: 'x' });
    const puts = t.production.puts;
    await t.as('boss', 'admin').post(M, { base: 'https://site.test' });
    assert.equal(t.production.headers.get(key)?.cacheControl, 'x', 'left as it was');
    assert.equal(t.production.puts, puts + 3);
    assert.equal(t.db.listing('wake')!.published!.hero_image, `https://prod.test/${key}`);
  });

  test('Vault admins only; needs the CDN storage; the site address defaults to SITE_URL', async () => {
    assert.equal((await t.as('rm', 'release_manager').post(M, { base: 'https://site.test' })).status, 403);
    assert.equal((await t.as('ada', 'none', 'admin').post(M, { base: 'https://site.test' })).status, 403);
    assert.equal((await t.as('boss', 'admin').post(M, { base: 'ftp://site.test' })).status, 400);
    assert.match(await (await t.as('boss', 'admin').get('/vault/listings')).text(), /name="base" value="https:\/\/vaultlearninggames\.org"/);
    assert.doesNotMatch(await (await t.as('rm', 'release_manager').get('/vault/listings')).text(), /Copy site images/);
    t.rebuild({ production: null });
    assert.equal((await t.as('boss', 'admin').post(M, { base: 'https://site.test' })).status, 503);
    assert.equal(t.db.listing('wake')!.published!.hero_image, 'games/wake/img/hero.png');
  });
});
