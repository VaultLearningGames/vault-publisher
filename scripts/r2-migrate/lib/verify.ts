// The verification diff: what is on disk, and what the public R2 URL answers for it. Pure: no fs, no network.
//
// Verification is done over the public base URL (R2_PUBLIC_BASE_URL) with HEAD, not the S3 API, because that is
// exactly what the browser fetches: same CDN, same headers. A copy is verified when every local file answers
// 200 with the local size, the expected Content-Type and (for .br/.gz) the expected Content-Encoding.

export interface FileSpec {
  key: string;
  size: number;
  contentType: string;
  contentEncoding?: string;
  cacheControl?: string;
}

// What a HEAD response said; status null means no response at all (network failure).
export interface RemoteHead {
  status: number | null;
  length?: number | null;
  contentType?: string | null;
  contentEncoding?: string | null;
}

export interface FileDiff {
  key: string;
  issues: string[];
}

export interface VerifyReport {
  ok: number;
  total: number;
  diffs: FileDiff[];
}

const mediaType = (v: string | null | undefined): string => (v ?? '').split(';')[0].trim().toLowerCase();

// The problems with one file; empty when it is served correctly.
export function diffFile(spec: FileSpec, head: RemoteHead | undefined): string[] {
  if (head === undefined) return ['no HEAD response recorded'];
  if (head.status === null) return ['no response (network error)'];
  if (head.status !== 200) return [`HTTP ${head.status}`];
  const issues: string[] = [];
  if (head.length !== spec.size) issues.push(`size ${head.length ?? 'missing'} != local ${spec.size}`);
  const got = mediaType(head.contentType), want = mediaType(spec.contentType);
  if (got !== want) issues.push(`content-type ${got || 'missing'} != ${want}`);
  if (spec.contentEncoding && mediaType(head.contentEncoding) !== spec.contentEncoding.toLowerCase()) {
    issues.push(`content-encoding ${mediaType(head.contentEncoding) || 'missing'} != ${spec.contentEncoding}`);
  }
  return issues;
}

// The whole game: every local file against its HEAD. `heads` is keyed by R2 key.
export function diffAll(specs: FileSpec[], heads: Map<string, RemoteHead>): VerifyReport {
  const diffs: FileDiff[] = [];
  let ok = 0;
  for (const spec of specs) {
    const issues = diffFile(spec, heads.get(spec.key));
    if (issues.length) diffs.push({ key: spec.key, issues });
    else ok += 1;
  }
  return { ok, total: specs.length, diffs };
}
