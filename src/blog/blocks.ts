// Block schema for blog post bodies. Pure functions: validateBlocks returns the normalized blocks or a list of errors.
export const MAX_BLOCKS = 500;
export const MARKS = ['bold', 'italic', 'code'] as const;
export const ALIGNS = ['left', 'center', 'right', 'wide', 'full'] as const;
export type Mark = (typeof MARKS)[number];
export type Align = (typeof ALIGNS)[number];

export interface Span { text: string; marks?: Mark[]; href?: string }
export type Block =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; children: Span[] }
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

// Image sources: absolute https URL or a root-relative path.
export function isSafeImageSrc(src: string): boolean {
  if (src.length === 0 || src.length > 2000 || hasCtl(src) || /\s/.test(src)) return false;
  if (src.startsWith('/')) return !src.startsWith('//') && !src.startsWith('/\\');
  try { const u = new URL(src); return u.protocol === 'https:' && !!u.hostname; } catch { return false; }
}

function heading(b: Record<string, unknown>, at: string, errors: string[]): Block | null {
  unknownKeys(b, ['type', 'level', 'text'], at, errors);
  if (b.level !== 2 && b.level !== 3) errors.push(`${at}.level must be 2 or 3`);
  const text = typeof b.text === 'string' ? b.text.trim() : null;
  if (text === null) errors.push(`${at}.text must be a string`);
  else if (text.length < 1 || text.length > 300) errors.push(`${at}.text must be 1-300 characters`);
  else if (hasCtl(text) || /[\r\n]/.test(text)) errors.push(`${at}.text must be a single line of plain text`);
  return text === null ? null : { type: 'heading', level: b.level as 2 | 3, text };
}

function paragraph(b: Record<string, unknown>, at: string, errors: string[]): Block | null {
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
