// The one-time import of the Squarespace blog (https://vault-games-library.squarespace.com/blog) into vault-site posts.
// Pure functions: a Squarespace post (its ?format=json item) to a snapshot record, and its body HTML to the editor's
// blocks (blog/blocks.ts), every paragraph through the editor's own sanitizer (sanitizeParagraphHtml):
//   p -> paragraph; h1, h2 -> heading 2; h3-h6 -> heading 3; ul, ol -> paragraph (list HTML); blockquote -> paragraph
//   (quote HTML); img, figure, Squarespace image blocks -> image (its stored copy, alt falling back to the post title,
//   caption); hr -> divider; YouTube and Vimeo embeds -> a paragraph linking to the video (there is no embed block);
//   loose inline content -> paragraph; any other element -> a paragraph of its text, with a warning.
// Links keep only http(s) and mailto: hrefs (links to the Squarespace blog become /blog/<slug>/); bold, italic,
// underline, strike and code are kept. script, style, iframe, noscript, on* and every other attribute are dropped.
// Images are never hotlinked: `image(url)` gives the stored copy's address, and an image without one is left out.
// scripts/import-squarespace-blog.ts fetches the blog, stores the images and writes the posts.
import { sanitizeParagraphHtml, validateBlocks, type Block } from '../blocks.ts';
import { isBlogSlug, MAX_SLUG, slugify, uniqueSlug } from '../slug.ts';

export const SQUARESPACE_ORIGIN = 'https://vault-games-library.squarespace.com';
export const EXCERPT_CHARS = 200;

// ---------- a small HTML tree ----------

export interface El { tag: string; attrs: Record<string, string>; children: Node[] }
export type Node = El | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Raw text elements: their content is not markup.
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript']);
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m; (m = re.exec(s));) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// Lenient: unclosed elements close at their parent's end tag, stray end tags are ignored.
export function parseHtml(input: string): Node[] {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
  for (let m; (m = re.exec(input));) {
    const [, close, rawName, attrs, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) { top.children.push(decodeEntities(text)); continue; }
    if (rawName === undefined) continue;
    const tag = rawName.toLowerCase();
    if (close) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const el: El = { tag, attrs: parseAttrs(attrs), children: [] };
    top.children.push(el);
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    if (RAW.has(tag)) {
      const end = input.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      const stop = end < 0 ? input.length : end;
      re.lastIndex = stop;
      continue;
    }
    stack.push(el);
  }
  return root.children;
}

export function textOf(n: Node): string {
  if (typeof n === 'string') return n;
  if (n.tag === 'br') return '\n';
  return n.children.map(textOf).join('');
}
const squash = (s: string) => s.replace(/[\s ]+/g, ' ').trim();
const hasCtl = (s: string) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

// Text with a space between block elements (paragraphs, list items, cells), which textOf runs together.
function spacedText(n: Node): string {
  if (typeof n === 'string') return n;
  if (n.tag === 'br') return ' ';
  const inner = n.children.map(spacedText).join('');
  return INLINE.has(n.tag) ? inner : ` ${inner} `;
}

// The plain text of some HTML, on one line.
export function plainText(html: string): string {
  return squash(parseHtml(html).map(spacedText).join(''));
}

// ---------- links and media ----------

// A link as the import keeps it: http(s) and mailto:, a link into the Squarespace blog as /blog/<slug>/; else null.
export function importHref(href: string | undefined): string | null {
  const h = (href ?? '').trim();
  if (!h || hasCtl(h) || /\s/.test(h)) return null;
  let u: URL;
  try { u = new URL(h, SQUARESPACE_ORIGIN); } catch { return null; }
  if (u.protocol === 'mailto:') return h.length > 'mailto:'.length ? h : null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin === SQUARESPACE_ORIGIN) {
    const m = /^\/blog\/([^/?#]+)\/?$/.exec(u.pathname);
    const slug = m ? slugify(decodeURIComponent(m[1])) : '';
    if (slug) return `/blog/${slug}/`;
    if (h.startsWith('/') || h.startsWith('#')) return null;
  }
  return u.href.length <= 2000 ? u.href : null;
}

// A YouTube or Vimeo video's watch address, from an embed or watch URL; null for anything else.
export function videoUrl(src: string | undefined): string | null {
  if (!src) return null;
  let u: URL;
  try { u = new URL(src.startsWith('//') ? `https:${src}` : src); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const id = (s: string | undefined | null) => (s && /^[A-Za-z0-9_-]{6,20}$/.test(s) ? s : null);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = id(u.searchParams.get('v')) ?? id(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/.exec(u.pathname)?.[1]);
    return v ? `https://www.youtube.com/watch?v=${v}` : null;
  }
  if (host === 'youtu.be') { const v = id(u.pathname.slice(1)); return v ? `https://www.youtube.com/watch?v=${v}` : null; }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const v = /\/(\d{4,12})(?:[/?#]|$)/.exec(u.pathname)?.[1];
    return v ? `https://vimeo.com/${v}` : null;
  }
  return null;
}

// An image element's source: Squarespace lazy-loads them (data-src, data-image), so src may be missing or a stub.
export function imageSrc(el: El): string | null {
  const s = el.attrs['data-src'] || el.attrs['data-image'] || el.attrs.src || '';
  if (!s || s.startsWith('data:')) return null;
  try { return new URL(s.startsWith('//') ? `https:${s}` : s, SQUARESPACE_ORIGIN).href; } catch { return null; }
}

// The original's address without the size Squarespace's CDN adds (?format=1500w), so each image is fetched once.
export function canonicalImageUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)squarespace-cdn\.com$/.test(u.hostname) || /(^|\.)squarespace\.com$/.test(u.hostname)) { u.search = ''; u.hash = ''; }
    return u.href;
  } catch { return url; }
}

// ---------- body HTML to blocks ----------

export interface ConvertOptions {
  title: string;
  // The stored copy's address for an original image URL (canonicalImageUrl), or null when there is none.
  image: (url: string) => string | null;
}
export interface ConvertResult { blocks: Block[]; warnings: string[]; images: string[] }

const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'label']);
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'center', 'body', 'html', 'picture', 'span']);
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'object', 'embed', 'form', 'input', 'button', 'select',
  'textarea', 'link', 'meta', 'title', 'head', 'source', 'track', 'video', 'audio', 'canvas']);
// Inline tags the editor's sanitizer keeps; the others keep only their content.
const KEEP_INLINE: Record<string, string> = { b: 'strong', strong: 'strong', i: 'em', em: 'em', u: 'u', s: 's', strike: 's', del: 's', code: 'code' };

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

export function convertBody(html: string, o: ConvertOptions): ConvertResult {
  const blocks: Block[] = [];
  const warnings: string[] = [];
  const images: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };

  // Inline nodes as the sanitizer's HTML.
  const inline = (nodes: Node[]): string => nodes.map((n) => {
    if (typeof n === 'string') return escText(clean(n));
    if (DROP.has(n.tag) || n.tag === 'iframe' || n.tag === 'img') return '';
    if (n.tag === 'br') return '<br>';
    const inner = inline(n.children);
    if (n.tag === 'a') {
      const href = importHref(n.attrs.href);
      if (!href) return inner;
      return `<a href="${escAttr(href)}"${n.attrs.target === '_blank' ? ' target="_blank"' : ''}>${inner}</a>`;
    }
    const keep = KEEP_INLINE[n.tag];
    if (keep && inner.trim()) return `<${keep}>${inner}</${keep}>`;
    if (n.tag === 'p' || n.tag === 'div') return `${inner}<br>`;
    return inner;
  }).join('');

  const pushHtml = (htmlOut: string, fallback: string) => {
    const errors: string[] = [];
    const sane = sanitizeParagraphHtml(htmlOut, 'import', errors);
    if (sane !== null && plainText(sane)) { blocks.push({ type: 'paragraph', html: sane }); return; }
    if (sane === null) warn(`a passage could not be kept as HTML and was imported as text (${errors[0] ?? 'invalid'})`);
    pushText(fallback);
  };
  const pushText = (text: string) => {
    const t = squash(clean(text));
    for (let i = 0; i < t.length; i += 10000) blocks.push({ type: 'paragraph', children: [{ text: t.slice(i, i + 10000) }] });
  };
  const pushParagraph = (nodes: Node[]) => {
    const body = inline(nodes).replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
    if (!squash(textOf({ tag: 'p', attrs: {}, children: nodes }))) return;
    pushHtml(`<p>${body}</p>`, textOf({ tag: 'p', attrs: {}, children: nodes }));
  };
  const pushLink = (url: string, label: string) => blocks.push({ type: 'paragraph', children: [{ text: label, href: url }] });
  const pushImage = (el: El, caption?: string) => {
    const src = imageSrc(el);
    if (!src) return;
    const original = canonicalImageUrl(src);
    if (!images.includes(original)) images.push(original);
    const stored = o.image(original);
    if (!stored) { warn(`an image was left out (no stored copy of ${original})`); return; }
    const alt = squash(clean(el.attrs.alt ?? '')).slice(0, 500) || o.title.slice(0, 500);
    const b: Extract<Block, { type: 'image' }> = { type: 'image', src: stored, alt };
    const cap = squash(clean(caption ?? '')).slice(0, 1000);
    if (cap) b.caption = cap;
    blocks.push(b);
  };
  const findAll = (n: Node, tag: string, out: El[] = []): El[] => {
    if (typeof n === 'string') return out;
    if (n.tag === tag) out.push(n);
    for (const c of n.children) findAll(c, tag, out);
    return out;
  };
  // A Squarespace video or embed block: data-block-json carries the video's url; else its iframe's src.
  const embedOf = (el: El): string | null => {
    const json = el.attrs['data-block-json'];
    if (json) {
      try {
        const d = JSON.parse(json) as Record<string, unknown>;
        for (const k of ['url', 'resolvedBy', 'html']) {
          const v = typeof d[k] === 'string' ? (d[k] as string) : '';
          const direct = videoUrl(v);
          if (direct) return direct;
          const m = /src=["']([^"']+)["']/.exec(v);
          if (m && videoUrl(m[1])) return videoUrl(m[1]);
        }
      } catch { /* not JSON */ }
    }
    const html = el.attrs['data-html'];
    if (html) { const m = /src=["']([^"']+)["']/.exec(html); if (m && videoUrl(m[1])) return videoUrl(m[1]); }
    return null;
  };

  const walk = (nodes: Node[]) => {
    let run: Node[] = [];
    const flush = () => { if (run.length) pushParagraph(run); run = []; };
    for (const n of nodes) {
      if (typeof n === 'string') { run.push(n); continue; }
      const t = n.tag;
      if (DROP.has(t)) continue;
      if (t === 'span' && n.children.every((c) => typeof c === 'string' || INLINE.has(c.tag))) { run.push(n); continue; }
      if (INLINE.has(t) && t !== 'span') {
        // An inline element holding images (a linked image): the images, then the rest inline.
        const imgs = findAll(n, 'img');
        if (imgs.length) { flush(); for (const img of imgs) pushImage(img); const rest = squash(textOf(n)); if (rest) pushParagraph([n]); continue; }
        run.push(n); continue;
      }
      flush();
      const video = embedOf(n);
      if (video) { pushLink(video, `Watch the video: ${video}`); continue; }
      if (t === 'p') {
        const imgs = findAll(n, 'img');
        for (const img of imgs) pushImage(img);
        pushParagraph(n.children);
      } else if (t === 'h1' || t === 'h2' || t === 'h3' || t === 'h4' || t === 'h5' || t === 'h6') {
        const text = squash(clean(textOf(n))).slice(0, 300).trim();
        if (text) blocks.push({ type: 'heading', level: t === 'h1' || t === 'h2' ? 2 : 3, text });
      } else if (t === 'ul' || t === 'ol') {
        const items = n.children.filter((c): c is El => typeof c !== 'string' && c.tag === 'li');
        const lis = items.map((li) => `<li>${inline(li.children.flatMap((c) => (typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol')) ? [] : [c])).replace(/(<br>)+$/, '')}</li>`).join('');
        if (items.length) pushHtml(`<${t}>${lis}</${t}>`, items.map(textOf).join(' · '));
      } else if (t === 'blockquote') {
        const body = inline(n.children).replace(/^(\s|<br>)+|(\s|<br>)+$/g, '');
        if (squash(textOf(n))) pushHtml(`<blockquote>${body}</blockquote>`, textOf(n));
      } else if (t === 'img') {
        pushImage(n);
      } else if (t === 'figure') {
        const cap = findAll(n, 'figcaption')[0];
        const imgs = findAll(n, 'img');
        imgs.forEach((img, i) => pushImage(img, i === imgs.length - 1 && cap ? textOf(cap) : undefined));
        if (!imgs.length) walk(n.children);
      } else if (t === 'hr') {
        blocks.push({ type: 'divider' });
      } else if (t === 'iframe') {
        const v = videoUrl(n.attrs.src ?? n.attrs['data-src']);
        if (v) pushLink(v, `Watch the video: ${v}`);
        else warn(`an embedded frame was left out (${(n.attrs.src ?? '').slice(0, 120)})`);
      } else if (t === 'figcaption' || t === 'br') {
        continue;
      } else if (CONTAINERS.has(t)) {
        // Squarespace's image blocks: the image and the caption beside it rather than in a figure.
        if (/\bimage-block\b/.test(n.attrs.class ?? '') && !findAll(n, 'figure').length) {
          const imgs = findAll(n, 'img');
          const capEl = findAll(n, 'figcaption')[0] ?? findAll(n, 'div').find((d) => /image-caption/.test(d.attrs.class ?? ''));
          imgs.forEach((img, i) => pushImage(img, i === imgs.length - 1 && capEl ? textOf(capEl) : undefined));
          if (imgs.length) continue;
        }
        walk(n.children);
      } else if (t === 'li') {
        pushParagraph(n.children);
      } else {
        const text = spacedText(n);
        if (squash(text)) { warn(`<${t}> was imported as plain text`); pushText(text); }
      }
    }
    flush();
  };
  walk(parseHtml(html));
  // Consecutive dividers, and dividers at the edges, are Squarespace spacing.
  const out = blocks.filter((b, i) => b.type !== 'divider' || (i > 0 && i < blocks.length - 1 && blocks[i - 1].type !== 'divider'));
  return { blocks: out, warnings, images };
}

// ---------- a Squarespace item to a snapshot record ----------

// A Squarespace blog item, as /blog?format=json lists it and /blog/<slug>?format=json has it (item).
export interface SquarespaceItem {
  title?: string; fullUrl?: string; urlId?: string; publishOn?: number | string; addedOn?: number; excerpt?: string; body?: string;
  tags?: string[]; categories?: string[]; author?: { displayName?: string } | null; assetUrl?: string; workflowState?: number;
  recordTypeLabel?: string; starred?: boolean;
}

export interface ImportRecord {
  sourceUrl: string;
  slug: string;
  title: string;
  author_name: string | null;
  publishedAt: string;
  excerpt: string;
  tags: string[];
  coverImageUrl: string | null;
  bodyHtml: string;
  blocks: Block[];
  warnings: string[];
}

// Why an item isn't imported (a draft or a scheduled post), or null when it is.
export function skipReason(item: SquarespaceItem, now = Date.now()): string | null {
  if (item.workflowState !== undefined && item.workflowState !== 1) return 'not published (a draft)';
  const at = publishTime(item);
  if (at === null) return 'no publish date';
  if (at > now) return 'scheduled for later';
  return null;
}

function publishTime(item: SquarespaceItem): number | null {
  const v = item.publishOn ?? item.addedOn;
  if (v === undefined || v === null) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// The post's slug from its Squarespace address: the last path segment, lowercased and made a blog slug.
export function sourceSlug(item: SquarespaceItem): string {
  const path = (item.fullUrl ?? item.urlId ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
  const last = path.slice(path.lastIndexOf('/') + 1);
  let s = last;
  try { s = decodeURIComponent(last); } catch { /* keep it */ }
  const lower = s.toLowerCase();
  return isBlogSlug(lower) ? lower : slugify(s) || slugify(item.title ?? '') || 'post';
}

// Tags and categories, deduplicated by their slug (case-insensitively), the first spelling kept; at most 20.
export function importTags(item: SquarespaceItem): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...(item.tags ?? []), ...(item.categories ?? [])]) {
    if (typeof t !== 'string') continue;
    const name = squash(clean(t)).slice(0, 50).trim();
    const s = slugify(name);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(name);
  }
  return out.slice(0, 20);
}

// The excerpt: Squarespace's (as text), else the start of the body's text, cut at a word.
export function importExcerpt(item: SquarespaceItem, body: string): string {
  const own = plainText(item.excerpt ?? '');
  if (own) return own.slice(0, 1000);
  const text = plainText(body);
  if (text.length <= EXCERPT_CHARS) return text;
  const cut = text.slice(0, EXCERPT_CHARS);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > EXCERPT_CHARS / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

// A snapshot record for an item. `taken`: slugs already used (earlier items); the record's slug avoids them.
export function itemToRecord(item: SquarespaceItem, o: { image: (url: string) => string | null; taken: (slug: string) => boolean }): ImportRecord {
  const title = squash(clean(item.title ?? '')).slice(0, 200) || 'Untitled';
  const body = item.body ?? '';
  const conv = convertBody(body, { title, image: o.image });
  const base = sourceSlug(item).slice(0, MAX_SLUG).replace(/-+$/, '');
  const slug = uniqueSlug(base, o.taken);
  const warnings = [...conv.warnings];
  if (slug !== base) warnings.push(`slug ${base} was taken; imported as ${slug}`);
  const checked = validateBlocks(conv.blocks);
  if (!checked.ok) throw new Error(`${slug}: the converted body is invalid: ${checked.errors.slice(0, 3).join('; ')}`);
  const cover = item.assetUrl ? o.image(canonicalImageUrl(item.assetUrl)) : null;
  if (item.assetUrl && !cover) warnings.push(`the cover image was left out (no stored copy of ${item.assetUrl})`);
  const author = squash(clean(item.author?.displayName ?? '')).slice(0, 120);
  const at = publishTime(item);
  return {
    sourceUrl: new URL(item.fullUrl ?? `/blog/${slug}`, SQUARESPACE_ORIGIN).href,
    slug, title, author_name: author || null,
    publishedAt: new Date(at ?? 0).toISOString(),
    excerpt: importExcerpt(item, body),
    tags: importTags(item),
    coverImageUrl: cover,
    bodyHtml: body,
    blocks: checked.blocks,
    warnings,
  };
}

// Every image address a post refers to (cover and body), as canonicalImageUrl gives them.
export function itemImages(item: SquarespaceItem): string[] {
  const out = convertBody(item.body ?? '', { title: item.title ?? '', image: () => null }).images;
  if (item.assetUrl) { const c = canonicalImageUrl(item.assetUrl); if (!out.includes(c)) out.unshift(c); }
  return out;
}

// ---------- the snapshot ----------

// key: its CDN object (blog/imageKey.ts, site/<post slug>/<sha-256>.<ext>), url: its CDN address, file: the downloaded
// copy beside the snapshot (images/<sha-256>.<ext>) that the apply step uploads.
export interface ImportImage { key: string; url: string; file: string; contentType: string; bytes: number }
export interface ImportSnapshot {
  version: 1;
  source: string;
  fetchedAt: string;
  // Original image address (canonicalImageUrl) -> its stored copy.
  images: Record<string, ImportImage>;
  posts: ImportRecord[];
  skipped: { sourceUrl: string; reason: string }[];
}

// The snapshot's posts as the editor's fields (blog/repo.ts BlogPostInput).
export function recordInput(r: ImportRecord) {
  return {
    title: r.title, blocks: r.blocks, excerpt: r.excerpt, featured_image: r.coverImageUrl, author: r.author_name ?? '',
    status: 'published' as const, published_at: r.publishedAt, tags: [...r.tags],
  };
}
