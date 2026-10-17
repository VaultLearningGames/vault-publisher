// The blog editor's autosaves: portal scratch storage, never committed. Posts live in the vault-site repository
// (blog/siteRepo.ts); an autosave is kept here until Save or Publish commits the post (which clears it), or the editor
// throws it away (reloading after a conflict, or deleting the post).
//
// One row per post, keyed by the post's slug in the repository (a new post's slug before its first commit). base_sha
// is the file's SHA the edits started from (null: a post not in the repository yet), so a later Save still makes the
// SHA check against what the editor loaded. The table is created on first use, IF NOT EXISTS; nothing else uses it.
import type { DatabaseSync } from 'node:sqlite';

export interface Scratch {
  slug: string;
  base_sha: string | null;
  // The editor's post fields as last autosaved (a parsed, validated BlogPostInput plus anything the editor keeps).
  data: Record<string, unknown>;
  updated_by: string;
  updated_at: string;
}

const ready = new WeakSet<DatabaseSync>();

export class BlogScratch {
  readonly sqlite: DatabaseSync;
  constructor(sqlite: DatabaseSync) {
    this.sqlite = sqlite;
    if (!ready.has(sqlite)) {
      sqlite.exec(`CREATE TABLE IF NOT EXISTS blog_scratch (
        slug       TEXT PRIMARY KEY,
        base_sha   TEXT,
        data_json  TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      ready.add(sqlite);
    }
  }

  get(slug: string): Scratch | undefined {
    const r = this.sqlite.prepare('SELECT * FROM blog_scratch WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(String(r.data_json)) as Record<string, unknown>; } catch { /* a broken row reads as empty */ }
    return { slug: String(r.slug), base_sha: (r.base_sha as string | null) ?? null, data, updated_by: String(r.updated_by), updated_at: String(r.updated_at) };
  }

  // Slugs with an autosave whose post isn't in the repository yet (new posts).
  newPosts(): Scratch[] {
    const rows = this.sqlite.prepare('SELECT slug FROM blog_scratch WHERE base_sha IS NULL ORDER BY updated_at DESC').all() as { slug: string }[];
    return rows.map((r) => this.get(r.slug)!).filter(Boolean);
  }

  has(slug: string): boolean {
    return !!this.sqlite.prepare('SELECT 1 FROM blog_scratch WHERE slug = ?').get(slug);
  }

  put(slug: string, baseSha: string | null, data: Record<string, unknown>, by: string): Scratch {
    const at = new Date().toISOString();
    this.sqlite.prepare(`INSERT INTO blog_scratch (slug, base_sha, data_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (slug) DO UPDATE SET base_sha = excluded.base_sha, data_json = excluded.data_json, updated_by = excluded.updated_by,
      updated_at = excluded.updated_at`).run(slug, baseSha, JSON.stringify(data), by, at);
    return { slug, base_sha: baseSha, data, updated_by: by, updated_at: at };
  }

  delete(slug: string): boolean {
    return Number(this.sqlite.prepare('DELETE FROM blog_scratch WHERE slug = ?').run(slug).changes) > 0;
  }
}
