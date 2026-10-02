// Check that a served copy of the website answers as its build says it should: every file and every address, the
// redirects, the 404 page, the headers. Only reads (GET and HEAD).
//   node scripts/site-check.ts BASE [--build site/public] [--robots noindex|all] [--compare OTHER] [--verbose]
//   BASE     where the build is served: http://127.0.0.1:8941 (cloudflare/site/check.sh starts the real hosting
//            runtime there), https://static.vaultlearninggames-staging.org, https://vaultlearninggames-staging.org
//   --build  the build that was published there (npm run site:build): bodies are compared with its files
//   --robots what X-Robots-Tag must say at BASE (default noindex; all at production's real address)
//   --compare OTHER  also fetch every address from OTHER and list what differs (status, body, type, lifetime,
//            robots, redirect target). Differences are printed, and only a different status or body fails the run.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheFor, canonicalPath, linkedPath, listFiles, PAGE_CACHE } from '../src/site-hosting.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const base = args[0]?.replace(/\/+$/, '');
if (!base || base.startsWith('--')) { console.error('usage: node scripts/site-check.ts BASE [--build site/public] [--robots noindex|all] [--compare OTHER] [--verbose]'); process.exit(2); }
const build = opt('--build') ?? 'site/public';
const robots = opt('--robots') ?? 'noindex';
const other = opt('--compare')?.replace(/\/+$/, '');
const verbose = args.includes('--verbose');

const TYPES: Record<string, RegExp> = {
  html: /^text\/html/, css: /^text\/css/, js: /^(text|application)\/javascript/, xml: /^(application|text)\/xml/, pdf: /^application\/pdf$/,
  png: /^image\/png$/, jpg: /^image\/jpeg$/, jpeg: /^image\/jpeg$/, woff2: /^font\/woff2$/, ico: /^image\/(x-icon|vnd\.microsoft\.icon)$/,
};

interface Got { status: number; headers: Headers; body: Buffer; location: string | null }
async function get(url: string, init: RequestInit = {}): Promise<Got> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(30000) });
      const body = Buffer.from(await res.arrayBuffer());
      if (res.status >= 500 && attempt < 3) continue;
      const loc = res.headers.get('location');
      return { status: res.status, headers: res.headers, body, location: loc === null ? null : new URL(loc, url).href };
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${(err as Error).message}`);
    }
  }
}
async function each<T>(items: T[], fn: (item: T) => Promise<void>, width = 12): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await fn(items[next++]); }));
}

const failures = new Map<string, string[]>();
const counts = new Map<string, number>();
const fail = (what: string, detail: string) => { failures.set(what, [...(failures.get(what) ?? []), detail]); };
const ok = (what: string) => { counts.set(what, (counts.get(what) ?? 0) + 1); };
const expect = (cond: boolean, what: string, detail: string) => { if (cond) ok(what); else fail(what, detail); };

try { await get(`${base}/`); } catch (err) { console.error(`can't reach ${base}: ${((err as Error).cause as Error | undefined)?.message ?? (err as Error).message}`); process.exit(2); }
const files = await listFiles(build);
const notFound = await readFile(join(build, '404.html'));
// The address of each file: a folder's index.html is the folder, with its slash.
const address = (key: string) => '/' + (key === 'index.html' ? '' : key.endsWith('/index.html') ? linkedPath(key.slice(0, -'index.html'.length)) : linkedPath(key));
const pages = files.filter((k) => k.endsWith('/index.html')).map((k) => k.slice(0, -'/index.html'.length));
const served = files.filter((k) => !k.endsWith('.html') || k === 'index.html' || k.endsWith('/index.html'));

// 1. Every file, at its address: 200 at once, the build's bytes, its type, lifetime, robots and CORS headers.
const bodies = new Map<string, Got>();
await each(served, async (key) => {
  const path = address(key);
  const got = await get(base + path);
  bodies.set(path, got);
  const want = await readFile(join(build, key));
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  expect(got.status === 200, 'file: 200 at once', `${path} → ${got.status}${got.location ? ' ' + got.location : ''}`);
  if (got.status !== 200) return;
  expect(got.body.equals(want), 'file: the build\'s bytes', `${path}: ${got.body.length} bytes, the build has ${want.length}`);
  expect((TYPES[ext] ?? /./).test(got.headers.get('content-type') ?? ''), 'file: content type', `${path}: ${got.headers.get('content-type')}`);
  expect(got.headers.get('cache-control') === cacheFor(key), 'file: cache lifetime', `${path}: ${got.headers.get('cache-control')}, expected ${cacheFor(key)}`);
  expect(got.headers.get('x-robots-tag') === robots, 'file: X-Robots-Tag', `${path}: ${got.headers.get('x-robots-tag')}`);
  expect(got.headers.get('access-control-allow-origin') === '*', 'file: readable from any origin', `${path}: ${got.headers.get('access-control-allow-origin')}`);
});

// 2. The sitemap lists only addresses that were just fetched (so: 200 at once), and all the pages.
const sitemap = (await readFile(join(build, 'sitemap.xml'), 'utf8')).match(/<loc>[^<]+<\/loc>/g)?.map((l) => new URL(l.slice(5, -6).replace(/&amp;/g, '&')).pathname) ?? [];
expect(sitemap.length > 0, 'sitemap: has addresses', 'no <loc> in sitemap.xml');
for (const path of sitemap) expect(bodies.get(path)?.status === 200, 'sitemap: address is 200 at once', `${path} → ${bodies.get(path)?.status ?? 'not a page of the build'}`);

// 3. A page's address without its slash: 301 to the address with it, the query string kept.
await each(pages, async (dir) => {
  const path = '/' + linkedPath(dir);
  const got = await get(`${base}${path}?offset=20`);
  expect(got.status === 301 && got.location === `${base}${path}/?offset=20`, 'page without its slash: 301', `${path}?offset=20 → ${got.status} ${got.location}`);
});

// 4. The /game-cards/<game> stubs still send the visitor to the game's page, and that page is there.
const stubs = pages.filter((dir) => /http-equiv="refresh"/.test(bodies.get(`/${linkedPath(dir)}/`)?.body.toString() ?? ''));
expect(stubs.length > 0, 'stubs: found', 'no page with a meta refresh in the build');
await each(stubs, async (dir) => {
  const html = bodies.get(`/${linkedPath(dir)}/`)!.body.toString();
  const target = html.match(/http-equiv="refresh" content="0; url=([^"]+)"/)?.[1];
  if (!target) return fail('stub: has a target', dir);
  const hop = await get(base + target);
  const end = hop.location ? await get(hop.location) : hop;
  expect(end.status === 200 && (hop.status === 200 || hop.status === 301), 'stub: its target is a page', `/${dir}/ → ${target} → ${hop.status} → ${end.status}`);
});

// 5. Addresses that don't exist: status 404 and the site's own page, at any depth, never indexed.
await each(['/nope', '/nope/', '/a/b/c/', '/a/b/c', '/game-cards/category/Nope/', '/game-cards/nope', '/sq/img/nope.jpg', '/_headers', '/_redirects', '/.assetsignore'], async (path) => {
  const got = await get(base + path);
  expect(got.status === 404 && got.body.equals(notFound), 'missing address: 404 with the site\'s page', `${path} → ${got.status}, ${got.body.length} bytes`);
  expect(/noindex/.test(notFound.toString()) && (got.headers.get('x-robots-tag') === robots), 'missing address: robots', `${path}: ${got.headers.get('x-robots-tag')}`);
});

// 6. Squarespace's address of the PDF.
{
  const got = await get(`${base}/s/keys-to-the-vault.pdf`);
  expect(got.status === 301 && got.location === `${base}/files/keys-to-the-vault.pdf`, 'keys-to-the-vault.pdf: 301', `${got.status} ${got.location}`);
}

// 7. A preview page (sandboxed: its origin is "null") can load the stylesheet, the script and the fonts.
await each(served.filter((k) => /\.(css|js|woff2)$/.test(k)), async (key) => {
  const got = await get(base + address(key), { headers: { origin: 'null' } });
  expect(got.status === 200 && got.headers.get('access-control-allow-origin') === '*', 'CORS from origin null', `${address(key)}: ${got.status} ${got.headers.get('access-control-allow-origin')}`);
});

// 8. HEAD, and another spelling of a filter address (a typed ":" or "%2B"): still reaches the page.
{
  const head = await get(`${base}/`, { method: 'HEAD' });
  expect(head.status === 200 && head.body.length === 0 && head.headers.get('cache-control') === PAGE_CACHE, 'HEAD', `${head.status}, ${head.body.length} bytes`);
  const odd = pages.find((d) => linkedPath(d) !== canonicalPath(d));
  if (odd) {
    for (const spelling of [`/${canonicalPath(odd)}/`, `/${odd.split('/').map((s) => encodeURI(s)).join('/')}/`]) {
      const hop = await get(base + spelling);
      const end = hop.location ? await get(hop.location) : hop;
      expect(end.status === 200 && end.body.equals(bodies.get(`/${linkedPath(odd)}/`)!.body), 'another spelling of a filter address reaches it', `${spelling} → ${hop.status} → ${end.status}`);
    }
  }
}

// 9. Every address the pages themselves link to or load: there at once, or after the one 301 to its slash.
const entity = (s: string) => s.replace(/&#43;/g, '+').replace(/&#39;/g, "'").replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, '&');
const linked = new Set<string>();
for (const key of files.filter((k) => k.endsWith('.html'))) {
  const html = await readFile(join(build, key), 'utf8');
  for (const m of html.matchAll(/\s(?:href|src|action|poster)="(\/(?!\/)[^"]*)"/g)) linked.add(entity(m[1]).split('#')[0]);
}
const dead: string[] = [];
await each([...linked], async (path) => {
  const hop = await get(base + path);
  const end = hop.status === 301 && hop.location ? await get(hop.location) : hop;
  // A link to something the build doesn't have is the site's mistake, not the hosting's: listed, not failed.
  if (end.status === 404 && end.body.equals(notFound)) { dead.push(path); return; }
  expect(end.status === 200, 'linked address: there (at once, or after one 301)', `${path} → ${hop.status}${hop.location ? ' ' + hop.location : ''} → ${end.status}`);
});

// 10. The same addresses from another copy of the site (today's hosting), and what differs.
let differs = false;
if (other) {
  const diffs = new Map<string, string[]>();
  const note = (kind: string, line: string) => { diffs.set(kind, [...(diffs.get(kind) ?? []), line]); };
  const rel = (loc: string | null, b: string) => (loc?.startsWith(b) ? loc.slice(b.length) : loc);
  const paths = [...served.map(address), ...pages.map((d) => `/${linkedPath(d)}`), '/game-cards?offset=20', '/s/keys-to-the-vault.pdf', '/nope/', '/nope', '/sq/img/nope.jpg'];
  await each(paths, async (path) => {
    const [a, b] = await Promise.all([bodies.get(path) ?? get(base + path), get(other + path, { headers: { 'cache-control': 'no-cache' } })]);
    if (a.status !== b.status) { note('status', `${path}: ${a.status} here, ${b.status} there`); if (a.status === 200 || b.status === 200) differs = true; }
    if (a.status === 200 && b.status === 200 && !a.body.equals(b.body)) { note('body', `${path}: ${a.body.length} bytes here, ${b.body.length} there`); differs = true; }
    if (a.status !== 200 && b.status === a.status && a.status !== 404 && rel(a.location, base) !== rel(b.location, other)) note('redirect target', `${path}: ${rel(a.location, base)} here, ${rel(b.location, other)} there`);
    if (a.status !== 200 || b.status !== 200) return;
    for (const h of ['content-type', 'cache-control', 'x-robots-tag', 'access-control-allow-origin']) {
      if ((a.headers.get(h) ?? '(none)') !== (b.headers.get(h) ?? '(none)')) note(h, `${path}: ${a.headers.get(h) ?? '(none)'} here, ${b.headers.get(h) ?? '(none)'} there`);
    }
  }, 8);
  console.log(`\nCompared ${paths.length} addresses with ${other}:`);
  if (!diffs.size) console.log('  no difference');
  for (const [kind, lines] of diffs) {
    console.log(`  ${kind}: ${lines.length} differ`);
    for (const l of lines.slice(0, verbose ? lines.length : 3)) console.log(`    ${l}`);
    if (!verbose && lines.length > 3) console.log(`    … and ${lines.length - 3} more (--verbose lists them)`);
  }
}

console.log(`\n${base} against ${build} (${files.length} files, ${pages.length + 1} pages, ${sitemap.length} sitemap addresses, ${stubs.length} stubs, ${linked.size} linked addresses):`);
for (const [what, n] of counts) console.log(`  ok   ${String(n).padStart(4)}  ${what}`);
for (const path of dead.sort()) console.log(`  note        a page links to ${path}, which the build doesn't have (404)`);
let failed = 0;
for (const [what, lines] of failures) {
  failed += lines.length;
  for (const l of lines.slice(0, verbose ? lines.length : 5)) console.log(`  FAIL ${what}: ${l}`);
  if (!verbose && lines.length > 5) console.log(`  … and ${lines.length - 5} more like it`);
}
console.log(failed ? `\n${failed} checks failed` : '\nall checks passed');
process.exit(failed || differs ? 1 : 0);
