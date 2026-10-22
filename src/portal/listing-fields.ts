// The listing editor's questions, in one table (card H of "Retire Squarespace data"): which section of the form each
// is in and in what order — the page top-down, as a visitor meets it — who sees it, which vault-site template reads
// it, what it's for, what wins when it is empty, and the crop an image field needs. editor() (listings.ts) renders
// the form from it, so a new question starts here, and the tests hold every studio-visible one to a template that
// reads it: no question in the form may silently do nothing.
//
// siteReads: the template paths in VaultLearningGames/vault-site (branch staging) that read the field, after card F
// (content/games/_content.gotmpl passes the listing's page fields to the game page). Each was checked against the
// templates on 2026-10-22.
import type { ListingFields } from '../listings.ts';
import { IMAGE_FIELDS, ratio, type ImageFieldKey } from './image-fields.ts';

export const SECTIONS = ['page_design', 'text', 'media', 'teaching', 'discovery', 'playing', 'address'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_INFO: Record<Section, { title: string; intro?: string }> = {
  page_design: { title: 'Page design', intro: 'How the top of the game’s page looks: the layout, and the images that layout uses.' },
  text: { title: 'Text' },
  media: { title: 'Media' },
  teaching: { title: 'Teaching' },
  discovery: { title: 'Discovery', intro: 'Where people find the game: its card on the Games page, and what search engines show. A field left empty falls back to the page’s own text.' },
  playing: { title: 'Playing' },
  address: { title: 'Site address' },
};

// Closed groups inside a section: optional text, and the player's plumbing.
export const DISCLOSURES = { card_text: 'Card text (optional)', player_geometry: 'Player geometry' } as const;
export type Disclosure = keyof typeof DISCLOSURES;

// A form question's stored key; the listing date is the record's created date, not a listing field.
export type FormField = keyof ListingFields | 'created_at';

export interface CropSpec {
  // The shape the crop is locked to ("16:9", from image-fields.ts), or null for any shape.
  ratio: string | null;
  // The shape as the field shows it next to its label.
  label: string;
  // Where the site shows the image, which is why it is that shape.
  why: string;
  // The image keeps its transparency (the logo art).
  transparent?: boolean;
}

export interface FieldSpec {
  name: FormField;
  section: Section;
  // studio: anyone with edit rights; staff: Vault staff only (studios see it read-only, or not at all).
  audience: 'studio' | 'staff';
  staffReason?: string;
  // Other stored keys the same control writes (the smallest play area's width and height).
  inputs?: (keyof ListingFields)[];
  siteReads: string[] | null;
  hint: string;
  fallback: string | null;
  crop: CropSpec | null;
  group?: Disclosure;
}

const T = 'themes/vault-squarespace/layouts/';
const SITE = {
  content: 'content/games/_content.gotmpl',
  single: `${T}games/single.html`,
  head: `${T}partials/sq/head.html`,
  gameGrid: `${T}partials/sq/game-grid.html`,
  blogGrid: `${T}partials/sq/blog-grid.html`,
  gameList: `${T}partials/sq/game-list.html`,
  accordion: `${T}partials/sq/game-accordion.html`,
  standards: `${T}partials/sq/game-standards.html`,
  gameDesc: `${T}partials/sq/game-desc.html`,
  cardImage: `${T}partials/sq/card-image.html`,
  cardTitle: `${T}partials/sq/card-title.html`,
  cardExcerpt: `${T}partials/sq/card-excerpt.html`,
} as const;

// A field's crop, its shape taken from image-fields.ts (the browser tool and the server's check use the same row).
const crop = (key: ImageFieldKey, why: string): CropSpec => {
  const a = IMAGE_FIELDS[key].aspect;
  return a ? { ratio: ratio(a), label: ratio(a), why } : { ratio: null, label: 'Transparent PNG', why, transparent: true };
};

const GEOMETRY = 'Vault sets the player’s geometry after testing the game in the player.';

export const FIELD_SPECS: readonly FieldSpec[] = [
  // ---- Page design: the layout, then the images it uses
  { name: 'page_layout', section: 'page_design', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: null,
    hint: 'Hero pages are dark; Standard pages are light.', fallback: null },
  { name: 'hero_image', section: 'page_design', audience: 'studio', siteReads: [SITE.content, SITE.single, SITE.head], crop: crop('hero_image', 'the cover beside the title on a Standard page, and the picture shown when the page is shared'),
    hint: 'A path on the site (games/x/img/hero.png) or an https link.', fallback: 'Empty: a Standard page has no cover.' },
  { name: 'hero_background', section: 'page_design', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: crop('hero_background', 'full-width behind the title'),
    hint: 'Only the Hero layout uses it.', fallback: 'Empty: the hero image fills the background.' },
  { name: 'logo_image', section: 'page_design', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: crop('logo_image', 'transparent PNG, centred over the dark hero — a logo with a white box around it will show the box'),
    hint: 'Only the Hero layout uses it.', fallback: 'Empty: the title shows as text.' },
  // ---- Text
  { name: 'title', section: 'text', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: null,
    hint: 'The page’s title, drawn from the site’s one title style (it shrinks to fit).', fallback: null },
  { name: 'makers', section: 'text', audience: 'studio', siteReads: [SITE.content, SITE.accordion, SITE.gameGrid], crop: null,
    hint: 'Shown as Made by.', fallback: 'Empty: the studio’s name.' },
  { name: 'short_description', section: 'text', audience: 'studio', siteReads: [SITE.content, SITE.gameDesc], crop: null,
    hint: 'One or two sentences under the title, and on the game card.', fallback: null },
  { name: 'about', section: 'text', audience: 'studio', siteReads: [SITE.content, SITE.accordion], crop: null,
    hint: 'The About this game section.', fallback: 'Empty: no About this game section.' },
  // ---- Media
  { name: 'screenshots', section: 'media', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: crop('screenshots', 'the gallery under the title, in this order'),
    hint: 'One path or link per line; delete a line to remove it.', fallback: 'Empty: the page shows no screenshots.' },
  { name: 'gameplay_video', section: 'media', audience: 'studio', siteReads: [SITE.content, SITE.accordion], crop: null,
    hint: 'A YouTube or other video link: the Trailer section.', fallback: 'Empty: no Trailer section.' },
  // ---- Teaching
  { name: 'grades', section: 'teaching', audience: 'studio', siteReads: [SITE.content, SITE.gameGrid], crop: null,
    hint: 'The grade bands the Games page filters on.', fallback: null },
  { name: 'subjects', section: 'teaching', audience: 'studio', siteReads: [SITE.content, SITE.gameGrid], crop: null,
    hint: 'Comma-separated, e.g. Math, Science.', fallback: null },
  { name: 'topics', section: 'teaching', audience: 'studio', siteReads: [SITE.content, SITE.blogGrid], crop: null,
    hint: 'Comma-separated, e.g. Algebra, Physics.', fallback: null },
  { name: 'standards', section: 'teaching', audience: 'studio', siteReads: [SITE.content, SITE.standards], crop: null,
    hint: 'Codes, one per line or comma-separated (Common Core, NGSS), e.g. 4.OA.A.2.', fallback: 'Empty: no Standards section.' },
  { name: 'related_curriculum', section: 'teaching', audience: 'studio', siteReads: [SITE.content, SITE.accordion], crop: null,
    hint: 'A link to teacher materials.', fallback: 'Empty: the game’s page says there is no curriculum yet and invites teachers to share one with the Vault (no email address is shown).' },
  // ---- Discovery: the game card, then search
  { name: 'thumb_image', section: 'discovery', audience: 'studio', siteReads: [SITE.content, SITE.cardImage], crop: crop('thumb_image', 'the game card on the Games page'),
    hint: 'A path on the site or an https link.', fallback: 'Empty: the card uses the hero image.' },
  { name: 'card_title', section: 'discovery', audience: 'studio', siteReads: [SITE.content, SITE.gameGrid, SITE.cardTitle], crop: null, group: 'card_text',
    hint: 'Shown on the game card.', fallback: 'Empty: the title.' },
  { name: 'card_excerpt', section: 'discovery', audience: 'studio', siteReads: [SITE.content, SITE.cardExcerpt], crop: null, group: 'card_text',
    hint: 'One or two sentences under the card title.', fallback: 'Empty: the short description.' },
  { name: 'card_categories', section: 'discovery', audience: 'studio', siteReads: [SITE.content, SITE.blogGrid], crop: null,
    hint: 'The grades and developer the game cards are filed under.', fallback: 'None ticked: the game’s grades and makers.' },
  { name: 'card_tags', section: 'discovery', audience: 'studio', siteReads: [SITE.content, SITE.blogGrid], crop: null,
    hint: 'The subjects and topics the game cards are tagged with.', fallback: 'None ticked: the game’s subjects and topics.' },
  { name: 'seo_title', section: 'discovery', audience: 'studio', siteReads: [SITE.content, SITE.head], crop: null,
    hint: 'What search engines show for the game.', fallback: 'Empty: the title.' },
  { name: 'seo_description', section: 'discovery', audience: 'studio', siteReads: [SITE.content, SITE.head], crop: null,
    hint: 'The snippet under the title.', fallback: 'Empty: the short description.' },
  // ---- Playing (play{...} in the catalog)
  { name: 'play_source', section: 'playing', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: null,
    hint: 'Where Play loads the game from.', fallback: null },
  { name: 'play_url', section: 'playing', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: null,
    hint: 'The page that shows only the game (what Vault’s player wraps).', fallback: 'It also plays when the CDN game has no release.' },
  { name: 'embed', section: 'playing', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: null,
    hint: 'Whether Play opens the game in Vault’s player or in a new tab.', fallback: null },
  { name: 'cdn_path', section: 'playing', audience: 'studio', siteReads: [SITE.content, SITE.single], crop: null, group: 'player_geometry',
    hint: 'Optional folder inside the CDN game, e.g. earthquake/ for one game of a collection.', fallback: 'Empty: the CDN game’s own folder.' },
  { name: 'fit', section: 'playing', audience: 'staff', staffReason: GEOMETRY, siteReads: [SITE.content, SITE.single], crop: null, group: 'player_geometry',
    hint: 'For fixed-size games: page width, page height, x, y, width, height of the game on that page.', fallback: 'Empty: the game fills the player.' },
  { name: 'min_width', inputs: ['min_width', 'min_height'], section: 'playing', audience: 'staff', staffReason: GEOMETRY, siteReads: [SITE.content, SITE.single], crop: null, group: 'player_geometry',
    hint: 'The smallest space (width × height, below Vault’s player bar) the game is playable in. On a smaller screen Play says what’s needed and offers to try anyway.', fallback: 'Empty: the site’s default.' },
  // ---- Address
  { name: 'page_address', section: 'address', audience: 'staff', staffReason: 'A page address can move, or shadow, another game’s page.', siteReads: [SITE.content], crop: null,
    hint: 'Lowercase letters, numbers and dashes. The old address becomes an alias, if you want it to keep working.', fallback: 'Empty: the listing’s slug.' },
  { name: 'aliases', section: 'address', audience: 'staff', staffReason: 'An alias can shadow another game’s page.', siteReads: [SITE.content], crop: null,
    hint: 'One old address per line (lowercase letters, numbers and dashes, or an old game-cards/ address); each sends its visitors to the page address.', fallback: null },
  { name: 'created_at', section: 'address', audience: 'staff', staffReason: 'The listing date is the record’s created date, set by Vault staff only (decision 7, 2026-10-21).', siteReads: [SITE.content, SITE.gameList], crop: null,
    hint: 'The date the site sorts the cards newest-first (the record’s created date).', fallback: null },
];

const BY_NAME = new Map<string, FieldSpec>(FIELD_SPECS.map((s) => [s.name, s]));

export function fieldSpec(name: FormField): FieldSpec {
  const s = BY_NAME.get(name);
  if (!s) throw new Error(`no form question for ${name}`);
  return s;
}

export const fieldsIn = (section: Section): FieldSpec[] => FIELD_SPECS.filter((s) => s.section === section);

// The question a form input belongs to: its own name, the part before the first ":" of a checkbox
// ("grades:Grades 3-5", "card_tags:subject:math", "makers:Field Day Lab"), the min-size pair, or "Made by"'s
// add-a-studio fields. null: not a question (the save controls).
export function specForInput(inputName: string): FieldSpec | null {
  const base = inputName.split(':')[0];
  if (base.startsWith('maker_new_')) return BY_NAME.get('makers') ?? null;
  return BY_NAME.get(base) ?? FIELD_SPECS.find((s) => s.inputs?.includes(base as keyof ListingFields)) ?? null;
}

// A field's hint as the form shows it: its crop and why, what it's for, then what wins when it's empty.
export function hintText(s: FieldSpec): string {
  const c = s.crop;
  const shape = !c ? '' : c.ratio ? `${c.ratio}: ${c.why}.` : `${c.why[0].toUpperCase()}${c.why.slice(1)}.`;
  return [shape, s.hint, s.fallback ?? ''].filter(Boolean).join(' ');
}
