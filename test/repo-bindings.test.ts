// A single repository assigned to a studio (studio_repositories): one GitHub organization holding several studios'
// games. Publishing with a bound repository, studios.json's "repositories" at startup, and the portal's page and API.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { Db, type StudioRole } from '../src/db.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { signSession } from '../src/portal/session.ts';
import { syncStudiosFile, type StudiosFileEntry } from '../src/studios-file.ts';
import { FakeStorage } from './portal-harness.ts';

const SECRET = 'test-session-secret';
const ORG = '214136763'; // VaultLearningGames
const SHADOWSPECT = { name: 'VaultLearningGames/hosted-shadowspect', id: '412239602' };
const TQ = { name: 'VaultLearningGames/hosted-transformation-quest', id: '679805874' };
// What staging has: the "vault" studio owns the organization's id; the hosted games' studios are Vault-managed.
const FILE: StudiosFileEntry[] = [
  { slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
  { slug: 'vault', name: 'Vault Learning Games', github_owner: 'VaultLearningGames', github_owner_id: ORG },
  { slug: 'mit-education-arcade', name: 'MIT Education Arcade', github_owner: '', github_owner_id: 'vault:mit-education-arcade', repositories: [SHADOWSPECT] },
  { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary', repositories: [TQ] },
];

const base = { owner: 'VaultLearningGames', ownerId: ORG, ref: 'refs/heads/main', sha: 'abc123', actor: 'dev', eventName: 'push' };
const identities: Record<string, GitHubIdentity> = {
  shadowspect: { ...base, repository: SHADOWSPECT.name, repositoryId: SHADOWSPECT.id },
  tq: { ...base, repository: TQ.name, repositoryId: TQ.id, ref: 'refs/heads/develop' },
  testgame: { ...base, repository: 'VaultLearningGames/vault-publisher-test', repositoryId: '700' },
  wake: { ...base, owner: 'fielddaylab', ownerId: '1881825', repository: 'fielddaylab/wake', repositoryId: '100' },
  stranger: { ...base, owner: 'acme', ownerId: '999', repository: 'acme/game', repositoryId: '300' },
  adopted: { ...base, owner: 'acme', ownerId: '999', repository: 'acme/adopted', repositoryId: '301' },
  admin: { ...base, repository: 'VaultLearningGames/vault-publisher', repositoryId: '900', eventName: 'workflow_dispatch', environment: 'production' },
};
const verifier: Verifier = {
  async github(token) { const id = identities[token]; if (!id) throw new Error('bad signature'); return id; },
  async google() { throw new Error('no'); },
};
const GITHUB: Record<string, { id: string; name: string }> = {
  'vaultlearninggames/hosted-transformation-quest': { id: TQ.id, name: TQ.name },
  'vaultlearninggames/public-game': { id: '555', name: 'VaultLearningGames/Public-Game' },
};
let githubDown = false;
const quiet = { log() {}, error() {} };

let db: Db, storage: FakeStorage, app: ReturnType<typeof createApp>;
function build() {
  storage = new FakeStorage();
  app = createApp({
    db, staging: storage, production: new FakeStorage(), verifier,
    stagingPublicUrl: 'https://stg.test', prodPublicUrl: 'https://prod.test',
    adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
    previewRetentionDays: 90, taskInvokerEmail: 'x@y',
    portal: {
      baseUrl: 'https://portal.test', sessionSecret: SECRET, vaultAdmins: ['boss'],
      githubRepository: async (name) => {
        if (githubDown) throw new Error('HTTP 500');
        return GITHUB[name.toLowerCase()] ?? null;
      },
    },
  });
}
beforeEach(() => {
  githubDown = false;
  db = new Db(':memory:');
  syncStudiosFile(db, FILE, quiet);
  build();
});

const files = [{ path: 'index.html', size: 10 }];
function post(path: string, token: string, body?: unknown) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) });
}
async function start(token: string, game: string) {
  const res = await post('/v1/previews', token, { game, files });
  return { res, json: (await res.json()) as any };
}
async function publish(token: string, game: string) {
  const { res, json } = await start(token, game);
  assert.equal(res.status, 200, JSON.stringify(json));
  for (const f of json.files) await storage.put(new URL(f.url).pathname.slice(1), new Uint8Array(10), 10, {} as ObjectHeaders);
  const done = await post(`/v1/previews/${json.upload_id}/finalize`, token);
  assert.equal(done.status, 200);
  return json.url as string;
}
const studio = (slug: string) => db.studioBySlug(slug)!;
function as(login: string, vaultRole: 'none' | 'release_manager' | 'admin' = 'none', roles: Record<string, StudioRole> = {}) {
  const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
  db.setVaultRole(u.id, vaultRole);
  for (const [slug, role] of Object.entries(roles)) db.setMembership(studio(slug).id, login, role, 'test');
  const cookie = `vault_session=${signSession(u.id, SECRET)}`;
  return {
    get: (path: string) => app.request(path, { headers: { Cookie: cookie } }),
    post: (path: string, body: unknown = {}) =>
      app.request(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' }, body: JSON.stringify(body) }),
  };
}
const audits = (action: string) => db.auditFor([action], 50);

describe('which studio a repository publishes for', () => {
  test('a repository assigned to a studio publishes for it, not for its organization’s studio', async () => {
    assert.equal(await publish('shadowspect', 'shadowspect'), 'https://stg.test/mit-education-arcade/shadowspect/main/');
    assert.equal(await publish('tq', 'transformation-quest'), 'https://stg.test/ucalgary/transformation-quest/develop/');
    const g = db.game(studio('mit-education-arcade').id, 'shadowspect')!;
    assert.deepEqual([g.repository, g.repository_id], [SHADOWSPECT.name, SHADOWSPECT.id]);
    assert.equal(db.game(studio('vault').id, 'shadowspect'), undefined);
  });

  test('a repository of the same organization that isn’t assigned still publishes for the organization’s studio', async () => {
    assert.equal(await publish('testgame', 'test-game'), 'https://stg.test/vault/test-game/main/');
    assert.equal(await publish('wake', 'aqualab'), 'https://stg.test/fieldday/aqualab/main/');
    assert.equal(db.gamesForStudio(studio('mit-education-arcade').id).length, 0);
  });

  test('an assignment works for a repository whose owner is no studio at all; other repositories of that owner stay out', async () => {
    assert.equal((await start('adopted', 'game')).res.status, 403);
    db.bindRepository({ repository_id: '301', repository: 'acme/adopted', studio_id: studio('ucalgary').id, created_by: 'test', source: 'portal' });
    assert.equal(await publish('adopted', 'game'), 'https://stg.test/ucalgary/game/main/');
    const refused = await start('stranger', 'game');
    assert.equal(refused.res.status, 403);
    assert.match(refused.json.error, /not a registered studio/);
  });

  test('an assigned repository and its organization’s studio never reach each other’s games, even with the same name', async () => {
    await publish('testgame', 'shadowspect');                    // vault/shadowspect, owned by the test repository
    await publish('shadowspect', 'shadowspect');                 // mit-education-arcade/shadowspect: a different game
    const vaultGame = db.game(studio('vault').id, 'shadowspect')!;
    const mitGame = db.game(studio('mit-education-arcade').id, 'shadowspect')!;
    assert.notEqual(vaultGame.id, mitGame.id);
    assert.equal(vaultGame.repository_id, '700');
    assert.equal(mitGame.repository_id, SHADOWSPECT.id);
    // Deleting a preview only touches the caller's own studio's game.
    assert.equal((await post('/v1/previews/delete', 'shadowspect', { game: 'shadowspect', ref: 'main' })).status, 200);
    assert.equal(db.build(vaultGame.id, 'main')!.status, 'live');
    assert.equal(db.build(mitGame.id, 'main')!.status, 'deleted');
    assert.ok(storage.objects.has('vault/shadowspect/main/index.html'));
    // A game only one of them has is unknown to the other.
    await publish('testgame', 'test-game');
    assert.equal((await post('/v1/previews/delete', 'shadowspect', { game: 'test-game', ref: 'main' })).status, 404);
    await publish('tq', 'transformation-quest');
    assert.equal((await post('/v1/previews/delete', 'testgame', { game: 'transformation-quest', ref: 'main' })).status, 404);
  });

  test('inside the studio, a game still belongs to the repository that first published it', async () => {
    await publish('shadowspect', 'shadowspect');
    db.bindRepository({ repository_id: '700', repository: 'VaultLearningGames/vault-publisher-test', studio_id: studio('mit-education-arcade').id, created_by: 'test', source: 'portal' });
    const r = await start('testgame', 'shadowspect');
    assert.equal(r.res.status, 403);
    assert.match(r.json.error, /is published from VaultLearningGames\/hosted-shadowspect/);
    assert.equal((await post('/v1/previews/delete', 'testgame', { game: 'shadowspect', ref: 'main' })).status, 403);
  });

  test('an assigned repository takes over a game Vault uploaded for its studio, and its builds can be released', async () => {
    const up = await post('/v1/admin/previews', 'admin', { studio: 'mit-education-arcade', game: 'shadowspect', ref: 'v1.0', files });
    assert.equal(up.status, 200);
    const mit = studio('mit-education-arcade');
    assert.equal(db.game(mit.id, 'shadowspect')!.repository_id, 'vault:mit-education-arcade/shadowspect');
    // A repository that publishes for another studio can't claim it.
    await publish('testgame', 'shadowspect');
    assert.equal(db.game(mit.id, 'shadowspect')!.repository_id, 'vault:mit-education-arcade/shadowspect');
    await publish('shadowspect', 'shadowspect');
    assert.deepEqual([db.game(mit.id, 'shadowspect')!.repository, db.game(mit.id, 'shadowspect')!.repository_id], [SHADOWSPECT.name, SHADOWSPECT.id]);
    assert.equal(audits('game.claim').filter((a) => a.target === 'mit-education-arcade/shadowspect').length, 1);
    // Release requests and releases go by studio and game, as for any other game.
    const check = await (await app.request('/v1/releases/mit-education-arcade/shadowspect/check?version=v1&ref=main')).json() as any;
    assert.equal(check.ok, true);
    assert.equal(check.repository, SHADOWSPECT.name);
    const ada = as('ada', 'none', { 'mit-education-arcade': 'maintainer' });
    assert.equal((await ada.post('/portal/api/s/mit-education-arcade/g/shadowspect/request', { ref: 'main', version: 'v1' })).status, 200);
    const approved = await post('/v1/admin/releases/approve', 'admin', { studio: 'mit-education-arcade', game: 'shadowspect', version: 'v1', ref: 'main' });
    assert.equal(approved.status, 200);
    assert.equal(((await approved.json()) as any).url, 'https://prod.test/mit-education-arcade/shadowspect/_releases/v1/');
  });

  test('an upload can only be finalized while its repository still publishes for the game’s studio', async () => {
    const { json } = await start('testgame', 'test-game');
    for (const f of json.files) storage.objects.set(new URL(f.url).pathname.slice(1), 10);
    assert.equal((await post(`/v1/previews/${json.upload_id}/finalize`, 'shadowspect')).status, 403);   // another repository
    db.bindRepository({ repository_id: '700', repository: 'VaultLearningGames/vault-publisher-test', studio_id: studio('ucalgary').id, created_by: 'test', source: 'portal' });
    assert.equal((await post(`/v1/previews/${json.upload_id}/finalize`, 'testgame')).status, 403);      // moved to another studio meanwhile
    db.unbindRepository('700');
    assert.equal((await post(`/v1/previews/${json.upload_id}/finalize`, 'testgame')).status, 200);
  });

  test('removing an assignment sends the repository back to its organization’s studio; its old games stay put', async () => {
    await publish('shadowspect', 'shadowspect');
    db.unbindRepository(SHADOWSPECT.id);
    assert.equal(await publish('shadowspect', 'shadowspect'), 'https://stg.test/vault/shadowspect/main/');
    assert.equal(db.game(studio('mit-education-arcade').id, 'shadowspect')!.repository_id, SHADOWSPECT.id);
  });

  test('a renamed repository keeps its assignment (matched by id) and the page shows GitHub’s current name', async () => {
    identities.renamed = { ...identities.shadowspect, repository: 'VaultLearningGames/shadowspect' };
    const { res, json } = await start('renamed', 'shadowspect');
    assert.equal(res.status, 200);
    assert.equal(json.url, 'https://stg.test/mit-education-arcade/shadowspect/main/');
    assert.equal(db.repositoryBinding(SHADOWSPECT.id)!.repository, 'VaultLearningGames/shadowspect');
    delete identities.renamed;
  });
});

describe('studios.json repositories at startup', () => {
  const bindings = () => (db.sqlite.prepare('SELECT repository_id, repository, studio_id, source FROM studio_repositories ORDER BY repository_id').all() as any[])
    .map((r) => `${r.repository_id} ${r.repository} ${db.studioById(r.studio_id)!.slug} ${r.source}`);

  test('assigns the listed repositories, and doing it again changes nothing', () => {
    const expected = [`${SHADOWSPECT.id} ${SHADOWSPECT.name} mit-education-arcade file`, `${TQ.id} ${TQ.name} ucalgary file`];
    assert.deepEqual(bindings(), expected);
    const adds = audits('studio.repository.add').length;
    assert.equal(adds, 2);
    const again = syncStudiosFile(db, FILE, quiet);
    assert.deepEqual(again.repositories, { bound: [], removed: [], skipped: [] });
    assert.deepEqual(bindings(), expected);
    assert.equal(audits('studio.repository.add').length, adds);
  });

  test('the repository’s studios.json is the one that ships: both hosted games are in it', () => {
    const shipped = JSON.parse(readFileSync(new URL('../studios.json', import.meta.url), 'utf8')) as StudiosFileEntry[];
    const fresh = new Db(':memory:');
    const errors: string[] = [];
    const out = syncStudiosFile(fresh, shipped, { log() {}, error: (m) => errors.push(m) });
    assert.deepEqual(errors, []);
    assert.deepEqual(out.repositories.skipped, []);
    assert.equal(fresh.studioByRepositoryId('412239602')?.slug, 'mit-education-arcade');
    assert.equal(fresh.studioByRepositoryId('679805874')?.slug, 'ucalgary');
    assert.equal(fresh.studioByOwnerId(ORG)?.slug, 'vault');
  });

  test('is authoritative for what it lists: a renamed or moved entry is updated, a dropped one is removed', () => {
    const moved = FILE.map((s) => s.slug === 'mit-education-arcade' ? { ...s, repositories: [] }
      : s.slug === 'ucalgary' ? { ...s, repositories: [{ name: 'VaultLearningGames/tq', id: TQ.id }, SHADOWSPECT] } : s);
    const out = syncStudiosFile(db, moved, quiet);
    assert.deepEqual(out.repositories.skipped, []);
    assert.deepEqual(bindings(), [`${SHADOWSPECT.id} ${SHADOWSPECT.name} ucalgary file`, `${TQ.id} VaultLearningGames/tq ucalgary file`]);
    const dropped = syncStudiosFile(db, FILE.map(({ repositories, ...s }) => s), quiet);
    assert.deepEqual(dropped.repositories.removed.sort(), [`ucalgary: ${SHADOWSPECT.name}`, 'ucalgary: VaultLearningGames/tq']);
    assert.deepEqual(bindings(), []);
  });

  test('never deletes a portal assignment, and takes over one the portal made for the same studio', () => {
    db.bindRepository({ repository_id: '555', repository: 'VaultLearningGames/public-game', studio_id: studio('ucalgary').id, created_by: 'user:boss', source: 'portal' });
    db.unbindRepository(TQ.id);
    db.bindRepository({ repository_id: TQ.id, repository: TQ.name, studio_id: studio('ucalgary').id, created_by: 'user:boss', source: 'portal' });
    const out = syncStudiosFile(db, FILE, quiet);
    assert.deepEqual(out.repositories.skipped, []);
    assert.deepEqual(bindings(), [`${SHADOWSPECT.id} ${SHADOWSPECT.name} mit-education-arcade file`, '555 VaultLearningGames/public-game ucalgary portal', `${TQ.id} ${TQ.name} ucalgary file`]);
  });

  test('conflicts and bad entries are logged and skipped, never thrown', () => {
    db.unbindRepository(SHADOWSPECT.id);
    db.bindRepository({ repository_id: SHADOWSPECT.id, repository: SHADOWSPECT.name, studio_id: studio('vault').id, created_by: 'user:boss', source: 'portal' });
    const errors: string[] = [];
    const file = [
      ...FILE,
      { slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825',
        repositories: [TQ, { name: 'not a repository', id: '1' }, { name: 'a/b', id: 'abc' }, { name: 'a/c' }, null, 'x', { name: 'a/numeric', id: 42 }] },
      { slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825', repositories: 'nope' },
    ] as unknown as StudiosFileEntry[];
    const out = syncStudiosFile(db, file, { log() {}, error: (m) => errors.push(m) });
    // The portal's assignment of hosted-shadowspect to another studio stands; the file's is skipped.
    assert.equal(db.studioByRepositoryId(SHADOWSPECT.id)!.slug, 'vault');
    assert.equal(db.repositoryBinding(SHADOWSPECT.id)!.source, 'portal');
    // Listed twice: the first studio keeps it.
    assert.equal(db.studioByRepositoryId(TQ.id)!.slug, 'ucalgary');
    assert.equal(db.studioByRepositoryId('42')!.slug, 'fieldday');
    assert.equal(out.repositories.skipped.length, 8);
    assert.equal(errors.length, 8);
    assert.ok(errors.some((e) => /hosted-shadowspect.*assigned to vault in the portal/.test(e)));
    assert.ok(errors.some((e) => /already listed under ucalgary/.test(e)));
  });

  test('a studio the file lists but the database can’t take is skipped along with its repositories', () => {
    const fresh = new Db(':memory:');
    fresh.createStudio({ slug: 'ucalgary', name: 'Somebody Else', github_owner: 'else', github_owner_id: '777' });
    const errors: string[] = [];
    const out = syncStudiosFile(fresh, FILE, { log() {}, error: (m) => errors.push(m) });
    assert.deepEqual(out.studios.skipped, ['ucalgary']);
    // The slug exists (as the portal's studio), so the repository is assigned to the studio of that name.
    assert.equal(fresh.studioByRepositoryId(TQ.id)!.slug, 'ucalgary');
    assert.equal(fresh.studioByRepositoryId(SHADOWSPECT.id)!.slug, 'mit-education-arcade');
  });

  test('a staging-like database starts cleanly: "vault" owns the organization id, the hosted studios are placeholders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-publisher-test-'));
    try {
      const path = join(dir, 'publisher.db');
      // The database as it was before v12: no studio_repositories, the vault studio holding the organization's id.
      const old = new Db(path);
      old.syncStudios(FILE);
      old.createStudio({ slug: 'phet', name: 'PhET', github_owner: '', github_owner_id: 'vault:phet' });
      const vaultGame = old.createGame(old.studioBySlug('vault')!.id, 'test-game', 'VaultLearningGames/vault-publisher-test', '700');
      old.sqlite.exec('ALTER TABLE studios DROP COLUMN ga_measurement_id; DROP TABLE site_builds; ALTER TABLE listings DROP COLUMN site_changed_at; DROP TABLE site_checks; DROP TABLE url_monitors; DROP TABLE studio_repositories; PRAGMA user_version = 11;'); // (v18, v17, v16, v15, v14)
      old.sqlite.close();

      const shipped = JSON.parse(readFileSync(new URL('../studios.json', import.meta.url), 'utf8')) as StudiosFileEntry[];
      const errors: string[] = [];
      const log = { log() {}, error: (m: string) => errors.push(m) };
      for (let boot = 0; boot < 2; boot++) {       // the migration start, then an ordinary restart
        const started = new Db(path);
        syncStudiosFile(started, shipped, log);
        assert.equal((started.sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 18); // v14 studio_repositories, v15 url_monitors, v16 site_checks, v17 site_builds, v18 studios' GA
        assert.equal(started.studioByOwnerId(ORG)!.slug, 'vault');
        assert.equal(started.studioBySlug('mit-education-arcade')!.github_owner_id, 'vault:mit-education-arcade');
        assert.equal(started.studioBySlug('ucalgary')!.github_owner_id, 'vault:ucalgary');
        assert.equal(started.studioByRepositoryId('412239602')!.slug, 'mit-education-arcade');
        assert.equal(started.studioByRepositoryId('679805874')!.slug, 'ucalgary');
        assert.equal(started.gameById(vaultGame.id)!.studio_id, started.studioBySlug('vault')!.id);
        assert.equal(started.studioBySlug('phet')!.source, 'portal');
        started.sqlite.close();
      }
      assert.deepEqual(errors, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a database where v12 had applied (MIT Education Arcade holding the organization id) is put right', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-publisher-test-'));
    try {
      const path = join(dir, 'publisher.db');
      const old = new Db(path);
      old.syncStudios(FILE.filter((s) => s.slug !== 'vault'));
      old.sqlite.exec(`UPDATE studios SET github_owner_id = '${ORG}', github_owner = 'VaultLearningGames' WHERE slug = 'mit-education-arcade';
        ALTER TABLE studios DROP COLUMN ga_measurement_id; DROP TABLE site_builds; ALTER TABLE listings DROP COLUMN site_changed_at; DROP TABLE site_checks; DROP TABLE url_monitors; DROP TABLE studio_repositories; PRAGMA user_version = 12;`);
      old.sqlite.close();
      const started = new Db(path);
      const errors: string[] = [];
      syncStudiosFile(started, FILE, { log() {}, error: (m) => errors.push(m) });
      assert.deepEqual(errors, []);
      assert.equal(started.studioByOwnerId(ORG)!.slug, 'vault');
      assert.equal(started.studioBySlug('mit-education-arcade')!.github_owner_id, 'vault:mit-education-arcade');
      assert.equal(started.studioByRepositoryId(SHADOWSPECT.id)!.slug, 'mit-education-arcade');
      started.sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Vault studio page: repositories that publish for this studio', () => {
  const api = '/portal/api/vault/studios/ucalgary/repositories';
  function everyone() {
    return {
      vaultAdmin: as('boss', 'admin'),
      releaseManager: as('rita', 'release_manager'),
      studioAdmin: as('ada', 'none', { ucalgary: 'admin' }),
      viewer: as('vera', 'none', { ucalgary: 'viewer' }),
      signedOut: { post: (path: string, body: unknown = {}) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' }, body: JSON.stringify(body) }) },
    };
  }

  test('Vault staff see the list; only Vault admins get the forms; studios.json ones are read-only', async () => {
    const p = everyone();
    db.bindRepository({ repository_id: '555', repository: 'VaultLearningGames/Public-Game', studio_id: studio('ucalgary').id, created_by: 'user:boss', source: 'portal' });
    const page = await (await p.vaultAdmin.get('/vault/studios/ucalgary')).text();
    assert.match(page, /Repositories that publish for this studio/);
    assert.match(page, /VaultLearningGames\/hosted-transformation-quest/);
    assert.match(page, /repository id 679805874/);
    assert.match(page, new RegExp(`data-api="${api}"`));
    assert.equal(page.split(`data-api="${api}/remove"`).length - 1, 1);         // only the portal's one can be removed
    assert.match(page, /name="id" value="555"/);
    assert.doesNotMatch(page, /name="id" value="679805874"/);
    const rm = await (await p.releaseManager.get('/vault/studios/ucalgary')).text();
    assert.match(rm, /VaultLearningGames\/hosted-transformation-quest/);
    assert.doesNotMatch(rm, new RegExp(`data-api="${api}`));
    assert.equal((await p.studioAdmin.get('/vault/studios/ucalgary')).status, 403);
    // A studio with an organization says its other repositories publish to it too.
    assert.match(await (await p.vaultAdmin.get('/vault/studios/vault')).text(), /Every other repository in <b>VaultLearningGames<\/b>/);
  });

  test('only Vault admins add or remove', async () => {
    const p = everyone();
    db.bindRepository({ repository_id: '555', repository: 'VaultLearningGames/Public-Game', studio_id: studio('ucalgary').id, created_by: 'user:boss', source: 'portal' });
    for (const who of [p.releaseManager, p.studioAdmin, p.viewer]) {
      assert.equal((await who.post(api, { repository: 'VaultLearningGames/private-game', id: '777' })).status, 403);
      assert.equal((await who.post(`${api}/remove`, { id: '555' })).status, 403);
    }
    assert.equal((await p.signedOut.post(api, { repository: 'VaultLearningGames/private-game', id: '777' })).status, 401);
    assert.equal((await p.signedOut.post(`${api}/remove`, { id: '555' })).status, 401);
    assert.equal(db.repositoryBinding('777'), undefined);
    assert.ok(db.repositoryBinding('555'));
    assert.equal((await p.vaultAdmin.post(`${api}/remove`, { id: '555' })).status, 200);
    assert.equal(db.repositoryBinding('555'), undefined);
  });

  test('adding a public repository looks its id up on GitHub; the new repository then publishes for the studio; audited', async () => {
    const boss = as('boss', 'admin');
    const res = await boss.post('/portal/api/vault/studios/mit-education-arcade/repositories', { repository: 'https://github.com/vaultlearninggames/public-game.git' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, repository: 'VaultLearningGames/Public-Game', repository_id: '555' });
    const b = db.repositoryBinding('555')!;
    assert.deepEqual([b.repository, b.studio_id, b.source, b.created_by], ['VaultLearningGames/Public-Game', studio('mit-education-arcade').id, 'portal', 'user:boss']);
    const a = audits('studio.repository.add').find((x) => x.target === 'mit-education-arcade:VaultLearningGames/Public-Game')!;
    assert.equal(a.actor, 'user:boss');
    assert.deepEqual(JSON.parse(a.detail_json!), { repository_id: '555', checked_with_github: true });
    identities.publicGame = { ...base, repository: 'VaultLearningGames/Public-Game', repositoryId: '555' };
    assert.equal(await publish('publicGame', 'puzzle'), 'https://stg.test/mit-education-arcade/puzzle/main/');
    delete identities.publicGame;
  });

  test('a private repository needs its id typed; a typed id must agree with GitHub when GitHub can see the repository', async () => {
    const boss = as('boss', 'admin');
    const missing = await boss.post(api, { repository: 'VaultLearningGames/private-game' });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as any).error, /If it is private, type its repository id/);
    assert.equal((await boss.post(api, { repository: 'VaultLearningGames/private-game', id: '777' })).status, 200);
    assert.deepEqual([db.repositoryBinding('777')!.repository, db.repositoryBinding('777')!.studio_id], ['VaultLearningGames/private-game', studio('ucalgary').id]);
    assert.deepEqual(JSON.parse(audits('studio.repository.add').find((x) => x.target === 'ucalgary:VaultLearningGames/private-game')!.detail_json!), { repository_id: '777', checked_with_github: false });
    const wrong = await boss.post(api, { repository: 'VaultLearningGames/public-game', id: '556' });
    assert.equal(wrong.status, 400);
    assert.match(((await wrong.json()) as any).error, /id is 555, not 556/);
    assert.equal(db.repositoryBinding('556'), undefined);
    // GitHub unreachable: refused without an id, accepted with one.
    githubDown = true;
    assert.equal((await boss.post(api, { repository: 'VaultLearningGames/public-game' })).status, 503);
    assert.equal((await boss.post(api, { repository: 'VaultLearningGames/public-game', id: '555' })).status, 200);
  });

  test('a repository publishes for one studio only; bad input is refused', async () => {
    const boss = as('boss', 'admin');
    const taken = await boss.post('/portal/api/vault/studios/vault/repositories', { repository: TQ.name });
    assert.equal(taken.status, 409);
    assert.match(((await taken.json()) as any).error, /already publishes for University of Calgary \(set in studios\.json\)/);
    assert.equal((await boss.post(api, { repository: TQ.name })).status, 409);
    assert.equal(db.studioByRepositoryId(TQ.id)!.slug, 'ucalgary');
    for (const body of [{}, { repository: 'no-slash' }, { repository: 'a/b/c' }, { repository: 'a/b', id: 'abc' }, { repository: 'a/b', id: '-1' }, { repository: '../x', id: '1' }]) {
      assert.equal((await boss.post(api, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await boss.post('/portal/api/vault/studios/nope/repositories', { repository: 'a/b', id: '1' })).status, 404);
  });

  test('removing: only this studio’s portal assignments; studios.json ones are changed in the file; audited', async () => {
    const boss = as('boss', 'admin');
    await boss.post(api, { repository: 'VaultLearningGames/public-game' });
    assert.equal((await boss.post('/portal/api/vault/studios/vault/repositories/remove', { id: '555' })).status, 404);   // another studio's
    assert.equal((await boss.post(`${api}/remove`, { id: '999999' })).status, 404);
    const fromFile = await boss.post(`${api}/remove`, { id: TQ.id });
    assert.equal(fromFile.status, 409);
    assert.match(((await fromFile.json()) as any).error, /studios\.json/);
    assert.ok(db.repositoryBinding(TQ.id));
    assert.equal((await boss.post(`${api}/remove`, { id: '555' })).status, 200);
    assert.equal(db.repositoryBinding('555'), undefined);
    assert.equal(audits('studio.repository.remove').filter((x) => x.target === 'ucalgary:VaultLearningGames/Public-Game' && x.actor === 'user:boss').length, 1);
  });

  test('deleting a studio removes its repository assignments with it', async () => {
    const boss = as('boss', 'admin');
    assert.equal((await boss.post('/portal/api/vault/studios', { name: 'Tiny Studio', slug: 'tiny', website: '', github: '' })).status, 200);
    assert.equal((await boss.post('/portal/api/vault/studios/tiny/repositories', { repository: 'VaultLearningGames/public-game' })).status, 200);
    assert.equal((await boss.post('/portal/api/vault/studios/tiny/delete')).status, 200);
    assert.equal(db.repositoryBinding('555'), undefined);
    assert.equal(db.studioBySlug('tiny'), undefined);
  });
});
