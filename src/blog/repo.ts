// SQL access for the blog. Join rows and redirects are removed explicitly inside the same transaction, so correctness
// doesn't depend on PRAGMA foreign_keys.
import type { DatabaseSync } from 'node:sqlite';
import type { Block } from './blocks.ts';
import { slugify, uniqueSlug } from './slug.ts';

export type BlogStatus = 'published' | 'private';
export interface BlogTag { slug: string; name: string }
export interface BlogPost {
  id: number; slug: string; title: string; blocks: Block[]; excerpt: string; featured_image: string | null; author: string;
  status: BlogStatus; published_at: string | null; created_at: string; updated_at: string; tags: BlogTag[]; redirects: string[];
}
export interface BlogPostInput {
  slug: string; title: string; blocks: Block[]; excerpt: string; featured_image: string | null; author: string;
  status: BlogStatus; published_at: string | null; tags: string[];
}

export class SlugTakenError extends Error {}

const now = () => new Date().toISOString();
// Now, but always after `prev`, so updated_at changes on every save (the editor's optimistic concurrency token).
const laterThan = (prev: string) => {
  const t = Date.now(), p = Date.parse(prev);
  return new Date(Number.isNaN(p) || t > p ? t : p + 1).toISOString();
};

export class BlogRepo {
  readonly sqlite: DatabaseSync;
  constructor(sqlite: DatabaseSync) { this.sqlite = sqlite; }

  private tx<T>(fn: () => T): T {
    this.sqlite.exec('BEGIN');
    try { const r = fn(); this.sqlite.exec('COMMIT'); return r; } catch (err) { this.sqlite.exec('ROLLBACK'); throw err; }
  }

  slugTaken(slug: string, exceptPostId?: number): boolean {
    return !!this.sqlite.prepare('SELECT 1 FROM blog_posts WHERE slug = ? AND id IS NOT ?').get(slug, exceptPostId ?? null);
  }
  // A slug no post uses and no redirect claims (for derived slugs).
  freeSlug(base: string): string {
    return uniqueSlug(base, (s) => this.slugTaken(s) || !!this.sqlite.prepare('SELECT 1 FROM blog_slug_redirects WHERE old_slug = ?').get(s));
  }

  private row(r: Record<string, unknown>): BlogPost {
    const id = Number(r.id);
    const tags = this.sqlite.prepare(`SELECT t.slug, t.name FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id
      WHERE pt.post_id = ? ORDER BY t.name`).all(id) as unknown as BlogTag[];
    const redirects = (this.sqlite.prepare('SELECT old_slug FROM blog_slug_redirects WHERE post_id = ? ORDER BY created_at, old_slug')
      .all(id) as { old_slug: string }[]).map((x) => x.old_slug);
    return {
      id, slug: String(r.slug), title: String(r.title), blocks: JSON.parse(String(r.blocks)) as Block[], excerpt: String(r.excerpt),
      featured_image: (r.featured_image as string | null) ?? null, author: String(r.author), status: r.status as BlogStatus,
      published_at: (r.published_at as string | null) ?? null, created_at: String(r.created_at), updated_at: String(r.updated_at), tags, redirects,
    };
  }

  list(status?: BlogStatus): BlogPost[] {
    const rows = (status
      ? this.sqlite.prepare('SELECT * FROM blog_posts WHERE status = ? ORDER BY COALESCE(published_at, created_at) DESC, id DESC').all(status)
      : this.sqlite.prepare('SELECT * FROM blog_posts ORDER BY COALESCE(published_at, created_at) DESC, id DESC').all()) as Record<string, unknown>[];
    return rows.map((r) => this.row(r));
  }
  get(id: number): BlogPost | undefined {
    const r = this.sqlite.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.row(r) : undefined;
  }
  bySlug(slug: string): BlogPost | undefined {
    const r = this.sqlite.prepare('SELECT * FROM blog_posts WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
    return r ? this.row(r) : undefined;
  }
  // The post an old slug now points at.
  redirectFor(oldSlug: string): BlogPost | undefined {
    const r = this.sqlite.prepare('SELECT post_id FROM blog_slug_redirects WHERE old_slug = ?').get(oldSlug) as { post_id: number } | undefined;
    return r ? this.get(Number(r.post_id)) : undefined;
  }

  // Up to `limit` existing tags whose name starts with `prefix`, case-insensitively, alphabetically.
  searchTags(prefix: string, limit = 10): BlogTag[] {
    const like = `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    return this.sqlite.prepare(`SELECT slug, name FROM blog_tags WHERE name LIKE ? ESCAPE '\\'
      ORDER BY name COLLATE NOCASE, slug LIMIT ?`).all(like, limit) as unknown as BlogTag[];
  }

  private setTags(postId: number, names: string[]) {
    this.sqlite.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(postId);
    for (const name of names) {
      const slug = slugify(name);
      if (!slug) continue;
      this.sqlite.prepare('INSERT INTO blog_tags (slug, name) VALUES (?, ?) ON CONFLICT (slug) DO NOTHING').run(slug, name);
      const tag = this.sqlite.prepare('SELECT id FROM blog_tags WHERE slug = ?').get(slug) as { id: number };
      this.sqlite.prepare('INSERT OR IGNORE INTO blog_post_tags (post_id, tag_id) VALUES (?, ?)').run(postId, tag.id);
    }
  }

  create(p: BlogPostInput): BlogPost {
    return this.tx(() => {
      if (this.slugTaken(p.slug)) throw new SlugTakenError(p.slug);
      // A live post's slug wins over an old redirect.
      this.sqlite.prepare('DELETE FROM blog_slug_redirects WHERE old_slug = ?').run(p.slug);
      const t = now();
      const res = this.sqlite.prepare(`INSERT INTO blog_posts (slug, title, blocks, excerpt, featured_image, author, status, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.slug, p.title, JSON.stringify(p.blocks), p.excerpt, p.featured_image, p.author, p.status, p.published_at, t, t);
      const id = Number(res.lastInsertRowid);
      this.setTags(id, p.tags);
      return this.get(id)!;
    });
  }

  // Returns undefined when the post doesn't exist. A slug change records old -> post. `inTx` runs first inside the same
  // transaction with the stored slug; throwing from it rolls everything back.
  update(id: number, p: BlogPostInput, inTx?: (cur: { slug: string }) => void): BlogPost | undefined {
    return this.tx(() => {
      const cur = this.sqlite.prepare('SELECT slug, updated_at FROM blog_posts WHERE id = ?').get(id) as { slug: string; updated_at: string } | undefined;
      if (!cur) return undefined;
      inTx?.(cur);
      if (p.slug !== cur.slug) {
        if (this.slugTaken(p.slug, id)) throw new SlugTakenError(p.slug);
        this.sqlite.prepare('DELETE FROM blog_slug_redirects WHERE old_slug = ?').run(p.slug);
        this.sqlite.prepare(`INSERT INTO blog_slug_redirects (old_slug, post_id, created_at) VALUES (?, ?, ?)
          ON CONFLICT (old_slug) DO UPDATE SET post_id = excluded.post_id, created_at = excluded.created_at`).run(cur.slug, id, now());
      }
      this.sqlite.prepare(`UPDATE blog_posts SET slug = ?, title = ?, blocks = ?, excerpt = ?, featured_image = ?, author = ?, status = ?,
        published_at = ?, updated_at = ? WHERE id = ?`)
        .run(p.slug, p.title, JSON.stringify(p.blocks), p.excerpt, p.featured_image, p.author, p.status, p.published_at, laterThan(cur.updated_at), id);
      this.setTags(id, p.tags);
      return this.get(id)!;
    });
  }

  delete(id: number): boolean {
    return this.tx(() => {
      this.sqlite.prepare('DELETE FROM blog_post_tags WHERE post_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM blog_slug_redirects WHERE post_id = ?').run(id);
      this.sqlite.prepare('DELETE FROM blog_slug_moves WHERE post_id = ?').run(id);
      return Number(this.sqlite.prepare('DELETE FROM blog_posts WHERE id = ?').run(id).changes) > 0;
    });
  }
}
