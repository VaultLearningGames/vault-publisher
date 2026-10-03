// Local portal preview with example data, in-memory storage and a fake GitHub sign-in.
//   node scripts/dev-portal.ts        → http://localhost:4181  (sign in as any username; "boss" is a Vault admin)
import { serve } from '@hono/node-server';
import type { Readable } from 'node:stream';
import { createApp } from '../src/app.ts';
import { Db, type Upload } from '../src/db.ts';
import { saveMonitor } from '../src/url-monitor.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { browseKeys, type Storage } from '../src/storage.ts';
import { existsSync, readFileSync } from 'node:fs';
import { importListings } from '../src/listings-import.ts';
import { saveFeatured } from '../src/featured.ts';
import { parsePreviewSites } from '../src/config.ts';
import { buildCatalog } from '../src/catalog.ts';
import { SitePreviewer } from '../src/portal/site-preview.ts';
import { countLevels, parseRun, type GameCheck } from '../src/game-checks.ts';
import { parseRun as parseSiteRun } from '../src/site-checks.ts';
import { Analytics } from '../src/analytics/ga.ts';
import { parseGaPropertyId } from '../src/config.ts';
import { fakeGa } from './fake-ga.ts';

class MemoryStorage implements Storage {
  objects = new Map<string, Uint8Array>();
  // Uploads from the browser (a .zip on the Upload builds page) go to /dev-r2/KEY on this server, below.
  async presignPut(key: string) { return `/dev-r2/${key.split('/').map(encodeURIComponent).join('/')}`; }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.byteLength })); }
  async deleteKeys(keys: string[]) { for (const k of keys) this.objects.delete(k); }
  async browse(prefix: string) { return browseKeys([...this.objects].map(([k, v]) => [k, v.byteLength] as [string, number]), prefix); }
  async get(key: string) { return this.objects.get(key)!; }
  async copy(src: string, dst: string) { this.objects.set(dst, this.objects.get(src)!); }
  async put(key: string, body: Readable | Uint8Array, _size: number, _h: ObjectHeaders) {
    await new Promise((r) => setTimeout(r, 400)); // feel like a real copy, so busy states show
    this.objects.set(key, body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await (body as Readable).toArray())));
  }
}

const PORT = Number(process.env.PORT ?? 4181);
// The site whose pages the image migration reads and whose assets listing previews load.
const SITE_URL = (process.env.SITE_URL ?? 'https://vaultlearninggames-staging.org').replace(/\/+$/, '');
const db = new Db(':memory:');
db.syncStudios([
  { slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
  { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' },
]);
db.syncStudioRepositories([{ slug: 'ucalgary', repositories: [{ name: 'VaultLearningGames/hosted-transformation-quest', id: '679805874' }] }]);
db.seedStudioWebsites({ fieldday: 'https://fielddaylab.wisc.edu/' });
const staging = new MemoryStorage(), production = new MemoryStorage();
const fd = db.studioBySlug('fieldday')!;

// Example games, staging builds and releases.
const seed: [string, string, [string, 'branch' | 'tag', string, number, number][]][] = [
  ['wake', 'fielddaylab/wake', [['production', 'branch', '4f7275b', 214, 145_000_000], ['develop', 'branch', '7d02b11', 214, 146_000_000], ['m3.2', 'tag', '5be8d3f', 212, 139_000_000]]],
  ['bloom', 'fielddaylab/bloom', [['production', 'branch', '44b91d0', 180, 92_000_000]]],
  ['spacefab', 'fielddaylab/spacefab', [['develop', 'branch', 'f008889', 402, 211_000_000]]],
  ['project-hercules', 'fielddaylab/project-hercules', []],
];
for (const [slug, repo, builds] of seed) {
  const g = db.createGame(fd.id, slug, repo, String(slug.length * 1000));
  for (const [ref, type, sha, files, bytes] of builds) {
    const id = `${slug}-${ref}`;
    db.createUpload({ id, game_id: g.id, ref_name: ref, ref_type: type, commit_sha: sha + '0'.repeat(33), actor: 'fielddaylab-ci', manifest: [], expires_at: '2999-01-01' });
    db.upsertBuild(db.upload(id)!, files, bytes);
    for (const f of ['index.html', 'Build/game.loader.js', 'Build/game.framework.js.br', 'Build/game.wasm.br', 'Build/game.data.br', 'TemplateData/style.css', 'TemplateData/favicon.ico'])
      staging.objects.set(`fieldday/${slug}/${ref}/${f}`, new TextEncoder().encode(f === 'index.html' ? `<h1>${slug} ${ref}</h1>` : 'x'.repeat(f.includes('data') ? 4096 : 512)));
  }
}
const wake = db.game(fd.id, 'wake')!;
db.createRelease({ game_id: wake.id, version: 'm3.0', source_ref: 'production', commit_sha: '71c2a90' + '0'.repeat(33), file_count: 208, total_bytes: 138_000_000, approved_by: 'user:boss' });
db.createRelease({ game_id: wake.id, version: 'm3.1', source_ref: 'production', commit_sha: '9ac0e21' + '0'.repeat(33), file_count: 210, total_bytes: 141_000_000, approved_by: 'user:boss' });
db.setWithdrawn(db.release(wake.id, 'm3.0')!.id, 'user:boss', 'Sends student names to the log server; fixed in m3.1');
for (const v of ['m3.0', 'm3.1']) production.objects.set(`fieldday/wake/_releases/${v}/index.html`, new TextEncoder().encode(`<h1>wake ${v}</h1>`));
production.objects.set('fieldday/wake/index.html', new TextEncoder().encode('<h1>wake m3.1</h1>'));
db.setCurrentRelease(wake.id, db.release(wake.id, 'm3.1')!.id);
db.createReleaseRequest({ game_id: wake.id, ref: 'm3.2', version: 'm3.2', notes: 'New kelp job; fixes the iPad save bug.', requested_by: 'user:mia' });
db.setMembership(fd.id, 'mia', 'maintainer', 'user:boss');
db.setMembership(fd.id, 'vera', 'viewer', 'user:boss');
db.setMembership(fd.id, 'ada', 'admin', 'user:boss');
db.setMembership(fd.id, 'newhire', 'viewer', 'user:ada'); // invited: hasn't signed in yet

// A game copied from the studio's own site by a URL monitor (Upload builds, path 4).
{
  const fm = db.createGame(fd.id, 'forevermine', '', 'vault:fieldday/forevermine');
  const m = saveMonitor(db, { game_id: fm.id, url: 'https://fielddaylab.wisc.edu/play/forevermine/game/', files_from: 'list', list_url: 'https://fielddaylab.wisc.edu/play/forevermine/game/files.txt', by: 'user:ada' });
  db.upsertBuild({ game_id: fm.id, ref_name: m.ref_name, ref_type: 'branch', commit_sha: 'url:3f9a1c2b7d4e5f60', actor: 'url-monitor' } as Upload, 88, 31_400_000);
  staging.objects.set(`fieldday/forevermine/${m.ref_name}/index.html`, new TextEncoder().encode('<h1>forevermine</h1>'));
  const hours = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
  db.sqlite.prepare(`UPDATE url_monitors SET last_checked_at = ?, last_changed_at = ?, last_status = 'unchanged', last_message = 'No changes (88 files checked).' WHERE id = ?`).run(hours(5), hours(77), m.id);
}

// Site listings: import the Hugo prototype's games if github.com/fielddaylab/vault-rebuild is checked out next to
// this repo (or at $VAULT_REBUILD), so /vault/listings and each studio's Site listings page have real content.
const rebuild = process.env.VAULT_REBUILD ?? new URL('../../vault-rebuild/', import.meta.url).pathname;
if (existsSync(`${rebuild}/migration/games-export.json`)) {
  const pages = JSON.parse(readFileSync(`${rebuild}/migration/games-export.json`, 'utf8'));
  const ov = existsSync(`${rebuild}/migration/import-overrides.json`) ? JSON.parse(readFileSync(`${rebuild}/migration/import-overrides.json`, 'utf8')) : {};
  const r = importListings(db, pages, ov.overrides ?? {}, 'user:boss', ov.studios ?? {});
  console.log(`site listings: imported ${r.created.length} published, ${r.drafts.length} drafts, ${r.studiosCreated.length} new studios from ${rebuild}`);
  // A studio member for the listings walkthrough: lee maintains NMSU Learning Games Lab's listings.
  const lgl = db.studios().find((s) => s.name === 'Learning Games Lab: NMSU');
  if (lgl) db.setMembership(lgl.id, 'lee', 'maintainer', 'user:boss');
  // The home page's Featured Games, as on vaultlearninggames.org today (the banners are in vault-rebuild/static/images/featured).
  saveFeatured(db, [
    { slug: 'project-hercules', blurb: 'In *Project Hercules*, you play Astrid, an astronomer in the distant future, working to identify objects in the night sky and uncover the mystery of an impending celestial event.', image: 'images/featured/project-hercules.webp', sequence: 1 },
    { slug: 'walden-self-reliance', blurb: '', image: 'images/featured/walden-self-reliance.webp', sequence: 2 },
    { slug: 'cozy-river-valley', blurb: '', image: 'images/featured/cozy-river-valley.webp', sequence: 3 },
  ], 'user:boss');
}

// Game availability (the Testing Status columns of Vault → Game Catalog): a run saved by
// `node scripts/check-games.ts --out FILE` when $GAME_CHECKS points at one, otherwise a made-up run over the listings.
if (process.env.GAME_CHECKS) {
  const run = parseRun(JSON.parse(readFileSync(process.env.GAME_CHECKS, 'utf8')));
  if (typeof run === 'string') throw new Error(`GAME_CHECKS: ${run}`);
  db.addGameCheck(run, 'github:dev');
} else {
  const onSite = db.listings({ published: true });
  const games = onSite.map((l, i): GameCheck => {
    const f = l.published!;
    const level = i === 1 ? 'fail' : i === 4 ? 'warn' : 'ok';
    return { slug: l.slug, title: f.title, studio: l.studio_slug, url: f.play_url, source: 'url', embed: f.embed, status: level === 'fail' ? 404 : 200,
      final_url: f.play_url, redirects: [], ms: level === 'warn' ? 6400 : 180 + i * 7, attempts: 1, error: null,
      framing: f.embed ? { allowed: true, reason: 'no framing restrictions' } : null, level,
      problems: level === 'fail' ? ['HTTP 404 Not Found'] : level === 'warn' ? ['Slow: 6.4 s to respond'] : [] };
  });
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  for (const n of [2, 1, 0]) {
    const run = { checked_at: day(n), site: 'https://vaultlearninggames.org', source: 'https://github.com/VaultLearningGames/vault-publisher/actions', games: n ? games.map((g) => ({ ...g, level: 'ok' as const, problems: [] })) : games };
    db.addGameCheck({ ...run, counts: countLevels(run.games) }, 'github:dev');
  }
}

// A finished site-check run to look at without waiting for one: SITE_CHECKS_JSON=run.json (what
// `npm run site:audit -- --site … --out run.json` writes).
if (process.env.SITE_CHECKS_JSON && existsSync(process.env.SITE_CHECKS_JSON)) {
  const run = parseSiteRun(JSON.parse(readFileSync(process.env.SITE_CHECKS_JSON, 'utf8')));
  if (typeof run === 'string') console.error(`SITE_CHECKS_JSON: ${run}`);
  else db.addSiteCheck(run, 'github:dev');
}

const app = createApp({
  db, staging, production,
  // No CI in dev, except admin tasks: `node scripts/admin-task.ts --portal http://localhost:4181 --token dev …`.
  verifier: {
    async github(token) {
      if (token !== 'dev') throw new Error('no CI in dev (admin tasks use the token "dev")');
      return { owner: 'VaultLearningGames', ownerId: '0', repository: 'VaultLearningGames/vault-publisher', repositoryId: '0', ref: 'refs/heads/main', sha: 'dev', actor: 'dev', eventName: 'workflow_dispatch', environment: 'production' };
    },
    async google() { throw new Error('no'); },
  },
  stagingPublicUrl: 'https://builds.vaultlearninggames.org', prodPublicUrl: 'https://cdn.vaultlearninggames.org',
  adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
  previewRetentionDays: 90, taskInvokerEmail: 'dev@example.org',
  siteUrl: SITE_URL,
  // Preview opens on this dev portal, which renders it with ../site (Hugo must be installed); the page loads its
  // CSS and images from SITE_URL.
  previewSites: parsePreviewSites(process.env.PREVIEW_SITES ?? `Site=http://localhost:${PORT}`),
  sitePreview: new SitePreviewer({
    siteDir: new URL('../site/', import.meta.url).pathname, siteUrl: SITE_URL, portalUrl: `http://localhost:${PORT}`,
    catalog: () => buildCatalog(db, 'https://cdn.vaultlearninggames.org'),
  }),
  // Analytics: a made-up property, or the real one with GA_PROPERTY_ID (read with your gcloud application default
  // credentials: `gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.readonly`).
  // GA_FAKE=off: neither, to see the pages' "not connected" state.
  analytics: new Analytics(parseGaPropertyId(process.env.GA_PROPERTY_ID)
    ? { propertyId: parseGaPropertyId(process.env.GA_PROPERTY_ID) }
    : process.env.GA_FAKE === 'off' ? {} : { transport: fakeGa(db.listings({ published: true }).map((l) => l.slug).slice(0, 40).concat(['wake', 'bloom'])) }),
  portal: {
    baseUrl: `http://localhost:${PORT}`, sessionSecret: 'dev-only-secret', vaultAdmins: ['boss'],
    oauth: {
      // "Signing in" asks for a username instead of going to GitHub.
      authorizeUrl: (state) => `/dev-login?state=${state}`,
      exchange: async (code) => ({ github_id: `dev-${code}`, login: code, name: code[0].toUpperCase() + code.slice(1), avatar_url: null }),
    },
  },
});
app.put('/dev-r2/*', async (c) => {
  staging.objects.set(decodeURIComponent(new URL(c.req.url).pathname.slice('/dev-r2/'.length)), new Uint8Array(await c.req.arrayBuffer()));
  return c.body(null, 200);
});
app.get('/dev-login', (c) => c.html(`<form action="/auth/callback" style="font:16px system-ui;max-width:360px;margin:15vh auto;display:grid;gap:10px">
  <b>Dev sign-in</b><input type="hidden" name="state" value="${c.req.query('state')}">
  <input name="code" placeholder="GitHub username" autofocus required style="padding:8px">
  <small>boss = Vault admin · ada = studio admin · mia = maintainer · vera = viewer · lee = NMSU maintainer · anyone else = no access</small>
  <button style="padding:8px">Sign in</button></form>`));

serve({ fetch: app.fetch, port: PORT }, () => console.log(`portal preview on http://localhost:${PORT}`));
