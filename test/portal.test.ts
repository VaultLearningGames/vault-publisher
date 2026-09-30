import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { createApp } from '../src/app.ts';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { Db, studioWebsite } from '../src/db.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { signSession } from '../src/portal/session.ts';
import { browseKeys, type Storage } from '../src/storage.ts';

class FakeStorage implements Storage {
  objects = new Map<string, number>();
  data = new Map<string, Uint8Array>();
  async presignPut(key: string) { return `https://r2.test/${key}`; }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })); }
  async browse(prefix: string) { return browseKeys(this.objects, prefix); }
  async copy(src: string, dst: string, headers: ObjectHeaders) {
    if (!this.objects.has(src)) throw new Error(`no such key ${src}`);
    await this.put(dst, this.data.get(src) ?? new Uint8Array(this.objects.get(src)!), this.objects.get(src)!, headers);
  }
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
    adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
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
    assert.ok(prod.objects.has('fieldday/aqualab/_releases/v1.0/index.html'));
    assert.match(new TextDecoder().decode(prod.data.get('fieldday/aqualab/current.json')), /"version":"v1\.0"/);
    assert.ok(prod.objects.has('fieldday/aqualab/index.html')); // served in place
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
    assert.equal((await as('vera', 'none', 'viewer').post(`${G}/promote`, { version: 'v1.0' })).status, 403);
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

describe('file browser', () => {
  test('members browse their studio’s staging and production folders', async () => {
    staging.objects.set('fieldday/aqualab/v1.0/Build/game.wasm.br', 2_000_000);
    staging.objects.set('ucalgary/tq/develop/index.html', 5);
    const mia = as('mia', 'none', 'viewer');
    const root = await (await mia.get('/s/fieldday/files')).text();
    assert.match(root, /aqualab\//);
    assert.doesNotMatch(root, /ucalgary|tq\//);
    const build = await (await mia.get('/s/fieldday/files?path=aqualab/v1.0/')).text();
    assert.match(build, /Build\//);
    assert.match(build, /index\.html/);
    assert.match(build, /https:\/\/stg\.test\/fieldday\/aqualab\/v1\.0\/index\.html/);
    const wasm = await (await mia.get('/s/fieldday/files?path=aqualab/v1.0/Build/')).text();
    assert.match(wasm, /application\/wasm · br/);
    assert.match(wasm, /1\.9 MB/);
    const prodPage = await (await mia.get('/s/fieldday/files?env=production')).text();
    assert.match(prodPage, /Nothing released to production yet/);
  });

  test('other studios and odd paths are refused', async () => {
    const mia = as('mia', 'none', 'viewer');
    assert.equal((await mia.get('/s/ucalgary/files')).status, 404);
    assert.equal((await mia.get('/s/fieldday/files?path=../ucalgary/')).status, 404);
    assert.equal((await mia.get('/s/fieldday/files?path=aqualab//')).status, 404);
    const out = await app.request('/s/fieldday/files?path=aqualab/');
    assert.equal(out.headers.get('location'), '/login?next=%2Fs%2Ffieldday%2Ffiles%3Fpath%3Daqualab%2F');
  });
});

describe('studios switching approved releases', () => {
  async function twoReleases() {
    const rita = as('rita', 'release_manager');
    await rita.post(`${G}/release`, { ref: 'v1.0', version: 'v1.0', makeCurrent: true });
    await rita.post(`${G}/release`, { ref: 'v1.1', version: 'v1.1', makeCurrent: true });
    return rita;
  }
  const current = () => db.currentRelease(db.game(db.studioBySlug('fieldday')!.id, 'aqualab')!.id)?.version;

  test('maintainers roll back and forward; viewers can’t', async () => {
    await twoReleases();
    const mia = as('mia', 'none', 'maintainer');
    const back = await mia.post(`${G}/promote`, { version: 'v1.0' });
    assert.equal(back.status, 200);
    assert.equal(((await back.json()) as any).rollback, true);
    assert.equal(current(), 'v1.0');
    assert.equal((await as('vera', 'none', 'viewer').post(`${G}/promote`, { version: 'v1.1' })).status, 403);
    assert.equal((await mia.post(`${G}/promote`, { version: 'v9' })).status, 404); // only approved versions
    assert.match(await (await as('boss', 'admin').get('/vault')).text(), /Rolled back[\s\S]*v1\.1 → v1\.0[\s\S]*mia/);
    assert.match(await (await mia.get('/s/fieldday/g/aqualab')).text(), /Make current/);
    assert.doesNotMatch(await (await mia.get('/s/fieldday/g/aqualab')).text(), /Withdraw…|>Freeze</);
  });

  test('Vault withdraws a release so nobody can make it current', async () => {
    const rita = await twoReleases();
    assert.equal((await rita.post(`${G}/withdraw`, { ref: 'v1.1', note: 'x' })).status, 409); // current
    assert.equal((await rita.post(`${G}/withdraw`, { ref: 'v1.0' })).status, 400);            // needs a reason
    const mia = as('mia', 'none', 'admin');
    assert.equal((await mia.post(`${G}/withdraw`, { ref: 'v1.0', note: 'x' })).status, 403);
    assert.equal((await rita.post(`${G}/withdraw`, { ref: 'v1.0', note: 'logs names' })).status, 200);
    const refused = await mia.post(`${G}/promote`, { version: 'v1.0' });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as any).error, /withdrawn by Vault: logs names/);
    assert.equal((await rita.post(`${G}/promote`, { version: 'v1.0' })).status, 409); // Vault too, until restored
    assert.match(await (await mia.get('/s/fieldday/g/aqualab')).text(), /Withdrawn[\s\S]*logs names/);
    assert.equal((await rita.post(`${G}/withdraw`, { ref: 'v1.0', restore: '1' })).status, 200);
    assert.equal((await mia.post(`${G}/promote`, { version: 'v1.0' })).status, 200);
  });

  test('a frozen game can only be switched by Vault', async () => {
    const rita = await twoReleases();
    assert.equal((await rita.post(`${G}/freeze`, { frozen: '1' })).status, 400);
    assert.equal((await rita.post(`${G}/freeze`, { frozen: '1', note: 'study until Dec 15' })).status, 200);
    const mia = as('mia', 'none', 'maintainer');
    const refused = await mia.post(`${G}/promote`, { version: 'v1.0' });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as any).error, /frozen aqualab \(study until Dec 15\)/);
    assert.match(await (await mia.get('/s/fieldday/g/aqualab')).text(), /Frozen[\s\S]*study until Dec 15/);
    assert.equal((await mia.post(`${G}/freeze`, { frozen: '' })).status, 403);
    assert.equal((await rita.post(`${G}/promote`, { version: 'v1.0' })).status, 200);
    assert.equal((await rita.post(`${G}/freeze`, { frozen: '' })).status, 200);
    assert.equal((await mia.post(`${G}/promote`, { version: 'v1.1' })).status, 200);
  });
});

describe('deleting a game', () => {
  test('studio admins and Vault staff delete it after typing its name; files and records go, listings stay', async () => {
    const boss = as('boss', 'admin');
    await boss.post(`${G}/release`, { ref: 'v1.0', version: 'v1.0', makeCurrent: true });
    prod.objects.set('fieldday/aqualab-two/index.html', 1);   // a neighbour whose name starts the same survives
    const page = await (await as('ada', 'none', 'admin').get('/s/fieldday/g/aqualab?tab=cdn')).text();
    assert.match(page, /Danger zone[\s\S]*Type <b class="mono">aqualab<\/b> to confirm/);
    assert.doesNotMatch(await (await as('mia', 'none', 'maintainer').get('/s/fieldday/g/aqualab?tab=cdn')).text(), /Danger zone/);
    for (const who of [as('mia', 'none', 'maintainer'), as('vera', 'none', 'viewer')]) assert.equal((await who.post(`${G}/delete`, { confirm: 'aqualab' })).status, 403);
    const ada = as('ada', 'none', 'admin');
    assert.equal((await ada.post(`${G}/delete`, { confirm: 'aqua' })).status, 400, 'must type the name');
    assert.ok(db.game(db.studioBySlug('fieldday')!.id, 'aqualab'));
    assert.equal((await ada.post(`${G}/delete`, { confirm: 'aqualab' })).status, 200);
    assert.equal(db.game(db.studioBySlug('fieldday')!.id, 'aqualab'), undefined);
    assert.equal([...staging.objects.keys()].filter((k) => k.startsWith('fieldday/aqualab/')).length, 0);
    assert.deepEqual([...prod.objects.keys()], ['fieldday/aqualab-two/index.html']);
    assert.equal((await ada.get('/s/fieldday/g/aqualab')).status, 404);
    assert.ok(db.recentAudit(5).some((a) => a.action === 'game.delete' && a.target === 'fieldday/aqualab/'));
  });

  test('Vault release managers can delete too', async () => {
    assert.equal((await as('rita', 'release_manager').post(`${G}/delete`, { confirm: 'aqualab' })).status, 200);
    assert.equal(db.game(db.studioBySlug('fieldday')!.id, 'aqualab'), undefined);
  });
});

describe('user management', () => {
  test('studio admins manage members; others can’t', async () => {
    const ada = as('ada', 'none', 'admin');
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'newbie', role: 'maintainer' })).status, 200);
    assert.equal(db.roleIn(db.studioBySlug('fieldday')!.id, 'NEWBIE'), 'maintainer'); // case-insensitive
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'bad user!', role: 'viewer' })).status, 400);
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ada', role: 'viewer' })).status, 409); // the only studio admin
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

describe('studio website', () => {
  const W = '/portal/api/s/fieldday/website';
  const website = () => db.studioBySlug('fieldday')!.website;

  test('only absolute http(s) addresses are accepted, trimmed; empty clears', () => {
    assert.equal(studioWebsite('  https://fielddaylab.wisc.edu/  '), 'https://fielddaylab.wisc.edu/');
    assert.equal(studioWebsite('http://example.org/studio?a=1'), 'http://example.org/studio?a=1');
    assert.equal(studioWebsite(''), null);
    assert.equal(studioWebsite('   '), null);
    assert.equal(studioWebsite(undefined), null);
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.org/', 'example.org', '/about', 'https://', 'https://exa mple.org/', 'https://user:pw@example.org/', `https://example.org/${'a'.repeat(300)}`]) {
      assert.throws(() => studioWebsite(bad), bad);
    }
  });

  test('a new database has no website until one is set', () => {
    assert.equal(website(), null);
    const cols = db.sqlite.prepare('PRAGMA table_info(studios)').all() as { name: string; notnull: number }[];
    assert.equal(cols.find((c) => c.name === 'website')?.notnull, 0);
  });

  test('studio admins and Vault admins set it; maintainers, viewers and release managers can’t', async () => {
    assert.equal((await as('mia', 'none', 'maintainer').post(W, { website: 'https://x.test/' })).status, 403);
    assert.equal((await as('vera', 'none', 'viewer').post(W, { website: 'https://x.test/' })).status, 403);
    assert.equal((await as('rm', 'release_manager').post(W, { website: 'https://x.test/' })).status, 403);
    assert.equal((await as('sam').post(W, { website: 'https://x.test/' })).status, 403);
    assert.equal(website(), null);
    const ada = as('ada', 'none', 'admin');
    assert.equal((await ada.post(W, { website: 'javascript:alert(1)' })).status, 400);
    assert.equal((await ada.post(W, { website: ' https://fielddaylab.wisc.edu/ ' })).status, 200);
    assert.equal(website(), 'https://fielddaylab.wisc.edu/');
    assert.equal((await as('boss', 'admin').post(W, { website: 'https://fielddaylab.org/' })).status, 200);
    assert.equal(website(), 'https://fielddaylab.org/');
    const log = db.auditFor(['studio.website'], 5);
    assert.equal(log.length, 2);
    assert.deepEqual(JSON.parse(log[0].detail_json!), { from: 'https://fielddaylab.wisc.edu/', to: 'https://fielddaylab.org/' });
    assert.equal((await ada.post(W, { website: '' })).status, 200);
    assert.equal(website(), '', 'cleared');
  });

  test('the Members page shows it; only those who can change it get the form', async () => {
    db.setStudioWebsite(db.studioBySlug('fieldday')!.id, 'https://fielddaylab.wisc.edu/');
    const viewerPage = await (await as('vera', 'none', 'viewer').get('/s/fieldday/members')).text();
    assert.match(viewerPage, /href="https:\/\/fielddaylab\.wisc\.edu\/"/);
    assert.doesNotMatch(viewerPage, /data-api="\/portal\/api\/s\/fieldday\/website"/);
    assert.match(await (await as('ada', 'none', 'admin').get('/s/fieldday/members')).text(), /data-api="\/portal\/api\/s\/fieldday\/website"/);
    assert.match(await (await as('boss', 'admin').get('/s/fieldday/members')).text(), /data-api="\/portal\/api\/s\/fieldday\/website"/);
  });

  test('studio-websites.json fills in websites never set, and never overrides the portal', async () => {
    const r = db.seedStudioWebsites({ fieldday: 'https://fielddaylab.wisc.edu/', ucalgary: 'javascript:x', nosuch: 'https://x.test/' });
    assert.deepEqual(r, { set: ['fieldday'], invalid: ['ucalgary'] });
    assert.equal(website(), 'https://fielddaylab.wisc.edu/');
    await as('ada', 'none', 'admin').post(W, { website: 'https://portal-edit.test/' });
    db.seedStudioWebsites({ fieldday: 'https://fielddaylab.wisc.edu/' });
    assert.equal(website(), 'https://portal-edit.test/', 'a portal edit wins');
    await as('ada', 'none', 'admin').post(W, { website: '' });
    db.seedStudioWebsites({ fieldday: 'https://fielddaylab.wisc.edu/' });
    assert.equal(website(), '', 'clearing it in the portal also wins');
    assert.equal(db.studioBySlug('ucalgary')!.website, null);
  });
});

describe('portal address', () => {
  test('browsers on the default run.app address go to the portal address; the API still answers there', async () => {
    const page = await app.request('https://vault-publisher-abc-uc.a.run.app/s/fieldday?x=1', { headers: { host: 'vault-publisher-abc-uc.a.run.app' } });
    assert.equal(page.status, 301);
    assert.equal(page.headers.get('location'), 'https://portal.test/s/fieldday?x=1');
    const api = await app.request('https://vault-publisher-abc-uc.a.run.app/v1/releases/fieldday/aqualab', { headers: { host: 'vault-publisher-abc-uc.a.run.app' } });
    assert.equal(api.status, 200);
    assert.equal((await app.request('/health', { headers: { host: 'vault-publisher-abc-uc.a.run.app' } })).status, 200);
  });
});
