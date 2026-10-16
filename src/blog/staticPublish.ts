// The public blog as static files on the Vault CDN (the release bucket, the portal's `production` storage), next to
// the blog's images (site/<slug>/..., imageKey.ts). Same pages and feeds as the portal's own /blog routes
// (publicRoutes.ts), rendered by the same functions; each key is the page's address, so the pages' root-relative
// links work as they are at <CDN>/blog:
//   blog                      the catalog                blog/rss.xml               the feed of every post
//   blog/<slug>               each viewable post         blog/tag/<tag>             each tag on a listed post
//   blog/tag/<tag>/rss.xml    that tag's feed            blog/<old slug>            a renamed post's old address (a redirect page)
// Canonical, feed and item addresses point at the copy on the CDN (blogUrl); the stylesheet and the home link stay the
// site's. No key ends in "/" or ".html": the CDN's redirect rule sends a browser's page load of such an address to the
// site's /cdn<path> (docs/setup.md), and an R2 bucket serves no index.html for a folder anyway. Every write and delete is a key equal to "blog" or under "blog/"; nothing else in the bucket is touched.
//
// Event-driven: the admin routes (portal/blog-admin.ts) call publish() after a change to a public post commits (publish,
// unpublish, edit, delete), and POST /portal/api/blog/republish rebuilds on demand. Each run writes the whole blog
// (it is small, and the catalog, tag pages, feeds and "More posts" all change together) and then deletes what is no
// longer in it. Runs never overlap: calls made while one runs share the single run that starts after it.
// Off unless BLOG_STATIC_PUBLISH is set; the deploy sets it on staging only.
import type { DatabaseSync } from 'node:sqlite';
import type { Storage } from '../storage.ts';
import { html } from '../portal/html.ts';
import { listablePosts, listableTags, relatedPosts, viewablePosts, viewableRedirects } from './publicQueries.ts';
import { catalogPage, postPage, tagPage } from './publicRender.ts';
import { buildFeedXml, selectFeedPosts } from './rss.ts';

export const BLOG_PREFIX = 'blog';
export const HTML_TYPE = 'text/html; charset=utf-8';
export const RSS_TYPE = 'application/rss+xml; charset=utf-8';
// Pages and feeds change whenever a post does: a minute, as on the site (site-hosting.ts PAGE_CACHE).
export const BLOG_CACHE = 'public, max-age=60';

export interface BlogFile { body: string; contentType: string }

export const isBlogKey = (key: string) => key === BLOG_PREFIX || key.startsWith(`${BLOG_PREFIX}/`);

// `${siteUrl}/blog...` addresses (canonical links, feed links, feed items) made `${blogUrl}...`: where the copy is served.
export function rebase(text: string, siteUrl: string, blogUrl: string): string {
  const site = siteUrl.replace(/\/+$/, ''), blog = blogUrl.replace(/\/+$/, '');
  if (`${site}/blog` === blog) return text;
  const re = new RegExp(`${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/blog(?=[/"<?#&]|$)`, 'g');
  return text.replace(re, blog);
}

function redirectPage(to: string): string {
  return String(html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Moved</title>
<link rel="canonical" href="${to}"><meta http-equiv="refresh" content="${`0; url=${to}`}">
</head><body><p>This post has moved to <a href="${to}">${to}</a>.</p></body></html>`);
}

// Every file of the static blog at `now`, by key. Pure apart from reading the database.
export function renderBlogFiles(db: DatabaseSync, o: { siteUrl: string; blogUrl: string; now: Date }): Map<string, BlogFile> {
  const now = o.now.toISOString();
  const files = new Map<string, BlogFile>();
  const page = (key: string, body: unknown) => files.set(key, { body: rebase(String(body), o.siteUrl, o.blogUrl), contentType: HTML_TYPE });
  const feed = (key: string, xml: string) => files.set(key, { body: rebase(xml, o.siteUrl, o.blogUrl), contentType: RSS_TYPE });

  page(BLOG_PREFIX, catalogPage(o.siteUrl, listablePosts(db, now), listableTags(db, now)));
  feed(`${BLOG_PREFIX}/rss.xml`, buildFeedXml({ siteUrl: o.siteUrl, now: o.now, posts: selectFeedPosts(db, { now }) }));
  for (const tag of listableTags(db, now)) {
    const t = encodeURIComponent(tag.slug);
    page(`${BLOG_PREFIX}/tag/${t}`, tagPage(o.siteUrl, tag, listablePosts(db, now, tag.slug)));
    feed(`${BLOG_PREFIX}/tag/${t}/rss.xml`, buildFeedXml({ siteUrl: o.siteUrl, now: o.now, posts: selectFeedPosts(db, { now, tag: tag.slug }), tag }));
  }
  for (const post of viewablePosts(db, now)) page(`${BLOG_PREFIX}/${encodeURIComponent(post.slug)}`, postPage(o.siteUrl, post, relatedPosts(db, post, now)));
  const blog = o.blogUrl.replace(/\/+$/, '');
  for (const r of viewableRedirects(db, now)) {
    const key = `${BLOG_PREFIX}/${encodeURIComponent(r.from)}`;
    if (!files.has(key)) files.set(key, { body: redirectPage(`${blog}/${encodeURIComponent(r.to)}`), contentType: HTML_TYPE });
  }
  return files;
}

export interface BlogPublishResult { written: number; deleted: number; keys: string[] }

export interface BlogPublisherOptions {
  db: DatabaseSync;
  // The CDN bucket; null (no CDN key yet) leaves the publisher off.
  storage: Storage | null;
  enabled: boolean;
  siteUrl: string;
  // The CDN's public base URL; the blog is served at <cdnUrl>/blog.
  cdnUrl: string;
  now?: () => Date;
}

export class BlogStaticPublisher {
  private running: Promise<BlogPublishResult> | null = null;
  private queued: Promise<BlogPublishResult> | null = null;
  private readonly o: BlogPublisherOptions;
  constructor(o: BlogPublisherOptions) { this.o = o; }

  get enabled(): boolean { return this.o.enabled && !!this.o.storage; }
  get blogUrl(): string { return `${this.o.cdnUrl.replace(/\/+$/, '')}/${BLOG_PREFIX}`; }

  // Rebuilds the static blog. Rejects when it is off or the storage fails (what was written stays; the next run
  // writes everything again).
  publish(): Promise<BlogPublishResult> {
    if (!this.enabled) return Promise.reject(new Error('static blog publishing is off'));
    if (this.queued) return this.queued;
    if (this.running) {
      const q: Promise<BlogPublishResult> = this.running.catch(() => undefined).then(() => { this.queued = null; return this.start(); });
      this.queued = q;
      return q;
    }
    return this.start();
  }

  private start(): Promise<BlogPublishResult> {
    const p: Promise<BlogPublishResult> = this.run().finally(() => { if (this.running === p) this.running = null; });
    this.running = p;
    return p;
  }

  private async run(): Promise<BlogPublishResult> {
    const storage = this.o.storage!;
    const files = renderBlogFiles(this.o.db, { siteUrl: this.o.siteUrl, blogUrl: this.blogUrl, now: this.o.now ? this.o.now() : new Date() });
    for (const [key, f] of files) {
      if (!isBlogKey(key)) throw new Error(`refusing to write "${key}" outside ${BLOG_PREFIX}/`);
      const body = new TextEncoder().encode(f.body);
      await storage.put(key, body, body.byteLength, { contentType: f.contentType, cacheControl: BLOG_CACHE });
    }
    const stale = (await storage.list(BLOG_PREFIX)).map((o) => o.key).filter((k) => isBlogKey(k) && !files.has(k));
    if (stale.length) await storage.deleteKeys(stale);
    return { written: files.size, deleted: stale.length, keys: [...files.keys()].sort() };
  }
}
