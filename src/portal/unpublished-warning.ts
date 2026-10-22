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

// The same redirect, for a game that is published: the CDN address still works, but a browser is sent to the site
// page that hosts the game (a Cloudflare rule sends document and cross-site iframe requests to cdn.* to /cdn<path>
// on the site). A neutral note, so the two addresses are not mistaken for two different games.
export const CDN_REDIRECT_NOTE = 'Opened directly in a browser, this address is redirected to the game’s page on the site by design.';

export function cdnRedirectNote(): Html {
  return html`<span class="small muted" role="note">${CDN_REDIRECT_NOTE}</span>`;
}
