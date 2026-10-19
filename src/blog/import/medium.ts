// The import of Field Day Lab's Medium blog (https://medium.com/@fielddaylab) into vault-site posts. Pure functions:
// discovery (the RSS feed, the profile's JSON stream, sitemaps, profile pages), a Medium post (RSS item, post page, or
// a post from Medium's own export) to a snapshot record, and the clean-up of Medium's HTML before the Squarespace
// import's converter (squarespace.ts convertBody) turns it into the editor's blocks:
//   - dropped: the tracking pixel (medium.com/_/stat), the title and subtitle repeated at the top of the body, Medium's
//     chrome (clap/follow/share/listen buttons, "Sign up" prompts, the "originally published in ... on Medium" footer,
//     related-post lists);
//   - h3 -> heading 2, h4 -> heading 3 (Medium's two body heading sizes); pre -> a paragraph of code; blockquotes and
//     pull quotes -> an italic paragraph, underline and strike-through -> their text (the site's Markdown has neither);
//   - YouTube and Vimeo embeds -> a paragraph linking to the video (the editor has no embed block); gists and any other
//     iframe -> a paragraph linking to what it shows;
//   - links to another Field Day Medium post -> /blog/<its slug>/.
// Images are never hotlinked: the record's images are the stored copies (`image(url)`), on the Vault CDN.
// Every record carries the post's Medium id; the apply step (medium-apply.ts) writes it to the post's front matter as
// `import_source: "medium:<id>"`, which makes the import idempotent and removable. scripts/import-medium-fielddaylab.ts
// runs it.
import { validateBlocks, type Block } from '../blocks.ts';
import { isBlogSlug, MAX_SLUG, slugify } from '../slug.ts';
import {
  convertBody, decodeEntities, importExcerpt, parseHtml, textOf, videoUrl, type El, type ImportImage, type ImportRecord, type Node,
} from './squarespace.ts';

export const MEDIUM_USER = 'fielddaylab';
export const MEDIUM_PROFILE = `https://medium.com/@${MEDIUM_USER}`;
export const MEDIUM_FEED = `https://medium.com/feed/@${MEDIUM_USER}`;
// The byline when a post has none: the profile's display name.
export const DEFAULT_AUTHOR = 'Field Day Lab';
export const SOURCE_PREFIX = 'medium:';

const squash = (s: string) => s.replace(/[\s ]+/g, ' ').trim();
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

// ---------- Medium addresses ----------

function parseUrl(url: string): URL | null {
  try { return new URL(url.trim().startsWith('//') ? `https:${url.trim()}` : url.trim(), 'https://medium.com'); } catch { return null; }
}

const isMediumHost = (host: string) => host === 'medium.com' || host.endsWith('.medium.com');

// The post id: the hex at the end of a Medium post's address (…/some-title-1a2b3c4d5e6f, /p/1a2b3c4d5e6f); else null.
export function mediumPostId(url: string): string | null {
  const u = parseUrl(url);
  if (!u) return null;
  const segs = u.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? '';
  if (segs.length === 2 && segs[0] === 'p' && /^[0-9a-f]{8,16}$/.test(last)) return last;
  const m = /(?:^|-)([0-9a-f]{8,16})$/.exec(last);
  // A bare hex segment that isn't /p/<id> is a post only on a medium host's post path (/@user/<id>).
  if (!m || (m[0] === last && !(segs.length === 2 && segs[0].startsWith('@')))) return null;
  return m[1];
}

// A Medium post's address as the import keeps it: https, no query or fragment.
export function canonicalPostUrl(url: string): string {
  const u = parseUrl(url);
  if (!u) return url;
  u.protocol = 'https:'; u.search = ''; u.hash = '';
  return u.href.replace(/\/+$/, '');
}

// Whether an address is one of this profile's posts (medium.com/@fielddaylab/…, fielddaylab.medium.com/…, /p/<id>).
export function isProfilePostUrl(url: string): boolean {
  const u = parseUrl(url);
  if (!u || !isMediumHost(u.hostname) || !mediumPostId(url)) return false;
  if (u.hostname === `${MEDIUM_USER}.medium.com`) return true;
  const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
  return first.toLowerCase() === `@${MEDIUM_USER}` || first === 'p';
}

// The slug: the address's last segment without the id, made a blog slug; else the title's.
export function mediumSlug(url: string, title = ''): string {
  const u = parseUrl(url);
  let last = u ? (u.pathname.split('/').filter(Boolean).pop() ?? '') : '';
  try { last = decodeURIComponent(last); } catch { /* keep it */ }
  const id = mediumPostId(url);
  if (id) last = last.slice(0, Math.max(0, last.length - id.length)).replace(/-+$/, '');
  const s = slugify(last) || slugify(title) || (id ? `post-${id}` : 'post');
  return s.slice(0, MAX_SLUG).replace(/-+$/, '');
}

// Medium's image ids (1*AbC.png, 0*xyz) from its CDN addresses (miro.medium.com/v2/resize:fit:700/…,
// cdn-images-1.medium.com/max/1024/…): one full-size address per image, so each image is fetched once.
export function canonicalMediumImage(url: string): string {
  const u = parseUrl(url);
  if (!u) return url;
  if (u.hostname === 'miro.medium.com' || /^cdn-images-\d+\.medium\.com$/.test(u.hostname)) {
    const id = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (/^[0-9]\*[A-Za-z0-9_.-]+$/.test(id) || /^[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp)$/i.test(id)) return `https://miro.medium.com/v2/resize:fit:2000/${id}`;
  }
  u.hash = '';
  return u.href;
}

const isTrackingPixel = (src: string) => {
  const u = parseUrl(src);
  return !!u && isMediumHost(u.hostname) && u.pathname.startsWith('/_/stat');
};

// ---------- discovery ----------

export interface Discovered { id: string; url: string; source: string }

// Post addresses of this profile in any text (HTML pages, sitemaps, JSON), deduplicated by id.
export function discoverUrls(text: string, source: string): Discovered[] {
  const out = new Map<string, Discovered>();
  const re = /(?:https?:)?(?:\\?\/\\?\/)?(?:[a-z0-9-]+\.)?medium\.com(?:\\?\/[^\s"'<>()\\]+)+|(?<=["'(])\/(?:@[A-Za-z0-9_.-]+|p)\/[^\s"'<>()\\?#]+/gi;
  for (const m of decodeEntities(text).matchAll(re)) {
    const raw = m[0].replace(/\\\//g, '/');
    const url = raw.startsWith('/') && !raw.startsWith('//') ? `https://medium.com${raw}` : raw.startsWith('//') ? `https:${raw}` : raw.startsWith('http') ? raw : `https://${raw}`;
    if (!isProfilePostUrl(url)) continue;
    const id = mediumPostId(url)!;
    if (!out.has(id)) out.set(id, { id, url: canonicalPostUrl(url), source });
  }
  return [...out.values()];
}

// <loc>s of a sitemap or sitemap index.
export function sitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
}

// Medium's legacy JSON (…?format=json) starts with an anti-hijacking prefix: ])}while(1);</x>
export function parseMediumJson(text: string): Record<string, unknown> | null {
  const i = text.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i)) as Record<string, unknown>; } catch { return null; }
}

export interface StreamPost { id: string; url: string; title: string; publishedAt: string | null; author: string | null }
export interface StreamPage { posts: StreamPost[]; next: string | null }

// One page of the profile's stream (https://medium.com/@fielddaylab/latest?format=json&limit=100): its posts and
// the cursor for the next page.
export function parseStreamPage(text: string): StreamPage {
  const json = parseMediumJson(text);
  const payload = (json?.payload ?? {}) as Record<string, unknown>;
  const refs = (payload.references ?? {}) as { Post?: Record<string, Record<string, unknown>>; User?: Record<string, Record<string, unknown>> };
  const users = refs.User ?? {};
  const posts: StreamPost[] = [];
  for (const p of Object.values(refs.Post ?? {})) {
    const id = typeof p.id === 'string' && /^[0-9a-f]{8,16}$/.test(p.id) ? p.id : null;
    if (!id) continue;
    const slug = typeof p.uniqueSlug === 'string' ? p.uniqueSlug : id;
    const at = typeof p.firstPublishedAt === 'number' && p.firstPublishedAt > 0 ? new Date(p.firstPublishedAt).toISOString() : null;
    const creator = typeof p.creatorId === 'string' ? users[p.creatorId] : undefined;
    posts.push({
      id, url: `${MEDIUM_PROFILE}/${slug}`, title: typeof p.title === 'string' ? p.title : '', publishedAt: at,
      author: typeof creator?.name === 'string' ? creator.name : null,
    });
  }
  const paging = (payload.paging ?? {}) as { next?: { to?: string | number } | null };
  const to = paging.next?.to;
  return { posts, next: to !== undefined && to !== null && String(to) ? String(to) : null };
}

// ---------- the RSS feed ----------

export interface MediumPost {
  url: string;
  id: string;
  title: string;
  subtitle: string;
  bodyHtml: string;
  publishedAt: string | null;
  author: string | null;
  tags: string[];
  // The hero image (the first one in the body unless the source names one).
  heroImage: string | null;
}

function xmlField(item: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(item);
  if (!m) return null;
  const v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  return cdata ? cdata[1] : decodeEntities(v);
}

// The feed's items as posts (the feed has only the latest ~10).
export function parseRssFeed(xml: string): MediumPost[] {
  const out: MediumPost[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const link = xmlField(item, 'link') ?? '';
    const guid = xmlField(item, 'guid') ?? '';
    const id = mediumPostId(link) ?? mediumPostId(guid);
    if (!id) continue;
    const body = xmlField(item, 'content:encoded') ?? xmlField(item, 'description') ?? '';
    const date = xmlField(item, 'pubDate');
    const at = date && !Number.isNaN(Date.parse(date)) ? new Date(Date.parse(date)).toISOString() : null;
    const tags = [...item.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map((c) => {
      const v = c[1].trim();
      return /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v)?.[1] ?? decodeEntities(v);
    });
    out.push({
      url: canonicalPostUrl(link || guid), id, title: squash(xmlField(item, 'title') ?? ''), subtitle: '', bodyHtml: body,
      publishedAt: at, author: squash(xmlField(item, 'dc:creator') ?? '') || null, tags, heroImage: null,
    });
  }
  return out;
}

// ---------- a post page, or a post from Medium's export ----------

const findAll = (nodes: Node[], pred: (e: El) => boolean, out: El[] = []): El[] => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (pred(n)) out.push(n);
    findAll(n.children, pred, out);
  }
  return out;
};
const hasClass = (e: El, c: string) => (e.attrs.class ?? '').split(/\s+/).includes(c);

function metaContent(html: string, key: string): string | null {
  for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const name = /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== key.toLowerCase()) continue;
    const c = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    if (c) return decodeEntities(c[1] ?? c[2] ?? '');
  }
  return null;
}

function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1]) as unknown;
      for (const x of Array.isArray(v) ? v : [v]) if (x && typeof x === 'object') out.push(x as Record<string, unknown>);
    } catch { /* not JSON */ }
  }
  return out;
}

function ldAuthor(v: unknown): string | null {
  const first = Array.isArray(v) ? v[0] : v;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof (first as { name?: unknown }).name === 'string') return (first as { name: string }).name;
  return null;
}

const isoDate = (s: string | null | undefined) => (s && !Number.isNaN(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null);

// A post's HTML: a page from medium.com (JSON-LD, meta tags and its <article>) or a file from Medium's export
// (posts/<date>_<title>-<id>.html: h1.p-name, section[data-field=subtitle], section[data-field=body],
// a.p-author, time.dt-published, a.p-canonical). `url`: where it came from, when the page itself doesn't say.
export function parsePostPage(html: string, url = ''): MediumPost | null {
  const tree = parseHtml(html);
  const ld = jsonLd(html).find((x) => typeof x.headline === 'string' || typeof x.datePublished === 'string') ?? {};
  const canonicalEl = findAll(tree, (e) => e.tag === 'a' && hasClass(e, 'p-canonical'))[0];
  const linkCanonical = /<link\s[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(html)?.[0];
  const canonical = canonicalEl?.attrs.href
    || (linkCanonical ? decodeEntities(/href\s*=\s*["']([^"']+)["']/i.exec(linkCanonical)?.[1] ?? '') : '')
    || metaContent(html, 'og:url') || (typeof ld.url === 'string' ? ld.url : '') || url;
  const id = mediumPostId(canonical) ?? mediumPostId(url) ?? (typeof ld.identifier === 'string' && /^[0-9a-f]{8,16}$/.test(ld.identifier) ? ld.identifier : null);
  if (!id) return null;

  const exportTitle = findAll(tree, (e) => hasClass(e, 'p-name'))[0];
  const titleEl = exportTitle ?? findAll(tree, (e) => e.tag === 'h1' && (e.attrs['data-testid'] === 'storyTitle' || hasClass(e, 'pw-post-title')))[0];
  const title = squash(clean(titleEl ? textOf(titleEl) : (typeof ld.headline === 'string' ? ld.headline : metaContent(html, 'og:title') ?? '')))
    .replace(/\s+\|\s+by\s.*$/i, '').replace(/\s+[-–|]\s+Medium$/i, '');
  const subtitleEl = findAll(tree, (e) => (e.tag === 'section' && e.attrs['data-field'] === 'subtitle') || hasClass(e, 'pw-subtitle-paragraph') || hasClass(e, 'graf--subtitle'))[0];
  const subtitle = squash(clean(subtitleEl ? textOf(subtitleEl) : ''));

  const exportBody = findAll(tree, (e) => e.tag === 'section' && e.attrs['data-field'] === 'body')[0];
  const article = exportBody ?? findAll(tree, (e) => e.tag === 'article')[0] ?? findAll(tree, (e) => e.tag === 'main')[0];
  const bodyHtml = article ? toHtml(article.children) : '';

  const authorEl = findAll(tree, (e) => e.tag === 'a' && (hasClass(e, 'p-author') || e.attrs['data-testid'] === 'authorName'))[0];
  const author = squash(clean(authorEl ? textOf(authorEl) : ldAuthor(ld.author) ?? metaContent(html, 'author') ?? '')) || null;

  const timeEl = findAll(tree, (e) => e.tag === 'time' && hasClass(e, 'dt-published'))[0];
  const publishedAt = isoDate(timeEl?.attrs.datetime) ?? isoDate(typeof ld.datePublished === 'string' ? ld.datePublished : null)
    ?? isoDate(metaContent(html, 'article:published_time'));

  const tags = new Set<string>();
  for (const k of ['keywords']) {
    const v = ld[k];
    for (const t of Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []) {
      // Medium's keywords include its own bookkeeping ("Tag:Games", "Elevated:false", "LockedPostSource:0", ...).
      if (typeof t === 'string') { const m = /^Tag:(.+)$/.exec(t.trim()); if (m) tags.add(m[1]); }
    }
  }
  for (const a of findAll(tree, (e) => e.tag === 'a' && /\/tag(?:ged)?\/[^/?#]+/.test(e.attrs.href ?? ''))) {
    if (!article || findAll(article.children, (e) => e === a).length === 0) { const t = squash(textOf(a)); if (t) tags.add(t); }
  }
  const ldImage = Array.isArray(ld.image) ? ld.image[0] : ld.image;
  const hero = (typeof ldImage === 'string' ? ldImage : null) ?? metaContent(html, 'og:image');
  return {
    url: canonicalPostUrl(canonical || url), id, title, subtitle, bodyHtml, publishedAt, author, tags: [...tags],
    heroImage: hero && !isTrackingPixel(hero) ? hero : null,
  };
}

// ---------- Medium's HTML, cleaned ----------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');

// Nodes back to HTML (parseHtml's tree; text is decoded, so it is escaped again).
export function toHtml(nodes: Node[]): string {
  return nodes.map((n) => {
    if (typeof n === 'string') return esc(n);
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
    if (VOID.has(n.tag)) return `<${n.tag}${attrs}>`;
    return `<${n.tag}${attrs}>${toHtml(n.children)}</${n.tag}>`;
  }).join('');
}

// Medium's buttons and prompts, by their test id or label.
const CHROME_TESTID = /clap|follow|share|bookmark|audio|listen|response|footer|readNext|recirc|signup|signin|authorPhoto|authorName|storyPublishDate|storyReadTime|publicationName|headerSocial|postFooter|moreFrom/i;
const CHROME_TEXT = /^(?:follow|following|share|listen|sign up|sign in|get started|open in app|member-only story|write|responses?(?: \(\d+\))?|\d+(?:\.\d+)?k?|--|·|\d+ min read|see all from .*|more from .*|recommended from medium|help|status|about|careers|press|blog|privacy|terms|text to speech|teams)$/i;
const ORIGINALLY = /\bwas originally published in\b.*\bon Medium\b|\bwhere people are continuing the conversation\b/i;

// An iframe's address: Medium wraps embeds in cdn.embedly.com/widgets/media.html?src=…&url=…; a gist is medium.com/media/<id>.
export function embedTarget(src: string): string | null {
  const u = parseUrl(src);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  if (u.hostname.endsWith('embedly.com')) {
    const inner = u.searchParams.get('url') ?? u.searchParams.get('src');
    return inner ? embedTarget(inner) : null;
  }
  return videoUrl(u.href) ?? u.href;
}

export interface CleanOptions {
  title: string;
  subtitle?: string;
  // The blog slug of another Field Day Medium post (by its Medium id), for links between them.
  postSlug?: (id: string) => string | null;
}

// The body with Medium's own markup made what convertBody reads; see the top of the file.
export function cleanMediumBody(html: string, o: CleanOptions): Node[] {
  const title = squash(o.title).toLowerCase();
  const subtitle = squash(o.subtitle ?? '').toLowerCase();
  let leading = true; // still before the first paragraph of the body (where the title and subtitle repeat)
  const walk = (nodes: Node[]): Node[] => {
    const out: Node[] = [];
    for (const n of nodes) {
      if (typeof n === 'string') { if (n.trim()) leading = false; out.push(n); continue; }
      const t = n.tag;
      if (t === 'button' || t === 'svg' || t === 'nav' || t === 'header' || t === 'footer' || t === 'aside') continue;
      if (n.attrs['data-testid'] && CHROME_TESTID.test(n.attrs['data-testid'])) continue;
      if (n.attrs['aria-label'] && /clap|follow|share|bookmark|listen|respond|more/i.test(n.attrs['aria-label']) && t !== 'figure' && t !== 'img') continue;
      if (t === 'img') {
        const src = n.attrs.src || n.attrs['data-src'] || '';
        if (!src || isTrackingPixel(src)) continue;
        out.push({ ...n, attrs: { ...n.attrs, src: canonicalMediumImage(src) } });
        leading = false;
        continue;
      }
      const text = squash(textOf(n));
      if (/^h[1-6]$/.test(t) || hasClass(n, 'graf--title') || hasClass(n, 'graf--subtitle')) {
        const lower = text.toLowerCase();
        if (leading && (lower === title || (subtitle && lower === subtitle) || hasClass(n, 'graf--title') || hasClass(n, 'graf--subtitle'))) continue;
        if (!text) continue;
      }
      if (t !== 'figure' && !findAll([n], (e) => e.tag === 'img' || e.tag === 'iframe').length && CHROME_TEXT.test(text)) continue;
      if (t === 'p' && leading && subtitle && text.toLowerCase() === subtitle && hasClass(n, 'pw-subtitle-paragraph')) continue;
      if ((t === 'p' || t === 'div') && ORIGINALLY.test(text)) continue;
      if (t === 'iframe') {
        const target = embedTarget(n.attrs.src ?? n.attrs['data-src'] ?? '');
        if (!target) continue;
        const label = squash(n.attrs.title ?? '') || (videoUrl(target) ? 'Watch the video' : 'See the embed');
        out.push({ tag: 'p', attrs: {}, children: [{ tag: 'a', attrs: { href: target }, children: [`${label}: ${target}`] }] });
        leading = false;
        continue;
      }
      if (t === 'pre') {
        // Code keeps its line breaks, as a paragraph of code.
        const lines = textOf(n).replace(/\n+$/, '').split('\n');
        const children: Node[] = [];
        lines.forEach((line, i) => { if (i) children.push({ tag: 'br', attrs: {}, children: [] }); if (line) children.push({ tag: 'code', attrs: {}, children: [line] }); });
        out.push({ tag: 'p', attrs: {}, children });
        leading = false;
        continue;
      }
      // The site's Markdown has no quotes, underline or strike-through: a quote (or pull quote) is an italic paragraph.
      if (t === 'blockquote') {
        const inner: Node[] = [];
        for (const c of walk(n.children)) {
          if (typeof c !== 'string' && c.tag === 'p') { if (inner.length) inner.push({ tag: 'br', attrs: {}, children: [] }); inner.push(...c.children); } else inner.push(c);
        }
        out.push({ tag: 'p', attrs: {}, children: [{ tag: 'em', attrs: {}, children: inner }] });
        if (text) leading = false;
        continue;
      }
      if (t === 'u' || t === 's' || t === 'strike' || t === 'del' || t === 'mark' || t === 'ins') { out.push(...walk(n.children)); continue; }
      let tag = t;
      if (t === 'h3') tag = 'h2';
      else if (t === 'h4') tag = 'h3';
      const attrs = { ...n.attrs };
      if (t === 'a') {
        const href = attrs.href ?? '';
        const id = isProfilePostUrl(href) ? mediumPostId(href) : null;
        const slug = id ? o.postSlug?.(id) : null;
        if (slug) { attrs.href = `/blog/${slug}/`; delete attrs.target; }
      }
      const children = walk(n.children);
      if (t === 'p' && text) leading = false;
      out.push({ tag, attrs, children });
    }
    return out;
  };
  return walk(parseHtml(html));
}

// ---------- a post to a snapshot record ----------

export interface MediumRecord extends ImportRecord {
  mediumId: string;
  subtitle: string;
}

// Every image address a post refers to (hero and body), as canonicalMediumImage gives them.
export function postImages(post: MediumPost): string[] {
  const body = convertBody(toHtml(cleanMediumBody(post.bodyHtml, post)), { title: post.title, image: () => null }).images;
  const hero = post.heroImage ? canonicalMediumImage(post.heroImage) : null;
  return hero && !body.includes(hero) ? [hero, ...body] : body;
}

// Tags as the site's kebab-case slugs, deduplicated, at most 20.
export function mediumTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const s = slugify(squash(clean(t)).slice(0, 50));
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 20);
}

// The first paragraph's HTML (spans as text), for the excerpt.
function firstParagraph(blocks: Block[]): string | null {
  for (const b of blocks) {
    if (b.type !== 'paragraph') continue;
    const html = b.html ?? b.children.map((c) => c.text).join('');
    if (!html.trim().startsWith('<ul') && !html.trim().startsWith('<ol')) return html;
  }
  return null;
}

export interface RecordOptions {
  slug: string;
  // The stored copy's address for an original image (canonicalMediumImage), or null when there is none.
  image: (url: string) => string | null;
  postSlug?: (id: string) => string | null;
}

export function postToRecord(post: MediumPost, o: RecordOptions): MediumRecord {
  if (!isBlogSlug(o.slug)) throw new Error(`"${o.slug}" is not a blog slug`);
  if (!post.publishedAt) throw new Error(`${post.url}: no publish date`);
  const title = squash(clean(post.title)).slice(0, 200) || 'Untitled';
  const cleaned = toHtml(cleanMediumBody(post.bodyHtml, { title, subtitle: post.subtitle, postSlug: o.postSlug }));
  const conv = convertBody(cleaned, { title, image: o.image });
  const warnings = [...conv.warnings];
  // The hero (else the body's first image) is the cover, which the site shows on cards and in feeds, not on the post.
  const heroOriginal = post.heroImage ? canonicalMediumImage(post.heroImage) : conv.images[0] ?? null;
  const cover = heroOriginal ? o.image(heroOriginal) : null;
  if (heroOriginal && !cover) warnings.push(`the cover image was left out (no stored copy of ${heroOriginal})`);
  const checked = validateBlocks(conv.blocks);
  if (!checked.ok) throw new Error(`${o.slug}: the converted body is invalid: ${checked.errors.slice(0, 3).join('; ')}`);
  const author = squash(clean(post.author ?? '')).slice(0, 120) || DEFAULT_AUTHOR;
  const subtitle = squash(clean(post.subtitle)).slice(0, 1000);
  return {
    sourceUrl: canonicalPostUrl(post.url), mediumId: post.id, slug: o.slug, title, subtitle, author_name: author,
    publishedAt: post.publishedAt,
    excerpt: subtitle || importExcerpt({}, firstParagraph(checked.blocks) ?? cleaned),
    tags: mediumTags(post.tags),
    coverImageUrl: cover,
    bodyHtml: post.bodyHtml,
    blocks: checked.blocks,
    warnings,
  };
}

// ---------- the snapshot ----------

export interface MediumSnapshot {
  version: 1;
  kind: 'medium';
  source: string;
  fetchedAt: string;
  // How many posts each discovery source found, and in all.
  discovered: Record<string, number>;
  images: Record<string, ImportImage>;
  posts: MediumRecord[];
  skipped: { sourceUrl: string; reason: string }[];
}

export const sourceMarker = (id: string) => `${SOURCE_PREFIX}${id}`;
