// Validation for everything that becomes part of an R2 object key, plus the
// Content-Type / Content-Encoding / Cache-Control each uploaded file is served with.

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}

export type RefType = 'branch' | 'tag';

// "feature/new-map" -> "feature_new-map" (same convention as the old DoIT /play/GAME/ci/BRANCH paths).
// Anything outside [A-Za-z0-9._-] becomes "-".
export function sanitizeRefName(raw: string): string | null {
  const name = raw.replaceAll('/', '_').replace(/[^A-Za-z0-9._-]/g, '-');
  if (name.length === 0 || name.length > 100 || name === '.' || name === '..') return null;
  return name;
}

// Only pushes to branches and tags publish previews; pull_request refs (refs/pull/N/merge) are rejected.
export function parseGitRef(ref: string): { type: RefType; name: string } | null {
  let type: RefType;
  let raw: string;
  if (ref.startsWith('refs/heads/')) {
    type = 'branch';
    raw = ref.slice('refs/heads/'.length);
  } else if (ref.startsWith('refs/tags/')) {
    type = 'tag';
    raw = ref.slice('refs/tags/'.length);
  } else {
    return null;
  }
  const name = sanitizeRefName(raw);
  return name ? { type, name } : null;
}

export const MAX_FILES = 10_000;
export const MAX_FILE_BYTES = 5 * 1024 ** 3; // R2 single-PUT limit
export const MAX_TOTAL_BYTES = 4 * 1024 ** 3;

// A relative POSIX path inside the build folder, e.g. "Build/WebGL.wasm.br".
export function isSafeFilePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  wasm: 'application/wasm',
  // Unity WebGL payloads
  data: 'application/octet-stream',
  unityweb: 'application/octet-stream',
  mem: 'application/octet-stream',
  symbols: 'application/octet-stream',
  bundle: 'application/octet-stream',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

export interface ObjectHeaders {
  contentType: string;
  contentEncoding?: 'gzip' | 'br';
  cacheControl: string;
}

// Unity 2020+ emits precompressed files like "Build/x.wasm.br"; those are served with
// Content-Encoding so the browser decompresses them. Unity 2019's ".unityweb" files are left
// alone because its loader decompresses them itself.
export function headersFor(path: string): ObjectHeaders {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  let base = name;
  let contentEncoding: ObjectHeaders['contentEncoding'];
  if (name.endsWith('.br')) {
    contentEncoding = 'br';
    base = name.slice(0, -3);
  } else if (name.endsWith('.gz')) {
    contentEncoding = 'gzip';
    base = name.slice(0, -3);
  }
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1);
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  // Previews change on every push; keep them fresh. Cloudflare cache rules cap the edge TTL too.
  const cacheControl = ext === 'html' || ext === 'htm' ? 'no-cache' : 'public, max-age=60';
  return contentEncoding ? { contentType, contentEncoding, cacheControl } : { contentType, cacheControl };
}
