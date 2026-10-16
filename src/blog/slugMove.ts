// Changing a blog post's slug moves its images from site/<old slug>/ to site/<new slug>/ (blog/imageKey.ts), as a saga
// recorded in blog_slug_moves:
//   1. list site/<old>/; with nothing there it is a plain slug change (repo.update keeps the old slug as a redirect).
//   2. 'copying': copy each object to the same name under site/<new>/. A copy already there with the same size is the
//      same image (names are content hashes) and is skipped; a different one is a 409 and nothing is overwritten. Any
//      failure deletes only the copies this attempt made, marks the move 'failed', and leaves the post as it was (502).
//   3. one transaction: the new slug, the image blocks and featured_image pointing at the copies, 'cleanup_pending'.
//   4. delete the old objects (except any another post still points at), then 'done'. If that fails the post is
//      already renamed and the move stays 'cleanup_pending': the next rename of the post, or
//      POST /portal/api/blog/posts/:id/slug-move/retry, finishes it.
// References are rewritten whether root-relative (/site/<slug>/<file>) or on the CDN's public URL. Saves that still
// send the old addresses (an editor opened before the rename) are pointed at the moved copies too (rewriteMovedRefs).
import type { DatabaseSync } from 'node:sqlite';
import { IMAGE_CACHE } from '../assets.ts';
import type { Storage } from '../storage.ts';
import type { Block } from './blocks.ts';
import { BLOG_IMAGE_DIR } from './imageKey.ts';
import type { BlogPost, BlogPostInput, BlogRepo } from './repo.ts';

export type SlugMoveStatus = 'copying' | 'cleanup_pending' | 'done' | 'failed';
export interface SlugMove {
  id: number; post_id: number; old_slug: string; new_slug: string; status: SlugMoveStatus; keys: string[];
  last_error: string | null; created_at: string; updated_at: string;
}

// A rename that can't go ahead: status is the HTTP status, code the JSON "error".
export class SlugMoveError extends Error {
  readonly status: 409 | 502;
  readonly code: string;
  constructor(status: 409 | 502, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface SlugMoveDeps {
  repo: BlogRepo;
  storage: Storage | null;                 // the Vault CDN bucket; without one, slugs change and nothing moves
  publicBase?: string;                     // the CDN's public base URL, for references stored as absolute URLs
}

const CONTENT_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const contentTypeOf = (key: string) => CONTENT_TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
const prefixOf = (slug: string) => `${BLOG_IMAGE_DIR}${slug}/`;
const now = () => new Date().toISOString();
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

// Posts being renamed in this process, so two requests can't move the same post's images at once.
const busy = new Set<number>();

export function slugMoves(sqlite: DatabaseSync, postId: number): SlugMove[] {
  return (sqlite.prepare('SELECT * FROM blog_slug_moves WHERE post_id = ? ORDER BY id').all(postId) as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id), post_id: Number(r.post_id), old_slug: String(r.old_slug), new_slug: String(r.new_slug), status: r.status as SlugMoveStatus,
    keys: JSON.parse(String(r.keys_json)) as string[], last_error: (r.last_error as string | null) ?? null,
    created_at: String(r.created_at), updated_at: String(r.updated_at),
  }));
}

function setStatus(sqlite: DatabaseSync, id: number, status: SlugMoveStatus, error: string | null) {
  sqlite.prepare('UPDATE blog_slug_moves SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, error, now(), id);
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

function rewriteInput(p: BlogPostInput, map: (src: string) => string): BlogPostInput {
  const blocks = p.blocks.map((b): Block => (b.type === 'image' && map(b.src) !== b.src ? { ...b, src: map(b.src) } : b));
  return { ...p, blocks, featured_image: p.featured_image === null ? null : map(p.featured_image) };
}

// The input with every reference to an image an earlier rename of this post moved pointed at where it is now.
export function rewriteMovedRefs(sqlite: DatabaseSync, postId: number, p: BlogPostInput, publicBase?: string): BlogPostInput {
  let out = p;
  for (const m of slugMoves(sqlite, postId)) {
    if (m.status !== 'cleanup_pending' && m.status !== 'done') continue;
    const keys = new Set(m.keys);
    out = rewriteInput(out, (src) => rewriteRef(src, m.old_slug, m.new_slug, keys, publicBase));
  }
  return out;
}

// Deletes a move's old objects (but not ones any post still points at) and marks it done. Throws, leaving it
// 'cleanup_pending' with the error, when the storage fails.
async function cleanup(deps: SlugMoveDeps, move: SlugMove): Promise<void> {
  const sqlite = deps.repo.sqlite;
  try {
    const stillUsed = sqlite.prepare("SELECT 1 FROM blog_posts WHERE instr(blocks, ?) > 0 OR instr(COALESCE(featured_image, ''), ?) > 0 LIMIT 1");
    const keys = move.keys.filter((k) => !stillUsed.get(`/${k}`, `/${k}`));
    if (keys.length) {
      if (!deps.storage) throw new Error('The Vault CDN storage isn’t configured here.');
      await deps.storage.deleteKeys(keys);
    }
    setStatus(sqlite, move.id, 'done', null);
  } catch (err) {
    setStatus(sqlite, move.id, 'cleanup_pending', message(err));
    throw err;
  }
}

// Finishes what earlier renames of the post left: deletes old objects still pending, and marks a 'copying' move that
// never finished (the process stopped mid-copy; the post kept its slug) failed. Returns the moves still pending.
async function finishPending(deps: SlugMoveDeps, postId: number): Promise<SlugMove[]> {
  const pending: SlugMove[] = [];
  for (const m of slugMoves(deps.repo.sqlite, postId)) {
    if (m.status === 'copying') setStatus(deps.repo.sqlite, m.id, 'failed', m.last_error ?? 'interrupted while copying');
    else if (m.status === 'cleanup_pending') {
      try { await cleanup(deps, m); } catch { pending.push({ ...m, status: 'cleanup_pending' }); }
    }
  }
  return pending;
}

async function locked<T>(postId: number, fn: () => Promise<T>): Promise<T> {
  if (busy.has(postId)) throw new SlugMoveError(409, 'rename_in_progress', 'This post’s images are being moved; try again in a moment.');
  busy.add(postId);
  try { return await fn(); } finally { busy.delete(postId); }
}

// POST .../slug-move/retry: finishes the post's pending moves. Returns the ones still pending.
export function retrySlugMoves(deps: SlugMoveDeps, postId: number): Promise<SlugMove[]> {
  return locked(postId, () => finishPending(deps, postId));
}

export interface UpdateResult { post: BlogPost | undefined; move?: { id: number; status: SlugMoveStatus; moved: number; error?: string } }

// repo.update(id, input) for the admin routes, moving the post's images when input.slug differs from base.slug.
// Throws SlugMoveError (409/502) or the repo's SlugTakenError; in either case the post and its old images are unchanged.
export async function updatePost(deps: SlugMoveDeps, id: number, base: BlogPost, input: BlogPostInput): Promise<UpdateResult> {
  const { repo, storage } = deps;
  const sqlite = repo.sqlite;
  input = rewriteMovedRefs(sqlite, id, input, deps.publicBase);
  if (input.slug === base.slug || !storage) return { post: repo.update(id, input) };

  return locked(id, async () => {
    const pending = await finishPending(deps, id);
    if (pending.length) {
      throw new SlugMoveError(409, 'previous_rename_cleanup_pending',
        `The images of an earlier rename (/${pending[0].old_slug} -> /${pending[0].new_slug}) are still being cleaned up: ${pending[0].last_error ?? 'unknown error'}. Retry that first.`);
    }
    if (repo.slugTaken(input.slug, id)) return { post: repo.update(id, input) }; // throws SlugTakenError

    const oldSlug = base.slug, newSlug = input.slug;
    const oldPrefix = prefixOf(oldSlug), newPrefix = prefixOf(newSlug);
    let objects;
    try {
      objects = (await storage.list(oldPrefix)).filter((o) => o.key.startsWith(oldPrefix) && o.key.length > oldPrefix.length);
    } catch (err) {
      throw new SlugMoveError(502, 'image_move_failed', `Could not list the post’s images: ${message(err)}`);
    }
    if (!objects.length) return { post: repo.update(id, input) };

    const keys = objects.map((o) => o.key);
    const t = now();
    const moveId = Number(sqlite.prepare(`INSERT INTO blog_slug_moves (post_id, old_slug, new_slug, status, keys_json, created_at, updated_at)
      VALUES (?, ?, ?, 'copying', ?, ?, ?)`).run(id, oldSlug, newSlug, JSON.stringify(keys), t, t).lastInsertRowid);

    // Copies this attempt made, so a failure removes exactly those and nothing that was there before.
    const created: string[] = [];
    const abandon = async (err: unknown) => {
      if (created.length) await storage.deleteKeys(created).catch(() => {});
      setStatus(sqlite, moveId, 'failed', message(err));
    };
    try {
      const existing = new Map((await storage.list(newPrefix)).map((o) => [o.key, o.size]));
      for (const o of objects) {
        const dst = newPrefix + o.key.slice(oldPrefix.length);
        const there = existing.get(dst);
        if (there === o.size) continue;
        if (there !== undefined) {
          throw new SlugMoveError(409, 'image_conflict', `A different file is already stored at ${dst}; nothing was moved.`);
        }
        await storage.copy(o.key, dst, { contentType: contentTypeOf(dst), cacheControl: IMAGE_CACHE });
        created.push(dst);
      }
    } catch (err) {
      await abandon(err);
      if (err instanceof SlugMoveError) throw err;
      throw new SlugMoveError(502, 'image_move_failed', `Could not copy the post’s images to its new address: ${message(err)}. Nothing was changed.`);
    }

    const moved = new Set(keys);
    const rewritten = rewriteInput(input, (src) => rewriteRef(src, oldSlug, newSlug, moved, deps.publicBase));
    let post: BlogPost | undefined;
    try {
      post = repo.update(id, rewritten, (cur) => {
        if (cur.slug !== oldSlug) throw new SlugMoveError(409, 'post_changed', 'This post’s slug was changed elsewhere meanwhile. Reload it.');
        setStatus(sqlite, moveId, 'cleanup_pending', null);
      });
    } catch (err) {
      await abandon(err);
      throw err;
    }
    if (!post) {
      await abandon(new Error('the post was deleted'));
      return { post };
    }

    const move = slugMoves(sqlite, id).find((m) => m.id === moveId)!;
    try {
      await cleanup(deps, move);
      return { post, move: { id: moveId, status: 'done', moved: keys.length } };
    } catch (err) {
      return { post, move: { id: moveId, status: 'cleanup_pending', moved: keys.length, error: message(err) } };
    }
  });
}
