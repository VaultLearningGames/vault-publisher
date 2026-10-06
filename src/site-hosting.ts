// What the website's static hosting (Cloudflare Workers Static Assets: cloudflare/site/wrangler.jsonc) needs next to
// the built pages: `_headers` and `_redirects`, written into the build (site/public) by scripts/site-hosting.ts as
// the last step of `npm run site:build`. Cloudflare reads the two files when the build is published; they are not
// served. Nothing else is configured anywhere: no zone rule, no script.
//
//   _headers    cache lifetimes, X-Robots-Tag, and the CORS header listing previews need
//   _redirects  /s/keys-to-the-vault.pdf, the /game-cards/<card> addresses (301 to the game's page), "/wake/" →
//               "/wake" (301), and the /game-cards filter addresses with "+" or "%2F" in them, which the hosting
//               would otherwise answer with a redirect to its own spelling; and /cdn/<folder>/ (and its index.html)
//               for each game played from the Vault CDN, a 302 to its page with the player open (index.cdnredirects.json)
//   robots.txt  everything may be crawled; production's also names the sitemap
//
// Every page is served at its Squarespace address, which has no trailing slash (html_handling: drop-trailing-slash
// serves wake/index.html at /wake): the address Google has indexed, the canonical link and the site's own links.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Pages and feeds change when listings do: a minute. Snapshot images (named NAME-<6 hex of their source address>), the
// smaller copies Hugo makes of them (NAME_hu_<hex>.webp, partials/sq/srcset.html) or that are made beside them
// (NAME-<6 hex>-<width>w.avif, site/scripts/image-copies.mjs) and fonts are never changed in place: a month. Everything else an hour: the stylesheet and script are requested as
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
  return isPage(key) ? PAGE_CACHE : /(?:-[0-9a-f]{6}(?:-\d+w)?|_hu_[0-9a-f]{8,16})\.[a-z0-9]+$/.test(key) || /\.woff2?$/i.test(key) ? FIXED_CACHE : ASSET_CACHE;
}

// A file or folder path as the hosting itself writes it in an address: every part through encodeURIComponent.
// It serves a file only at this spelling and answers any other spelling of the same name with a redirect to it.
export function canonicalPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

// The same path as Squarespace's addresses, the sitemap, the canonical link and the site's own links spell it
// (Hugo's urlquery of a filter's value: partials/sq/canonical.html): "+" stays "+", ":" is "%3A"; and a "/" inside a
// filter's value ("Subject: Family/Consumer Science", which site/scripts/squarespace-paths.mjs makes two folders) is
// "%2F".
export function linkedPath(key: string): string {
  const filter = key.match(/^(game-cards\/(?:category|tag))\/(.+)$/);
  const enc = (s: string) => encodeURIComponent(s).replace(/%2B/g, '+').replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return filter ? `${filter[1]}/${enc(filter[2])}` : key.split('/').map(enc).join('/');
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
// Squarespace's own pages, which old links and its header still point at: nothing to show for them, so the home page.
export const LEGACY_REDIRECTS = ['/cart / 301', '/search / 301'];

// A Squarespace address that is now another page's: "/game-cards/addition-blocks" → "/addition-blocks".
export interface CardRedirect { from: string; to: string }

// A game played from the Vault CDN: its build's path there ("/fieldday/yardgames/bacteria/") and its page ("/antibiotic-resistance").
// The CDN (a Cloudflare redirect rule on cdn.<site host>) sends a browser that opens a build itself, in the address
// bar, a new tab or another site's iframe, to /cdn<path> here; the build only ever plays inside the Vault player.
export interface CdnRedirect { from: string; to: string }
export const CDN_PREFIX = '/cdn';

export interface Redirects { text: string; cards: number; cdn: number; rewrites: number; slashes: number; skippedSlashes: boolean }

export function redirectsFile(files: string[], cards: CardRedirect[] = [], cdn: CdnRedirect[] = []): Redirects {
  const pages = files.filter((k) => k.endsWith('/index.html')).map((k) => k.slice(0, -'/index.html'.length)).sort();
  // A line is "FROM TO STATUS"; "*" and ":name" in FROM are placeholders. An address that can't be written safely
  // gets no line: the hosting still serves it, after its own redirect (a 307).
  const plain = (p: string) => !/[\s*:]/.test(p) && p.length < 480;
  const served = new Set(pages.map((p) => `/${linkedPath(p)}`));
  // Squarespace's Game Card addresses: permanent redirects to the game's page, so what the card earned passes to it.
  const cardLines: string[] = [];
  for (const { from, to } of [...cards].sort((a, b) => a.from.localeCompare(b.from))) {
    if (!/^\/game-cards\/[A-Za-z0-9._-]+$/.test(from)) throw new Error(`card redirect from "${from}": not a /game-cards/<card> address`);
    if (!served.has(to)) throw new Error(`card redirect ${from} → ${to}: the build has no such page`);
    if (served.has(from)) throw new Error(`card redirect ${from}: the build has a page at that address`);
    cardLines.push(`${from} ${to} 301`);
  }
  // A CDN build opened outside the player: its page with the player open (#play). 302, not 301: what the CDN holds at
  // a path can change. Exact addresses only (the folder and its index.html): one line with a "*" placeholder makes
  // Cloudflare stop matching the percent-encoded filter lines above, which then get its own 307. Another page inside
  // a build is the site's 404.
  const cdnLines: string[] = [];
  const seen = new Map<string, string>();
  for (const { from, to } of [...cdn].sort((a, b) => a.from.localeCompare(b.from))) {
    if (!/^(\/[A-Za-z0-9._~-]+)+\/$/.test(from)) throw new Error(`CDN redirect from "${from}": not a CDN folder like /studio/game/`);
    if (!served.has(to)) throw new Error(`CDN redirect ${from} → ${to}: the build has no such page`);
    const before = seen.get(from);
    if (before && before !== to) throw new Error(`CDN redirect ${from}: two games play it (${before}, ${to})`);
    if (before) continue;
    seen.set(from, to);
    cdnLines.push(`${CDN_PREFIX}${from} ${to}#play 302`, `${CDN_PREFIX}${from}index.html ${to}#play 302`);
  }
  // Served at once (200) at the address everything links to, instead of a redirect to the hosting's spelling.
  const rewrites = pages.filter((p) => linkedPath(p) !== canonicalPath(p) && plain(linkedPath(p)))
    .map((p) => `/${linkedPath(p)} /${canonicalPath(p)} 200`);
  // "/wake/" → "/wake", permanent (the hosting's own answer is a 307); the same for a card's address.
  const slashes = [...pages.filter((p) => plain(linkedPath(p))).map((p) => `/${linkedPath(p)}/ /${linkedPath(p)} 301`),
    ...cardLines.map((l) => l.replace(' ', '/ '))];
  const must = 1 + LEGACY_REDIRECTS.length + cardLines.length + rewrites.length + cdnLines.length;
  if (must > MAX_STATIC_REDIRECTS) throw new Error(`_redirects would need ${must} lines; Cloudflare allows ${MAX_STATIC_REDIRECTS}`);
  const fits = must + slashes.length <= MAX_STATIC_REDIRECTS;
  const out = [
    '# Written by scripts/site-hosting.ts (src/site-hosting.ts) at every build: not edited by hand.',
    PDF_REDIRECT,
    ...LEGACY_REDIRECTS,
    ...cardLines,
    ...rewrites,
    ...cdnLines,
    ...(fits ? slashes : []),
  ];
  return { text: out.join('\n') + '\n', cards: cardLines.length, cdn: seen.size, rewrites: rewrites.length, slashes: fits ? slashes.length : 0, skippedSlashes: !fits };
}

// robots.txt. Squarespace's file kept crawlers out of its own machinery only (/config, /api, ?format=json, ...), none
// of which exists here, and named the sitemap: so everything may be crawled. A build that is not to be indexed
// (staging, a test address) says so with X-Robots-Tag: noindex (_headers), which a crawler only sees if it may fetch
// the page: such a build must not disallow anything either, and names no sitemap.
export function robotsFile(opts: HostingOptions = {}): string {
  const host = opts.indexHost?.trim().toLowerCase();
  return `User-agent: *\nDisallow:\n${host ? `\nSitemap: https://${host}/sitemap.xml\n` : ''}`;
}

// Every file under `dir`, as paths from it ("game-cards/category/Dev:+Field+Day+Lab/index.html"), without the
// hosting's own files.
export const CARD_REDIRECTS = 'card-redirects.json';
export const CDN_REDIRECTS = 'cdn-redirects.json';
export const HOSTING_FILES = ['_headers', '_redirects', '.assetsignore', CARD_REDIRECTS, CDN_REDIRECTS];
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

export interface HostingResult { files: number; headerRules: number; cards: number; cdn: number; rewrites: number; slashes: number; skippedSlashes: boolean }

// Write the hosting files into a build. A build without a home page and a 404 page isn't the site: refuse it, so it
// is never published.
export async function writeHostingFiles(dir: string, opts: HostingOptions = {}): Promise<HostingResult> {
  await writeFile(join(dir, 'robots.txt'), robotsFile(opts));
  const files = await listFiles(dir);
  for (const need of ['index.html', '404.html']) if (!files.includes(need)) throw new Error(`the build has no ${need}: not a site to publish`);
  // Hugo's list of the Game Card addresses (layouts/index.cardredirects.json); a build without it has none.
  const cards = await readFile(join(dir, CARD_REDIRECTS), 'utf8').then((t) => JSON.parse(t) as CardRedirect[] | null, () => null) ?? [];
  // Hugo's list of the CDN games' builds (layouts/index.cdnredirects.json); likewise optional.
  const cdn = await readFile(join(dir, CDN_REDIRECTS), 'utf8').then((t) => JSON.parse(t) as CdnRedirect[] | null, () => null) ?? [];
  const headers = headersFile(files, opts);
  const redirects = redirectsFile(files, cards, cdn);
  await writeFile(join(dir, '_headers'), headers);
  await writeFile(join(dir, '_redirects'), redirects.text);
  // Never published: the list the redirects were made from, and a Mac's folder files.
  await writeFile(join(dir, '.assetsignore'), `${CARD_REDIRECTS}\n${CDN_REDIRECTS}\n.DS_Store\n`);
  return { files: files.length, headerRules: headers.split('\n').filter((l) => /^(\/|https:)/.test(l)).length, cards: redirects.cards, cdn: redirects.cdn, rewrites: redirects.rewrites, slashes: redirects.slashes, skippedSlashes: redirects.skippedSlashes };
}
