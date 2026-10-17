// Block schema for blog post bodies. Pure functions: validateBlocks returns the normalized blocks or a list of errors.
export const MAX_BLOCKS = 500;
export const MARKS = ['bold', 'italic', 'code'] as const;
export const ALIGNS = ['left', 'center', 'right', 'wide', 'full'] as const;
export type Mark = (typeof MARKS)[number];
export type Align = (typeof ALIGNS)[number];

export interface Span { text: string; marks?: Mark[]; href?: string }
// A paragraph holds either spans or (from the editor) whitelist-sanitized HTML; see sanitizeParagraphHtml.
export type Block =
  | { type: 'heading'; level: 2 | 3 | 4; text: string }
  | { type: 'paragraph'; children: Span[]; html?: undefined }
  | { type: 'paragraph'; html: string; children?: undefined }
  | { type: 'image'; src: string; alt: string; caption?: string; align?: Align }
  | { type: 'divider' };

export type BlocksResult = { ok: true; blocks: Block[] } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasCtl = (s: string) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);

function unknownKeys(o: Record<string, unknown>, allowed: string[], at: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}: unknown key "${k}"`);
}

// Links in paragraphs: absolute http(s), mailto:, or a root-relative path ("/x", not "//x").
export function isSafeHref(href: string): boolean {
  if (href.length === 0 || href.length > 2000 || hasCtl(href) || /\s/.test(href)) return false;
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\');
  let u: URL;
  try { u = new URL(href); } catch { return false; }
  if (u.protocol === 'mailto:') return href.length > 'mailto:'.length;
  return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
}

// In-page links in editor HTML: "#" and a fragment id.
export const isFragmentHref = (href: string): boolean => /^#[A-Za-z0-9_:.-]{0,200}$/.test(href);

// Image sources: absolute https URL or a root-relative path.
export function isSafeImageSrc(src: string): boolean {
  if (src.length === 0 || src.length > 2000 || hasCtl(src) || /\s/.test(src)) return false;
  if (src.startsWith('/')) return !src.startsWith('//') && !src.startsWith('/\\');
  try { const u = new URL(src); return u.protocol === 'https:' && !!u.hostname; } catch { return false; }
}

function heading(b: Record<string, unknown>, at: string, errors: string[]): Block | null {
  unknownKeys(b, ['type', 'level', 'text'], at, errors);
  if (b.level !== 2 && b.level !== 3 && b.level !== 4) errors.push(`${at}.level must be 2, 3 or 4`);
  const text = typeof b.text === 'string' ? b.text.trim() : null;
  if (text === null) errors.push(`${at}.text must be a string`);
  else if (text.length < 1 || text.length > 300) errors.push(`${at}.text must be 1-300 characters`);
  else if (hasCtl(text) || /[\r\n]/.test(text)) errors.push(`${at}.text must be a single line of plain text`);
  return text === null ? null : { type: 'heading', level: b.level as 2 | 3 | 4, text };
}

export const MAX_PARAGRAPH_HTML = 20000;
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'h2', 'h3', 'h4', 'code', 'span']);
// Elements that may carry data-indent="1".."4" (the editor's Indent/Outdent); no other attribute but a[href] and a[target].
const INDENTABLE = new Set(['p', 'li', 'h2', 'h3', 'h4', 'blockquote']);
// Elements that end an open paragraph (or heading) instead of nesting in it, as in a browser.
const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'blockquote', 'h2', 'h3', 'h4']);
const attrValue = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : undefined;
};
// Elements dropped together with everything inside them; any other element not allowed keeps only its text.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'textarea', 'title', 'noscript', 'svg', 'math', 'select', 'xmp', 'noembed', 'noframes', 'plaintext']);
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

// Whitelist sanitizer for paragraph HTML, the one the server applies to everything the editor sends: keeps p, br,
// strong, b, em, i, u, s, strike, del, a, ul, ol, li, blockquote, h2-h4, code and span. Attributes: a[href], a[target]
// (only _blank, and then rel="noopener noreferrer" is added), and data-indent="1".."4" on p, li, h2-h4 and blockquote;
// every other attribute (style, class, on*, ...) is dropped. Other tags are removed (script-like ones with their
// content), comments dropped, text re-escaped, and tags balanced.
// An <a> whose href is not an http(s) URL, a mailto: link, a root-relative path or a #fragment (javascript:, data:, ...)
// is an error, not silently dropped. Returns the clean HTML, or null with errors pushed.
export function sanitizeParagraphHtml(input: string, at: string, errors: string[]): string | null {
  if (input.length > MAX_PARAGRAPH_HTML) { errors.push(`${at}.html must be at most ${MAX_PARAGRAPH_HTML} characters`); return null; }
  let out = '';
  const open: string[] = [];
  let skip: string | null = null;
  let bad = false;
  const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
  for (let m; (m = re.exec(input));) {
    const [, close, rawName, attrs, text] = m;
    if (text !== undefined) { if (!skip) out += escText(decodeEntities(text)); continue; }
    if (rawName === undefined) continue; // comment, doctype, processing instruction
    const name = rawName.toLowerCase();
    if (skip) { if (close && name === skip) skip = null; continue; }
    if (DROP_WITH_CONTENT.has(name)) { if (!close && !/\/\s*$/.test(attrs)) skip = name; continue; }
    if (!ALLOWED_TAGS.has(name)) continue;
    if (name === 'br') { if (!close) out += '<br>'; continue; }
    if (close) {
      const i = open.lastIndexOf(name);
      if (i < 0) continue;
      while (open.length > i) out += `</${open.pop()}>`;
      continue;
    }
    // As in a browser, a block element ends an open paragraph or heading instead of nesting in it.
    if (BLOCK_TAGS.has(name)) {
      const i = Math.max(open.lastIndexOf('p'), open.lastIndexOf('h2'), open.lastIndexOf('h3'), open.lastIndexOf('h4'));
      if (i >= 0) while (open.length > i) out += `</${open.pop()}>`;
    }
    if (name === 'a') {
      const href = attrValue(attrs, 'href');
      let tag = '<a';
      if (href !== undefined) {
        if (!isSafeHref(href) && !isFragmentHref(href)) { errors.push(`${at}.html: link "${href.slice(0, 80)}" must be an http(s) URL, a mailto: link, a path starting with / or a #fragment`); bad = true; continue; }
        tag += ` href="${escAttr(href)}"`;
      }
      if (attrValue(attrs, 'target')?.toLowerCase() === '_blank') tag += ' target="_blank" rel="noopener noreferrer"';
      out += `${tag}>`;
    } else if (INDENTABLE.has(name)) {
      const indent = attrValue(attrs, 'data-indent');
      out += indent && /^[1-4]$/.test(indent) ? `<${name} data-indent="${indent}">` : `<${name}>`;
    } else out += `<${name}>`;
    open.push(name);
  }
  while (open.length) out += `</${open.pop()}>`;
  if (hasCtl(out)) { errors.push(`${at}.html contains control characters`); return null; }
  return bad ? null : out;
}

function paragraph(b: Record<string, unknown>, at: string, errors: string[]): Block | null {
  if (b.html !== undefined) {
    unknownKeys(b, ['type', 'html'], at, errors);
    if (typeof b.html !== 'string') { errors.push(`${at}.html must be a string`); return null; }
    const clean = sanitizeParagraphHtml(b.html, at, errors);
    return clean === null ? null : { type: 'paragraph', html: clean };
  }
  unknownKeys(b, ['type', 'children'], at, errors);
  if (!Array.isArray(b.children)) { errors.push(`${at}.children must be an array`); return null; }
  const n = b.children.length;
  if (n < 1 || n > 200) { errors.push(`${at}.children must have 1-200 spans`); return null; }
  const children: Span[] = [];
  let total = 0;
  b.children.forEach((sp, j) => {
    const sat = `${at}.children[${j}]`;
    if (!isObj(sp)) { errors.push(`${sat} must be an object`); return; }
    unknownKeys(sp, ['text', 'marks', 'href'], sat, errors);
    if (typeof sp.text !== 'string') { errors.push(`${sat}.text must be a string`); return; }
    if (hasCtl(sp.text)) errors.push(`${sat}.text contains control characters`);
    if (sp.text.length === 0 && n > 1) errors.push(`${sat}.text may only be empty when it is the only span`);
    total += sp.text.length;
    const span: Span = { text: sp.text };
    if (sp.marks !== undefined) {
      if (!Array.isArray(sp.marks)) errors.push(`${sat}.marks must be an array`);
      else {
        const seen = new Set<string>();
        for (const m of sp.marks) {
          if (typeof m !== 'string' || !(MARKS as readonly string[]).includes(m)) errors.push(`${sat}.marks: "${String(m)}" is not one of ${MARKS.join(', ')}`);
          else if (seen.has(m)) errors.push(`${sat}.marks: duplicate "${m}"`);
          else seen.add(m);
        }
        if (seen.size) span.marks = MARKS.filter((m) => seen.has(m));
      }
    }
    if (sp.href !== undefined) {
      if (typeof sp.href !== 'string' || !isSafeHref(sp.href)) errors.push(`${sat}.href must be an http(s) URL, a mailto: link, or a path starting with /`);
      else span.href = sp.href;
    }
    children.push(span);
  });
  if (total > 10000) errors.push(`${at}: paragraph text must be at most 10000 characters`);
  return { type: 'paragraph', children };
}

function image(b: Record<string, unknown>, at: string, errors: string[]): Block | null {
  unknownKeys(b, ['type', 'src', 'alt', 'caption', 'align'], at, errors);
  if (typeof b.src !== 'string' || !isSafeImageSrc(b.src)) errors.push(`${at}.src must be an https URL or a path starting with /`);
  if (typeof b.alt !== 'string') errors.push(`${at}.alt must be a string`);
  else if (b.alt.length > 500 || hasCtl(b.alt)) errors.push(`${at}.alt must be at most 500 characters of plain text`);
  if (b.caption !== undefined && (typeof b.caption !== 'string' || b.caption.length > 1000 || hasCtl(b.caption)))
    errors.push(`${at}.caption must be at most 1000 characters of plain text`);
  if (b.align !== undefined && !(ALIGNS as readonly unknown[]).includes(b.align)) errors.push(`${at}.align must be one of ${ALIGNS.join(', ')}`);
  if (typeof b.src !== 'string' || typeof b.alt !== 'string') return null;
  const out: Block = { type: 'image', src: b.src, alt: b.alt.trim() };
  if (typeof b.caption === 'string' && b.caption.trim()) out.caption = b.caption.trim();
  if (b.align !== undefined) out.align = b.align as Align;
  return out;
}

export function validateBlocks(value: unknown): BlocksResult {
  const errors: string[] = [];
  if (!Array.isArray(value)) return { ok: false, errors: ['blocks must be an array'] };
  if (value.length > MAX_BLOCKS) return { ok: false, errors: [`blocks may contain at most ${MAX_BLOCKS} blocks`] };
  const blocks: Block[] = [];
  value.forEach((b, i) => {
    const at = `blocks[${i}]`;
    if (!isObj(b)) { errors.push(`${at} must be an object`); return; }
    let out: Block | null = null;
    switch (b.type) {
      case 'heading': out = heading(b, at, errors); break;
      case 'paragraph': out = paragraph(b, at, errors); break;
      case 'image': out = image(b, at, errors); break;
      case 'divider': unknownKeys(b, ['type'], at, errors); out = { type: 'divider' }; break;
      default: errors.push(`${at}.type "${String(b.type)}" is not one of heading, paragraph, image, divider`);
    }
    if (out) blocks.push(out);
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, blocks };
}
