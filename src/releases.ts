// Production layout, per game:
//   STUDIO/GAME/                    a full copy of the current release: what players load and bookmark
//   STUDIO/GAME/current.json        which release that is
//   STUDIO/GAME/_releases/VERSION/  every approved release, never changed; the source for switching and rollback
import { headersFor, type ObjectHeaders } from './paths.ts';
import type { Storage } from './storage.ts';

// Release folders never change once written, so browsers and Cloudflare may keep them for a year.
export const RELEASE_CACHE = 'public, max-age=31536000, immutable';
// Files in STUDIO/GAME/ are overwritten on every switch, so browsers and Cloudflare revalidate them on each
// load (a cheap 304 when unchanged, so big .wasm/.data files aren't downloaded again).
export const LIVE_CACHE = 'no-cache';
export const RELEASES_DIR = '_releases/';

export const releasePrefix = (gamePrefix: string, version: string) => `${gamePrefix}${RELEASES_DIR}${version}/`;

export interface CopyResult {
  files: number;
  bytes: number;
}

// Copies every object under `srcPrefix` in staging to `dstPrefix` in production, re-labelling each
// file with the release cache policy. On any failure it removes what it copied, so a failed approval
// can be retried (the release folder must be empty before an approval starts).
export async function copyRelease(opts: {
  staging: Storage;
  production: Storage;
  srcPrefix: string;
  dstPrefix: string;
  concurrency?: number;
}): Promise<CopyResult> {
  const { staging, production, srcPrefix, dstPrefix } = opts;
  const objects = await staging.list(srcPrefix);
  if (objects.length === 0) throw new Error(`nothing in staging under ${srcPrefix}`);
  const written: string[] = [];
  const queue = [...objects];
  try {
    await Promise.all(
      Array.from({ length: opts.concurrency ?? 8 }, async () => {
        for (let o = queue.shift(); o; o = queue.shift()) {
          const rel = o.key.slice(srcPrefix.length);
          const headers: ObjectHeaders = { ...headersFor(rel), cacheControl: RELEASE_CACHE };
          const dst = dstPrefix + rel;
          await production.put(dst, await staging.get(o.key), o.size, headers);
          written.push(dst);
        }
      }),
    );
    // Verify the copy before recording the release.
    const copied = new Map((await production.list(dstPrefix)).map((c) => [c.key, c.size]));
    const bad = objects.filter((o) => copied.get(dstPrefix + o.key.slice(srcPrefix.length)) !== o.size);
    if (bad.length) throw new Error(`${bad.length} file(s) did not copy correctly, e.g. ${bad[0].key}`);
  } catch (err) {
    if (written.length) await production.deleteKeys(written).catch(() => {});
    throw err;
  }
  return { files: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0) };
}

// Copies release `version` over STUDIO/GAME/ (server-side, inside the production bucket), then removes files
// the previous release had that this one doesn't. HTML goes in last and the top index.html very last, so a
// player arriving mid-switch gets either the old page or a new page whose files are all in place.
export async function makeLive(production: Storage, gamePrefix: string, version: string, concurrency = 8): Promise<CopyResult> {
  const src = releasePrefix(gamePrefix, version);
  const objects = await production.list(src);
  if (objects.length === 0) throw new Error(`release ${version} has no files under ${src}`);
  const rels = objects.map((o) => ({ rel: o.key.slice(src.length), size: o.size }));
  const clash = rels.find((r) => r.rel.startsWith(RELEASES_DIR) || r.rel === 'current.json');
  if (clash) throw new Error(`release ${version} contains ${clash.rel}, which would collide with the release layout`);
  const liveBefore = (await production.list(gamePrefix))
    .map((o) => o.key)
    .filter((k) => !k.startsWith(gamePrefix + RELEASES_DIR) && k !== `${gamePrefix}current.json`);

  const isHtml = (rel: string) => /\.html?$/i.test(rel);
  const phases = [rels.filter((r) => !isHtml(r.rel)), rels.filter((r) => isHtml(r.rel) && r.rel !== 'index.html'), rels.filter((r) => r.rel === 'index.html')];
  for (const phase of phases) {
    const queue = [...phase];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        await production.copy(src + r.rel, gamePrefix + r.rel, { ...headersFor(r.rel), cacheControl: LIVE_CACHE });
      }
    }));
  }
  const json = new TextEncoder().encode(JSON.stringify({ version, promoted_at: new Date().toISOString() }) + '\n');
  await production.put(`${gamePrefix}current.json`, json, json.byteLength, { contentType: 'application/json', cacheControl: LIVE_CACHE });
  const keep = new Set(rels.map((r) => gamePrefix + r.rel));
  const stale = liveBefore.filter((k) => !keep.has(k));
  if (stale.length) await production.deleteKeys(stale);
  return { files: rels.length, bytes: rels.reduce((n, r) => n + r.size, 0) };
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
  // Remove the old copies listed above, except any path the live copy now uses (makeLive has usually
  // removed them already as stale files).
  const live = new Set<string>();
  for (const r of releases.filter((x) => x.current)) {
    const src = releasePrefix(r.gamePrefix, r.version);
    for (const o of await production.list(src)) live.add(r.gamePrefix + o.key.slice(src.length));
  }
  const gone = moved.filter((k) => !live.has(k));
  if (gone.length) await production.deleteKeys(gone);
}
