// Renaming a blog post's slug moves its images on the Vault CDN from site/<old slug>/ to site/<new slug>/
// (blog/imageKey.ts), around the rename's commit to the vault-site repository (portal/blog-admin.ts):
//   1. copyImages: copy each object under site/<old>/ to the same name under site/<new>/. A copy already there with the
//      same size is the same image (names are content hashes) and is skipped; a different one is a 409 and nothing is
//      overwritten. Any failure deletes only the copies this attempt made (502), and the post isn't renamed.
//   2. rewriteImageRefs: the post's image blocks and featured image pointed at the copies, then the rename is committed.
//      If the commit fails, discardCopies removes the copies again.
//   3. deleteOld: the old objects are deleted. If that fails the post is renamed already; the response says so and
//      the old objects are left (they are harmless, and the next rename of the post doesn't depend on them).
// References are rewritten whether root-relative (/site/<slug>/<file>) or on the CDN's public URL.
import { IMAGE_CACHE } from '../assets.ts';
import type { Storage } from '../storage.ts';
import type { Block } from './blocks.ts';
import { BLOG_IMAGE_DIR } from './imageKey.ts';
import type { BlogPostInput } from './repo.ts';

// A move that can't go ahead: status is the HTTP status, code the JSON "error".
export class ImageMoveError extends Error {
  readonly status: 409 | 502;
  readonly code: string;
  constructor(status: 409 | 502, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface ImageCopy { oldSlug: string; newSlug: string; keys: string[]; created: string[] }

const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const contentTypeOf = (key: string) => CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
const prefixOf = (slug: string) => `${BLOG_IMAGE_DIR}${slug}/`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

// Posts being renamed in this process, so two requests can't move the same post's images at once.
const busy = new Set<string>();

export async function withImageLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(slug)) throw new ImageMoveError(409, 'rename_in_progress', 'This post’s images are being moved; try again in a moment.');
  busy.add(slug);
  try { return await fn(); } finally { busy.delete(slug); }
}

// `src` pointed at the copy of one of `keys` (old object keys) under newSlug, or unchanged. Keeps the address's form
// (root-relative or on `publicBase`) and any ?query or #fragment.
export function rewriteRef(src: string, oldSlug: string, newSlug: string, keys: ReadonlySet<string>, publicBase?: string): string {
  const bases = [''];
  const pub = (publicBase ?? '').replace(/\/+$/, '');
  if (pub) bases.push(pub);
  for (const base of bases) {
    const from = `${base}/${prefixOf(oldSlug)}`;
    if (!src.startsWith(from)) continue;
    const rest = src.slice(from.length);
    const file = rest.replace(/[?#].*$/, '');
    if (keys.has(prefixOf(oldSlug) + file)) return `${base}/${prefixOf(newSlug)}${rest}`;
  }
  return src;
}

export function rewriteImageRefs<T extends Pick<BlogPostInput, 'blocks' | 'featured_image'>>(p: T, copy: ImageCopy, publicBase?: string): T {
  const keys = new Set(copy.keys);
  const map = (src: string) => rewriteRef(src, copy.oldSlug, copy.newSlug, keys, publicBase);
  const blocks = p.blocks.map((b): Block => (b.type === 'image' && map(b.src) !== b.src ? { ...b, src: map(b.src) } : b));
  return { ...p, blocks, featured_image: p.featured_image === null ? null : map(p.featured_image) };
}

// Step 1. Without storage, or with nothing under site/<old>/, there is nothing to move (keys empty).
export async function copyImages(storage: Storage | null, oldSlug: string, newSlug: string): Promise<ImageCopy> {
  const copy: ImageCopy = { oldSlug, newSlug, keys: [], created: [] };
  if (!storage) return copy;
  const oldPrefix = prefixOf(oldSlug), newPrefix = prefixOf(newSlug);
  let objects;
  try {
    objects = (await storage.list(oldPrefix)).filter((o) => o.key.startsWith(oldPrefix) && o.key.length > oldPrefix.length);
  } catch (err) {
    throw new ImageMoveError(502, 'image_move_failed', `Could not list the post’s images: ${message(err)}`);
  }
  if (!objects.length) return copy;
  copy.keys = objects.map((o) => o.key);
  try {
    const existing = new Map((await storage.list(newPrefix)).map((o) => [o.key, o.size]));
    for (const o of objects) {
      const dst = newPrefix + o.key.slice(oldPrefix.length);
      const there = existing.get(dst);
      if (there === o.size) continue;
      if (there !== undefined) throw new ImageMoveError(409, 'image_conflict', `A different file is already stored at ${dst}; nothing was moved.`);
      await storage.copy(o.key, dst, { contentType: contentTypeOf(dst), cacheControl: IMAGE_CACHE });
      copy.created.push(dst);
    }
  } catch (err) {
    await discardCopies(storage, copy);
    if (err instanceof ImageMoveError) throw err;
    throw new ImageMoveError(502, 'image_move_failed', `Could not copy the post’s images to its new address: ${message(err)}. Nothing was changed.`);
  }
  return copy;
}

// The rename didn't happen: removes the copies step 1 made (and nothing that was there before).
export async function discardCopies(storage: Storage | null, copy: ImageCopy): Promise<void> {
  if (storage && copy.created.length) await storage.deleteKeys(copy.created).catch(() => {});
}

// Step 3: deletes the old objects. Never throws; says what happened.
export async function deleteOld(storage: Storage | null, copy: ImageCopy): Promise<{ moved: number; status: 'done' | 'cleanup_failed'; error?: string }> {
  if (!storage || !copy.keys.length) return { moved: 0, status: 'done' };
  try {
    await storage.deleteKeys(copy.keys);
    return { moved: copy.keys.length, status: 'done' };
  } catch (err) {
    return { moved: copy.keys.length, status: 'cleanup_failed', error: message(err) };
  }
}
