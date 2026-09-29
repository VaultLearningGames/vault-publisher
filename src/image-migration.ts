// One-time (and safely repeatable) move of site listings' images onto the Vault CDN. Listings imported from the Hugo
// site point at images in the website repo by site path ("games/x/img/hero.png"). For every listing's published and
// draft hero_image, thumb_image and screenshots, and every featured game's image, a site path is downloaded from the
// site, checked like an upload, stored exactly as an upload would be (STUDIO/GAME/_vault-assets/KIND-HASH.EXT, see
// assets.ts) and replaced by its absolute CDN URL.
//
// - Only site paths move. http(s) URLs (another host the studio chose, or the CDN already) are left alone and
//   reported. A CDN _vault-assets/ URL counts as already migrated.
// - The same image is the same object (named by content hash); an object that exists already isn't written again.
// - Rewriting the published listing changes only those image fields and nothing else (not its publish date, not its
//   review state): it's the same image, so it needs no new review. Drafts are rewritten the same way, so a listing
//   whose draft matched what's published still matches.
// - Running it again changes nothing.
import type { Db } from './db.ts';
import { ASSETS_DIR, assetKey, IMAGE_CACHE, sniffImage, type AssetKind } from './assets.ts';
import { FEATURED_KEY, readFeatured, type FeaturedEntry } from './featured.ts';
import type { ListingFields } from './listings.ts';
import type { Storage } from './storage.ts';

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;

export interface MigrationItem {
  listing: string;          // the listing's page slug
  field: string;            // hero_image, thumb_image, screenshots, featured image
  where: 'published' | 'draft' | 'featured';
  from: string;
  to?: string;              // migrated: the CDN URL
  reason?: string;          // failed: why
}
export interface MigrationResult {
  base: string;
  ran_at: string;
  by: string;
  migrated: MigrationItem[];
  already: number;          // image values already on the Vault CDN (_vault-assets/)
  failed: MigrationItem[];
  external: MigrationItem[];
  objects_written: number;
}

export const isSitePath = (v: string) => v !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('//');

export async function migrateListingImages(opts: {
  db: Db;
  production: Storage;
  prodPublicUrl: string;
  base: string;
  actor: string;
  fetch?: typeof fetch;
}): Promise<MigrationResult> {
  const { db, production, prodPublicUrl, actor } = opts;
  const base = opts.base.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const result: MigrationResult = { base, ran_at: new Date().toISOString(), by: actor, migrated: [], already: 0, failed: [], external: [], objects_written: 0 };
  const isOurs = (v: string) => v.startsWith(`${prodPublicUrl}/`) && v.includes(`/${ASSETS_DIR}`);

  // Every image value, with where it is and how to put the new URL back.
  type Ref = { item: MigrationItem; studio: string; game: string; kind: AssetKind; set: (url: string) => void };
  const refs: Ref[] = [];
  const listings = db.listings();
  const edited = new Map<number, { draft: ListingFields; published: ListingFields | null }>();
  for (const l of listings) {
    const copy = { draft: structuredClone(l.draft), published: l.published ? structuredClone(l.published) : null };
    edited.set(l.id, copy);
    for (const where of ['published', 'draft'] as const) {
      const f = copy[where];
      if (!f) continue;
      const one = (field: 'hero_image' | 'thumb_image', kind: AssetKind) =>
        refs.push({ item: { listing: l.slug, field, where, from: f[field] }, studio: l.studio_slug, game: l.slug, kind, set: (u) => { f[field] = u; } });
      one('hero_image', 'hero');
      one('thumb_image', 'thumb');
      f.screenshots.forEach((v, i) => refs.push({ item: { listing: l.slug, field: 'screenshots', where, from: v }, studio: l.studio_slug, game: l.slug, kind: 'screenshot', set: (u) => { f.screenshots[i] = u; } }));
    }
  }
  const featured = readFeatured(db);
  const bySlug = new Map(listings.map((l) => [l.slug, l]));
  const lists = { games: featured.games.map((e) => ({ ...e })), unfeatured: featured.unfeatured.map((e) => ({ ...e })) };
  for (const e of [...lists.games, ...lists.unfeatured] as FeaturedEntry[]) {
    const l = bySlug.get(e.slug);
    if (!l) continue;
    refs.push({ item: { listing: e.slug, field: 'featured image', where: 'featured', from: e.image }, studio: l.studio_slug, game: l.slug, kind: 'featured', set: (u) => { e.image = u; } });
  }

  // Download each distinct site path once.
  const todo = refs.filter((r) => r.item.from !== '');
  const paths = [...new Set(todo.filter((r) => isSitePath(r.item.from)).map((r) => r.item.from))];
  const got = new Map<string, { bytes: Uint8Array; ext: string; contentType: string } | { error: string }>();
  const queue = [...paths];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) got.set(p, await download(doFetch, base, p));
  }));

  // Sort the values, then store each distinct object once (skipping objects that exist), then point the refs at them.
  const toStore = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const placed: { r: Ref; key: string }[] = [];
  for (const r of todo) {
    const v = r.item.from;
    if (isOurs(v)) { result.already++; continue; }
    if (!isSitePath(v)) { result.external.push(r.item); continue; }
    const file = got.get(v)!;
    if ('error' in file) { result.failed.push({ ...r.item, reason: file.error }); continue; }
    const key = assetKey(r.studio, r.game, r.kind, file.bytes, file.ext);
    toStore.set(key, file);
    placed.push({ r, key });
  }
  const keys = [...toStore.keys()];
  const failedKeys = new Map<string, string>();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let key = keys.shift(); key !== undefined; key = keys.shift()) {
      const file = toStore.get(key)!;
      try {
        if ((await production.list(key)).some((o) => o.key === key)) continue;
        await production.put(key, file.bytes, file.bytes.length, { contentType: file.contentType, cacheControl: IMAGE_CACHE });
        result.objects_written++;
      } catch (err) {
        failedKeys.set(key, `couldn’t store it on the CDN: ${(err as Error).message}`);
      }
    }
  }));
  let changedListings = false, changedFeatured = false;
  for (const { r, key } of placed) {
    const why = failedKeys.get(key);
    if (why) { result.failed.push({ ...r.item, reason: why }); continue; }
    const url = `${prodPublicUrl}/${key}`;
    r.set(url);
    result.migrated.push({ ...r.item, to: url });
    if (r.kind === 'featured') changedFeatured = true; else changedListings = true;
  }

  // Write back only the image fields: the JSON columns, without touching dates, authors or review state.
  if (changedListings) {
    const upd = db.sqlite.prepare('UPDATE listings SET draft_json = ?, published_json = ? WHERE id = ?');
    for (const l of listings) {
      const e = edited.get(l.id)!;
      if (JSON.stringify(e.draft) === JSON.stringify(l.draft) && JSON.stringify(e.published) === JSON.stringify(l.published)) continue;
      upd.run(JSON.stringify(e.draft), e.published ? JSON.stringify(e.published) : null, l.id);
    }
  }
  if (changedFeatured) db.setSetting(FEATURED_KEY, JSON.stringify({ ...featured, ...lists }));
  if (result.migrated.length || result.failed.length) {
    db.audit(actor, 'listing.images.migrate', base, {
      migrated: result.migrated.length, already: result.already, failed: result.failed.length, external: result.external.length, objects_written: result.objects_written,
    });
  }
  return result;
}

async function download(doFetch: typeof fetch, base: string, path: string): Promise<{ bytes: Uint8Array; ext: string; contentType: string } | { error: string }> {
  let url: string;
  try { url = new URL(path.replace(/^\/+/, ''), `${base}/`).href; } catch { return { error: 'not a valid path' }; }
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) return { error: `HTTP ${res.status} from ${url}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) return { error: `too big (${Math.round(bytes.length / 1024 / 1024)} MB)` };
    if (!bytes.length) return { error: `empty file at ${url}` };
    const type = sniffImage(bytes);
    if (!type) return { error: `not a PNG, JPEG or WebP image (${url})` };
    return { bytes, ...type };
  } catch (err) {
    return { error: `couldn’t download ${url}: ${(err as Error).message}` };
  }
}
