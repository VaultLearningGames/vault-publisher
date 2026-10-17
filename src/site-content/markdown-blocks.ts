// A blog post's body as Markdown (content/blog/<slug>/index.md in the vault-site repository) and as the editor's blocks
// (blog/blocks.ts). Pure functions. One block is one Markdown chunk; chunks are separated by a blank line:
//   heading     ## text  (### and #### for levels 3 and 4)
//   divider     ---
//   image       ![alt](src), or with a caption or an alignment Hugo's figure shortcode:
//               {{< figure src="..." alt="..." caption="..." class="align-wide" >}}
//   paragraph   spans as Markdown: **bold**, *italic*, `code`, [text](href); `<!---->` (an empty HTML comment, which
//               renders as nothing) separates two spans that would otherwise run together
//   paragraph   (editor HTML) the HTML as it is, when it starts with <p>, <ul> or <ol>; else after a
//               `<!-- vault:html -->` line. Line breaks that would make a blank line, carriage returns and `{{` (which
//               Hugo would take for a shortcode) are written &#10;, &#13; and &#123;{; sanitized HTML has no other &#.
// Text is escaped so it reads back as text: Markdown's punctuation with a backslash, and line breaks, tabs and the
// spaces at the edges of a span as character references (&#10;, &#9;, &#32;).
//
// Lossless: markdownToBlocks(blocksToMarkdown(blocks)) is blocks again, for every block validateBlocks accepts. A block
// that can't be written so it reads back exactly (a code span with a line break, say) is written as
// `<!-- vault:block {json} -->`, which reads back exactly but shows nothing on the page.
// Markdown written by hand is read as well as this format allows (h1 and h5-h6 become h2 and h4, other syntax is text).
import { isDeepStrictEqual } from 'node:util';
import { MARKS, ALIGNS, type Align, type Block, type Mark, type Span } from '../blog/blocks.ts';

// ---------- writing ----------

const ENT: Record<string, string> = { '\n': '\\\n', '\r': '&#13;', '\t': '&#9;' };

// Text as Markdown that reads back as exactly that text. `edges`: also the spaces at the start and end, which
// Markdown would drop or which would stop a delimiter from working.
function escapeText(s: string, edges: boolean): string {
  let out = s.replace(/[\\`*_[\]<>&~|#]/g, '\\$&').replace(/\{(?=\{)/g, '\\{').replace(/[\n\r\t]/g, (c) => ENT[c]);
  if (edges) out = out.replace(/^ +| +$/g, (m) => '&#32;'.repeat(m.length));
  return out;
}

// What would start something other than a paragraph at the start of a chunk: a list item, a heading, a quote, a rule.
function guardStart(md: string): string {
  return md.replace(/^([-+=])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
}

const escapeDest = (s: string) => s.replace(/[\\()<> ]/g, '\\$&');

function codeSpan(text: string): string | null {
  if (text === '' || /[\n\r]/.test(text) || text.includes('{{')) return null;
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function spanMarkdown(sp: Span): string | null {
  const m = new Set(sp.marks ?? []);
  let inner: string | null;
  if (m.has('code')) inner = codeSpan(sp.text);
  else inner = escapeText(sp.text, m.has('bold') || m.has('italic') || sp.href !== undefined);
  if (inner === null) return null;
  if (m.has('italic')) inner = `*${inner}*`;
  if (m.has('bold')) inner = `**${inner}**`;
  if (sp.href !== undefined) inner = `[${inner}](${escapeDest(sp.href)})`;
  return inner;
}

const sameFormat = (a: Span, b: Span) => a.href === b.href && (a.marks ?? []).join() === (b.marks ?? []).join();

function paragraphMarkdown(children: Span[]): string | null {
  let out = '';
  for (let i = 0; i < children.length; i++) {
    const md = spanMarkdown(children[i]);
    if (md === null) return null;
    if (i > 0 && (sameFormat(children[i - 1], children[i]) || out.at(-1) === md[0] && /[`*_\]]/.test(md[0]))) out += SEP;
    out += md;
  }
  out = out.replace(/^ +| +$/g, (m) => '&#32;'.repeat(m.length));
  return guardStart(out);
}

const SEP = '<!---->';
const HTML_MARK = '<!-- vault:html -->';
const HTML_START = /^<(p|ul|ol)>/;

function encodeHtml(html: string): string {
  const lines = html.replace(/\r/g, '&#13;').replace(/\{(?=\{)/g, '&#123;').split('\n');
  const blank = (l: string) => /^[ \t]*$/.test(l);
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) out += (blank(lines[i - 1]) || blank(lines[i]) ? '&#10;' : '\n') + lines[i];
  return out;
}
const decodeHtml = (s: string) => s.replace(/&#10;/g, '\n').replace(/&#13;/g, '\r').replace(/&#123;/g, '{');

// A shortcode parameter's value: "double quoted" (Hugo reads \" as "), else `raw` when it has a double quote.
function shortcodeValue(v: string): string | null {
  if (v.includes('}}') || v.includes('{{')) return null;
  if (!v.includes('"') && !v.endsWith('\\')) return `"${v}"`;
  if (!v.includes('`')) return `\`${v}\``;
  return null;
}

function imageMarkdown(b: Extract<Block, { type: 'image' }>): string | null {
  if (b.caption === undefined && b.align === undefined) return `![${escapeText(b.alt, true)}](${escapeDest(b.src)})`;
  const params: string[] = [];
  for (const [k, v] of [['src', b.src], ['alt', b.alt], ['caption', b.caption], ['align', b.align]] as const) {
    if (v === undefined) continue;
    const q = shortcodeValue(v);
    if (q === null) return null;
    params.push(`${k}=${q}`);
  }
  return `{{< image ${params.join(' ')} >}}`;
}

function blockMarkdown(b: Block): string | null {
  switch (b.type) {
    case 'heading': return `${'#'.repeat(b.level)} ${escapeText(b.text, true)}`;
    case 'divider': return '---';
    case 'image': return imageMarkdown(b);
    case 'paragraph':
      if (b.html !== undefined) return null; // converted to Markdown blocks first (htmlToBlocks), never written as HTML
      return paragraphMarkdown(b.children);
    default: return null;
  }
}

// The fallback: the block as JSON in an HTML comment (with no "--" or ">" in it, so the comment can't end early).
const jsonComment = (b: Block) => `<!-- vault:block ${JSON.stringify(b).replace(/-/g, '\\u002d').replace(/>/g, '\\u003e')} -->`;

const canon = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

// The Markdown of one block: its normal form when that reads back as the same block, else the JSON fallback.
export function blockToMarkdown(b: Block): string {
  const md = blockMarkdown(b);
  if (md !== null && !/\n[ \t]*\n/.test(md) && md.trim() !== '' && isDeepStrictEqual(canon(markdownToBlocks(md)), canon([b]))) return md;
  return jsonComment(b);
}

// A post body: the blocks' Markdown, a blank line between blocks, ending with a line break ('' for no blocks).
export function blocksToMarkdown(blocks: Block[], eol: '\n' | '\r\n' = '\n'): string {
  blocks = blocks.flatMap((b) => {
    if (b.type !== 'paragraph' || b.html === undefined) return [b];
    const r = htmlToBlocks(b.html);
    if (typeof r === 'string') throw new Error(r);
    return r;
  });
  if (!blocks.length) return '';
  return blocks.map(blockToMarkdown).join('\n\n').replace(/\n/g, eol) + eol;
}

// ---------- reading ----------

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const PUNCT = /[!-/:-@[-`{-~]/;

// A character reference at s[i] ('&...;'): its text and length, or null.
function entityAt(s: string, i: number): [string, number] | null {
  const m = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/.exec(s.slice(i, i + 12));
  if (!m) return null;
  if (m[3]) return m[3] in NAMED ? [NAMED[m[3]], m[0].length] : null;
  const n = m[1] ? parseInt(m[1], 10) : parseInt(m[2], 16);
  return [n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd', m[0].length];
}

// Text with Markdown's backslash escapes and character references resolved (headings, alt text).
function unescapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { out += s[i + 1]; i += 2; continue; }
    if (s[i] === '&') { const e = entityAt(s, i); if (e) { out += e[0]; i += e[1]; continue; } }
    out += s[i++];
  }
  return out;
}

interface Fmt { marks: Set<Mark>; href?: string }

class InlineParser {
  spans: Span[] = [];
  private split = false;
  private s: string;
  constructor(s: string) { this.s = s; }

  private push(text: string, f: Fmt) {
    const last = this.spans.at(-1);
    const marks = MARKS.filter((m) => f.marks.has(m));
    if (last && !this.split && (last.marks ?? []).join() === marks.join() && last.href === f.href && !f.marks.has('code')) { last.text += text; return; }
    const sp: Span = { text };
    if (marks.length) sp.marks = marks;
    if (f.href !== undefined) sp.href = f.href;
    this.spans.push(sp);
    this.split = false;
  }

  // Parses s from i in format f until `close` (a delimiter or ']'); returns the index after it, or -1 when it never
  // comes (then nothing was added).
  run(i: number, f: Fmt, close: string | null): number {
    const s = this.s;
    const mark = this.spans.length, splitWas = this.split;
    const lastText = this.spans.at(-1)?.text;
    let buf = '';
    const flush = () => { if (buf) { this.push(buf, f); buf = ''; } };
    const fail = () => { this.spans.length = mark; if (mark) this.spans[mark - 1].text = lastText!; this.split = splitWas; return -1; };
    while (i < s.length) {
      const c = s[i];
      if (close !== null && s.startsWith(close, i) && !(close === '*' && s.startsWith('**', i) && !f.marks.has('italic'))) {
        flush(); return i + close.length;
      }
      if (c === '\\' && s[i + 1] === '\n') { buf += '\n'; i += 2; continue; }
      if (c === ' ' && s[i + 1] === ' ' && /^ +\n/.test(s.slice(i))) { buf += '\n'; i = s.indexOf('\n', i) + 1; continue; }
      if (c === '\n') { buf += ' '; i++; continue; }
      if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (c === '&') { const e = entityAt(s, i); if (e) { buf += e[0]; i += e[1]; continue; } }
      if (s.startsWith(SEP, i)) { flush(); this.split = true; i += SEP.length; continue; }
      if (c === '`') {
        const run = /^`+/.exec(s.slice(i))![0];
        const end = s.indexOf(run, i + run.length);
        let j = end;
        while (j >= 0 && s[j + run.length] === '`') j = s.indexOf(run, j + run.length + 1);
        if (j < 0) { buf += run; i += run.length; continue; }
        let text = s.slice(i + run.length, j).replace(/\n/g, ' ');
        if (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') text = text.slice(1, -1);
        flush();
        this.push(text, { marks: new Set([...f.marks, 'code']), href: f.href });
        this.split = false;
        i = j + run.length;
        continue;
      }
      const strong = s.startsWith('**', i) ? '**' : s.startsWith('__', i) ? '__' : null;
      if (strong && !f.marks.has('bold')) {
        flush();
        const end = this.run(i + 2, { marks: new Set([...f.marks, 'bold']), href: f.href }, strong);
        if (end >= 0) { i = end; continue; }
      }
      if ((c === '*' || c === '_') && !f.marks.has('italic') && !(c === '_' && /\w/.test(s[i - 1] ?? ''))) {
        flush();
        const end = this.run(i + 1, { marks: new Set([...f.marks, 'italic']), href: f.href }, c);
        if (end >= 0) { i = end; continue; }
      }
      if (c === '[' && f.href === undefined) {
        flush();
        const linkFrom = this.spans.length;
        const end = this.run(i + 1, { marks: f.marks, href: '\u0000' }, ']');
        const dest = end >= 0 ? /^\(((?:\\.|[^()\\\s])*)\)/.exec(s.slice(end)) : null;
        if (end >= 0 && dest) {
          const href = unescapeText(dest[1]);
          for (const sp of this.spans.slice(linkFrom)) sp.href = href;
          // A link's spans can't merge with what comes before them.
          i = end + dest[0].length;
          continue;
        }
        if (end >= 0) { this.spans.length = linkFrom; }
      }
      buf += c; i++;
    }
    if (close !== null) return fail();
    flush();
    return i;
  }
}

// A paragraph's spans from Markdown.
export function parseInline(s: string): Span[] {
  const p = new InlineParser(s);
  p.run(0, { marks: new Set() }, null);
  // Spans of the link being built carry a placeholder href that never survives; links that never closed are text.
  return p.spans.length ? p.spans : [{ text: '' }];
}

// Hugo shortcode parameters: name="value", name=`value` or name=value.
function shortcodeParams(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const re = /\s*([A-Za-z_][\w-]*)=(?:"((?:\\"|[^"])*)"|`([^`]*)`|([^\s"`]+))/y;
  let i = 0;
  while (i < s.length) {
    if (/^\s*$/.test(s.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    out[m[1]] = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : m[3] ?? m[4];
    i = re.lastIndex;
  }
  return out;
}

function chunkBlock(chunk: string): Block {
  let m: RegExpExecArray | null;
  if ((m = /^<!-- vault:block (\{.*\}) -->$/.exec(chunk))) {
    try { const b = JSON.parse(m[1]) as Block; if (b && typeof b === 'object' && typeof b.type === 'string') return b; } catch { /* text, below */ }
  }
  if (chunk.startsWith(HTML_MARK + '\n')) {
    // Posts the older portal wrote: the marker was only a note, the text after it is Markdown (or the escaped shortcode).
    const rest = chunk.slice(HTML_MARK.length + 1);
    const sc = decodeHtml(rest).replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return chunkBlock(/^\{\{<\s*image\s/.test(sc) ? sc : rest);
  }
  if (HTML_START.test(chunk)) return { type: 'paragraph', html: decodeHtml(chunk) };
  if ((m = /^(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(chunk)) && !chunk.includes('\n')) {
    const level = Math.min(4, Math.max(2, m[1].length)) as 2 | 3 | 4;
    return { type: 'heading', level, text: unescapeText(m[2] ?? '') };
  }
  if (/^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(chunk)) return { type: 'divider' };
  if ((m = /^!\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^()\\\s])+)\)$/.exec(chunk))) return { type: 'image', src: unescapeText(m[2]), alt: unescapeText(m[1]) };
  if ((m = /^\{\{<\s*(?:image|figure)\s([\s\S]*?)\s*\/?>\}\}$/.exec(chunk))) {
    const p = shortcodeParams(m[1]);
    if (p && p.src !== undefined) {
      const b: Block = { type: 'image', src: p.src, alt: p.alt ?? '' };
      if (p.caption !== undefined) b.caption = p.caption;
      const align = p.align ?? /^align-(\w+)$/.exec(p.class ?? '')?.[1];
      if (align && (ALIGNS as readonly string[]).includes(align)) b.align = align as Align;
      return b;
    }
  }
  return { type: 'paragraph', children: parseInline(chunk) };
}

// A post body's blocks. Line endings may be LF or CRLF.
export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) { blocks.push(chunkBlock(cur.join('\n'))); cur = []; } };
  for (const line of lines) {
    if (/^[ \t]*$/.test(line)) flush();
    else cur.push(line);
  }
  flush();
  return blocks;
}

// ---------- the editor's HTML as blocks ----------
// The site renders Markdown and its own shortcodes only (raw HTML is off), so the editor's paragraph HTML is written
// as Markdown: p, h2-h4, br, strong/b, em/i, code and a. Anything else (lists, quotes, u, s, span, indent) is
// returned as an error string, so a save fails with a message rather than writing what the site would drop.
export function htmlToBlocks(html: string): Block[] | string {
  const out: Block[] = [];
  let spans: Span[] = [];
  let inP = false, head: 2 | 3 | 4 | null = null, headText = '';
  const marks = { bold: 0, italic: 0, code: 0 };
  let href: string | undefined;
  const addText = (t: string) => {
    if (!t) return;
    if (head) { headText += t; return; }
    if (!inP) { inP = true; }
    const m = MARKS.filter((k) => marks[k] > 0);
    const last = spans.at(-1);
    if (last && (last.marks ?? []).join() === m.join() && last.href === href) { last.text += t; return; }
    const sp: Span = { text: t };
    if (m.length) sp.marks = m;
    if (href !== undefined) sp.href = href;
    spans.push(sp);
  };
  const flushP = () => {
    if (!inP) return;
    inP = false;
    while (spans.length && /^\s*$/.test(spans.at(-1)!.text) && !spans.at(-1)!.marks) spans.pop();
    while (spans.length && /^\s*$/.test(spans[0].text) && !spans[0].marks) spans.shift();
    if (spans.length) out.push({ type: 'paragraph', children: spans });
    spans = [];
  };
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  for (let m; (m = re.exec(html));) {
    if (m[4] !== undefined) { const t = decodeEntities(m[4]); if (inP || head || t.trim()) addText(head ? t : inP ? t : t.trim()); continue; }
    const close = m[1] === '/', name = m[2].toLowerCase(), attrs = m[3];
    if (!close && /data-indent/i.test(attrs)) return 'indented text is not supported on the site; remove the indent';
    switch (name) {
      case 'p': if (close) flushP(); else { flushP(); inP = true; } break;
      case 'h2': case 'h3': case 'h4':
        if (close) { const t = headText.replace(/\s+/g, ' ').trim(); if (t) out.push({ type: 'heading', level: head!, text: t }); head = null; headText = ''; }
        else { flushP(); head = Number(name[1]) as 2 | 3 | 4; headText = ''; }
        break;
      case 'br': if (!close) { if (head) headText += ' '; else { const h = href, mk = { ...marks }; href = undefined; marks.bold = marks.italic = marks.code = 0; addText('\n'); href = h; Object.assign(marks, mk); } } break;
      case 'strong': case 'b': marks.bold += close ? -1 : 1; break;
      case 'em': case 'i': marks.italic += close ? -1 : 1; break;
      case 'code': marks.code += close ? -1 : 1; break;
      case 'a': if (close) href = undefined; else { const h = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs); href = h ? decodeEntities(h[1] ?? h[2]) : undefined; } break;
      default: return `<${name}> is not supported on the site (Markdown has p, headings, bold, italic, code, links and line breaks only)`;
    }
  }
  flushP();
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
