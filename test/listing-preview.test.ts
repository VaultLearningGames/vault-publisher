import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePreviewSites } from '../src/config.ts';
import { PREVIEW_TTL_MS, PreviewStore } from '../src/portal/listing-preview.ts';
import { portalHarness } from './portal-harness.ts';

const L = '/portal/api/s/fieldday/listings';
const SITES = parsePreviewSites('Squarespace=https://sq.test New=https://new.test/');
let t: ReturnType<typeof portalHarness>;

beforeEach(async () => {
  t = portalHarness({ previewSites: SITES });
  const boss = t.as('boss', 'release_manager');
  assert.equal((await boss.post(L, { slug: 'wake', title: 'Wake' })).status, 200);
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', short_description: 'Old.', publish: true })).status, 200);
});

type Preview = { ok: true; token: string; expires_at: string; urls: { label: string; url: string }[] };
const catalog = async () => (await (await t.app.request('/v1/catalog')).json()) as { studios: unknown[]; games: Record<string, unknown>[] };

describe('PREVIEW_SITES', () => {
  test('space-separated label=url pairs; bad ones skipped', () => {
    assert.deepEqual(SITES, [{ label: 'Squarespace', url: 'https://sq.test' }, { label: 'New', url: 'https://new.test' }]);
    assert.deepEqual(parsePreviewSites(''), []);
    assert.deepEqual(parsePreviewSites(undefined), []);
    assert.deepEqual(parsePreviewSites('nolabel https://x.test =https://y.test A=ftp://z B=https://ok.test'), [{ label: 'B', url: 'https://ok.test' }]);
  });
});

describe('listing previews', () => {
  test('unsaved edits become exactly the catalog game, served once by token, without saving', async () => {
    const mia = t.as('mia', 'none', 'maintainer');
    const before = JSON.stringify(t.db.listing('wake'));
    const res = await mia.post(`${L}/wake/preview`, { title: '  Wake: The Deep  ', short_description: 'New!', subjects: 'Science, Math', 'grades:Grades 5-8': true, embed: 'false', screenshots: 'a.png\nb.png', fit: '1,2,3,4,5,6' });
    assert.equal(res.status, 200);
    const p = (await res.json()) as Preview;
    assert.match(p.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(p.urls, [{ label: 'Squarespace', url: `https://sq.test/_preview/${p.token}/` }, { label: 'New', url: `https://new.test/_preview/${p.token}/` }]);
    assert.equal(JSON.stringify(t.db.listing('wake')), before, 'nothing saved');

    const got = await t.app.request(`/v1/listing-previews/${p.token}`, { headers: { Accept: 'application/json' } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('cache-control'), 'no-store');
    const body = (await got.json()) as { version: number; game: Record<string, any>; studios: unknown[] };
    assert.deepEqual(Object.keys(body), ['version', 'game', 'studios']);
    assert.equal(body.version, 1);
    // The same shape and values as the catalog entry after saving and publishing those edits.
    const c0 = await catalog();
    assert.deepEqual(body.studios, c0.studios);
    await t.as('boss', 'release_manager').post(`${L}/wake`, { title: '  Wake: The Deep  ', short_description: 'New!', subjects: 'Science, Math', 'grades:Grades 5-8': true, embed: 'false', screenshots: 'a.png\nb.png', publish: true });
    const published = (await catalog()).games[0];
    assert.deepEqual({ ...body.game, published_at: null }, { ...published, published_at: null });
    assert.equal(body.game.title, 'Wake: The Deep');
    assert.deepEqual(body.game.studio, { slug: 'fieldday', name: 'Field Day Lab', url: null });
    assert.equal(body.game.play.fit, null, 'player fit is Vault’s: ignored from studio members, as on save');

    assert.equal((await t.app.request('/v1/listing-previews/nope', { headers: { Accept: 'application/json' } })).status, 404);
  });

  test('a CDN game plays from its current release, as in the catalog; studio website included', async () => {
    const fd = t.db.studioBySlug('fieldday')!;
    t.db.setStudioWebsite(fd.id, 'https://fielddaylab.wisc.edu/');
    const g = t.db.createGame(fd.id, 'wake', 'fielddaylab/wake', '100');
    const r = t.db.createRelease({ game_id: g.id, version: 'm3.1', source_ref: 'production', commit_sha: 'a'.repeat(40), file_count: 1, total_bytes: 1, approved_by: 'x' });
    t.db.setCurrentRelease(g.id, r.id);
    t.db.linkListing(t.db.listing('wake')!.id, g.id);
    const p = (await (await t.as('mia', 'none', 'maintainer').post(`${L}/wake/preview`, { play_source: 'cdn', cdn_path: 'deep' })).json()) as Preview;
    const { game } = (await (await t.app.request(`/v1/listing-previews/${p.token}`, { headers: { Accept: 'application/json' } })).json()) as { game: any };
    assert.deepEqual(game.play, { url: 'https://prod.test/fieldday/wake/deep/', source: 'cdn', release: 'm3.1', embed: true, fit: null, min_width: null, min_height: null });
    assert.equal(game.studio.url, t.db.studioBySlug('fieldday')!.website);
    assert.match(game.studio.url, /^https:\/\/fielddaylab\.wisc\.edu/);
  });

  test('who may preview: whoever may edit the draft; bad fields fail as a save would; no sites → 503', async () => {
    assert.equal((await t.as('ada', 'none', 'admin').post(`${L}/wake/preview`, {})).status, 200);
    assert.equal((await t.as('boss', 'release_manager').post(`${L}/wake/preview`, {})).status, 200);
    assert.equal((await t.as('vera', 'none', 'viewer').post(`${L}/wake/preview`, {})).status, 403);
    assert.equal((await t.as('zed').post(`${L}/wake/preview`, {})).status, 403);
    assert.equal((await t.as('mia', 'none', 'maintainer').post('/portal/api/s/ucalgary/listings/wake/preview', {})).status, 404);
    const bad = await t.as('mia', 'none', 'maintainer').post(`${L}/wake/preview`, { play_url: 'javascript:alert(1)' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /play URL/);

    const page = await (await t.as('mia', 'none', 'maintainer').get('/s/fieldday/g/wake')).text();
    assert.match(page, /data-preview="\/portal\/api\/s\/fieldday\/listings\/wake\/preview" data-site="0"[^>]*>Preview</);
    assert.match(page, /data-site="1"[^>]*>Preview \(New\)</);
    t.rebuild({ previewSites: [] });
    assert.equal((await t.as('mia', 'none', 'maintainer').post(`${L}/wake/preview`, {})).status, 503);
    assert.doesNotMatch(await (await t.as('mia', 'none', 'maintainer').get('/s/fieldday/g/wake')).text(), /data-preview/);
  });

  test('previews expire after 30 minutes, and only so many are kept', () => {
    let now = 1_000;
    const store = new PreviewStore(() => now);
    const body = { version: 1 as const, game: {} as any, studios: [] };
    const { token } = store.put(body);
    assert.equal(store.get(token), body);
    now += PREVIEW_TTL_MS;
    assert.equal(store.get(token), undefined);
    const first = store.put(body).token;
    for (let i = 0; i < 600; i++) store.put(body);
    assert.equal(store.size, 500);
    assert.equal(store.get(first), undefined, 'the oldest go first');
  });
});

describe('save and publish', () => {
  test('Vault staff get one “Save and Publish Changes” button that saves and publishes', async () => {
    const boss = t.as('boss', 'release_manager');
    const page = await (await boss.get('/s/fieldday/g/wake')).text();
    assert.match(page, />Save and Publish Changes</);
    assert.doesNotMatch(page, /Publish to the site when saved/);
    assert.match(page, /<input type="hidden" name="publish" value="1">/);
    // What the page's form sends:
    assert.equal((await boss.post(`${L}/wake`, { title: 'Wake 2', publish: '1' })).status, 200);
    assert.equal(t.db.listing('wake')!.published!.title, 'Wake 2');
  });

  test('every studio save goes to Vault for review', async () => {
    const mia = t.as('mia', 'none', 'maintainer');
    const page = await (await mia.get('/s/fieldday/g/wake')).text();
    assert.match(page, /<button class="btn pri">Save and Submit for Review<\/button>/);
    assert.doesNotMatch(page, /name="submit"|Save and Publish|name="publish"/);
    // A plain save (no submit flag) is submitted; asking to publish doesn't publish.
    assert.equal((await mia.post(`${L}/wake`, { title: 'Wake 3', publish: '1' })).status, 200);
    const l = t.db.listing('wake')!;
    assert.equal(l.published!.title, 'Wake', 'studio members can’t publish');
    assert.equal(l.draft.title, 'Wake 3');
    assert.equal(l.review, 'submitted');
    assert.equal(l.submitted_by, 'user:mia');
  });
});

describe('Game Catalog: featured settings as an accordion', () => {
  test('each featured row’s editor is collapsed, with a toggle next to its sequence; ticking opens it', async () => {
    const boss = t.as('boss', 'release_manager');
    await boss.post('/portal/api/vault/featured', { op: 'feature', slug: 'wake', featured: true });
    const page = await (await boss.get('/vault/listings')).text();
    assert.match(page, /<tr class="feat-edit" id="feat-edit-wake" hidden>/);
    assert.match(page, /#1<\/span><\/label><button type="button" class="feat-open" aria-expanded="false" aria-controls="feat-edit-wake"[^>]*>Edit</);
    assert.match(page, /data-open-after="feat-edit-wake"/);
    assert.match(page, /name="sequence" value="1"/, 'the editor is still on the page');
    const viewer = await (await t.as('mia', 'none', 'maintainer').get('/vault/listings')).text();
    assert.equal(viewer.includes('feat-open'), false, 'studio members don’t see this page');
  });
});
