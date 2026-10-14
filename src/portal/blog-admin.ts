// Admin-only blog REST API (/portal/api/blog). Vault admins only; everyone else gets 403 (401 when signed out).
//   GET    /portal/api/blog/posts[?status=published|private]
//   GET    /portal/api/blog/posts/:id
//   POST   /portal/api/blog/posts            -> 201
//   PUT|PATCH /portal/api/blog/posts/:id     (fields omitted keep their value)
//   DELETE /portal/api/blog/posts/:id
//   GET    /portal/api/blog/slugify?title=...  -> { slug } (a free slug for the title)
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import type { User } from '../db.ts';
import { validateBlocks, isSafeImageSrc, type Block } from '../blog/blocks.ts';
import { BlogRepo, SlugTakenError, type BlogPost, type BlogPostInput, type BlogStatus } from '../blog/repo.ts';
import { isBlogSlug, MAX_SLUG, slugify } from '../blog/slug.ts';
import type { ListingHelpers } from './listings.ts';

const FIELDS = ['slug', 'title', 'blocks', 'excerpt', 'featured_image', 'author', 'status', 'published_at', 'tags'];
const MAX_TAGS = 20;

const hasCtl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

function str(b: Record<string, unknown>, key: string, max: number, errors: string[]): string | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') { errors.push(`${key} must be a string`); return undefined; }
  const t = v.trim();
  if (t.length > max) errors.push(`${key} must be at most ${max} characters`);
  if (hasCtl(t)) errors.push(`${key} must be plain text on one line`);
  return t;
}

function isoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return false;
  return !Number.isNaN(Date.parse(v));
}

// Validates a create/update body over `base` (the current post on update). Collects every error into one 400.
function parseInput(b: Record<string, unknown>, base: BlogPost | undefined, repo: BlogRepo): BlogPostInput {
  const errors: string[] = [];
  for (const k of Object.keys(b)) if (!FIELDS.includes(k)) errors.push(`unknown field "${k}"`);

  const title = str(b, 'title', 200, errors);
  if (title !== undefined && !title) errors.push('title must not be empty');
  if (!base && title === undefined) errors.push('title is required');

  let blocks: Block[] | undefined;
  if (b.blocks !== undefined) {
    const r = validateBlocks(b.blocks);
    if (r.ok) blocks = r.blocks; else errors.push(...r.errors);
  }
  const excerpt = str(b, 'excerpt', 1000, errors);
  const author = str(b, 'author', 200, errors);

  let featured: string | null | undefined;
  if (b.featured_image === null || b.featured_image === '') featured = null;
  else if (b.featured_image !== undefined) {
    if (typeof b.featured_image !== 'string' || !isSafeImageSrc(b.featured_image)) errors.push('featured_image must be an https URL or a path starting with /');
    else featured = b.featured_image;
  }

  let status: BlogStatus | undefined;
  if (b.status !== undefined) {
    if (b.status !== 'published' && b.status !== 'private') errors.push('status must be "published" or "private"');
    else status = b.status;
  }

  let publishedAt: string | null | undefined;
  if (b.published_at === null) publishedAt = null;
  else if (b.published_at !== undefined) {
    if (typeof b.published_at !== 'string' || !isoDate(b.published_at)) errors.push('published_at must be an ISO-8601 date-time or null');
    else publishedAt = new Date(b.published_at).toISOString();
  }

  let tags: string[] | undefined;
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags)) errors.push('tags must be an array of names');
    else if (b.tags.length > MAX_TAGS) errors.push(`a post may have at most ${MAX_TAGS} tags`);
    else {
      const seen = new Set<string>();
      tags = [];
      b.tags.forEach((t, i) => {
        if (typeof t !== 'string' || !t.trim() || t.trim().length > 50 || hasCtl(t) || !slugify(t)) { errors.push(`tags[${i}] must be a name of 1-50 characters with letters or digits`); return; }
        const s = slugify(t);
        if (!seen.has(s)) { seen.add(s); tags!.push(t.trim()); }
      });
    }
  }

  let slug: string | undefined;
  if (b.slug !== undefined && b.slug !== null && b.slug !== '') {
    if (!isBlogSlug(b.slug)) errors.push(`slug must be lowercase letters, digits and single hyphens, at most ${MAX_SLUG} characters`);
    else slug = b.slug;
  }
  if (errors.length) fail(400, 'Invalid blog post.', { errors: errors.slice(0, 50) });

  const finalStatus = status ?? base?.status ?? 'private';
  let finalPublishedAt = publishedAt !== undefined ? publishedAt : base?.published_at ?? null;
  if (finalStatus === 'published' && !finalPublishedAt) finalPublishedAt = new Date().toISOString();
  const finalTitle = title ?? base!.title;
  if (slug === undefined) slug = base ? base.slug : repo.freeSlug(slugify(finalTitle));

  return {
    slug, title: finalTitle, blocks: blocks ?? base?.blocks ?? [], excerpt: excerpt ?? base?.excerpt ?? '',
    featured_image: featured !== undefined ? featured : base?.featured_image ?? null, author: author ?? base?.author ?? '',
    status: finalStatus, published_at: finalPublishedAt, tags: tags ?? base?.tags.map((t) => t.name) ?? [],
  };
}

export function registerBlogAdmin(app: Hono, h: ListingHelpers) {
  const repo = new BlogRepo(h.db.sqlite);
  const admin = (c: Context): User => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can manage the blog.');
    return u;
  };
  const idOf = (c: Context): number => {
    const raw = c.req.param('id') ?? '';
    if (!/^[1-9]\d{0,15}$/.test(raw)) fail(404, 'No such blog post.');
    return Number(raw);
  };
  const save = <T>(fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (err instanceof SlugTakenError) fail(409, `The slug "${err.message}" is already used by another post.`, { field: 'slug' });
      throw err;
    }
  };

  app.get('/portal/api/blog/posts', (c) => {
    admin(c);
    const s = c.req.query('status');
    if (s !== undefined && s !== 'published' && s !== 'private') fail(400, 'status must be "published" or "private"');
    return c.json({ posts: repo.list(s as BlogStatus | undefined) });
  });

  app.get('/portal/api/blog/slugify', (c) => {
    admin(c);
    return c.json({ slug: repo.freeSlug(slugify(c.req.query('title') ?? '')) });
  });

  app.get('/portal/api/blog/posts/:id', (c) => {
    admin(c);
    const post = repo.get(idOf(c));
    if (!post) fail(404, 'No such blog post.');
    return c.json({ post });
  });

  app.post('/portal/api/blog/posts', async (c) => {
    const u = admin(c);
    const input = parseInput(await jsonBody(c), undefined, repo);
    const post = save(() => repo.create(input));
    h.db.audit(h.actor(u), 'blog.create', post.slug, { id: post.id, status: post.status });
    return c.json({ post }, 201);
  });

  const update = async (c: Context) => {
    const u = admin(c);
    const id = idOf(c);
    const base = repo.get(id);
    if (!base) fail(404, 'No such blog post.');
    const input = parseInput(await jsonBody(c), base, repo);
    const post = save(() => repo.update(id, input));
    if (!post) fail(404, 'No such blog post.');
    h.db.audit(h.actor(u), 'blog.update', post.slug, { id, ...(base.slug !== post.slug ? { from: base.slug } : {}), status: post.status });
    return c.json({ post });
  };
  app.put('/portal/api/blog/posts/:id', update);
  app.patch('/portal/api/blog/posts/:id', update);

  app.delete('/portal/api/blog/posts/:id', (c) => {
    const u = admin(c);
    const id = idOf(c);
    const post = repo.get(id);
    if (!post || !repo.delete(id)) fail(404, 'No such blog post.');
    h.db.audit(h.actor(u), 'blog.delete', post.slug, { id });
    return c.json({ ok: true });
  });
}
