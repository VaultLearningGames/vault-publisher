import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { portalHarness } from './portal-harness.ts';

// Tokens are keys into this table.
const adminId: GitHubIdentity = {
  owner: 'VaultLearningGames', ownerId: '1', repository: 'VaultLearningGames/vault-publisher', repositoryId: '900',
  ref: 'refs/heads/main', sha: 'abc', actor: 'octo', eventName: 'workflow_dispatch', environment: 'production',
};
const identities: Record<string, GitHubIdentity> = {
  admin: adminId,
  otherRepo: { ...adminId, repository: 'fielddaylab/wake', repositoryId: '100' },
  otherEnv: { ...adminId, environment: 'staging' },
  noEnv: { ...adminId, environment: undefined },
};
const verifier: Verifier = {
  async github(token) { const id = identities[token]; if (!id) throw new Error('bad signature'); return id; },
  async google() { throw new Error('no'); },
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const pages = [
  { slug: 'quest', title: 'Transformations Quest', params: { short_description: 'Rotate!', about_this_game: 'Geometry.', makers: ['University of Calgary'], grades: ['Grades 5-8'], hero_image: 'games/quest/img/hero.png', game_url: 'https://play.test/quest/' } },
  { slug: 'sam', title: 'Shady Sam', params: { makers: ['Next Gen Personal Finance'], game_url: 'https://play.test/sam/' } },
  { slug: 'nolink', title: 'No Link', params: { makers: ['Field Day Lab'] } },
  { slug: 'orphan', title: 'Orphan', params: {} },
];
const overrides = { overrides: { sam: { embed: false } }, studios: { 'Next Gen Personal Finance': 'ngpf' } };
let site: Record<string, unknown>;
let fetched: string[];
const fakeFetch = (async (url: string | URL) => {
  fetched.push(String(url));
  const b = site[String(url)];
  if (b === undefined) return new Response('nope', { status: 404 });
  return b instanceof Uint8Array ? new Response(b as Uint8Array<ArrayBuffer>) : Response.json(b);
}) as typeof fetch;

let t: ReturnType<typeof portalHarness>;
const call = (method: 'GET' | 'POST', path: string, token: string | null, body?: unknown) => t.app.request(path, {
  method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const post = async (path: string, body: unknown, token: string | null = 'admin') => {
  const res = await call('POST', `/v1/admin/listings/${path}`, token, body);
  return { status: res.status, json: (await res.json()) as any };
};
const list = async (query = '') => (await (await call('GET', `/v1/admin/listings${query}`, 'admin')).json()) as any;
const audits = (...actions: string[]) => t.db.auditFor(actions, 50).map((a) => ({ actor: a.actor, action: a.action, target: a.target, detail: a.detail_json ? JSON.parse(a.detail_json) : null }));
const snapshot = () => JSON.stringify([t.db.listings(), t.db.studios(), t.db.recentAudit(100).length]);
const L = '/portal/api/s/fieldday/listings';

beforeEach(async () => {
  fetched = [];
  site = {
    'https://site.test/migration/games-export.json': pages,
    'https://site.test/migration/import-overrides.json': overrides,
    'https://site.test/games/quest/img/hero.png': PNG,
    'https://site.test/games/wake/img/hero.png': PNG,
  };
  t = portalHarness({ verifier, fetch: fakeFetch });
  const boss = t.as('boss', 'admin');
  await boss.post(L, { slug: 'wake', title: 'Wake' });
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', about: 'Old about.', hero_image: 'games/wake/img/hero.png', publish: true })).status, 200);
});

describe('admin tasks: who may call', () => {
  const routes: ['GET' | 'POST', string, unknown][] = [
    ['GET', '/v1/admin/listings', undefined],
    ['POST', '/v1/admin/listings/import', { source: 'https://site.test' }],
    ['POST', '/v1/admin/listings/migrate-images', { base: 'https://site.test' }],
    ['POST', '/v1/admin/listings/move', { slug: 'wake', studio: 'ucalgary' }],
    ['POST', '/v1/admin/listings/update', { updates: [{ slug: 'wake', fields: { about: 'x' } }], publish: true }],
  ];
  test('no token or a bad one → 401; another repository or environment → 403; nothing changes', async () => {
    const before = snapshot();
    for (const [method, path, body] of routes) {
      assert.equal((await call(method, path, null, body)).status, 401, `${path} without a token`);
      assert.equal((await call(method, path, 'forged', body)).status, 401, `${path} with a bad token`);
      for (const token of ['otherRepo', 'otherEnv', 'noEnv']) assert.equal((await call(method, path, token, body)).status, 403, `${path} as ${token}`);
    }
    assert.equal(snapshot(), before);
    assert.equal(fetched.length, 0);
  });

  test('a portal session is not enough', async () => {
    const res = await t.as('boss', 'admin').post('/v1/admin/listings/move', { slug: 'wake', studio: 'ucalgary' });
    assert.equal(res.status, 401);
  });

  test('a staging portal accepts only the staging environment', async () => {
    t.rebuild({ adminEnvironment: 'staging' });
    assert.equal((await call('GET', '/v1/admin/listings', 'admin')).status, 403);
    assert.equal((await call('GET', '/v1/admin/listings', 'otherEnv')).status, 200);
  });
});

describe('admin task: list', () => {
  test('drafts, published listings and review state; filtered by slug', async () => {
    await t.as('mia', 'none', 'maintainer').post(`${L}/wake`, { title: 'Wake 2' });
    const all = await list();
    assert.equal(all.count, 1);
    const [wake] = all.listings;
    assert.equal(wake.slug, 'wake');
    assert.equal(wake.studio, 'fieldday');
    assert.equal(wake.on_site, true);
    assert.equal(wake.review, 'submitted');
    assert.deepEqual(wake.unpublished_changes, ['title']);
    assert.equal(wake.draft.title, 'Wake 2');
    assert.equal(wake.published.title, 'Wake');
    assert.equal(wake.published_by, 'user:boss');
    const some = await list('?slug=wake,nope&slug=other');
    assert.equal(some.count, 1);
    assert.deepEqual(some.missing, ['nope', 'other']);
  });
});

describe('admin task: import', () => {
  test('a dry run reports what an import would do and writes nothing', async () => {
    const before = snapshot();
    const { status, json } = await post('import', { source: 'https://site.test/', dry_run: true });
    assert.equal(status, 200);
    assert.deepEqual(json, {
      dry_run: true, source: 'https://site.test',
      created: ['quest', 'sam'],
      drafts: [{ slug: 'nolink', why: ['Add the URL the game is hosted at.'] }],
      skipped: [],
      failed: [{ slug: 'orphan', why: 'no studio (makers is empty and no override)' }],
      studios_created: ['ngpf'],
    });
    assert.equal(snapshot(), before);
  });

  test('limited to some slugs: reads the export from the site, creates and publishes, audited as the workflow’s actor', async () => {
    const { status, json } = await post('import', { source: 'https://site.test', slugs: ['quest', 'missing'] });
    assert.equal(status, 200);
    assert.deepEqual(json, { dry_run: false, source: 'https://site.test', created: ['quest'], drafts: [], skipped: [], failed: [{ slug: 'missing', why: 'not in the export' }], studios_created: [] });
    assert.deepEqual(fetched, ['https://site.test/migration/games-export.json', 'https://site.test/migration/import-overrides.json']);
    const quest = t.db.listing('quest')!;
    assert.equal(quest.studio_slug, 'ucalgary');
    assert.equal(quest.published!.title, 'Transformations Quest');
    assert.equal(quest.published_by, 'github:octo');
    assert.equal(t.db.listing('sam'), undefined);
    assert.deepEqual(audits('listings.import'), [{ actor: 'github:octo', action: 'listings.import', target: 'vault-rebuild', detail: { created: 1, drafts: 0, skipped: 0, studios: [], listings: ['quest'] } }]);
    // It's in the catalog the site is built from.
    const cat = (await (await t.app.request('/v1/catalog')).json()) as any;
    assert.ok(cat.games.some((g: any) => g.slug === 'quest' && g.studio.slug === 'ucalgary'));

    // Again: it has a listing now, so it's skipped.
    const again = await post('import', { source: 'https://site.test', slugs: ['quest'] });
    assert.deepEqual(again.json.skipped, [{ slug: 'quest', why: 'already has a listing' }]);
    assert.deepEqual(again.json.created, []);
  });

  test('everything: the same import as the portal’s, with overrides and new studios', async () => {
    const { json } = await post('import', { source: 'https://site.test' });
    assert.deepEqual(json.created, ['quest', 'sam']);
    assert.deepEqual(json.studios_created, ['ngpf']);
    assert.equal(t.db.listing('sam')!.published!.embed, false);
    assert.equal(t.db.listing('sam')!.studio_slug, 'ngpf');
    assert.equal(t.db.listing('nolink')!.published, null);
  });

  test('the export can come in the request; a site without one is a clear error', async () => {
    delete site['https://site.test/migration/games-export.json'];
    const refused = await post('import', { source: 'https://site.test', slugs: ['quest'] });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /couldn’t read https:\/\/site\.test\/migration\/games-export\.json: HTTP 404/);
    const { status, json } = await post('import', { source: 'https://site.test', slugs: ['sam'], pages, overrides });
    assert.equal(status, 200);
    assert.deepEqual(json.created, ['sam']);
    assert.equal(t.db.listing('sam')!.studio_slug, 'ngpf');
  });

  test('bad requests', async () => {
    assert.equal((await post('import', {})).status, 400);
    assert.equal((await post('import', { source: 'ftp://site.test' })).status, 400);
    assert.equal((await post('import', { source: 'https://site.test', slugs: 'quest' })).status, 400);
    assert.equal((await post('import', { source: 'https://site.test', slugs: ['Not A Slug'] })).status, 400);
    assert.equal((await post('import', { source: 'https://site.test', dry_run: 'yes' })).status, 400);
    assert.equal((await post('import', { source: 'https://site.test', pages: { not: 'a list' } })).status, 400);
    assert.equal(t.db.listings().length, 1);
  });
});

describe('admin task: migrate-images', () => {
  test('a dry run lists the site-path images and downloads nothing', async () => {
    const before = snapshot();
    const { status, json } = await post('migrate-images', { base: 'https://site.test', dry_run: true });
    assert.equal(status, 200);
    assert.equal(json.dry_run, true);
    assert.deepEqual(json.counts, { migrated: 2, already: 0, failed: 0, external: 0, objects_written: 0, remaining: 0 });
    assert.deepEqual(json.migrated.map((i: any) => `${i.listing} ${i.where} ${i.field} ${i.from}`), ['wake published hero_image games/wake/img/hero.png', 'wake draft hero_image games/wake/img/hero.png']);
    assert.equal(fetched.length, 0);
    assert.equal(t.production.puts, 0);
    assert.equal(snapshot(), before);
    assert.equal(t.db.setting('listing_image_migration'), undefined, 'no "last run" from a dry run');
  });

  test('copies, relinks, audits; running it again changes nothing', async () => {
    const { status, json } = await post('migrate-images', { base: 'https://site.test/' });
    assert.equal(status, 200);
    assert.deepEqual(json.counts, { migrated: 2, already: 0, failed: 0, external: 0, objects_written: 1, remaining: 0 });
    assert.equal(json.by, 'github:octo');
    const hero = t.db.listing('wake')!.published!.hero_image;
    assert.match(hero, /^https:\/\/prod\.test\/fieldday\/wake\/_vault-assets\/hero-[0-9a-f]{16}\.png$/);
    assert.equal(json.migrated[0].to, hero);
    assert.deepEqual(audits('listing.images.migrate').map((a) => [a.actor, a.target, a.detail.migrated]), [['github:octo', 'https://site.test', 2]]);
    // The run is kept as the last result (the portal has no page for it).
    const last = JSON.parse(t.db.setting('listing_image_migration')!);
    assert.deepEqual([last.migrated.length, last.objects_written], [2, 1]);

    const snap = JSON.stringify(t.db.listing('wake'));
    const again = await post('migrate-images', { base: 'https://site.test' });
    assert.deepEqual(again.json.counts, { migrated: 0, already: 2, failed: 0, external: 0, objects_written: 0, remaining: 0 });
    assert.equal(t.production.puts, 1);
    assert.equal(JSON.stringify(t.db.listing('wake')), snap);
  });

  test('a run that runs out of time keeps what it did, and the next run finishes', async () => {
    const shots = ['games/wake/img/1.png', 'games/wake/img/2.png', 'games/wake/img/3.png'];
    for (const p of shots) site[`https://site.test/${p}`] = PNG;
    await t.as('boss', 'admin').post(`${L}/wake`, { screenshots: shots.join('\n'), publish: true });
    // Four distinct paths; every download "takes" 10 s of a 25 s budget, so the fourth never starts.
    const real = Date.now;
    let elapsed = 0;
    Date.now = () => real() + elapsed;
    t.rebuild({ verifier, fetch: (async (url: string | URL) => { elapsed += 10_000; return fakeFetch(url); }) as typeof fetch });
    try {
      const first = await post('migrate-images', { base: 'https://site.test', budget_seconds: 25 });
      assert.equal(first.status, 200);
      assert.deepEqual(first.json.counts, { migrated: 6, already: 0, failed: 0, external: 0, objects_written: 2, remaining: 2 });
      assert.equal(fetched.length, 3);
    } finally {
      Date.now = real;
    }
    const l = t.db.listing('wake')!;
    assert.match(l.published!.hero_image, /^https:\/\/prod\.test\//);
    assert.equal(l.published!.screenshots.filter((v) => v.startsWith('https://prod.test/')).length, 2);
    assert.equal(l.published!.screenshots[2], shots[2], 'left for the next run');
    assert.equal(audits('listing.images.migrate')[0].detail.remaining, 2);

    t.rebuild({ verifier, fetch: fakeFetch });
    const second = await post('migrate-images', { base: 'https://site.test' });
    assert.deepEqual(second.json.counts, { migrated: 2, already: 6, failed: 0, external: 0, objects_written: 0, remaining: 0 });
    assert.equal(fetched.length, 4, 'only what remained is downloaded');
  });

  test('bad requests; needs the CDN storage', async () => {
    assert.equal((await post('migrate-images', {})).status, 400);
    assert.equal((await post('migrate-images', { base: 'site.test' })).status, 400);
    assert.equal((await post('migrate-images', { base: 'https://site.test', budget_seconds: 0 })).status, 400);
    assert.equal((await post('migrate-images', { base: 'https://site.test', budget_seconds: '60' })).status, 400);
    t.rebuild({ verifier, fetch: fakeFetch, production: null });
    assert.equal((await post('migrate-images', { base: 'https://site.test' })).status, 503);
  });
});

describe('admin task: move', () => {
  test('a dry run says what would move; a real one moves it like the portal does, audited', async () => {
    const before = snapshot();
    const dry = await post('move', { slug: 'wake', studio: 'ucalgary', dry_run: true });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.json, { dry_run: true, moved: { slug: 'wake', from: 'fieldday', to: 'ucalgary', makers: { from: ['Field Day Lab'], to: ['University of Calgary'] } } });
    assert.equal(snapshot(), before);

    const { status, json } = await post('move', { slug: 'wake', studio: 'ucalgary' });
    assert.equal(status, 200);
    assert.equal(json.dry_run, false);
    const l = t.db.listing('wake')!;
    assert.equal(l.studio_slug, 'ucalgary');
    assert.deepEqual(l.published!.makers, ['University of Calgary']);
    assert.equal(l.updated_by, 'github:octo');
    assert.deepEqual(audits('listing.move'), [{ actor: 'github:octo', action: 'listing.move', target: 'wake', detail: { from: 'fieldday', to: 'ucalgary' } }]);
    const cat = (await (await t.app.request('/v1/catalog')).json()) as any;
    assert.equal(cat.games[0].studio.slug, 'ucalgary');
  });

  test('refusals: unknown listing or studio, already there, hosted on the CDN', async () => {
    assert.equal((await post('move', { slug: 'nope', studio: 'ucalgary' })).status, 404);
    assert.equal((await post('move', { slug: 'wake', studio: 'nope' })).status, 404);
    assert.equal((await post('move', { slug: 'wake' })).status, 400);
    assert.equal((await post('move', { studio: 'ucalgary' })).status, 400);
    const same = await post('move', { slug: 'wake', studio: 'fieldday' });
    assert.equal(same.status, 400);
    assert.match(same.json.error, /already belongs to Field Day Lab/);
    // Hosted on the studio's CDN game: it can't leave the studio, in a dry run either.
    const fd = t.db.studioBySlug('fieldday')!;
    const g = t.db.createGame(fd.id, 'wake', 'fielddaylab/wake', '100');
    t.db.linkListing(t.db.listing('wake')!.id, g.id);
    const draft = { ...t.db.listing('wake')!.draft, play_source: 'cdn' as const };
    t.db.saveListingDraft(t.db.listing('wake')!.id, draft, 'test');
    for (const dry_run of [true, false]) {
      const res = await post('move', { slug: 'wake', studio: 'ucalgary', dry_run });
      assert.equal(res.status, 400);
      assert.match(res.json.error, /Switch it back to its web address first/);
    }
    assert.equal(t.db.listing('wake')!.studio_slug, 'fieldday');
    assert.equal(audits('listing.move').length, 0);
  });
});

describe('admin task: update', () => {
  beforeEach(async () => {
    const boss = t.as('boss', 'admin');
    await boss.post(L, { slug: 'bloom', title: 'Bloom' });
    await boss.post(`${L}/bloom`, { play_url: 'https://example.org/bloom/', publish: true });
  });
  const about = (slug: string, text: string) => ({ slug, fields: { about: text } });

  test('a dry run shows before and after and writes nothing', async () => {
    const before = snapshot();
    const { status, json } = await post('update', { updates: [about('wake', ' New about. '), about('bloom', '')], publish: true, dry_run: true });
    assert.equal(status, 200);
    assert.deepEqual(json, {
      dry_run: true, publish: true,
      updated: [{ slug: 'wake', studio: 'fieldday', changed: ['about'], published: ['about'], before: { about: 'Old about.' }, after: { about: 'New about.' } }],
      unchanged: ['bloom'],
    });
    assert.equal(snapshot(), before);
  });

  test('publish: true saves and publishes each as Vault, with audit entries', async () => {
    const { status, json } = await post('update', { updates: [about('wake', 'New about.'), { slug: 'bloom', fields: { about: 'Flowers.', grades: ['Grades 3-5'], embed: false } }], publish: true });
    assert.equal(status, 200);
    assert.deepEqual(json.updated.map((u: any) => [u.slug, u.changed]), [['wake', ['about']], ['bloom', ['about', 'grades', 'embed']]]);
    const wake = t.db.listing('wake')!, bloom = t.db.listing('bloom')!;
    assert.equal(wake.published!.about, 'New about.');
    assert.equal(wake.published!.title, 'Wake', 'other fields are kept');
    assert.equal(wake.published_by, 'github:octo');
    assert.deepEqual([bloom.published!.about, bloom.published!.grades, bloom.published!.embed], ['Flowers.', ['Grades 3-5'], false]);
    assert.deepEqual(audits('listing.save', 'listing.publish').filter((a) => a.actor === 'github:octo').map((a) => [a.action, a.target, a.detail.fields]).reverse(), [
      ['listing.save', 'fieldday:wake', ['about']], ['listing.publish', 'fieldday:wake', ['about']],
      ['listing.save', 'fieldday:bloom', ['about', 'grades', 'embed']], ['listing.publish', 'fieldday:bloom', ['about', 'grades', 'embed']],
    ]);
    const cat = (await (await t.app.request('/v1/catalog')).json()) as any;
    assert.equal(cat.games.find((g: any) => g.slug === 'wake').about, 'New about.');

    // The same update again changes nothing and logs nothing.
    const n = t.db.recentAudit(100).length;
    const again = await post('update', { updates: [about('wake', 'New about.')], publish: true });
    assert.deepEqual([again.json.updated, again.json.unchanged], [[], ['wake']]);
    assert.equal(t.db.recentAudit(100).length, n);
  });

  test('publish: false only changes the draft', async () => {
    const { status, json } = await post('update', { updates: [about('wake', 'Draft about.')], publish: false });
    assert.equal(status, 200);
    assert.deepEqual(json.updated[0].published, []);
    const wake = t.db.listing('wake')!;
    assert.equal(wake.draft.about, 'Draft about.');
    assert.equal(wake.published!.about, 'Old about.');
    assert.equal(wake.review, 'editing');
    assert.deepEqual(audits('listing.publish').filter((a) => a.actor === 'github:octo'), []);
    assert.equal(audits('listing.save')[0].actor, 'github:octo');
  });

  test('sets the smallest play area (numbers, or null for the site default)', async () => {
    const set = (min_width: unknown, min_height: unknown) => post('update', { publish: true, updates: [{ slug: 'bloom', fields: { min_width, min_height } }] });
    const { status, json } = await set(1024, 600);
    assert.equal(status, 200);
    assert.deepEqual(json.updated[0].changed, ['min_width', 'min_height']);
    assert.deepEqual([t.db.listing('bloom')!.published!.min_width, t.db.listing('bloom')!.published!.min_height], [1024, 600]);
    const refused = await set('1024', 50);
    assert.equal(refused.status, 400);
    assert.match(refused.json.detail[0].problems.join('\n'), /min_width must be a whole number of pixels, or null/);
    assert.match((await set(1024, 50)).json.detail[0].problems.join('\n'), /minimum play height must be a whole number of pixels from 200/);
    assert.equal((await set(null, null)).status, 200);
    assert.equal(t.db.listing('bloom')!.published!.min_width, null);
  });

  test('all or nothing: every problem comes back, and nothing is written', async () => {
    const before = snapshot();
    const { status, json } = await post('update', {
      publish: true,
      updates: [
        about('wake', 'Fine.'),
        about('nope', 'x'),
        { slug: 'bloom', fields: { about: 7, abuot: 'typo', grades: ['Grade 13'], play_url: 'not a url', hero_image: 'x'.repeat(600) } },
        about('wake', 'Twice.'),
        { slug: 'bloom2' },
        { slug: 'Bad Slug', fields: { about: 'x' } },
      ],
    });
    assert.equal(status, 400);
    assert.match(json.error, /5 of 6 updates can’t be applied; nothing was changed/);
    assert.deepEqual(json.detail.map((d: any) => d.slug), ['nope', 'bloom', 'wake', 'bloom2', 'Bad Slug']);
    const bloom = json.detail[1].problems.join('\n');
    assert.match(bloom, /about must be a string/);
    assert.match(bloom, /Unknown field “abuot”/);
    assert.match(bloom, /hero_image is too long/);
    assert.deepEqual(json.detail[0].problems, ['No such listing.']);
    assert.deepEqual(json.detail[2].problems, ['Listed more than once.']);
    assert.equal(snapshot(), before);

    // The save's own rules (the same messages the portal gives).
    const rules = await post('update', { publish: true, updates: [{ slug: 'bloom', fields: { grades: ['Grade 13'], play_url: 'not a url', title: '' } }] });
    assert.equal(rules.status, 400);
    assert.deepEqual(rules.json.detail[0].problems, ['The play URL must start with https:// (or http://).', 'Unknown grade band “Grade 13”.', 'Add a title.']);
    // A draft may lack a title; a published listing may not.
    assert.equal((await post('update', { publish: false, updates: [{ slug: 'bloom', fields: { title: '' } }], dry_run: true })).status, 200);
    assert.equal(snapshot(), before);
  });

  test('publishing won’t carry along a studio’s unreviewed changes, or put a new game on the site, unless asked', async () => {
    await t.as('mia', 'none', 'maintainer').post(`${L}/wake`, { title: 'Wake (studio edit)' });
    await t.as('boss', 'admin').post(L, { slug: 'fresh', title: 'Fresh' });
    const body = { publish: true, updates: [about('wake', 'New.'), about('fresh', 'New.'), about('bloom', 'New.')] };
    const refused = await post('update', body);
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.json.detail.map((d: any) => d.slug), ['wake', 'fresh']);
    assert.match(refused.json.detail[0].problems[0], /other unpublished draft changes on the site \(title\); pass publish_pending: true/);
    assert.match(refused.json.detail[1].problems.join(' '), /isn’t on the site yet/);
    assert.equal(t.db.listing('bloom')!.published!.about, '');
    // As a draft change it's fine, and the studio's submission stays in the review queue.
    assert.equal((await post('update', { ...body, publish: false })).status, 200);
    assert.equal(t.db.listing('wake')!.review, 'submitted');
    assert.equal(t.db.listing('wake')!.published!.title, 'Wake');
    // Asked to: everything in the draft goes on the site ("fresh" still has no play URL, so that is refused).
    const still = await post('update', { ...body, publish_pending: true });
    assert.deepEqual(still.json.detail, [{ slug: 'fresh', problems: ['Add the URL the game is hosted at.'] }]);
    const ok = await post('update', { publish: true, publish_pending: true, updates: [about('wake', 'Newer.')] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.updated[0].published, ['title', 'about']);
    assert.equal(t.db.listing('wake')!.published!.title, 'Wake (studio edit)');
    assert.equal(t.db.listing('wake')!.review, 'editing');
  });

  test('cdn_game connects a CDN game, so one update can switch a listing to the CDN; disconnecting needs the web address back', async () => {
    const fd = t.db.studioBySlug('fieldday')!;
    const g = t.db.createGame(fd.id, 'aqualab', '', 'vault:fieldday/aqualab');
    const unreleased = t.db.createGame(fd.id, 'tide', '', 'vault:fieldday/tide');
    const toCdn = { slug: 'wake', cdn_game: 'aqualab', fields: { play_source: 'cdn' } };
    // Without a current release the switch is refused, and nothing is linked.
    const early = await post('update', { publish: true, updates: [toCdn] });
    assert.equal(early.status, 400);
    assert.match(early.json.detail[0].problems.join(' '), /needs a CDN game with a current release/);
    assert.equal(t.db.listing('wake')!.game_id, null);
    assert.match((await post('update', { publish: true, updates: [{ slug: 'wake', cdn_game: 'nope' }] })).json.detail[0].problems[0], /has no CDN game “nope”/);

    const r = t.db.createRelease({ game_id: g.id, version: 'v1', source_ref: 'master', commit_sha: 'a'.repeat(40), file_count: 1, total_bytes: 1, approved_by: 'x' });
    t.db.setCurrentRelease(g.id, r.id);
    const before = snapshot();
    const dry = await post('update', { publish: true, updates: [toCdn], dry_run: true });
    assert.deepEqual(dry.json.updated[0].cdn_game, { before: null, after: 'aqualab' });
    assert.equal(snapshot(), before);
    const ok = await post('update', { publish: true, updates: [toCdn] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.updated[0].published, ['play_source']);
    assert.equal(t.db.listing('wake')!.game_id, g.id);
    assert.equal(audits('listing.link')[0].actor, 'github:octo');
    const cat = (await (await t.app.request('/v1/catalog')).json()) as any;
    assert.equal(cat.games.find((x: any) => x.slug === 'wake').play.url, 'https://prod.test/fieldday/aqualab/');

    // Connecting only (no fields) works too; disconnecting a game that plays from the CDN is refused.
    assert.equal((await post('update', { publish: false, updates: [{ slug: 'bloom', cdn_game: 'tide' }] })).status, 200);
    assert.equal(t.db.listing('bloom')!.game_id, unreleased.id);
    const off = await post('update', { publish: true, updates: [{ slug: 'wake', cdn_game: '' }] });
    assert.match(off.json.detail[0].problems.join(' '), /switch it back to its web address/);
    const back = await post('update', { publish: true, updates: [{ slug: 'wake', cdn_game: '', fields: { play_source: 'url' } }] });
    assert.equal(back.status, 200);
    assert.equal(t.db.listing('wake')!.game_id, null);
  });

  test('bad requests', async () => {
    assert.equal((await post('update', { updates: [about('wake', 'x')] })).status, 400, 'publish is required');
    assert.equal((await post('update', { updates: [], publish: true })).status, 400);
    assert.equal((await post('update', { updates: { wake: {} }, publish: true })).status, 400);
    assert.equal((await post('update', { updates: [about('wake', 'x')], publish: 'yes' })).status, 400);
  });
});

describe('admin task: featured', () => {
  const featured = async (body: unknown, token: string | null = 'admin') => {
    const res = await call('POST', '/v1/admin/featured', token, body);
    return { status: res.status, json: (await res.json()) as any };
  };

  test('sets the home page’s featured games; a dry run changes nothing; unknown games are refused', async () => {
    const games = [{ slug: 'wake', sequence: 2, blurb: 'In *Wake*…', image: 'images/featured/wake.webp' }];
    const dry = await featured({ games, dry_run: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.dry_run, true);
    assert.deepEqual((await (await t.app.request('/v1/catalog')).json() as any).featured, []);

    assert.equal((await featured({ games: [{ slug: 'nope' }] })).status, 400);
    assert.equal((await featured({ games: 'wake' })).status, 400);
    assert.equal((await featured({ games }, null)).status, 401);

    const r = await featured({ games });
    assert.equal(r.status, 200);
    assert.deepEqual((await (await t.app.request('/v1/catalog')).json() as any).featured, [{ slug: 'wake', blurb: 'In *Wake*…', image: 'images/featured/wake.webp', sequence: 2 }]);
    assert.deepEqual(audits('featured.set').map((a) => [a.actor, a.target]), [['github:octo', 'wake']]);

    // Replacing the list with nothing parks the game.
    assert.equal((await featured({ games: [] })).status, 200);
    assert.deepEqual((await (await t.app.request('/v1/catalog')).json() as any).featured, []);
  });
});

describe('admin task: studios', () => {
  const studios = async (body: unknown, token: string | null = 'admin') => {
    const res = await call('POST', '/v1/admin/studios', token, body);
    return { status: res.status, json: (await res.json()) as any };
  };

  test('creates Vault-managed studios and renames existing ones; dry runs and bad input change nothing', async () => {
    const before = t.db.studios().length;
    const dry = await studios({ dry_run: true, studios: [{ slug: 'cmu', name: 'Carnegie Mellon University', website: 'https://www.cmu.edu' }] });
    assert.equal(dry.status, 200);
    assert.equal(t.db.studios().length, before);
    assert.equal((await studios({ studios: [{ slug: 'cmu' }] })).status, 400, 'a new studio needs a name');
    assert.equal((await studios({ studios: [{ slug: 'cmu', name: 'X', website: 'not a url' }] })).status, 400);
    assert.equal((await studios({ studios: [{ slug: 'cmu', name: 'Carnegie Mellon University' }] }, null)).status, 401);
    assert.equal(t.db.studios().length, before);

    const r = await studios({ studios: [{ slug: 'cmu', name: 'Carnegie Mellon University', website: 'https://www.cmu.edu' }] });
    assert.equal(r.status, 200);
    const cmu = t.db.studioBySlug('cmu')!;
    assert.deepEqual([cmu.name, cmu.github_owner_id, cmu.website], ['Carnegie Mellon University', 'vault:cmu', 'https://www.cmu.edu']);

    const again = await studios({ studios: [{ slug: 'cmu', name: 'CMU', website: 'https://www.etc.cmu.edu' }] });
    assert.deepEqual(again.json.studios[0].changes, { name: { from: 'Carnegie Mellon University', to: 'CMU' }, website: { from: 'https://www.cmu.edu', to: 'https://www.etc.cmu.edu' } });
    assert.equal(t.db.studioBySlug('cmu')!.name, 'CMU');
    // A second studio can't take a name already in use.
    assert.equal((await studios({ studios: [{ slug: 'other', name: 'cmu' }] })).status, 409);
    assert.deepEqual(audits('studio.create', 'studio.update').map((a) => [a.action, a.target]).sort(), [['studio.create', 'cmu'], ['studio.update', 'cmu']]);
  });
});

describe('admin task: remove-studios', () => {
  const studios = async (path: string, body: unknown) => {
    const res = await call('POST', path, 'admin', body);
    return { status: res.status, json: (await res.json()) as any };
  };

  test('deletes only completely empty studios; one refusal removes nothing; a dry run changes nothing', async () => {
    assert.equal((await studios('/v1/admin/studios', { studios: [{ slug: 'empty-a', name: 'Empty A' }, { slug: 'empty-b', name: 'Empty B' }, { slug: 'busy', name: 'Busy' }, { slug: 'staffed', name: 'Staffed' }] })).status, 200);
    assert.equal((await post('move', { slug: 'wake', studio: 'busy' })).status, 200);
    t.db.setMembership(t.db.studioBySlug('staffed')!.id, 'someone', 'viewer', 'test');
    const exists = (...slugs: string[]) => slugs.map((s) => !!t.db.studioBySlug(s));

    for (const blocked of ['busy', 'staffed', 'fieldday']) {
      const r = await studios('/v1/admin/studios/remove', { slugs: ['empty-a', blocked] });
      assert.equal(r.status, 409, blocked);
    }
    assert.equal((await studios('/v1/admin/studios/remove', { slugs: ['nope'] })).status, 404);
    assert.deepEqual(exists('empty-a', 'empty-b', 'busy', 'staffed'), [true, true, true, true]);

    const dry = await studios('/v1/admin/studios/remove', { slugs: ['empty-a', 'empty-b'], dry_run: true });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.json.studios.map((s: any) => [s.slug, s.removed]), [['empty-a', false], ['empty-b', false]]);
    assert.deepEqual(exists('empty-a', 'empty-b'), [true, true]);

    const done = await studios('/v1/admin/studios/remove', { slugs: ['empty-a', 'empty-b'] });
    assert.equal(done.status, 200);
    assert.deepEqual(exists('empty-a', 'empty-b', 'busy', 'staffed'), [false, false, true, true]);
    assert.deepEqual(audits('studio.delete').map((a) => [a.actor, a.target]).sort(), [['github:octo', 'empty-a'], ['github:octo', 'empty-b']]);
  });
});
