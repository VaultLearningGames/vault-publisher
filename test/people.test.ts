// Studios and people: who can add studios and studio members, invitations, and studios.json vs. portal studios.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { Db, type StudioRole } from '../src/db.ts';
import { STUDIO_PERMISSIONS, VAULT_PERMISSIONS, type StudioPermission, type VaultPermission } from '../src/permissions.ts';
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
// vaultRole and roles: old roles (permissions.ts maps them) or the permissions themselves.
function as(login: string, vaultRole: 'none' | 'release_manager' | 'admin' | VaultPermission[] = 'none', roles: Record<string, StudioRole | StudioPermission[]> = {}) {
  const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
  if (Array.isArray(vaultRole)) db.setVaultPermissions(login, vaultRole, 'test');
  else db.setVaultRole(u.id, vaultRole);
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

// The kinds of people every action is checked against.
function everyone() {
  db.syncStudios([{ slug: 'other', name: 'Other Studio', github_owner: '', github_owner_id: 'vault:other' }]);
  return {
    vaultAdmin: as('boss', 'admin'),   // every Vault permission
    contentEditor: as('rita', ['vault.content.edit']),
    blogEditor: as('bea', ['vault.blog.edit']),
    userMaintainer: as('uma', ['vault.users.maintain']),
    studioAdmin: as('ada', 'none', { fieldday: [...STUDIO_PERMISSIONS] }),
    otherStudioAdmin: as('otto', 'none', { other: [...STUDIO_PERMISSIONS] }),
    maintainer: as('mia', 'none', { fieldday: ['studio.edit', 'studio.request_publish'] }),
    viewer: as('vera', 'none', { fieldday: ['studio.view'] }),
    signedOut: anon,
  };
}

describe('studio members', () => {
  test('adding someone to a studio: Vault staff who maintain users and that studio’s members who do', async () => {
    const p = everyone();
    const add = (who: typeof anon, login: string) => who.post('/portal/api/s/fieldday/members', { login, permissions: ['studio.view'] });
    assert.equal((await add(p.vaultAdmin, 'v1')).status, 200);
    assert.equal((await add(p.studioAdmin, 'v2')).status, 200);
    assert.equal((await add(p.userMaintainer, 'v3')).status, 200);
    for (const who of [p.otherStudioAdmin, p.maintainer, p.viewer, p.contentEditor, p.blogEditor]) assert.equal((await add(who, 'v4')).status, 403);
    assert.equal((await add(p.signedOut, 'v5')).status, 401);
    assert.deepEqual(db.memberships(fd().id).map((m) => m.github_login).filter((l) => l.startsWith('v') && l !== 'vera'), ['v1', 'v2', 'v3']);
  });

  test('changing permissions and removing: same rules; audited', async () => {
    const p = everyone();
    db.setMembership(fd().id, 'sam', ['studio.view'], 'test');
    for (const who of [p.otherStudioAdmin, p.maintainer, p.viewer, p.contentEditor, p.blogEditor]) {
      assert.equal((await who.post('/portal/api/s/fieldday/members', { login: 'sam', permissions: STUDIO_PERMISSIONS })).status, 403);
      assert.equal((await who.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 403);
    }
    assert.equal((await p.signedOut.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 401);
    assert.deepEqual(db.studioPermissionsOf(fd().id, 'sam'), ['studio.view']);
    assert.equal((await p.studioAdmin.post('/portal/api/s/fieldday/members', { login: 'sam', permissions: ['studio.edit'] })).status, 200);
    assert.deepEqual(db.studioPermissionsOf(fd().id, 'sam'), ['studio.view', 'studio.edit'], 'Edit implies View');
    assert.equal(db.roleIn(fd().id, 'sam'), 'maintainer', 'the old column follows');
    assert.equal((await p.studioAdmin.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 200);
    assert.equal(db.membership(fd().id, 'sam'), undefined);
    assert.equal((await p.studioAdmin.post('/portal/api/s/fieldday/members/remove', { login: 'sam' })).status, 404);
    const log = db.recentAudit(5).map((a) => `${a.actor} ${a.action} ${a.target}`);
    assert.deepEqual(log.slice(0, 2), ['user:ada member.remove fieldday:sam', 'user:ada member.set fieldday:sam']);
    assert.deepEqual(JSON.parse(db.auditFor(['member.set'], 1)[0].detail_json!), { permissions: ['studio.view', 'studio.edit'], from: ['studio.view'], invited: true });
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
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: '@NewPerson', permissions: ['studio.edit', 'studio.request_publish'] })).status, 200);
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

  test('a member can’t remove the last signed-in member who maintains users, or take it from them; Vault staff who maintain users can', async () => {
    const ada = as('ada', 'none', { fieldday: 'admin' });
    // An invited one who hasn't signed in doesn't count.
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ghost', permissions: STUDIO_PERMISSIONS })).status, 200);
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ada', permissions: ['studio.view', 'studio.edit'] })).status, 409);
    const r = await ada.post('/portal/api/s/fieldday/members/remove', { login: 'ada' });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /only member of Field Day Lab who maintains users/);
    // With a second signed-in one, ada can step down.
    as('bea', 'none', { fieldday: ['studio.maintain_users'] });
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ada', permissions: ['studio.view', 'studio.edit'] })).status, 200);
    assert.deepEqual(db.studioPermissionsOf(fd().id, 'ada'), ['studio.view', 'studio.edit']);
    // Vault staff who maintain users may remove the last one.
    const uma = as('uma', ['vault.users.maintain']);
    assert.equal((await uma.post('/portal/api/s/fieldday/members/remove', { login: 'bea' })).status, 200);
    assert.deepEqual(db.signedInUserMaintainers(fd().id), []);
  });

  test('bad input is refused', async () => {
    const ada = as('ada', 'none', { fieldday: 'admin' });
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'bad user!', role: 'viewer' })).status, 400);
    assert.equal((await ada.post('/portal/api/s/fieldday/members', { login: 'ok', role: 'owner' })).status, 400);
    assert.equal((await ada.post('/portal/api/s/nope/members', { login: 'ok', role: 'viewer' })).status, 403);
  });
});

describe('Vault People page', () => {
  test('Vault staff who maintain users see everyone and every invitation, with the forms; nobody else sees the page', async () => {
    const p = everyone();
    db.setMembership(fd().id, 'invitee', 'maintainer', 'user:ada');
    for (const who of [p.vaultAdmin, p.userMaintainer]) {
      const page = await (await who.get('/vault/people')).text();
      assert.match(page, /<h2>Add someone<\/h2>/);
      for (const perm of VAULT_PERMISSIONS) assert.match(page, new RegExp(`name="${perm}"`));
      assert.match(page, /invitee<\/b><span><span class="pill p-wait">Invited/);
      assert.match(page, /otto<\/b>[\s\S]*Other Studio/);
      assert.match(await (await who.get('/')).text(), /href="\/vault\/people"/);
    }
    for (const who of [p.contentEditor, p.blogEditor, p.studioAdmin, p.maintainer, p.viewer]) assert.equal((await who.get('/vault/people')).status, 403);
    assert.doesNotMatch(await (await p.contentEditor.get('/')).text(), /href="\/vault\/people"/);
    assert.equal((await p.signedOut.get('/vault/people')).status, 302);
  });

  test('adding someone with Vault permissions: theirs now if they have signed in, from their first sign-in otherwise', async () => {
    const p = everyone();
    const add = (body: unknown) => p.vaultAdmin.post('/portal/api/vault/members', body);
    assert.equal((await add({ login: 'nobody' })).status, 400, 'needs a studio or a Vault permission');
    assert.equal((await add({ login: 'vera', 'vault.king': true })).status, 400);
    // Signed in already: the permissions apply now; a studio and its permissions can come along.
    assert.equal((await add({ login: 'vera', 'vault.content.edit': true, studio: 'other', 'studio.edit': true })).status, 200);
    assert.deepEqual(db.vaultPermissionsOf('vera'), ['vault.content.edit']);
    assert.equal(db.userByLogin('vera')!.vault_role, 'release_manager', 'the old column follows');
    assert.deepEqual(db.studioPermissionsOf(db.studioBySlug('other')!.id, 'vera'), ['studio.view', 'studio.edit']);
    assert.equal((await add({ login: 'boss', studio: 'other', 'studio.view': true })).status, 200, 'own studio permissions are fine');
    assert.equal((await add({ login: 'boss', 'vault.blog.edit': true })).status, 400, 'not your own Vault permissions');
    // Not signed in yet: shows on People and applies at first sign-in.
    assert.equal((await add({ login: 'Newbie', 'vault.users.maintain': true, 'vault.content.edit': true, 'vault.blog.edit': true })).status, 200);
    assert.match(await (await p.vaultAdmin.get('/vault/people')).text(), /Newbie<\/b><span><span class="pill p-wait">Invited[\s\S]*name="vault\.users\.maintain" checked[\s\S]*<span class="muted small">\(at first sign-in\)/);
    assert.equal((await signInWithGitHub('newbie')).status, 302);
    assert.deepEqual(db.vaultPermissionsOf('newbie'), VAULT_PERMISSIONS);
    assert.equal(db.userByLogin('newbie')!.vault_role, 'admin');
    for (const who of [p.contentEditor, p.blogEditor, p.studioAdmin]) assert.equal((await who.post('/portal/api/vault/members', { login: 'x', 'vault.blog.edit': true })).status, 403);
    assert.equal((await p.userMaintainer.post('/portal/api/vault/members', { login: 'x', 'vault.blog.edit': true })).status, 200);
  });

  test('someone who hasn’t signed in: their Vault permissions are shown, changed and removed in the table like anyone’s', async () => {
    const p = everyone();
    const set = (body: unknown, who = p.vaultAdmin) => who.post('/portal/api/vault/permissions', body);
    const row = (page: string, login: string) => page.slice(page.indexOf(`<b>${login}</b>`), page.indexOf('</tr>', page.indexOf(`<b>${login}</b>`)));
    const people = async (who = p.vaultAdmin) => (await who.get('/vault/people')).text();
    const VAULT_CHECKED = /name="vault\.[a-z.]+" checked/;
    // Invited to a studio only: Vault permissions can be given from their row, before they ever sign in.
    db.setMembership(fd().id, 'invitee', 'maintainer', 'user:ada');
    assert.match(row(await people(), 'invitee'), /data-api="\/portal\/api\/vault\/permissions"[^]*name="login" value="invitee"/);
    assert.doesNotMatch(row(await people(), 'invitee'), VAULT_CHECKED);
    assert.doesNotMatch(row(await people(), 'invitee'), /at first sign-in/);
    assert.deepEqual(await (await set({ login: 'invitee', permissions: ['vault.content.edit'] })).json(), { ok: true, pending: true });
    assert.deepEqual(db.vaultPermissionsOf('invitee'), ['vault.content.edit']);
    assert.match(row(await people(), 'invitee'), /name="vault\.content\.edit" checked[^]*\(at first sign-in\)/);
    // Changed (from the editor's checkboxes), then removed; the login's capitalization doesn't matter.
    assert.equal((await set({ login: 'Invitee', 'vault.blog.edit': 'on' })).status, 200);
    assert.deepEqual(db.vaultPermissionsOf('invitee'), ['vault.blog.edit']);
    assert.match(row(await people(p.userMaintainer), 'invitee'), /name="vault\.blog\.edit" checked[^]*\(at first sign-in\)/);
    assert.equal((await set({ login: 'invitee', permissions: [] })).status, 200);
    assert.deepEqual(db.vaultPermissionsOf('invitee'), []);
    assert.doesNotMatch(row(await people(), 'invitee'), VAULT_CHECKED, 'still invited to the studio');
    assert.match(row(await people(), 'invitee'), /Invited/);
    assert.deepEqual(db.auditFor(['vault.permissions'], 10).map((a) => JSON.parse(a.detail_json!)).reverse(), [
      { permissions: ['vault.content.edit'], from: [], invited: true },
      { permissions: ['vault.blog.edit'], from: ['vault.content.edit'], invited: true },
      { permissions: [], from: ['vault.blog.edit'], invited: true },
    ]);
    // A Vault-only invitation that is removed leaves nothing: the person is off the page.
    assert.equal((await p.vaultAdmin.post('/portal/api/vault/members', { login: 'Newbie', 'vault.content.edit': true })).status, 200);
    assert.match(row(await people(), 'Newbie'), /name="login" value="Newbie"[^]*name="vault\.content\.edit" checked/);
    assert.equal((await set({ login: 'newbie', permissions: [] })).status, 200);
    assert.doesNotMatch(await people(), /Newbie/);
    assert.equal((await signInWithGitHub('newbie')).status, 302);
    assert.equal(db.userByLogin('newbie')!.vault_role, 'none', 'removed permissions aren’t given at sign-in');
    // What they hold when they sign in is what they have.
    assert.equal((await set({ login: 'invitee', permissions: ['vault.content.edit'] })).status, 200);
    assert.equal((await signInWithGitHub('invitee')).status, 302);
    assert.deepEqual(db.vaultPermissionsOf('invitee'), ['vault.content.edit']);
    assert.equal(db.userByLogin('invitee')!.vault_role, 'release_manager');
    assert.doesNotMatch(row(await people(), 'invitee'), /at first sign-in/);
    assert.deepEqual(await (await set({ login: 'invitee', permissions: VAULT_PERMISSIONS })).json(), { ok: true, pending: false });
    assert.equal(db.userByLogin('invitee')!.vault_role, 'admin');
    // Vault staff who maintain users only; real permissions and username; never your own.
    assert.equal((await set({ login: 'x', permissions: ['vault.blog.edit'] }, p.contentEditor)).status, 403);
    assert.equal((await set({ login: 'x', permissions: ['vault.blog.edit'] }, p.studioAdmin)).status, 403);
    assert.equal((await set({ login: 'x', permissions: ['vault.king'] })).status, 400);
    assert.equal((await set({ login: 'x', 'vault.king': true })).status, 400);
    assert.equal((await set({ login: 'not a login!', permissions: ['vault.blog.edit'] })).status, 400);
    assert.equal((await set({ login: 'boss', permissions: [] })).status, 400);
    assert.deepEqual(db.vaultPermissionsOf('x'), []);
  });

  test('Vault staff who maintain users add anyone to any studio there, and change or remove any membership', async () => {
    const p = everyone();
    const add = (who: typeof anon, body: unknown) => who.post('/portal/api/vault/members', body);
    assert.equal((await add(p.vaultAdmin, { studio: 'other', login: 'zed', ...Object.fromEntries(STUDIO_PERMISSIONS.map((x) => [x, true])) })).status, 200);
    assert.deepEqual(db.studioPermissionsOf(db.studioBySlug('other')!.id, 'zed'), STUDIO_PERMISSIONS);
    assert.equal((await add(p.userMaintainer, { studio: 'other', login: 'zoe', 'studio.view': true })).status, 200);
    for (const who of [p.contentEditor, p.blogEditor, p.studioAdmin, p.otherStudioAdmin, p.maintainer, p.viewer]) {
      assert.equal((await add(who, { studio: 'other', login: 'x', 'studio.view': true })).status, 403);
    }
    assert.equal((await add(p.signedOut, { studio: 'other', login: 'x', 'studio.view': true })).status, 401);
    assert.equal((await add(p.vaultAdmin, { studio: 'nope', login: 'x', 'studio.view': true })).status, 404);
    // The per-membership forms on People use each studio's member API, which they may use for any studio.
    assert.equal((await p.userMaintainer.post('/portal/api/s/other/members', { login: 'otto', 'studio.view': true })).status, 200);
    assert.equal((await p.userMaintainer.post('/portal/api/s/other/members/remove', { login: 'zed' })).status, 200);
    assert.equal(db.membership(db.studioBySlug('other')!.id, 'zed'), undefined);
  });

  test('Vault permissions: Vault staff who maintain users only, not their own', async () => {
    const p = everyone();
    const set = (who: typeof anon, login: string, permissions: readonly string[]) => who.post('/portal/api/vault/permissions', { login, permissions });
    for (const who of [p.contentEditor, p.blogEditor, p.studioAdmin, p.maintainer, p.viewer]) assert.equal((await set(who, 'rita', VAULT_PERMISSIONS)).status, 403);
    assert.deepEqual(db.vaultPermissionsOf('rita'), ['vault.content.edit']);
    assert.equal((await set(p.userMaintainer, 'rita', [])).status, 200);
    assert.equal(db.userByLogin('rita')!.vault_role, 'none');
    assert.equal((await set(p.userMaintainer, 'uma', VAULT_PERMISSIONS)).status, 400);
    assert.equal((await set(p.signedOut, 'rita', [])).status, 401);
  });
});

describe('Vault Studios page', () => {
  test('lists every studio with its counts and origin; staff only; the create form for those who edit game/studio content', async () => {
    const p = everyone();
    db.setMembership(fd().id, 'invitee', 'viewer', 'test');
    const page = await (await p.vaultAdmin.get('/vault/studios')).text();
    assert.match(page, /Field Day Lab/);
    assert.match(page, /University of Calgary/);
    assert.match(page, /New studio/);
    assert.match(page, /\+1 invited/);
    assert.match(page, /studios\.json/);
    assert.match(await (await p.contentEditor.get('/vault/studios')).text(), /New studio/);
    for (const who of [p.blogEditor, p.userMaintainer]) {
      assert.doesNotMatch(await (await who.get('/vault/studios')).text(), /New studio/);
      assert.equal((await who.get('/vault/studios/fieldday')).status, 200);
    }
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
    assert.equal((await ann.post('/portal/api/s/lgl/members', { login: 'bob', permissions: ['studio.view'] })).status, 200);
    assert.equal((await ann.post('/portal/api/s/fieldday/members', { login: 'bob', permissions: ['studio.view'] })).status, 403);
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

  test('only Vault staff who edit game/studio content create or edit studios', async () => {
    const p = everyone();
    const body = { name: 'New', slug: 'new', website: '', github: '' };
    for (const who of [p.blogEditor, p.userMaintainer, p.studioAdmin, p.otherStudioAdmin, p.maintainer, p.viewer]) {
      assert.equal((await who.post('/portal/api/vault/studios', body)).status, 403);
      assert.equal((await who.post('/portal/api/vault/studios/other', { name: 'Hacked', website: '', github: '' })).status, 403);
    }
    assert.equal((await p.signedOut.post('/portal/api/vault/studios', body)).status, 401);
    assert.equal(db.studioBySlug('new'), undefined);
    assert.equal(db.studioBySlug('other')!.name, 'Other Studio');
    assert.equal((await p.contentEditor.post('/portal/api/vault/studios', body)).status, 200);
    assert.equal((await p.contentEditor.post('/portal/api/vault/studios/new', { name: 'Renamed', website: '', github: '' })).status, 200);
    assert.equal(db.studioBySlug('new')!.name, 'Renamed');
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
