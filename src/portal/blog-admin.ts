// The blog editor and its admin API. Posts live in the vault-site repository, content/blog/<slug>/index.md on this
// system's branch (staging or production; site-repo/config.ts) (blog/siteRepo.ts over the GitHub client in
// site-content/). Every Save, Publish, Unpublish, rename and delete is one commit there by the bot user, with a
// Portal-User trailer naming the editor, and the site's own workflow rebuilds and publishes the site on it; the
// portal builds nothing. SITE_PUBLISHING_ENABLED=false refuses every write: 503 { error: 'publishing_disabled' }.
// Autosaves are not commits: they go to the portal's scratch storage (blog/scratch.ts) until the next Save.
// A post's blob SHA, as loaded, is the conflict check: a write naming another SHA gets 409 { error: 'conflict' }.
// Vault admins do everything. Blog maintainers (the Vault permission blog.maintain, db.ts) edit any post: they list,
// open, autosave, preview and Save existing posts (a rename too), and upload images, but get 403 creating, deleting,
// publishing or unpublishing one, and on a Save that changes its publish date or its visibility. Everyone else gets
// 403 on every route here (401 when signed out).
//   GET    /portal/api/blog/posts                 -> { posts: [{ slug, sha, title, date, draft, private, tags, author, image }] } (image: a thumbnail, or null)
//   GET    /portal/api/blog/posts/:slug           -> { post }
//   POST   /portal/api/blog/posts                 a new post (committed) -> 201 { post }
//   PUT|PATCH /portal/api/blog/posts/:slug        { sha, ...fields } (fields omitted keep their value; a new slug renames)
//   DELETE /portal/api/blog/posts/:slug?sha=      removes the post's folder -> { ok, commit }
//   GET    /portal/api/blog/slugify?title=...     -> { slug } (a free slug for the title)
//   POST   /portal/api/blog/:slug/images          an image upload (multipart "file") -> { key, url, ... } (blog-images.ts)
// A slug change (rename) is one commit that moves the post's folder and adds /blog/<old>/ to its aliases; the post's
// CDN images move to site/<new slug>/ around it (blog/imageMove.ts): 502 { error: 'image_move_failed' } or 409 when they
// can't be moved, and then nothing changed. The response's "move" says what happened to them.
// The editor (pages need a session; the JSON routes are API routes like the ones above):
//   GET    /portal/blog                     every post in the repository, and new posts not committed yet
//   GET    /portal/blog/new                 a new post (scratch only until its first Save), 302 -> /portal/blog/edit/<slug>
//   GET    /portal/blog/edit/:slug          the editor page, with the post as JSON in #blog-post-data (its autosave if any):
//                                           the post list (thumbnails) on the left, the body in the middle, settings on the right
//   PUT    /portal/blog/:slug/autosave      { sha, ...fields } -> { autosaved_at }; scratch storage only, no commit
//   DELETE /portal/blog/:slug/autosave      throws the autosave away (the editor then reloads the committed post)
//   PUT    /portal/blog/:slug               Save: { sha (null for a new post), ...fields } -> { post } (one commit)
//   POST   /portal/blog/:slug/publish       Save with the publish date set (now, unless set) -> { post }
//   POST   /portal/blog/:slug/unpublish     { sha } back to a draft (no date; off the site) -> { post }
//   DELETE /portal/blog/:slug               { sha } -> { ok } (a new post: just its autosave)
//   POST   /portal/blog/:slug/preview       the unsaved post built by the site (Hugo); saves nothing
//   GET    /portal/blog/slug-check?slug=&current= -> { slug, available } (slug normalized)
//   GET    /portal/blog/tags?q=             -> { tags } up to 10 existing tags whose name starts with q
//   GET    /assets/portal-blog-editor.js|.css  the editor's script (an ES module) and styles
//   GET    /assets/portal-blog-image-editor.js  the image editor (crop, resize, compress, alt text) the editor imports
//   GET    /assets/portal-blog-editor-commands.js  the editor's formatting commands (all its execCommand calls)
// A draft is a post with no publish date (draft: true in its front matter): the site doesn't publish it.
// Errors: 409 { error: 'conflict', currentSha } (the file changed since it was loaded), 409 { error: 'slug_taken' },
// 502 { error: 'upstream' } (GitHub failed or couldn't be reached; nothing was saved), 503 { error: 'not_configured' }.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { fail, jsonBody } from '../app.ts';
import type { User } from '../db.ts';
import { validateBlocks, isSafeImageSrc, type Block } from '../blog/blocks.ts';
import type { BlogPostInput, BlogStatus } from '../blog/repo.ts';
import { BlogScratch } from '../blog/scratch.ts';
import { markDeployPending } from '../deploy-status.ts';
import { PostSlugTakenError, SiteBlogRepo, type RepoPost } from '../blog/siteRepo.ts';
import { isBlogSlug, MAX_SLUG, slugify, uniqueSlug } from '../blog/slug.ts';
import { copyImages, deleteOld, discardCopies, ImageMoveError, rewriteImageRefs, withImageLock } from '../blog/imageMove.ts';
import {
  applyPostInput, FrontMatterError, parsePostFile, postInputFromFile, SaveConflictError, SAVE_CONFLICT_MESSAGE, serializePostFile, SiteContentConfigError, SiteContentError,
} from '../site-content/index.ts';
import { withPortalUserTrailer } from '../site-repo/config.ts';
import { registerBlogImages } from './blog-images.ts';
import { head, pill } from './routes.ts';
import { html, raw, type Html } from './html.ts';
import type { ListingHelpers } from './listings.ts';

const FIELDS = ['slug', 'title', 'blocks', 'excerpt', 'featured_image', 'author', 'status', 'published_at', 'tags'];
const MAX_TAGS = 20;
// Slugs set from the editor are normalized ("My  Post!" -> "my-post") and at most this long.
export const EDITOR_MAX_SLUG = 80;
// Keys of a loaded post the editor may send back unchanged; they are not editable. `sha` is read separately.
const READ_ONLY = ['sha', 'aliases', 'autosaved_at', 'committed', 'publish'];

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
function parseInput(b: Record<string, unknown>, base: BlogPostInput | undefined, freeSlug: (base: string) => string, publishNow = true): BlogPostInput {
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

  const finalStatus = status ?? base?.status ?? 'published';
  let finalPublishedAt = publishedAt !== undefined ? publishedAt : base?.published_at ?? null;
  if (publishNow && finalStatus === 'published' && !finalPublishedAt) finalPublishedAt = new Date().toISOString();
  const finalTitle = title ?? base!.title;
  if (slug === undefined) slug = base ? base.slug : freeSlug(slugify(finalTitle));

  return {
    slug, title: finalTitle, blocks: blocks ?? base?.blocks ?? [], excerpt: excerpt ?? base?.excerpt ?? '',
    featured_image: featured !== undefined ? featured : base?.featured_image ?? null, author: author ?? base?.author ?? '',
    status: finalStatus, published_at: finalPublishedAt, tags: tags ?? base?.tags ?? [],
  };
}

// A post as the editor and the API get it.
export interface EditorPost extends BlogPostInput {
  // The file's blob SHA as loaded; null for a post not committed yet.
  sha: string | null;
  aliases: string[];
  // Whether the post is in the repository.
  committed: boolean;
  // When the fields came from an autosave rather than the committed file.
  autosaved_at?: string;
}

const fromRepo = (p: RepoPost): EditorPost => ({ ...p.input, sha: p.sha, aliases: p.aliases, committed: true });
const fields = (p: BlogPostInput): Omit<BlogPostInput, 'slug'> => {
  const { slug: _slug, ...rest } = p;
  return rest;
};

export function registerBlogAdmin(app: Hono, h: ListingHelpers) {
  const repo = new SiteBlogRepo({ client: h.deps.siteContent ?? undefined });
  const scratch = new BlogScratch(h.db.sqlite);
  // The editor's script and styles, read once at startup and versioned by content like the portal's own assets.
  const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)));
  const editorJs = asset('portal-blog-editor.js'), editorCss = asset('portal-blog-editor.css'), imageJs = asset('portal-blog-image-editor.js');
  const commandsJs = asset('portal-blog-editor-commands.js');
  const editorVersion = createHash('sha256').update(editorJs).update(editorCss).update(imageJs).update(commandsJs).digest('hex').slice(0, 10);
  const immutable = 'public, max-age=31536000, immutable';
  app.get('/assets/portal-blog-editor.js', (c) => c.body(editorJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': immutable }));
  // The editor imports it by this unversioned address, so browsers revalidate it rather than keep it for good.
  app.get('/assets/portal-blog-image-editor.js', (c) => c.body(imageJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }));
  app.get('/assets/portal-blog-editor-commands.js', (c) => c.body(commandsJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }));
  app.get('/assets/portal-blog-editor.css', (c) => c.body(editorCss, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': immutable }));
  const maintains = (u: User) => h.isVaultAdmin(u) || h.db.hasVaultPermission(u.login, 'blog.maintain');
  registerBlogImages(app, h, {
    postExists: async (slug) => scratch.has(slug) || (await repo.listPosts()).some((p) => p.slug === slug),
    canUpload: maintains,
  });
  // Creating, deleting, publishing and unpublishing: Vault admins.
  const admin = (c: Context): User => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, maintains(u) ? 'Only Vault admins can create, delete, publish or unpublish blog posts.' : NOT_ADMIN);
    return u;
  };
  // Editing posts: Vault admins and Blog maintainers.
  const editor = (c: Context): User => {
    const u = h.apiUser(c);
    if (!maintains(u)) fail(403, NOT_ADMIN);
    return u;
  };
  // A Blog maintainer's Save keeps the post's publish date and visibility (changing them publishes or unpublishes it).
  const keepsPublishing = (u: User, base: BlogPostInput, input: BlogPostInput) => {
    if (h.isVaultAdmin(u)) return;
    const same = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));
    if (!same(base.published_at, input.published_at) || base.status !== input.status) {
      fail(403, 'Only Vault admins can publish or unpublish posts, or change their publish date or visibility.');
    }
  };
  const slugOf = (c: Context): string => {
    const s = c.req.param('slug') ?? '';
    if (!isBlogSlug(s)) fail(404, 'No such blog post.');
    return s;
  };
  const shaOf = (v: unknown, required: boolean): string | null => {
    if (v === null || v === undefined || v === '') {
      if (required) fail(400, 'sha (the post’s SHA as loaded) is required.', { field: 'sha' });
      return null;
    }
    if (typeof v !== 'string' || !/^[0-9a-f]{40,64}$/i.test(v)) fail(400, 'sha must be the post’s blob SHA as loaded.', { field: 'sha' });
    return v;
  };
  const jsonError = (status: number, body: Record<string, unknown>) =>
    new HTTPException(status as 409, { res: Response.json(body, { status }) });
  // A failure of the repository as the HTTP answer. Nothing reached scratch storage or the repository when these throw.
  const repoError = (err: unknown): never => {
    if (err instanceof HTTPException) throw err;
    if (err instanceof SaveConflictError) throw jsonError(409, { error: 'conflict', message: SAVE_CONFLICT_MESSAGE, currentSha: err.currentSha ?? null });
    if (err instanceof PostSlugTakenError) {
      throw jsonError(409, { error: 'slug_taken', message: `The slug "${err.slug}" is already used by another post.`, field: 'slug', detail: { field: 'slug' } });
    }
    if (err instanceof ImageMoveError) throw jsonError(err.status, { error: err.code, message: err.message, field: 'slug' });
    if (err instanceof FrontMatterError) throw jsonError(422, { error: 'unreadable', message: `The post’s front matter can’t be read: ${err.message}` });
    if (err instanceof SiteContentConfigError) throw jsonError(503, { error: 'not_configured', message: err.message });
    if (err instanceof SiteContentError) {
      if (err.status === 400) throw jsonError(400, { error: err.code, message: err.message });
      if (err.code === 'publishing_disabled') throw jsonError(503, { error: 'publishing_disabled', message: err.message });
      if (err.status === 404) throw jsonError(404, { error: 'not_found', message: 'No such blog post.' });
      console.error(`blog: ${err.message}`);
      throw jsonError(502, { error: 'upstream', message: 'The website repository on GitHub could not be reached or refused the change. Nothing was saved; try again.' });
    }
    throw err;
  };
  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (err) { return repoError(err); } };

  const freeSlugFrom = (taken: Set<string>) => (base: string) => uniqueSlug(base.slice(0, EDITOR_MAX_SLUG).replace(/-+$/, ''), (s) => taken.has(s) || scratch.has(s));
  const takenSlugs = async () => {
    const out = new Set<string>();
    for (const p of await repo.cache.list()) {
      out.add(p.slug);
      for (const a of p.frontMatter?.aliases ?? []) { const m = /^\/?blog\/([^/]+)\/?$/.exec(a.trim()); if (m) out.add(m[1]); }
    }
    return out;
  };

  // The post at `slug` as the editor should open it: its autosave over the committed file, or a new post's autosave.
  const editorPost = async (slug: string): Promise<EditorPost | null> => {
    const committed = await repo.getPost(slug);
    const s = scratch.get(slug);
    if (s) {
      const base = committed ? committed.input : undefined;
      const input = scratchInput(s.data, slug, base) ?? base ?? newPostInput(slug, '');
      // An autosave of an older version keeps the SHA it started from, so Save reports the conflict instead of overwriting.
      return { ...input, sha: s.base_sha, aliases: committed?.aliases ?? [], committed: !!committed, autosaved_at: s.updated_at };
    }
    return committed ? fromRepo(committed) : null;
  };
  // Committed by the bot user; the trailer says who in the portal made the change.
  const commitMessage = (verb: string, what: string, u: User) =>
    withPortalUserTrailer(`blog: ${verb} ${what}\n\nBy ${h.actor(u)} in the Vault Studio Portal.`, u.login);

  // A Save: create (sha null), update, or rename (a new slug), each one commit. Clears the post's autosave.
  const commit = async (u: User, slug: string, sha: string | null, input: BlogPostInput, verb?: string): Promise<{ post: EditorPost; move?: unknown }> => {
    if (sha === null) {
      const r = await repo.savePost(input.slug, fields(input), null, commitMessage(verb ?? 'create', input.slug, u));
      scratch.delete(slug);
      h.db.audit(h.actor(u), 'blog.create', input.slug, { commit: r.commit });
      markDeployPending(h.db, 'blog.create');
      return { post: { ...input, sha: r.sha, aliases: [], committed: true } };
    }
    if (input.slug === slug) {
      const r = await repo.savePost(slug, fields(input), sha, commitMessage(verb ?? 'update', slug, u));
      scratch.delete(slug);
      h.db.audit(h.actor(u), `blog.${verb ?? 'update'}`, slug, { commit: r.commit });
      markDeployPending(h.db, `blog.${verb ?? 'update'}`);
      const after = await repo.getPost(slug).catch(() => null);
      return { post: { ...input, sha: r.sha, aliases: after?.aliases ?? [], committed: true } };
    }
    // A rename: images first, then the commit; the copies are removed again when the commit fails.
    return withImageLock(slug, async () => {
      const storage = h.deps.production;
      const copy = await copyImages(storage, slug, input.slug);
      const moved = copy.keys.length ? rewriteImageRefs(input, copy, h.deps.prodPublicUrl) : input;
      let r;
      try {
        r = await repo.renamePost(slug, input.slug, fields(moved), sha, commitMessage('rename', `${slug} -> ${input.slug}`, u));
      } catch (err) {
        await discardCopies(storage, copy);
        throw err;
      }
      const move = copy.keys.length ? await deleteOld(storage, copy) : undefined;
      scratch.delete(slug);
      scratch.delete(input.slug);
      h.db.audit(h.actor(u), 'blog.rename', input.slug, { from: slug, commit: r.commit, ...(move ? { move } : {}) });
      markDeployPending(h.db, 'blog.rename');
      const after = await repo.getPost(input.slug).catch(() => null);
      return { post: { ...moved, sha: r.sha, aliases: after?.aliases ?? [], committed: true }, ...(move ? { move } : {}) };
    });
  };

  // ---------- the API ----------
  const NOT_ADMIN = 'Only Vault admins and Blog maintainers can manage the blog.';
  app.get('/portal/api/blog/posts', async (c) => {
    editor(c);
    return c.json({ posts: await guarded(() => repo.listPosts()) });
  });

  app.get('/portal/api/blog/slugify', async (c) => {
    editor(c);
    const taken = await guarded(takenSlugs);
    return c.json({ slug: freeSlugFrom(taken)(slugify(c.req.query('title') ?? '')) });
  });

  app.get('/portal/api/blog/posts/:slug', async (c) => {
    editor(c);
    const post = await guarded(() => repo.getPost(slugOf(c)));
    if (!post) fail(404, 'No such blog post.');
    return c.json({ post: fromRepo(post) });
  });

  app.post('/portal/api/blog/posts', async (c) => {
    const u = admin(c);
    const body = await jsonBody(c);
    const taken = await guarded(takenSlugs);
    const input = parseInput(body, undefined, freeSlugFrom(taken));
    const r = await guarded(() => commit(u, input.slug, null, input));
    return c.json(r, 201);
  });

  const apiUpdate = async (c: Context) => {
    const u = editor(c);
    const slug = slugOf(c);
    const body = await jsonBody(c);
    const sha = shaOf(body.sha, true)!;
    delete body.sha;
    const base = await guarded(() => repo.getPost(slug));
    if (!base) fail(404, 'No such blog post.');
    if (base.sha !== sha) throw jsonError(409, { error: 'conflict', message: SAVE_CONFLICT_MESSAGE, currentSha: base.sha });
    const input = parseInput(body, base.input, () => slug);
    keepsPublishing(u, base.input, input);
    return c.json(await guarded(() => commit(u, slug, sha, input)));
  };
  app.put('/portal/api/blog/posts/:slug', apiUpdate);
  app.patch('/portal/api/blog/posts/:slug', apiUpdate);

  const remove = async (c: Context, sha: string | null) => {
    const u = admin(c);
    const slug = slugOf(c);
    if (sha === null) {
      // A post never committed: only its autosave is there.
      if (!scratch.delete(slug)) fail(400, 'sha (the post’s SHA as loaded) is required.', { field: 'sha' });
      h.db.audit(h.actor(u), 'blog.discard', slug, {});
      return c.json({ ok: true });
    }
    const r = await guarded(() => repo.deletePost(slug, sha, commitMessage('delete', slug, u)));
    scratch.delete(slug);
    h.db.audit(h.actor(u), 'blog.delete', slug, { commit: r.commit });
    markDeployPending(h.db, 'blog.delete');
    return c.json({ ok: true, commit: r.commit });
  };
  app.delete('/portal/api/blog/posts/:slug', (c) => remove(c, shaOf(c.req.query('sha'), true)));

  // ---------- the editor ----------
  // Pages: signed out -> sign-in, non-admins -> the portal's "No access" page, like the other Vault pages.
  const notFoundPage = (c: Context) =>
    h.page(c, 'Not found', html`${head('Not found', 'No such blog post.')}<p><a href="/portal/blog">Back to the blog</a></p>`, { status: 404, active: 'blog' });
  const errorPage = (c: Context, err: unknown) => {
    const msg = err instanceof SiteContentConfigError ? 'The portal isn’t connected to the website repository here (VAULT_SITE_GITHUB_TOKEN).'
      : err instanceof FrontMatterError ? `This post’s front matter can’t be read: ${err.message}. Fix the file in the vault-site repository.`
      : 'The website repository on GitHub could not be reached. Try again in a moment.';
    if (!(err instanceof SiteContentConfigError || err instanceof FrontMatterError || err instanceof SiteContentError)) throw err;
    return h.page(c, 'Blog', html`${head('Blog', msg)}<p><a href="/portal">Back to the portal</a></p>`, { status: err instanceof FrontMatterError ? 422 : 503, active: 'blog' });
  };
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
  // An autosave's fields (over `base`, the committed post), or undefined when they no longer validate.
  const scratchInput = (data: Record<string, unknown>, slug: string, base?: BlogPostInput): BlogPostInput | undefined => {
    try { return parseInput(editorBody(data), base, () => slug, false); } catch { return undefined; }
  };
  // A new post's fields: an empty draft.
  const newPostInput = (slug: string, author: string): BlogPostInput => ({
    slug, title: 'Untitled', blocks: [], excerpt: '', featured_image: null, author, status: 'published', published_at: null, tags: [],
  });
  // The committed post at `slug` (null: a new post, only in scratch), or 404.
  const baseOf = async (slug: string): Promise<{ input: BlogPostInput; sha: string | null }> => {
    const committed = await guarded(() => repo.getPost(slug));
    if (committed) return { input: committed.input, sha: committed.sha };
    const s = scratch.get(slug);
    if (!s || s.base_sha !== null) fail(404, 'No such blog post.');
    return { input: scratchInput(s.data, slug) ?? newPostInput(slug, ''), sha: null };
  };

  // Every post, newest first, with a link to its editor; new posts that only have an autosave come first.
  app.get('/portal/blog', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!maintains(u)) return h.denied(c, NOT_ADMIN);
    let posts;
    try { posts = await repo.listPosts(); } catch (err) { return errorPage(c, err); }
    posts.sort((a, b) => (b.date ?? '9999').localeCompare(a.date ?? '9999') || a.slug.localeCompare(b.slug));
    const status = (p: { draft: boolean; private: boolean; date: string | null }) => {
      const s = postStatus(p);
      return s === 'Published' ? pill('ok', s) : s === 'Unlisted' ? pill('off', s) : pill('wait', s);
    };
    const fresh = scratch.newPosts().filter((s) => !posts.some((p) => p.slug === s.slug));
    const rows = [
      ...fresh.map((s) => html`<tr><td class="proj"><b>${typeof s.data.title === 'string' && s.data.title ? s.data.title : s.slug}</b><span class="mono">${s.slug}</span></td>
        <td>${pill('wait', 'not saved yet')}</td><td>—</td><td>${typeof s.data.author === 'string' && s.data.author ? s.data.author : '—'}</td>
        <td class="r"><a class="btn sm" href="/portal/blog/edit/${s.slug}">Edit</a></td></tr>`),
      ...posts.map((p) => html`<tr><td class="proj"><b>${p.title || p.slug}</b><span class="mono">${p.slug}</span>${p.parseError ? html` <span class="err">front matter can’t be read</span>` : ''}</td>
        <td>${status(p)}${scratch.has(p.slug) ? html` ${pill('wait', 'autosaved')}` : ''}</td><td>${listDate(p.date)}</td><td>${p.author || '—'}</td>
        <td class="r">${p.parseError ? '' : html`<a class="btn sm" href="/portal/blog/edit/${p.slug}">Edit</a>`}</td></tr>`),
    ];
    const body = html`${head('Blog', 'Every post on the Vault blog, from the website repository: drafts, published and private ones. Saving commits to the site; the site rebuilds itself.', h.isVaultAdmin(u) ? html`<a class="btn pri" href="/portal/blog/new">New post</a>` : '')}
      ${rows.length
        ? html`<div class="tbl-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Date</th><th>Author</th><th class="r"></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<p class="muted">No posts yet.</p>`}`;
    return h.page(c, 'Blog', body, { active: 'blog' });
  });

  // A new post exists only as an autosave until its first Save commits it.
  app.get('/portal/blog/new', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isVaultAdmin(u)) return h.denied(c, maintains(u) ? 'Only Vault admins can create blog posts.' : NOT_ADMIN);
    let taken;
    try { taken = await takenSlugs(); } catch (err) { return errorPage(c, err); }
    const slug = freeSlugFrom(taken)('untitled');
    const input = newPostInput(slug, u.name || u.login);
    scratch.put(slug, null, { ...input }, h.actor(u));
    return c.redirect(`/portal/blog/edit/${slug}`, 302);
  });

  app.get('/portal/blog/edit/:slug', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!maintains(u)) return h.denied(c, NOT_ADMIN);
    const slug = c.req.param('slug') ?? '';
    if (!isBlogSlug(slug)) return notFoundPage(c);
    let post;
    try { post = await editorPost(slug); } catch (err) { return errorPage(c, err); }
    if (!post) return notFoundPage(c);
    // A new post (not committed yet) is a Vault admin's to create.
    if (!post.committed && !h.isVaultAdmin(u)) return h.denied(c, 'Only Vault admins can create blog posts.');
    // '<' as <, so nothing in the post can close the script element.
    const data = JSON.stringify(post).replace(/</g, '\\u003c');
    const sub = !post.committed ? 'New post: not in the website repository until you save it'
      : post.published_at ? 'Published' : 'Draft: not on the blog yet';
    // The post list beside the editor; the editor still opens when the list can't be read.
    let pane: PaneItem[] | null = null;
    try {
      const posts = (await repo.listPosts()).filter((p) => !p.parseError);
      posts.sort((a, b) => (b.date ?? '9999').localeCompare(a.date ?? '9999') || a.slug.localeCompare(b.slug));
      const fresh = scratch.newPosts().filter((s) => !posts.some((p) => p.slug === s.slug));
      pane = [
        ...fresh.map((s): PaneItem => ({
          slug: s.slug, title: typeof s.data.title === 'string' && s.data.title ? s.data.title : s.slug, status: 'New', date: null,
          image: typeof s.data.featured_image === 'string' ? s.data.featured_image : null,
        })),
        ...posts.map((p): PaneItem => ({ slug: p.slug, title: p.title || p.slug, status: postStatus(p), date: p.date, image: p.image })),
      ];
    } catch (err) {
      if (!(err instanceof SiteContentError || err instanceof SiteContentConfigError)) throw err;
    }
    return h.page(c, `Edit: ${post.title || 'Untitled'}`, html`${head('Edit post', sub)}
      <link rel="stylesheet" href="/assets/portal-blog-editor.css?v=${editorVersion}">
      <div class="be-shell">${postsPane(pane, slug, h.isVaultAdmin(u))}
      <div id="blog-editor" data-slug="${slug}" data-site-url="${h.deps.siteUrl ?? 'https://vaultlearninggames.org'}"${h.isVaultAdmin(u) ? '' : raw(' data-can-publish="0"')}></div></div>
      <script type="application/json" id="blog-post-data">${raw(data)}</script>
      <script type="module" src="/assets/portal-blog-editor.js?v=${editorVersion}"></script>`, { active: 'blog' });
  });

  // Autosave: scratch storage only.
  app.put('/portal/blog/:slug/autosave', async (c) => {
    const u = editor(c);
    const slug = slugOf(c);
    const body = await jsonBody(c);
    const sha = shaOf(body.sha, false);
    // A new post's autosave is the new post, which only a Vault admin creates.
    if (sha === null && !h.isVaultAdmin(u)) fail(403, 'Only Vault admins can create blog posts.');
    const existing = scratch.get(slug);
    // A post that is neither committed nor started as a new post isn't autosaved into being.
    if (sha === null && !existing) fail(404, 'No such blog post.');
    const input = parseInput(editorBody(body), (existing && scratchInput(existing.data, slug)) ?? newPostInput(slug, ''), () => slug, false);
    const saved = scratch.put(slug, sha ?? existing?.base_sha ?? null, { ...input }, h.actor(u));
    return c.json({ autosaved_at: saved.updated_at });
  });

  app.delete('/portal/blog/:slug/autosave', (c) => {
    editor(c);
    const slug = slugOf(c);
    const s = scratch.get(slug);
    // A new post's autosave is the post; it is only removed by deleting the post.
    if (s && s.base_sha !== null) scratch.delete(slug);
    return c.json({ ok: true });
  });

  // Save and Publish: one commit each.
  const save = (publish: boolean) => async (c: Context) => {
    const u = publish ? admin(c) : editor(c);
    const slug = slugOf(c);
    const body = await jsonBody(c);
    if (!('sha' in body)) fail(400, 'sha (the post’s SHA as loaded, or null for a new post) is required.', { field: 'sha' });
    const sha = shaOf(body.sha, false);
    if (sha === null && !h.isVaultAdmin(u)) fail(403, 'Only Vault admins can create blog posts.');
    const base = await baseOf(slug);
    if (base.sha !== sha) throw jsonError(409, { error: 'conflict', message: SAVE_CONFLICT_MESSAGE, currentSha: base.sha });
    const input = parseInput(editorBody(body), base.input, () => slug, false);
    if (!publish) keepsPublishing(u, base.input, input);
    if (publish && !input.published_at) input.published_at = new Date().toISOString();
    const verb = publish ? 'publish' : undefined;
    return c.json(await guarded(() => commit(u, slug, sha, input, verb)));
  };
  app.put('/portal/blog/:slug', save(false));
  app.post('/portal/blog/:slug/publish', save(true));

  app.post('/portal/blog/:slug/unpublish', async (c) => {
    const u = admin(c);
    const slug = slugOf(c);
    const body = await jsonBody(c);
    const sha = shaOf(body.sha, true)!;
    const base = await guarded(() => repo.getPost(slug));
    if (!base) fail(404, 'No such blog post.');
    if (base.sha !== sha) throw jsonError(409, { error: 'conflict', message: SAVE_CONFLICT_MESSAGE, currentSha: base.sha });
    const input = { ...base.input, published_at: null };
    return c.json(await guarded(() => commit(u, slug, sha, input, 'unpublish')));
  });

  app.delete('/portal/blog/:slug', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown> | null;
    return remove(c, shaOf(body && typeof body === 'object' ? body.sha : undefined, false));
  });

  // The unsaved post as the site builds it: the file it would commit, rendered by Hugo on the site source.
  app.post('/portal/blog/:slug/preview', async (c) => {
    editor(c);
    const slug = slugOf(c);
    const body = await jsonBody(c);
    const previewer = h.deps.sitePreview;
    if (!previewer?.blogPage) fail(503, 'This portal can’t build website previews (no site source here).');
    const committed = await guarded(() => repo.client.getPost(slug));
    const prev = committed ? await guarded(async () => parsePostFile(committed.raw)) : undefined;
    const input = parseInput(editorBody(body), prev ? postInputFromFile(slug, prev) : newPostInput(slug, ''), () => slug, false);
    const file = applyPostInput(fields(input), prev);
    let page: string;
    try {
      page = await previewer.blogPage({ slug: input.slug, markdown: serializePostFile(file) });
    } catch (err) {
      console.error(`blog preview ${slug}: ${(err as Error).message}`);
      throw jsonError(500, { error: 'preview_failed', message: 'The preview could not be built. Try again; if it keeps happening, tell the Vault team.' });
    }
    return c.html(page, 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  });

  app.get('/portal/blog/slug-check', async (c) => {
    editor(c);
    const slug = editorSlug(c.req.query('slug') ?? '');
    const current = c.req.query('current') ?? '';
    if (!slug || !isBlogSlug(slug)) return c.json({ slug, available: false });
    if (slug === current) return c.json({ slug, available: true });
    const taken = await guarded(() => repo.slugTaken(slug, current || undefined));
    return c.json({ slug, available: !taken && !scratch.has(slug) });
  });

  app.get('/portal/blog/tags', async (c) => {
    editor(c);
    const names = await guarded(() => repo.searchTags((c.req.query('q') ?? '').trim().slice(0, 50), 10));
    return c.json({ tags: names.map((name) => ({ slug: slugify(name), name })) });
  });
}

// A post's status on the posts list, by the editor's rules: a draft (draft: true, or no date) isn't on the site at all;
// otherwise a private post has a page but is in no list, tag page or feed (Unlisted).
// One post in the editor's post list (the left pane).
export interface PaneItem { slug: string; title: string; status: 'New' | 'Draft' | 'Published' | 'Unlisted'; date: string | null; image: string | null }

// The editor's left pane: every post, scrollable, each with a thumbnail (its image when that is a safe address, else
// the title's first letter), title, status and date; the one being edited is marked aria-current. Selecting one opens
// it in the editor. `items` null: the list couldn't be read. `canCreate`: show the New post button (Vault admins).
export function postsPane(items: PaneItem[] | null, current: string, canCreate = true): Html {
  const kind = { New: 'wait', Draft: 'wait', Published: 'ok', Unlisted: 'off' } as const;
  const thumb = (p: PaneItem) => p.image && isSafeImageSrc(p.image)
    ? html`<img class="be-thumb" src="${p.image}" alt="" loading="lazy" decoding="async">`
    : html`<span class="be-thumb be-thumb-ph" aria-hidden="true">${(p.title.trim()[0] ?? '?').toUpperCase()}</span>`;
  const list = items === null
    ? html`<p class="muted be-posts-msg">The post list couldn’t be loaded.</p>`
    : items.length === 0 ? html`<p class="muted be-posts-msg">No posts yet.</p>`
    : html`<ul class="be-posts-list">${items.map((p) => html`<li><a class="be-post${p.slug === current ? ' is-current' : ''}" href="/portal/blog/edit/${p.slug}" data-slug="${p.slug}"${p.slug === current ? raw(' aria-current="page"') : ''}>
        ${thumb(p)}<span class="be-post-text"><span class="be-post-title">${p.title}</span>
        <span class="be-post-meta">${pill(kind[p.status], p.status)} ${p.date ? listDate(p.date) : ''}</span></span></a></li>`)}</ul>`;
  return html`<nav class="card be-posts" aria-label="Blog posts">
    <div class="be-posts-head"><h2>Posts</h2>${canCreate ? html`<a class="btn sm pri" href="/portal/blog/new">New post</a>` : ''}</div>
    ${list}</nav>`;
}

export function postStatus(p: { draft: boolean; private: boolean; date: string | null }): 'Draft' | 'Published' | 'Unlisted' {
  if (p.draft || !p.date) return 'Draft';
  return p.private ? 'Unlisted' : 'Published';
}

// A front matter date as YYYY-MM-DD for the posts list; '—' when it is missing or isn't a date.
export function listDate(date: string | null | undefined): string {
  if (!date) return '—';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
  if (m) {
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(m[1]) ? m[1] : '—';
  }
  const t = Date.parse(date);
  return Number.isNaN(t) ? '—' : new Date(t).toISOString().slice(0, 10);
}

// "  My  Post!! " -> "my-post": lowercase a-z, 0-9 and single hyphens, at most EDITOR_MAX_SLUG characters.
export function editorSlug(input: string): string {
  return slugify(input).slice(0, EDITOR_MAX_SLUG).replace(/-+$/, '');
}
