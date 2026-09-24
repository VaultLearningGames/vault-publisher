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
  syncStudios(studios: Omit<Studio, 'id'>[]) {
    const upsert = this.sqlite.prepare(`
      INSERT INTO studios (slug, name, github_owner, github_owner_id, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (slug) DO UPDATE SET name = excluded.name, github_owner = excluded.github_owner,
        github_owner_id = excluded.github_owner_id`);
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

  audit(actor: string, action: string, target: string, detail?: unknown) {
    this.sqlite
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(now(), actor, action, target, detail === undefined ? null : JSON.stringify(detail));
  }
}
