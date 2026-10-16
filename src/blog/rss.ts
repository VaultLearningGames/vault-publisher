// RSS 2.0 feeds for the public blog: /blog/rss.xml (every listable post) and /blog/tag/<tag>/rss.xml (one tag). Items
// come from listablePosts (publicQueries.ts), so a feed holds exactly what the catalog and tag pages list: status
// 'published' with a published_at at or before now. Private posts never appear. URLs are absolute against siteUrl, the
// same base as the pages' canonical links.
import type { DatabaseSync } from 'node:sqlite';
import { isSafeImageSrc, type Block } from './blocks.ts';
import { listablePosts, type PublicPost } from './publicQueries.ts';
import type { BlogTag } from './repo.ts';

export const SITE_NAME = 'Vault Learning Games';
export const FEED_LIMIT = 50;
const EXCERPT_CHARS = 300;

export const feedPath = (tagSlug?: string) => tagSlug === undefined ? '/blog/rss.xml' : `/blog/tag/${encodeURIComponent(tagSlug)}/rss.xml`;
export const feedTitle = (tag?: BlogTag) => `${SITE_NAME} Blog${tag ? ` — ${tag.name}` : ''}`;

// The newest listable posts, at most `limit`; only those carrying `tagSlug` (already slugified) when given.
export function selectFeedPosts(db: DatabaseSync, o: { now: string; tag?: string; limit?: number }): PublicPost[] {
  return listablePosts(db, o.now, o.tag).slice(0, o.limit ?? FEED_LIMIT);
}

// Escapes text for XML content and attributes, dropping characters XML 1.0 can't carry at all.
export function xmlEscape(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlToText(h: string): string {
  return h
    .replace(/<(br|\/p|\/li|\/h\d)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return ''; }
    });
}

function blocksText(blocks: Block[]): string {
  return blocks.map((b) => {
    if (b.type === 'heading') return b.text;
    if (b.type === 'paragraph') return typeof b.html === 'string' ? htmlToText(b.html) : (b.children ?? []).map((s) => s.text).join('');
    return '';
  }).join(' ');
}

// The post's excerpt; failing that, the start of its text, cut at a word boundary.
export function itemDescription(p: PublicPost): string {
  if (p.excerpt.trim()) return p.excerpt.trim();
  const text = blocksText(p.blocks).replace(/\s+/g, ' ').trim();
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > EXCERPT_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
};

// The MIME type of an image by its address's extension, or undefined for an unknown one.
export function imageMimeType(url: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(new URL(url, 'https://x.invalid').pathname)?.[1]?.toLowerCase();
  return ext ? IMAGE_TYPES[ext] : undefined;
}

// An absolute https URL and MIME type for a featured image, or undefined when it's unsafe or of an unknown type.
function enclosureOf(src: string | null, site: string): { url: string; type: string } | undefined {
  if (!src || !isSafeImageSrc(src)) return undefined;
  const url = src.startsWith('/') ? `${site}${src}` : src;
  const type = imageMimeType(url);
  return type ? { url, type } : undefined;
}

const rfc822 = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? undefined : d.toUTCString();
};

export interface FeedOptions { siteUrl: string; posts: PublicPost[]; tag?: BlogTag; now: Date }

export function buildFeedXml(o: FeedOptions): string {
  const site = o.siteUrl.replace(/\/+$/, '');
  const e = xmlEscape;
  const pageUrl = `${site}${o.tag ? `/blog/tag/${encodeURIComponent(o.tag.slug)}` : '/blog'}`;
  const selfUrl = `${site}${feedPath(o.tag?.slug)}`;
  const lastBuild = (o.posts.length && rfc822(o.posts[0].published_at)) || o.now.toUTCString();
  const description = o.tag ? `Posts tagged "${o.tag.name}" on the ${SITE_NAME} blog.` : `Posts from the ${SITE_NAME} blog.`;

  const items = o.posts.map((p) => {
    const url = `${site}/blog/${encodeURIComponent(p.slug)}`;
    const pubDate = rfc822(p.published_at);
    const enc = enclosureOf(p.featured_image, site);
    return [
      '<item>',
      `<title>${e(p.title)}</title>`,
      `<link>${e(url)}</link>`,
      `<guid isPermaLink="true">${e(url)}</guid>`,
      pubDate ? `<pubDate>${pubDate}</pubDate>` : '',
      p.author ? `<dc:creator>${e(p.author)}</dc:creator>` : '',
      `<description>${e(itemDescription(p))}</description>`,
      ...p.tags.map((t) => `<category>${e(t.name)}</category>`),
      enc ? `<enclosure url="${e(enc.url)}" length="0" type="${enc.type}"/>` : '',
      '</item>',
    ].filter(Boolean).join('\n');
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '<channel>',
    `<title>${e(feedTitle(o.tag))}</title>`,
    `<link>${e(pageUrl)}</link>`,
    `<description>${e(description)}</description>`,
    `<lastBuildDate>${lastBuild}</lastBuildDate>`,
    `<atom:link href="${e(selfUrl)}" rel="self" type="application/rss+xml"/>`,
    ...items,
    '</channel>',
    '</rss>',
    '',
  ].join('\n');
}
