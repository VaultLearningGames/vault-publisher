// Addresses the portal prints that look live but are not, because the listing is not published yet.
// vaultlearninggames.org/games/<slug>/ 404s until Vault publishes the listing, and a CDN address opened directly in a
// browser is redirected by Cloudflare to the site page, which 404s for the same reason. Previews are the way to look.
import { html, type Html } from './html.ts';

type Pub = { published?: unknown } | null | undefined;

export const isUnpublished = (listings: Pub | Pub[]): boolean => {
  const all = Array.isArray(listings) ? listings : [listings];
  return !all.some((l) => !!l && !!l.published);
};

export const UNPUBLISHED_SITE = 'Not published yet: this address shows a “page not found” until Vault publishes the listing. Use Preview to see it.';
export const UNPUBLISHED_CDN = 'Not published yet: opened directly in a browser, this address is redirected to the site page, which shows “page not found” until Vault publishes the listing. Use Preview to see it.';

export function unpublishedWarning(listings: Pub | Pub[], kind: 'site' | 'cdn'): Html | '' {
  if (!isUnpublished(listings)) return '';
  return html`<span class="warn-note small" role="note" style="color:#9a5b00">⚠ ${kind === 'site' ? UNPUBLISHED_SITE : UNPUBLISHED_CDN}</span>`;
}
