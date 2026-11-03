// A listing's Standards field (listings.ts `standards`), and the one place its text is tokenized and rendered.
//
// A standard is one item per HARD RETURN, and nothing else. Studios paste whole standard descriptions, which are
// prose full of commas ("…including cost, safety, reliability, and aesthetics…"), semicolons and pipes: treating a
// comma as a separator turned Locke's Gambit's 8 standards into 29 fragments on its page, each read as a standard
// of its own ("desires", "safety", "cultural"). So: newlines separate, every other character is part of the line's
// text and is kept verbatim.
//
// The raw text the studio typed is what is stored (listings.ts keeps the field as the studio's lines); the split
// happens on output — the catalog entry's `standards` list, and any HTML — so a stored value is never re-cut.
import { escape } from './portal/html.ts';

// A standard is a code and its whole description, so each line has room for a sentence; and no listing names
// more than this many (a paste of a whole curriculum is a mistake, not a listing).
export const MAX_STANDARD_LENGTH = 500;
export const MAX_STANDARDS = 40;

// Hard returns only: CRLF, CR and LF. Commas, semicolons, pipes and slashes are text.
const LINES = /\r\n|\r|\n/;

// The standards of `raw`, in the order they were typed: one per line, trimmed, blank lines and repeats dropped.
// A list arrives as it is (the API and the import send arrays); each of its items is split on its own newlines too,
// so every path tokenizes identically. Anything else (null, a number, an object) has no standards: [].
export function parseStandards(raw: unknown): string[] {
  const chunks: string[] = Array.isArray(raw)
    ? raw.filter((v) => typeof v === 'string' || typeof v === 'number').map(String)
    : typeof raw === 'string' ? [raw] : [];
  const out: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split(LINES)) {
      const item = line.trim();
      if (!item || out.includes(item)) continue;
      out.push(item.slice(0, MAX_STANDARD_LENGTH));
      if (out.length >= MAX_STANDARDS) return out;
    }
  }
  return out;
}

// The text a textarea shows for stored standards: one per line, so re-opening the editor gives back exactly the
// lines a save read (and a value stored before standards.ts, or an array from the API, shows as lines too).
export const standardsToText = (raw: unknown): string => parseStandards(raw).join('\n');

// The class the portal's standards list carries, so the one stylesheet rule finds it (public/portal.css).
export const STANDARDS_LIST_CLASS = 'vault-standards';

// `items` (already tokenized by parseStandards) as plain HTML: an unordered list, one list item per standard, the
// item's own text escaped (& < > " '), and nothing else — no Markdown, no linkifying, no list markers read out of
// the text, no <br>-joined run and no comma-joined paragraph, so a studio's "<" or "&" shows as typed, a comma
// stays inside its item, and a paste can never put markup on a page.
// No standards: '' — an empty <ul> is never emitted, because a game with no standards shows no Standards section.
export function renderStandardsHtml(items: string[]): string {
  if (!items.length) return '';
  const lis = items.map((s) => `<li>${escape(s)}</li>`).join('\n');
  return `<ul class="${STANDARDS_LIST_CLASS}">\n${lis}\n</ul>`;
}

// The standards of `raw` as that list: parse (hard returns only), then render. This is the only sanctioned way the
// portal emits a listing's Standards section, so anything that starts showing them goes through it rather than
// writing markup, or Markdown, of its own.
export const standardsToHtml = (raw: unknown): string => renderStandardsHtml(parseStandards(raw));
