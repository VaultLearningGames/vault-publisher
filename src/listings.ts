// Site listings: what vaultlearninggames.org shows for each game (title, descriptions, grades, images, and how to
// play it). Studios edit a draft; Vault publishes it. The site is built from the published listings (/v1/catalog).
//
// A listing is hosted either at an HTML URL in Vault's in-page player (the first version of the site), or on the
// Vault CDN: the current release of one of the studio's games at https://cdn.vaultlearninggames.org/STUDIO/GAME/.
import { isSlug } from './paths.ts';
import { DEFAULT_PAGE_LAYOUT, DEFAULT_THEME, effectivePageLayout, effectiveTheme, layoutAssetError, normalizeLayoutFields, validateLayoutFields } from './portal/listing-layout.ts';
import { deriveTheme } from './portal/listing-theme.ts';
import { CARD_CATEGORY_KINDS, CARD_TAG_KINDS, cardTagProblems, normalizeEnumValue, parseCardString, type CardTag, type CardTagKind } from './portal/listing-enums.ts';

// "Grades 13+" is undergraduate and beyond (David, 2026-10-03; ThermoLab is the first).
export const GRADES = ['Grades K-3', 'Grades 3-5', 'Grades 5-8', 'Grades 9-12', 'Grades 13+'] as const;

export interface ListingFields {
  title: string;
  short_description: string;
  about: string;
  makers: string[];            // shown as "Made by": names, usually studios' (the site links those); the studio's name when empty
  grades: string[];
  subjects: string[];
  topics: string[];
  standards: string[];         // codes looked up in the site's standards data, e.g. "4.OA.A.2", "MS-LS1-1"
  related_curriculum: string;  // a URL or short Markdown
  gameplay_video: string;
  hero_image: string;          // a path on the site ("games/agrinautica/img/hero.png") or an https URL
  thumb_image: string;         // the game card's image (card C): the card uses it through card A's upload tool
  screenshots: string[];
  // The game card (card C): the title and excerpt the card shows (empty: the site falls back to the title /
  // short description), and the categories and tags, each a choice from the portal's option lists (listing-enums.ts):
  // the categories are grades and the developer/studio, the tags subjects and topics.
  card_title: string;
  card_excerpt: string;
  card_categories: CardTag[];
  card_tags: CardTag[];
  // Search (card C): what search engines show; empty: the site falls back to the title / short description.
  seo_title: string;
  seo_description: string;
  // The game's page on the site (card C): the address defaults to the listing's slug; aliases are old addresses
  // that send visitors there (301). Vault staff only — they can collide with other games' pages and aliases.
  page_address: string;
  aliases: string[];
  // Page design (card B): one of the two layouts the site offers (portal/listing-layout.ts); problems() rejects
  // anything else. The theme isn't asked (card G): a save sets it from the layout (inheritedListing).
  page_layout: string;   // 'standard' | 'hero'
  theme: string;         // 'light' | 'dark': Standard is light, Hero is dark
  // The hero layout's art, each a link to one of the listing's own uploaded images (card A's tool), or null for
  // none — the site then falls back (hero_background to hero_image, the cover to thumb_image).
  hero_background: string | null;
  logo_image: string | null;
  play_source: 'url' | 'cdn';
  play_url: string;            // the game's HTML page; used when play_source is "url" (and as the fallback for "cdn")
  cdn_path: string;            // optional folder inside the linked CDN game, e.g. "earthquake/" for one game of The Yard
  embed: boolean;              // false: the game's site refuses to be framed, so Play opens a new tab
  fit: string;                 // optional player fit, "pageWidth,pageHeight,x,y,width,height" (Vault staff only)
  // The smallest game area (Vault's player below its bar, in CSS pixels) the game is playable in; null: the site's
  // default (hugo.toml params.play). Below it, Play explains what's needed instead of starting the game (Vault staff set it).
  min_width: number | null;
  min_height: number | null;
}

export const EMPTY_LISTING: ListingFields = {
  title: '', short_description: '', about: '', makers: [], grades: [], subjects: [], topics: [], standards: [],
  related_curriculum: '', gameplay_video: '', hero_image: '', thumb_image: '', screenshots: [],
  card_title: '', card_excerpt: '', card_categories: [], card_tags: [],
  seo_title: '', seo_description: '', page_address: '', aliases: [],
  page_layout: DEFAULT_PAGE_LAYOUT, theme: DEFAULT_THEME, hero_background: null, logo_image: null,
  play_source: 'url', play_url: '', cdn_path: '', embed: true, fit: '', min_width: null, min_height: null,
};

// A stored listing, with any field written before it existed filled in from EMPTY_LISTING. Rows keep the shape
// they were saved with, so an old row can be missing newer fields (card_categories, card_tags, the layout
// fields): readers index them directly, and a missing array crashed the game page. Defaulting once here, at the
// parse boundary, keeps every reader honest. Arrays are copied so a row can never share EMPTY_LISTING's.
export function listingFieldsOf(json: string): ListingFields {
  const stored = JSON.parse(json) as Partial<ListingFields> | null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(EMPTY_LISTING as unknown as Record<string, unknown>)) {
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  for (const [k, v] of Object.entries(stored ?? {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  // A field stored as the wrong shape (null, or a scalar where the code indexes an array) is as fatal as a
  // missing one: keep the default instead.
  for (const [k, v] of Object.entries(EMPTY_LISTING as unknown as Record<string, unknown>)) {
    if (Array.isArray(v) && !Array.isArray(out[k])) out[k] = [...v];
  }
  return out as unknown as ListingFields;
}

// Fields only Vault staff set; a studio member's save or preview leaves them as they are.
// The page address and aliases are Vault staff only: they can point at, or hide, other games' pages.
export const VAULT_ONLY = ['fit', 'min_width', 'min_height', 'page_address', 'aliases'] as const;

// Bounds for min_width / min_height: below 200 px nothing is a game area; above 4K nobody could play it.
export const MIN_SIZE_RANGE = { min: 200, max: 3840 } as const;

const MAX_TEXT = 5000, MAX_LIST = 40;
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// Lists arrive as arrays, or as text with one item per line (or comma-separated for short tags).
function list(v: unknown, splitCommas: boolean): string[] {
  const raw = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(splitCommas ? /[\n,]/ : /\n/) : [];
  const out: string[] = [];
  for (const item of raw.map((s) => s.trim()).filter(Boolean)) if (!out.includes(item)) out.push(item.slice(0, 200));
  return out.slice(0, MAX_LIST);
}
const isHttpUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);
// Images are site paths like "games/x/img/hero.png" (or "/games/..."), or absolute https URLs (e.g. on the Vault CDN).
const isImageRef = (s: string) => s === '' || isHttpUrl(s) || /^\/?[A-Za-z0-9][A-Za-z0-9._/ -]*\.(png|jpe?g|webp|gif|svg|avif)$/i.test(s);
// "earthquake", "/earthquake/" → "earthquake/"; only plain folder names.
function cleanPath(s: string) {
  const parts = s.split('/').filter(Boolean);
  return parts.every((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) && parts.length ? parts.join('/') + '/' : '';
}
// A minimum play size from a form ("1024", "", " 768 px"?) or JSON (1024, null). Empty: null (the site default);
// anything else that isn't a whole number is kept as NaN so problems() can say so (it never reaches a save).
function minSize(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim())) return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) ? n : NaN;
}
const isMinSize = (n: number | null | undefined) => n == null || (Number.isInteger(n) && n >= MIN_SIZE_RANGE.min && n <= MIN_SIZE_RANGE.max);
const isFit = (s: string) => s === '' || (/^\d+(,\d+){5}$/.test(s) && s.split(',').map(Number).every((n) => n >= 0));

// One card category/tag as sent: a checkbox named "card_categories:grade:3-5", or an array item — { kind, value }
// (the API, the migration), or a string with the kind in it ("Subject: Science"). The kind is kept as sent, so
// problems() can name what is wrong (a kind the field doesn't carry, a value not in the enum).
function cardTagItem(field: 'card_categories' | 'card_tags', item: unknown): CardTag | null {
  if (typeof item === 'string') {
    const { kind, value } = parseCardString(item);
    if (!value) return null;
    if (kind) return { kind, value };
    const kinds = (field === 'card_categories' ? CARD_CATEGORY_KINDS : CARD_TAG_KINDS) as readonly CardTagKind[];
    const hit = kinds.map((k) => normalizeEnumValue(k, value)).find((v) => v !== null);
    return hit ? { kind: (kinds as readonly CardTagKind[]).find((k) => normalizeEnumValue(k, value) === hit)!, value: hit } : { kind: 'subject', value: item };
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const o = item as Record<string, unknown>;
    return { kind: String(o.kind ?? '') as CardTagKind, value: String(o.value ?? '').trim() };
  }
  return null;
}

// The card categories/tags of a form or API body: the checkboxes named "field:kind:value" (the editor's chip
// pickers), or an array. Like the grades/makers checkboxes, any checkbox of the field present means the field is
// whatever is checked; an array replaces it (an empty one clears it).
function cardTagsOf(field: 'card_categories' | 'card_tags', input: Record<string, unknown>): CardTag[] | null {
  const boxes = Object.keys(input).filter((k) => k.startsWith(field + ':'));
  if (boxes.length) {
    const out: CardTag[] = [];
    for (const k of boxes) {
      if (input[k] !== true && input[k] !== 'on') continue;
      const t = cardTagItem(field, k.slice(field.length + 1));
      if (t && !out.some((x) => x.kind === t.kind && x.value === t.value)) out.push(t);
    }
    return out;
  }
  const v = input[field];
  if (v === undefined || v === null) return null;   // not sent: keep the base value
  if (!Array.isArray(v)) return [];
  const out: CardTag[] = [];
  for (const item of v) {
    const t = cardTagItem(field, item);
    if (t && !out.some((x) => x.kind === t.kind && x.value === t.value)) out.push(t);
  }
  return out.slice(0, MAX_LIST);
}

// Clean up whatever a form or an import sends into a ListingFields. Never throws; see problems() for what's wrong.
export function normalize(input: Record<string, unknown>, base: ListingFields = EMPTY_LISTING): ListingFields {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  // (A listing saved before a field existed has no value for it: the field's empty value.)
  const pick = <K extends keyof ListingFields>(k: K, value: ListingFields[K]) => (has(k) ? value : base[k] ?? EMPTY_LISTING[k]);
  // Grades may also come from checkboxes named "grades:Grades 3-5".
  const gradeBoxes = Object.keys(input).filter((k) => k.startsWith('grades:'));
  const grades = gradeBoxes.length ? gradeBoxes.filter((k) => input[k] === true || input[k] === 'on').map((k) => k.slice(7)) : null;
  // "Made by" may also come from the editor's chooser: checkboxes named "makers:Field Day Lab", in the order they are on
  // the page (so a name can contain a comma, which the comma-separated text can't).
  const makerBoxes = Object.keys(input).filter((k) => k.startsWith('makers:'));
  const makers = makerBoxes.length ? list(makerBoxes.filter((k) => input[k] === true || input[k] === 'on').map((k) => k.slice(7)), false) : null;
  // Page design (card B): defaults for empty values, unknown values kept for problems() to reject.
  const layout = normalizeLayoutFields(input);
  return {
    title: pick('title', str(input.title, 200)),
    short_description: pick('short_description', str(input.short_description, 600)),
    about: pick('about', str(input.about, MAX_TEXT)),
    makers: makers ?? pick('makers', list(input.makers, true)),
    grades: grades ?? pick('grades', list(input.grades, true)),
    subjects: pick('subjects', list(input.subjects, true)),
    topics: pick('topics', list(input.topics, true)),
    standards: pick('standards', list(input.standards, true)),
    related_curriculum: pick('related_curriculum', str(input.related_curriculum, 2000)),
    gameplay_video: pick('gameplay_video', str(input.gameplay_video, 500)),
    hero_image: pick('hero_image', str(input.hero_image, 500)),
    thumb_image: pick('thumb_image', str(input.thumb_image, 500)),
    screenshots: pick('screenshots', list(input.screenshots, false)),
    card_title: pick('card_title', str(input.card_title, 200)),
    card_excerpt: pick('card_excerpt', str(input.card_excerpt, 600)),
    // Like grades: the box checkboxes (checked or not) replace the value; no boxes and no key keeps the base.
    card_categories: cardTagsOf('card_categories', input) ?? pick('card_categories', []),
    card_tags: cardTagsOf('card_tags', input) ?? pick('card_tags', []),
    seo_title: pick('seo_title', str(input.seo_title, 300)),
    seo_description: pick('seo_description', str(input.seo_description, 600)),
    page_address: pick('page_address', str(input.page_address, 200).toLowerCase()),
    aliases: pick('aliases', list(input.aliases, true).map((a) => a.toLowerCase())),
    page_layout: pick('page_layout', layout.page_layout),
    theme: pick('theme', layout.theme),
    hero_background: pick('hero_background', layout.hero_background),
    logo_image: pick('logo_image', layout.logo_image),
    play_source: pick('play_source', input.play_source === 'cdn' ? 'cdn' : 'url'),
    play_url: pick('play_url', str(input.play_url, 1000)),
    cdn_path: pick('cdn_path', cleanPath(str(input.cdn_path, 200))),
    embed: pick('embed', input.embed === false || input.embed === 'false' ? false : true),
    fit: pick('fit', str(input.fit, 60).replace(/\s+/g, '')),
    min_width: pick('min_width', minSize(input.min_width)),
    min_height: pick('min_height', minSize(input.min_height)),
  };
}

// What a save stores for the fields the listing inherits (card G): the theme always follows the layout
// (listing-theme.ts), whatever was sent; and the card's title and excerpt are empty — inherited from the title and
// short description — unless they say something else, so renaming a game can never leave its old name on its card.
// (normalize() already trims, so whitespace-only is empty.) Every write path that persists a listing applies it.
export function inheritedListing(f: ListingFields): ListingFields {
  return {
    ...f,
    theme: deriveTheme(f.page_layout),
    card_title: f.card_title === f.title ? '' : f.card_title,
    card_excerpt: f.card_excerpt === f.short_description ? '' : f.card_excerpt,
  };
}

// What stops a listing from being saved (hard errors) or published (also needs a title and a way to play).
// cdnReady: the listing is linked to a CDN game that has a current release.
// Another game's reserved addresses: its slug, its page address and its aliases (what a new one may not take).
export interface ListingAddress { slug: string; page_address: string; aliases: string[] }

// An alias is an old page address ("crowds", served at /crowds/), or an old Squarespace Game Card address
// ("game-cards/CARD-ID", served at /game-cards/CARD-ID): both 301 to the game's page.
export const CARD_ALIAS_PREFIX = 'game-cards/';
export const isAlias = (a: string): boolean => (a.startsWith(CARD_ALIAS_PREFIX) ? isListingSlug(a.slice(CARD_ALIAS_PREFIX.length)) : isListingSlug(a));

// The page address and the aliases, checked against what this game itself may not take: the slug, and every
// other game's page and aliases (301s must land on exactly one game).
export function pageAddressProblems(f: ListingFields, self: string, others: ListingAddress[]): string[] {
  const out: string[] = [];
  const addr = f.page_address;
  if (addr && !isListingSlug(addr)) out.push(`The page address “${addr}” can use lowercase letters, numbers and dashes.`);
  const own = addr || self;
  const taken = new Map<string, string>();
  for (const o of others) for (const a of [o.slug, o.page_address, ...o.aliases]) if (a) taken.set(a, o.slug);
  if (addr && addr !== self && taken.has(addr)) out.push(`The page address “${addr}” is already used by ${taken.get(addr)}.`);
  const seen = new Set<string>();
  for (const a of f.aliases) {
    if (!isAlias(a)) { out.push(`The alias “${a}” can use lowercase letters, numbers and dashes (or be a game-cards/ address).`); continue; }
    if (a === own || a === self) { out.push(`“${a}” is the game’s own address, so it can’t be an alias of itself.`); continue; }
    if (seen.has(a)) { out.push(`“${a}” is listed as an alias twice.`); continue; }
    seen.add(a);
    if (taken.has(a)) out.push(`The alias “${a}” is already used by ${taken.get(a)}.`);
  }
  return out;
}

export function problems(f: ListingFields, opts: { forPublish: boolean; cdnReady: boolean; publicUrl?: string; studio?: string; slug?: string; studios?: { slug: string }[]; address?: { self: string; others: ListingAddress[] } }): string[] {
  const out: string[] = [];
  if (f.play_url && !isHttpUrl(f.play_url)) out.push('The play URL must start with https:// (or http://).');
  if (f.gameplay_video && !isHttpUrl(f.gameplay_video)) out.push('The gameplay video must be a link.');
  for (const [name, v] of [['hero image', f.hero_image], ['thumbnail', f.thumb_image], ...f.screenshots.map((s) => ['screenshot', s])] as const) {
    if (!isImageRef(v)) out.push(`The ${name} “${v}” must be an image path on the site or an https link.`);
  }
  if (!isFit(f.fit)) out.push('Player fit must be six whole numbers: page width, page height, x, y, width, height.');
  for (const [name, v] of [['width', f.min_width], ['height', f.min_height]] as const) {
    if (!isMinSize(v)) out.push(`The minimum play ${name} must be a whole number of pixels from ${MIN_SIZE_RANGE.min} to ${MIN_SIZE_RANGE.max}, or empty for the site’s default.`);
  }
  for (const g of f.grades) if (!(GRADES as readonly string[]).includes(g)) out.push(`Unknown grade band “${g}”.`);
  // The card's categories and tags (card C): choices from the option lists; a studio value must be a studio.
  for (const errs of cardTagProblems('card_categories', f.card_categories, { studios: opts.studios })) out.push(errs);
  for (const errs of cardTagProblems('card_tags', f.card_tags, { studios: opts.studios })) out.push(errs);
  if (opts.address) for (const e of pageAddressProblems(f, opts.address.self, opts.address.others)) out.push(e);
  // The page's layout and theme (card B): always checked; the art links only when this listing's own address is
  // known (the save, the publish and the preview all pass it).
  const { publicUrl, studio, slug } = opts;
  const asset = publicUrl && studio && slug
    ? (field: 'hero_background' | 'logo_image', value: string) => layoutAssetError(field, value, { publicUrl, studio, game: slug })
    : null;
  for (const errs of Object.values(validateLayoutFields(f, asset))) for (const e of errs) out.push(e);
  if (f.play_source === 'cdn' && !opts.cdnReady) out.push('To be hosted on the Vault CDN, the game needs a CDN game with a current release.');
  if (opts.forPublish) {
    if (!f.title) out.push('Add a title.');
    if (f.play_source === 'url' && !f.play_url) out.push('Add the URL the game is hosted at.');
  }
  return out;
}

export function isListingSlug(v: unknown): v is string {
  return isSlug(v);
}

// Field-by-field differences, for "what will change on the site". The layout and theme compare after
// normalization, so a stored empty (or absent) value is equal to the default it stands for.
export function changedFields(a: ListingFields | null, b: ListingFields): (keyof ListingFields)[] {
  return (Object.keys(EMPTY_LISTING) as (keyof ListingFields)[]).filter((k) => {
    const av = a?.[k] ?? EMPTY_LISTING[k];
    const bv = b[k] ?? EMPTY_LISTING[k];
    if (k === 'page_layout') return effectivePageLayout(av) !== effectivePageLayout(bv);
    if (k === 'theme') return effectiveTheme(av) !== effectiveTheme(bv);
    return JSON.stringify(av) !== JSON.stringify(bv);
  });
}

export const FIELD_LABEL: Record<keyof ListingFields, string> = {
  title: 'Title', short_description: 'Short description', about: 'About this game', makers: 'Made by', grades: 'Grades',
  subjects: 'Subjects', topics: 'Topics', standards: 'Standards', related_curriculum: 'Related curriculum',
  gameplay_video: 'Gameplay video', hero_image: 'Hero image', thumb_image: 'Thumbnail', screenshots: 'Screenshots',
  card_title: 'Card title', card_excerpt: 'Card excerpt', card_categories: 'Card categories', card_tags: 'Card tags',
  seo_title: 'SEO title', seo_description: 'SEO description', page_address: 'Page address', aliases: 'Aliases',
  page_layout: 'Page layout', theme: 'Colour theme', hero_background: 'Hero background', logo_image: 'Logo art',
  play_source: 'Hosted by', play_url: 'Play URL', cdn_path: 'CDN folder', embed: 'Opens in', fit: 'Player fit',
  min_width: 'Minimum play width', min_height: 'Minimum play height',
};

// The public catalog entry for a published listing. `cdn` is the linked game's current production URL and release,
// if it has one; the listing's cdn_path is added to the URL.
export function catalogEntry(
  l: { slug: string; studio_slug: string; studio_name: string; studio_website?: string | null; published_at: string | null; updated_at: string; created_at: string },
  f: ListingFields,
  cdn: { url: string; release: string } | null,
) {
  const fromCdn = f.play_source === 'cdn' && cdn;
  return {
    slug: l.slug,
    title: f.title,
    studio: { slug: l.studio_slug, name: l.studio_name, url: l.studio_website || null },
    makers: f.makers.length ? f.makers : [l.studio_name],
    short_description: f.short_description,
    about: f.about,
    grades: f.grades, subjects: f.subjects, topics: f.topics, standards: f.standards,
    related_curriculum: f.related_curriculum,
    gameplay_video: f.gameplay_video,
    hero_image: f.hero_image, thumb_image: f.thumb_image, screenshots: f.screenshots,
    // The game card (card C): the title and excerpt the card shows — the field's value, or the title / short
    // description when it is empty — and its categories and tags ({ kind, value } from the portal's option lists;
    // the site maps value to its label, and filters on it). The card's image is the thumbnail.
    card_title: f.card_title || f.title,
    card_excerpt: f.card_excerpt || f.short_description,
    card_categories: f.card_categories,
    card_tags: f.card_tags,
    // Search (card C): the same fallbacks.
    seo_title: f.seo_title || f.title,
    seo_description: f.seo_description || f.short_description,
    // The listing's date (card C): the record's created date — the site sorts the cards newest-first by it.
    created_at: l.created_at,
    // The game's page on the site (card C): the address (default: the slug) and the old addresses that 301 to it.
    page_address: f.page_address || l.slug,
    aliases: f.aliases,
    // The page design (card B): the two layouts and two themes the site renders, plus the hero layout's art
    // (null: the site falls back to hero_image / thumb_image).
    page_layout: effectivePageLayout(f.page_layout),
    theme: effectiveTheme(f.theme),
    hero_background: f.hero_background ?? null,
    logo_image: f.logo_image ?? null,
    play: {
      url: fromCdn ? cdn.url + f.cdn_path : f.play_url,
      source: fromCdn ? 'cdn' : 'url',
      release: fromCdn ? cdn.release : null,
      embed: fromCdn ? true : f.embed,
      fit: fromCdn || !f.fit ? null : f.fit.split(',').map(Number),
      // The smallest game area it plays in (CSS px); null: the site's default. Whoever hosts it.
      min_width: f.min_width ?? null,
      min_height: f.min_height ?? null,
    },
    published_at: l.published_at,
  };
}
