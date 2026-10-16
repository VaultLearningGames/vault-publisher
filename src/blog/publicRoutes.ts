// Public, server-rendered blog: /blog (and /blog/), /blog/tag/<tag>, /blog/<slug>. Visibility rules are in publicQueries.ts.
// /blog/tag/:tag is registered before /blog/:slug, so a post with the slug "tag" can't be reached at /blog/tag/<x>.
import type { Context, Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { isBlogSlug, slugify } from './slug.ts';
import { listablePosts, listableTags, redirectSlug, relatedPosts, tagBySlug, viewablePost } from './publicQueries.ts';
import { catalogPage, notFoundPage, postPage, tagPage } from './publicRender.ts';

export interface BlogPublicDeps { sqlite: DatabaseSync; siteUrl: string; now?: () => Date }

export function registerBlogPublic(app: Hono, deps: BlogPublicDeps) {
  const { sqlite: db, siteUrl } = deps;
  const nowIso = () => (deps.now ? deps.now() : new Date()).toISOString();
  const send = (c: Context, body: unknown, status: 200 | 404 = 200) =>
    c.html(String(body), status, { 'Cache-Control': 'public, max-age=60' });
  const notFound = (c: Context) => send(c, notFoundPage(siteUrl), 404);

  const catalog = (c: Context) => {
    const now = nowIso();
    return send(c, catalogPage(siteUrl, listablePosts(db, now), listableTags(db, now)));
  };
  app.get('/blog', catalog);
  app.get('/blog/', catalog);

  app.get('/blog/tag/:tag', (c) => {
    let raw = c.req.param('tag');
    try { raw = decodeURIComponent(raw); } catch { /* already decoded */ }
    const slug = slugify(raw);
    if (!slug) return notFound(c);
    const now = nowIso();
    const posts = listablePosts(db, now, slug);
    const tag = posts.length ? tagBySlug(db, slug) : undefined;
    if (!tag) return notFound(c);
    return send(c, tagPage(siteUrl, tag, posts));
  });

  app.get('/blog/:slug', (c) => {
    const slug = c.req.param('slug');
    if (!isBlogSlug(slug)) return notFound(c);
    const now = nowIso();
    const post = viewablePost(db, slug, now);
    if (!post) {
      const to = redirectSlug(db, slug, now);
      return to ? c.redirect(`/blog/${encodeURIComponent(to)}`, 301) : notFound(c);
    }
    const res = send(c, postPage(siteUrl, post, relatedPosts(db, post, now)));
    if (post.status === 'private') {
      res.headers.set('X-Robots-Tag', 'noindex');
      res.headers.set('Cache-Control', 'private, no-store');
    }
    return res;
  });
}
