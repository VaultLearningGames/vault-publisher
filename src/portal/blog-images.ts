// Uploading a blog image from the post editor (Vault admins only; 401 signed out, 403 otherwise):
//   POST /portal/api/blog/:slug/images   multipart/form-data, the file in field "file"
//     -> 200 { key, url, contentType, bytes, created }
// The browser crops, resizes and compresses the image first (portal-blog-image-editor.js); this checks what arrives
// by its first bytes (JPEG, PNG, WebP or GIF; anything else 415), at most 10 MiB (413), and stores it in the Vault
// CDN (release) bucket at site/<slug>/<sha-256>.<ext> (blog/imageKey.ts), cached for a year. The same bytes are the
// same key: an object that is already there isn't written again (created: false). Nothing is deleted here; renaming
// a post’s slug moves its images to the new slug’s folder and repoints the post at them (blog/imageMove.ts).
import type { Hono } from 'hono';
import { fail } from '../app.ts';
import { IMAGE_CACHE } from '../assets.ts';
import { buildImageKey, contentHash, imageUrl, sniffImageType } from '../blog/imageKey.ts';
import { isBlogSlug } from '../blog/slug.ts';
import { objectExists } from '../storage.ts';
import type { ListingHelpers } from './listings.ts';

export const MAX_BLOG_IMAGE_BYTES = 10 * 1024 * 1024;
// Room for the multipart boundaries and part headers around the file itself.
const MULTIPART_OVERHEAD = 64 * 1024;

// `postExists`: whether a post is at the slug (in the website repository, or a new post's autosave).
export function registerBlogImages(app: Hono, h: ListingHelpers, o: { postExists: (slug: string) => Promise<boolean> }) {

  app.post('/portal/api/blog/:slug/images', async (c) => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can manage the blog.');
    const slug = c.req.param('slug');
    if (!isBlogSlug(slug)) fail(400, 'Invalid blog post slug.');
    if (!(await o.postExists(slug).catch(() => true))) fail(404, 'No such blog post.');
    const storage = h.deps.production;
    if (!storage) fail(503, 'The Vault CDN storage isn’t configured here, so images can’t be uploaded.');

    const tooBig = `The image is too big: at most ${MAX_BLOG_IMAGE_BYTES / 1024 / 1024} MB.`;
    const contentType = c.req.header('content-type') ?? '';
    if (!/^multipart\/form-data\s*;/i.test(contentType)) fail(400, 'Send the image as multipart/form-data in the field "file".');
    const raw = await readCapped(c.req.raw, MAX_BLOG_IMAGE_BYTES + MULTIPART_OVERHEAD);
    if (raw === 'too big') fail(413, tooBig);
    let file: FormDataEntryValue | null;
    try {
      file = (await new Response(raw, { headers: { 'content-type': contentType } }).formData()).get('file');
    } catch {
      fail(400, 'The upload could not be read as multipart/form-data.');
    }
    if (!file || typeof file === 'string' || file.size === 0) fail(400, 'Choose an image to upload.');
    if (file.size > MAX_BLOG_IMAGE_BYTES) fail(413, tooBig);
    const bytes = new Uint8Array(await file.arrayBuffer());

    const type = sniffImageType(bytes);
    if (!type) fail(415, 'That isn’t a JPEG, PNG, WebP or GIF image.');
    const key = buildImageKey(slug, contentHash(bytes), type.ext);
    const created = !(await objectExists(storage, key));
    if (created) await storage.put(key, bytes, bytes.length, { contentType: type.contentType, cacheControl: IMAGE_CACHE });
    const url = imageUrl(h.deps.prodPublicUrl, key);
    if (created) h.db.audit(h.actor(u), 'blog.image', slug, { key, bytes: bytes.length });
    return c.json({ key, url, contentType: type.contentType, bytes: bytes.length, created });
  });
}

// The request body, or 'too big' when its Content-Length or the bytes actually read pass max (without reading the rest).
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | 'too big'> {
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
