// Studios and people: who can add studios and studio members, invitations, and studios.json vs. portal studios.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { Db, type StudioRole } from '../src/db.ts';
import { signSession } from '../src/portal/session.ts';
import { importListings } from '../src/listings-import.ts';
import type { Storage } from '../src/storage.ts';

const SECRET = 'test-session-secret';
const noStorage = {} as Storage;
const GITHUB: Record<string, { id: string; login: string }> = { learninggameslab: { id: '5550001', login: 'LearningGamesLab' }, fielddaylab: { id: '1881825', login: 'fielddaylab' } };
let githubDown = false;
const FILE = [
  { slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
  { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' },
];

let db: Db, app: ReturnType<typeof createApp>;
beforeEach(() => {
  githubDown = false;
  db = new Db(':memory:');
  db.syncStudios(FILE);
  app = createApp({
    db, staging: noStorage, production: null,
    verifier: { async github() { throw new Error('no'); }, async google() { throw new Error('no'); } },
    stagingPublicUrl: 'https://stg.test', prodPublicUrl: 'https://prod.test',
    adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
    previewRetentionDays: 90, taskInvokerEmail: 'x@y',
    portal: {
      baseUrl: 'https://portal.test', sessionSecret: SECRET, vaultAdmins: ['boss'],
      oauth: {
        authorizeUrl: (state, redirect) => `https://github.test/authorize?state=${state}&redirect_uri=${redirect}`,
        exchange: async (code) => ({ github_id: `id-${code.toLowerCase()}`, login: code, name: null, avatar_url: null }),
      },
      githubAccount: async (login) => {
        if (githubDown) throw new Error('HTTP 500');
        return GITHUB[login.toLowerCase()] ?? null;
      },
    },
  });
});

const fd = () => db.studioBySlug('fieldday')!;
function as(login: string, vaultRole: 'none' | 'release_manager' | 'admin' = 'none', roles: Record<string, StudioRole> = {}) {
  const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
  db.setVaultRole(u.id, vaultRole);
  for (const [slug, role] of Object.entries(roles)) db.setMembership(db.studioBySlug(slug)!.id, login, role, 'test');
  const cookie = `vault_session=${signSession(u.id, SECRET)}`;
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, body: unknown = {}) =>
      app.request(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' }, body: JSON.stringify(body) }),
  };
}
const anon = {
  get: (path: string) => app.request(path),
  post: (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' }, body: JSON.stringify(body) }),
};
async function signInWithGitHub(code: string) {
  const start = await app.request('/auth/github');
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  return app.request(`/auth/callback?code=${code}&state=${state}`, { headers: { Cookie: cookie } });
}

// The six kinds of people every action is checked against.
function everyone() {
  db.syncStudios([{ slug: 'other', name: 'Other Studio', github_owner: '', github_owner_id: 'vault:other' }]);
  return {
    vaultAdmin: as('boss', 'admin'),
    releaseManager: as('rita', 'release_manager'),
    studioAdmin: as('ada', 'none', { fieldday: 'admin' }),
    otherStudioAdmin: as('otto', 'none', { other: 'admin' }),
    maintainer: as('mia', 'none', { fieldday: 'maintainer' }),
    viewer: as('vera', 'none', { fieldday: 'viewer' }),
    signedOut: anon,
  };
}

describe('studio members', () => {
  test('adding someone to a studio: Vault admins and that studio’s admins only', async () => {
    const p = everyone();
    const add = (who: typeof anon, login: string) => who.post('/portal/api/s/fieldday/members', { login, role: 'viewer' });
    assert.equal((await add(p.vaultAdmin, 'v1')).status, 200);
    assert.equal((await add(p.studioAdmin, 'v2')).status, 200);
    assert.equal((await add(p.otherStudioAdmin, 'v3')).status, 403);
    assert.equal((await add(p.maintainer, 'v4')).status, 403);
    assert.equal((await add(p.viewer, 'v5')).status, 403);
    assert.equal((await add(p.releaseManager, 'v6')).status, 403);
    assert.equal((await add(p.signedOut, 'v7')).status, 401);
    assert.deepEqual(db.memberships(fd().id).map((m) => m.github_login).filter((l) => l.startsWith('v') && l !== 'vera'), ['v1', 'v2']);
  });

  test('changing a role and removing: same rules; audited', async () => {
    const p = everyone();
    db.setMembership(fd().id, 'sam', 'viewer', 'test');
    for (const who of [p.otherStudioAdmin, p.maintainer, p.viewer, p.releaseManager]) {
      assert.equal((await who.post('/portal/api/s/fieldday/members', { login: 'sam', role: 'admin' })).status, 403);
      assert.equal((await who.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 403);
    }
    assert.equal((await p.signedOut.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 401);
    assert.equal(db.roleIn(fd().id, 'sam'), 'viewer');
    assert.equal((await p.studioAdmin.post('/portal/api/s/fieldday/members', { login: 'sam', role: 'maintainer' })).status, 200);
    assert.equal(db.roleIn(fd().id, 'sam'), 'maintainer');
    assert.equal((await p.studioAdmin.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 200);
    assert.equal(db.roleIn(fd().id, 'sam'), undefined);
    assert.equal((await p.studioAdmin.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 404);
    const log = db.recentAudit(5).map((a) => `${a.actor} ${a.action} ${a.target}`);
    assert.deepEqual(log.slice(0, 2), ['user:ada member.remove fieldday:sam', 'user:ada member.set fieldday:sam']);
  });

  test('the Members page: forms for admins only; invited people are marked', async () => {
    const p = everyone();
    db.setMembership(fd().id, 'newbie', 'viewer', 'user:ada');
    const adminPage = await (await p.studioAdmin.get('/s/fieldday/members')).text();
    assert.match(adminPage, /Add someone/);
    assert.match(adminPage, /newbie<\/b><span><span class="pill p-wait">Invited/);
    assert.match(adminPage, /Cancel invite/);
    for (const who of [p.maintainer, p.viewer]) {
      const r = await who.get('/s/fieldday/members');
      assert.equal(r.status, 200);
      const page = await r.text();
      assert.doesNotMatch(page, /Add someone|data-api="\/portal\/api\/s\/fieldday\/members/);
      assert.match(page, /Invited/);
    }
    assert.equal((await p.otherStudioAdmin.get('/s/fieldday/members')).status, 404);
    assert.equal((await p.signedOut.get('/s/fieldday/members')).status, 302);
  });

  test('an invitation becomes a membership the first time that GitHub account signs in', async () => {
    const ada = as('ada', 'none', { fieldday: 'admin' });
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: '@NewPerson', role: 'maintainer' })).status, 200);
    assert.equal(db.studioSummaries().find((s) => s.slug === 'fieldday')!.invited, 1);
    const cb = await signInWithGitHub('newperson');   // GitHub logins are case-insensitive
    assert.equal(cb.status, 302);
    const cookie = cb.headers.get('set-cookie')!.match(/vault_session=[^;]+/)![0];
    const s = db.studioSummaries().find((x) => x.slug === 'fieldday')!;
    assert.deepEqual([s.members, s.invited], [2, 0]);
    const page = await (await app.request('/s/fieldday', { headers: { Cookie: cookie } })).text();
    assert.match(page, /Field Day Lab/);
    const members = await (await ada.get('/s/fieldday/members')).text();
    assert.doesNotMatch(members, /Invited/);
    assert.match(members, /signed in just now/);
  });

  test('a studio admin can’t remove or demote the last signed-in studio admin; Vault admins can', async () => {
    const ada = as('ada', 'none', { fieldday: 'admin' });
    // An invited admin who hasn't signed in doesn't count.
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ghost', role: 'admin' })).status, 200);
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ada', role: 'maintainer' })).status, 409);
    const r = await ada.post('/portal/api/s/fieldday/members/remove', { login: 'ada' });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /only studio admin/);
    // With a second signed-in admin, ada can step down.
    as('bea', 'none', { fieldday: 'admin' });
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ada', role: 'maintainer' })).status, 200);
    assert.equal(db.roleIn(fd().id, 'ada'), 'maintainer');
    // A Vault admin may remove the last one.
    const boss = as('boss', 'admin');
    assert.equal((await boss.post('/portal/api/s/fieldday/members/remove', { login: 'bea' })).status, 200);
    assert.deepEqual(db.signedInAdmins(fd().id), []);
  });

  test('bad input is refused', async () => {
    const ada = as('ada', 'none', { fieldday: 'admin' });
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'bad user!', role: 'viewer' })).status, 400);
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ok', role: 'owner' })).status, 400);
    assert.equal((await ada.post('/portal/api/s/nope/members', { login: 'ok', role: 'viewer' })).status, 403);
  });
});

describe('Vault People page', () => {
  test('any Vault staff sees everyone and every invitation; only Vault admins get the forms', async () => {
    const p = everyone();
    db.setMembership(fd().id, 'invitee', 'maintainer', 'user:ada');
    const adminPage = await (await p.vaultAdmin.get('/vault/people')).text();
    assert.match(adminPage, /<h2>Add someone<\/h2>/);
    assert.match(adminPage, /name="vaultRole"/);
    assert.match(adminPage, /invitee<\/b><span><span class="pill p-wait">Invited/);
    assert.match(adminPage, /otto<\/b>[\s\S]*Other Studio/);
    const rm = await (await p.releaseManager.get('/vault/people')).text();
    assert.match(rm, /invitee/);
    assert.doesNotMatch(rm, /<h2>Add someone<\/h2>|data-api/);
    for (const who of [p.studioAdmin, p.maintainer, p.viewer]) assert.equal((await who.get('/vault/people')).status, 403);
    assert.equal((await p.signedOut.get('/vault/people')).status, 302);
  });

  test('adding someone with a Vault role: now if they have signed in, at first sign-in otherwise', async () => {
    const p = everyone();
    const add = (body: unknown) => p.vaultAdmin.post('/portal/api/vault/members', body);
    assert.equal((await add({ login: 'nobody' })).status, 400, 'needs a studio or a Vault role');
    assert.equal((await add({ login: 'vera', vaultRole: 'king' })).status, 400);
    // Signed in already: the role applies now; a studio and role can come along.
    assert.equal((await add({ login: 'vera', vaultRole: 'release_manager', studio: 'other', role: 'maintainer' })).status, 200);
    assert.equal(db.userByLogin('vera')!.vault_role, 'release_manager');
    assert.equal(db.roleIn(db.studioBySlug('other')!.id, 'vera'), 'maintainer');
    assert.equal((await add({ login: 'boss', vaultRole: 'none', studio: 'other', role: 'viewer' })).status, 200, 'own studio role is fine');
    assert.equal((await add({ login: 'boss', vaultRole: 'release_manager' })).status, 400, 'not your own Vault role');
    // Not signed in yet: a Vault-only invitation shows on People and applies at first sign-in.
    assert.equal((await add({ login: 'Newbie', vaultRole: 'admin' })).status, 200);
    assert.match(await (await p.vaultAdmin.get('/vault/people')).text(), /Newbie<\/b><span><span class="pill p-wait">Invited[\s\S]*Vault admin <span class="muted">\(at first sign-in\)/);
    assert.equal((await signInWithGitHub('newbie')).status, 302);
    assert.equal(db.userByLogin('newbie')!.vault_role, 'admin');
    assert.equal(db.vaultInvites().length, 0);
    assert.equal((await p.releaseManager.post('/portal/api/vault/members', { login: 'x', vaultRole: 'admin' })).status, 403);
  });

  test('Vault admins add anyone to any studio there, and change or remove any membership', async () => {
    const p = everyone();
    const add = (who: typeof anon, body: unknown) => who.post('/portal/api/vault/members', body);
    assert.equal((await add(p.vaultAdmin, { studio: 'other', login: 'zed', role: 'admin' })).status, 200);
    assert.equal(db.roleIn(db.studioBySlug('other')!.id, 'zed'), 'admin');
    for (const who of [p.releaseManager, p.studioAdmin, p.otherStudioAdmin, p.maintainer, p.viewer]) {
      assert.equal((await add(who, { studio: 'other', login: 'x', role: 'viewer' })).status, 403);
    }
    assert.equal((await add(p.signedOut, { studio: 'other', login: 'x', role: 'viewer' })).status, 401);
    assert.equal((await add(p.vaultAdmin, { studio: 'nope', login: 'x', role: 'viewer' })).status, 404);
    // The per-membership forms on People use each studio's member API, which Vault admins may use for any studio.
    assert.equal((await p.vaultAdmin.post('/portal/api/s/other/members', { login: 'otto', role: 'viewer' })).status, 200);
    assert.equal((await p.vaultAdmin.post('/portal/api/s/other/members/remove', { login: 'zed' })).status, 200);
    assert.equal(db.roleIn(db.studioBySlug('other')!.id, 'zed'), undefined);
  });

  test('Vault roles: Vault admins only, not their own', async () => {
    const p = everyone();
    const rita = db.users().find((u) => u.login === 'rita')!;
    for (const who of [p.releaseManager, p.studioAdmin, p.maintainer, p.viewer]) assert.equal((await who.post(`/portal/api/vault/users/${rita.id}/role`, { role: 'admin' })).status, 403);
    assert.equal((await p.vaultAdmin.post(`/portal/api/vault/users/${rita.id}/role`, { role: 'none' })).status, 200);
    assert.equal(db.userById(rita.id)!.vault_role, 'none');
  });
});

describe('Vault Studios page', () => {
  test('lists every studio with its counts and origin; staff only; the create form for Vault admins', async () => {
    const p = everyone();
    db.setMembership(fd().id, 'invitee', 'viewer', 'test');
    const page = await (await p.vaultAdmin.get('/vault/studios')).text();
    assert.match(page, /Field Day Lab/);
    assert.match(page, /University of Calgary/);
    assert.match(page, /New studio/);
    assert.match(page, /\+1 invited/);
    assert.match(page, /studios\.json/);
    const rm = await (await p.releaseManager.get('/vault/studios')).text();
    assert.doesNotMatch(rm, /New studio/);
    assert.equal((await p.releaseManager.get('/vault/studios/fieldday')).status, 200);
    for (const who of [p.studioAdmin, p.maintainer, p.viewer]) {
      assert.equal((await who.get('/vault/studios')).status, 403);
      assert.equal((await who.get('/vault/studios/fieldday')).status, 403);
    }
    assert.equal((await p.signedOut.get('/vault/studios')).status, 302);
    assert.match(await (await p.vaultAdmin.get('/')).text(), /href="\/vault\/studios"/);
  });

  test('Vault admins create studios with a GitHub organization or without one', async () => {
    const boss = as('boss', 'admin');
    const r = await boss.post('/portal/api/vault/studios', { name: ' Learning  Games Lab ', slug: 'lgl', website: ' https://lgl.example/ ', github: 'https://github.com/learninggameslab' });
    assert.equal(r.status, 200);
    const lgl = db.studioBySlug('lgl')!;
    assert.deepEqual([lgl.name, lgl.github_owner, lgl.github_owner_id, lgl.website, lgl.source], ['Learning Games Lab', 'LearningGamesLab', '5550001', 'https://lgl.example/', 'portal']);
    assert.equal(db.studioByOwnerId('5550001')?.slug, 'lgl');   // its repositories can publish
    assert.equal((await boss.post('/portal/api/vault/studios', { name: 'PhET', slug: 'phet', website: '', github: '' })).status, 200);
    assert.deepEqual([db.studioBySlug('phet')!.github_owner, db.studioBySlug('phet')!.github_owner_id], ['', 'vault:phet']);
    assert.equal(db.recentAudit(1)[0].action, 'studio.create');
    // The new studio's admin can then manage it.
    const ann = as('ann', 'none', { lgl: 'admin' });
    assert.equal((await ann.post('/portal/api/s/lgl/members', { login: 'bob', role: 'viewer' })).status, 200);
    assert.equal((await ann.post('/portal/api/s/fieldday/members', { login: 'bob', role: 'viewer' })).status, 403);
  });

  test('studio creation is validated', async () => {
    const boss = as('boss', 'admin');
    const create = async (body: Record<string, string>) => {
      const r = await boss.post('/portal/api/vault/studios', { name: 'New', slug: 'new', website: '', github: '', ...body });
      return [r.status, ((await r.json()) as { error?: string }).error ?? ''] as const;
    };
    assert.equal((await create({ slug: 'Bad Slug' }))[0], 400);
    assert.equal((await create({ slug: '-x' }))[0], 400);
    assert.equal((await create({ name: '   ' }))[0], 400);
    assert.equal((await create({ name: 'x'.repeat(101) }))[0], 400);
    assert.equal((await create({ website: 'lgl.example' }))[0], 400);
    assert.equal((await create({ github: 'no such/org' }))[0], 400);
    const missing = await create({ github: 'nobody-here' });
    assert.equal(missing[0], 400);
    assert.match(missing[1], /no organization or user called nobody-here/);
    assert.equal((await create({ slug: 'fieldday' }))[0], 409);                 // slug taken
    assert.equal((await create({ name: 'field day lab' }))[0], 409);            // name taken
    const org = await create({ github: 'fielddaylab' });                         // org already publishes to fieldday
    assert.equal(org[0], 409);
    assert.match(org[1], /already publishes to Field Day Lab/);
    githubDown = true;
    assert.equal((await create({ github: 'learninggameslab' }))[0], 503);
    assert.equal(db.studioBySlug('new'), undefined);
  });

  test('only Vault admins create or edit studios', async () => {
    const p = everyone();
    const body = { name: 'New', slug: 'new', website: '', github: '' };
    for (const who of [p.releaseManager, p.studioAdmin, p.otherStudioAdmin, p.maintainer, p.viewer]) {
      assert.equal((await who.post('/portal/api/vault/studios', body)).status, 403);
      assert.equal((await who.post('/portal/api/vault/studios/other', { name: 'Hacked', website: '', github: '' })).status, 403);
    }
    assert.equal((await p.signedOut.post('/portal/api/vault/studios', body)).status, 401);
    assert.equal(db.studioBySlug('new'), undefined);
    assert.equal(db.studioBySlug('other')!.name, 'Other Studio');
  });

  test('Vault admins edit a portal studio’s name, website and GitHub organization; audited', async () => {
    const boss = as('boss', 'admin');
    await boss.post('/portal/api/vault/studios', { name: 'LGL', slug: 'lgl', website: '', github: '' });
    const edit = (body: Record<string, string>) => boss.post('/portal/api/vault/studios/lgl', { name: 'LGL', website: '', github: '', ...body });
    assert.equal((await edit({ name: 'Learning Games Lab', website: 'https://lgl.example/', github: 'learninggameslab' })).status, 200);
    let s = db.studioBySlug('lgl')!;
    assert.deepEqual([s.name, s.website, s.github_owner, s.github_owner_id], ['Learning Games Lab', 'https://lgl.example/', 'LearningGamesLab', '5550001']);
    const a = db.auditFor(['studio.update'], 1)[0];
    assert.deepEqual(JSON.parse(a.detail_json!), { name: { from: 'LGL', to: 'Learning Games Lab' }, github: { from: 'vault:lgl', to: 'LearningGamesLab' }, website: { from: null, to: 'https://lgl.example/' } });
    // Back to Vault-managed: the placeholder owner id again.
    assert.equal((await edit({ name: 'Learning Games Lab', github: '' })).status, 200);
    s = db.studioBySlug('lgl')!;
    assert.deepEqual([s.github_owner, s.github_owner_id], ['', 'vault:lgl']);
    assert.equal((await edit({ name: 'Field Day Lab' })).status, 409);
    assert.equal((await edit({ github: 'fielddaylab' })).status, 409);
    assert.equal((await boss.post('/portal/api/vault/studios/nope', { name: 'x', website: '', github: '' })).status, 404);
  });

  test('a studios.json studio: only its website can be changed in the portal', async () => {
    const boss = as('boss', 'admin');
    const page = await (await boss.get('/vault/studios/fieldday')).text();
    assert.match(page, /change them there/);
    assert.equal((await boss.post('/portal/api/vault/studios/fieldday', { name: 'Renamed', website: '', github: 'fielddaylab' })).status, 409);
    assert.equal((await boss.post('/portal/api/vault/studios/fieldday', { name: 'Field Day Lab', website: 'https://fielddaylab.wisc.edu/', github: 'fielddaylab' })).status, 200);
    assert.equal(db.studioBySlug('fieldday')!.website, 'https://fielddaylab.wisc.edu/');
    assert.equal(db.studioBySlug('fieldday')!.name, 'Field Day Lab');
  });
});

describe('studios.json at startup', () => {
  test('never changes or deletes studios it doesn’t list, and skips an entry whose slug a portal studio has', async () => {
    const boss = as('boss', 'admin');
    await boss.post('/portal/api/vault/studios', { name: 'Learning Games Lab', slug: 'lgl', website: 'https://lgl.example/', github: 'learninggameslab' });
    db.setMembership(db.studioBySlug('lgl')!.id, 'ann', 'admin', 'user:boss');
    // A later studios.json lists a different org under the same slug: skipped, not a crash, and lgl is untouched.
    const out = db.syncStudios([...FILE, { slug: 'lgl', name: 'Somebody Else', github_owner: 'else', github_owner_id: '777' }]);
    assert.deepEqual(out.skipped, ['lgl']);
    const lgl = db.studioBySlug('lgl')!;
    assert.deepEqual([lgl.name, lgl.github_owner_id, lgl.website, lgl.source], ['Learning Games Lab', '5550001', 'https://lgl.example/', 'portal']);
    assert.equal(db.roleIn(lgl.id, 'ann'), 'admin');
    assert.equal(db.studioByOwnerId('777'), undefined);
    // Re-syncing the same file again (every deploy) leaves it alone too.
    db.syncStudios(FILE);
    assert.equal(db.studioBySlug('lgl')!.name, 'Learning Games Lab');
    assert.equal(db.studios().length, 3);
  });

  test('stays authoritative for the studios it lists, and records where each studio came from', () => {
    db.syncStudios([{ ...FILE[0], name: 'Field Day Lab (UW)' }]);
    assert.equal(db.studioBySlug('fieldday')!.name, 'Field Day Lab (UW)');
    assert.equal(db.studioBySlug('fieldday')!.source, 'file');
    importListings(db, [{ slug: 'some-game', title: 'Some Game', params: { makers: ['Brand New Maker'] } } as never], {}, 'user:boss', { 'Brand New Maker': 'bnm' });
    assert.equal(db.studioBySlug('bnm')?.source, 'import');
  });
});
