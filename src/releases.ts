// Production layout, per game:
//   STUDIO/GAME/                    a full copy of the current release: what players load and bookmark
//   STUDIO/GAME/current.json        which release that is
//   STUDIO/GAME/_releases/VERSION/  every approved release, never changed; the source for switching and rollback
//   STUDIO/GAME/_vault-assets/      images uploaded in the portal for the game's site listing (assets.ts); never part
//                                   of a release, so switching and rollback leave it alone
import { headersFor, type ObjectHeaders } from './paths.ts';
import type { Storage } from './storage.ts';

// Release folders never change once written, so browsers and Cloudflare may keep them for a year.
export const RELEASE_CACHE = 'public, max-age=31536000, immutable';
// Files in STUDIO/GAME/ are overwritten on every switch, so browsers and Cloudflare revalidate them on each
// load (a cheap 304 when unchanged, so big .wasm/.data files aren't downloaded again).
export const LIVE_CACHE = 'no-cache';
export const RELEASES_DIR = '_releases/';
export const ASSETS_DIR = '_vault-assets/';
// Paths under STUDIO/GAME/ that belong to Vault, not to any release: a release can't contain them, and switching
// releases never copies over or removes them.
const isVaultPath = (rel: string) => rel.startsWith(RELEASES_DIR) || rel.startsWith(ASSETS_DIR) || rel === 'current.json';

export const releasePrefix = (gamePrefix: string, version: string) => `${gamePrefix}${RELEASES_DIR}${version}/`;

export class ReleaseLayoutError extends Error {}

export interface CopyResult {
  files: number;
  bytes: number;
}

// Stop starting new copies once `deadline` (ms since the epoch) has passed; what is left is `remaining`.
// `signal` stops a copy for good (a switch whose lock was taken over, see promoteStep in app.ts): nothing new starts,
// the storage calls in flight are aborted, and the copy rejects with the signal's reason. Every storage call also has
// its own timeout (`callTimeoutMs`, plus a second per MB for files that pass through this service), so a request that
// never answers fails the copy instead of hanging it. `onProgress` is called after every storage call that completes.
export interface Budget {
  deadline?: number;
  concurrency?: number;
  signal?: AbortSignal;
  callTimeoutMs?: number;
  onProgress?: () => void;
}
const pastDeadline = (b: Budget) => b.deadline !== undefined && Date.now() > b.deadline;
export const STORAGE_CALL_TIMEOUT_MS = 60_000;

export class StorageTimeoutError extends Error {}

// One storage call under the budget's signal and its own timeout. It rejects as soon as either fires, even if the
// storage doesn't honour the signal it was given.
export async function storageCall<T>(b: Budget, what: string, fn: (signal: AbortSignal) => Promise<T>, bytes = 0): Promise<T> {
  b.signal?.throwIfAborted();
  const ms = (b.callTimeoutMs ?? STORAGE_CALL_TIMEOUT_MS) + bytes / 1000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new StorageTimeoutError(`storage did not answer ${what} within ${Math.round(ms / 1000)} s`)), ms);
  const stop = () => ctl.abort(b.signal!.reason);
  b.signal?.addEventListener('abort', stop, { once: true });
  try {
    const work = fn(ctl.signal);
    work.catch(() => {}); // it may still settle after we gave up on it
    const result = await Promise.race([work, new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true }))]);
    b.onProgress?.();
    return result;
  } finally {
    clearTimeout(timer);
    b.signal?.removeEventListener('abort', stop);
  }
}

// Runs `work` on each item, `concurrency` at a time, starting none after the deadline. After the first failure (or
// the signal) nothing new starts, and the error is thrown only once every item already started has settled, so a
// caller cleaning up never races a copy still in flight. Answers the items never started.
async function pool<T>(items: T[], b: Budget, work: (item: T) => Promise<void>): Promise<T[]> {
  const queue = [...items];
  let failure: { err: unknown } | undefined;
  const next = () => (failure || b.signal?.aborted || pastDeadline(b) ? undefined : queue.shift());
  await Promise.all(Array.from({ length: b.concurrency ?? 8 }, async () => {
    for (let item = next(); item !== undefined; item = next()) {
      try { await work(item); } catch (err) { failure ??= { err }; }
    }
  }));
  if (failure) throw failure.err;
  b.signal?.throwIfAborted();
  return queue;
}

// Copies every object under `srcPrefix` in staging to `dstPrefix` in production, re-labelling each
// file with the release cache policy. On any failure it removes what it copied, so a failed approval
// can be retried (the release folder must be empty before an approval starts).
// With `resume`, files already at the destination with the right size are kept and files the source doesn't have
// are removed, so a copy cut short by its deadline (or a dropped request) carries on where it stopped. With a
// deadline it may return with `remaining` > 0: nothing is verified then; call it again with `resume`.
export async function copyRelease(opts: Budget & {
  staging: Storage;
  production: Storage;
  srcPrefix: string;
  dstPrefix: string;
  resume?: boolean;
}): Promise<CopyResult & { remaining: number }> {
  const { staging, production, srcPrefix, dstPrefix } = opts;
  const objects = await storageCall(opts, `list ${srcPrefix}`, (signal) => staging.list(srcPrefix, signal));
  if (objects.length === 0) throw new Error(`nothing in staging under ${srcPrefix}`);
  const clash = objects.map((o) => o.key.slice(srcPrefix.length)).find(isVaultPath);
  if (clash) throw new ReleaseLayoutError(`the build contains ${clash}, which would collide with the release layout (${RELEASES_DIR}, ${ASSETS_DIR} and current.json are Vault's)`);
  const total = { files: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0) };
  let todo = objects;
  if (opts.resume) {
    const there = new Map((await storageCall(opts, `list ${dstPrefix}`, (signal) => production.list(dstPrefix, signal))).map((c) => [c.key, c.size]));
    const wanted = new Set(objects.map((o) => dstPrefix + o.key.slice(srcPrefix.length)));
    const extra = [...there.keys()].filter((k) => !wanted.has(k));
    if (extra.length) await storageCall(opts, `delete ${extra.length} file(s) under ${dstPrefix}`, (signal) => production.deleteKeys(extra, signal));
    todo = objects.filter((o) => there.get(dstPrefix + o.key.slice(srcPrefix.length)) !== o.size);
  }
  const written: string[] = [];
  try {
    const left = await pool(todo, opts, async (o) => {
      const rel = o.key.slice(srcPrefix.length);
      const headers: ObjectHeaders = { ...headersFor(rel), cacheControl: RELEASE_CACHE };
      const dst = dstPrefix + rel;
      await storageCall(opts, `copy ${o.key}`, async (signal) => production.put(dst, await staging.get(o.key, signal), o.size, headers, signal), o.size);
      written.push(dst);
    });
    if (left.length) return { ...total, remaining: left.length };
    // Verify the copy before recording the release.
    const copied = new Map((await storageCall(opts, `list ${dstPrefix}`, (signal) => production.list(dstPrefix, signal))).map((c) => [c.key, c.size]));
    const bad = objects.filter((o) => copied.get(dstPrefix + o.key.slice(srcPrefix.length)) !== o.size);
    if (bad.length) throw new Error(`${bad.length} file(s) did not copy correctly, e.g. ${bad[0].key}`);
  } catch (err) {
    // Cleaning up has its own timeout but ignores the signal: a stopped copy still removes what it wrote.
    if (written.length) await storageCall({ callTimeoutMs: opts.callTimeoutMs }, `delete ${written.length} file(s)`, (signal) => production.deleteKeys(written, signal)).catch(() => {});
    throw err;
  }
  return { ...total, remaining: 0 };
}

// Copies release `version` over STUDIO/GAME/ (server-side, inside the production bucket), then removes files
// the previous release had that this one doesn't. HTML goes in last and the top index.html very last, so a
// player arriving mid-switch gets either the old page or a new page whose files are all in place.
// With a deadline it may stop part-way and return `remaining` > 0, with `done` the number of files copied in the
// fixed order below; call it again with `skip: done` to carry on (the old files and current.json stay until the end).
export async function makeLive(production: Storage, gamePrefix: string, version: string, budget: Budget & { skip?: number } | number = {}): Promise<CopyResult & { remaining: number; done: number }> {
  const b: Budget & { skip?: number } = typeof budget === 'number' ? { concurrency: budget } : budget;
  const src = releasePrefix(gamePrefix, version);
  const objects = await storageCall(b, `list ${src}`, (signal) => production.list(src, signal));
  if (objects.length === 0) throw new Error(`release ${version} has no files under ${src}`);
  const rels = objects.map((o) => ({ rel: o.key.slice(src.length), size: o.size })).sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  const clash = rels.find((r) => isVaultPath(r.rel));
  if (clash) throw new Error(`release ${version} contains ${clash.rel}, which would collide with the release layout`);
  const liveBefore = (await storageCall(b, `list ${gamePrefix}`, (signal) => production.list(gamePrefix, signal)))
    .map((o) => o.key)
    .filter((k) => !isVaultPath(k.slice(gamePrefix.length)));

  const isHtml = (rel: string) => /\.html?$/i.test(rel);
  const phases = [rels.filter((r) => !isHtml(r.rel)), rels.filter((r) => isHtml(r.rel) && r.rel !== 'index.html'), rels.filter((r) => r.rel === 'index.html')];
  const total = { files: rels.length, bytes: rels.reduce((n, r) => n + r.size, 0) };
  let skip = Math.max(0, Math.min(b.skip ?? 0, rels.length));
  let done = skip;
  for (const phase of phases) {
    const queue = phase.slice(Math.min(skip, phase.length));
    skip = Math.max(0, skip - phase.length);
    // Every copy started has settled when pool() answers, so `done` counts exactly the files in place.
    const left = await pool(queue, b, async (r) => {
      await storageCall(b, `copy ${src + r.rel}`, (signal) => production.copy(src + r.rel, gamePrefix + r.rel, { ...headersFor(r.rel), cacheControl: LIVE_CACHE }, signal));
      done++;
    });
    if (left.length) return { ...total, remaining: rels.length - done, done };
  }
  const json = new TextEncoder().encode(JSON.stringify({ version, promoted_at: new Date().toISOString() }) + '\n');
  await storageCall(b, `write ${gamePrefix}current.json`, (signal) => production.put(`${gamePrefix}current.json`, json, json.byteLength, { contentType: 'application/json', cacheControl: LIVE_CACHE }, signal));
  const keep = new Set(rels.map((r) => gamePrefix + r.rel));
  const stale = liveBefore.filter((k) => !keep.has(k));
  if (stale.length) await storageCall(b, `delete ${stale.length} old file(s) under ${gamePrefix}`, (signal) => production.deleteKeys(stale, signal));
  return { ...total, remaining: 0, done: rels.length };
}

// One-time move from the first layout (STUDIO/GAME/VERSION/ plus a redirect page at STUDIO/GAME/) to the one above.
export async function relayoutReleases(production: Storage, releases: { gamePrefix: string; version: string; current: boolean }[], log = console.log): Promise<void> {
  const moved: string[] = [];
  for (const r of releases) {
    const oldPrefix = `${r.gamePrefix}${r.version}/`;
    const newPrefix = releasePrefix(r.gamePrefix, r.version);
    const old = await production.list(oldPrefix);
    moved.push(...old.map((o) => o.key));
    const have = new Set((await production.list(newPrefix)).map((o) => o.key));
    const todo = old.filter((o) => !have.has(newPrefix + o.key.slice(oldPrefix.length))); // resumes after a crash
    for (const o of todo) await production.copy(o.key, newPrefix + o.key.slice(oldPrefix.length), { ...headersFor(o.key), cacheControl: RELEASE_CACHE });
    if (todo.length) log(`relayout: copied ${todo.length} files ${oldPrefix} -> ${newPrefix}`);
  }
  for (const r of releases.filter((x) => x.current)) {
    await makeLive(production, r.gamePrefix, r.version);
    log(`relayout: ${r.gamePrefix} now serves ${r.version} in place`);
  }
  // Remove the old copies listed above (only ever keys under STUDIO/GAME/VERSION/, and version names can't start with
  // "_", so never _releases/ or _vault-assets/), except any path the live copy now uses (makeLive has usually
  // removed them already as stale files).
  const live = new Set<string>();
  for (const r of releases.filter((x) => x.current)) {
    const src = releasePrefix(r.gamePrefix, r.version);
    for (const o of await production.list(src)) live.add(r.gamePrefix + o.key.slice(src.length));
  }
  const gone = moved.filter((k) => !live.has(k));
  if (gone.length) await production.deleteKeys(gone);
}
