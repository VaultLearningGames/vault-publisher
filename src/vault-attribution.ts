// Vault as the traffic source in a game's own analytics: the UTM tags for a game's launch address. The website's
// player does this in the browser with site/themes/vault-squarespace/assets/js/vault-attribution.js; this is the same
// rule for server code (the server image doesn't carry the site's theme). Keep the two in step.
//
// A studio's GA4, Plausible, Unity/Godot web analytics etc. decide a session's source from document.referrer and the
// UTM parameters on the game's address; with neither they report "Direct". The tags:
//
//   utm_source=vault  utm_medium=referral  utm_campaign=<game slug>  utm_content=<surface: game_page, embed, ...>
//
// Left as given: an address that already has any utm_* parameter (the studio's own tagging wins), a signed address
// (adding parameters would break its signature), anything not http(s) or not an address, and every address while
// VAULT_ATTRIBUTION_UTM=off. The existing query is kept byte for byte, the tags go at its end, before any #fragment,
// and a relative address stays relative. Never throws.

export interface AttributionContext {
  gameSlug: string;
  /** Where the game was launched from, e.g. game_page or embed; game_page when unknown. */
  surface?: string;
}

export interface AttributionOptions {
  /** Base for a relative address (the current page); only its validity matters, the result stays relative. */
  base?: string;
  /** Overrides VAULT_ATTRIBUTION_UTM. */
  enabled?: boolean;
}

export const DEFAULT_SURFACE = 'game_page';

// Query parameter names (case-insensitive) that mean the address is signed: S3/R2 presigned, CloudFront, generic
// sig/token. Azure SAS is se + sp together; Expires counts only with a signature beside it.
const SIGNED = ['x-amz-signature', 'signature', 'sig', 'token', 'policy', 'key-pair-id'];
const DUMMY_BASE = 'https://vault-attribution.invalid/';

/** False when VAULT_ATTRIBUTION_UTM is off (also false, 0, no); on otherwise. */
export function attributionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no)$/i.test(env.VAULT_ATTRIBUTION_UTM?.trim() ?? '');
}

export function isSignedUrl(names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  const has = (n: string) => lower.includes(n);
  if (SIGNED.some(has)) return true;
  if (has('se') && has('sp')) return true;
  return has('expires') && lower.some((n) => n.includes('sig'));
}

export function buildAttributedLaunchUrl(rawUrl: string, ctx: AttributionContext, opts: AttributionOptions = {}): string {
  try {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return rawUrl;
    if (!(opts.enabled ?? attributionEnabled())) return rawUrl;
    const u = new URL(rawUrl, opts.base || DUMMY_BASE);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return rawUrl;
    const names = [...u.searchParams.keys()];
    if (names.some((n) => n.toLowerCase().startsWith('utm_'))) return rawUrl;
    if (isSignedUrl(names)) return rawUrl;

    const tags = new URLSearchParams({ utm_source: 'vault', utm_medium: 'referral' });
    const slug = String(ctx?.gameSlug ?? '').trim();
    if (slug) tags.set('utm_campaign', slug);
    tags.set('utm_content', String(ctx?.surface ?? '').trim() || DEFAULT_SURFACE);

    // Edit the address as written, so a relative one stays relative and the existing query keeps its exact encoding.
    const hashAt = rawUrl.indexOf('#');
    const hash = hashAt >= 0 ? rawUrl.slice(hashAt) : '';
    const rest = hashAt >= 0 ? rawUrl.slice(0, hashAt) : rawUrl;
    const queryAt = rest.indexOf('?');
    const path = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
    let query = queryAt >= 0 ? rest.slice(queryAt + 1) : '';
    if (query && !query.endsWith('&')) query += '&';
    return `${path}?${query}${tags}${hash}`;
  } catch {
    return rawUrl;
  }
}
