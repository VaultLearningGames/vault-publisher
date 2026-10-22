// The card categories and card tags of a site listing (card C of "Retire Squarespace data"): they are no longer
// free text but choices from option lists — the GRADES bands, the SUBJECTS and TOPICS the portal already carries,
// and the studio list (the developer), which is not a static enum: it is the portal's own studios table.
//
// Every option is { value, label }: value is the kebab-case id stored in the listing (and in the catalog), label is
// what people read. A listing's card_categories / card_tags are JSON arrays of { kind, value }, one per choice:
// the categories are grades and the developer/studio, the tags are subjects and topics.
//
// reconcile() matches the old Squarespace strings ("Grades 5-8", "Dev: Field Day Lab", "Subject: Science",
// "Topic: Civics") against the options, case/whitespace/punctuation-blind (normalizeEnumValue), so the migration
// of the 99 games.json cards fills the fields without a person retyping them; what doesn't match is listed for
// review (docs/listing-enum-reconciliation.md).
import type { Db } from '../db.ts';

export interface EnumOption { value: string; label: string }

export type CardTagKind = 'grade' | 'subject' | 'topic' | 'studio';
export interface CardTag { kind: CardTagKind; value: string }

// A card category: a grade band or the developer (a studio); a card tag: a subject or a topic.
export const CARD_CATEGORY_KINDS: readonly CardTagKind[] = ['grade', 'studio'] as const;
export const CARD_TAG_KINDS: readonly CardTagKind[] = ['subject', 'topic'] as const;
export const CARD_KINDS: readonly CardTagKind[] = [...CARD_CATEGORY_KINDS, ...CARD_TAG_KINDS] as readonly CardTagKind[];

// Seeded from the portal's existing Grades bands (listings.ts GRADES).
export const GRADES: EnumOption[] = [
  { value: 'k-3', label: 'Grades K-3' },
  { value: '3-5', label: 'Grades 3-5' },
  { value: '5-8', label: 'Grades 5-8' },
  { value: '9-12', label: 'Grades 9-12' },
  { value: '13-plus', label: 'Grades 13+' },
];

// Seeded from the subjects the portal's listings carry (the "Subject: …" strings of the Squarespace cards).
export const SUBJECTS: EnumOption[] = [
  { value: 'family-consumer-science', label: 'Family/Consumer Science' },
  { value: 'health', label: 'Health' },
  { value: 'information-technology', label: 'Information Technology' },
  { value: 'language-arts', label: 'Language Arts' },
  { value: 'math', label: 'Math' },
  { value: 'science', label: 'Science' },
  { value: 'social-studies', label: 'Social Studies' },
  { value: 'technology-education', label: 'Technology Education' },
];

// Seeded from the topics the portal's listings carry (the "Topic: …" strings of the Squarespace cards).
export const TOPICS: EnumOption[] = [
  { value: 'agricultural-science', label: 'Agricultural Science' },
  { value: 'algebra', label: 'Algebra' },
  { value: 'arithmetic', label: 'Arithmetic' },
  { value: 'astronomy', label: 'Astronomy' },
  { value: 'biology', label: 'Biology' },
  { value: 'business', label: 'Business' },
  { value: 'chemistry', label: 'Chemistry' },
  { value: 'civics', label: 'Civics' },
  { value: 'computer-science', label: 'Computer Science' },
  { value: 'earth-science', label: 'Earth Science' },
  { value: 'ecology', label: 'Ecology' },
  { value: 'economics', label: 'Economics' },
  { value: 'engineering-principles', label: 'Engineering Principles' },
  { value: 'english-language', label: 'English Language' },
  { value: 'environmental-science', label: 'Environmental Science' },
  { value: 'finance', label: 'Finance' },
  { value: 'geography', label: 'Geography' },
  { value: 'geometry', label: 'Geometry' },
  { value: 'graphing', label: 'Graphing' },
  { value: 'history', label: 'History' },
  { value: 'journalism', label: 'Journalism' },
  { value: 'life-sciences', label: 'Life Sciences' },
  { value: 'literature', label: 'Literature' },
  { value: 'physics', label: 'Physics' },
  { value: 'psychology', label: 'Psychology' },
  { value: 'public-speaking', label: 'Public Speaking' },
  { value: 'reading-comprehension', label: 'Reading Comprehension' },
  { value: 'writing', label: 'Writing' },
];

const STATIC_OPTIONS: Record<'grade' | 'subject' | 'topic', EnumOption[]> = { grade: GRADES, subject: SUBJECTS, topic: TOPICS };

// The developer/studio options: the studios the portal knows, by their short name (slug) and their name. Not a
// static enum — a new studio is a new option at once.
export function studioOptions(db: Db): EnumOption[] {
  return db.studios().map((s) => ({ value: s.slug, label: s.name })).sort((a, b) => a.label.localeCompare(b.label));
}

// "Grades 3-5", "Subject: Science", "Topic: Civics", "Dev: Field Day Lab" name their kind; anything else (a bare
// "Civics") is matched against every kind.
export function parseCardString(s: string): { kind: CardTagKind | null; value: string } {
  const t = String(s ?? '').trim();
  const prefixed: [RegExp, CardTagKind][] = [
    [/^grades[\s:]+/i, 'grade'],
    [/^subject\s*:\s*/i, 'subject'],
    [/^topic\s*:\s*/i, 'topic'],
    [/^dev(?:eloper)?\s*:\s*/i, 'studio'],
  ];
  for (const [re, kind] of prefixed) {
    const m = t.match(re);
    if (m) return { kind, value: t.slice(m[0].length).trim() };
  }
  return { kind: null, value: t };
}

// Case/whitespace/punctuation-blind key: "K-2" and "k 2" and "K2" are one thing.
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Where matching the value or the label is not enough, an explicit synonym: the Squarespace "Dev: …" strings for
// two studios the portal knows by another name ("Learning Games Lab: NMSU" is the studio
// "Learning Games Lab, New Mexico State University"; the PhET cards carry CU Boulder's name, the studio is
// "PhET Interactive Simulations"). "CU Boulder" alone and "Havana24" have no studio: they stay unmatched for review.
const SYNONYMS: Record<string, { kind: CardTagKind; value: string }> = {
  learninggameslabnmsu: { kind: 'studio', value: 'nmsu' },
  phetinteractivesimulationscuboulder: { kind: 'studio', value: 'phet' },
};

// The enum value of `input` for this kind, or null: its value or its label, case/whitespace/punctuation-insensitive
// ("Math" is math, "K-2" is k-2), then the synonyms map. Studios come from `opts.studios` (studioOptions(db)).
export function normalizeEnumValue(kind: CardTagKind, input: string, opts: { studios?: EnumOption[] } = {}): string | null {
  const key = normKey(String(input ?? '').trim());
  if (!key) return null;
  const options = kind === 'studio' ? opts.studios ?? [] : STATIC_OPTIONS[kind];
  for (const o of options) if (normKey(o.value) === key || normKey(o.label) === key) return o.value;
  const syn = SYNONYMS[key];
  if (syn && syn.kind === kind) return syn.value;
  return null;
}

// Every distinct string, matched: original string -> enum value (kind from its prefix, or the first kind it fits),
// and the rest as unmatched. Sorted, so a second run says the same thing.
export function reconcile(strings: string[], opts: { studios?: EnumOption[] } = {}): { matched: Map<string, string>; unmatched: string[] } {
  const matched = new Map<string, string>();
  const unmatched: string[] = [];
  for (const s of [...new Set(strings.map((x) => String(x).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))) {
    const { kind, value } = parseCardString(s);
    const kinds: CardTagKind[] = kind ? [kind] : [...CARD_KINDS];
    const hit = kinds.map((k) => normalizeEnumValue(k, value, opts)).find((v) => v !== null);
    if (hit) matched.set(s, hit);
    else unmatched.push(s);
  }
  return { matched, unmatched };
}
