// HTML for the public blog pages. The pages use the public site's stylesheet (sq/css/vault-sq.css from the Hugo theme)
// and its blog-grid / blog-item card markup, so they look like the site. There are no blog-specific styles.
// Every interpolated value is escaped by html``.
import { html, raw, type Html } from '../portal/html.ts';
import { isSafeHref, isSafeImageSrc, sanitizeParagraphHtml, type Block, type Span } from './blocks.ts';
import type { BlogTag } from './repo.ts';
import type { PublicPost } from './publicQueries.ts';
import { feedPath, feedTitle } from './rss.ts';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// <time datetime="ISO">Month D, YYYY</time> in UTC; nothing for a missing or bad date.
export function dateHtml(iso: string | null): Html {
  if (!iso) return html``;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return html``;
  return html`<time class="blog-date" datetime="${d.toISOString()}">${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}</time>`;
}

export const tagHref = (slug: string) => `/blog/tag/${encodeURIComponent(slug)}`;
const postHref = (slug: string) => `/blog/${encodeURIComponent(slug)}`;

function tagLinks(tags: BlogTag[]): Html {
  if (!tags.length) return html``;
  return html`<span class="blog-cats">${tags.map((t, i) => html`${i ? ', ' : ''}<a href="${tagHref(t.slug)}">${t.name}</a>`)}</span>`;
}

function spanHtml(s: Span): Html {
  let out: Html = html`${s.text}`;
  const marks = s.marks ?? [];
  if (marks.includes('code')) out = html`<code>${out}</code>`;
  if (marks.includes('italic')) out = html`<em>${out}</em>`;
  if (marks.includes('bold')) out = html`<strong>${out}</strong>`;
  if (s.href && isSafeHref(s.href)) out = html`<a href="${s.href}">${out}</a>`;
  return out;
}

export function blockHtml(b: Block): Html {
  switch (b.type) {
    case 'heading': return b.level === 4 ? html`<h4>${b.text}</h4>` : b.level === 3 ? html`<h3>${b.text}</h3>` : html`<h2>${b.text}</h2>`;
    case 'paragraph': {
      if (typeof b.html !== 'string') return html`<p>${(b.children ?? []).map(spanHtml)}</p>`;
      // Sanitized on save; sanitized again here so stored HTML is never trusted. Lists and <p> stand on their own.
      const clean = sanitizeParagraphHtml(b.html, 'paragraph', []) ?? '';
      return /^\s*<(p|ul|ol)>/.test(clean) ? raw(clean) : html`<p>${raw(clean)}</p>`;
    }
    case 'image':
      if (!isSafeImageSrc(b.src)) return html``;
      return html`<figure class="${`blog-figure${b.align ? ` align-${b.align}` : ''}`}"><img src="${b.src}" alt="${b.alt ?? ''}" loading="lazy">${
        b.caption ? html`<figcaption>${b.caption}</figcaption>` : ''}</figure>`;
    case 'divider': return html`<hr>`;
    default: return html``;
  }
}

export function cardHtml(p: PublicPost): Html {
  const href = postHref(p.slug);
  const img = p.featured_image && isSafeImageSrc(p.featured_image)
    ? html`<a class="blog-img" href="${href}"><img src="${p.featured_image}" alt="${p.title}" loading="lazy"></a>` : '';
  return html`<article class="blog-item">${img}
      <div class="blog-meta">${dateHtml(p.published_at)}${p.author ? html`<span class="blog-delim" aria-hidden="true"></span><span class="blog-author">${p.author}</span>` : ''}</div>
      <h1 class="blog-title"><a href="${href}">${p.title}</a></h1>
      ${p.excerpt ? html`<div class="blog-excerpt"><p>${p.excerpt}</p></div>` : ''}
      ${p.tags.length ? html`<div class="blog-meta blog-tags">${tagLinks(p.tags)}</div>` : ''}
      <a class="blog-more" href="${href}">Read More</a>
    </article>`;
}

// `feeds`: RSS autodiscovery links, each a title and a site-relative feed path.
export interface PageOptions {
  siteUrl: string; title: string; canonicalPath: string; noindex?: boolean; description?: string; feeds?: { title: string; path: string }[];
}

export function page(o: PageOptions, body: Html): Html {
  const site = o.siteUrl.replace(/\/+$/, '');
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title}</title>${o.noindex ? html`<meta name="robots" content="noindex">` : ''}${
  o.description ? html`<meta name="description" content="${o.description}">` : ''}
<link rel="canonical" href="${`${site}${o.canonicalPath}`}">${(o.feeds ?? []).map((f) =>
  html`<link rel="alternate" type="application/rss+xml" title="${f.title}" href="${`${site}${f.path}`}">`)}
<link rel="stylesheet" href="${`${site}/sq/css/fonts.css`}">
<link rel="stylesheet" href="${`${site}/sq/css/vault-sq.css`}">
</head><body>
<header class="blog-header"><a href="${`${site}/`}">Vault Learning Games</a> · <a href="/blog">Blog</a></header>
<main>${body}</main>
</body></html>`;
}

const grid = (posts: PublicPost[]) => posts.length
  ? html`<div class="blog-grid">${posts.map(cardHtml)}</div>`
  : html`<div class="blog-grid"><p class="blog-empty">No posts yet.</p></div>`;

const allFeed = { title: feedTitle(), path: feedPath() };

export function catalogPage(siteUrl: string, posts: PublicPost[], tags: BlogTag[]): Html {
  const filter = tags.length
    ? html`<nav class="blog-filter" aria-label="Tags"><ul>${tags.map((t) => html`<li><a href="${tagHref(t.slug)}">${t.name}</a></li>`)}</ul></nav>` : '';
  return page({ siteUrl, title: 'Blog', canonicalPath: '/blog', feeds: [allFeed] },
    html`<section class="sq-sec theme-white sq-blog"><div class="blog-grid"><h1>Blog</h1>${filter}</div>${grid(posts)}</section>`);
}

export function tagPage(siteUrl: string, tag: BlogTag, posts: PublicPost[]): Html {
  const feeds = [{ title: feedTitle(tag), path: feedPath(tag.slug) }, allFeed];
  return page({ siteUrl, title: `Posts tagged "${tag.name}"`, canonicalPath: tagHref(tag.slug), feeds },
    html`<section class="sq-sec theme-white sq-blog"><div class="blog-grid"><h1>Posts tagged "${tag.name}"</h1><p><a href="/blog">All posts</a></p></div>${grid(posts)}</section>`);
}

export function postPage(siteUrl: string, post: PublicPost, related: PublicPost[]): Html {
  const more = related.length
    ? html`<section class="sq-sec theme-white sq-blog blog-related"><div class="blog-grid"><h2>More posts</h2></div><div class="blog-grid">${related.map(cardHtml)}</div></section>` : '';
  return page({ siteUrl, title: post.title, canonicalPath: postHref(post.slug), noindex: post.status === 'private', description: post.excerpt || undefined },
    html`<article class="sq-sec theme-white blog-post"><div class="sq-text">
<h1>${post.title}</h1>
<div class="blog-meta">${post.author ? html`<span class="blog-author">${post.author}</span><span class="blog-delim" aria-hidden="true"></span>` : ''}${dateHtml(post.published_at)}</div>
<div class="blog-body">${post.blocks.map(blockHtml)}</div>
${post.tags.length ? html`<div class="blog-meta blog-tags">${tagLinks(post.tags)}</div>` : ''}
</div></article>${more}`);
}

export function notFoundPage(siteUrl: string): Html {
  return page({ siteUrl, title: 'Not found', canonicalPath: '/blog', noindex: true },
    html`<section class="sq-sec theme-white"><div class="sq-text"><h1>Not found</h1><p><a href="/blog">Back to the blog</a></p></div></section>`);
}
