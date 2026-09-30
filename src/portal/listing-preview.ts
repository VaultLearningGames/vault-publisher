// Previewing a listing's unsaved edits on the website. The editor's Preview button posts the form as it is; the
// fields are cleaned up exactly as a save would (nothing is saved) and turned into the game object /v1/catalog would
// publish. That is kept for PREVIEW_TTL_MS under a random token, and the site shows it at SITE/_preview/TOKEN/,
// fetching GET /v1/listing-previews/TOKEN:
//   { "version": 1, "game": <a /v1/catalog game>, "studios": <as /v1/catalog's studios> }
// Previews are kept in memory: the service runs as one instance, and a lost preview only needs another click.
import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { catalogGame, catalogStudios } from '../catalog.ts';
import { normalize, problems, type ListingFields } from '../listings.ts';
import type { PreviewSite } from '../config.ts';
import { html, type Html } from './html.ts';
import { listingPieces, type ListingHelpers, type ListingRow } from './listings.ts';

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const MAX_PREVIEWS = 500;

export interface PreviewBody {
  version: 1;
  game: ReturnType<typeof catalogGame>;
  studios: ReturnType<typeof catalogStudios>;
}

export class PreviewStore {
  private items = new Map<string, { body: PreviewBody; expires: number }>();
  private now: () => number;
  constructor(now = () => Date.now()) { this.now = now; }
  put(body: PreviewBody): { token: string; expires: number } {
    this.prune();
    while (this.items.size >= MAX_PREVIEWS) this.items.delete(this.items.keys().next().value!); // oldest first
    const token = randomBytes(32).toString('base64url');                                         // 43 url-safe chars
    const expires = this.now() + PREVIEW_TTL_MS;
    this.items.set(token, { body, expires });
    return { token, expires };
  }
  get(token: string): PreviewBody | undefined {
    const it = this.items.get(token);
    if (!it) return undefined;
    if (it.expires <= this.now()) { this.items.delete(token); return undefined; }
    return it.body;
  }
  get size() { return this.items.size; }
  private prune() {
    const t = this.now();
    for (const [k, v] of this.items) if (v.expires <= t) this.items.delete(k);
  }
}

// Turns an editor form (as the save endpoint receives it) into the draft a save would store, or fails with the same
// problems a save would. Shared with the save endpoint's rules: only Vault sets the player fit.
export function formToDraft(b: Record<string, unknown>, base: ListingFields, canPublish: boolean, cdnReady: boolean): ListingFields {
  if (typeof b.embed === 'string') b.embed = b.embed === 'true';
  if (!canPublish) delete b.fit;
  const draft = normalize(b, base);
  const bad = problems(draft, { forPublish: false, cdnReady });
  if (bad.length) fail(400, bad.join(' '));
  return draft;
}

export function registerListingPreview(app: Hono, h: ListingHelpers, store = new PreviewStore()) {
  const { db } = h;
  const P = listingPieces(h);
  const sites = h.deps.previewSites ?? [];

  app.post('/portal/api/s/:studio/listings/:slug/preview', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    const l = db.listing(c.req.param('slug'));
    if (!s || !l || l.studio_id !== s.id) fail(404, 'unknown listing');
    if (!P.canEdit(u, s)) fail(403, 'Only studio maintainers, admins and Vault staff can preview site listings.');
    if (!sites.length) fail(503, 'No preview sites are configured here.');
    const cdnReady = !!(l.game_id && db.currentRelease(l.game_id));
    const draft = formToDraft(await jsonBody(c), l.draft, P.canPublish(u), cdnReady);
    const game = catalogGame(db, h.deps.prodPublicUrl, l, draft);
    // The catalog's studios, plus this game's studio when it has nothing on the site yet.
    const studios = catalogStudios([...db.listings({ published: true }), l]);
    const { token, expires } = store.put({ version: 1, game, studios });
    return c.json({ ok: true, token, expires_at: new Date(expires).toISOString(), urls: sites.map((site) => ({ label: site.label, url: `${site.url}/_preview/${token}/` })) });
  });

  app.get('/v1/listing-previews/:token', (c: Context) => {
    const body = store.get(c.req.param('token') ?? '');
    c.header('Cache-Control', 'no-store');
    if (!body) return c.json({ error: 'This preview has expired or doesn’t exist.' }, 404);
    return c.json(body);
  });
}

// The editor's save controls. Vault (who may publish) saves and publishes in one step; studio members save the draft
// and may submit it for review.
export function saveControls(canPublish: boolean, l: ListingRow): Html {
  if (canPublish) return html`<input type="hidden" name="publish" value="1"><button class="btn pri">Save and Publish Changes</button>`;
  return html`<button class="btn pri">Save and Submit for Review</button>`;
}

// Preview buttons: the first site is "Preview", the others "Preview (Label)". None without preview sites.
export function previewButtons(api: string, sites: PreviewSite[] = []): Html | '' {
  if (!sites.length) return '';
  return html`${sites.map((site, i) => html`<button type="button" class="btn${i ? ' sm' : ''}" data-preview="${api}/preview" data-site="${i}" title="Show the unsaved edits on ${site.url}">${i ? `Preview (${site.label})` : 'Preview'}</button>`)}`;
}
