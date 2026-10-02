// The featured games API behind Vault → Game Catalog (listings.ts): the Featured checkbox, each featured game's
// sequence number and home-page blurb, and its uploaded image. Vault release managers only. The site gets the list
// from GET /v1/catalog ("featured") on its next build.
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { applyFeaturedEdit, readFeatured, saveFeatured, type FeaturedEdit, type FeaturedLists } from '../featured.ts';
import { storeImage } from '../assets.ts';
import type { User } from '../db.ts';
import type { ListingHelpers } from './listings.ts';

export function registerFeaturedApi(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const onSite = () => new Set(db.listings({ published: true }).map((l) => l.slug));
  const editor = (c: Context): User => {
    const u = h.apiUser(c);
    if (!h.canRelease(u)) fail(403, 'Only Vault release managers can change the featured games.');
    return u;
  };
  const save = (u: User, edit: FeaturedEdit): FeaturedLists => {
    const site = onSite();
    const next = applyFeaturedEdit(readFeatured(db), edit, (s) => site.has(s));
    if (typeof next === 'string') fail(400, next);
    saveFeatured(db, next, h.actor(u));
    return next;
  };

  // Body: { op: "feature", slug, featured: true|false } (the checkbox), or
  //       { op: "set", slug, sequence?, blurb?, image? } (image "" goes back to the listing's hero image).
  app.post('/portal/api/vault/featured', async (c) => {
    const u = editor(c);
    const b = await jsonBody(c);
    const op = String(b.op ?? '');
    const slug = String(b.slug ?? '').trim();
    if (!slug) fail(400, 'Choose a game.');
    let edit: FeaturedEdit;
    if (op === 'feature') edit = { op, slug, on: b.featured === true || b.featured === 'on' };
    else if (op === 'set') edit = { op, slug, sequence: b.sequence, blurb: typeof b.blurb === 'string' ? b.blurb : undefined, image: typeof b.image === 'string' ? b.image : undefined };
    else fail(400, 'unknown change');
    save(u, edit);
    db.audit(h.actor(u), op === 'feature' ? `featured.${edit.op === 'feature' && edit.on ? 'add' : 'remove'}` : 'featured.set', slug,
      op === 'set' ? { fields: ['sequence', 'blurb', 'image'].filter((k) => b[k] !== undefined), sequence: b.sequence } : undefined);
    return c.json({ ok: true });
  });

  // A featured game's home-page image. The body is the file itself (png, jpeg or webp, up to 2 MB, its type read from
  // its content). It goes to the Vault CDN (the release bucket) under the listing's STUDIO/GAME/_vault-assets/ and the
  // entry keeps its public URL.
  app.post('/portal/api/vault/featured/:slug/image', async (c) => {
    const u = editor(c);
    const slug = c.req.param('slug');
    if (!readFeatured(db).games.some((e) => e.slug === slug)) fail(400, 'That game isn’t featured.');
    const l = db.listing(slug);
    if (!l) fail(400, 'That game isn’t on the site.');
    const { url, bytes } = await storeImage(c.req.raw, h.deps, l.studio_slug, l.slug, 'featured');
    save(u, { op: 'set', slug, image: url });
    db.audit(h.actor(u), 'featured.image', slug, { image: url, bytes });
    return c.json({ ok: true, image: url });
  });
}
