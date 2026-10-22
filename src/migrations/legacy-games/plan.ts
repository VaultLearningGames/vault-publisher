// What the import writes into one version (draft or published) of one listing: a pure function of the old page,
// the listing's current fields and what the import wrote before. Images are planned separately (images.ts).
//
// The conflict rule (never lose content): a field is written only while it is empty (its default, for the layout
// and the theme) or still holds what the import itself wrote before. Otherwise a person set it: it is kept and the
// difference is reported as a conflict. The aliases are a union (nothing is ever dropped from them, except the
// page's own address, which can't be an alias of itself). The listing's date is never written (decision 7: it is
// the record's created date); the old page's date is only compared, in the report.
import { tagsFrom } from '../../listing-fields-migration.ts';
import type { ListingFields } from '../../listings.ts';
import { CARD_CATEGORY_KINDS, CARD_TAG_KINDS, type EnumOption } from '../../portal/listing-enums.ts';
import { DEFAULT_PAGE_LAYOUT, DEFAULT_THEME } from '../../portal/listing-layout.ts';
import { str, strList, type LegacyValues } from './legacy.ts';
import type { FieldWrite, GameReport, LegacyGame } from './types.ts';
import { cardAlias } from './urls.ts';

export interface PlanInput {
  slug: string;                     // the listing's slug
  path: string;                     // the old page address (matched, slug-map.ts)
  legacy: LegacyGame;
  lv: LegacyValues;
  fields: ListingFields;            // the version's current fields (normalized)
  studios: EnumOption[];
  written: Record<string, { from: unknown; to: unknown }>; // what the import wrote into this version before
}

export interface FieldPlan {
  next: ListingFields;
  writes: FieldWrite[];
  conflicts: string[];
  unmatched: GameReport['dropped']['unmatchedStrings'];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The text, layout, card, SEO and address fields; see the conflict rule above.
export function planFields(p: PlanInput): FieldPlan {
  const cur = p.fields;
  const next: ListingFields = { ...cur };
  const conflicts: string[] = [];
  const unmatched: FieldPlan['unmatched'] = [];

  const set = <K extends keyof ListingFields>(field: K, want: ListingFields[K], empty: (v: ListingFields[K]) => boolean) => {
    const v = cur[field];
    if (same(v, want)) return;
    if (empty(v) || (Object.hasOwn(p.written, field) && same(v, p.written[field].to))) { next[field] = want; return; }
    conflicts.push(`${field}: kept “${JSON.stringify(v)}” (the old page has “${JSON.stringify(want)}”).`);
  };
  const blank = (v: unknown) => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length);

  // Page design (card B): the old page's layout and the colour of its first section.
  if (p.lv.layout) set('page_layout', p.lv.layout, (v) => blank(v) || v === DEFAULT_PAGE_LAYOUT);
  if (p.lv.theme) set('theme', p.lv.theme, (v) => blank(v) || v === DEFAULT_THEME);

  // The card and search fields (card C): only where the old page has a value.
  const text: [keyof ListingFields & ('card_title' | 'card_excerpt' | 'seo_title' | 'seo_description'), number][] = [['card_title', 200], ['card_excerpt', 600], ['seo_title', 300], ['seo_description', 600]];
  for (const [field, max] of text) {
    const want = str(p.legacy[field], max);
    if (want) set(field, want, blank);
  }
  // Categories and tags through the option lists; unmatched strings are reported and dropped, and when nothing
  // matches, the field is left as it is.
  for (const [field, kinds] of [['card_categories', CARD_CATEGORY_KINDS], ['card_tags', CARD_TAG_KINDS]] as const) {
    const miss = new Map<string, string[]>();
    // (A synonym may name a studio this portal doesn't have: that one is unmatched too.)
    const tags = tagsFrom(strList(p.legacy[field]), kinds, { studios: p.studios }, miss, p.slug).filter((t) => {
      if (t.kind !== 'studio' || p.studios.some((s) => s.value === t.value)) return true;
      miss.set(`studio “${t.value}” (not in this portal)`, [p.slug]);
      return false;
    });
    for (const s of miss.keys()) unmatched.push({ field, string: s });
    if (tags.length) set(field, tags, blank);
  }

  // The page address: the old path, so the page stays where it is (empty when it is the slug: the default).
  const wantAddress = p.path === p.slug ? '' : p.path;
  set('page_address', wantAddress, (v) => blank(v) || v === p.slug);
  const own = next.page_address || p.slug;
  // The aliases: what they were, the old path when the page now lives elsewhere, and the Game Card address.
  const aliases = new Set(cur.aliases ?? []);
  if (p.path !== own) aliases.add(p.path);
  if (p.lv.cardId) aliases.add(cardAlias(p.lv.cardId));
  aliases.delete(own);
  aliases.delete(p.slug);
  const wantAliases = [...aliases].sort();
  if (!same(cur.aliases ?? [], wantAliases)) next.aliases = wantAliases;

  return { next, writes: diffFields(cur, next), conflicts, unmatched };
}

// Field-by-field writes from one version to another (the order of ListingFields).
export function diffFields(a: ListingFields, b: ListingFields): FieldWrite[] {
  return (Object.keys(b) as (keyof ListingFields)[]).filter((k) => !same(a[k], b[k])).map((k) => ({ field: k, from: a[k] ?? null, to: b[k] ?? null }));
}

// The days between the record's created date and the old page's date (absolute, rounded to a tenth).
export function dayDiff(record: string, legacy: string): number {
  return Math.round((Math.abs(Date.parse(record) - Date.parse(legacy)) / 86_400_000) * 10) / 10;
}
