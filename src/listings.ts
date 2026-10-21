// Site listings: what vaultlearninggames.org shows for each game (title, descriptions, grades, images, and how to
// play it). Studios edit a draft; Vault publishes it. The site is built from the published listings (/v1/catalog).
//
// A listing is hosted either at an HTML URL in Vault's in-page player (the first version of the site), or on the
// Vault CDN: the current release of one of the studio's games at https://cdn.vaultlearninggames.org/STUDIO/GAME/.
import { isSlug } from './paths.ts';
import { DEFAULT_PAGE_LAYOUT, DEFAULT_THEME, effectivePageLayout, effectiveTheme, layoutAssetError, normalizeLayoutFields, validateLayoutFields } from './portal/listing-layout.ts';

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
  thumb_image: string;
  screenshots: string[];
  // Page design (card B): one of the two layouts and one of the two themes the site offers (portal/listing-layout.ts);
  // problems() rejects anything else.
  page_layout: string;   // 'standard' | 'hero'
  theme: string;         // 'light' | 'dark'
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
  page_layout: DEFAULT_PAGE_LAYOUT, theme: DEFAULT_THEME, hero_background: null, logo_image: null,
  play_source: 'url', play_url: '', cdn_path: '', embed: true, fit: '', min_width: null, min_height: null,
};

// Fields only Vault staff set; a studio member's save or preview leaves them as they are.
export const VAULT_ONLY = ['fit', 'min_width', 'min_height'] as const;

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

// What stops a listing from being saved (hard errors) or published (also needs a title and a way to play).
// cdnReady: the listing is linked to a CDN game that has a current release.
export function problems(f: ListingFields, opts: { forPublish: boolean; cdnReady: boolean; publicUrl?: string; studio?: string; slug?: string }): string[] {
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
  page_layout: 'Page layout', theme: 'Colour theme', hero_background: 'Hero background', logo_image: 'Logo art',
  play_source: 'Hosted by', play_url: 'Play URL', cdn_path: 'CDN folder', embed: 'Opens in', fit: 'Player fit',
  min_width: 'Minimum play width', min_height: 'Minimum play height',
};

// The public catalog entry for a published listing. `cdn` is the linked game's current production URL and release,
// if it has one; the listing's cdn_path is added to the URL.
export function catalogEntry(
  l: { slug: string; studio_slug: string; studio_name: string; studio_website?: string | null; published_at: string | null; updated_at: string },
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
