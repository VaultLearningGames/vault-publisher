// What the website's static hosting (Cloudflare Workers Static Assets: cloudflare/site/wrangler.jsonc) needs next to
// the built pages: `_headers` and `_redirects`, written into the build (site/public) by scripts/site-hosting.ts as
// the last step of `npm run site:build`. Cloudflare reads the two files when the build is published; they are not
// served. Nothing else is configured anywhere: no zone rule, no script.
//
//   _headers    cache lifetimes, X-Robots-Tag, and the CORS header listing previews need
//   _redirects  /s/keys-to-the-vault.pdf, the "/wake" → "/wake/" redirects (301), and the /game-cards filter
//               addresses with a "+" in them, which the hosting would otherwise answer with a redirect to "%2B"
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Pages and feeds change when listings do: a minute. Snapshot images (named NAME-<6 hex of their source address>) and
// fonts are never changed in place: a month. Everything else an hour: the stylesheet and script are requested as
// "?v=<hash>", so a new one is fetched at once whatever this says.
export const PAGE_CACHE = 'public, max-age=60';
export const FIXED_CACHE = 'public, max-age=2592000';
export const ASSET_CACHE = 'public, max-age=3600';
const PAGE_EXT = new Set(['html', 'htm', 'xml', 'json', 'txt']);

// Cloudflare's limits (Workers Static Assets, 2026-10): 100 rules in _headers; 2,000 redirects without a
// placeholder and 1,000 characters a line in _redirects.
export const MAX_HEADER_RULES = 100;
export const MAX_STATIC_REDIRECTS = 2000;

export function isPage(key: string): boolean {
  return PAGE_EXT.has(key.slice(key.lastIndexOf('.') + 1).toLowerCase());
}

export function cacheFor(key: string): string {
  return isPage(key) ? PAGE_CACHE : /-[0-9a-f]{6}\.[a-z0-9]+$/.test(key) || /\.woff2?$/i.test(key) ? FIXED_CACHE : ASSET_CACHE;
}

// A file or folder path as the hosting itself writes it in an address: every part through encodeURIComponent.
// It serves a file only at this spelling and answers any other spelling of the same name with a redirect to it.
export function canonicalPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

// The same path as the site's own links, the sitemap and Squarespace's addresses spell it: "+" stays "+"
// (site/scripts/squarespace-paths.mjs), ":" is "%3A".
export function linkedPath(key: string): string {
  return canonicalPath(key).replace(/%2B/g, '+');
}

interface Dir { files: string[]; dirs: Map<string, Dir> }

// The fewest rules that give every file its lifetime: a rule for a folder when most of what is under it differs from
// what the folder above gives, then the exceptions. "/*" is always the page lifetime, so an address that doesn't
// exist (the 404 page) is cached as a page.
function cacheRules(files: string[]): [string, string][] {
  const root: Dir = { files: [], dirs: new Map() };
  for (const key of files) {
    const parts = key.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) d.dirs.set(p, (next = { files: [], dirs: new Map() }));
      d = next;
    }
    d.files.push(key);
  }
  const count = (d: Dir, into = new Map<string, number>()): Map<string, number> => {
    for (const f of d.files) into.set(cacheFor(f), (into.get(cacheFor(f)) ?? 0) + 1);
    for (const sub of d.dirs.values()) count(sub, into);
    return into;
  };
  const rules: [string, string][] = [];
  const walk = (d: Dir, path: string, inherited: string): void => {
    let here = inherited;
    if (path) {
      const most = [...count(d)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      if (most !== inherited) rules.push([`/${canonicalPath(path)}/*`, (here = most)]);
    }
    for (const f of [...d.files].sort()) if (cacheFor(f) !== here) rules.push([`/${canonicalPath(f)}`, cacheFor(f)]);
    for (const name of [...d.dirs.keys()].sort()) walk(d.dirs.get(name)!, path ? `${path}/${name}` : name, here);
  };
  walk(root, '', PAGE_CACHE);
  return rules;
}

export interface HostingOptions {
  // The one hostname search engines may index (production: "vaultlearninggames.org"). Every other hostname the
  // build is served at (staging, a test address) says noindex. Not set: noindex everywhere.
  indexHost?: string;
}

export function headersFile(files: string[], opts: HostingOptions = {}): string {
  const host = opts.indexHost?.trim().toLowerCase();
  if (host && !/^[a-z0-9.-]+$/.test(host)) throw new Error(`the host to index, "${host}", isn't a hostname`);
  const rules = cacheRules(files);
  const count = 1 + (host ? 1 : 0) + rules.length;
  if (count > MAX_HEADER_RULES) throw new Error(`_headers would need ${count} rules; Cloudflare allows ${MAX_HEADER_RULES}`);
  const out = [
    '# Written by scripts/site-hosting.ts (src/site-hosting.ts) at every build: not edited by hand.',
    '# Preview pages on the portal load the stylesheet, script and fonts from here, from a sandboxed page (origin',
    '# "null"): any origin may read.',
    '/*',
    `  X-Robots-Tag: noindex`,
    '  Access-Control-Allow-Origin: *',
    `  Cache-Control: ${PAGE_CACHE}`,
  ];
  if (host) out.push(`https://${host}/*`, '  ! X-Robots-Tag', '  X-Robots-Tag: all');
  // A later rule adds to an earlier one's header unless it removes it first ("!").
  for (const [path, cache] of rules) out.push(path, '  ! Cache-Control', `  Cache-Control: ${cache}`);
  return out.join('\n') + '\n';
}

export const PDF_REDIRECT = '/s/keys-to-the-vault.pdf /files/keys-to-the-vault.pdf 301';

export interface Redirects { text: string; rewrites: number; slashes: number; skippedSlashes: boolean }

export function redirectsFile(files: string[]): Redirects {
  const pages = files.filter((k) => k.endsWith('/index.html')).map((k) => k.slice(0, -'/index.html'.length)).sort();
  // A line is "FROM TO STATUS"; "*" and ":name" in FROM are placeholders. An address that can't be written safely
  // gets no line: the hosting still serves it, after its own redirect.
  const plain = (p: string) => !/[\s*:]/.test(p) && p.length < 480;
  // Served at once (200) at the address the site links to, instead of a redirect to the "%2B" spelling.
  const rewrites = pages.filter((p) => linkedPath(p) !== canonicalPath(p) && plain(linkedPath(p)))
    .map((p) => `/${linkedPath(p)}/ /${canonicalPath(p)}/ 200`);
  // "/wake" → "/wake/", permanent, as nginx and the R2 rule answered (the hosting's own answer is a 307). The site's
  // links and canonical addresses have no trailing slash, so this is the redirect most visits go through.
  const slashes = pages.filter((p) => plain(linkedPath(p))).map((p) => `/${linkedPath(p)} /${linkedPath(p)}/ 301`);
  const fits = 1 + rewrites.length + slashes.length <= MAX_STATIC_REDIRECTS;
  if (1 + rewrites.length > MAX_STATIC_REDIRECTS) throw new Error(`_redirects would need ${1 + rewrites.length} lines; Cloudflare allows ${MAX_STATIC_REDIRECTS}`);
  const out = [
    '# Written by scripts/site-hosting.ts (src/site-hosting.ts) at every build: not edited by hand.',
    PDF_REDIRECT,
    ...rewrites,
    ...(fits ? slashes : []),
  ];
  return { text: out.join('\n') + '\n', rewrites: rewrites.length, slashes: fits ? slashes.length : 0, skippedSlashes: !fits };
}

// Every file under `dir`, as paths from it ("game-cards/category/Dev:+Field+Day+Lab/index.html"), without the
// hosting's own files.
export const HOSTING_FILES = ['_headers', '_redirects', '.assetsignore'];
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const base = dir.replace(/\/+$/, '');
  for (const e of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name === '.DS_Store') continue;
    const key = join(e.parentPath, e.name).slice(base.length + 1).split('\\').join('/');
    if (HOSTING_FILES.includes(key)) continue;
    out.push(key);
  }
  return out.sort();
}

export interface HostingResult { files: number; headerRules: number; rewrites: number; slashes: number; skippedSlashes: boolean }

// Write the hosting files into a build. A build without a home page and a 404 page isn't the site: refuse it, so it
// is never published.
export async function writeHostingFiles(dir: string, opts: HostingOptions = {}): Promise<HostingResult> {
  const files = await listFiles(dir);
  for (const need of ['index.html', '404.html']) if (!files.includes(need)) throw new Error(`the build has no ${need}: not a site to publish`);
  const headers = headersFile(files, opts);
  const redirects = redirectsFile(files);
  await writeFile(join(dir, '_headers'), headers);
  await writeFile(join(dir, '_redirects'), redirects.text);
  // Never published, whatever machine the build was made on.
  await writeFile(join(dir, '.assetsignore'), '.DS_Store\n');
  return { files: files.length, headerRules: headers.split('\n').filter((l) => /^(\/|https:)/.test(l)).length, rewrites: redirects.rewrites, slashes: redirects.slashes, skippedSlashes: redirects.skippedSlashes };
}
