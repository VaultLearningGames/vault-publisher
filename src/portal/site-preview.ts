// Rendering a listing preview as the website would show it: Hugo, run in this process's container against the site
// source (site/, carried in the image), with the published catalog and the previewed game put in its place.
//
// The page is then served from the portal (listing-preview.ts: GET /_preview/TOKEN/ and /v1/listing-previews/TOKEN),
// not from the site, so:
//   * every root-relative address in it (CSS, JS, images, links) is made absolute to the site's origin;
//   * it gets a "Preview — not published" badge before </body>;
//   * it must be sent with PREVIEW_HEADERS. The listing text is the studio's Markdown, rendered as typed (raw HTML
//     included), and the portal's origin holds people's sessions: the Content-Security-Policy sandbox gives the page
//     an origin of its own, so nothing in a preview can act as the person looking at it.
// At most MAX_BUILDS Hugo runs at a time (others wait), each killed after HUGO_TIMEOUT_MS; a rendered page is kept
// per token for CACHE_MS (the portal issues a new token for every Preview click).
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

export const HUGO_TIMEOUT_MS = 25_000;
export const CACHE_MS = 3 * 60_000;
export const MAX_BUILDS = 2;
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TMP_PREFIX = 'vault-preview-';

// No allow-same-origin: the page runs in an opaque origin, apart from the portal's (see the note above).
export const PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation allow-pointer-lock allow-orientation-lock';
export const PREVIEW_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': PREVIEW_CSP,
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export const BADGE = '<div id="vault-preview-badge" role="status" style="position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
  'padding:8px 14px;border-radius:999px;background:#c62828;color:#fff;font:600 14px/1.2 system-ui,-apple-system,' +
  'Segoe UI,Roboto,sans-serif;letter-spacing:.02em;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none">' +
  'Preview — not published</div>';

function message(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;` +
    `max-width:36rem;margin:15vh auto;padding:0 16px;color:#222}h1{font-size:1.4rem}</style></head>` +
    `<body><h1>${title}</h1><p>${text}</p></body></html>`;
}
export const EXPIRED = message('This preview has expired',
  'Listing previews last about half an hour. Go back to the Vault Studio Portal and click Preview again.');
export const NOT_FOUND = message('Not found', 'There is no preview at this address. Open previews from the Vault Studio Portal.');
export const FAILED = message('The preview could not be built',
  'Something went wrong while building this preview. Try again from the Vault Studio Portal; if it keeps happening, tell the Vault team.');
export const UNAVAILABLE = message('Previews aren’t available here',
  'This portal can’t build website previews. Tell the Vault team.');

// A /v1/catalog answer, as far as the preview needs it.
export interface CatalogLike {
  games: { slug: string }[];
  studios?: { slug: string }[];
  [key: string]: unknown;
}
export interface PreviewInput {
  game: { slug: string };
  studios?: { slug: string }[] | null;
}
export interface RenderedPage {
  status: 200 | 500;
  body: string;
}

// Runs Hugo once: `args` after the binary, `env` its whole environment. Rejects when Hugo fails or is killed.
export type HugoRunner = (args: string[], env: Record<string, string>, timeoutMs: number) => Promise<void>;

export function hugoRunner(bin = 'hugo'): HugoRunner {
  return (args, env, timeoutMs) => new Promise((ok, fail) => {
    const p = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (d: Buffer) => { output = (output + d).slice(-4000); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (err) => { clearTimeout(timer); fail(err); });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return ok();
      fail(new Error(`hugo ${signal ? `was stopped (${signal}) after ${timeoutMs} ms` : `exited with ${code}`}: ${output.trim()}`));
    });
  });
}

// Root-relative addresses ("/sq/css/x.css", "/about") made absolute to `origin`, so a page served from the portal
// loads its assets from, and links to, the site. Covers src, href, action, poster, srcset and CSS url(); "//host/…"
// and absolute addresses are left alone. Addresses a script puts together are not seen here: templates must give
// scripts absolute ones (absURL).
export function absolutize(html: string, origin: string): string {
  const o = origin.replace(/\/+$/, '');
  return html
    .replace(/(\s(?:src|href|action|poster)=)(["'])\/(?!\/)/g, `$1$2${o}/`)
    .replace(/(\ssrcset=)(["'])([^"']*)\2/g, (_m, attr: string, q: string, list: string) =>
      attr + q + list.split(',').map((c) => c.replace(/^(\s*)\/(?!\/)/, `$1${o}/`)).join(',') + q)
    .replace(/url\((["']?)\/(?!\/)/g, `url($1${o}/`);
}

export function withBadge(html: string): string {
  const at = html.lastIndexOf('</body>');
  return at >= 0 ? html.slice(0, at) + BADGE + html.slice(at) : html + BADGE;
}

// The catalog with the previewed game replaced (matched on slug) or added, and its studios merged in (the
// preview's win).
export function mergeCatalog(catalog: CatalogLike, input: PreviewInput): CatalogLike {
  const games = [...(Array.isArray(catalog.games) ? catalog.games : [])];
  const i = games.findIndex((g) => g?.slug === input.game.slug);
  if (i >= 0) games[i] = input.game; else games.push(input.game);
  const out: CatalogLike = { ...catalog, games };
  if (Array.isArray(input.studios)) {
    const merged = new Map((Array.isArray(catalog.studios) ? catalog.studios : []).map((s) => [s?.slug, s]));
    for (const s of input.studios) if (s && typeof s.slug === 'string') merged.set(s.slug, s);
    out.studios = [...merged.values()];
  }
  return out;
}

export interface SitePreviewOptions {
  // The site source: hugo.toml, content/, data/, layouts/, themes/ and preview/hugo.preview.toml.
  siteDir: string;
  // The public site (https://vaultlearninggames.org): Hugo's baseURL, and where the page's assets load from.
  siteUrl: string;
  // This portal: the site's forms post to it, as in the site build.
  portalUrl: string;
  // The published catalog right now (what GET /v1/catalog answers).
  catalog: () => CatalogLike;
  hugo?: HugoRunner;
  timeoutMs?: number;
  maxBuilds?: number;
  cacheMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export class SitePreviewer {
  private o: Required<Omit<SitePreviewOptions, 'siteUrl' | 'portalUrl'>> & { siteUrl: string; portalUrl: string };
  private running = 0;
  private waiting: (() => void)[] = [];
  private cache = new Map<string, { at: number; page: Promise<RenderedPage> }>();

  constructor(options: SitePreviewOptions) {
    this.o = {
      hugo: hugoRunner(), timeoutMs: HUGO_TIMEOUT_MS, maxBuilds: MAX_BUILDS, cacheMs: CACHE_MS, now: () => Date.now(),
      log: (line) => console.log(`preview: ${line}`),
      ...options,
      siteDir: resolve(options.siteDir),
      siteUrl: options.siteUrl.replace(/\/+$/, ''),
      portalUrl: options.portalUrl.replace(/\/+$/, ''),
    };
  }

  // Builds in progress and waiting for a turn.
  get load() { return { running: this.running, waiting: this.waiting.length }; }

  // The rendered page for `token`'s preview: built once, then served from memory for cacheMs. A failure isn't kept,
  // so the next request tries again.
  page(token: string, input: PreviewInput): Promise<RenderedPage> {
    const now = this.o.now();
    for (const [k, v] of this.cache) if (now - v.at > this.o.cacheMs) this.cache.delete(k);
    let hit = this.cache.get(token);
    if (!hit) {
      hit = { at: now, page: this.build(token, input) };
      this.cache.set(token, hit);
      const mine = hit;
      const drop = () => { if (this.cache.get(token) === mine) this.cache.delete(token); };
      hit.page.then((r) => { if (r.status !== 200) drop(); }, drop);
    }
    return hit.page;
  }

  private async build(token: string, input: PreviewInput): Promise<RenderedPage> {
    const slug = input?.game?.slug;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      this.o.log(`token ${token.slice(0, 6)}…: unexpected game slug ${JSON.stringify(slug)}`);
      return { status: 500, body: FAILED };
    }
    try {
      return { status: 200, body: await this.limited(() => this.render(input)) };
    } catch (err) {
      this.o.log(`token ${token.slice(0, 6)}…: building ${slug} failed: ${(err as Error).message}`);
      return { status: 500, body: FAILED };
    }
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.o.maxBuilds) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try { return await fn(); } finally { this.running--; this.waiting.shift()?.(); }
  }

  private async render(input: PreviewInput): Promise<string> {
    const t0 = this.o.now();
    const { siteDir, siteUrl, portalUrl } = this.o;
    const dir = await mkdtemp(join(tmpdir(), TMP_PREFIX));
    try {
      const src = join(dir, 'src');
      const out = join(dir, 'out');
      // The templates, content and data; of the static files only the stylesheets and scripts (templates read them
      // for their "?v=" hashes). Images and downloads are served by the site, not by a preview.
      await cp(siteDir, src, { recursive: true, filter: (from) => copied(siteDir, from) });
      await writeFile(join(src, 'data', 'catalog.json'), JSON.stringify(mergeCatalog(this.o.catalog(), input)));

      // Same as the site build (deploy.yml): the site's URL, and the forms posting to this portal. Hugo gets only
      // this environment, none of the portal's own.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: dir,
        HUGO_BASEURL: `${siteUrl}/`,
        HUGOxPARAMSxFORMSxNEWSLETTER: `${portalUrl}/v1/forms/newsletter`,
        HUGOxPARAMSxFORMSxSUBMIT_GAME: `${portalUrl}/v1/forms/submit-game`,
      };
      await this.o.hugo(['--buildDrafts', '--logLevel', 'warn', '--noBuildLock', '--source', src, '--destination', out,
        '--cacheDir', join(dir, 'cache'), '--config', `hugo.toml,${join('preview', 'hugo.preview.toml')}`], env, this.o.timeoutMs);

      // preview-map.json (layouts/home.previewmap.json, only in preview builds): each catalog slug's page address.
      const map = JSON.parse(await readFile(join(out, 'preview-map.json'), 'utf8')) as { games?: { slug: string; path: string }[] };
      const entry = (map.games ?? []).find((g) => g.slug === input.game.slug);
      if (!entry) throw new Error(`no page for ${input.game.slug} in preview-map.json`);
      const file = resolve(out, '.' + decodeURIComponent(entry.path), entry.path.endsWith('.html') ? '' : 'index.html');
      if (!file.startsWith(out + sep)) throw new Error(`page path ${entry.path} is outside the output`);
      const html = await readFile(file, 'utf8');
      this.o.log(`built ${input.game.slug} (${entry.path}) in ${this.o.now() - t0} ms; ${this.running} running, ${this.waiting.length} waiting`);
      return withBadge(absolutize(html, siteUrl));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((err) => this.o.log(`couldn't remove ${dir}: ${err.message}`));
    }
  }
}

// What a preview build copies from the site source: everything but build output and, under static/ folders, anything
// that isn't a stylesheet or script.
function copied(siteDir: string, from: string): boolean {
  const rel = relative(siteDir, from).split(sep);
  if (rel.length === 1 && ['public', 'resources', '.hugo_build.lock', 'scripts'].includes(rel[0])) return false;
  const at = rel.indexOf('static');
  if (at < 0 || at === rel.length - 1) return true;
  const name = basename(from);
  return !name.includes('.') || /\.(css|js)$/i.test(name);   // folders, and .css / .js files
}

// Temp folders left behind by a crash.
export async function clearPreviewTemp(): Promise<void> {
  for (const d of await readdir(tmpdir()).catch(() => [])) {
    if (d.startsWith(TMP_PREFIX)) await rm(join(tmpdir(), d), { recursive: true, force: true }).catch(() => {});
  }
}
