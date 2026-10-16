// GET /v1/blog: the public blog as data, which the website build (site/scripts/pull-catalog.mjs -> site/data/blog.json)
// turns into its /blog pages and feeds with Hugo (site/content/blog/_content.gotmpl), the way /v1/catalog gives it the
// games. Visibility comes only from publicQueries.ts:
//   posts      every post viewable by direct URL (viewablePosts); `listed` is false for a private post, which gets a
//              page (noindex) but is in no list, tag page or feed
//   tags       the listable tags (listableTags), each with its listed posts, newest first
//   redirects  old slugs of viewable posts (viewableRedirects), as site addresses
// Drafts, scheduled posts and deleted posts are in none of them. Nothing in it depends on when it is asked for except
// through `now` (which posts are out yet), so the same database gives byte-identical JSON: a site build with nothing
// new changes nothing.
import type { DatabaseSync } from 'node:sqlite';
import { isSafeImageSrc, type Block } from './blocks.ts';
import { listableTags, relatedPosts, viewablePosts, viewableRedirects, type PublicPost } from './publicQueries.ts';
import { blockHtml } from './publicRender.ts';
import { imageMimeType, itemDescription } from './rss.ts';

export type PayloadBlock =
  | { type: 'heading'; level: 2 | 3 | 4; text: string }
  // `html`: the paragraph as the page shows it (sanitized again, spans made HTML), ready to insert.
  | { type: 'paragraph'; html: string }
  | { type: 'image'; src: string; url: string; alt: string; caption: string; align: string }
  | { type: 'divider' };

export interface PayloadPost {
  slug: string; title: string; author: { name: string }; published_at: string; listed: boolean; excerpt: string;
  // The RSS item's description: the excerpt, or else the start of the post's text (rss.ts itemDescription).
  description: string;
  featured_image: { url: string; alt: string; type: string | null } | null;
  tags: { slug: string; name: string }[]; blocks: PayloadBlock[]; related: string[];
}

export interface BlogPayload {
  version: 1;
  posts: PayloadPost[];
  tags: { slug: string; name: string; post_slugs: string[] }[];
  redirects: { from: string; to: string }[];
}

export const postPath = (slug: string) => `/blog/${encodeURIComponent(slug)}`;

// A block as stored, but a paragraph as its HTML. An image's src is kept as stored: an https URL (its copy on the CDN,
// site/<slug>/...) or a root-relative path on the site; one that isn't safe is left out, as the page left it out.
function payloadBlock(b: Block): PayloadBlock | null {
  switch (b.type) {
    case 'heading': return { type: 'heading', level: b.level, text: b.text };
    case 'paragraph': return { type: 'paragraph', html: String(blockHtml(b)) };
    case 'image':
      if (!isSafeImageSrc(b.src)) return null;
      return { type: 'image', src: b.src, url: b.src, alt: b.alt ?? '', caption: b.caption ?? '', align: b.align ?? '' };
    case 'divider': return { type: 'divider' };
    default: return null;
  }
}

const iso = (s: string | null) => {
  const d = s ? new Date(s) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};

const byNewest = (a: PublicPost, b: PublicPost) => {
  const pa = iso(a.published_at), pb = iso(b.published_at);
  return pa === pb ? (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) : pa < pb ? 1 : -1;
};

export function buildBlogPayload(db: DatabaseSync, o: { now: Date }): BlogPayload {
  const now = o.now.toISOString();
  const viewable = viewablePosts(db, now).sort(byNewest);
  const slugs = new Set(viewable.map((p) => p.slug));
  const listed = viewable.filter((p) => p.status === 'published');
  const posts = viewable.map((p): PayloadPost => ({
    slug: p.slug, title: p.title, author: { name: p.author }, published_at: iso(p.published_at), listed: p.status === 'published',
    excerpt: p.excerpt, description: itemDescription(p),
    featured_image: p.featured_image && isSafeImageSrc(p.featured_image)
      ? { url: p.featured_image, alt: p.title, type: imageMimeType(p.featured_image) ?? null } : null,
    tags: p.tags.map((t) => ({ slug: t.slug, name: t.name })),
    blocks: p.blocks.map(payloadBlock).filter((b): b is PayloadBlock => b !== null),
    related: relatedPosts(db, p, now).map((r) => r.slug).filter((s) => slugs.has(s)),
  }));
  const tags = listableTags(db, now).map((t) => ({ slug: t.slug, name: t.name,
    post_slugs: listed.filter((p) => p.tags.some((x) => x.slug === t.slug)).map((p) => p.slug) }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  // An old slug that a viewable post now has is that post's page, not a redirect.
  const redirects = viewableRedirects(db, now).filter((r) => !slugs.has(r.from) && slugs.has(r.to))
    .map((r) => ({ from: postPath(r.from), to: postPath(r.to) }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { version: 1, posts, tags, redirects };
}
