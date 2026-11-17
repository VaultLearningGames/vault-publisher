// The shared Vault channel script, shipped next to every CDN game's wrapper files.
//
// Analytics.1 wrote `src/cdn/vault-channel.js`: one plain browser script that resolves a play's acquisition channel
// (vaultResolveChannel), reports it to whichever analytics the page has (vaultReportChannel) and forwards the vault
// params down to an inner frame (vaultForwardParams). A CDN game's wrapper layers load it relatively —
// `<script src="vault-channel.js">` in STUDIO/GAME/index.html and in STUDIO/GAME/iframe.html — so the file has to sit
// at the same directory level those two pages resolve from.
//
// How the publisher assembles that directory (Analytics.2a's finding): it generates no wrapper HTML at all. A build's
// own files (index.html, iframe.html and everything they load) are uploaded to the CDN bucket under STUDIO/GAME/REF/
// and copied into STUDIO/GAME/ when a release is made live (releases.ts makeLive); the `/cdn<path>` lines
// src/site-hosting.ts writes are the *website's* redirects for a build opened outside the player, not how any file of
// a build is served. So "next to the wrapper" means one more object in the bucket, written by the step that assembles
// the directory:
//
//   STUDIO/GAME/vault-channel.js        the live copy players load (makeLive)
//   STUDIO/GAME/REF/vault-channel.js    a preview build (app.ts finishUpload, url-monitor.ts)
//
// Unconditional: no per-game key, option or flag is consulted anywhere, every CDN build gets it, and the bytes written
// are exactly the bytes of src/cdn/vault-channel.js (read as a Buffer, no templating and no minification). Writing it
// again overwrites, so re-publishing is idempotent — and the file goes in before the wrapper HTML that loads it, so a
// player arriving mid-switch never gets a page whose script isn't there yet.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { headersFor, type ObjectHeaders } from './paths.ts';
import type { Storage } from './storage.ts';

/** The file name the wrapper layers load relatively, and the name of the object in each build directory. */
export const CHANNEL_ASSET_NAME = 'vault-channel.js';

/** The one source of the asset: Analytics.1's shared script. Never written to by this module. */
export const CHANNEL_ASSET_SOURCE = new URL('./cdn/vault-channel.js', import.meta.url);

/** Where that source is in this checkout (and in the image: the Dockerfile copies `src/`). */
export const channelAssetPath = (): string => fileURLToPath(CHANNEL_ASSET_SOURCE);

/** Whether a path inside a build directory is the shared asset (it is Vault's, not the build's). */
export const isChannelAsset = (rel: string): boolean => rel === CHANNEL_ASSET_NAME;

/** Where the asset goes for a build directory ("fieldday/jowilder/" → "fieldday/jowilder/vault-channel.js"). */
export const channelAssetKey = (prefix: string): string => `${prefix}${CHANNEL_ASSET_NAME}`;

let cached: Promise<Buffer> | undefined;

/** The asset's bytes, read once per process, exactly as they are on disk. */
export function readChannelAsset(): Promise<Buffer> {
  return (cached ??= readFile(channelAssetPath()));
}

/** Forgets the read bytes (tests). */
export function resetChannelAssetCache(): void {
  cached = undefined;
}

/**
 * How the asset is served: the Content-Type every other .js of a build gets (paths.ts), with the cache policy of the
 * wrapper files it sits beside — `cacheControl` for the live copy of a release (no-cache, like index.html next to it),
 * and a preview build's own default when it isn't given.
 */
export function channelAssetHeaders(cacheControl?: string): ObjectHeaders {
  const headers = headersFor(CHANNEL_ASSET_NAME);
  return cacheControl ? { ...headers, cacheControl } : headers;
}

/**
 * Writes the shared asset into one build directory (`prefix`, ending in "/"), overwriting whatever is there.
 * Answers the key written and its size, for logs and audit lines.
 */
export async function putChannelAsset(
  storage: Pick<Storage, 'put'>,
  prefix: string,
  cacheControl?: string,
  signal?: AbortSignal,
): Promise<{ key: string; bytes: number }> {
  const body = await readChannelAsset();
  const key = channelAssetKey(prefix);
  await storage.put(key, body, body.byteLength, channelAssetHeaders(cacheControl), signal);
  return { key, bytes: body.byteLength };
}
