import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, SWITCH_STALE_MS, type AppDeps } from '../src/app.ts';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import { browseKeys, type Storage } from '../src/storage.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import type { Readable } from 'node:stream';
import { copyRelease, makeLive, StorageTimeoutError } from '../src/releases.ts';

class FakeStorage implements Storage {
  objects = new Map<string, number>();
  data = new Map<string, Uint8Array>();
  headers = new Map<string, ObjectHeaders>();
  failPutAfter = Infinity;
  async get(key: string) {
    if (!this.objects.has(key)) throw new Error(`no such key ${key}`);
    return this.data.get(key) ?? new Uint8Array(this.objects.get(key)!);
  }
  async put(key: string, body: Readable | Uint8Array, size: number, headers: ObjectHeaders, _signal?: AbortSignal) {
    if (this.failPutAfter-- <= 0) throw new Error('simulated R2 failure');
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await (body as Readable).toArray()));
    this.objects.set(key, size);
    this.data.set(key, bytes);
    this.headers.set(key, headers);
  }
  async presignPut(key: string) {
    return `https://r2.test/${key}`;
  }
  async list(prefix: string) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size }));
  }
  async browse(prefix: string) { return browseKeys(this.objects, prefix); }
  async copy(src: string, dst: string, headers: ObjectHeaders, _signal?: AbortSignal) {
    if (!this.objects.has(src)) throw new Error(`no such key ${src}`);
    await this.put(dst, this.data.get(src) ?? new Uint8Array(this.objects.get(src)!), this.objects.get(src)!, headers);
  }
  async deleteKeys(keys: string[]) {
    for (const k of keys) this.objects.delete(k);
  }
}

const wake: GitHubIdentity = {
  owner: 'fielddaylab',
  ownerId: '1881825',
  repository: 'fielddaylab/wake',
  repositoryId: '100',
  ref: 'refs/heads/feature/new-map',
  sha: 'abc123',
  actor: 'dev',
  eventName: 'push',
};
const otherRepo: GitHubIdentity = { ...wake, repository: 'fielddaylab/bloom', repositoryId: '200' };
const otherOrg: GitHubIdentity = { ...wake, owner: 'acme', ownerId: '999', repository: 'acme/wake', repositoryId: '300' };

// Tokens in tests are just keys into this table.
const releaser: GitHubIdentity = { ...wake, repository: 'VaultLearningGames/vault-publisher', repositoryId: '900', ref: 'refs/heads/main', eventName: 'workflow_dispatch', environment: 'production' };
const releaserNoEnv: GitHubIdentity = { ...releaser, environment: undefined };
const identities: Record<string, GitHubIdentity> = { wake, otherRepo, otherOrg, releaser, releaserNoEnv };
const verifier: Verifier = {
  async github(token) {
    const id = identities[token];
    if (!id) throw new Error('bad signature');
    return id;
  },
  async google(token) {
    if (token !== 'scheduler') throw new Error('bad signature');
    return 'scheduler@example.iam.gserviceaccount.com';
  },
};

let db: Db;
let storage: FakeStorage;
let prod: FakeStorage;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new Db(':memory:');
  db.syncStudios([{ slug: 'fielddaylab', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' }]);
  db.syncStudios([{ slug: 'fielddaylab', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' }]); // idempotent
  storage = new FakeStorage();
  prod = new FakeStorage();
  app = newApp();
});

function newApp(extra: Partial<AppDeps> = {}) {
  return createApp({
    db,
    staging: storage,
    production: prod,
    verifier,
    stagingPublicUrl: 'https://cdn.example-staging.org',
    prodPublicUrl: 'https://cdn.example.org',
    adminRepository: 'VaultLearningGames/vault-publisher',
    adminEnvironment: 'production',
    portal: { baseUrl: 'https://portal.test', vaultAdmins: [] },
    previewRetentionDays: 90,
    taskInvokerEmail: 'scheduler@example.iam.gserviceaccount.com',
    ...extra,
  });
}

function post(path: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request(path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const files = [
  { path: 'index.html', size: 10 },
  { path: 'Build/game.wasm.br', size: 20 },
];

async function start(token = 'wake', body: unknown = { game: 'aqualab', files }) {
  const res = await post('/v1/previews', token, body);
  return { res, json: (await res.json()) as any };
}

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

function uploadAll(json: any, sizes: Record<string, number> = { 'index.html': 10, 'Build/game.wasm.br': 20 }) {
  for (const f of json.files) storage.objects.set(new URL(f.url).pathname.slice(1), sizes[f.path]);
}

describe('publishing a preview', () => {
  test('returns presigned URLs under studio/game/ref with Unity-aware headers', async () => {
    const { res, json } = await start();
    assert.equal(res.status, 200);
    assert.equal(json.url, 'https://cdn.example-staging.org/fielddaylab/aqualab/feature_new-map/');
    const wasm = json.files.find((f: any) => f.path === 'Build/game.wasm.br');
    assert.equal(wasm.url, 'https://r2.test/fielddaylab/aqualab/feature_new-map/Build/game.wasm.br');
    assert.deepEqual(wasm.headers, {
      'Content-Type': 'application/wasm',
      'Cache-Control': 'public, max-age=60',
      'Content-Encoding': 'br',
    });
  });

  test('finalize records the build and removes files from the previous build', async () => {
    storage.objects.set('fielddaylab/aqualab/feature_new-map/Build/old.data', 5);
    const { json } = await start();
    uploadAll(json);
    const res = await post(`/v1/previews/${json.upload_id}/finalize`, 'wake');
    assert.equal(res.status, 200);
    assert.equal(storage.objects.has('fielddaylab/aqualab/feature_new-map/Build/old.data'), false);
    assert.equal(storage.objects.size, 2);
    const build = db.build(db.game(1, 'aqualab')!.id, 'feature_new-map');
    assert.equal(build?.status, 'live');
    assert.equal(build?.ref_type, 'branch');
  });

  test('finalize refuses when a file is missing or the wrong size', async () => {
    const { json } = await start();
    uploadAll(json, { 'index.html': 10, 'Build/game.wasm.br': 19 });
    const res = await post(`/v1/previews/${json.upload_id}/finalize`, 'wake');
    assert.equal(res.status, 409);
    assert.deepEqual(((await res.json()) as any).detail, ['Build/game.wasm.br']);
  });

  test('an older upload cannot finalize after a newer one started', async () => {
    const first = await start();
    await start();
    uploadAll(first.json);
    const res = await post(`/v1/previews/${first.json.upload_id}/finalize`, 'wake');
    assert.equal(res.status, 409);
  });

  test('tags publish as release candidates', async () => {
    identities.tag = { ...wake, ref: 'refs/tags/m3.2' };
    const { json } = await start('tag');
    assert.equal(json.url, 'https://cdn.example-staging.org/fielddaylab/aqualab/m3.2/');
  });
});

describe('authorization', () => {
  test('rejects a missing or invalid token', async () => {
    assert.equal((await start('nope')).res.status, 401);
    assert.equal((await post('/v1/previews', null, { game: 'aqualab', files })).status, 401);
  });

  test('rejects an org that is not a registered studio', async () => {
    assert.equal((await start('otherOrg')).res.status, 403);
  });

  test('a game can only be published from the repository that first claimed it', async () => {
    assert.equal((await start('wake')).res.status, 200);
    assert.equal((await start('otherRepo')).res.status, 403);
  });

  test('another repository cannot finalize or delete the game', async () => {
    const { json } = await start();
    uploadAll(json);
    assert.equal((await post(`/v1/previews/${json.upload_id}/finalize`, 'otherRepo')).status, 403);
    assert.equal((await post('/v1/previews/delete', 'otherRepo', { game: 'aqualab', ref: 'feature/new-map' })).status, 403);
  });

  test('pull_request refs are rejected', async () => {
    identities.pr = { ...wake, ref: 'refs/pull/7/merge', eventName: 'pull_request' };
    assert.equal((await start('pr')).res.status, 400);
  });
});

describe('input validation', () => {
  for (const [name, body] of [
    ['bad game slug', { game: 'Aqua Lab', files }],
    ['path traversal', { game: 'aqualab', files: [{ path: '../other/index.html', size: 1 }] }],
    ['absolute path', { game: 'aqualab', files: [{ path: '/index.html', size: 1 }] }],
    ['duplicate path', { game: 'aqualab', files: [files[0], files[0]] }],
    ['negative size', { game: 'aqualab', files: [{ path: 'a', size: -1 }] }],
    ['empty files', { game: 'aqualab', files: [] }],
  ] as const) {
    test(`rejects ${name}`, async () => {
      assert.equal((await start('wake', body)).res.status, 400);
    });
  }
});

describe('deleting and cleanup', () => {
  test('delete removes every object and marks the build deleted', async () => {
    const { json } = await start();
    uploadAll(json);
    await post(`/v1/previews/${json.upload_id}/finalize`, 'wake');
    const res = await post('/v1/previews/delete', 'wake', { game: 'aqualab', ref: 'feature/new-map' });
    assert.deepEqual(await res.json(), { deleted: 2 });
    assert.equal(storage.objects.size, 0);
    assert.equal(db.build(1, 'feature_new-map')?.status, 'deleted');
  });

  test('cleanup requires the scheduler identity', async () => {
    assert.equal((await post('/v1/tasks/cleanup', 'wake')).status, 401);
  });

  test('cleanup expires stale branch previews but keeps tags', async () => {
    for (const token of ['wake', 'tag']) {
      identities.tag = { ...wake, ref: 'refs/tags/m3.2' };
      const { json } = await start(token);
      uploadAll(json);
      await post(`/v1/previews/${json.upload_id}/finalize`, token);
    }
    db.sqlite.prepare("UPDATE builds SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    const res = await post('/v1/tasks/cleanup', 'scheduler');
    assert.deepEqual(((await res.json()) as any).removed, ['fielddaylab/aqualab/feature_new-map/']);
    assert.equal(db.build(1, 'm3.2')?.status, 'live');
    assert.equal([...storage.objects.keys()].every((k) => k.includes('/m3.2/')), true);
  });
});

describe('production releases', () => {
  async function publishTag(tag = 'm3.2') {
    identities.tag = { ...wake, ref: `refs/tags/${tag}` };
    const { json } = await start('tag');
    uploadAll(json);
    await post(`/v1/previews/${json.upload_id}/finalize`, 'tag');
  }
  const approve = (version = 'm3.2', token = 'releaser', extra = {}) =>
    post('/v1/admin/releases/approve', token, { studio: 'fielddaylab', game: 'aqualab', version, ...extra });
  const promote = (version: string, token = 'releaser') =>
    post('/v1/admin/releases/promote', token, { studio: 'fielddaylab', game: 'aqualab', version });

  test('approve copies the staging build into production with a one-year immutable cache', async () => {
    await publishTag();
    const res = await approve();
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).url, 'https://cdn.example.org/fielddaylab/aqualab/_releases/m3.2/');
    assert.deepEqual([...prod.objects.keys()].sort(), ['fielddaylab/aqualab/_releases/m3.2/Build/game.wasm.br', 'fielddaylab/aqualab/_releases/m3.2/index.html']);
    const wasm = prod.headers.get('fielddaylab/aqualab/_releases/m3.2/Build/game.wasm.br')!;
    assert.equal(wasm.cacheControl, 'public, max-age=31536000, immutable');
    assert.equal(wasm.contentEncoding, 'br');
    assert.equal(wasm.contentType, 'application/wasm');
    assert.equal(db.release(1, 'm3.2')?.commit_sha, 'abc123');
  });

  test('a release can never be approved twice or overwritten', async () => {
    await publishTag();
    assert.equal((await approve()).status, 200);
    assert.equal((await approve()).status, 409);
  });

  test('publish (the admin task "release"): approve and promote in one call, a dry run, and safe to repeat', async () => {
    const publish = (body: Record<string, unknown>, token = 'releaser') =>
      post('/v1/admin/releases/publish', token, { studio: 'fielddaylab', game: 'aqualab', ...body });
    const { json } = await start(); // the feature/new-map branch
    uploadAll(json);
    await post(`/v1/previews/${json.upload_id}/finalize`, 'wake');

    assert.equal((await publish({ version: 'v1', ref: 'feature/new-map' }, 'wake')).status, 403);
    assert.equal((await publish({ version: 'v1', ref: 'nope' })).status, 404);
    assert.equal((await publish({ version: 'v1', dry_run: 'yes' })).status, 400);
    const dry = await publish({ version: 'v1', ref: 'feature/new-map', dry_run: true });
    assert.equal(dry.status, 200);
    assert.deepEqual(pick(await dry.json(), ['approve', 'promote', 'current', 'ref']), { approve: true, promote: true, current: null, ref: 'feature_new-map' });
    assert.equal(prod.objects.size, 0);
    assert.equal(db.release(1, 'v1'), undefined);

    const res = await publish({ version: 'v1', ref: 'feature/new-map' });
    assert.equal(res.status, 200);
    assert.deepEqual(pick(await res.json(), ['approved', 'promoted', 'current', 'play_url']), { approved: true, promoted: true, current: 'v1', play_url: 'https://cdn.example.org/fielddaylab/aqualab/' });
    assert.equal(prod.objects.has('fielddaylab/aqualab/index.html'), true);
    assert.equal(db.currentRelease(1)?.version, 'v1');

    const again = await publish({ version: 'v1', ref: 'feature/new-map' });
    assert.deepEqual(pick(await again.json(), ['approved', 'promoted', 'current']), { approved: false, promoted: false, current: 'v1' });
    assert.equal((await publish({ version: 'v1', ref: 'other' })).status, 409, 'a release is never replaced from another ref');
    // promote: false only approves.
    const only = await publish({ version: 'v2', ref: 'feature/new-map', promote: false });
    assert.deepEqual(pick(await only.json(), ['approved', 'promoted', 'current']), { approved: true, promoted: false, current: 'v1' });
  });

  test('a copy or a switch cut short by its deadline carries on where it stopped', async () => {
    const src = new FakeStorage(), dst = new FakeStorage();
    for (let i = 0; i < 20; i++) src.objects.set(`s/g/b/f${String(i).padStart(2, '0')}.js`, 10 + i);
    src.objects.set('s/g/b/index.html', 5);
    dst.objects.set('s/g/_releases/v1/stale.js', 3); // left by an earlier build: removed on resume
    const slow = Object.assign(Object.create(dst), { put: async (...a: Parameters<FakeStorage['put']>) => { await new Promise((r) => setTimeout(r, 5)); return dst.put(...a); } }) as FakeStorage;
    const opts = { staging: src, production: slow, srcPrefix: 's/g/b/', dstPrefix: 's/g/_releases/v1/' };
    const first = await copyRelease({ ...opts, deadline: Date.now() + 12, concurrency: 1, resume: true });
    assert.ok(first.remaining > 0 && first.remaining < 21, `remaining ${first.remaining}`);
    assert.equal(dst.objects.has('s/g/_releases/v1/stale.js'), false);
    const puts = dst.objects.size;
    const second = await copyRelease({ ...opts, resume: true });
    assert.deepEqual(second, { files: 21, bytes: 5 + 20 * 10 + 190, remaining: 0 });
    assert.equal(dst.objects.size, 21);
    assert.ok(puts >= 21 - first.remaining);

    // makeLive: stop part-way, then skip what was done; index.html last, current.json only at the end.
    dst.objects.set('s/g/old.js', 1);
    const live = await makeLive(dst, 's/g/', 'v1', { deadline: 0 });
    assert.deepEqual([live.done, live.remaining], [0, 21]);
    const slowCopy = Object.assign(Object.create(dst), { copy: async (...a: Parameters<FakeStorage['copy']>) => { await new Promise((r) => setTimeout(r, 5)); return dst.copy(...a); } }) as FakeStorage;
    const part = await makeLive(slowCopy, 's/g/', 'v1', { deadline: Date.now() + 12, concurrency: 1 });
    assert.ok(part.remaining > 0 && part.done === 21 - part.remaining);
    assert.equal(dst.objects.has('s/g/index.html'), false);
    assert.equal(dst.objects.has('s/g/current.json'), false);
    assert.equal(dst.objects.has('s/g/old.js'), true, 'the old release stays until the switch finishes');
    const rest = await makeLive(dst, 's/g/', 'v1', { skip: part.done });
    assert.deepEqual([rest.done, rest.remaining], [21, 0]);
    assert.equal(dst.objects.has('s/g/index.html'), true);
    assert.equal(dst.objects.has('s/g/current.json'), true);
    assert.equal(dst.objects.has('s/g/old.js'), false);
  });

  test('approve resumes files left by an unfinished copy of the same build, and refuses leftovers it did not start', async () => {
    await publishTag();
    prod.objects.set('fielddaylab/aqualab/_releases/m3.2/index.html', 10);
    assert.equal((await approve()).status, 409);
    const b = db.build(1, 'm3.2')!;
    db.setSetting('release_copy:1:m3.2', `${b.id}:${b.updated_at}:${b.commit_sha}`);
    const res = await approve();
    assert.equal(res.status, 200);
    assert.equal(db.release(1, 'm3.2')?.file_count, 2);
    assert.equal(db.setting('release_copy:1:m3.2'), '');
  });

  test('approving from another staging ref (e.g. a legacy import) works with ref', async () => {
    const { json } = await start(); // feature/new-map branch
    uploadAll(json);
    await post(`/v1/previews/${json.upload_id}/finalize`, 'wake');
    const res = await approve('legacy-2026-09', 'releaser', { ref: 'feature/new-map' });
    assert.equal(res.status, 200);
    assert.equal(db.release(1, 'legacy-2026-09')?.source_ref, 'feature_new-map');
  });

  test('a failed copy leaves nothing behind so it can be retried', async () => {
    await publishTag();
    prod.failPutAfter = 1;
    await assert.rejects(async () => { const r = await approve(); if (r.status >= 500) throw new Error(String(r.status)); });
    assert.equal(prod.objects.size, 0);
    assert.equal(db.release(1, 'm3.2'), undefined);
    prod.failPutAfter = Infinity;
    assert.equal((await approve()).status, 200);
  });

  test('only the Release workflow in the production environment may approve or promote', async () => {
    await publishTag();
    assert.equal((await approve('m3.2', 'wake')).status, 403);          // a game repo
    assert.equal((await approve('m3.2', 'releaserNoEnv')).status, 403); // right repo, no protected environment
    assert.equal((await promote('m3.2', 'wake')).status, 403);
  });

  test('promote copies a release into STUDIO/GAME/ itself; promoting an older one is a rollback', async () => {
    await publishTag('m3.1');
    await approve('m3.1');
    await publishTag('m3.2');
    await approve('m3.2');
    const live = () => [...prod.objects.keys()].filter((k) => !k.includes('/_releases/')).sort();
    let res = await promote('m3.2');
    assert.deepEqual(await res.json(), { current: 'm3.2', previous: null, rollback: false, url: 'https://cdn.example.org/fielddaylab/aqualab/' });
    assert.deepEqual(live(), ['fielddaylab/aqualab/Build/game.wasm.br', 'fielddaylab/aqualab/current.json', 'fielddaylab/aqualab/index.html']);
    const wasm = prod.headers.get('fielddaylab/aqualab/Build/game.wasm.br')!;
    assert.equal(wasm.cacheControl, 'no-cache');   // overwritten on every switch: revalidate (304s are cheap)
    assert.equal(wasm.contentEncoding, 'br');
    assert.equal(prod.headers.get('fielddaylab/aqualab/index.html')?.cacheControl, 'no-cache');
    // index.html is written last, so a visitor mid-switch never gets a page whose files aren't there yet.
    const order = [...prod.headers.keys()].filter((k) => !k.includes('/_releases/'));
    assert.ok(order.indexOf('fielddaylab/aqualab/index.html') > order.indexOf('fielddaylab/aqualab/Build/game.wasm.br'));
    // Files the new release doesn't have are removed; the archive is untouched.
    prod.objects.set('fielddaylab/aqualab/Build/old-only.js', 1);
    res = await promote('m3.1');
    assert.equal(((await res.json()) as any).rollback, true);
    assert.ok(!prod.objects.has('fielddaylab/aqualab/Build/old-only.js'));
    assert.match(new TextDecoder().decode(prod.data.get('fielddaylab/aqualab/current.json')), /"version":"m3.1"/);
    assert.equal(prod.objects.size, 7); // 2 releases × 2 files + 2 live files + current.json
    const list = (await (await app.request('/v1/releases/fielddaylab/aqualab')).json()) as any;
    assert.equal(list.current, 'm3.1');
    assert.deepEqual(list.releases.map((r: any) => r.version), ['m3.2', 'm3.1']);
  });

  test('a switch that fails part-way puts the previous release back', async () => {
    await publishTag('m3.1');
    await approve('m3.1');
    await publishTag('m3.2');
    await approve('m3.2');
    await promote('m3.1');
    prod.data.set('fielddaylab/aqualab/_releases/m3.2/index.html', new TextEncoder().encode('new'));
    prod.data.set('fielddaylab/aqualab/_releases/m3.1/index.html', new TextEncoder().encode('old'));
    await promote('m3.1');
    prod.failPutAfter = 1; // the first file copies, the second fails
    const res = await promote('m3.2');
    assert.equal(res.status, 500);
    prod.failPutAfter = Infinity;
    assert.equal(db.currentRelease(1)?.version, 'm3.1');
    assert.equal(new TextDecoder().decode(prod.data.get('fielddaylab/aqualab/index.html')), 'old');
  });

  // Copies of a file in the production bucket that wait until `release()` (or their signal) lets them go.
  function holdCopies(match: (dst: string) => boolean, honourSignal = true) {
    const real = prod.copy.bind(prod);
    const held: { dst: string; go: () => void }[] = [];
    let reached: () => void;
    const first = new Promise<void>((r) => { reached = r; });
    prod.copy = (src, dst, headers, signal) => {
      if (!match(dst)) return real(src, dst, headers, signal);
      return new Promise<void>((resolve, reject) => {
        held.push({ dst, go: () => real(src, dst, headers).then(resolve, reject) });
        const h = held[held.length - 1];
        if (honourSignal) signal?.addEventListener('abort', () => { held.splice(held.indexOf(h), 1); reject(signal.reason); }, { once: true });
        reached();
      });
    };
    return { first, held, restore: () => { prod.copy = real; }, release: () => held.splice(0).forEach((h) => h.go()) };
  }
  async function twoReleases() {
    await publishTag('m3.1');
    await approve('m3.1');
    await publishTag('m3.2');
    await approve('m3.2');
    prod.data.set('fielddaylab/aqualab/_releases/m3.1/index.html', new TextEncoder().encode('old'));
    prod.data.set('fielddaylab/aqualab/_releases/m3.2/index.html', new TextEncoder().encode('new'));
    prod.data.set('fielddaylab/aqualab/_releases/m3.1/Build/game.wasm.br', new TextEncoder().encode('old wasm'));
    prod.data.set('fielddaylab/aqualab/_releases/m3.2/Build/game.wasm.br', new TextEncoder().encode('new wasm'));
    assert.equal((await promote('m3.1')).status, 200);
  }
  const liveText = (rel: string) => new TextDecoder().decode(prod.data.get(`fielddaylab/aqualab/${rel}`));

  test('a storage request that never answers fails the switch (and rolls it back) instead of holding the lock', async () => {
    app = newApp({ storageTimeoutMs: 30 });
    await twoReleases();
    const hold = holdCopies((dst) => dst === 'fielddaylab/aqualab/Build/game.wasm.br', false); // ignores its signal too
    const res = await promote('m3.2');
    assert.equal(res.status, 500);
    hold.restore();
    assert.equal(db.currentRelease(1)?.version, 'm3.1');
    assert.deepEqual([liveText('index.html'), liveText('Build/game.wasm.br')], ['old', 'old wasm'], 'the previous release was put back');
    const again = await promote('m3.2');
    assert.equal(again.status, 200, 'the lock was released, so the next call switches');
    assert.deepEqual([liveText('index.html'), liveText('Build/game.wasm.br')], ['new', 'new wasm']);
  });

  test('a stale lock is taken over; the abandoned switch is aborted and touches nothing after that', async () => {
    await twoReleases();
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const hold = holdCopies((dst) => dst.startsWith('fielddaylab/aqualab/') && !dst.includes('/_releases/'));
      const stuck = promote('m3.2');
      await hold.first;
      const busy = await promote('m3.2');
      assert.equal(busy.status, 409);
      assert.match(((await busy.json()) as any).error, /already switching versions \(started 0 s ago, last progress 0 s ago\)/);

      mock.timers.tick(SWITCH_STALE_MS - 1000);
      assert.equal((await promote('m3.1')).status, 409, 'not stale yet');
      mock.timers.tick(2000);
      hold.restore(); // the new owner's copies go through
      const writes: string[] = [];
      const put = prod.put.bind(prod);
      prod.put = async (key, ...rest) => { writes.push(key); return put(key, ...rest); };
      const took = await promote('m3.2');
      assert.equal(took.status, 200);
      assert.deepEqual(pick(await took.json(), ['current', 'previous']), { current: 'm3.2', previous: 'm3.1' });

      const old = await stuck;
      assert.equal(old.status, 409, 'the abandoned call answers that it was taken over');
      assert.match(((await old.json()) as any).error, /taken over/);
      assert.equal(hold.held.length, 0, 'its copy in flight was aborted, not left waiting');
      const n = writes.length;
      hold.release();
      await new Promise((r) => setImmediate(r));
      assert.equal(writes.length, n, 'and it wrote nothing more (no rollback to m3.1)');
      assert.equal(db.currentRelease(1)?.version, 'm3.2');
      assert.deepEqual([liveText('index.html'), liveText('Build/game.wasm.br')], ['new', 'new wasm']);
      assert.equal(db.setting('release_live:1'), '');
      assert.deepEqual(db.recentAudit().filter((a) => a.action === 'release.lock_takeover').map((a) => [a.actor, a.target]), [['github:dev', 'fielddaylab/aqualab/']]);
    } finally {
      mock.timers.reset();
    }
  });

  test('a switch taken over mid-way by a budgeted call (the admin task) resumes from the saved progress', async () => {
    await twoReleases();
    const publish = (budget_seconds?: number) => post('/v1/admin/releases/publish', 'releaser', { studio: 'fielddaylab', game: 'aqualab', version: 'm3.2', ref: 'm3.2', budget_seconds });
    db.setSetting('release_live:1', JSON.stringify({ version: 'm3.2', done: 1 })); // an earlier round copied Build/game.wasm.br
    await prod.copy('fielddaylab/aqualab/_releases/m3.2/Build/game.wasm.br', 'fielddaylab/aqualab/Build/game.wasm.br', { contentType: 'application/wasm', cacheControl: 'no-cache' });
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const hold = holdCopies((dst) => dst === 'fielddaylab/aqualab/index.html');
      const stuck = publish();
      await hold.first;
      mock.timers.tick(SWITCH_STALE_MS + 1);
      hold.restore();
      const copies: string[] = [];
      const copy = prod.copy.bind(prod);
      prod.copy = async (src, dst, ...rest) => { copies.push(dst); return copy(src, dst, ...rest); };
      const res = await publish();
      assert.equal(res.status, 200);
      assert.deepEqual(pick(await res.json(), ['done', 'promoted', 'current']), { done: true, promoted: true, current: 'm3.2' });
      assert.deepEqual(copies, ['fielddaylab/aqualab/index.html'], 'only what the saved progress says is left');
      assert.equal((await stuck).status, 409);
      assert.equal(db.setting('release_live:1'), '');
    } finally {
      mock.timers.reset();
    }
  });

  test('after one copy fails, a switch starts no more and waits for those in flight before putting the old release back', async () => {
    const dst = new FakeStorage();
    for (let i = 0; i < 12; i++) dst.objects.set(`s/g/_releases/v1/f${String(i).padStart(2, '0')}.js`, 1);
    let active = 0, started = 0, peakAfterFailure = 0, failed = false;
    const copy = dst.copy.bind(dst);
    dst.copy = async (src, to, h, signal) => {
      started++; active++;
      try {
        if (to.endsWith('f01.js')) { failed = true; throw new Error('simulated R2 failure'); }
        await new Promise((r) => setTimeout(r, 10));
        if (failed) peakAfterFailure = Math.max(peakAfterFailure, active);
        return await copy(src, to, h, signal);
      } finally { active--; }
    };
    await assert.rejects(makeLive(dst, 's/g/', 'v1', { concurrency: 4 }), /simulated R2 failure/);
    assert.equal(active, 0, 'nothing is still copying when makeLive rejects');
    assert.ok(started <= 4, `started ${started}: none after the failure`);
    assert.ok(peakAfterFailure <= 3);
  });

  test('a storage call that never answers times out, even if the storage ignores its signal', async () => {
    const dst = new FakeStorage();
    dst.objects.set('s/g/_releases/v1/index.html', 1);
    dst.copy = () => new Promise(() => {});
    const t0 = Date.now();
    await assert.rejects(makeLive(dst, 's/g/', 'v1', { callTimeoutMs: 20 }), (err) => err instanceof StorageTimeoutError && /did not answer copy/.test(err.message));
    assert.ok(Date.now() - t0 < 1000);
    const src = new FakeStorage();
    src.objects.set('a/index.html', 1);
    src.get = () => new Promise(() => {});
    await assert.rejects(copyRelease({ staging: src, production: dst, srcPrefix: 'a/', dstPrefix: 'b/', callTimeoutMs: 20 }), StorageTimeoutError);
  });

  test('make current and rollback leave STUDIO/GAME/_vault-assets/ (uploaded listing images) untouched', async () => {
    await publishTag('m3.1');
    await approve('m3.1');
    await publishTag('m3.2');
    await approve('m3.2');
    const h = { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' };
    const assets = ['fielddaylab/aqualab/_vault-assets/hero-0123456789abcdef.png', 'fielddaylab/aqualab/_vault-assets/screenshot-fedcba9876543210.webp'];
    for (const k of assets) await prod.put(k, new TextEncoder().encode(k), k.length, h);
    const assetState = () => assets.map((k) => [prod.objects.has(k), new TextDecoder().decode(prod.data.get(k)), prod.headers.get(k)?.cacheControl]);
    const before = assetState();
    assert.equal((await promote('m3.2')).status, 200);   // make current
    assert.deepEqual(assetState(), before);
    assert.equal((await promote('m3.1')).status, 200);   // rollback
    assert.deepEqual(assetState(), before);
    assert.equal((await promote('m3.2')).status, 200);
    assert.deepEqual(assetState(), before);
  });

  test('a build with its own top-level _vault-assets/ folder can’t be released', async () => {
    identities.tag = { ...wake, ref: 'refs/tags/m4' };
    const { json } = await start('tag', { game: 'aqualab', files: [...files, { path: '_vault-assets/logo.png', size: 3 }] });
    uploadAll(json, { 'index.html': 10, 'Build/game.wasm.br': 20, '_vault-assets/logo.png': 3 });
    assert.equal((await post(`/v1/previews/${json.upload_id}/finalize`, 'tag')).status, 200);
    const res = await approve('m4', 'releaser', { ref: 'm4' });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error, /_vault-assets\/logo\.png/);
    assert.equal([...prod.objects.keys()].length, 0, 'nothing was copied');
    assert.equal(db.release(1, 'm4'), undefined);
  });

  test('makeLive also refuses a release that contains _vault-assets/', async () => {
    const { makeLive } = await import('../src/releases.ts');
    const h = { contentType: 'text/html', cacheControl: 'x' };
    await prod.put('s/g/_releases/v1/index.html', new Uint8Array(1), 1, h);
    await prod.put('s/g/_releases/v1/_vault-assets/x.png', new Uint8Array(1), 1, h);
    await assert.rejects(makeLive(prod, 's/g/', 'v1'), /_vault-assets\/x\.png/);
    assert.ok(!prod.objects.has('s/g/index.html'));
  });

  test('promoting an unapproved version or a bad version name is refused', async () => {
    assert.equal((await promote('m9')).status, 404);
    assert.equal((await approve('../evil')).status, 400);
    assert.equal((await approve('index.html')).status, 400);
  });
});

describe('one-time release relayout', () => {
  test('moves VERSION/ folders under _releases/ and serves the current release in place', async () => {
    const { relayoutReleases } = await import('../src/releases.ts');
    const h = { contentType: 'text/html', cacheControl: 'x' };
    for (const v of ['0.1.0', '0.2.0']) {
      await prod.put(`fieldday/spacefab/${v}/index.html`, new TextEncoder().encode(v), 5, h);
      await prod.put(`fieldday/spacefab/${v}/Build/a.wasm.br`, new Uint8Array(9), 9, h);
    }
    await prod.put('fieldday/spacefab/index.html', new TextEncoder().encode('redirect'), 8, h);
    await prod.put('fieldday/spacefab/current.json', new TextEncoder().encode('{}'), 2, h);
    const rel = [{ gamePrefix: 'fieldday/spacefab/', version: '0.1.0', current: false }, { gamePrefix: 'fieldday/spacefab/', version: '0.2.0', current: true }];
    await relayoutReleases(prod, rel, () => {});
    assert.deepEqual([...prod.objects.keys()].sort(), [
      'fieldday/spacefab/Build/a.wasm.br', 'fieldday/spacefab/_releases/0.1.0/Build/a.wasm.br', 'fieldday/spacefab/_releases/0.1.0/index.html',
      'fieldday/spacefab/_releases/0.2.0/Build/a.wasm.br', 'fieldday/spacefab/_releases/0.2.0/index.html', 'fieldday/spacefab/current.json', 'fieldday/spacefab/index.html']);
    assert.equal(new TextDecoder().decode(prod.data.get('fieldday/spacefab/index.html')), '0.2.0');
    assert.equal(prod.headers.get('fieldday/spacefab/_releases/0.1.0/index.html')?.cacheControl, 'public, max-age=31536000, immutable');
    await relayoutReleases(prod, rel, () => {}); // safe to run again
    assert.equal(prod.objects.size, 7);
  });
});

describe('release check (shown to reviewers before approval)', () => {
  const check = async (q: string) => (await (await app.request(`/v1/releases/fielddaylab/aqualab/check?${q}`)).json()) as any;
  async function publishTag(tag: string) {
    identities.tag = { ...wake, ref: `refs/tags/${tag}` };
    const { json } = await start('tag');
    uploadAll(json);
    await post(`/v1/previews/${json.upload_id}/finalize`, 'tag');
  }

  test('describes a releasable tag', async () => {
    await publishTag('m3.2');
    const r = await check('version=m3.2');
    assert.equal(r.ok, true);
    assert.equal(r.staging.url, 'https://cdn.example-staging.org/fielddaylab/aqualab/m3.2/');
    assert.equal(r.staging.commit_sha, 'abc123');
    assert.equal(r.staging.files, 2);
    assert.deepEqual(r.warnings, []);
  });

  test('stops the run before approval on problems, and warns about branches', async () => {
    const { json } = await start();                                            // a branch build
    uploadAll(json);
    await post(`/v1/previews/${json.upload_id}/finalize`, 'wake');
    assert.equal((await check('version=m9')).ok, false);                       // nothing on staging
    assert.equal((await check('action=promote&version=m9')).ok, false);       // never approved
    const r = await check('version=legacy-1&ref=feature/new-map');
    assert.equal(r.ok, true);
    assert.match(r.warnings[0], /is a branch/);
  });

  test('refuses to approve a version twice', async () => {
    await publishTag('m3.2');
    await post('/v1/admin/releases/approve', 'releaser', { studio: 'fielddaylab', game: 'aqualab', version: 'm3.2' });
    const r = await check('version=m3.2');
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /already approved/);
  });
});

describe('studios', () => {
  test('changing a studio slug renames it in place and keeps its games', async () => {
    const { json } = await start();
    uploadAll(json);
    await post(`/v1/previews/${json.upload_id}/finalize`, 'wake');
    db.syncStudios([{ slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' }]);
    assert.equal(db.studioBySlug('fielddaylab'), undefined);
    assert.equal(db.game(db.studioBySlug('fieldday')!.id, 'aqualab')?.repository, 'fielddaylab/wake');
    const again = await start();
    assert.equal(again.json.url, 'https://cdn.example-staging.org/fieldday/aqualab/feature_new-map/');
  });

  test('Vault-managed studios (no GitHub org) can never be matched by a GitHub token', async () => {
    db.syncStudios([{ slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' }]);
    assert.equal(db.studioBySlug('ucalgary')?.github_owner_id, 'vault:ucalgary');
    assert.equal(db.studioByOwnerId('999'), undefined);
  });
});
