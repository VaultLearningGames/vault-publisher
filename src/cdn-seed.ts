// Staging only: copies production's released games from production's CDN bucket into staging's, after a re-seed
// (.github/workflows/reseed-staging.yml, scripts/reseed-cdn.ts; docs/staging-reseed.md).
//
// A re-seed gives staging production's database, so staging's catalog says each game has its production release, and
// the site plays it from staging's CDN (CDN_PUBLIC_URL/STUDIO/GAME/). Those files were only ever written to
// production's bucket, so without this every CDN-hosted game 404s in staging's player.
//
// One way and additive: production's bucket is only listed and read (a read-only R2 token), nothing on staging is
// ever deleted (staging keeps its own test releases), and a file already on staging with the same size is skipped, so
// a run cut short carries on where it stopped and a second run copies nothing. Per game it copies what players and
// the portal need: the live copy in STUDIO/GAME/, current.json, _vault-assets/ (listing images and their smaller
// copies) and the current release's folder, _releases/VERSION/ (named by production's current.json). Older releases
// are left out: they are only the source for switching back, and copying every one would copy every build ever made.
import { Readable } from 'node:stream';
import { headersFor, type ObjectHeaders } from './paths.ts';
import { IMAGE_CACHE } from './assets.ts';
import { ASSETS_DIR, LIVE_CACHE, pool, RELEASE_CACHE, RELEASES_DIR, storageCall, type Budget } from './releases.ts';
import type { Storage, StoredObject } from './storage.ts';

// Production's bucket is never written to: only these two calls are ever made on it.
export type SeedSource = Pick<Storage, 'list' | 'get'>;
export type SeedTarget = Pick<Storage, 'list' | 'put'>;

// What to tell the operator when production's bucket can't be read with the token staging was given.
export const SEED_ACCESS_HELP =
  'Staging needs read-only access to production\'s CDN bucket: an R2 API token with "Object Read only" permission on ' +
  'that bucket alone (never Read & Write), stored as the Secret Manager secrets ' +
  'vault-publisher-staging-r2-seed-cdn-access-key-id and vault-publisher-staging-r2-seed-cdn-secret-access-key, with ' +
  'roles/secretmanager.secretAccessor on both for the deploy service account. See docs/staging-reseed.md.';

export class SeedAccessError extends Error {}

// Why these buckets can't be seeded, or null: only ever from production's bucket into staging's.
export function seedBucketProblem(source: string, target: string): string | null {
  if (!source) return `the production CDN bucket to copy from (SEED_CDN_BUCKET) isn't set. ${SEED_ACCESS_HELP}`;
  if (!target) return 'staging\'s CDN bucket (CDN_BUCKET) isn\'t set';
  if (!target.includes('staging')) return `CDN_BUCKET '${target}' isn't staging's: only staging's bucket is ever written to`;
  if (source.includes('staging') || source === target) return `SEED_CDN_BUCKET '${source}' isn't production's`;
  return null;
}

const GAME_PREFIX = /^([^/]+\/[^/]+\/)/;
const CURRENT_JSON = /^[^/]+\/[^/]+\/current\.json$/;

// The game folder (STUDIO/GAME/) a key belongs to, or null for keys outside any game.
export function gamePrefixOf(key: string): string | null {
  return key.match(GAME_PREFIX)?.[1] ?? null;
}

// Which of production's objects staging should have: everything but releases other than each game's current one
// (`current`: game prefix → version, from production's current.json files).
export function wantedObjects(source: StoredObject[], current: Map<string, string>): StoredObject[] {
  return source.filter((o) => {
    const prefix = gamePrefixOf(o.key);
    if (!prefix) return true;
    const rel = o.key.slice(prefix.length);
    if (!rel.startsWith(RELEASES_DIR)) return true;
    const version = current.get(prefix);
    return version !== undefined && rel.startsWith(`${RELEASES_DIR}${version}/`);
  });
}

// What is still to copy: wanted objects staging doesn't have at the same size. Staging's other objects stay.
export function missingObjects(wanted: StoredObject[], target: StoredObject[]): StoredObject[] {
  const there = new Map(target.map((o) => [o.key, o.size]));
  return wanted.filter((o) => there.get(o.key) !== o.size);
}

// The headers a file is served with on the CDN, as releases.ts and assets.ts write them.
export function seedHeaders(key: string): ObjectHeaders {
  const prefix = gamePrefixOf(key);
  const rel = prefix ? key.slice(prefix.length) : key;
  if (rel === 'current.json') return { contentType: 'application/json', cacheControl: LIVE_CACHE };
  if (rel.startsWith(RELEASES_DIR)) return { ...headersFor(rel), cacheControl: RELEASE_CACHE };
  if (rel.startsWith(ASSETS_DIR)) return { ...headersFor(rel), cacheControl: IMAGE_CACHE };
  const headers = headersFor(rel);
  return prefix ? { ...headers, cacheControl: LIVE_CACHE } : headers;
}

async function readText(body: Readable | Uint8Array): Promise<string> {
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

function isAccessDenied(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  return status === 401 || status === 403 || /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|Unauthorized|Forbidden/i.test(`${e?.name ?? ''} ${e?.Code ?? ''}`);
}

export interface SeedResult {
  games: number;            // games with a current release on production
  wanted: number;           // objects staging should have
  copied: number;
  bytes: number;
  remaining: number;        // not copied before the deadline; run again to carry on
  failed: { key: string; error: string }[];
}

// Copies what staging is missing (see the top of this file). Production's bucket that can't be read throws
// SeedAccessError (SEED_ACCESS_HELP); one file that fails to copy is reported in `failed` and the rest carry on.
// With dryRun nothing is copied: `copied` and `bytes` are what would be.
export async function seedCdn(opts: Budget & { source: SeedSource; target: SeedTarget; dryRun?: boolean; log?: (line: string) => void }): Promise<SeedResult> {
  const { source, target } = opts;
  const log = opts.log ?? (() => {});
  let sourceObjects: StoredObject[];
  try {
    sourceObjects = await storageCall(opts, 'list production\'s CDN bucket', (signal) => source.list('', signal));
  } catch (err) {
    if (isAccessDenied(err)) throw new SeedAccessError(`can't read production's CDN bucket (${(err as Error).message}). ${SEED_ACCESS_HELP}`);
    throw err;
  }
  const current = new Map<string, string>();
  for (const o of sourceObjects.filter((x) => CURRENT_JSON.test(x.key))) {
    try {
      const text = await storageCall(opts, `read ${o.key}`, async (signal) => readText(await source.get(o.key, signal)));
      const version = (JSON.parse(text) as { version?: unknown }).version;
      if (typeof version === 'string' && version) current.set(gamePrefixOf(o.key)!, version);
    } catch (err) {
      if (isAccessDenied(err)) throw new SeedAccessError(`can't read ${o.key} in production's CDN bucket. ${SEED_ACCESS_HELP}`);
      log(`warning: couldn't read ${o.key} (${(err as Error).message}); that game's releases are skipped`);
    }
  }
  const wanted = wantedObjects(sourceObjects, current);
  const targetObjects = await storageCall(opts, 'list staging\'s CDN bucket', (signal) => target.list('', signal));
  const todo = missingObjects(wanted, targetObjects);
  log(`${current.size} game(s) released on production; ${wanted.length} file(s) wanted, ${todo.length} missing on staging`);

  const result: SeedResult = { games: current.size, wanted: wanted.length, copied: 0, bytes: 0, remaining: 0, failed: [] };
  if (opts.dryRun) return { ...result, copied: todo.length, bytes: todo.reduce((n, o) => n + o.size, 0) };
  // A failed file is recorded rather than thrown, so pool() keeps going with the others.
  const left = await pool(todo, opts, async (o) => {
    try {
      await storageCall(opts, `copy ${o.key}`, async (signal) => target.put(o.key, await source.get(o.key, signal), o.size, seedHeaders(o.key), signal), o.size);
      result.copied++;
      result.bytes += o.size;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      result.failed.push({ key: o.key, error: (err as Error).message });
    }
  });
  result.remaining = left.length;
  return result;
}
