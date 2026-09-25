import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RefType } from './paths.ts';

// Plain SQL with no SQLite-only features, so a later move to Postgres is a driver swap.
// Each entry is applied once, in order; PRAGMA user_version tracks progress.
const MIGRATIONS = [
  `
  CREATE TABLE studios (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    github_owner    TEXT NOT NULL,
    github_owner_id TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL
  );

  -- A game is claimed by the first repository that publishes it; only that repository
  -- (matched by numeric id, which survives renames) may publish or delete its builds.
  CREATE TABLE games (
    id            INTEGER PRIMARY KEY,
    studio_id     INTEGER NOT NULL REFERENCES studios(id),
    slug          TEXT NOT NULL,
    repository    TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (studio_id, slug)
  );

  -- One row per preview (branch or tag) on the staging CDN.
  CREATE TABLE builds (
    id          INTEGER PRIMARY KEY,
    game_id     INTEGER NOT NULL REFERENCES games(id),
    ref_name    TEXT NOT NULL,
    ref_type    TEXT NOT NULL CHECK (ref_type IN ('branch', 'tag')),
    commit_sha  TEXT NOT NULL,
    actor       TEXT NOT NULL,
    file_count  INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('live', 'deleted')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (game_id, ref_name)
  );

  -- An in-progress upload: presigned URLs were issued, finalize hasn't run yet.
  CREATE TABLE uploads (
    seq           INTEGER PRIMARY KEY,
    id            TEXT NOT NULL UNIQUE,
    game_id       INTEGER NOT NULL REFERENCES games(id),
    ref_name      TEXT NOT NULL,
    ref_type      TEXT NOT NULL,
    commit_sha    TEXT NOT NULL,
    actor         TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    finalized_at  TEXT
  );

  CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY,
    at          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT NOT NULL,
    detail_json TEXT
  );
  `,
  `
  -- Production releases: immutable copies of approved staging builds.
  CREATE TABLE releases (
    id          INTEGER PRIMARY KEY,
    game_id     INTEGER NOT NULL REFERENCES games(id),
    version     TEXT NOT NULL,
    source_ref  TEXT NOT NULL,
    commit_sha  TEXT,
    file_count  INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    UNIQUE (game_id, version)
  );

  -- The release players get at STUDIO/GAME/.
  ALTER TABLE games ADD COLUMN current_release_id INTEGER REFERENCES releases(id);
  ALTER TABLE games ADD COLUMN promoted_at TEXT;
  `,
  `
  -- People who sign in to the portal (with GitHub). vault_role is for Vault staff.
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    github_id     TEXT NOT NULL UNIQUE,
    login         TEXT NOT NULL,
    name          TEXT,
    avatar_url    TEXT,
    vault_role    TEXT NOT NULL DEFAULT 'none' CHECK (vault_role IN ('none', 'release_manager', 'admin')),
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  -- Studio membership by GitHub username, so people can be added before they first sign in.
  CREATE TABLE memberships (
    id           INTEGER PRIMARY KEY,
    studio_id    INTEGER NOT NULL REFERENCES studios(id),
    github_login TEXT NOT NULL COLLATE NOCASE,
    role         TEXT NOT NULL CHECK (role IN ('viewer', 'maintainer', 'admin')),
    added_by     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (studio_id, github_login)
  );

  -- A studio asks Vault to release one of its staging builds.
  CREATE TABLE release_requests (
    id            INTEGER PRIMARY KEY,
    game_id       INTEGER NOT NULL REFERENCES games(id),
    ref           TEXT NOT NULL,
    version       TEXT NOT NULL,
    notes         TEXT,
    status        TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'withdrawn')),
    requested_by  TEXT NOT NULL,
    decided_by    TEXT,
    decision_note TEXT,
    created_at    TEXT NOT NULL,
    decided_at    TEXT
  );
  `,
  // v4: studios switch between approved releases themselves; Vault can withdraw a release (never current again)
  // or freeze a game (only Vault can switch it, e.g. during a study).
  `
  ALTER TABLE releases ADD COLUMN withdrawn_at TEXT;
  ALTER TABLE releases ADD COLUMN withdrawn_by TEXT;
  ALTER TABLE releases ADD COLUMN withdrawn_note TEXT;
  ALTER TABLE games ADD COLUMN frozen_at TEXT;
  ALTER TABLE games ADD COLUMN frozen_by TEXT;
  ALTER TABLE games ADD COLUMN frozen_note TEXT;
  `,
];

export interface Studio {
  id: number;
  slug: string;
  name: string;
  github_owner: string;
  github_owner_id: string;
}

export interface Game {
  id: number;
  studio_id: number;
  slug: string;
  repository: string;
  repository_id: string;
  frozen_at?: string | null;
  frozen_by?: string | null;
  frozen_note?: string | null;
}

export interface ManifestFile {
  path: string;
  size: number;
}

export interface Upload {
  seq: number;
  id: string;
  game_id: number;
  ref_name: string;
  ref_type: RefType;
  commit_sha: string;
  actor: string;
  manifest: ManifestFile[];
  expires_at: string;
  finalized_at: string | null;
}

export interface Build {
  id: number;
  game_id: number;
  ref_name: string;
  ref_type: RefType;
  commit_sha: string;
  file_count: number;
  total_bytes: number;
  actor: string;
  status: 'live' | 'deleted';
  updated_at: string;
}

export interface Release {
  id: number;
  game_id: number;
  version: string;
  source_ref: string;
  commit_sha: string | null;
  file_count: number;
  total_bytes: number;
  approved_by: string;
  approved_at: string;
  withdrawn_at?: string | null;
  withdrawn_by?: string | null;
  withdrawn_note?: string | null;
}

export type VaultRole = 'none' | 'release_manager' | 'admin';
export type StudioRole = 'viewer' | 'maintainer' | 'admin';

export interface User {
  id: number;
  github_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
  vault_role: VaultRole;
  last_login_at: string | null;
}

export interface Membership {
  id: number;
  studio_id: number;
  github_login: string;
  role: StudioRole;
  added_by: string;
  created_at: string;
}

export interface ReleaseRequest {
  id: number;
  game_id: number;
  ref: string;
  version: string;
  notes: string | null;
  status: 'requested' | 'approved' | 'rejected' | 'withdrawn';
  requested_by: string;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface StaleBuild {
  build_id: number;
  studio_slug: string;
  game_slug: string;
  ref_name: string;
}

const now = () => new Date().toISOString();

export class Db {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    // WAL is required by Litestream; busy_timeout covers Litestream's brief checkpoint locks.
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const { user_version } = this.sqlite.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.sqlite.exec('BEGIN');
      try {
        this.sqlite.exec(MIGRATIONS[v]);
        this.sqlite.exec(`PRAGMA user_version = ${v + 1}`);
        this.sqlite.exec('COMMIT');
      } catch (err) {
        this.sqlite.exec('ROLLBACK');
        throw err;
      }
    }
  }

  // studios.json is the source of truth for which GitHub orgs may publish, until there's an admin UI.
  // A studio is identified by its GitHub owner id, so changing its slug in studios.json renames it in place
  // (its games stay attached). Studios that only get content through Vault have no GitHub org; they use a
  // placeholder id like "vault:ucalgary" that can never match a real (numeric) GitHub id.
  syncStudios(studios: Omit<Studio, 'id'>[]) {
    const upsert = this.sqlite.prepare(`
      INSERT INTO studios (slug, name, github_owner, github_owner_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (github_owner_id) DO UPDATE SET slug = excluded.slug, name = excluded.name,
        github_owner = excluded.github_owner`);
    for (const s of studios) upsert.run(s.slug, s.name, s.github_owner, s.github_owner_id, now());
  }

  studioByOwnerId(ownerId: string): Studio | undefined {
    return this.sqlite.prepare('SELECT * FROM studios WHERE github_owner_id = ?').get(ownerId) as Studio | undefined;
  }

  studioBySlug(slug: string): Studio | undefined {
    return this.sqlite.prepare('SELECT * FROM studios WHERE slug = ?').get(slug) as Studio | undefined;
  }

  studioById(id: number): Studio | undefined {
    return this.sqlite.prepare('SELECT * FROM studios WHERE id = ?').get(id) as Studio | undefined;
  }

  game(studioId: number, slug: string): Game | undefined {
    return this.sqlite.prepare('SELECT * FROM games WHERE studio_id = ? AND slug = ?').get(studioId, slug) as
      | Game
      | undefined;
  }

  gameById(id: number): Game | undefined {
    return this.sqlite.prepare('SELECT * FROM games WHERE id = ?').get(id) as Game | undefined;
  }

  createGame(studioId: number, slug: string, repository: string, repositoryId: string): Game {
    this.sqlite
      .prepare('INSERT INTO games (studio_id, slug, repository, repository_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(studioId, slug, repository, repositoryId, now());
    return this.game(studioId, slug)!;
  }

  createUpload(u: Omit<Upload, 'seq' | 'finalized_at'>) {
    this.sqlite
      .prepare(`INSERT INTO uploads (id, game_id, ref_name, ref_type, commit_sha, actor, manifest_json, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(u.id, u.game_id, u.ref_name, u.ref_type, u.commit_sha, u.actor, JSON.stringify(u.manifest), now(), u.expires_at);
  }

  upload(id: string): Upload | undefined {
    const row = this.sqlite.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as
      | (Omit<Upload, 'manifest'> & { manifest_json: string })
      | undefined;
    if (!row) return undefined;
    const { manifest_json, ...rest } = row;
    return { ...rest, manifest: JSON.parse(manifest_json) as ManifestFile[] };
  }

  // True if a later upload to the same preview has started; finalizing an older one would
  // delete the newer build's files as "stale".
  hasNewerUpload(u: Upload): boolean {
    return (
      this.sqlite
        .prepare('SELECT 1 FROM uploads WHERE game_id = ? AND ref_name = ? AND seq > ? LIMIT 1')
        .get(u.game_id, u.ref_name, u.seq) !== undefined
    );
  }

  markUploadFinalized(id: string) {
    this.sqlite.prepare('UPDATE uploads SET finalized_at = ? WHERE id = ?').run(now(), id);
  }

  deleteExpiredUploads(): number {
    return Number(this.sqlite.prepare('DELETE FROM uploads WHERE expires_at < ?').run(now()).changes);
  }

  upsertBuild(u: Upload, fileCount: number, totalBytes: number) {
    const t = now();
    this.sqlite
      .prepare(`
        INSERT INTO builds (game_id, ref_name, ref_type, commit_sha, actor, file_count, total_bytes, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)
        ON CONFLICT (game_id, ref_name) DO UPDATE SET ref_type = excluded.ref_type, commit_sha = excluded.commit_sha,
          actor = excluded.actor, file_count = excluded.file_count, total_bytes = excluded.total_bytes,
          status = 'live', updated_at = excluded.updated_at`)
      .run(u.game_id, u.ref_name, u.ref_type, u.commit_sha, u.actor, fileCount, totalBytes, t, t);
  }

  build(gameId: number, refName: string): Build | undefined {
    return this.sqlite.prepare('SELECT * FROM builds WHERE game_id = ? AND ref_name = ?').get(gameId, refName) as
      | Build
      | undefined;
  }

  markBuildDeleted(id: number) {
    this.sqlite.prepare("UPDATE builds SET status = 'deleted', updated_at = ? WHERE id = ?").run(now(), id);
  }

  // Branch previews not pushed since `cutoff`. Tags are release candidates and are kept.
  staleBranchBuilds(cutoff: string): StaleBuild[] {
    return this.sqlite
      .prepare(`
        SELECT b.id AS build_id, s.slug AS studio_slug, g.slug AS game_slug, b.ref_name
        FROM builds b JOIN games g ON g.id = b.game_id JOIN studios s ON s.id = g.studio_id
        WHERE b.status = 'live' AND b.ref_type = 'branch' AND b.updated_at < ?`)
      .all(cutoff) as unknown as StaleBuild[];
  }

  createRelease(r: Omit<Release, 'id' | 'approved_at'>): Release {
    this.sqlite
      .prepare(`INSERT INTO releases (game_id, version, source_ref, commit_sha, file_count, total_bytes, approved_by, approved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.game_id, r.version, r.source_ref, r.commit_sha, r.file_count, r.total_bytes, r.approved_by, now());
    return this.release(r.game_id, r.version)!;
  }

  release(gameId: number, version: string): Release | undefined {
    return this.sqlite.prepare('SELECT * FROM releases WHERE game_id = ? AND version = ?').get(gameId, version) as
      | Release
      | undefined;
  }

  releases(gameId: number): Release[] {
    return this.sqlite.prepare('SELECT * FROM releases WHERE game_id = ? ORDER BY id DESC').all(gameId) as unknown as Release[];
  }

  currentRelease(gameId: number): Release | undefined {
    return this.sqlite
      .prepare('SELECT r.* FROM releases r JOIN games g ON g.current_release_id = r.id WHERE g.id = ?')
      .get(gameId) as Release | undefined;
  }

  setCurrentRelease(gameId: number, releaseId: number) {
    this.sqlite.prepare('UPDATE games SET current_release_id = ?, promoted_at = ? WHERE id = ?').run(releaseId, now(), gameId);
  }

  // Withdraw (by + note) or restore (null) a release.
  setWithdrawn(releaseId: number, by: string | null, note: string | null) {
    this.sqlite.prepare('UPDATE releases SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_note = ? WHERE id = ?')
      .run(by ? now() : null, by, by ? note : null, releaseId);
  }

  // Freeze (by + note) or unfreeze (null) a game's current release.
  setFrozen(gameId: number, by: string | null, note: string | null) {
    this.sqlite.prepare('UPDATE games SET frozen_at = ?, frozen_by = ?, frozen_note = ? WHERE id = ?')
      .run(by ? now() : null, by, by ? note : null, gameId);
  }

  // ----- portal: studios, games, builds -----
  studios(): Studio[] {
    return this.sqlite.prepare('SELECT * FROM studios ORDER BY name').all() as unknown as Studio[];
  }

  gamesForStudio(studioId: number): Game[] {
    return this.sqlite.prepare('SELECT * FROM games WHERE studio_id = ? ORDER BY slug').all(studioId) as unknown as Game[];
  }

  liveBuilds(gameId: number): Build[] {
    return this.sqlite
      .prepare("SELECT * FROM builds WHERE game_id = ? AND status = 'live' ORDER BY updated_at DESC")
      .all(gameId) as unknown as Build[];
  }

  // ----- portal: users and roles -----
  upsertUser(u: { github_id: string; login: string; name: string | null; avatar_url: string | null }): User {
    this.sqlite
      .prepare(`INSERT INTO users (github_id, login, name, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (github_id) DO UPDATE SET login = excluded.login, name = excluded.name,
                  avatar_url = excluded.avatar_url, last_login_at = excluded.last_login_at`)
      .run(u.github_id, u.login, u.name, u.avatar_url, now(), now());
    return this.sqlite.prepare('SELECT * FROM users WHERE github_id = ?').get(u.github_id) as unknown as User;
  }

  userById(id: number): User | undefined {
    return this.sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  users(): User[] {
    return this.sqlite.prepare('SELECT * FROM users ORDER BY login COLLATE NOCASE').all() as unknown as User[];
  }

  setVaultRole(userId: number, role: VaultRole) {
    this.sqlite.prepare('UPDATE users SET vault_role = ? WHERE id = ?').run(role, userId);
  }

  memberships(studioId: number): Membership[] {
    return this.sqlite
      .prepare('SELECT * FROM memberships WHERE studio_id = ? ORDER BY github_login COLLATE NOCASE')
      .all(studioId) as unknown as Membership[];
  }

  membershipsForLogin(login: string): (Membership & { studio_slug: string; studio_name: string })[] {
    return this.sqlite
      .prepare(`SELECT m.*, s.slug AS studio_slug, s.name AS studio_name FROM memberships m JOIN studios s ON s.id = m.studio_id
                WHERE m.github_login = ? ORDER BY s.name`)
      .all(login) as unknown as (Membership & { studio_slug: string; studio_name: string })[];
  }

  roleIn(studioId: number, login: string): StudioRole | undefined {
    const row = this.sqlite.prepare('SELECT role FROM memberships WHERE studio_id = ? AND github_login = ?').get(studioId, login) as
      | { role: StudioRole }
      | undefined;
    return row?.role;
  }

  setMembership(studioId: number, login: string, role: StudioRole, addedBy: string) {
    this.sqlite
      .prepare(`INSERT INTO memberships (studio_id, github_login, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (studio_id, github_login) DO UPDATE SET role = excluded.role`)
      .run(studioId, login, role, addedBy, now());
  }

  removeMembership(studioId: number, login: string) {
    this.sqlite.prepare('DELETE FROM memberships WHERE studio_id = ? AND github_login = ?').run(studioId, login);
  }

  // ----- portal: release requests -----
  createReleaseRequest(r: { game_id: number; ref: string; version: string; notes: string | null; requested_by: string }): ReleaseRequest {
    const res = this.sqlite
      .prepare(`INSERT INTO release_requests (game_id, ref, version, notes, status, requested_by, created_at)
                VALUES (?, ?, ?, ?, 'requested', ?, ?)`)
      .run(r.game_id, r.ref, r.version, r.notes, r.requested_by, now());
    return this.releaseRequest(Number(res.lastInsertRowid))!;
  }

  releaseRequest(id: number): ReleaseRequest | undefined {
    return this.sqlite.prepare('SELECT * FROM release_requests WHERE id = ?').get(id) as ReleaseRequest | undefined;
  }

  releaseRequests(filter: { gameId?: number; status?: string }): (ReleaseRequest & { game_slug: string; studio_slug: string })[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.gameId !== undefined) { where.push('r.game_id = ?'); args.push(filter.gameId); }
    if (filter.status) { where.push('r.status = ?'); args.push(filter.status); }
    return this.sqlite
      .prepare(`SELECT r.*, g.slug AS game_slug, s.slug AS studio_slug FROM release_requests r
                JOIN games g ON g.id = r.game_id JOIN studios s ON s.id = g.studio_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.id DESC LIMIT 100`)
      .all(...args) as unknown as (ReleaseRequest & { game_slug: string; studio_slug: string })[];
  }

  decideReleaseRequest(id: number, status: 'approved' | 'rejected' | 'withdrawn', by: string, note: string | null) {
    this.sqlite
      .prepare("UPDATE release_requests SET status = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'requested'")
      .run(status, by, note, now(), id);
  }

  // A version released by any route (portal, Release workflow) satisfies open requests for it.
  closeRequestsForVersion(gameId: number, version: string, by: string) {
    this.sqlite
      .prepare("UPDATE release_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE game_id = ? AND version = ? AND status = 'requested'")
      .run(by, now(), gameId, version);
  }

  recentAudit(limit = 50): { at: string; actor: string; action: string; target: string }[] {
    return this.sqlite.prepare('SELECT at, actor, action, target FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as {
      at: string; actor: string; action: string; target: string;
    }[];
  }

  auditFor(actions: string[], limit = 10): { at: string; actor: string; action: string; target: string; detail_json: string | null }[] {
    return this.sqlite.prepare(`SELECT at, actor, action, target, detail_json FROM audit_log WHERE action IN (${actions.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`)
      .all(...actions, limit) as unknown as { at: string; actor: string; action: string; target: string; detail_json: string | null }[];
  }

  audit(actor: string, action: string, target: string, detail?: unknown) {
    this.sqlite
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(now(), actor, action, target, detail === undefined ? null : JSON.stringify(detail));
  }
}
