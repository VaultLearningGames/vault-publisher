// Content-Type / Content-Encoding / Cache-Control for the copied static files. Pure: no fs, no network.
//
// The type table matches src/paths.ts, so a copied build is served the same as one the CI publishes.
// The cache policy is the migration's: the entry page gets a short max-age=300 so a replaced index is
// picked up quickly; everything else is content-addressed in practice and gets a day.
import type { ObjectHeaders } from '../../../src/paths.ts';

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

// The extension the Content-Type comes from: Unity's precompressed "x.wasm.br" / "x.js.gz" are typed
// as their underlying file.
function baseName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name.endsWith('.br')) return name.slice(0, -3);
  if (name.endsWith('.gz')) return name.slice(0, -3);
  return name;
}

export function extensionOf(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
}

// "x.wasm.br" → "br", "x.js.gz" → "gzip", anything else → undefined.
export function contentEncodingFor(path: string): 'br' | 'gzip' | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name.endsWith('.br')) return 'br';
  if (name.endsWith('.gz')) return 'gzip';
  return undefined;
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? 'application/octet-stream';
}

export function cacheControlFor(path: string): string {
  const ext = extensionOf(path);
  return ext === 'html' || ext === 'htm' ? 'public, max-age=300' : 'public, max-age=86400';
}

export function headersForPath(path: string): ObjectHeaders {
  const contentEncoding = contentEncodingFor(path);
  return contentEncoding
    ? { contentType: contentTypeFor(path), contentEncoding, cacheControl: cacheControlFor(path) }
    : { contentType: contentTypeFor(path), cacheControl: cacheControlFor(path) };
}
