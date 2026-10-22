// One-time (and safely repeatable) clean-up of copied card text (card G of "Retire Squarespace data"): a card title
// equal to the listing's title, or a card excerpt equal to its short description, is a copy of the value the card
// inherits anyway — and a stale one the moment the game is renamed. Both are cleared (stored empty), in the draft
// and in the published fields, each compared within itself, exactly (no trimming, no case folding).
//
// - The catalog doesn't change: it emits the card text or, when it is empty, the title / short description
//   (catalogEntry), so a cleared copy serializes to the same bytes.
// - It runs at every boot (server.ts): staging is re-seeded from production daily, and must be cleaned again after
//   each re-seed. A second run finds nothing and changes nothing.
// - Only card_title and card_excerpt are written; the rest of the stored JSON is kept as it is. The theme is not
//   rewritten: a stored theme that differs from the one its layout gives (expected: none) is only logged.
import type { Db } from './db.ts';
import { effectiveTheme } from './portal/listing-layout.ts';
import { deriveTheme } from './portal/listing-theme.ts';

export interface ClearCardTextResult {
  card_title: string[];      // the listings (slugs) whose card title was cleared (draft or published)
  card_excerpt: string[];    // the same for the card excerpt
  theme_mismatch: string[];  // listings whose stored theme isn't the one its layout gives (logged, not changed)
}

type Stored = Record<string, unknown>;
const PAIRS = [['card_title', 'title'], ['card_excerpt', 'short_description']] as const;

// The fields of one stored version cleared in place; which of the two were.
function clearCopies(f: Stored | null): Set<'card_title' | 'card_excerpt'> {
  const out = new Set<'card_title' | 'card_excerpt'>();
  if (!f) return out;
  for (const [card, from] of PAIRS) {
    const v = f[card];
    if (typeof v === 'string' && v !== '' && v === f[from]) { f[card] = ''; out.add(card); }
  }
  return out;
}

const parse = (json: string | null): Stored | null => {
  if (!json) return null;
  const v = JSON.parse(json) as unknown;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Stored) : null;
};

export function clearInheritedCardText(db: Db, log: (line: string) => void = console.log): ClearCardTextResult {
  const rows = db.sqlite.prepare('SELECT id, slug, draft_json, published_json FROM listings ORDER BY slug').all() as
    { id: number; slug: string; draft_json: string; published_json: string | null }[];
  const result: ClearCardTextResult = { card_title: [], card_excerpt: [], theme_mismatch: [] };
  const write = db.sqlite.prepare('UPDATE listings SET draft_json = ?, published_json = ? WHERE id = ?');
  db.sqlite.exec('BEGIN');
  try {
    for (const r of rows) {
      const draft = parse(r.draft_json), published = parse(r.published_json);
      for (const f of [draft, published]) {
        if (f && effectiveTheme(f.theme) !== deriveTheme(f.page_layout) && !result.theme_mismatch.includes(r.slug)) result.theme_mismatch.push(r.slug);
      }
      const cleared = new Set([...clearCopies(draft), ...clearCopies(published)]);
      if (!cleared.size) continue;
      write.run(draft ? JSON.stringify(draft) : r.draft_json, published ? JSON.stringify(published) : r.published_json, r.id);
      for (const k of cleared) result[k].push(r.slug);
      db.audit('system:card-text', 'listing.clear-card-text', r.slug, { fields: [...cleared].sort() });
    }
    db.sqlite.exec('COMMIT');
  } catch (err) {
    db.sqlite.exec('ROLLBACK');
    throw err;
  }
  const list = (slugs: string[]) => (slugs.length ? `: ${slugs.join(', ')}` : '');
  log(`card text: cleared card_title copying the title on ${result.card_title.length} listings${list(result.card_title)}`);
  log(`card text: cleared card_excerpt copying the short description on ${result.card_excerpt.length} listings${list(result.card_excerpt)}`);
  if (result.theme_mismatch.length) log(`card text: ${result.theme_mismatch.length} listings store a theme their layout doesn't give (left as is)${list(result.theme_mismatch)}`);
  return result;
}
