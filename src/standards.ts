// A listing's Standards field (listings.ts `standards`), and the one place its text is tokenized.
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

// The standards of `raw` as plain HTML: one paragraph per line, the line's own text escaped (& < > " '), nothing
// else — no Markdown, no linkifying, no list markers read out of the text, so a studio's "<" or "&" shows as typed
// and a paste can never put markup on a page. The shape is the site's own (partials/sq/game-standards.html writes
// <p class="std">…</p> for a standard it has no lookup description for), so portal-rendered standards read exactly
// as the game's page does. No standards: '' — an empty wrapper is never emitted, because a game with no standards
// shows no Standards section at all.
//
// Nothing in the portal renders standards as HTML today (the field is a textarea, and the catalog carries the list):
// this is the only sanctioned renderer, so anything that starts showing them goes through it rather than writing
// markup, or Markdown, of its own.
export function standardsToHtml(raw: unknown): string {
  const items = parseStandards(raw);
  return items.map((s) => `<p class="std">${escape(s)}</p>`).join('\n');
}
