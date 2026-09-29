import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { createApp } from '../src/app.ts';
import type { Verifier } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { signSession } from '../src/portal/session.ts';
import { browseKeys, type Storage } from '../src/storage.ts';

class FakeStorage implements Storage {
  objects = new Map<string, number>();
  data = new Map<string, Uint8Array>();
  headers = new Map<string, ObjectHeaders>();
  async presignPut(key: string) { return `https://r2.test/${key}`; }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })); }
  async browse(prefix: string) { return browseKeys(this.objects, prefix); }
  async copy(src: string, dst: string, headers: ObjectHeaders) { await this.put(dst, this.data.get(src)!, this.objects.get(src)!, headers); }
  async deleteKeys(keys: string[]) { for (const k of keys) this.objects.delete(k); }
  async get(key: string) { return this.data.get(key)!; }
  async put(key: string, body: Readable | Uint8Array, size: number, h: ObjectHeaders) {
    this.objects.set(key, size);
    this.headers.set(key, h);
    this.data.set(key, body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await (body as Readable).toArray())));
  }
}

const SECRET = 'test-session-secret';
const verifier: Verifier = { async github() { throw new Error('no'); }, async google() { throw new Error('no'); } };
let db: Db, production: FakeStorage, app: ReturnType<typeof createApp>;
const deps = (): Parameters<typeof createApp>[0] => ({
  db, staging: new FakeStorage(), production, verifier,
  stagingPublicUrl: 'https://stg.test', prodPublicUrl: 'https://prod.test',
  adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
  previewRetentionDays: 90, taskInvokerEmail: 'x@y',
  portal: { baseUrl: 'https://portal.test', sessionSecret: SECRET, vaultAdmins: ['boss'],
    oauth: { authorizeUrl: () => 'https://github.test/', exchange: async (code: string) => ({ github_id: `id-${code}`, login: code, name: null, avatar_url: null }) } },
});

function as(login: string, vaultRole: 'none' | 'release_manager' | 'admin' = 'none', studioRole?: 'viewer' | 'maintainer' | 'admin') {
  const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
  db.setVaultRole(u.id, vaultRole);
  if (studioRole) db.setMembership(db.studioBySlug('fieldday')!.id, login, studioRole, 'test');
  const headers = { Cookie: `vault_session=${signSession(u.id, SECRET)}`, 'X-Requested-With': 'vault-portal' };
  return {
    get: (path: string) => app.request(path, { headers }),
    post: (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    upload: (kind: string, body: Uint8Array, slug = 'wake', studio = 'fieldday') =>
      app.request(`/portal/api/s/${studio}/listings/${slug}/images/${kind}`, { method: 'POST', body: body as Uint8Array<ArrayBuffer>, headers: { ...headers, 'Content-Type': 'image/png' } }),
  };
}

const L = '/portal/api/s/fieldday/listings';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 20, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 1, 2, 3]);
const sized = (n: number) => { const b = new Uint8Array(n); b.set(PNG); return b; };
const MB = 1024 * 1024;
const draft = () => db.listing('wake')!.draft;
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeEach(async () => {
  db = new Db(':memory:');
  db.syncStudios([{ slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
    { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' }]);
  production = new FakeStorage();
  app = createApp(deps());
  const boss = as('boss', 'release_manager');
  assert.equal((await boss.post(L, { slug: 'wake', title: 'Wake' })).status, 200);
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', hero_image: 'games/wake/img/hero.png', publish: true })).status, 200);
});

describe('listing image uploads', () => {
  test('who may upload: whoever may edit the draft', async () => {
    assert.equal((await as('mia', 'none', 'maintainer').upload('hero', PNG)).status, 200);
    assert.equal((await as('ada', 'none', 'admin').upload('thumb', PNG)).status, 200);
    assert.equal((await as('boss', 'release_manager').upload('screenshot', PNG)).status, 200);
    const viewer = await as('vera', 'none', 'viewer').upload('hero', WEBP);
    assert.equal(viewer.status, 403);
    assert.match(await errorOf(viewer), /maintainers, admins and Vault staff/);
    assert.equal((await as('zed').upload('hero', WEBP)).status, 403, 'signed in, not in the studio');
    assert.equal((await as('mia', 'none', 'maintainer').upload('hero', PNG, 'wake', 'ucalgary')).status, 404, 'wrong studio for the listing');
    assert.equal((await as('mia', 'none', 'maintainer').upload('hero', PNG, 'nope')).status, 404);
    assert.equal((await as('mia', 'none', 'maintainer').upload('banner', PNG)).status, 404, 'unknown kind');
    assert.equal((await app.request(`${L}/wake/images/hero`, { method: 'POST', body: PNG as Uint8Array<ArrayBuffer>, headers: { 'X-Requested-With': 'vault-portal' } })).status, 401);
    // Nothing was stored for the refused uploads.
    assert.equal(production.objects.size, 3);
  });

  test('files are checked by content and size', async () => {
    const mia = as('mia', 'none', 'maintainer');
    const svg = await mia.upload('hero', new TextEncoder().encode('<svg onload="alert(1)"></svg>'));
    assert.equal(svg.status, 400, 'an image/png Content-Type doesn’t make it one');
    assert.match(await errorOf(svg), /PNG, JPEG or WebP/);
    assert.equal((await mia.upload('hero', new Uint8Array())).status, 400);
    assert.equal((await mia.upload('hero', sized(5 * MB + 1))).status, 413);
    assert.equal((await mia.upload('hero', sized(3 * MB))).status, 200, 'hero images may be up to 5 MB');
    const big = await mia.upload('thumb', sized(2 * MB + 1));
    assert.equal(big.status, 413);
    assert.match(await errorOf(big), /at most 2 MB/);
    assert.equal((await mia.upload('screenshot', sized(2 * MB + 1))).status, 413);
    assert.equal(production.objects.size, 1);
  });

  test('stored at STUDIO/GAME/_vault-assets/KIND-HASH.EXT, immutable, and put into the draft only', async () => {
    const mia = as('mia', 'none', 'maintainer');
    const hero = (await (await mia.upload('hero', WEBP)).json()) as { url: string; field: string; value: string };
    assert.match(hero.url, /^https:\/\/prod\.test\/fieldday\/wake\/_vault-assets\/hero-[0-9a-f]{16}\.webp$/);
    assert.deepEqual([hero.field, hero.value], ['hero_image', hero.url]);
    const key = hero.url.slice('https://prod.test/'.length);
    assert.deepEqual(production.headers.get(key), { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
    assert.deepEqual(production.data.get(key), WEBP);

    const thumb = ((await (await mia.upload('thumb', JPEG)).json()) as { url: string }).url;
    assert.match(thumb, /\/fieldday\/wake\/_vault-assets\/thumb-[0-9a-f]{16}\.jpg$/);
    assert.equal(production.headers.get(thumb.slice(18))?.contentType, 'image/jpeg');
    const s1 = ((await (await mia.upload('screenshot', PNG)).json()) as { url: string }).url;
    const s2 = ((await (await mia.upload('screenshot', WEBP)).json()) as { url: string }).url;
    assert.match(s1, /\/_vault-assets\/screenshot-[0-9a-f]{16}\.png$/);
    assert.equal((await (await mia.upload('screenshot', PNG)).json() as { value: string[] }).value.length, 2, 'the same file twice is one screenshot');

    const d = draft();
    assert.equal(d.hero_image, hero.url);
    assert.equal(d.thumb_image, thumb);
    assert.deepEqual(d.screenshots, [s1, s2]);
    assert.equal(db.listing('wake')!.published!.hero_image, 'games/wake/img/hero.png', 'the site keeps the published image until Vault publishes');

    // Replacing the hero image keeps the old object: drafts and published versions may still use it.
    const hero2 = ((await (await mia.upload('hero', PNG)).json()) as { url: string }).url;
    assert.notEqual(hero2, hero.url);
    assert.ok(production.objects.has(key));
    assert.equal(draft().hero_image, hero2);

    // Removing and reordering screenshots, and typed paths, still go through the normal save.
    assert.equal((await mia.post(`${L}/wake`, { screenshots: `${s2}\ngames/wake/img/1.png`, thumb_image: 'games/wake/img/thumb.png' })).status, 200);
    assert.deepEqual(draft().screenshots, [s2, 'games/wake/img/1.png']);
    assert.equal(draft().thumb_image, 'games/wake/img/thumb.png');
  });

  test('uploads go through the usual submit → Vault publish review', async () => {
    const mia = as('mia', 'none', 'maintainer');
    const boss = as('boss', 'release_manager');
    const url = ((await (await mia.upload('hero', PNG)).json()) as { url: string }).url;
    assert.match(await (await mia.get('/s/fieldday/g/wake')).text(), /Not on the site yet:<\/b> Hero image/);
    assert.equal((await mia.post(`${L}/wake`, { submit: true })).status, 200);
    assert.equal(db.listing('wake')!.review, 'submitted');
    // An upload while waiting for Vault changes the draft Vault will publish, and doesn't withdraw the submission.
    const shot = ((await (await mia.upload('screenshot', WEBP)).json()) as { url: string }).url;
    assert.equal(db.listing('wake')!.review, 'submitted');
    assert.equal((await boss.post(`${L}/wake/publish`)).status, 200);
    const games = ((await (await app.request('/v1/catalog')).json()) as { games: any[] }).games;
    assert.equal(games[0].hero_image, url);
    assert.deepEqual(games[0].screenshots, [shot]);
    assert.ok(db.auditFor(['listing.image'], 10).length >= 2);
  });

  test('the editor offers uploads to editors, with previews; without the CDN storage it says so (503)', async () => {
    const mia = as('mia', 'none', 'maintainer');
    await mia.upload('hero', PNG);
    const page = await (await mia.get('/s/fieldday/g/wake')).text();
    for (const kind of ['hero', 'thumb', 'screenshot']) assert.match(page, new RegExp(`data-upload-image="/portal/api/s/fieldday/listings/wake/images/${kind}"`));
    assert.match(page, /<img class="feat-thumb" src="https:\/\/prod\.test\/fieldday\/wake\/_vault-assets\/hero-/);
    assert.match(page, /name="hero_image" value="https:\/\/prod\.test\//);
    assert.doesNotMatch(await (await as('vera', 'none', 'viewer').get('/s/fieldday/g/wake')).text(), /data-upload-image/);

    app = createApp({ ...deps(), production: null });
    const none = await mia.upload('hero', PNG);
    assert.equal(none.status, 503);
    assert.match(await errorOf(none), /isn’t configured/);
    assert.match(await (await mia.get('/s/fieldday/g/wake')).text(), /Uploads need the Vault CDN storage/);
  });
});
