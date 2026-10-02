// Publishing the built website (site/public, from `npm run site:build`) to its R2 bucket, which Cloudflare serves at
// the site's address. scripts/site-sync.ts runs this from the deploy workflow.
//
// Every file is uploaded on every run (the site is a few hundred files), each with its Content-Type and
// Cache-Control; then objects the build no longer has are deleted. Pages go last, after the stylesheets, scripts and
// images they refer to, so a visitor never gets a new page that points at a file that isn't there yet.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { headersFor, type ObjectHeaders } from './paths.ts';
import type { Storage } from './storage.ts';

// Pages and feeds change when listings do: a minute. Snapshot images (named NAME-<6 hex of their source address>) and
// fonts are never changed in place: a month. Everything else an hour, as nginx served it: the stylesheet and script
// are requested as "?v=<hash>", so a new one is fetched at once whatever this says.
export const PAGE_CACHE = 'public, max-age=60';
export const FIXED_CACHE = 'public, max-age=2592000';
export const ASSET_CACHE = 'public, max-age=3600';
const PAGE_EXT = new Set(['html', 'htm', 'xml', 'json', 'txt']);

export function isPage(key: string): boolean {
  return PAGE_EXT.has(key.slice(key.lastIndexOf('.') + 1).toLowerCase());
}

export function siteHeaders(key: string): ObjectHeaders {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  const contentType = ext === 'pdf' ? 'application/pdf' : headersFor(key.replace(/\.(br|gz)$/i, '.bin')).contentType;
  const cacheControl = isPage(key) ? PAGE_CACHE : /-[0-9a-f]{6}\.[a-z0-9]+$/.test(key) || /\.woff2?$/i.test(key) ? FIXED_CACHE : ASSET_CACHE;
  return { contentType, cacheControl };
}

export interface SyncPlan {
  uploads: string[];     // in upload order: everything else, then pages
  deletes: string[];
}

// What a sync will do, or why it must not run. A build without a home page and a 404 page isn't the site; and a
// build that would remove more than half of what is published needs `allowMassDelete` (a wrong folder, a wrong bucket).
export function planSync(local: string[], remote: string[], opts: { allowMassDelete?: boolean } = {}): SyncPlan {
  const have = new Set(local);
  for (const need of ['index.html', '404.html']) if (!have.has(need)) throw new Error(`the build has no ${need}: not publishing it`);
  const deletes = remote.filter((k) => !have.has(k)).sort();
  if (!opts.allowMassDelete && remote.length >= 20 && deletes.length > remote.length / 2) {
    throw new Error(`this would delete ${deletes.length} of the bucket's ${remote.length} objects; pass --allow-mass-delete if that is right`);
  }
  const sorted = [...local].sort();
  return { uploads: [...sorted.filter((k) => !isPage(k)), ...sorted.filter(isPage)], deletes };
}

// Every file under `dir`, as bucket keys ("game-cards/category/Dev:+Field+Day+Lab/index.html").
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const key = join(e.parentPath, e.name).slice(dir.replace(/\/+$/, '').length + 1).split('\\').join('/');
    if (key.split('/').some((s) => s === '.DS_Store')) continue;
    out.push(key);
  }
  return out.sort();
}

export interface SyncResult {
  uploaded: number;
  bytes: number;
  deleted: string[];
}

export async function syncSite(dir: string, bucket: Pick<Storage, 'list' | 'put' | 'deleteKeys'>, opts: { dryRun?: boolean; allowMassDelete?: boolean; concurrency?: number; log?: (line: string) => void } = {}): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const local = await listFiles(dir);
  const remote = (await bucket.list('')).map((o) => o.key);
  const plan = planSync(local, remote, opts);
  let bytes = 0;
  for (const key of plan.uploads) bytes += (await stat(join(dir, key))).size;
  log(`${plan.uploads.length} files (${(bytes / 1e6).toFixed(1)} MB) to upload, ${plan.deletes.length} to delete, ${remote.length} in the bucket now`);
  if (opts.dryRun) {
    for (const k of plan.deletes) log(`would delete ${k}`);
    return { uploaded: 0, bytes: 0, deleted: [] };
  }
  const upload = async (keys: string[]) => {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const key = keys[next++];
        if (key === undefined) return;
        const body = await readFile(join(dir, key));
        await bucket.put(key, body, body.byteLength, siteHeaders(key));
      }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 12, keys.length) }, worker));
  };
  await upload(plan.uploads.filter((k) => !isPage(k)));
  await upload(plan.uploads.filter(isPage));
  if (plan.deletes.length) await bucket.deleteKeys(plan.deletes);
  for (const k of plan.deletes) log(`deleted ${k}`);
  return { uploaded: plan.uploads.length, bytes, deleted: plan.deletes };
}
