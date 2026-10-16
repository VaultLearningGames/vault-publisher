// Admin-only blog REST API (/portal/api/blog). Vault admins only; everyone else gets 403 (401 when signed out).
//   GET    /portal/api/blog/posts[?status=published|private]
//   GET    /portal/api/blog/posts/:id
//   POST   /portal/api/blog/posts            -> 201
//   PUT|PATCH /portal/api/blog/posts/:id     (fields omitted keep their value)
//   DELETE /portal/api/blog/posts/:id
//   GET    /portal/api/blog/slugify?title=...  -> { slug } (a free slug for the title)
//   POST   /portal/api/blog/:slug/images     an image upload (multipart "file") -> { key, url, ... } (blog-images.ts)
// The editor (pages need a session; the JSON routes are API routes like the ones above):
//   GET    /portal/blog/new                 creates an empty draft, 302 -> /portal/blog/edit/<id>
//   GET    /portal/blog/edit/:id            the editor page, with the post as JSON in #blog-post-data
//   PUT    /portal/blog/:id                 save; body has the post's updated_at as loaded -> { post }, or 409 { error, current }
//   POST   /portal/blog/:id/preview         the unsaved body rendered as the public post page; saves nothing
//   POST   /portal/blog/:id/publish         sets published_at (now, unless already set) -> { post }
//   GET    /portal/blog/slug-check?slug=&id= -> { slug, available } (slug normalized)
//   GET    /portal/blog/tags?q=             -> { tags } up to 10 existing tags whose name starts with q
//   GET    /assets/portal-blog-editor.js|.css  the editor's script (an ES module) and styles
//   GET    /assets/portal-blog-image-editor.js  the image editor (crop, resize, compress, alt text) the editor imports
// A draft is a 'published' post with no published_at: the public blog 404s it until it is published.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { fail, jsonBody } from '../app.ts';
import type { User } from '../db.ts';
import { validateBlocks, isSafeImageSrc, type Block } from '../blog/blocks.ts';
import { BlogRepo, SlugTakenError, type BlogPost, type BlogPostInput, type BlogStatus } from '../blog/repo.ts';
import { isBlogSlug, MAX_SLUG, slugify } from '../blog/slug.ts';
import { postPage } from '../blog/publicRender.ts';
import { registerBlogImages } from './blog-images.ts';
import { head } from './routes.ts';
import { html, raw } from './html.ts';
import type { ListingHelpers } from './listings.ts';

const FIELDS = ['slug', 'title', 'blocks', 'excerpt', 'featured_image', 'author', 'status', 'published_at', 'tags'];
const MAX_TAGS = 20;
// Slugs set from the editor are normalized ("My  Post!" -> "my-post") and at most this long.
export const EDITOR_MAX_SLUG = 80;
// Keys of a loaded post the editor may send back unchanged; they are not editable.
const READ_ONLY = ['id', 'created_at', 'updated_at', 'redirects'];

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
// A published post without published_at gets now, unless `publishNow` is false (the editor saves drafts that way).
function parseInput(b: Record<string, unknown>, base: BlogPost | undefined, repo: BlogRepo, publishNow = true): BlogPostInput {
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
  if (publishNow && finalStatus === 'published' && !finalPublishedAt) finalPublishedAt = new Date().toISOString();
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
  // The editor's script and styles, read once at startup and versioned by content like the portal's own assets.
  const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)));
  const editorJs = asset('portal-blog-editor.js'), editorCss = asset('portal-blog-editor.css'), imageJs = asset('portal-blog-image-editor.js');
  const editorVersion = createHash('sha256').update(editorJs).update(editorCss).update(imageJs).digest('hex').slice(0, 10);
  const immutable = 'public, max-age=31536000, immutable';
  app.get('/assets/portal-blog-editor.js', (c) => c.body(editorJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': immutable }));
  // The editor imports it by this unversioned address, so browsers revalidate it rather than keep it for good.
  app.get('/assets/portal-blog-image-editor.js', (c) => c.body(imageJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }));
  app.get('/assets/portal-blog-editor.css', (c) => c.body(editorCss, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': immutable }));
  registerBlogImages(app, h);
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
      if (err instanceof SlugTakenError) {
        const error = `The slug "${err.message}" is already used by another post.`;
        throw new HTTPException(409, { res: Response.json({ error, field: 'slug', detail: { field: 'slug' } }, { status: 409 }) });
      }
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

  // ---------- the editor ----------
  // Pages: signed out -> sign-in, non-admins -> the portal's "No access" page, like the other Vault pages.
  const NOT_ADMIN = 'Only Vault admins can manage the blog.';
  const notFoundPage = (c: Context) =>
    h.page(c, 'Not found', html`${head('Not found', 'No such blog post.')}<p><a href="/">Back to the portal</a></p>`, { status: 404 });
  // An editor body: drops the read-only keys and normalizes the slug.
  const editorBody = (b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) if (!READ_ONLY.includes(k)) out[k] = v;
    if (typeof out.slug === 'string' && out.slug !== '') {
      const slug = editorSlug(out.slug);
      if (!slug) fail(400, 'Invalid blog post.', { errors: ['slug must contain letters or digits'], field: 'slug' });
      out.slug = slug;
    }
    return out;
  };
  const conflict = (c: Context, current: BlogPost) =>
    c.json({ error: 'This post was changed elsewhere since you loaded it. Reload to get the latest version.', current }, 409);

  app.get('/portal/blog/new', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isVaultAdmin(u)) return h.denied(c, NOT_ADMIN);
    const post = repo.create({ slug: repo.freeSlug('untitled'), title: 'Untitled', blocks: [], excerpt: '', featured_image: null,
      author: u.name || u.login, status: 'published', published_at: null, tags: [] });
    h.db.audit(h.actor(u), 'blog.create', post.slug, { id: post.id, status: post.status, draft: true });
    return c.redirect(`/portal/blog/edit/${post.id}`, 302);
  });

  app.get('/portal/blog/edit/:id', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isVaultAdmin(u)) return h.denied(c, NOT_ADMIN);
    const raw_ = c.req.param('id') ?? '';
    const post = /^[1-9]\d{0,15}$/.test(raw_) ? repo.get(Number(raw_)) : undefined;
    if (!post) return notFoundPage(c);
    // '<' as \u003c, so nothing in the post can close the script element.
    const data = JSON.stringify(post).replace(/</g, '\\u003c');
    return h.page(c, `Edit: ${post.title || 'Untitled'}`, html`${head('Edit post', post.published_at ? 'Published' : 'Draft: not on the blog yet')}
      <link rel="stylesheet" href="/assets/portal-blog-editor.css?v=${editorVersion}">
      <div id="blog-editor" data-id="${post.id}" data-site-url="${h.deps.siteUrl ?? 'https://vaultlearninggames.org'}"></div>
      <script type="application/json" id="blog-post-data">${raw(data)}</script>
      <script type="module" src="/assets/portal-blog-editor.js?v=${editorVersion}"></script>`);
  });

  app.put('/portal/blog/:id', async (c) => {
    const u = admin(c);
    const id = idOf(c);
    const body = await jsonBody(c);
    const base = repo.get(id);
    if (!base) fail(404, 'No such blog post.');
    if (typeof body.updated_at !== 'string' || !body.updated_at) fail(400, 'updated_at (as loaded) is required.', { field: 'updated_at' });
    if (body.updated_at !== base.updated_at) return conflict(c, base);
    const input = parseInput(editorBody(body), base, repo, false);
    const post = save(() => repo.update(id, input));
    if (!post) fail(404, 'No such blog post.');
    h.db.audit(h.actor(u), 'blog.update', post.slug, { id, ...(base.slug !== post.slug ? { from: base.slug } : {}), status: post.status });
    return c.json({ post });
  });

  app.post('/portal/blog/:id/preview', async (c) => {
    admin(c);
    const id = idOf(c);
    const body = await jsonBody(c);
    const base = repo.get(id);
    if (!base) fail(404, 'No such blog post.');
    const p = parseInput(editorBody(body), base, repo, false);
    const tags = p.tags.map((name) => ({ slug: slugify(name), name }));
    const page = postPage(h.deps.siteUrl ?? 'https://vaultlearninggames.org', { id, ...p, tags }, []);
    return c.html(String(page), 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  });

  app.post('/portal/blog/:id/publish', async (c) => {
    const u = admin(c);
    const id = idOf(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown> | null;
    const base = repo.get(id);
    if (!base) fail(404, 'No such blog post.');
    const loaded = body && typeof body === 'object' ? body.updated_at : undefined;
    if (loaded !== undefined && loaded !== base.updated_at) return conflict(c, base);
    // Scheduled posts keep their date; status (published or private) is the editor's choice and stays.
    const input: BlogPostInput = { slug: base.slug, title: base.title, blocks: base.blocks, excerpt: base.excerpt, featured_image: base.featured_image,
      author: base.author, status: base.status, published_at: base.published_at ?? new Date().toISOString(), tags: base.tags.map((t) => t.name) };
    const post = save(() => repo.update(id, input));
    if (!post) fail(404, 'No such blog post.');
    h.db.audit(h.actor(u), 'blog.publish', post.slug, { id, status: post.status, published_at: post.published_at });
    return c.json({ post });
  });

  app.get('/portal/blog/slug-check', (c) => {
    admin(c);
    const slug = editorSlug(c.req.query('slug') ?? '');
    const rawId = c.req.query('id') ?? '';
    const id = /^[1-9]\d{0,15}$/.test(rawId) ? Number(rawId) : undefined;
    return c.json({ slug, available: !!slug && isBlogSlug(slug) && !repo.slugTaken(slug, id) });
  });

  app.get('/portal/blog/tags', (c) => {
    admin(c);
    return c.json({ tags: repo.searchTags((c.req.query('q') ?? '').trim().slice(0, 50), 10) });
  });
}

// "  My  Post!! " -> "my-post": lowercase a-z, 0-9 and single hyphens, at most EDITOR_MAX_SLUG characters.
export function editorSlug(input: string): string {
  return slugify(input).slice(0, EDITOR_MAX_SLUG).replace(/-+$/, '');
}
