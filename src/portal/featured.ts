// Vault → Featured games: which site games the home page's Featured Games section shows, in order, with optional
// home-page blurbs and images. Vault release managers edit it; other Vault staff can look. The site gets the list
// from GET /v1/catalog ("featured") on its next build.
import type { Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { applyFeaturedEdit, MAX_FEATURED, readFeatured, saveFeatured, type FeaturedEdit } from '../featured.ts';
import { html } from './html.ts';
import type { ListingHelpers, ListingRow } from './listings.ts';
import { ago, head, who } from './routes.ts';

const err = html`<span class="err" role="status" aria-live="polite"></span>`;

export function registerFeaturedPages(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const onSite = () => new Map(db.listings({ published: true }).map((l) => [l.slug, l as ListingRow]));

  app.get('/vault/featured', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const edit = h.canRelease(u);
    const f = readFeatured(db);
    const site = onSite();
    const api = '/portal/api/vault/featured';
    const n = f.games.length;

    const cards = f.games.map((e, i) => {
      const l = site.get(e.slug);
      const shown = l?.published;
      const title = shown?.title || l?.draft.title || e.slug;
      const move = (to: number, label: string, text: string) => html`<form data-api="${api}" data-then="reload"><input type="hidden" name="op" value="move"><input type="hidden" name="slug" value="${e.slug}"><input type="hidden" name="to" value="${to}"><button class="btn sm" aria-label="${label} ${title}">${text}</button></form>`;
      return html`<div class="card">
        <div class="card-h"><b>${i + 1}. ${title}</b> <small>${l ? html`${l.studio_name} · <a href="/s/${l.studio_slug}/g/${e.slug}">listing</a>` : html`<span class="err">No longer on the site, so the home page skips it.</span>`}</small></div>
        ${edit ? html`
          <form data-api="${api}" data-then="reload" class="fields">
            <input type="hidden" name="op" value="set"><input type="hidden" name="slug" value="${e.slug}">
            <label class="field full"><span class="lab">Home-page blurb (optional; *italics* work)</span>
              <textarea name="blurb" rows="3" placeholder="${shown?.short_description ?? ''}">${e.blurb}</textarea></label>
            <label class="field full"><span class="lab">Image (optional; the listing’s hero image otherwise)</span>
              <input name="image" value="${e.image}" placeholder="${shown?.hero_image || 'games/…/img/hero.jpg'}"></label>
            <div class="form-foot"><button class="btn pri">Save</button>${err}</div>
          </form>
          <div class="req-actions">
            ${i > 0 ? move(i - 1, 'Move up', '↑ Move up') : ''}
            ${i < n - 1 ? move(i + 1, 'Move down', '↓ Move down') : ''}
            <form data-api="${api}" data-then="reload" data-confirm="Take ${title} off the home page?"><input type="hidden" name="op" value="remove"><input type="hidden" name="slug" value="${e.slug}"><button class="btn sm">Remove</button>${err}</form>
          </div>`
        : html`<p class="small">${e.blurb || shown?.short_description || ''}</p>`}
      </div>`;
    });

    const choices = [...site.values()].filter((l) => !f.games.some((e) => e.slug === l.slug))
      .sort((a, b) => (a.published!.title || a.slug).localeCompare(b.published!.title || b.slug));
    const add = edit && n < MAX_FEATURED ? html`<div class="card" style="margin-top:22px"><h2>Feature another game</h2>
      <form data-api="${api}" data-then="reload" class="fields">
        <input type="hidden" name="op" value="add">
        <label class="field full"><span class="lab">Game on the site</span>
          <select name="slug" required><option value="">Choose a game…</option>${choices.map((l) => html`<option value="${l.slug}">${l.published!.title || l.slug} (${l.studio_name})</option>`)}</select></label>
        <div class="form-foot"><button class="btn pri">Add to Featured Games</button>${err}</div>
      </form></div>` : '';

    const updated = f.updated_at ? ` Last changed ${ago(f.updated_at)} by ${who(f.updated_by ?? '')}.` : '';
    const body = html`${head('Featured games', `The Featured Games section on the home page of vaultlearninggames.org shows these games, in this order (three to a row). Changes reach the site on its next build.${updated}`, html`<a class="btn" href="/v1/catalog" target="_blank">Catalog JSON ↗</a>`)}
      ${!edit ? html`<div class="card"><p class="muted">Only Vault release managers can change the featured games.</p></div>` : ''}
      ${n ? html`<div class="grid">${cards}</div>` : html`<div class="card"><p class="muted">No games are featured, so the home page leaves the section out.</p></div>`}
      ${add}`;
    return h.page(c, 'Featured games', body, { active: 'vault-featured' });
  });

  app.post('/portal/api/vault/featured', async (c) => {
    const u = h.apiUser(c);
    if (!h.canRelease(u)) fail(403, 'Only Vault release managers can change the featured games.');
    const b = await jsonBody(c);
    const op = String(b.op ?? '');
    const slug = String(b.slug ?? '').trim();
    if (!slug) fail(400, 'Choose a game.');
    let edit: FeaturedEdit;
    if (op === 'add' || op === 'remove') edit = { op, slug };
    else if (op === 'move') edit = { op, slug, to: Number(b.to) };
    else if (op === 'set') edit = { op, slug, blurb: String(b.blurb ?? ''), image: String(b.image ?? '') };
    else fail(400, 'unknown change');
    const site = onSite();
    const next = applyFeaturedEdit(readFeatured(db).games, edit, (s) => site.has(s));
    if (typeof next === 'string') fail(400, next);
    saveFeatured(db, next, h.actor(u));
    db.audit(h.actor(u), `featured.${op}`, slug, op === 'move' ? { to: Number(b.to) } : undefined);
    return c.json({ ok: true });
  });
}
