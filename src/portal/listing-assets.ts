// Uploading a site listing's images from its editor: every image field of image-fields.ts (the hero image, the
// thumbnail, screenshots, the hero background and the logo art). The browser's image tool
// (public/portal-image-tool.js) crops and compresses the image to the field's row first; the body is the result,
// and it's refused unless it matches that row (type by content, width, shape and bytes: validateFieldImage). The file
// goes to the Vault CDN at STUDIO/GAME/_vault-assets/KIND-HASH.EXT (assets.ts) straight away, and its public URL goes
// into the listing's draft (the field, or appended to screenshots), so it reaches the site through the usual submit →
// Vault publish review. Whoever may edit the draft may upload.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { fail } from '../app.ts';
import { storeImage, type ImageCheck } from '../assets.ts';
import { changedFields, EMPTY_LISTING, inheritedListing, normalize } from '../listings.ts';
import { html, type Html } from './html.ts';
import { formatKB, IMAGE_FIELDS, imageFieldByKind, imageSpecJson, validateFieldImage, type ImageFieldKey, type ImageFieldSpec } from './image-fields.ts';
import { listingPieces, type ListingHelpers } from './listings.ts';

const toolJs = readFileSync(fileURLToPath(new URL('../../public/portal-image-tool.js', import.meta.url)));
const toolSrc = `/assets/portal-image-tool.js?v=${createHash('sha256').update(toolJs).digest('hex').slice(0, 10)}`;

// The upload check for a field's row (storeImage).
export function fieldCheck(spec: ImageFieldSpec): ImageCheck {
  return {
    maxBytes: spec.maxBytes,
    tooBig: `The image is too big: the ${spec.label.toLowerCase()} can be at most ${formatKB(spec.maxBytes)}.`,
    check(body) {
      const v = validateFieldImage(spec, body);
      if (!v.ok) return { status: v.status, error: v.error };
      return { ext: v.header.type === 'jpeg' ? 'jpg' : v.header.type, contentType: v.header.contentType };
    },
  };
}

export function registerListingAssetsApi(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const P = listingPieces(h);

  app.get('/assets/portal-image-tool.js', (c) => c.body(toolJs, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' }));

  app.post('/portal/api/s/:studio/listings/:slug/images/:kind', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    const l = db.listing(c.req.param('slug'));
    if (!s || !l || l.studio_id !== s.id) fail(404, 'unknown listing');
    if (!P.canEdit(u, s)) fail(403, 'Only studio members who can edit, and Vault staff who can edit game/studio content, can change site listings.');
    const target = imageFieldByKind(c.req.param('kind'));
    // A registered kind the listing model has no field for can't be uploaded (it would land nowhere).
    if (!target || !Object.hasOwn(EMPTY_LISTING, target.key)) fail(404, 'unknown image kind');
    const field = target.key as keyof typeof l.draft;
    if (target.spec.multiple && (l.draft[field] as string[]).length >= 40) fail(400, `A listing can have at most 40 ${target.spec.label.toLowerCase()}s.`);
    const { url, bytes } = await storeImage(c.req.raw, h.deps, s.slug, l.slug, target.spec.kind, fieldCheck(target.spec));
    // Re-read the draft: the upload may have taken a while.
    const now = db.listing(l.slug)!.draft;
    const draft = inheritedListing(normalize({ [field]: target.spec.multiple ? [...(now[field] as string[]), url] : url }, now));
    db.saveListingDraft(l.id, draft, h.actor(u));
    db.audit(h.actor(u), 'listing.image', `${s.slug}:${l.slug}`, { field, image: url, bytes, fields: changedFields(now, draft) });
    return c.json({ ok: true, url, field, value: draft[field] });
  });
}

// The image tool's script, once per editor that can upload.
export const imageToolScript = (): Html => html`<script type="module" src="${toolSrc}"></script>`;

// An image field in the listing editor: the typed path or link (as before), a preview of uploaded (https) images, and a
// file picker that opens the image tool (portal-image-tool.js) with the field's row of image-fields.ts; the tool crops,
// compresses and uploads, and puts the new URL into the field, so unsaved edits elsewhere in the form are kept. The
// picker has no name, so saving the form doesn't send it.
export function imageField(o: { api: string; name: ImageFieldKey; label: string; hint: string; value: string | string[]; edit: boolean; canUpload: boolean }): Html {
  const spec = IMAGE_FIELDS[o.name];
  const many = Array.isArray(o.value);
  const values = many ? o.value as string[] : [o.value as string].filter(Boolean);
  const dis = o.edit ? '' : 'disabled';
  const input = many
    ? html`<textarea id="f-${o.name}" name="${o.name}" rows="3" ${dis}>${values.join('\n')}</textarea>`
    : html`<input type="text" id="f-${o.name}" name="${o.name}" value="${o.value}" ${dis}>`;
  const prev = html`<span class="img-prev" data-prev-for="${o.name}">${values.filter((v) => /^https:\/\//.test(v)).map((v) => html`<a href="${v}" target="_blank" rel="noopener"><img class="feat-thumb" src="${v}" alt="" loading="lazy"></a>`)}</span>`;
  const up = !o.edit ? '' : o.canUpload
    ? html`<span class="img-up"><input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" aria-label="Upload ${many ? `a ${spec.label.toLowerCase()}` : `the ${o.label.toLowerCase()}`}" data-upload-image="${o.api}/images/${spec.kind}" data-field="${o.name}" data-image-spec="${imageSpecJson(spec)}">
        <span class="err" role="status" aria-live="polite"></span></span>`
    : html`<span class="small muted">Uploads need the Vault CDN storage, which isn’t configured here.</span>`;
  const shape = spec.aspect ? `cropped to ${spec.aspect.w}:${spec.aspect.h}` : 'any shape, transparency kept';
  const limit = `${shape}, at most ${spec.maxWidth} px wide and ${formatKB(spec.maxBytes)}, as WebP`;
  return html`<div class="field${many ? ' full' : ''}"><label class="lab" for="f-${o.name}">${o.label}</label>${input}
    <div class="img-row">${prev}${up}</div><span class="hint">${o.hint}${o.edit && o.canUpload ? ` Or upload one (${limit}): you crop it, it’s compressed in your browser, and it’s saved to the draft straight away.` : ''}</span></div>`;
}
