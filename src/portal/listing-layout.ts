// A game page's layout and colour theme (card B of "Retire Squarespace data"). The portal offers exactly two of
// each — a decision of 2026-10-21: the layout is Standard (a cover image above the text) or Hero (a full-width
// background with the logo art over it), and the theme is Light or Dark. The site (vault-site) renders only these,
// from the listing's fields: no per-game geometry, no Squarespace data. The editor shows each choice as a picture
// of the result (layoutIcon / themeIcon), so the picker is an icon, not a word.
import { ASSETS_DIR } from '../releases.ts';
import { ACCEPTED_TYPES, IMAGE_FIELDS } from './image-fields.ts';
import { html, type Html } from './html.ts';

export const PAGE_LAYOUTS = ['standard', 'hero'] as const;
export type PageLayout = (typeof PAGE_LAYOUTS)[number];
export const DEFAULT_PAGE_LAYOUT: PageLayout = 'standard';

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'light';

export type LayoutFieldKey = 'page_layout' | 'theme' | 'hero_background' | 'logo_image';

export interface LayoutFields {
  // A PageLayout / Theme — or the raw value when a form or API sent something else, which validateLayoutFields
  // rejects (it is never silently coerced).
  page_layout: string;
  theme: string;
  // A link to the listing's own uploaded art (card A's tool), or null for none — the site then falls back
  // (hero_background to hero_image, the cover to thumb_image).
  hero_background: string | null;
  logo_image: string | null;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// The layout fields of a form or API body: an absent or empty choice is the default; an unknown choice is kept as
// is, for validateLayoutFields to reject; an image value is trimmed, and empty is null.
export function normalizeLayoutFields(input: Record<string, unknown>): LayoutFields {
  return {
    page_layout: str(input.page_layout, 20) || DEFAULT_PAGE_LAYOUT,
    theme: str(input.theme, 20) || DEFAULT_THEME,
    hero_background: str(input.hero_background, 500) || null,
    logo_image: str(input.logo_image, 500) || null,
  };
}

export const isPageLayout = (v: unknown): v is PageLayout => typeof v === 'string' && (PAGE_LAYOUTS as readonly string[]).includes(v);
export const isTheme = (v: unknown): v is Theme => typeof v === 'string' && (THEMES as readonly string[]).includes(v);

// A stored enum value as its effective value: absent or empty is the default, so a listing saved before the field
// existed compares equal to one that has the default (changedFields uses this).
export const effectivePageLayout = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_PAGE_LAYOUT);
export const effectiveTheme = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_THEME);

// One of the listing's art values, checked against the listing's own asset prefix: it must be the https URL of an
// image this listing uploaded through card A's tool (publicUrl/STUDIO/GAME/_vault-assets/KIND-HASH16.EXT, in the
// field's own kind and its own types — the upload already enforced the size cap). An external link, another
// listing's asset or a site path is refused. The error, or null when the value is kept.
export function layoutAssetError(field: 'hero_background' | 'logo_image', value: string, o: { publicUrl: string; studio: string; game: string }): string | null {
  const spec = IMAGE_FIELDS[field];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const base = `${o.publicUrl.replace(/\/+$/, '')}/${o.studio}/${o.game}/${ASSETS_DIR}`;
  // The stored extension is "jpg" for JPEG (storeImage rewrites it), the other types keep their name.
  const exts = ACCEPTED_TYPES[spec.format].map((t) => (t === 'jpeg' ? 'jpg' : t));
  const re = new RegExp(`^${esc(base)}${esc(spec.kind)}-[0-9a-f]{16}\\.(?:${exts.join('|')})$`);
  if (!re.test(value)) return `The ${spec.label.toLowerCase()} must be an image uploaded for this game; external links and other addresses are not kept.`;
  return null;
}

// The server-side check of the four layout fields of a draft: one of the two layouts, one of the two themes, and —
// when the art fields are set — the listing's own uploaded assets (through `assetValidator`, e.g. layoutAssetError;
// null skips the link check, as where the listing's address is unknown). Field-scoped errors; {} means fine.
export function validateLayoutFields(
  f: LayoutFields,
  assetValidator: ((field: 'hero_background' | 'logo_image', value: string) => string | null) | null = null,
): Partial<Record<LayoutFieldKey, string[]>> {
  const out: Partial<Record<LayoutFieldKey, string[]>> = {};
  if (!isPageLayout(f.page_layout)) out.page_layout = [`The page layout must be one of: ${PAGE_LAYOUTS.join(', ')}.`];
  if (!isTheme(f.theme)) out.theme = [`The colour theme must be one of: ${THEMES.join(', ')}.`];
  if (assetValidator) {
    for (const k of ['hero_background', 'logo_image'] as const) {
      const v = f[k];
      if (v) {
        const err = assetValidator(k, v);
        if (err) out[k] = [err];
      }
    }
  }
  return out;
}

// The pictures the pickers show: each choice drawn as a miniature of the page it gives.
// Standard: a small image to the left of text lines. Hero: a wide banner over the content.
export const layoutIcon = (v: PageLayout): Html =>
  v === 'hero'
    ? html`<svg class="opt-icon" viewBox="0 0 36 28" role="img" aria-label="The hero layout: a wide background image over the page’s content"><rect class="opt-img" x="2.5" y="2.5" width="31" height="12.5" rx="2.5"/><g class="opt-lines"><rect x="2.5" y="19" width="31" height="3.4" rx="1.7"/><rect x="2.5" y="24.3" width="20" height="3.4" rx="1.7"/></g></svg>`
    : html`<svg class="opt-icon" viewBox="0 0 36 28" role="img" aria-label="The standard layout: a small image to the left of the page’s text"><rect class="opt-img" x="2.5" y="5" width="13" height="18" rx="2.5"/><g class="opt-lines"><rect x="20" y="7.5" width="13.5" height="3.4" rx="1.7"/><rect x="20" y="13.8" width="11" height="3.4" rx="1.7"/><rect x="20" y="20.1" width="13.5" height="3.4" rx="1.7"/></g></svg>`;

// Light: a white tile with dark text bars. Dark: a near-black tile with light text bars.
export const themeIcon = (v: Theme): Html =>
  v === 'dark'
    ? html`<svg class="opt-icon" viewBox="0 0 36 28" role="img" aria-label="The dark theme: a dark page with light text"><rect class="swatch swatch-dark" x="2.5" y="2.5" width="31" height="23" rx="3"/><g class="opt-lines bars-light"><rect x="9" y="9.3" width="14" height="3.4" rx="1.7"/><rect x="9" y="15.6" width="10" height="3.4" rx="1.7"/></g></svg>`
    : html`<svg class="opt-icon" viewBox="0 0 36 28" role="img" aria-label="The light theme: a light page with dark text"><rect class="swatch swatch-light" x="2.5" y="2.5" width="31" height="23" rx="3"/><g class="opt-lines bars-dark"><rect x="9" y="9.3" width="14" height="3.4" rx="1.7"/><rect x="9" y="15.6" width="10" height="3.4" rx="1.7"/></g></svg>`;

// A radio group that shows each choice as a picture: native radios (no JavaScript, arrow keys move the selection),
// and the checked choice gets a visible outline (portal.css).
export function iconPicker(o: {
  name: string;
  label: string;
  value: string;
  disabled?: boolean;
  hint?: string;
  options: { value: string; caption: string; icon: Html }[];
}): Html {
  const dis = o.disabled ? 'disabled' : '';
  return html`<div class="field full">
    <span class="lab">${o.label}</span>
    <div class="opt-pick" role="radiogroup" aria-label="${o.label}">
      ${o.options.map((op) => html`<label class="opt">
        <input type="radio" name="${o.name}" value="${op.value}" ${o.value === op.value ? 'checked' : ''} ${dis}>
        ${op.icon}<span class="opt-cap">${op.caption}</span></label>`)}
    </div>
    ${o.hint ? html`<span class="hint">${o.hint}</span>` : ''}
  </div>`;
}
