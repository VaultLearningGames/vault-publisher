import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import type { Storage } from '../src/storage.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import type { Readable } from 'node:stream';

class FakeStorage implements Storage {
  objects = new Map<string, number>();
  data = new Map<string, Uint8Array>();
  headers = new Map<string, ObjectHeaders>();
  failPutAfter = Infinity;
  async get(key: string) {
    if (!this.objects.has(key)) throw new Error(`no such key ${key}`);
    return this.data.get(key) ?? new Uint8Array(this.objects.get(key)!);
  }
  async put(key: string, body: Readable | Uint8Array, size: number, headers: ObjectHeaders) {
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
const releaser: GitHubIdentity = { ...wake, repository: 'fielddaylab/vault-publisher', repositoryId: '900', ref: 'refs/heads/main', eventName: 'workflow_dispatch', environment: 'production' };
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
  storage = new FakeStorage();
  prod = new FakeStorage();
  app = createApp({
    db,
    staging: storage,
    production: prod,
    verifier,
    stagingPublicUrl: 'https://cdn.example-staging.org',
    prodPublicUrl: 'https://cdn.example.org',
    adminRepository: 'fielddaylab/vault-publisher',
    adminEnvironment: 'production',
    previewRetentionDays: 90,
    taskInvokerEmail: 'scheduler@example.iam.gserviceaccount.com',
  });
});

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
    assert.equal(((await res.json()) as any).url, 'https://cdn.example.org/fielddaylab/aqualab/m3.2/');
    assert.deepEqual([...prod.objects.keys()].sort(), ['fielddaylab/aqualab/m3.2/Build/game.wasm.br', 'fielddaylab/aqualab/m3.2/index.html']);
    const wasm = prod.headers.get('fielddaylab/aqualab/m3.2/Build/game.wasm.br')!;
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

  test('promote points STUDIO/GAME/ at a release; promoting an older one is a rollback', async () => {
    await publishTag('m3.1');
    await approve('m3.1');
    await publishTag('m3.2');
    await approve('m3.2');
    let res = await promote('m3.2');
    assert.deepEqual(await res.json(), { current: 'm3.2', previous: null, rollback: false, url: 'https://cdn.example.org/fielddaylab/aqualab/' });
    const html = new TextDecoder().decode(prod.data.get('fielddaylab/aqualab/index.html'));
    assert.match(html, /location\.replace\("\.\/m3\.2\/" \+ location\.search/);
    assert.equal(prod.headers.get('fielddaylab/aqualab/index.html')?.cacheControl, 'no-cache');
    res = await promote('m3.1');
    assert.equal(((await res.json()) as any).rollback, true);
    assert.match(new TextDecoder().decode(prod.data.get('fielddaylab/aqualab/current.json')), /"version":"m3.1"/);
    const list = (await (await app.request('/v1/releases/fielddaylab/aqualab')).json()) as any;
    assert.equal(list.current, 'm3.1');
    assert.deepEqual(list.releases.map((r: any) => r.version), ['m3.2', 'm3.1']);
  });

  test('promoting an unapproved version or a bad version name is refused', async () => {
    assert.equal((await promote('m9')).status, 404);
    assert.equal((await approve('../evil')).status, 400);
    assert.equal((await approve('index.html')).status, 400);
  });
});
