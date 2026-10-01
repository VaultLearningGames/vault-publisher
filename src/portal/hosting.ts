// The "Hosted by" column of the portal's game lists (Vault → Site games, each studio's Games page): how a game
// is hosted today. 'Vault CDN' rows show the game's current release version; 'External server' rows show the
// address players play the game from. getHosting() is pure — a record in, a classification out — so every list
// and the tests share one rule; the lists feed it the record from the game's listing fields and current release.
import { html, type Html } from './html.ts';

export type HostingType = 'cdn' | 'external' | 'unknown';

export interface Hosting {
  type: HostingType;
  // What the row shows next to the type: the release version for 'cdn', the play address for 'external', and
  // null for 'unknown' (or when the type has nothing to show yet).
  detail: string | null;
}

// What a list row knows about a game's hosting.
export interface HostingGame {
  // An explicit hosting/source enum, when the record has one: a listing's play_source ('cdn' or 'url').
  play_source?: string | null;
  // The address players open to play the game: a full http(s) URL, or a path served from the Vault CDN.
  play_url?: string | null;
  // The game's current release version, when it has one (the detail shown for 'cdn').
  version?: string | null;
}

// Enum values that name the Vault CDN (its R2 bucket) or someone else's server.
function enumType(v: string | null | undefined): HostingType | null {
  const s = (v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (['cdn', 'r2', 'vault', 'vault_cdn'].includes(s)) return 'cdn';
  if (['url', 'remote', 'external', 'external_server'].includes(s)) return 'external';
  return null;
}

// A host for comparison: lowercased, and the scheme's default port (80 for http, 443 for https) dropped, so
// https://cdn.example.com/ and https://CDN.Example.com:443/ compare equal while a lookalike host does not.
function hostOf(u: URL): string {
  const def = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
  return u.port && u.port !== def ? `${u.hostname}:${u.port}` : u.hostname;
}

// Classify how a game is hosted. An explicit enum decides when present; otherwise the play address does:
// an address on the configured Vault CDN (exactly its host, or under its base URL, or a path served from it)
// is 'cdn'; any other absolute address is 'external'; a missing one is 'unknown'. The CDN base is only trusted
// when it is a valid URL, so an unconfigured or broken one can never make an address 'cdn'.
export function getHosting(game: HostingGame, cdnBase?: string | null): Hosting {
  const version = game.version?.trim() || null;
  const t = enumType(game.play_source);
  if (t === 'cdn') return { type: 'cdn', detail: version };
  if (t === 'external') return { type: 'external', detail: game.play_url?.trim() || null };
  const url = (game.play_url ?? '').trim();
  if (!url) return { type: 'unknown', detail: null };
  // No scheme: a path served from the site's CDN prefix.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return { type: 'cdn', detail: version };
  let u: URL;
  try { u = new URL(url); } catch { return { type: 'external', detail: url }; }
  const base = (cdnBase ?? '').trim().replace(/\/+$/, '');
  let b: URL | null = null;
  try { b = new URL(base); } catch { /* no CDN base: only the enum or a path can say 'cdn' */ }
  if (b) {
    // Exact host match (never a substring, so cdn.example.com.evil.com or cdn.example.com:8080 are not the
    // CDN). Any URL that genuinely starts with the base URL has the same host, so host equality covers it.
    if (hostOf(u) === hostOf(b)) return { type: 'cdn', detail: version };
  }
  return { type: 'external', detail: url };
}

// The "Hosted by" cell for a list row. Everything is rendered through the portal's escaping; the play address
// is a link only for http(s) — any other scheme is escaped text and never an href — and is visually truncated
// to fit the column, with the full address in the title.
export function hostingCell(h: Hosting): Html {
  if (h.type === 'cdn') {
    const v = h.detail;
    return html`<span class="pill p-brass">Vault CDN</span> ${v ? html`<span class="mono small">${v}</span>` : html`<span class="muted small">— (no release version)</span>`}`;
  }
  if (h.type === 'external') {
    const url = h.detail ?? '';
    const shown = !url ? html`<span class="muted small">—</span>`
      : /^https?:\/\//i.test(url)
        ? html`<a class="mono small host-url" href="${url}" target="_blank" rel="noopener noreferrer" title="${url}">${url}</a>`
        : html`<span class="mono small host-url" title="${url}">${url}</span>`;
    return html`<span class="pill p-wait">External server</span> ${shown}`;
  }
  return html`<span class="muted small" title="Hosting not set">—</span>`;
}
