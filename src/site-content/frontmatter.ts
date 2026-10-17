// A blog post file's front matter: the YAML between the leading `---` lines of content/blog/<slug>/index.md.
// Pure functions. Only the small part of YAML Hugo front matter uses is read: top-level `key: value` pairs whose values
// are scalars (plain, "double" or 'single' quoted, or | and > block scalars) or lists of scalars ([a, b] or `- a` lines).
//
// Lossless: splitFrontMatter keeps every entry's text as it was. serializeFrontMatter writes an entry back exactly as
// read while its value is unchanged, writes keys it doesn't know (`extra`) verbatim, and keeps comments, blank lines,
// the key order, the line ending (LF or CRLF) and a byte-order mark. So serialize(parse(file)) is the file again, and
// parse(serialize(fm)) is fm again. Changed and new keys are written in one canonical form;
// a key whose value is the default (empty text, false, null, no items) is left out.
import { FrontMatterError } from './errors.ts';

export interface FrontMatter {
  title: string;
  // The publish date (the post's published_at), as written; null: not set.
  date: string | null;
  draft: boolean;
  // A private post has a page but is in no list, tag page or feed (the portal's status 'private').
  private: boolean;
  author: string;
  // The excerpt: the summary in lists and the page's meta description.
  description: string;
  featured_image: string | null;
  tags: string[];
  // Old addresses of the post (Hugo aliases), e.g. /blog/old-slug/.
  aliases: string[];
  // Keys this module doesn't know, each as its YAML text exactly as in the file: the `key:` line and the lines under it
  // (LF line endings). Written back unchanged.
  extra: Record<string, string>;
}

export const FRONT_MATTER_KEYS = ['title', 'date', 'draft', 'private', 'author', 'description', 'featured_image', 'tags', 'aliases'] as const;
type Known = (typeof FRONT_MATTER_KEYS)[number];
const isKnown = (k: string): k is Known => (FRONT_MATTER_KEYS as readonly string[]).includes(k);

export function emptyFrontMatter(): FrontMatter {
  return { title: '', date: null, draft: false, private: false, author: '', description: '', featured_image: null, tags: [], aliases: [], extra: {} };
}

// How a file was laid out, for writing it back the same way.
export interface FrontMatterLayout {
  bom: boolean;
  eol: '\n' | '\r\n';
  // false: the file had no front matter block.
  present: boolean;
  // The block's lines in order, grouped: a key with its lines, or (key null) blank lines and comments between keys.
  entries: { key: string | null; raw: string }[];
}

export interface SplitFile { frontMatter: FrontMatter; layout: FrontMatterLayout; body: string }

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:'"\-?{}[\],&*!|>%@`][^:#]*?)[ \t]*:(?=[ \t]|$)/;

function unquoteKey(k: string): string {
  if (k.startsWith('"')) return parseDoubleQuoted(k, 'a key');
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k;
}

// Splits a file into its front matter and the rest (the body, exactly as in the file).
export function splitFrontMatter(raw: string): SplitFile {
  const bom = raw.startsWith('﻿');
  const s = bom ? raw.slice(1) : raw;
  const open = /^---[ \t]*(\r?\n)/.exec(s);
  if (!open) {
    const eol = /\r\n/.test(s) && !/(^|[^\r])\n/.test(s) ? '\r\n' : '\n';
    return { frontMatter: emptyFrontMatter(), layout: { bom, eol, present: false, entries: [] }, body: s };
  }
  const eol = open[1] === '\r\n' ? '\r\n' : '\n';
  const rest = s.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close) throw new FrontMatterError('The front matter has no closing --- line.');
  // The block's lines, without the line break before the closing line.
  let block = rest.slice(0, close.index);
  if (eol === '\r\n') block = block.replace(/\r\n/g, '\n');
  if (block.endsWith('\n')) block = block.slice(0, -1);
  const body = rest.slice(close.index + close[0].length);
  const entries = close.index === 0 ? [] : entriesOf(block);
  const fm = emptyFrontMatter();
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.key === null) continue;
    if (seen.has(e.key)) throw new FrontMatterError(`Front matter key "${e.key}" appears twice.`);
    seen.add(e.key);
    if (isKnown(e.key)) setKnown(fm, e.key, valueText(e.raw));
    else fm.extra[e.key] = e.raw;
  }
  // An opening or closing line other than a bare --- (a closing ..., trailing spaces) and a closing line that ends the
  // file without a line break are kept as markers, so the file comes back byte for byte.
  const closeLine = close[0].replace(/\r?\n$/, '');
  if (closeLine !== '---') entries.push({ key: null, raw: `\u0000close:${closeLine}` });
  const openLine = open[0].replace(/\r?\n$/, '');
  if (openLine !== '---') entries.unshift({ key: null, raw: `\u0000open:${openLine}` });
  if (!/\r?\n$/.test(close[0])) entries.push({ key: null, raw: '\u0000noeol' });
  return { frontMatter: fm, layout: { bom, eol, present: true, entries }, body };
}

function entriesOf(block: string): { key: string | null; raw: string }[] {
  const out: { key: string | null; raw: string }[] = [];
  let cur: { key: string | null; raw: string } | null = null;
  let pending: string[] = [];
  const flush = () => { if (pending.length) { out.push({ key: null, raw: pending.join('\n') }); pending = []; } };
  for (const line of block.split('\n')) {
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) { pending.push(line); continue; }
    if (/^[ \t]/.test(line) || line === '-' || line.startsWith('- ')) {
      if (!cur) throw new FrontMatterError(`Front matter line "${line.slice(0, 60)}" is not under a key.`);
      cur.raw += '\n' + [...pending, line].join('\n');
      pending = [];
      continue;
    }
    const m = KEY_RE.exec(line);
    if (!m) throw new FrontMatterError(`Front matter line "${line.slice(0, 60)}" is not a "key: value" line.`);
    flush();
    cur = { key: unquoteKey(m[1]), raw: line };
    out.push(cur);
  }
  flush();
  return out;
}

// An entry's value: the text after `key:` and the lines under it.
function valueText(raw: string): { first: string; more: string[] } {
  const lines = raw.split('\n');
  const m = KEY_RE.exec(lines[0])!;
  return { first: lines[0].slice(m[0].length), more: lines.slice(1) };
}

type Value = { kind: 'null' } | { kind: 'scalar'; text: string; plain: boolean } | { kind: 'list'; items: string[] };

const stripComment = (s: string) => s.replace(/(^|[ \t])#.*$/, '').trim();

function parseValue(v: { first: string; more: string[] }, key: string): Value {
  const first = v.first.trim();
  const more = v.more.filter((l) => !/^[ \t]*(#.*)?$/.test(l));
  if (first === '' || first.startsWith('#')) {
    if (!more.length) return { kind: 'null' };
    if (more.every((l) => /^[ \t]*-(?:[ \t]|$)/.test(l)))
      return { kind: 'list', items: more.map((l) => scalarText(l.replace(/^[ \t]*-[ \t]?/, ''), key)) };
    // A plain scalar on the following lines.
    return { kind: 'scalar', text: more.map((l) => stripComment(l)).join(' '), plain: true };
  }
  if (first.startsWith('|') || first.startsWith('>')) return { kind: 'scalar', text: blockScalar(first, v.more, key), plain: false };
  if (first.startsWith('[')) {
    const joined = [first, ...more.map((l) => l.trim())].join(' ');
    return { kind: 'list', items: flowList(joined, key) };
  }
  if (more.length && !first.startsWith('"') && !first.startsWith("'"))
    return { kind: 'scalar', text: [stripComment(first), ...more.map((l) => stripComment(l))].join(' '), plain: true };
  if (more.length) throw new FrontMatterError(`Front matter "${key}": a quoted value must be on one line.`);
  if (first.startsWith('"') || first.startsWith("'")) {
    const { text, end } = quoted(first, 0, key);
    if (stripComment(first.slice(end)) !== '') throw new FrontMatterError(`Front matter "${key}": unexpected text after the quoted value.`);
    return { kind: 'scalar', text, plain: false };
  }
  const text = stripComment(first);
  if (text === '~' || /^null$/i.test(text)) return { kind: 'null' };
  return { kind: 'scalar', text, plain: true };
}

function scalarText(s: string, key: string): string {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const { text, end } = quoted(t, 0, key);
    if (stripComment(t.slice(end)) !== '') throw new FrontMatterError(`Front matter "${key}": unexpected text after a quoted item.`);
    return text;
  }
  if (t.startsWith('[') || t.startsWith('{') || /^-(\s|$)/.test(t)) throw new FrontMatterError(`Front matter "${key}": nested lists are not supported.`);
  return stripComment(t);
}

function flowList(s: string, key: string): string[] {
  const items: string[] = [];
  let i = 1;
  const ws = () => { while (i < s.length && /[ \t]/.test(s[i])) i++; };
  ws();
  if (s[i] === ']') { i++; }
  else for (;;) {
    ws();
    if (s[i] === '"' || s[i] === "'") { const q = quoted(s, i, key); items.push(q.text); i = q.end; }
    else {
      const m = /^[^,\]\[{}]*/.exec(s.slice(i))!;
      const t = m[0].trim();
      if (t === '') throw new FrontMatterError(`Front matter "${key}": empty list item.`);
      items.push(t); i += m[0].length;
    }
    ws();
    if (s[i] === ',') { i++; ws(); if (s[i] === ']') { i++; break; } continue; }
    if (s[i] === ']') { i++; break; }
    throw new FrontMatterError(`Front matter "${key}": a [list] is not closed or has a nested value.`);
  }
  if (stripComment(s.slice(i)) !== '') throw new FrontMatterError(`Front matter "${key}": unexpected text after the list.`);
  return items;
}

function quoted(s: string, at: number, key: string): { text: string; end: number } {
  const q = s[at];
  if (q === "'") {
    let i = at + 1, out = '';
    for (;;) {
      if (i >= s.length) throw new FrontMatterError(`Front matter "${key}": unterminated quoted value.`);
      if (s[i] === "'") { if (s[i + 1] === "'") { out += "'"; i += 2; continue; } return { text: out, end: i + 1 }; }
      out += s[i++];
    }
  }
  let i = at + 1;
  while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
  if (i >= s.length) throw new FrontMatterError(`Front matter "${key}": unterminated quoted value.`);
  return { text: parseDoubleQuoted(s.slice(at, i + 1), key), end: i + 1 };
}

const ESC: Record<string, string> = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: ' ', L: ' ', P: ' ' };

function parseDoubleQuoted(s: string, key: string): string {
  const inner = s.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { out += c; continue; }
    const e = inner[++i];
    const hex = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
    if (hex) {
      const h = inner.slice(i + 1, i + 1 + hex);
      if (!/^[0-9a-fA-F]+$/.test(h) || h.length !== hex) throw new FrontMatterError(`Front matter "${key}": bad \\${e} escape.`);
      const n = parseInt(h, 16);
      // \u escapes are UTF-16 code units (a surrogate pair is two of them), as JSON writes them.
      out += e === 'u' ? String.fromCharCode(n) : String.fromCodePoint(n);
      i += hex;
    } else if (e !== undefined && e in ESC) out += ESC[e];
    else throw new FrontMatterError(`Front matter "${key}": unknown escape \\${e ?? ''}.`);
  }
  return out;
}

function blockScalar(head: string, lines: string[], key: string): string {
  const m = /^([|>])([+-]?)([1-9]?)([+-]?)[ \t]*(#.*)?$/.exec(head);
  if (!m) throw new FrontMatterError(`Front matter "${key}": bad block scalar header "${head}".`);
  const chomp = m[2] || m[4];
  const indent = m[3] ? Number(m[3]) : Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length), Infinity);
  const body = lines.map((l) => (l.trim() ? l.slice(indent === Infinity ? 0 : indent) : ''));
  let trailing = 0;
  while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
  let text: string;
  if (m[1] === '|') text = body.join('\n');
  else {
    text = '';
    body.forEach((l, i) => {
      if (i === 0) { text = l; return; }
      const prev = body[i - 1];
      if (l === '') text += '\n';
      else if (prev === '' || /^[ \t]/.test(l) || /^[ \t]/.test(prev)) text += (prev === '' ? '' : '\n') + l;
      else text += ' ' + l;
    });
  }
  if (!body.length) return '';
  if (chomp === '-') return text;
  if (chomp === '+') return text + '\n'.repeat(trailing + 1);
  return text + '\n';
}

const isTrue = (t: string) => /^(true|True|TRUE)$/.test(t);
const isFalse = (t: string) => /^(false|False|FALSE)$/.test(t);

function setKnown(fm: FrontMatter, key: Known, v: { first: string; more: string[] }): void {
  const val = parseValue(v, key);
  switch (key) {
    case 'draft': case 'private': {
      if (val.kind === 'null') { fm[key] = false; return; }
      if (val.kind === 'scalar' && val.plain && isTrue(val.text)) { fm[key] = true; return; }
      if (val.kind === 'scalar' && val.plain && isFalse(val.text)) { fm[key] = false; return; }
      throw new FrontMatterError(`Front matter "${key}" must be true or false.`);
    }
    case 'tags': case 'aliases': {
      if (val.kind === 'null') { fm[key] = []; return; }
      if (val.kind === 'list') { fm[key] = val.items; return; }
      throw new FrontMatterError(`Front matter "${key}" must be a list.`);
    }
    case 'date': {
      if (val.kind === 'null') { fm.date = null; return; }
      if (val.kind !== 'scalar' || !val.text || Number.isNaN(Date.parse(val.text)))
        throw new FrontMatterError(`Front matter "date" must be a date, like 2026-10-16T09:00:00Z.`);
      fm.date = val.text; return;
    }
    case 'featured_image': {
      if (val.kind === 'null') { fm.featured_image = null; return; }
      if (val.kind !== 'scalar') throw new FrontMatterError('Front matter "featured_image" must be text.');
      fm.featured_image = val.text; return;
    }
    default: {
      if (val.kind === 'null') { fm[key] = ''; return; }
      if (val.kind !== 'scalar') throw new FrontMatterError(`Front matter "${key}" must be text.`);
      fm[key] = val.text;
    }
  }
}

// Reads front matter from a whole file. Throws FrontMatterError when it can't.
export function parseFrontMatter(raw: string): FrontMatter {
  return splitFrontMatter(raw).frontMatter;
}

// ---------- writing ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
// Text is written "double quoted" as JSON writes it, which is valid YAML and reads back exactly.
// (U+0085, U+2028 and U+2029, which JSON leaves as they are, are escaped too: YAML 1.1 readers take them as line breaks.)
function str(s: string): string {
  return JSON.stringify(s).replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function canonical(fm: FrontMatter, key: Known): string | null {
  switch (key) {
        case 'date': return fm.date === null ? null : `date: ${ISO_DATE.test(fm.date) ? fm.date : str(fm.date)}`;
    case 'draft': case 'private': return fm[key] ? `${key}: true` : null;
    case 'title': case 'author': case 'description': return fm[key] ? `${key}: ${str(fm[key])}` : null;
    case 'featured_image': return fm.featured_image === null ? null : `featured_image: ${str(fm.featured_image)}`;
    case 'tags': case 'aliases': return fm[key].length ? `${key}: [${fm[key].map(str).join(', ')}]` : null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

// The value an entry's text stands for, or undefined when the text can't be read.
function entryValue(key: Known, raw: string): unknown {
  try { const fm = emptyFrontMatter(); setKnown(fm, key, valueText(raw)); return fm[key]; } catch { return undefined; }
}

// Writes front matter and a body as a file. With the layout splitFrontMatter gave, unchanged entries, comments, the key
// order, line endings and a BOM are kept; without, the canonical form: known keys in FRONT_MATTER_KEYS order, then extra.
export function serializeFrontMatter(fm: FrontMatter, body: string, layout?: FrontMatterLayout): string {
  const eol = layout?.eol ?? '\n';
  const lines: string[] = [];
  let openLine = '---', closeLine = '---', closeEol = true;
  const done = new Set<string>();
  const emit = (key: string | null, raw: string | null) => { if (raw !== null) lines.push(raw); if (key) done.add(key); };
  for (const e of layout?.entries ?? []) {
    if (e.key === null) {
      if (e.raw.startsWith('\u0000open:')) openLine = e.raw.slice(6);
      else if (e.raw.startsWith('\u0000close:')) closeLine = e.raw.slice(7);
      else if (e.raw === '\u0000noeol') closeEol = false;
      else lines.push(e.raw);
      continue;
    }
    if (isKnown(e.key)) emit(e.key, sameValue(entryValue(e.key, e.raw), fm[e.key]) ? e.raw : canonical(fm, e.key));
    else if (Object.hasOwn(fm.extra, e.key)) emit(e.key, fm.extra[e.key]);
  }
  for (const key of FRONT_MATTER_KEYS) if (!done.has(key)) emit(key, canonical(fm, key));
  for (const [key, raw] of Object.entries(fm.extra)) if (!done.has(key)) emit(key, raw);
  const bom = layout?.bom ? '﻿' : '';
  // A file without front matter stays without while there is still nothing to put in it.
  if (layout && !layout.present && lines.length === 0) return bom + body;
  const block = lines.length ? lines.join('\n').split('\n').join(eol) + eol : '';
  return `${bom}${openLine}${eol}${block}${closeLine}${closeEol ? eol : ''}${body}`;
}
