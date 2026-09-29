// Uploading a site listing's images from its editor: the hero image, the thumbnail and screenshots. The body is the
// file itself (png, jpeg or webp, checked by content; 5 MB for the hero image, 2 MB for the others). The file goes to
// the Vault CDN at STUDIO/GAME/_vault-assets/KIND-HASH.EXT (assets.ts) straight away, and its public URL goes into the
// listing's draft (hero_image, thumb_image, or appended to screenshots), so it reaches the site through the usual
// submit → Vault publish review. Whoever may edit the draft may upload.
import type { Hono } from 'hono';
import { fail } from '../app.ts';
import { MAX_ASSET_BYTES, storeImage, type AssetKind } from '../assets.ts';
import { changedFields, normalize, type ListingFields } from '../listings.ts';
import { html, type Html } from './html.ts';
import { listingPieces, type ListingHelpers } from './listings.ts';

const FIELD: Record<string, { kind: AssetKind; field: keyof ListingFields }> = {
  hero: { kind: 'hero', field: 'hero_image' },
  thumb: { kind: 'thumb', field: 'thumb_image' },
  screenshot: { kind: 'screenshot', field: 'screenshots' },
};

export function registerListingAssetsApi(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const P = listingPieces(h);

  app.post('/portal/api/s/:studio/listings/:slug/images/:kind', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    const l = db.listing(c.req.param('slug'));
    if (!s || !l || l.studio_id !== s.id) fail(404, 'unknown listing');
    if (!P.canEdit(u, s)) fail(403, 'Only studio maintainers, admins and Vault staff can change site listings.');
    const target = FIELD[c.req.param('kind')];
    if (!target) fail(404, 'unknown image kind');
    if (target.kind === 'screenshot' && l.draft.screenshots.length >= 40) fail(400, 'A listing can have at most 40 screenshots.');
    const { url, bytes } = await storeImage(c.req.raw, h.deps, s.slug, l.slug, target.kind);
    // Re-read the draft: the upload may have taken a while.
    const now = db.listing(l.slug)!.draft;
    const draft = normalize({ [target.field]: target.kind === 'screenshot' ? [...now.screenshots, url] : url }, now);
    db.saveListingDraft(l.id, draft, h.actor(u));
    db.audit(h.actor(u), 'listing.image', `${s.slug}:${l.slug}`, { field: target.field, image: url, bytes, fields: changedFields(now, draft) });
    return c.json({ ok: true, url, field: target.field, value: draft[target.field] });
  });
}

// An image field in the listing editor: the typed path or link (as before), a preview of uploaded (https) images, and a
// file picker that uploads as soon as a file is chosen (portal.js) and puts the new URL into the field, so unsaved
// edits elsewhere in the form are kept. The picker has no name, so saving the form doesn't send it.
export function imageField(o: { api: string; name: 'hero_image' | 'thumb_image' | 'screenshots'; label: string; hint: string; value: string | string[]; edit: boolean; canUpload: boolean }): Html {
  const kind = o.name === 'hero_image' ? 'hero' : o.name === 'thumb_image' ? 'thumb' : 'screenshot';
  const many = Array.isArray(o.value);
  const values = many ? o.value as string[] : [o.value as string].filter(Boolean);
  const dis = o.edit ? '' : 'disabled';
  const input = many
    ? html`<textarea id="f-${o.name}" name="${o.name}" rows="3" ${dis}>${values.join('\n')}</textarea>`
    : html`<input type="text" id="f-${o.name}" name="${o.name}" value="${o.value}" ${dis}>`;
  const prev = html`<span class="img-prev" data-prev-for="${o.name}">${values.filter((v) => /^https:\/\//.test(v)).map((v) => html`<a href="${v}" target="_blank" rel="noopener"><img class="feat-thumb" src="${v}" alt="" loading="lazy"></a>`)}</span>`;
  const max = MAX_ASSET_BYTES[kind];
  const up = !o.edit ? '' : o.canUpload
    ? html`<span class="img-up"><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload ${many ? 'a screenshot' : `the ${o.label.toLowerCase()}`}" data-upload-image="${o.api}/images/${kind}" data-field="${o.name}" data-max="${max}">
        <span class="err" role="status" aria-live="polite"></span></span>`
    : html`<span class="small muted">Uploads need the Vault CDN storage, which isn’t configured here.</span>`;
  const limit = `PNG, JPEG or WebP, up to ${max / 1024 / 1024} MB`;
  return html`<div class="field${many ? ' full' : ''}"><label class="lab" for="f-${o.name}">${o.label}</label>${input}
    <div class="img-row">${prev}${up}</div><span class="hint">${o.hint}${o.edit && o.canUpload ? ` Or upload one (${limit}): it’s saved to the draft straight away.` : ''}</span></div>`;
}
