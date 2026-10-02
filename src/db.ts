import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RefType } from './paths.ts';
import type { ListingFields } from './listings.ts';
import type { GameCheck, GameCheckRun } from './game-checks.ts';

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
  // v5: small key/value settings (e.g. one-time storage migrations).
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // v6: site listings. Studios edit draft_json; Vault publishes it to published_json, which the site is built from.
  // review: 'editing' (the studio is working on it), 'submitted' (waiting for Vault) or 'returned' (sent back).
  `
  CREATE TABLE listings (
    id              INTEGER PRIMARY KEY,
    studio_id       INTEGER NOT NULL REFERENCES studios(id),
    slug            TEXT NOT NULL UNIQUE,
    draft_json      TEXT NOT NULL,
    published_json  TEXT,
    review          TEXT NOT NULL DEFAULT 'editing' CHECK (review IN ('editing', 'submitted', 'returned')),
    review_note     TEXT,
    submitted_by    TEXT,
    submitted_at    TEXT,
    published_by    TEXT,
    published_at    TEXT,
    updated_by      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  `,
  // v7: a site listing is hosted on its linked CDN game once it has a release (several listings can share one CDN game,
  // each in its own folder, e.g. The Yard). Games Vault uploads for a studio (before the studio's own CI publishes)
  // have repository '' and repository_id 'vault:STUDIO/GAME' until a repository claims them.
  `
  ALTER TABLE listings ADD COLUMN game_id INTEGER REFERENCES games(id);
  CREATE INDEX listings_game ON listings (game_id);
  `,
  // v8: game availability checks (check-games.yml posts one run a day): whether each site game still loads.
  `
  CREATE TABLE game_checks (
    id           INTEGER PRIMARY KEY,
    checked_at   TEXT NOT NULL,
    source       TEXT,
    site         TEXT NOT NULL,
    ok_count     INTEGER NOT NULL,
    warn_count   INTEGER NOT NULL,
    fail_count   INTEGER NOT NULL,
    results_json TEXT NOT NULL,
    posted_by    TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  `,
  // v9: each studio's own website, published in /v1/catalog so the site can link a game's maker to it.
  // NULL: never set (studio-websites.json may fill it in); '': cleared in the portal (the file leaves it alone).
  `
  ALTER TABLE studios ADD COLUMN website TEXT;
  `,
  // v10: how each studio was created: 'file' (studios.json, which stays authoritative for the studios it lists),
  // 'import' (the site listing import) or 'portal' (a Vault admin). NULL: from before v10 and not in studios.json.
  `
  ALTER TABLE studios ADD COLUMN source TEXT;
  UPDATE studios SET source = 'import' WHERE slug IN (SELECT target FROM audit_log WHERE action = 'studio.create');
  `,
  // v11: a Vault role given to someone before they first sign in; applied (and removed) at their first sign-in.
  `
  CREATE TABLE vault_invites (
    github_login TEXT PRIMARY KEY COLLATE NOCASE,
    vault_role   TEXT NOT NULL CHECK (vault_role IN ('release_manager', 'admin')),
    added_by     TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  `,
  // v12: withdrawn. It gave MIT Education Arcade the VaultLearningGames organization's GitHub id, but that id is
  // unique and already belongs to the "vault" studio wherever that studio exists, so the statement failed and the
  // service could not start (staging, 2026-10-01). One organization can't stand for several studios; see v13.
  `
  SELECT 1;
  `,
  // v13: undo v12 where it did apply (databases created while it was in place).
  `
  UPDATE studios SET github_owner_id = 'vault:mit-education-arcade', github_owner = ''
  WHERE slug = 'mit-education-arcade' AND github_owner_id = '214136763';
  `,
  // v14: a single repository assigned to a studio, for an organization whose repositories belong to several studios
  // (VaultLearningGames hosts other studios' games). A repository listed here publishes for that studio whatever
  // its owner; every other repository still goes by its owner (studios.github_owner_id). repository_id is GitHub's
  // numeric repository id (it survives renames); repository is "owner/name", for display only.
  // source: 'file' (studios.json, which stays authoritative for the repositories it lists) or 'portal' (a Vault admin).
  `
  CREATE TABLE studio_repositories (
    repository_id TEXT PRIMARY KEY,
    repository    TEXT NOT NULL,
    studio_id     INTEGER NOT NULL REFERENCES studios(id),
    created_at    TEXT NOT NULL,
    created_by    TEXT NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('file', 'portal'))
  );
  CREATE INDEX studio_repositories_studio ON studio_repositories (studio_id);
  `,
  // v15: URL monitors (url-monitor.ts). A studio registers the public address of a web build it already hosts; Vault
  // copies it into the game's test build `ref_name` when it changes. files_from: 'list' (the studio publishes a file
  // list at list_url) or 'crawl' (the files index.html links to). state_json remembers each copied file's size, hash,
  // ETag and Last-Modified, so the next check only downloads what changed. One monitor per game.
  `
  CREATE TABLE url_monitors (
    id              INTEGER PRIMARY KEY,
    game_id         INTEGER NOT NULL UNIQUE REFERENCES games(id),
    url             TEXT NOT NULL,
    files_from      TEXT NOT NULL CHECK (files_from IN ('list', 'crawl')),
    list_url        TEXT,
    ref_name        TEXT NOT NULL,
    state_json      TEXT NOT NULL,
    last_checked_at TEXT,
    last_changed_at TEXT,
    last_status     TEXT CHECK (last_status IN ('changed', 'unchanged', 'error')),
    last_message    TEXT,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  `,
];

export interface Listing {
  id: number;
  studio_id: number;
  slug: string;
  game_id: number | null;
  draft: ListingFields;
  published: ListingFields | null;
  review: 'editing' | 'submitted' | 'returned';
  review_note: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  published_by: string | null;
  published_at: string | null;
  updated_by: string;
  updated_at: string;
}

export interface Studio {
  id: number;
  slug: string;
  name: string;
  github_owner: string;
  github_owner_id: string;
  website?: string | null;
  source?: StudioSource | null;
}

export type StudioSource = 'file' | 'import' | 'portal';

// A repository assigned to a studio: it publishes for that studio whatever organization owns it.
export interface StudioRepository {
  repository_id: string;
  repository: string;
  studio_id: number;
  created_at: string;
  created_by: string;
  source: 'file' | 'portal';
}
// studios.json: one studio's "repositories" entries.
export interface StudioRepositoriesFile { slug: string; repositories?: unknown }
export interface RepositorySyncResult { bound: string[]; removed: string[]; skipped: string[] }
// "owner/name" as GitHub writes it, and GitHub's numeric repository id as text.
export const REPOSITORY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const REPOSITORY_ID = /^[1-9][0-9]{0,18}$/;

// What keeps a studio from being removed: its CDN games (with their builds, releases and requests) and its site
// listings, in any state. Members are not a blocker: they go with the studio.
export interface StudioRemovalBlockers { games: number; listings: number }
export class StudioNotFoundError extends Error {
  constructor(studioId: number) { super(`no studio with id ${studioId}`); }
}
export class StudioNotEmptyError extends Error {
  readonly blockers: StudioRemovalBlockers;
  constructor(blockers: StudioRemovalBlockers) {
    const parts: string[] = [];
    if (blockers.games) parts.push(`${blockers.games} CDN game${blockers.games === 1 ? '' : 's'}`);
    if (blockers.listings) parts.push(`${blockers.listings} site listing${blockers.listings === 1 ? '' : 's'}`);
    super(`the studio still has ${parts.join(' and ')}; remove those first`);
    this.blockers = blockers;
  }
}
// The studio, the rows that go with it and everything the caller needs to know it was safe.
export interface RemoveStudioResult {
  dryRun: boolean;
  studio: Studio;
  // Every membership row removed (dry run: that would be removed).
  memberships: Membership[];
  // Every repository assignment removed with it (dry run: that would be removed).
  repositories: StudioRepository[];
  // Other studios carrying the same GitHub owner id. Their rows are never touched by a removal: the delete is
  // scoped to the studio's own id, and this system keeps no other org-scoped records to revoke.
  sharedWith: Studio[];
  warnings: string[];
}

export interface StudioSummary extends Studio {
  cdn_games: number;
  listings: number;
  members: number;
  invited: number;
}

const MAX_WEBSITE = 300;
// A studio website as typed in the portal or studio-websites.json: an absolute http(s) URL, trimmed. Empty means
// "no website" (null). Throws with a message for the person typing it.
export function studioWebsite(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  if (s.length > MAX_WEBSITE) throw new Error(`The website address is too long (at most ${MAX_WEBSITE} characters).`);
  let url: URL | null = null;
  try { url = new URL(s); } catch { /* not a URL */ }
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname || /\s/.test(s) || url.username || url.password) {
    throw new Error('The website must be a full address starting with https:// (or http://).');
  }
  return s;
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

export interface GameCheckRow {
  id: number;
  checked_at: string;
  source: string | null;
  site: string;
  ok_count: number;
  warn_count: number;
  fail_count: number;
  posted_by: string;
  created_at: string;
}

export interface StaleBuild {
  build_id: number;
  studio_slug: string;
  game_slug: string;
  ref_name: string;
}

const now = () => new Date().toISOString();
const GAME_CHECKS_KEPT = 120;

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

  // studios.json is the source of truth for the studios it lists (which GitHub orgs may publish). A studio is identified
  // by its GitHub owner id, so changing its slug in studios.json renames it in place (its games stay attached). Studios
  // that only get content through Vault have no GitHub org; they use a placeholder id like "vault:ucalgary" that can
  // never match a real (numeric) GitHub id. Studios the file doesn't list (created in the portal or by the listing
  // import) are never changed or deleted; an entry whose slug is already another studio's is skipped and returned.
  syncStudios(studios: Omit<Studio, 'id'>[], source: StudioSource = 'file'): { skipped: string[] } {
    const upsert = this.sqlite.prepare(`
      INSERT INTO studios (slug, name, github_owner, github_owner_id, created_at, source) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (github_owner_id) DO UPDATE SET slug = excluded.slug, name = excluded.name,
        github_owner = excluded.github_owner, source = excluded.source`);
    const bySlug = this.sqlite.prepare('SELECT github_owner_id FROM studios WHERE slug = ?');
    const skipped: string[] = [];
    for (const s of studios) {
      const taken = bySlug.get(s.slug) as { github_owner_id: string } | undefined;
      if (taken && taken.github_owner_id !== s.github_owner_id) { skipped.push(s.slug); continue; }
      upsert.run(s.slug, s.name, s.github_owner, s.github_owner_id, now(), source);
    }
    return { skipped };
  }

  // A studio a Vault admin creates in the portal. The caller checks that the slug and owner id are free.
  createStudio(s: Omit<Studio, 'id' | 'source'>): Studio {
    this.sqlite.prepare(`INSERT INTO studios (slug, name, github_owner, github_owner_id, website, created_at, source) VALUES (?, ?, ?, ?, ?, ?, 'portal')`)
      .run(s.slug, s.name, s.github_owner, s.github_owner_id, s.website ?? null, now());
    return this.studioBySlug(s.slug)!;
  }

  updateStudio(id: number, s: Pick<Studio, 'name' | 'github_owner' | 'github_owner_id'>) {
    this.sqlite.prepare('UPDATE studios SET name = ?, github_owner = ?, github_owner_id = ? WHERE id = ?').run(s.name, s.github_owner, s.github_owner_id, id);
  }

  // Remove a studio by its own primary key, never by GitHub owner id: a studio that shares its owner id with
  // anything else (another studio, the organization the publisher's repositories belong to) loses only its own rows.
  // Refused while the studio still owns CDN games or site listings; its members are removed with it. The audit row
  // keeps what was removed. dryRun snapshots every row that would go without writing anything.
  removeStudio(id: number, opts: { dryRun?: boolean; actor: string }): RemoveStudioResult {
    const studio = this.studioById(id);
    if (!studio) throw new StudioNotFoundError(id);
    const sharedWith = this.sqlite
      .prepare('SELECT * FROM studios WHERE github_owner_id = ? AND id <> ? ORDER BY id')
      .all(studio.github_owner_id, id) as unknown as Studio[];
    const warnings: string[] = [];
    if (sharedWith.length)
      warnings.push(`GitHub owner id ${studio.github_owner_id} is also registered to ${sharedWith.map((s) => s.name).join(', ')}; only this studio's own rows are removed.`);
    if (studio.source === 'file')
      warnings.push('This studio is listed in studios.json; it is created again at the next startup unless that entry is removed.');
    this.sqlite.exec('BEGIN');
    try {
      const games = Number((this.sqlite.prepare('SELECT COUNT(*) AS n FROM games WHERE studio_id = ?').get(id) as { n: number }).n);
      const listings = Number((this.sqlite.prepare('SELECT COUNT(*) AS n FROM listings WHERE studio_id = ?').get(id) as { n: number }).n);
      if (games || listings) throw new StudioNotEmptyError({ games, listings });
      const memberships = this.memberships(id);
      const repositories = this.studioRepositories(id);
      if (repositories.some((r) => r.source === 'file'))
        warnings.push('studios.json assigns repositories to this studio; they stop publishing for it until the studio is created again.');
      if (opts.dryRun) {
        this.sqlite.exec('ROLLBACK');
        return { dryRun: true, studio, memberships, repositories, sharedWith, warnings };
      }
      // Builds, uploads, releases and release requests all hang off games, which the guard above ruled out.
      for (const m of memberships) this.removeMembership(m.studio_id, m.github_login);
      this.sqlite.prepare('DELETE FROM studio_repositories WHERE studio_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM studios WHERE id = ?').run(id);
      this.audit(opts.actor, 'studio.delete', studio.slug, {
        name: studio.name, github: studio.github_owner || null, github_owner_id: studio.github_owner_id,
        members_removed: memberships.length, repositories_removed: repositories.map((r) => r.repository), shared_owner_id_with: sharedWith.map((s) => s.slug), warnings,
      });
      this.sqlite.exec('COMMIT');
      return { dryRun: false, studio, memberships, repositories, sharedWith, warnings };
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  // Every studio with its counts, for Vault's Studios page. Members have signed in; invited people haven't yet.
  studioSummaries(): StudioSummary[] {
    return this.sqlite.prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM games g WHERE g.studio_id = s.id) AS cdn_games,
        (SELECT COUNT(*) FROM listings l WHERE l.studio_id = s.id) AS listings,
        (SELECT COUNT(*) FROM memberships m WHERE m.studio_id = s.id AND EXISTS (SELECT 1 FROM users u WHERE u.login = m.github_login COLLATE NOCASE)) AS members,
        (SELECT COUNT(*) FROM memberships m WHERE m.studio_id = s.id AND NOT EXISTS (SELECT 1 FROM users u WHERE u.login = m.github_login COLLATE NOCASE)) AS invited
      FROM studios s ORDER BY s.name COLLATE NOCASE`).all() as unknown as StudioSummary[];
  }

  // Set (or clear, with null) a studio's website from the portal. Cleared is stored as '' so studio-websites.json
  // doesn't fill it in again.
  setStudioWebsite(studioId: number, website: string | null) {
    this.sqlite.prepare('UPDATE studios SET website = ? WHERE id = ?').run(website ?? '', studioId);
  }

  // studio-websites.json ({ "slug": "https://…" }): fills in websites for studios that exist and have never had one
  // set, so edits in the portal always win. Returns the slugs it set and the entries it skipped as invalid.
  seedStudioWebsites(websites: Record<string, unknown>): { set: string[]; invalid: string[] } {
    const out = { set: [] as string[], invalid: [] as string[] };
    const update = this.sqlite.prepare('UPDATE studios SET website = ? WHERE slug = ? AND website IS NULL');
    for (const [slug, v] of Object.entries(websites)) {
      let url: string | null;
      try { url = studioWebsite(v); } catch { url = null; }
      if (!url) { out.invalid.push(slug); continue; }
      if (update.run(url, slug).changes) out.set.push(slug);
    }
    return out;
  }

  studioByOwnerId(ownerId: string): Studio | undefined {
    // Deterministic if the unique owner id ever covers more than one studio: the oldest wins, and the ambiguity is
    // logged, so a lookup can never depend on row order or silently resolve to the wrong studio.
    const rows = this.sqlite
      .prepare('SELECT * FROM studios WHERE github_owner_id = ? ORDER BY created_at, id')
      .all(ownerId) as unknown as Studio[];
    if (rows.length > 1) console.error(`studios: ${rows.length} studios share GitHub owner id ${ownerId}; resolving to ${rows[0].slug}`);
    return rows[0];
  }

  // ----- repositories assigned to a studio -----
  repositoryBinding(repositoryId: string): StudioRepository | undefined {
    return this.sqlite.prepare('SELECT * FROM studio_repositories WHERE repository_id = ?').get(repositoryId) as StudioRepository | undefined;
  }

  // The studio a repository is assigned to, if any. Publishing checks this before the repository's owner.
  studioByRepositoryId(repositoryId: string): Studio | undefined {
    return this.sqlite
      .prepare('SELECT s.* FROM studios s JOIN studio_repositories r ON r.studio_id = s.id WHERE r.repository_id = ?')
      .get(repositoryId) as Studio | undefined;
  }

  studioRepositories(studioId: number): StudioRepository[] {
    return this.sqlite
      .prepare('SELECT * FROM studio_repositories WHERE studio_id = ? ORDER BY repository COLLATE NOCASE')
      .all(studioId) as unknown as StudioRepository[];
  }

  // Assign a repository to a studio (or move it, or rename it). The caller decides whether that's allowed.
  bindRepository(b: Omit<StudioRepository, 'created_at'>) {
    this.sqlite
      .prepare(`INSERT INTO studio_repositories (repository_id, repository, studio_id, created_at, created_by, source) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (repository_id) DO UPDATE SET repository = excluded.repository, studio_id = excluded.studio_id,
                  created_by = excluded.created_by, source = excluded.source`)
      .run(b.repository_id, b.repository, b.studio_id, now(), b.created_by, b.source);
  }

  // GitHub's own name for the repository (from its publishing token), which follows renames and transfers.
  renameBoundRepository(repositoryId: string, repository: string) {
    this.sqlite.prepare('UPDATE studio_repositories SET repository = ? WHERE repository_id = ?').run(repository, repositoryId);
  }

  unbindRepository(repositoryId: string) {
    this.sqlite.prepare('DELETE FROM studio_repositories WHERE repository_id = ?').run(repositoryId);
  }

  // studios.json's "repositories" ([{ "name": "owner/name", "id": "123" }] per studio), synced at startup. The file is
  // authoritative for the repositories it lists: each is assigned to its studio, and an assignment the file made
  // earlier and no longer lists is removed. Assignments made in the portal are never deleted, and a repository the
  // portal assigned to another studio stays there (the file's entry is skipped). Nothing here throws: every entry
  // that can't be applied is returned in `skipped` with the reason, so a bad entry can never stop the service starting.
  syncStudioRepositories(studios: StudioRepositoriesFile[]): RepositorySyncResult {
    const out: RepositorySyncResult = { bound: [], removed: [], skipped: [] };
    const listed = new Map<string, string>(); // repository id → the studio slug that listed it first
    for (const s of studios) {
      if (s.repositories === undefined) continue;
      if (!Array.isArray(s.repositories)) { out.skipped.push(`${s.slug}: "repositories" must be a list`); continue; }
      for (const entry of s.repositories) {
        const { name, id: rawId } = (entry ?? {}) as { name?: unknown; id?: unknown };
        const id = typeof rawId === 'number' ? String(rawId) : rawId;
        const label = `${s.slug}: ${typeof name === 'string' ? name : JSON.stringify(entry)}`;
        try {
          if (typeof name !== 'string' || !REPOSITORY_NAME.test(name)) { out.skipped.push(`${label}: "name" must be OWNER/NAME`); continue; }
          if (typeof id !== 'string' || !REPOSITORY_ID.test(id)) { out.skipped.push(`${label}: "id" must be GitHub's numeric repository id`); continue; }
          const first = listed.get(id);
          if (first !== undefined) { out.skipped.push(`${label}: repository id ${id} is already listed under ${first}`); continue; }
          listed.set(id, s.slug);
          const studio = this.studioBySlug(s.slug);
          if (!studio) { out.skipped.push(`${label}: there is no studio ${s.slug}`); continue; }
          const existing = this.repositoryBinding(id);
          if (existing && existing.source === 'portal' && existing.studio_id !== studio.id) {
            out.skipped.push(`${label}: repository id ${id} was assigned to ${this.studioById(existing.studio_id)?.slug ?? `studio ${existing.studio_id}`} in the portal; remove it there first`);
            continue;
          }
          if (existing && existing.source === 'file' && existing.studio_id === studio.id && existing.repository === name) continue;
          this.bindRepository({ repository_id: id, repository: name, studio_id: studio.id, created_by: 'studios.json', source: 'file' });
          this.audit('studios.json', 'studio.repository.add', `${studio.slug}:${name}`, { repository_id: id, from: existing ? this.studioById(existing.studio_id)?.slug ?? null : null });
          out.bound.push(`${studio.slug}: ${name}`);
        } catch (err) {
          out.skipped.push(`${label}: ${(err as Error).message}`);
        }
      }
    }
    try {
      const fromFile = this.sqlite.prepare(`SELECT r.*, s.slug AS studio_slug FROM studio_repositories r JOIN studios s ON s.id = r.studio_id WHERE r.source = 'file'`)
        .all() as unknown as (StudioRepository & { studio_slug: string })[];
      for (const r of fromFile) {
        if (listed.has(r.repository_id)) continue;
        this.unbindRepository(r.repository_id);
        this.audit('studios.json', 'studio.repository.remove', `${r.studio_slug}:${r.repository}`, { repository_id: r.repository_id });
        out.removed.push(`${r.studio_slug}: ${r.repository}`);
      }
    } catch (err) {
      out.skipped.push(`removing repositories studios.json no longer lists: ${(err as Error).message}`);
    }
    return out;
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

  setting(key: string): string | undefined {
    return (this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string) {
    this.sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // Every release with its game's storage prefix, for storage migrations.
  allReleases(): { gamePrefix: string; version: string; current: boolean }[] {
    return (this.sqlite.prepare(`SELECT s.slug || '/' || g.slug || '/' AS gamePrefix, r.version, (g.current_release_id = r.id) AS current
      FROM releases r JOIN games g ON g.id = r.game_id JOIN studios s ON s.id = g.studio_id ORDER BY r.id`).all() as unknown as { gamePrefix: string; version: string; current: number }[])
      .map((r) => ({ ...r, current: !!r.current }));
  }

  // Withdraw (by + note) or restore (null) a release.
  setWithdrawn(releaseId: number, by: string | null, note: string | null) {
    this.sqlite.prepare('UPDATE releases SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_note = ? WHERE id = ?')
      .run(by ? now() : null, by, by ? note : null, releaseId);
  }

  // Removes a CDN game and everything recorded about it (test versions, releases, requests, uploads, its URL monitor). Site listings
  // that played from it stay, unlinked. The caller deletes its files from the buckets first.
  deleteGame(gameId: number) {
    this.sqlite.exec('BEGIN');
    try {
      this.sqlite.prepare('UPDATE listings SET game_id = NULL WHERE game_id = ?').run(gameId);
      this.sqlite.prepare('UPDATE games SET current_release_id = NULL WHERE id = ?').run(gameId);
      for (const table of ['release_requests', 'uploads', 'builds', 'releases', 'url_monitors']) this.sqlite.prepare(`DELETE FROM ${table} WHERE game_id = ?`).run(gameId);
      this.sqlite.prepare('DELETE FROM games WHERE id = ?').run(gameId);
      this.sqlite.exec('COMMIT');
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
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

  // Vault roles waiting for someone's first sign-in.
  vaultInvites(): { github_login: string; vault_role: VaultRole; added_by: string; created_at: string }[] {
    return this.sqlite.prepare('SELECT * FROM vault_invites ORDER BY github_login COLLATE NOCASE').all() as unknown as
      { github_login: string; vault_role: VaultRole; added_by: string; created_at: string }[];
  }
  setVaultInvite(login: string, role: VaultRole, by: string) {
    if (role === 'none') this.sqlite.prepare('DELETE FROM vault_invites WHERE github_login = ?').run(login);
    else this.sqlite.prepare(`INSERT INTO vault_invites (github_login, vault_role, added_by, created_at) VALUES (?, ?, ?, ?)
                              ON CONFLICT (github_login) DO UPDATE SET vault_role = excluded.vault_role, added_by = excluded.added_by`)
      .run(login, role, by, now());
  }
  // Removes and returns the Vault role waiting for this login, if any.
  takeVaultInvite(login: string): VaultRole | undefined {
    const row = this.sqlite.prepare('SELECT vault_role FROM vault_invites WHERE github_login = ?').get(login) as { vault_role: VaultRole } | undefined;
    if (row) this.sqlite.prepare('DELETE FROM vault_invites WHERE github_login = ?').run(login);
    return row?.vault_role;
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

  // Every membership with its studio, for Vault's People page.
  allMemberships(): (Membership & { studio_slug: string; studio_name: string })[] {
    return this.sqlite
      .prepare(`SELECT m.*, s.slug AS studio_slug, s.name AS studio_name FROM memberships m JOIN studios s ON s.id = m.studio_id
                ORDER BY m.github_login COLLATE NOCASE, s.name`)
      .all() as unknown as (Membership & { studio_slug: string; studio_name: string })[];
  }

  // A studio's admins who have signed in at least once (invited admins don't count: they may never arrive).
  signedInAdmins(studioId: number): string[] {
    return (this.sqlite.prepare(`SELECT m.github_login FROM memberships m WHERE m.studio_id = ? AND m.role = 'admin'
        AND EXISTS (SELECT 1 FROM users u WHERE u.login = m.github_login COLLATE NOCASE)`).all(studioId) as { github_login: string }[])
      .map((r) => r.github_login);
  }

  userByLogin(login: string): User | undefined {
    return this.sqlite.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').get(login) as User | undefined;
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

  // ---------- site listings ----------
  private listingRow(r: Record<string, unknown> | undefined): (Listing & { studio_slug: string; studio_name: string; studio_website: string | null }) | undefined {
    if (!r) return undefined;
    const { draft_json, published_json, ...rest } = r as Record<string, unknown> & { draft_json: string; published_json: string | null };
    return { ...(rest as unknown as Listing & { studio_slug: string; studio_name: string; studio_website: string | null }), draft: JSON.parse(draft_json), published: published_json ? JSON.parse(published_json) : null };
  }
  private readonly LISTING_SELECT = `SELECT l.*, s.slug AS studio_slug, s.name AS studio_name, s.website AS studio_website FROM listings l JOIN studios s ON s.id = l.studio_id`;

  createListing(studioId: number, slug: string, draft: ListingFields, by: string) {
    const t = now();
    this.sqlite.prepare(`INSERT INTO listings (studio_id, slug, draft_json, updated_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(studioId, slug, JSON.stringify(draft), by, t, t);
    return this.listing(slug)!;
  }

  listing(slug: string) {
    return this.listingRow(this.sqlite.prepare(`${this.LISTING_SELECT} WHERE l.slug = ?`).get(slug) as Record<string, unknown> | undefined);
  }

  listings(filter: { studioId?: number; review?: string; published?: boolean } = {}) {
    const where: string[] = [], args: (string | number)[] = [];
    if (filter.studioId !== undefined) { where.push('l.studio_id = ?'); args.push(filter.studioId); }
    if (filter.review) { where.push('l.review = ?'); args.push(filter.review); }
    if (filter.published) where.push('l.published_json IS NOT NULL');
    const rows = this.sqlite.prepare(`${this.LISTING_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.slug`).all(...args);
    return rows.map((r) => this.listingRow(r as Record<string, unknown>)!);
  }

  linkListing(id: number, gameId: number | null) {
    this.sqlite.prepare('UPDATE listings SET game_id = ? WHERE id = ?').run(gameId, id);
  }

  // Vault admins move a site listing to another studio. Its CDN link is dropped (CDN games belong to a studio), and
  // the caller passes the draft/published fields to keep (e.g. "Made by" renamed to the new studio).
  moveListing(id: number, studioId: number, draft: ListingFields, published: ListingFields | null, by: string) {
    this.sqlite.prepare(`UPDATE listings SET studio_id = ?, game_id = NULL, draft_json = ?, published_json = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .run(studioId, JSON.stringify(draft), published ? JSON.stringify(published) : null, by, now(), id);
  }

  listingsForGame(gameId: number) {
    return this.sqlite.prepare(`${this.LISTING_SELECT} WHERE l.game_id = ? ORDER BY l.slug`).all(gameId).map((r) => this.listingRow(r as Record<string, unknown>)!);
  }

  // A studio's repository takes over a game Vault uploaded for it (repository_id 'vault:…').
  claimGame(gameId: number, repository: string, repositoryId: string) {
    this.sqlite.prepare('UPDATE games SET repository = ?, repository_id = ? WHERE id = ?').run(repository, repositoryId, gameId);
  }

  saveListingDraft(id: number, draft: ListingFields, by: string) {
    this.sqlite.prepare(`UPDATE listings SET draft_json = ?, updated_by = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(draft), by, now(), id);
  }

  setListingReview(id: number, review: 'editing' | 'submitted' | 'returned', by: string, note: string | null) {
    if (review === 'submitted') {
      this.sqlite.prepare(`UPDATE listings SET review = 'submitted', review_note = ?, submitted_by = ?, submitted_at = ? WHERE id = ?`).run(note, by, now(), id);
    } else {
      this.sqlite.prepare(`UPDATE listings SET review = ?, review_note = ? WHERE id = ?`).run(review, note, id);
    }
  }

  publishListing(id: number, by: string) {
    this.sqlite.prepare(`UPDATE listings SET published_json = draft_json, published_by = ?, published_at = ?, review = 'editing', review_note = NULL WHERE id = ?`)
      .run(by, now(), id);
  }

  unpublishListing(id: number) {
    this.sqlite.prepare(`UPDATE listings SET published_json = NULL, published_by = NULL, published_at = NULL WHERE id = ?`).run(id);
  }

  // ---------- game availability checks ----------
  // Keeps the most recent GAME_CHECKS_KEPT runs (a daily run is ~50 KB).
  addGameCheck(run: GameCheckRun, by: string): number {
    const res = this.sqlite
      .prepare(`INSERT INTO game_checks (checked_at, source, site, ok_count, warn_count, fail_count, results_json, posted_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.checked_at, run.source, run.site, run.counts.ok, run.counts.warn, run.counts.fail, JSON.stringify(run.games), by, now());
    this.sqlite.prepare('DELETE FROM game_checks WHERE id NOT IN (SELECT id FROM game_checks ORDER BY id DESC LIMIT ?)').run(GAME_CHECKS_KEPT);
    return Number(res.lastInsertRowid);
  }

  // Recent runs, newest first, without their per-game results.
  gameChecks(limit = 30): GameCheckRow[] {
    return this.sqlite.prepare(`SELECT id, checked_at, source, site, ok_count, warn_count, fail_count, posted_by, created_at
      FROM game_checks ORDER BY id DESC LIMIT ?`).all(limit) as unknown as GameCheckRow[];
  }

  // One run with its results; the latest when id is omitted.
  gameCheck(id?: number): (GameCheckRow & { games: GameCheck[] }) | undefined {
    const row = (id === undefined
      ? this.sqlite.prepare('SELECT * FROM game_checks ORDER BY id DESC LIMIT 1').get()
      : this.sqlite.prepare('SELECT * FROM game_checks WHERE id = ?').get(id)) as (GameCheckRow & { results_json: string }) | undefined;
    if (!row) return undefined;
    const { results_json, ...rest } = row;
    return { ...rest, games: JSON.parse(results_json) as GameCheck[] };
  }

  audit(actor: string, action: string, target: string, detail?: unknown) {
    this.sqlite
      .prepare('INSERT INTO audit_log (at, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
      .run(now(), actor, action, target, detail === undefined ? null : JSON.stringify(detail));
  }
}
