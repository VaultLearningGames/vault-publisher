// Production releases: copying an approved staging build into the production bucket, and the
// per-game "current release" redirect that makes cdn.vaultlearninggames.org/STUDIO/GAME/ stable.
import { headersFor, type ObjectHeaders } from './paths.ts';
import type { Storage } from './storage.ts';

// Release folders never change once written, so browsers and Cloudflare may keep them for a year.
export const RELEASE_CACHE = 'public, max-age=31536000, immutable';
// The redirect and current.json change on every promotion or rollback, so they're revalidated every time.
export const POINTER_CACHE = 'no-cache';

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

// The page served at STUDIO/GAME/ that sends players to the current release, keeping any
// query string (player codes, teacher parameters) and hash. Relative, so it works on any host.
export function pointerHtml(version: string, title: string): string {
  const v = encodeURIComponent(version);
  const t = title.replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<title>${t}</title>
<script>location.replace("./${v}/" + location.search + location.hash);</script>
<noscript><meta http-equiv="refresh" content="0; url=./${v}/"></noscript>
</head>
<body><p><a href="./${v}/">Continue to ${t}</a></p></body>
</html>
`;
}

// Writes STUDIO/GAME/index.html and STUDIO/GAME/current.json pointing at `version`.
export async function writePointer(production: Storage, gamePrefix: string, version: string, title: string): Promise<void> {
  const html = new TextEncoder().encode(pointerHtml(version, title));
  await production.put(`${gamePrefix}index.html`, html, html.byteLength, {
    contentType: 'text/html; charset=utf-8',
    cacheControl: POINTER_CACHE,
  });
  const json = new TextEncoder().encode(JSON.stringify({ version, promoted_at: new Date().toISOString() }) + '\n');
  await production.put(`${gamePrefix}current.json`, json, json.byteLength, {
    contentType: 'application/json',
    cacheControl: POINTER_CACHE,
  });
}
