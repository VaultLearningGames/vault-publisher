// Read-only queries behind the public blog pages (src/blog/publicRoutes.ts). The single source of truth for visibility:
// - listable: status 'published' with a published_at at or before now. These appear in the catalog, tag pages, the tag
//   filter and "More posts".
// - viewable by direct URL: listable posts, plus 'private' posts. Private posts are never listed, but a scheduled
//   private post (published_at in the future) is still hidden.
// B1 has no draft status. A 'published' post with no or a future published_at is unpublished, and 404s everywhere.
import type { DatabaseSync } from 'node:sqlite';
import type { Block } from './blocks.ts';
import type { BlogStatus, BlogTag } from './repo.ts';

export interface PublicPost {
  id: number; slug: string; title: string; blocks: Block[]; excerpt: string; featured_image: string | null; author: string;
  status: BlogStatus; published_at: string | null; tags: BlogTag[];
}

const LISTABLE = `p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at <= ?`;
const VIEWABLE = `((${LISTABLE}) OR (p.status = 'private' AND (p.published_at IS NULL OR p.published_at <= ?)))`;
const ORDER = 'ORDER BY p.published_at DESC, p.id DESC';

function tagsOf(db: DatabaseSync, postId: number): BlogTag[] {
  return db.prepare(`SELECT t.slug, t.name FROM blog_post_tags pt JOIN blog_tags t ON t.id = pt.tag_id
    WHERE pt.post_id = ? ORDER BY t.name COLLATE NOCASE, t.slug`).all(postId) as unknown as BlogTag[];
}

function toPost(db: DatabaseSync, r: Record<string, unknown>): PublicPost {
  const id = Number(r.id);
  let blocks: Block[] = [];
  try { const b = JSON.parse(String(r.blocks)); if (Array.isArray(b)) blocks = b as Block[]; } catch { /* treat as empty */ }
  return {
    id, slug: String(r.slug), title: String(r.title), blocks, excerpt: String(r.excerpt ?? ''),
    featured_image: (r.featured_image as string | null) ?? null, author: String(r.author ?? ''), status: r.status as BlogStatus,
    published_at: (r.published_at as string | null) ?? null, tags: tagsOf(db, id),
  };
}

// Listable posts, newest first; only those carrying `tagSlug` when given.
export function listablePosts(db: DatabaseSync, now: string, tagSlug?: string): PublicPost[] {
  const rows = (tagSlug === undefined
    ? db.prepare(`SELECT p.* FROM blog_posts p WHERE ${LISTABLE} ${ORDER}`).all(now)
    : db.prepare(`SELECT p.* FROM blog_posts p JOIN blog_post_tags pt ON pt.post_id = p.id JOIN blog_tags t ON t.id = pt.tag_id
        WHERE t.slug = ? AND ${LISTABLE} ${ORDER}`).all(tagSlug, now)) as Record<string, unknown>[];
  return rows.map((r) => toPost(db, r));
}

// Tags on at least one listable post, alphabetically. A tag used only by private posts is left out.
export function listableTags(db: DatabaseSync, now: string): BlogTag[] {
  return db.prepare(`SELECT DISTINCT t.slug, t.name FROM blog_tags t JOIN blog_post_tags pt ON pt.tag_id = t.id
    JOIN blog_posts p ON p.id = pt.post_id WHERE ${LISTABLE} ORDER BY t.name COLLATE NOCASE, t.slug`).all(now) as unknown as BlogTag[];
}

export function tagBySlug(db: DatabaseSync, slug: string): BlogTag | undefined {
  return db.prepare('SELECT slug, name FROM blog_tags WHERE slug = ?').get(slug) as BlogTag | undefined;
}

export function viewablePost(db: DatabaseSync, slug: string, now: string): PublicPost | undefined {
  const r = db.prepare(`SELECT p.* FROM blog_posts p WHERE p.slug = ? AND ${VIEWABLE}`).get(slug, now, now) as Record<string, unknown> | undefined;
  return r ? toPost(db, r) : undefined;
}

// The current slug that an old slug redirects to, if that post is viewable.
export function redirectSlug(db: DatabaseSync, oldSlug: string, now: string): string | undefined {
  const r = db.prepare(`SELECT p.slug FROM blog_slug_redirects r JOIN blog_posts p ON p.id = r.post_id
    WHERE r.old_slug = ? AND ${VIEWABLE}`).get(oldSlug, now, now) as { slug: string } | undefined;
  return r && r.slug !== oldSlug ? r.slug : undefined;
}

// "More posts": listable posts other than `post`, ranked by the number of tags they share with it, then newest. Posts that
// share no tags fill the remaining places, newest first.
export function relatedPosts(db: DatabaseSync, post: PublicPost, now: string, limit = 3): PublicPost[] {
  const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM blog_post_tags a JOIN blog_post_tags b ON b.tag_id = a.tag_id
      WHERE a.post_id = p.id AND b.post_id = ?) AS shared
    FROM blog_posts p WHERE p.id != ? AND ${LISTABLE} ORDER BY shared DESC, p.published_at DESC, p.id DESC LIMIT ?`)
    .all(post.id, post.id, now, limit) as Record<string, unknown>[];
  return rows.map((r) => toPost(db, r));
}
