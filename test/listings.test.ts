import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { createApp } from '../src/app.ts';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import { fieldsFromPage } from '../src/listings-import.ts';
import { normalize, problems } from '../src/listings.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { signSession } from '../src/portal/session.ts';
import { browseKeys, type Storage } from '../src/storage.ts';

class FakeStorage implements Storage {
  objects = new Map<string, number>();
  data = new Map<string, Uint8Array>();
  async presignPut(key: string) { return `https://r2.test/${key}`; }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })); }
  async browse(prefix: string) { return browseKeys(this.objects, prefix); }
  async copy(src: string, dst: string, headers: ObjectHeaders) { await this.put(dst, this.data.get(src) ?? new Uint8Array(this.objects.get(src)!), this.objects.get(src)!, headers); }
  async deleteKeys(keys: string[]) { for (const k of keys) this.objects.delete(k); }
  async get(key: string) { return this.data.get(key) ?? new Uint8Array(this.objects.get(key)!); }
  async put(key: string, body: Readable | Uint8Array, size: number, _h: ObjectHeaders) {
    this.objects.set(key, size);
    this.data.set(key, body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await (body as Readable).toArray())));
  }
}

const SECRET = 'test-session-secret';
const wake: GitHubIdentity = { owner: 'fielddaylab', ownerId: '1881825', repository: 'fielddaylab/wake', repositoryId: '100', ref: 'refs/tags/v1.0', sha: 'abc1234', actor: 'dev', eventName: 'push' };
const adminId: GitHubIdentity = { owner: 'VaultLearningGames', ownerId: '214136763', repository: 'VaultLearningGames/vault-publisher', repositoryId: '900', ref: 'refs/heads/main', sha: 'fff0000', actor: 'boss', eventName: 'workflow_dispatch', environment: 'production' };
const ids: Record<string, GitHubIdentity> = {};
const verifier: Verifier = { async github(t) { const id = t === 'wake' ? wake : t === 'admin' ? adminId : ids[t]; if (!id) throw new Error('bad'); return id; }, async google() { throw new Error('no'); } };

let db: Db, staging: FakeStorage, app: ReturnType<typeof createApp>;
beforeEach(async () => {
  db = new Db(':memory:');
  db.syncStudios([{ slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
    { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' }]);
  staging = new FakeStorage();
  app = createApp({
    db, staging, production: new FakeStorage(), verifier,
    stagingPublicUrl: 'https://stg.test', prodPublicUrl: 'https://prod.test',
    adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
    previewRetentionDays: 90, taskInvokerEmail: 'x@y',
    portal: { baseUrl: 'https://portal.test', sessionSecret: SECRET, vaultAdmins: ['boss'],
      oauth: { authorizeUrl: () => 'https://github.test/', exchange: async (code) => ({ github_id: `id-${code}`, login: code, name: null, avatar_url: null }) } },
  });
  // aqualab v1.0 on staging, through the normal CI path.
  const start = await app.request('/v1/previews', { method: 'POST', headers: { Authorization: 'Bearer wake', 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'aqualab', files: [{ path: 'index.html', size: 5 }] }) });
  const j = (await start.json()) as { upload_id: string };
  staging.objects.set('fieldday/aqualab/v1.0/index.html', 5);
  await app.request(`/v1/previews/${j.upload_id}/finalize`, { method: 'POST', headers: { Authorization: 'Bearer wake' } });
});

function as(login: string, vaultRole: 'none' | 'release_manager' | 'admin' = 'none', studioRole?: 'viewer' | 'maintainer' | 'admin') {
  const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
  db.setVaultRole(u.id, vaultRole);
  if (studioRole) db.setMembership(db.studioBySlug('fieldday')!.id, login, studioRole, 'test');
  const cookie = `vault_session=${signSession(u.id, SECRET)}`;
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, body: unknown = {}) =>
      app.request(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' }, body: JSON.stringify(body) }),
  };
}
const L = '/portal/api/s/fieldday/listings';
const catalog = async () => ((await (await app.request('/v1/catalog')).json()) as { games: any[] }).games;

describe('listing fields', () => {
  test('forms and imports are cleaned up', () => {
    const f = normalize({ title: '  Wake  ', subjects: 'Science, Math, Science', 'grades:Grades 5-8': true, 'grades:Grades 9-12': false, embed: 'false', screenshots: 'a.png\n\nb.png' });
    assert.equal(f.title, 'Wake');
    assert.deepEqual(f.subjects, ['Science', 'Math']);
    assert.deepEqual(f.grades, ['Grades 5-8']);
    assert.equal(f.embed, false);
    assert.deepEqual(f.screenshots, ['a.png', 'b.png']);
  });
  test('problems explain what blocks saving and publishing', () => {
    const f = normalize({ play_url: 'javascript:alert(1)', hero_image: '../../etc/passwd', fit: '1,2,3' });
    const p = problems(f, { forPublish: true, cdnReady: false });
    assert.ok(p.some((m) => m.includes('play URL')));
    assert.ok(p.some((m) => m.includes('hero image')));
    assert.ok(p.some((m) => m.includes('Player fit')));
    assert.ok(p.some((m) => m.includes('title')));
  });
  test('Hugo front matter maps to listing fields, with overrides', () => {
    const f = fieldsFromPage({ slug: 'wake', title: 'Wake', params: { about_this_game: 'A kelp game', makers: ['Field Day Lab'], standards: '', game_url: 'https://old', grades: ['Grades 5-8'], screenshots: ['/games/wake/img/1.webp'] } },
      { play_url: 'https://new/', embed: false });
    assert.equal(f.about, 'A kelp game');
    assert.deepEqual(f.standards, []);
    assert.equal(f.play_url, 'https://new/');
    assert.equal(f.embed, false);
  });
});

describe('studios edit, Vault publishes', () => {
  test('a maintainer creates, edits and submits; a release manager publishes; the catalog shows it', async () => {
    const mia = as('mia', 'none', 'maintainer');
    assert.equal((await mia.post(L, { slug: 'wake', title: 'Wake' })).status, 200);
    assert.equal((await mia.post(`${L}/wake`, { short_description: 'Kelp!', play_url: 'https://fielddaylab.wisc.edu/play/wake/', 'grades:Grades 5-8': true, submit: true })).status, 200);
    assert.equal(db.listing('wake')!.review, 'submitted');
    assert.deepEqual(await catalog(), [], 'nothing is public before Vault publishes');
    // A maintainer can't publish.
    assert.equal((await mia.post(`${L}/wake/publish`)).status, 403);
    const boss = as('boss', 'release_manager');
    assert.match(await (await boss.get('/vault/listings')).text(), /Waiting for Vault \(1\)/);
    assert.equal((await boss.post(`${L}/wake/publish`)).status, 200);
    const [g] = await catalog();
    assert.equal(g.slug, 'wake');
    assert.deepEqual(g.studio, { slug: 'fieldday', name: 'Field Day Lab' });
    assert.deepEqual(g.makers, ['Field Day Lab']);
    assert.deepEqual(g.grades, ['Grades 5-8']);
    assert.deepEqual(g.play, { url: 'https://fielddaylab.wisc.edu/play/wake/', source: 'url', release: null, embed: true, fit: null });
    // Later edits don't reach the site until they're published.
    await mia.post(`${L}/wake`, { short_description: 'Changed' });
    assert.equal((await catalog())[0].short_description, 'Kelp!');
    assert.match(await (await mia.get('/s/fieldday')).text(), /Unpublished changes/);
    assert.equal((await mia.get('/s/fieldday/listings/wake')).headers.get('location'), '/s/fieldday/g/wake', 'old listing pages redirect');
  });

  test('viewers and other studios can’t edit; the portal header is required', async () => {
    await as('boss', 'admin').post(L, { slug: 'wake', title: 'Wake' });
    assert.equal((await as('vera', 'none', 'viewer').post(`${L}/wake`, { title: 'Nope' })).status, 403);
    assert.equal((await as('stranger').post(`${L}/wake`, { title: 'Nope' })).status, 404);
    const mia = as('mia', 'none', 'maintainer');
    const noHeader = await app.request(`${L}/wake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    assert.equal((await mia.post(L, { slug: 'wake', title: 'Again' })).status, 409, 'page addresses are unique');
    assert.equal((await mia.post(L, { slug: 'Bad Slug', title: 'x' })).status, 400);
  });

  test('only Vault sets the player fit; Vault sends back with a note and can unpublish', async () => {
    const boss = as('boss', 'release_manager'), mia = as('mia', 'none', 'maintainer');
    await boss.post(L, { slug: 'wake', title: 'Wake' });
    await mia.post(`${L}/wake`, { play_url: 'https://x.test/', fit: '1920,1080,0,0,960,600', submit: true });
    assert.equal(db.listing('wake')!.draft.fit, '');
    assert.equal((await boss.post(`${L}/wake/return`, {})).status, 400, 'a note is required');
    await boss.post(`${L}/wake/return`, { note: 'Add grades' });
    assert.equal(db.listing('wake')!.review, 'returned');
    await boss.post(`${L}/wake`, { fit: '1920,1080,0,0,960,600', publish: true });
    assert.deepEqual((await catalog())[0].play.fit, [1920, 1080, 0, 0, 960, 600]);
    await boss.post(`${L}/wake/unpublish`);
    assert.deepEqual(await catalog(), []);
  });

  test('a listing plays from its connected CDN game’s current release, plus an optional folder', async () => {
    const boss = as('boss', 'release_manager');
    await boss.post(L, { slug: 'aquatic-lab', title: 'Aqualab' });
    await boss.post(`${L}/aquatic-lab`, { play_url: 'https://old.test/', publish: true });
    assert.equal((await boss.post(`${L}/aquatic-lab`, { play_source: 'cdn', publish: true })).status, 400, 'not connected to a CDN game');
    assert.equal((await boss.post(`${L}/aquatic-lab/link`, { game: 'aqualab' })).status, 200);
    assert.equal((await boss.post(`${L}/aquatic-lab`, { play_source: 'cdn', publish: true })).status, 400, 'no release yet');
    assert.equal((await boss.post('/portal/api/s/fieldday/g/aqualab/release', { version: 'v1.0', ref: 'v1.0', makeCurrent: true })).status, 200);
    const page = await (await boss.get('/s/fieldday/g/aquatic-lab')).text();
    assert.match(page, /Switch to the Vault CDN \(v1\.0\)/);
    assert.equal((await boss.get('/s/fieldday/g/aqualab')).headers.get('location'), '/s/fieldday/g/aquatic-lab', 'the CDN game’s page is the listing’s page');
    assert.equal((await boss.post(`${L}/aquatic-lab`, { play_source: 'cdn', cdn_path: 'lab', publish: '1' })).status, 200);
    assert.deepEqual((await catalog())[0].play, { url: 'https://prod.test/fieldday/aqualab/lab/', source: 'cdn', release: 'v1.0', embed: true, fit: null });
    assert.equal((await boss.post(`${L}/aquatic-lab/link`, { game: '' })).status, 400, 'can’t disconnect while playing from it');
  });
});

describe('one list of games per studio', () => {
  test('web-address games, CDN games and connected games appear together', async () => {
    const boss = as('boss', 'release_manager');
    await boss.post(L, { slug: 'jowilder', title: 'Jo Wilder' });
    await boss.post(`${L}/jowilder`, { play_url: 'https://fielddaylab.wisc.edu/play/jowilder/game/', publish: true });
    const list = await (await as('vera', 'none', 'viewer').get('/s/fieldday')).text();
    assert.match(list, /Jo Wilder/);
    assert.match(list, /fielddaylab\.wisc\.edu/);
    assert.match(list, /aqualab/, 'a CDN game without a listing is listed too');
    assert.match(list, /not on the site/);
    assert.match(await (await boss.get('/s/fieldday/g/aqualab?tab=listing')).text(), /Put it on the site/);
    assert.match(await (await boss.get('/s/fieldday/g/jowilder?tab=cdn')).text(), /Not on the Vault CDN yet/);
  });

  test('a studio’s first CI publish of a game connects its listing of the same name', async () => {
    const boss = as('boss', 'release_manager');
    await boss.post(L, { slug: 'bloom', title: 'Bloom' });
    ids.bloom = { ...wake, repository: 'fielddaylab/bloom', repositoryId: '101' };
    const start = await app.request('/v1/previews', { method: 'POST', headers: { Authorization: 'Bearer bloom', 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'bloom', files: [{ path: 'index.html', size: 5 }] }) });
    assert.equal(start.status, 200);
    assert.equal(db.listing('bloom')!.game_id, db.game(db.studioBySlug('fieldday')!.id, 'bloom')!.id);
  });
});

describe('a collection on the CDN', () => {
  test('several site games play from folders of one CDN game (The Yard)', async () => {
    const boss = as('boss', 'release_manager');
    assert.equal((await boss.post('/portal/api/s/fieldday/g/aqualab/release', { version: 'v1.0', ref: 'v1.0', makeCurrent: true })).status, 200);
    for (const [slug, folder] of [['earthquake', 'earthquake'], ['water-cycle-game', 'water']]) {
      await boss.post(L, { slug, title: slug });
      assert.equal((await boss.post(`${L}/${slug}/link`, { game: 'aqualab' })).status, 200);
      assert.equal((await boss.post(`${L}/${slug}`, { play_url: 'https://theyardgames.org/', play_source: 'cdn', cdn_path: `/${folder}`, publish: true })).status, 200);
    }
    const urls = (await catalog()).map((g) => g.play.url).sort();
    assert.deepEqual(urls, ['https://prod.test/fieldday/aqualab/earthquake/', 'https://prod.test/fieldday/aqualab/water/']);
    const page = await (await boss.get('/s/fieldday/g/aqualab')).text();
    assert.match(page, /Site games in this CDN game/, 'the CDN game lists the site games it serves');
  });
});

describe('Vault uploads a game’s current version for a studio', () => {
  const up = (body: unknown, token = 'admin') => app.request('/v1/admin/previews', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  test('creates the CDN game, connects the listing, and the studio’s repo takes it over later', async () => {
    const boss = as('boss', 'release_manager');
    await boss.post(L, { slug: 'legend-of-the-lost-emerald', title: 'The Legend of the Lost Emerald' });
    assert.equal((await up({ studio: 'fieldday', game: 'emerald', ref: 'v1.0', files: [{ path: 'index.html', size: 5 }] }, 'wake')).status, 403, 'studio repos can’t use the Vault path');
    const res = await up({ studio: 'fieldday', game: 'emerald', ref: 'v1.0', listing: 'legend-of-the-lost-emerald', files: [{ path: 'index.html', size: 5 }] });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { upload_id: string; url: string };
    assert.equal(j.url, 'https://stg.test/fieldday/emerald/v1.0/');
    staging.objects.set('fieldday/emerald/v1.0/index.html', 5);
    assert.equal((await app.request(`/v1/admin/previews/${j.upload_id}/finalize`, { method: 'POST', headers: { Authorization: 'Bearer admin' } })).status, 200);
    const fd = db.studioBySlug('fieldday')!;
    const g = db.game(fd.id, 'emerald')!;
    assert.equal(g.repository_id, 'vault:fieldday/emerald');
    assert.equal(db.listing('legend-of-the-lost-emerald')!.game_id, g.id);
    assert.equal((await boss.post('/portal/api/s/fieldday/g/emerald/release', { version: 'v1.0', ref: 'v1.0', makeCurrent: true })).status, 200);
    assert.match(await (await boss.get('/s/fieldday/g/legend-of-the-lost-emerald?tab=cdn')).text(), /uploaded by Vault/);
    // Later the studio's own CI publishes emerald: it takes the game over, releases and all.
    ids.emerald = { ...wake, repository: 'fielddaylab/emerald', repositoryId: '102', ref: 'refs/heads/develop' };
    const ci = await app.request('/v1/previews', { method: 'POST', headers: { Authorization: 'Bearer emerald', 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'emerald', files: [{ path: 'index.html', size: 5 }] }) });
    assert.equal(ci.status, 200);
    assert.equal(db.game(fd.id, 'emerald')!.repository, 'fielddaylab/emerald');
    assert.equal(db.currentRelease(g.id)!.version, 'v1.0');
  });
});

describe('import from the Hugo prototype', () => {
  test('creates listings and missing studios, publishes complete ones, skips repeats', async () => {
    const pages = [
      { slug: 'wake', title: 'Wake', params: { makers: ['Field Day Lab'], game_url: 'https://fielddaylab.wisc.edu/play/wake/', grades: ['Grades 5-8'] } },
      { slug: 'crowds', title: 'Crowds', params: { makers: ['Nicky Case'], game_url: 'https://ncase.me/crowds/' } },
      { slug: 'no-url', title: 'No URL', params: { makers: ['Field Day Lab'] } },
      { slug: 'ztype', title: 'ZType', params: { makers: [] } },
    ];
    const overrides = { ztype: { studio: 'PhobosLab', play_url: 'https://zty.pe/' }, crowds: { fit: '1920,1024,0,0,800,600' } };
    const boss = as('boss', 'admin');
    assert.equal((await as('rm', 'release_manager').post('/portal/api/vault/listings/import', { pages: JSON.stringify(pages) })).status, 403, 'admins only');
    const res = await boss.post('/portal/api/vault/listings/import', { pages: JSON.stringify(pages), overrides: JSON.stringify({ overrides }) });
    const r = (await res.json()) as any;
    assert.deepEqual(r.created.sort(), ['crowds', 'wake', 'ztype']);
    assert.deepEqual(r.drafts.map((d: any) => d.slug), ['no-url']);
    assert.deepEqual(r.studiosCreated.sort(), ['nicky-case', 'phoboslab']);
    assert.equal(db.studioBySlug('phoboslab')!.github_owner_id, 'vault:phoboslab');
    const games = await catalog();
    assert.deepEqual(games.map((g) => g.slug).sort(), ['crowds', 'wake', 'ztype']);
    assert.deepEqual(games.find((g) => g.slug === 'ztype').makers, ['PhobosLab']);
    assert.deepEqual(games.find((g) => g.slug === 'crowds').play.fit, [1920, 1024, 0, 0, 800, 600]);
    const again = (await (await boss.post('/portal/api/vault/listings/import', { pages: JSON.stringify(pages) })).json()) as any;
    assert.equal(again.skipped.length, 4);
    for (const path of ['/vault/listings', '/vault/listings?show=offsite', '/vault/listings?show=ready', '/s/phoboslab', '/s/phoboslab/g/ztype', '/s/phoboslab/g/ztype?tab=cdn']) {
      assert.equal((await boss.get(path)).status, 200, path);
    }
  });
});

describe('featured games on the home page', () => {
  const F = '/portal/api/vault/featured';
  const full = async () => (await (await app.request('/v1/catalog')).json()) as { featured: { slug: string; blurb: string; image: string }[] };
  async function onSite(boss: ReturnType<typeof as>, slug: string, title: string) {
    await boss.post(L, { slug, title });
    assert.equal((await boss.post(`${L}/${slug}`, { short_description: `${title}!`, play_url: `https://example.org/${slug}/`, 'grades:Grades 5-8': true, publish: true })).status, 200);
  }

  test('release managers choose, order and describe them; the catalog publishes them in order', async () => {
    const boss = as('boss', 'release_manager');
    await onSite(boss, 'wake', 'Wake');
    await onSite(boss, 'jowilder', 'Jo Wilder');
    await onSite(boss, 'aqualab', 'Aqualab');
    await boss.post(L, { slug: 'draft-only', title: 'Draft only' });
    assert.deepEqual((await full()).featured, [], 'nothing is featured to begin with');

    for (const slug of ['wake', 'jowilder', 'aqualab']) assert.equal((await boss.post(F, { op: 'add', slug })).status, 200);
    assert.equal((await boss.post(F, { op: 'add', slug: 'wake' })).status, 400, 'no duplicates');
    const off = await boss.post(F, { op: 'add', slug: 'draft-only' });
    assert.equal(off.status, 400);
    assert.match(((await off.json()) as { error: string }).error, /on the site/);

    assert.equal((await boss.post(F, { op: 'move', slug: 'aqualab', to: 0 })).status, 200);
    assert.equal((await boss.post(F, { op: 'set', slug: 'jowilder', blurb: 'Solve *mysteries* in Wisconsin.', image: 'games/jowilder/img/banner.jpg' })).status, 200);
    assert.equal((await boss.post(F, { op: 'set', slug: 'wake', blurb: '', image: 'javascript:alert(1)' })).status, 400, 'images are site paths or https');
    assert.deepEqual((await full()).featured, [
      { slug: 'aqualab', blurb: '', image: '' },
      { slug: 'wake', blurb: '', image: '' },
      { slug: 'jowilder', blurb: 'Solve *mysteries* in Wisconsin.', image: 'games/jowilder/img/banner.jpg' },
    ]);

    // Taking a game off the site drops it from the home page, and it's gone from the list once removed.
    await boss.post(`${L}/wake/unpublish`);
    assert.deepEqual((await full()).featured.map((e) => e.slug), ['aqualab', 'jowilder']);
    assert.match(await (await boss.get('/vault/featured')).text(), /No longer on the site/);
    assert.equal((await boss.post(F, { op: 'remove', slug: 'wake' })).status, 200);
    const page = await (await boss.get('/vault/featured')).text();
    assert.match(page, /1\. Aqualab/);
    assert.match(page, /2\. Jo Wilder/);
    assert.match(page, /Last changed .* by/);
  });

  test('studio members can’t change them or see the page', async () => {
    const boss = as('boss', 'release_manager');
    await onSite(boss, 'wake', 'Wake');
    await boss.post(F, { op: 'add', slug: 'wake' });
    const mia = as('mia', 'none', 'maintainer');
    assert.equal((await mia.post(F, { op: 'remove', slug: 'wake' })).status, 403);
    assert.equal((await mia.get('/vault/featured')).status, 403);
    assert.deepEqual((await full()).featured.map((e) => e.slug), ['wake']);
  });
});
