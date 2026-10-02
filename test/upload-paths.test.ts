// The four ways to upload a build: the page, automatic publish requests from CI, zip uploads and URL monitors in the portal.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import type { Fetcher } from '../src/net-guard.ts';
import { uploadRefName } from '../src/portal/uploads.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { monitorsForStudio, saveMonitor } from '../src/url-monitor.ts';
import { FakeStorage, portalHarness } from './portal-harness.ts';

const repo: GitHubIdentity = { owner: 'fielddaylab', ownerId: '1881825', repository: 'fielddaylab/tide', repositoryId: '100', ref: 'refs/heads/production', sha: 'a'.repeat(40), actor: 'dev', eventName: 'push' };
let ids: Record<string, GitHubIdentity>;
const verifier: Verifier = {
  async github(token) { if (!ids[token]) throw new Error('bad signature'); return ids[token]; },
  async google(token) { if (token !== 'scheduler') throw new Error('bad signature'); return 'x@y'; },
};
// The studio's own site, for URL monitors.
let web: Record<string, string>;
const fetcher: Fetcher = async (url) => {
  const body = web[url];
  return body === undefined ? { url, status: 404, headers: {}, body: Readable.from([]) }
    : { url, status: 200, headers: { 'content-length': String(Buffer.byteLength(body)) }, body: Readable.from([Buffer.from(body)]) };
};

let h: ReturnType<typeof portalHarness>, staging: FakeStorage;
beforeEach(() => {
  staging = new FakeStorage();
  ids = { repo, tag: { ...repo, ref: 'refs/tags/v1.2', sha: 'b'.repeat(40) }, release: { ...repo, ref: 'refs/tags/v1.2', sha: 'b'.repeat(40), eventName: 'release' },
    pr: { ...repo, ref: 'refs/pull/7/merge', eventName: 'pull_request' }, other: { ...repo, repository: 'fielddaylab/other', repositoryId: '200' } };
  web = {};
  h = portalHarness({ verifier, fetcher, staging });
});
const ci = (path: string, token: string, body: unknown = {}) =>
  h.app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// What the action's upload step does: start, PUT the files, finalize.
async function publish(token: string, game = 'tide') {
  const start = await (await ci('/v1/previews', token, { game, files: [{ path: 'index.html', size: 5 }] })).json() as { upload_id: string; files: { url: string }[] };
  for (const f of start.files) { const key = new URL(f.url).pathname.slice(1); staging.objects.set(key, 5); staging.data.set(key, Buffer.from('<h1>')); }
  assert.equal((await ci(`/v1/previews/${start.upload_id}/finalize`, token)).status, 200);
}
const game = () => h.db.game(h.db.studioBySlug('fieldday')!.id, 'tide')!;
const requests = () => h.db.releaseRequests({ gameId: game().id }).map((r) => [r.version, r.ref, r.status, r.requested_by]);

describe('the Upload builds page', () => {
  test('offers exactly the four paths, in plain terms, to every member', async () => {
    const page = await (await h.as('mia', 'none', 'maintainer').get('/s/fieldday/register')).text();
    for (const id of ['path-1', 'path-2', 'path-3', 'path-4']) assert.match(page, new RegExp(`id="${id}"`));
    assert.equal(page.match(/<section class="card path"/g)!.length, 4);
    assert.match(page, /Upload every push from GitHub[\s\S]*Also ask Vault to publish, automatically[\s\S]*Upload a \.zip[\s\S]*Monitor a web address/);
    assert.equal(page.match(/What happens next/g)!.length, 4);
    assert.match(page, /"portal":"https:\/\/portal\.test"/);
    assert.match(page, /id="zip-form"/);
    assert.match(page, /data-api="\/portal\/api\/s\/fieldday\/monitors"/);
    assert.doesNotMatch(page, /Field Day framework|Zip upload is coming/);
  });
  test('viewers can read it but get no upload or monitor forms', async () => {
    const page = await (await h.as('vera', 'none', 'viewer').get('/s/fieldday/register')).text();
    assert.doesNotMatch(page, /id="zip-form"|data-api="\/portal\/api\/s\/fieldday\/monitors"/);
    assert.match(page, /Only studio maintainers and studio admins can do this/);
    assert.equal((await h.as('sam').get('/s/fieldday/register')).status, 404);
  });
  test('its script and styles are served', async () => {
    const page = await (await h.as('mia', 'none', 'maintainer').get('/s/fieldday/register')).text();
    for (const src of [/\/assets\/setup\.js\?v=\w+/, /\/assets\/setup\.css\?v=\w+/]) assert.equal((await h.app.request(page.match(src)![0])).status, 200);
  });
});

describe('automatic publish requests from a workflow (path 2)', () => {
  test('a push to production files a request for the build it just uploaded; Vault still approves it', async () => {
    await publish('repo');
    const res = await ci('/v1/release-requests', 'repo', { game: 'tide' });
    assert.equal(res.status, 200);
    const out = await res.json() as { status: string; version: string; url: string };
    assert.deepEqual([out.status, out.version, out.url], ['requested', 'production-aaaaaaa', 'https://portal.test/s/fieldday/g/tide?tab=cdn']);
    assert.deepEqual(requests(), [['production-aaaaaaa', 'production', 'requested', 'github:dev']]);
    assert.match(h.db.releaseRequests({ gameId: game().id })[0].notes!, /Requested automatically by a push to production \(commit aaaaaaa\)/);
    assert.equal(h.db.release(game().id, 'production-aaaaaaa'), undefined); // nothing is released by asking
    // The request is in Vault's queue and on the game's page like any other.
    assert.match(await (await h.as('boss', 'admin').get('/vault')).text(), /production-aaaaaaa/);
    const approve = await h.as('rita', 'release_manager').post(`/portal/api/requests/${h.db.releaseRequests({ gameId: game().id })[0].id}/approve`, { makeCurrent: true });
    assert.equal(approve.status, 200);
    assert.equal(h.db.currentRelease(game().id)!.version, 'production-aaaaaaa');
  });

  test('running it again changes nothing; a newer push replaces the request Vault hasn’t decided', async () => {
    await publish('repo');
    await ci('/v1/release-requests', 'repo', { game: 'tide' });
    assert.equal((await (await ci('/v1/release-requests', 'repo', { game: 'tide' })).json() as { status: string }).status, 'already-requested');
    ids.repo = { ...repo, sha: 'c'.repeat(40) };
    await publish('repo');
    assert.equal((await ci('/v1/release-requests', 'repo', { game: 'tide' })).status, 200);
    assert.deepEqual(requests(), [['production-ccccccc', 'production', 'requested', 'github:dev'], ['production-aaaaaaa', 'production', 'withdrawn', 'github:dev']]);
  });

  test('a published GitHub release uploads its tag and asks for a release named after it', async () => {
    await publish('release'); // the release event may publish, as a push does
    const out = await (await ci('/v1/release-requests', 'release', { game: 'tide', notes: 'Spring update' })).json() as { status: string; version: string };
    assert.deepEqual([out.status, out.version], ['requested', 'v1.2']);
    assert.equal(h.db.releaseRequests({ gameId: game().id })[0].notes, 'Spring update');
    // once Vault has released it, asking again says so
    const req = h.db.releaseRequests({ gameId: game().id })[0];
    await h.as('rita', 'release_manager').post(`/portal/api/requests/${req.id}/approve`, {});
    assert.equal((await (await ci('/v1/release-requests', 'tag', { game: 'tide' })).json() as { status: string }).status, 'released');
  });

  test('a version can be named, and must be a valid release name', async () => {
    await publish('repo');
    assert.equal((await (await ci('/v1/release-requests', 'repo', { game: 'tide', version: '1.4.0' })).json() as { version: string }).version, '1.4.0');
    assert.equal((await ci('/v1/release-requests', 'repo', { game: 'tide', version: '../x' })).status, 400);
  });

  test('only for the build this commit uploaded, from the game’s own repository', async () => {
    assert.equal((await ci('/v1/release-requests', 'repo', { game: 'tide' })).status, 404); // no such game yet
    await publish('repo');
    ids.repo = { ...repo, sha: 'd'.repeat(40) }; // a later commit that didn't upload
    const stale = await ci('/v1/release-requests', 'repo', { game: 'tide' });
    assert.equal(stale.status, 409);
    assert.match((await stale.json() as { error: string }).error, /upload this commit first/);
    assert.equal((await ci('/v1/release-requests', 'tag', { game: 'tide' })).status, 409); // no test build for that tag
    assert.equal((await ci('/v1/release-requests', 'other', { game: 'tide' })).status, 403);
    assert.equal((await ci('/v1/release-requests', 'pr', { game: 'tide' })).status, 400);
    assert.equal((await ci('/v1/release-requests', 'nobody', { game: 'tide' })).status, 401);
    assert.deepEqual(requests(), []);
  });
});

describe('uploading a .zip in the portal (path 3)', () => {
  const files = [{ path: 'index.html', size: 12 }, { path: 'Build/game.wasm.br', size: 40 }];
  const start = (who: ReturnType<typeof h.as>, body: unknown = { game: 'tide', files }, studio = 'fieldday') => who.post(`/portal/api/s/${studio}/uploads`, body);

  test('a maintainer uploads a build; it becomes a test build they can request a release from', async () => {
    const mia = h.as('mia', 'none', 'maintainer');
    const res = await start(mia);
    assert.equal(res.status, 200);
    const up = await res.json() as { upload_id: string; ref: string; files: { path: string; url: string; headers: Record<string, string> }[] };
    assert.match(up.ref, /^upload-\d{8}-\d{4}$/);
    assert.deepEqual(up.files.map((f) => f.url), [`https://r2.test/fieldday/tide/${up.ref}/index.html`, `https://r2.test/fieldday/tide/${up.ref}/Build/game.wasm.br`]);
    assert.equal(up.files[1].headers['Content-Encoding'], 'br');
    // not finished until every file has arrived, at its declared size
    staging.objects.set(`fieldday/tide/${up.ref}/index.html`, 12);
    assert.equal((await mia.post(`/portal/api/s/fieldday/uploads/${up.upload_id}/finalize`)).status, 409);
    staging.objects.set(`fieldday/tide/${up.ref}/Build/game.wasm.br`, 40);
    const done = await mia.post(`/portal/api/s/fieldday/uploads/${up.upload_id}/finalize`);
    assert.equal(done.status, 200);
    assert.equal((await done.json() as { page: string }).page, '/s/fieldday/g/tide?tab=cdn');
    const build = h.db.build(game().id, up.ref)!;
    assert.deepEqual([build.status, build.ref_type, build.file_count, build.total_bytes, build.actor], ['live', 'branch', 2, 52, 'mia']);
    assert.match(build.commit_sha, /^zip:[0-9a-f]{16}$/);
    assert.equal(game().repository_id, 'vault:fieldday/tide'); // no repository yet; one can take the game over later
    const page = await (await mia.get('/s/fieldday/g/tide?tab=cdn')).text();
    assert.match(page, new RegExp(`${up.ref}</span> <span class="tag">upload</span>`));
    assert.match(page, /a \.zip uploaded here/);
    assert.match(page, new RegExp(`data-open="request" data-ref="${up.ref}" data-type="upload"`));
    assert.equal((await mia.post('/portal/api/s/fieldday/g/tide/request', { ref: up.ref, version: 'v1.0' })).status, 200);
    assert.deepEqual(h.db.recentAudit(3).map((a) => a.action), ['release.request', 'preview.publish', 'game.create']);
  });

  test('who may upload: maintainers, studio admins and Vault staff, each only where they belong', async () => {
    assert.equal((await start(h.as('ada', 'none', 'admin'))).status, 200);
    assert.equal((await start(h.as('rita', 'release_manager'))).status, 200);
    assert.equal((await start(h.as('rita', 'release_manager'), { game: 'quest', files }, 'ucalgary')).status, 200); // Vault uploads for any studio
    assert.equal((await start(h.as('vera', 'none', 'viewer'))).status, 403);
    assert.equal((await start(h.as('sam'))).status, 404);
    assert.equal((await start(h.as('mia', 'none', 'maintainer'), { game: 'quest', files }, 'ucalgary')).status, 404); // not her studio
    assert.equal((await h.app.request('/portal/api/s/fieldday/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'tide', files }) })).status, 403); // no portal header
    assert.equal((await h.app.request('/portal/api/s/fieldday/uploads', { method: 'POST', headers: { 'X-Requested-With': 'vault-portal', 'Content-Type': 'application/json' }, body: '{}' })).status, 401); // not signed in
  });

  test('finalizing is for the studio’s own portal uploads only', async () => {
    const mia = h.as('mia', 'none', 'maintainer');
    const up = await (await start(mia)).json() as { upload_id: string; ref: string };
    for (const f of files) staging.objects.set(`fieldday/tide/${up.ref}/${f.path}`, f.size);
    assert.equal((await h.as('vera', 'none', 'viewer').post(`/portal/api/s/fieldday/uploads/${up.upload_id}/finalize`)).status, 403);
    assert.equal((await h.as('rita', 'release_manager').post(`/portal/api/s/ucalgary/uploads/${up.upload_id}/finalize`)).status, 404); // another studio's address
    assert.equal((await mia.post('/portal/api/s/fieldday/uploads/nope/finalize')).status, 404);
    await publish('repo', 'ci-game'); // an upload CI started can't be finalized from the portal
    const ciUpload = await (await ci('/v1/previews', 'repo', { game: 'ci-game', files: [{ path: 'index.html', size: 5 }] })).json() as { upload_id: string };
    assert.equal((await mia.post(`/portal/api/s/fieldday/uploads/${ciUpload.upload_id}/finalize`)).status, 404);
    assert.equal((await mia.post(`/portal/api/s/fieldday/uploads/${up.upload_id}/finalize`)).status, 200);
    assert.equal((await mia.post(`/portal/api/s/fieldday/uploads/${up.upload_id}/finalize`)).status, 409); // once
  });

  test('unsafe paths, a missing index.html, reserved names and oversize builds are refused before any upload address is issued', async () => {
    const mia = h.as('mia', 'none', 'maintainer');
    const index = { path: 'index.html', size: 1 };
    for (const path of ['../escape.js', 'a/../../b.js', '/etc/passwd', 'a\\b.js', 'a//b.js', './a.js', '']) {
      const r = await start(mia, { game: 'tide', files: [index, { path, size: 1 }] });
      assert.equal(r.status, 400, path);
    }
    assert.match((await (await start(mia, { game: 'tide', files: [{ path: 'game.js', size: 1 }] })).json() as { error: string }).error, /no index\.html/);
    assert.match((await (await start(mia, { game: 'tide', files: [index, { path: '_releases/v1/x.js', size: 1 }] })).json() as { error: string }).error, /a name Vault uses/);
    assert.match((await (await start(mia, { game: 'tide', files: [index, { path: 'big.data', size: 3 * 1024 ** 3 }] })).json() as { error: string }).error, /at most 2048 MB/);
    assert.match((await (await start(mia, { game: 'tide', files: [index, ...Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}`, size: 1 }))] })).json() as { error: string }).error, /at most 5000 files/);
    assert.equal((await start(mia, { game: 'Not A Slug', files })).status, 400);
    assert.equal((await start(mia, { game: 'tide', files: [index, index] })).status, 400);
    assert.equal((await start(mia, { game: 'tide', files: 'nope' })).status, 400);
    assert.equal(staging.objects.size, 0);
    assert.equal(h.db.game(h.db.studioBySlug('fieldday')!.id, 'tide'), undefined); // and no game was made
  });

  test('test build names say when they were uploaded, and two in the same minute don’t collide', async () => {
    assert.equal(uploadRefName(new Date('2026-10-01T14:32:59Z')), 'upload-20261001-1432');
    const mia = h.as('mia', 'none', 'maintainer');
    const a = await (await start(mia)).json() as { upload_id: string; ref: string };
    for (const f of files) staging.objects.set(`fieldday/tide/${a.ref}/${f.path}`, f.size);
    await mia.post(`/portal/api/s/fieldday/uploads/${a.upload_id}/finalize`);
    const b = await (await start(mia)).json() as { ref: string };
    assert.notEqual(b.ref, a.ref);
  });

  test('a repository that later publishes the game takes it over, uploads and all', async () => {
    const mia = h.as('mia', 'none', 'maintainer');
    await start(mia);
    await publish('repo');
    assert.equal(game().repository, 'fielddaylab/tide');
  });
});

describe('monitoring a web address in the portal (path 4)', () => {
  const body = { game: 'tide', url: 'https://games.example.org/tide', files_from: 'list', list_url: 'files.txt' };
  beforeEach(() => { web = { 'https://games.example.org/tide/files.txt': 'index.html\ngame.js', 'https://games.example.org/tide/': '<h1>v1</h1>', 'https://games.example.org/tide/game.js': 'js' }; });

  test('a maintainer registers an address; it is copied at once, checked on demand, and stopped', async () => {
    const mia = h.as('mia', 'none', 'maintainer');
    const res = await mia.post('/portal/api/s/fieldday/monitors', body);
    assert.equal(res.status, 200);
    assert.match((await res.json() as { message: string }).message, /Copied 2 files/);
    const [m] = monitorsForStudio(h.db, game().studio_id);
    assert.deepEqual([m.url, m.files_from, m.list_url, m.ref_name, m.created_by], ['https://games.example.org/tide/', 'list', 'https://games.example.org/tide/files.txt', 'web-copy', 'user:mia']);
    assert.equal(h.db.build(game().id, 'web-copy')!.status, 'live');
    assert.equal(Buffer.from(staging.data.get('fieldday/tide/web-copy/index.html')!).toString(), '<h1>v1</h1>');
    const setup = await (await mia.get('/s/fieldday/register')).text();
    assert.match(setup, /Addresses Vault is watching[\s\S]*games\.example\.org\/tide\/[\s\S]*Check now/);
    const page = await (await mia.get('/s/fieldday/g/tide?tab=cdn')).text();
    assert.match(page, /web-copy<\/span> <span class="tag">web copy<\/span>/);
    assert.match(page, /is copied from <a[^>]*>https:\/\/games\.example\.org\/tide\//);

    web['https://games.example.org/tide/'] = '<h1>v2</h1>';
    const again = await (await mia.post(`/portal/api/s/fieldday/monitors/${m.id}/check`)).json() as { status: string };
    assert.equal(again.status, 'changed');
    assert.equal(Buffer.from(staging.data.get('fieldday/tide/web-copy/index.html')!).toString(), '<h1>v2</h1>');
    assert.equal((await (await mia.post(`/portal/api/s/fieldday/monitors/${m.id}/check`)).json() as { status: string }).status, 'unchanged');

    assert.equal((await mia.post(`/portal/api/s/fieldday/monitors/${m.id}/delete`)).status, 200);
    assert.deepEqual(monitorsForStudio(h.db, game().studio_id), []);
    assert.equal(h.db.build(game().id, 'web-copy')!.status, 'live'); // its test build stays
  });

  test('who may: the same people as uploads', async () => {
    assert.equal((await h.as('vera', 'none', 'viewer').post('/portal/api/s/fieldday/monitors', body)).status, 403);
    assert.equal((await h.as('sam').post('/portal/api/s/fieldday/monitors', body)).status, 404);
    await h.as('ada', 'none', 'admin').post('/portal/api/s/fieldday/monitors', body);
    const [m] = monitorsForStudio(h.db, game().studio_id);
    assert.equal((await h.as('vera', 'none', 'viewer').post(`/portal/api/s/fieldday/monitors/${m.id}/check`)).status, 403);
    assert.equal((await h.as('vera', 'none', 'viewer').post(`/portal/api/s/fieldday/monitors/${m.id}/delete`)).status, 403);
    assert.equal((await h.as('rita', 'release_manager').post(`/portal/api/s/ucalgary/monitors/${m.id}/check`)).status, 404); // not that studio's monitor
    assert.equal((await h.as('rita', 'release_manager').post(`/portal/api/s/fieldday/monitors/${m.id}/check`)).status, 200);
  });

  test('private, non-web and off-site addresses are refused and nothing is saved', async () => {
    const mia = h.as('mia', 'none', 'maintainer');
    for (const url of ['http://localhost:3000/game/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.8/', 'http://[::1]/', 'file:///etc/passwd', 'ftp://games.example.org/tide/', 'not a url', '']) {
      assert.equal((await mia.post('/portal/api/s/fieldday/monitors', { ...body, url })).status, 400, url);
    }
    assert.equal((await mia.post('/portal/api/s/fieldday/monitors', { ...body, list_url: 'https://elsewhere.example.com/files.txt' })).status, 400);
    assert.equal((await mia.post('/portal/api/s/fieldday/monitors', { ...body, list_url: '' })).status, 400);
    assert.equal(h.db.game(h.db.studioBySlug('fieldday')!.id, 'tide'), undefined);
  });

  test('a site that can’t be copied is saved with the reason, and a branch called web-copy isn’t overwritten', async () => {
    const mia = h.as('mia', 'none', 'maintainer');
    delete web['https://games.example.org/tide/game.js'];
    const out = await (await mia.post('/portal/api/s/fieldday/monitors', body)).json() as { status: string; message: string };
    assert.equal(out.status, 'error');
    assert.match(out.message, /game\.js answered 404/);
    assert.match(await (await mia.get('/s/fieldday/register')).text(), /Couldn’t copy[\s\S]*game\.js answered 404/);

    ids.repo = { ...repo, repository: 'fielddaylab/pond', ref: 'refs/heads/web-copy' };
    await publish('repo', 'pond');
    assert.equal((await mia.post('/portal/api/s/fieldday/monitors', { ...body, game: 'pond' })).status, 409);
  });

  test('the scheduled tasks check monitors, and the cleanup keeps a monitored build that hasn’t changed in months', async () => {
    await h.as('mia', 'none', 'maintainer').post('/portal/api/s/fieldday/monitors', body);
    h.db.sqlite.prepare("UPDATE builds SET updated_at = '2020-01-01T00:00:00.000Z'").run();
    const task = (path: string, token = 'scheduler') => h.app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await task('/v1/tasks/monitors', 'nope')).status, 401);
    const out = await (await task('/v1/tasks/monitors')).json() as { checked: { game: string; status: string }[]; left: number };
    assert.deepEqual(out, { checked: [{ game: 'fieldday/tide', status: 'unchanged', message: 'No changes (2 files checked).' }], left: 0 });
    const cleanup = await (await task('/v1/tasks/cleanup')).json() as { removed: string[]; monitors: { checked: unknown[] } };
    assert.deepEqual(cleanup.removed, []);
    assert.equal(cleanup.monitors.checked.length, 1);
    assert.equal(h.db.build(game().id, 'web-copy')!.status, 'live');
  });
});

describe('a repository assigned to a studio (its organization belongs to another studio)', () => {
  // VaultLearningGames/hosted-quest is assigned to ucalgary, which has no GitHub organization of its own.
  const hosted: GitHubIdentity = { owner: 'VaultLearningGames', ownerId: '214136763', repository: 'VaultLearningGames/hosted-quest', repositoryId: '555', ref: 'refs/heads/production', sha: 'e'.repeat(40), actor: 'vaultdev', eventName: 'push' };
  const calgary = () => h.db.studioBySlug('ucalgary')!;
  beforeEach(() => {
    h.db.syncStudios([{ slug: 'vault', name: 'Vault Learning Games', github_owner: 'VaultLearningGames', github_owner_id: '214136763' }]);
    h.db.bindRepository({ repository_id: '555', repository: 'VaultLearningGames/hosted-quest', studio_id: calgary().id, created_by: 'user:boss', source: 'portal' });
    ids.hosted = hosted;
    ids.sibling = { ...hosted, repository: 'VaultLearningGames/vault-publisher-test', repositoryId: '556' }; // same organization, not assigned
  });

  test('its automatic publish request is filed in the studio it is assigned to, not its organization’s', async () => {
    await publish('hosted', 'quest');
    const out = await (await ci('/v1/release-requests', 'hosted', { game: 'quest' })).json() as { status: string; version: string; url: string };
    assert.deepEqual([out.status, out.version, out.url], ['requested', 'production-eeeeeee', 'https://portal.test/s/ucalgary/g/quest?tab=cdn']);
    const quest = h.db.game(calgary().id, 'quest')!;
    assert.deepEqual(h.db.releaseRequests({ gameId: quest.id }).map((r) => [r.studio_slug, r.version, r.status]), [['ucalgary', 'production-eeeeeee', 'requested']]);
    assert.equal(h.db.game(h.db.studioBySlug('vault')!.id, 'quest'), undefined);
    // Another repository of the same organization publishes for the organization's studio, where there is no such game.
    assert.equal((await ci('/v1/release-requests', 'sibling', { game: 'quest' })).status, 404);
    // Once the assignment is removed, the repository is its organization's again and can't reach the game.
    h.db.unbindRepository('555');
    assert.equal((await ci('/v1/release-requests', 'hosted', { game: 'quest' })).status, 404);
  });

  test('a zip uploaded in the portal goes to that studio, and the assigned repository takes the game over on its first push', async () => {
    h.db.setMembership(calgary().id, 'cal', 'maintainer', 'test');
    const cal = h.as('cal');
    const files = [{ path: 'index.html', size: 9 }];
    const up = await (await cal.post('/portal/api/s/ucalgary/uploads', { game: 'quest', files })).json() as { upload_id: string; ref: string; files: { url: string }[] };
    assert.equal(up.files[0].url, `https://r2.test/ucalgary/quest/${up.ref}/index.html`);
    staging.objects.set(`ucalgary/quest/${up.ref}/index.html`, 9);
    assert.equal((await cal.post(`/portal/api/s/ucalgary/uploads/${up.upload_id}/finalize`)).status, 200);
    assert.equal((await cal.post('/portal/api/s/fieldday/uploads', { game: 'quest', files })).status, 404); // not a member there
    const quest = () => h.db.game(calgary().id, 'quest')!;
    assert.equal(quest().repository_id, 'vault:ucalgary/quest');
    assert.equal((await ci('/v1/previews', 'sibling', { game: 'quest', files })).status, 200); // the organization's own studio: a different game
    assert.equal(quest().repository_id, 'vault:ucalgary/quest');
    await publish('hosted', 'quest');
    assert.equal(quest().repository, 'VaultLearningGames/hosted-quest');
    assert.deepEqual(h.db.liveBuilds(quest().id).map((b) => b.ref_name).sort(), ['production', up.ref].sort()); // the upload is still there
    assert.equal((await ci('/v1/release-requests', 'hosted', { game: 'quest' })).status, 200);
    const page = await (await cal.get('/s/ucalgary/register')).text();
    assert.match(page, /Vault accepts uploads for this studio from <b>github\.com\/VaultLearningGames\/hosted-quest<\/b>/);
  });
});

describe('the url_monitors migration is v15 (and site_checks v16 after it)', () => {
  const version = (db: Db) => (db.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  const tables = (db: Db) => (db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);

  test('a new database ends at v16 with both tables', () => {
    const db = new Db(':memory:');
    assert.equal(version(db), 16);
    assert.ok(tables(db).includes('studio_repositories') && tables(db).includes('url_monitors'));
  });

  test('a database already at v14 (repository assignments, no monitors) upgrades and keeps its data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-publisher-v15-'));
    try {
      const path = join(dir, 'publisher.db');
      const main = new Db(path);
      main.syncStudios([{ slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' }]);
      const studio = main.studioBySlug('ucalgary')!;
      main.bindRepository({ repository_id: '555', repository: 'VaultLearningGames/hosted-quest', studio_id: studio.id, created_by: 'user:boss', source: 'portal' });
      const game = main.createGame(studio.id, 'quest', 'VaultLearningGames/hosted-quest', '555');
      main.sqlite.exec('DROP TABLE site_checks; DROP TABLE url_monitors; PRAGMA user_version = 14;'); // as origin/main leaves it
      main.sqlite.close();
      for (let boot = 0; boot < 2; boot++) { // the upgrade, then an ordinary restart
        const db = new Db(path);
        assert.equal(version(db), 16);
        assert.equal(db.studioByRepositoryId('555')!.slug, 'ucalgary');
        const m = saveMonitor(db, { game_id: game.id, url: 'https://games.example.org/quest/', files_from: 'crawl', list_url: null, by: 'user:boss' });
        assert.equal(monitorsForStudio(db, studio.id)[0].id, m.id);
        db.sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
