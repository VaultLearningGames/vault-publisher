// The byline at the top of a public blog post (site/themes/vault-squarespace/layouts/partials/blog/post-header.html
// works these out in the site's Hugo template; this is their reference, which the tests check): the reading time, the
// post's words at 200 a minute rounded up and at least 1, and the date, "January 2, 2006" in UTC.

export const WORDS_PER_MINUTE = 200;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

type TextBlock = { type?: unknown; html?: unknown; text?: unknown; caption?: unknown; items?: unknown; children?: unknown };

function spansText(spans: unknown): string[] {
  return Array.isArray(spans) ? spans.map((s) => (typeof s?.text === 'string' ? s.text : '')) : [];
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[k] ?? m;
  });
}

/** The words a post's blocks show: paragraphs (their html's text, or their spans), headings, list items and image
 *  captions. A string is taken as the post's text itself. */
function postText(textOrBlocks: string | readonly TextBlock[]): string {
  if (typeof textOrBlocks === 'string') return textOrBlocks;
  const out: string[] = [];
  for (const b of textOrBlocks) {
    if (b.type === 'paragraph') {
      if (typeof b.html === 'string') out.push(decodeEntities(b.html.replace(/<[^>]*>/g, ' ')));
      else out.push(...spansText(b.children));
    } else if (b.type === 'heading' && typeof b.text === 'string') out.push(b.text);
    else if (b.type === 'list' && Array.isArray(b.items)) for (const it of b.items) out.push(...spansText(it));
    else if (b.type === 'image' && typeof b.caption === 'string') out.push(b.caption);
  }
  return out.join(' ');
}

/** Minutes to read a post (its text, or its blocks): words / 200, rounded up, at least 1. */
export function readingTimeMinutes(textOrBlocks: string | readonly TextBlock[]): number {
  const words = postText(textOrBlocks).match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/** "January 2, 2006" (UTC) for a date or ISO date string; '' for none or an invalid one. */
export function formatPostDate(date: Date | string | null | undefined): string {
  if (date === null || date === undefined || date === '') return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
