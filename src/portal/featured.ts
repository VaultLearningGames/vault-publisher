// The featured games API behind Vault → Site games (listings.ts): the Featured checkbox, each featured game's
// sequence number and home-page blurb, and its uploaded image. Vault release managers only. The site gets the list
// from GET /v1/catalog ("featured") on its next build.
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { applyFeaturedEdit, featuredImageKey, IMAGE_CACHE, MAX_IMAGE_BYTES, readFeatured, saveFeatured, sniffImage, type FeaturedEdit, type FeaturedLists } from '../featured.ts';
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

  // A featured game's home-page image. The body is the file itself (png, jpeg or webp, up to MAX_IMAGE_BYTES, its type
  // read from its content). It goes to the Vault CDN (the release bucket) and the entry keeps its public URL.
  app.post('/portal/api/vault/featured/:slug/image', async (c) => {
    const u = editor(c);
    const slug = c.req.param('slug');
    if (!readFeatured(db).games.some((e) => e.slug === slug)) fail(400, 'That game isn’t featured.');
    if (!h.deps.production) fail(503, 'The Vault CDN storage isn’t configured here, so images can’t be uploaded.');
    const body = await readCapped(c.req.raw, MAX_IMAGE_BYTES);
    if (body === 'too big') fail(413, `The image is too big: at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
    if (!body.length) fail(400, 'Choose an image to upload.');
    const type = sniffImage(body);
    if (!type) fail(400, 'That isn’t a PNG, JPEG or WebP image.');
    const key = featuredImageKey(slug, body, type.ext);
    await h.deps.production.put(key, body, body.length, { contentType: type.contentType, cacheControl: IMAGE_CACHE });
    const url = `${h.deps.prodPublicUrl}/${key}`;
    save(u, { op: 'set', slug, image: url });
    db.audit(h.actor(u), 'featured.image', slug, { image: url, bytes: body.length });
    return c.json({ ok: true, image: url });
  });
}

// The request body, or 'too big' as soon as it passes max bytes (without reading the rest).
async function readCapped(req: Request, max: number): Promise<Uint8Array | 'too big'> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return 'too big';
  if (!req.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) return 'too big';
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
