// Previewing a listing's unsaved edits on the website. The editor's Preview button posts the form as it is; the
// fields are cleaned up exactly as a save would (nothing is saved) and turned into the game object /v1/catalog would
// publish. That is kept for PREVIEW_TTL_MS under a random token. The portal itself renders the page, with the
// website's own templates (site-preview.ts runs Hugo on site/), at
//   GET /_preview/TOKEN/              what the editor's Preview button opens (PREVIEW_SITES points at this portal)
//   GET /v1/listing-previews/TOKEN    the same page
// A caller that asks /v1/listing-previews/TOKEN for JSON (Accept: application/json, and not text/html) gets the data
// instead, { "version": 1, "game": <a /v1/catalog game>, "studios": <as /v1/catalog's studios> }: a site that still
// renders its own previews at SITE/_preview/TOKEN/ (the new design, on Cloud Run) reads it that way.
// Previews are kept in memory: the service runs as one instance, and a lost preview only needs another click.
import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { catalogGame, catalogStudios } from '../catalog.ts';
import { normalize, problems, type ListingFields } from '../listings.ts';
import type { PreviewSite } from '../config.ts';
import { html, type Html } from './html.ts';
import { listingPieces, type ListingHelpers, type ListingRow } from './listings.ts';
import { EXPIRED, NOT_FOUND, PREVIEW_HEADERS, TOKEN_RE, UNAVAILABLE } from './site-preview.ts';

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
    // The catalog's studios, plus this game's studio when it has nothing on the site yet, and its makers' studios.
    const published = db.listings({ published: true });
    const studios = catalogStudios([...published, l], db.studios(), [...published.map((x) => x.published!), draft]);
    const { token, expires } = store.put({ version: 1, game, studios });
    return c.json({ ok: true, token, expires_at: new Date(expires).toISOString(), urls: sites.map((site) => ({ label: site.label, url: `${site.url}/_preview/${token}/` })) });
  });

  // The preview as a page. Always no-store, noindex and sandboxed (PREVIEW_HEADERS), whatever the answer.
  async function page(c: Context, token: string): Promise<Response> {
    const send = (status: number, body: string) => new Response(c.req.method === 'HEAD' ? null : body, { status, headers: PREVIEW_HEADERS });
    if (!TOKEN_RE.test(token)) return send(404, NOT_FOUND);
    const body = store.get(token);
    if (!body) return send(404, EXPIRED);
    const previewer = h.deps.sitePreview;
    if (!previewer) return send(503, UNAVAILABLE);
    const { status, body: htmlPage } = await previewer.page(token, body);
    return send(status, htmlPage);
  }

  app.get('/_preview/:token/', (c: Context) => page(c, c.req.param('token') ?? ''));
  app.get('/_preview/:token', (c: Context) => {
    const token = c.req.param('token') ?? '';
    if (!TOKEN_RE.test(token)) return new Response(NOT_FOUND, { status: 404, headers: PREVIEW_HEADERS });
    return new Response(null, { status: 301, headers: { Location: `/_preview/${token}/`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  });
  app.get('/_preview/*', () => new Response(NOT_FOUND, { status: 404, headers: PREVIEW_HEADERS }));

  app.get('/v1/listing-previews/:token', async (c: Context): Promise<Response> => {
    const token = c.req.param('token') ?? '';
    if (!wantsJson(c.req.header('accept'))) return page(c, token);
    const body = store.get(token);
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
    if (!body) return c.json({ error: 'This preview has expired or doesn’t exist.' }, 404);
    return c.json(body);
  });
}

// JSON only for a caller that asks for it and not for a page: browsers (text/html) and plain requests get the page.
export function wantsJson(accept: string | undefined): boolean {
  const a = (accept ?? '').toLowerCase();
  return a.includes('application/json') && !a.includes('text/html');
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
