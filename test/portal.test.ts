import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { createApp } from '../src/app.ts';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { signSession } from '../src/portal/session.ts';
import type { Storage } from '../src/storage.ts';

class FakeStorage implements Storage {
  objects = new Map<string, number>();
  data = new Map<string, Uint8Array>();
  async presignPut(key: string) { return `https://r2.test/${key}`; }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })); }
  async deleteKeys(keys: string[]) { for (const k of keys) this.objects.delete(k); }
  async get(key: string) { return this.data.get(key) ?? new Uint8Array(this.objects.get(key)!); }
  async put(key: string, body: Readable | Uint8Array, size: number, _h: ObjectHeaders) {
    this.objects.set(key, size);
    this.data.set(key, body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await (body as Readable).toArray())));
  }
}

const SECRET = 'test-session-secret';
const wake: GitHubIdentity = { owner: 'fielddaylab', ownerId: '1881825', repository: 'fielddaylab/wake', repositoryId: '100', ref: 'refs/tags/v1.0', sha: 'abc1234', actor: 'dev', eventName: 'push' };
const identities: Record<string, GitHubIdentity> = { wake };
const verifier: Verifier = { async github(t) { if (!identities[t]) throw new Error('bad'); return identities[t]; }, async google() { throw new Error('no'); } };

let db: Db, staging: FakeStorage, prod: FakeStorage, app: ReturnType<typeof createApp>;
beforeEach(async () => {
  db = new Db(':memory:');
  db.syncStudios([{ slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
    { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' }]);
  staging = new FakeStorage(); prod = new FakeStorage();
  app = createApp({
    db, staging, production: prod, verifier,
    stagingPublicUrl: 'https://stg.test', prodPublicUrl: 'https://prod.test',
    adminRepository: 'fielddaylab/vault-publisher', adminEnvironment: 'production',
    previewRetentionDays: 90, taskInvokerEmail: 'x@y',
    portal: {
      baseUrl: 'https://portal.test', sessionSecret: SECRET, vaultAdmins: ['boss'],
      oauth: {
        authorizeUrl: (state, redirect) => `https://github.test/authorize?state=${state}&redirect_uri=${redirect}`,
        exchange: async (code) => ({ github_id: `id-${code}`, login: code, name: code.toUpperCase(), avatar_url: null }),
      },
    },
  });
  // Publish tag v1.0 of aqualab to staging through the normal CI path.
  for (const tag of ['v1.0', 'v1.1']) {
    identities.wake = { ...wake, ref: `refs/tags/${tag}` };
    const start = await app.request('/v1/previews', { method: 'POST', headers: { Authorization: 'Bearer wake', 'Content-Type': 'application/json' }, body: JSON.stringify({ game: 'aqualab', files: [{ path: 'index.html', size: 5 }] }) });
    const j = (await start.json()) as any;
    staging.objects.set(`fieldday/aqualab/${tag}/index.html`, 5);
    await app.request(`/v1/previews/${j.upload_id}/finalize`, { method: 'POST', headers: { Authorization: 'Bearer wake' } });
  }
});

function as(login: string, vaultRole: 'none' | 'release_manager' | 'admin' = 'none', studioRole?: 'viewer' | 'maintainer' | 'admin') {
  const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
  db.setVaultRole(u.id, vaultRole);
  if (studioRole) db.setMembership(db.studioBySlug('fieldday')!.id, login, studioRole, 'test');
  const cookie = `vault_session=${signSession(u.id, SECRET)}`;
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, body: unknown = {}, extra: Record<string, string> = { 'X-Requested-With': 'vault-portal' }) =>
      app.request(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) }),
  };
}
const G = '/portal/api/s/fieldday/g/aqualab';

describe('sign-in', () => {
  test('pages redirect to sign-in when signed out', async () => {
    const r = await app.request('/s/fieldday');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login?next=%2Fs%2Ffieldday');
  });

  test('GitHub sign-in sets a session and bootstraps Vault admins', async () => {
    const start = await app.request('/auth/github?next=/vault');
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const cb = await app.request(`/auth/callback?code=boss&state=${state}`, { headers: { Cookie: cookie } });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), '/vault');
    assert.match(cb.headers.get('set-cookie')!, /vault_session=.*HttpOnly.*Secure/i);
    const boss = db.users().find((u) => u.login === 'boss')!;
    assert.equal(boss.vault_role, 'admin');
  });

  test('a wrong OAuth state is refused', async () => {
    const r = await app.request('/auth/callback?code=boss&state=nope', { headers: { Cookie: 'vault_oauth=real|/' } });
    assert.match(r.headers.get('location')!, /^\/login\?error=/);
    assert.equal(db.users().length, 0);
  });

  test('a tampered session cookie is ignored', async () => {
    const r = await app.request('/s/fieldday', { headers: { Cookie: 'vault_session=eyJ1aWQiOjF9.forged' } });
    assert.equal(r.status, 302);
  });
});

describe('seeing studios and games', () => {
  test('members see their studio’s staging versions; non-members get nothing', async () => {
    const viewer = as('vera', 'none', 'viewer');
    const page = await (await viewer.get('/s/fieldday/g/aqualab')).text();
    assert.match(page, /v1\.0/);
    assert.match(page, /https:\/\/stg\.test\/fieldday\/aqualab\/v1\.0\//);
    assert.doesNotMatch(page, /Release…|Request release…/); // viewers can't act
    const stranger = as('sam');
    assert.equal((await stranger.get('/s/fieldday/g/aqualab')).status, 404);
    assert.equal((await stranger.get('/s/ucalgary')).status, 404);
  });

  test('maintainers see Request release; release managers see Release', async () => {
    assert.match(await (await as('mia', 'none', 'maintainer').get('/s/fieldday/g/aqualab')).text(), /Request release…/);
    assert.match(await (await as('rita', 'release_manager').get('/s/fieldday/g/aqualab')).text(), /Release…/);
  });

  test('every page renders for Vault staff', async () => {
    const boss = as('boss', 'admin');
    for (const p of ['/', '/s/fieldday', '/s/fieldday/g/aqualab', '/s/fieldday/register', '/s/fieldday/members', '/vault', '/vault/people', '/vault/activity']) {
      const r = await boss.get(p);
      assert.equal(r.status, 200, p);
    }
    assert.equal((await as('vera', 'none', 'viewer').get('/vault')).status, 403);
  });
});

describe('releasing from the web', () => {
  test('a maintainer requests, a release manager approves and it goes live', async () => {
    const mia = as('mia', 'none', 'maintainer');
    let r = await mia.post(`${G}/request`, { ref: 'v1.0', version: 'v1.0', notes: 'first release' });
    assert.equal(r.status, 200);
    const id = ((await r.json()) as any).id;
    assert.equal((await mia.post(`/portal/api/requests/${id}/approve`, { makeCurrent: true })).status, 403); // can't approve own studio's
    const rita = as('rita', 'release_manager');
    r = await rita.post(`/portal/api/requests/${id}/approve`, { makeCurrent: true });
    assert.equal(r.status, 200);
    assert.equal(db.releaseRequest(id)?.status, 'approved');
    assert.ok(prod.objects.has('fieldday/aqualab/v1.0/index.html'));
    assert.match(new TextDecoder().decode(prod.data.get('fieldday/aqualab/index.html')), /\.\/v1\.0\//);
    assert.equal(db.releases(db.game(1, 'aqualab')!.id)[0].approved_by, 'user:rita');
  });

  test('release managers release directly, promote and roll back', async () => {
    const rita = as('rita', 'release_manager');
    assert.equal((await rita.post(`${G}/release`, { ref: 'v1.0', version: 'v1.0', makeCurrent: true })).status, 200);
    assert.equal((await rita.post(`${G}/release`, { ref: 'v1.1', version: 'v1.1', makeCurrent: true })).status, 200);
    assert.equal((await rita.post(`${G}/release`, { ref: 'v1.1', version: 'v1.1' })).status, 409); // never twice
    const back = await rita.post(`${G}/promote`, { version: 'v1.0' });
    // An open request for a version that gets released another way is closed as approved.
    const mia = as('mia', 'none', 'maintainer');
    const req = ((await (await mia.post(`${G}/request`, { ref: 'v1.1', version: 'v2' })).json()) as any).id;
    await rita.post(`${G}/release`, { ref: 'v1.1', version: 'v2' });
    assert.equal(db.releaseRequest(req)?.status, 'approved');
    assert.equal(((await back.json()) as any).rollback, true);
  });

  test('studio members can’t release, and requests need the portal header', async () => {
    const mia = as('mia', 'none', 'admin');
    assert.equal((await mia.post(`${G}/release`, { ref: 'v1.0', version: 'v1.0' })).status, 403);
    assert.equal((await mia.post(`${G}/promote`, { version: 'v1.0' })).status, 403);
    assert.equal((await as('vera', 'none', 'viewer').post(`${G}/request`, { ref: 'v1.0', version: 'v1.0' })).status, 403);
    assert.equal((await as('rita', 'release_manager').post(`${G}/release`, { ref: 'v1.0', version: 'v1.0' }, {})).status, 403);
  });

  test('bad requests explain themselves', async () => {
    const mia = as('mia', 'none', 'maintainer');
    const bad = await mia.post(`${G}/request`, { ref: 'nope', version: 'v9' });
    assert.equal(bad.status, 404);
    assert.match(((await bad.json()) as any).error, /isn’t on staging/);
    assert.equal((await mia.post(`${G}/request`, { ref: 'v1.0', version: '../x' })).status, 400);
  });

  test('send back and withdraw', async () => {
    const mia = as('mia', 'none', 'maintainer');
    const id1 = ((await (await mia.post(`${G}/request`, { ref: 'v1.0', version: 'v1.0' })).json()) as any).id;
    const id2 = ((await (await mia.post(`${G}/request`, { ref: 'v1.1', version: 'v1.1' })).json()) as any).id;
    const rita = as('rita', 'release_manager');
    assert.equal((await rita.post(`/portal/api/requests/${id1}/reject`, {})).status, 400);
    assert.equal((await rita.post(`/portal/api/requests/${id1}/reject`, { note: 'crashes on iPad' })).status, 200);
    assert.equal(db.releaseRequest(id1)?.status, 'rejected');
    assert.equal((await mia.post(`/portal/api/requests/${id2}/withdraw`)).status, 200);
    assert.equal((await rita.post(`/portal/api/requests/${id2}/approve`, {})).status, 409);
  });
});

describe('user management', () => {
  test('studio admins manage members; others can’t', async () => {
    const ada = as('ada', 'none', 'admin');
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'newbie', role: 'maintainer' })).status, 200);
    assert.equal(db.roleIn(db.studioBySlug('fieldday')!.id, 'NEWBIE'), 'maintainer'); // case-insensitive
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'bad user!', role: 'viewer' })).status, 400);
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ada', role: 'viewer' })).status, 400); // no self-demotion
    assert.equal((await as('mia', 'none', 'maintainer').post('/portal/api/s/fieldday/members', { login: 'x', role: 'admin' })).status, 403);
    assert.equal((await ada.post('/portal/api/s/fieldday/members/remove', { login: 'newbie' })).status, 200);
    assert.equal(db.roleIn(db.studioBySlug('fieldday')!.id, 'newbie'), undefined);
  });

  test('Vault admins set Vault roles, but not their own', async () => {
    const boss = as('boss', 'admin');
    const rita = db.upsertUser({ github_id: 'id-rita', login: 'rita', name: null, avatar_url: null });
    assert.equal((await boss.post(`/portal/api/vault/users/${rita.id}/role`, { role: 'release_manager' })).status, 200);
    assert.equal(db.userById(rita.id)?.vault_role, 'release_manager');
    const me = db.users().find((u) => u.login === 'boss')!;
    assert.equal((await boss.post(`/portal/api/vault/users/${me.id}/role`, { role: 'none' })).status, 400);
    assert.equal((await as('rita', 'release_manager').post(`/portal/api/vault/users/${me.id}/role`, { role: 'none' })).status, 403);
  });
});
