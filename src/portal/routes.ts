// The Vault Studio Portal: a server-rendered web UI on the same service and database as the publisher.
// Sign-in is GitHub OAuth (profile only). Studios control staging; only Vault release managers release,
// promote and roll back. Studio maintainers can request a release.
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppDeps } from '../app.ts';
import { fail, jsonBody } from '../app.ts';
import { DEFAULT_SUPPORT_URL, SUPPORT_CHANNEL } from '../config.ts';
import { studioWebsite, type Build, type Game, type Membership, type Release, type StudioRole, type Studio, type User, type VaultRole } from '../db.ts';
import { headersFor, isSafeFilePath, isVersionName, sanitizeRefName } from '../paths.ts';
import { escape, html, raw, type Html } from './html.ts';
import { listingPieces, registerListingPages, type ListingRow } from './listings.ts';
import { registerFeaturedApi } from './featured.ts';
import { registerSiteChecks } from './site-checks.ts';
import { Analytics, registerAnalytics } from './analytics.ts';
import { registerListingAssetsApi } from './listing-assets.ts';
import { registerListingPreview } from './listing-preview.ts';
import { registerListingMakers } from './listing-makers.ts';
import { registerImageMigration } from './image-migration.ts';
import { githubAccount, githubRepository, registerPeople, type GitHubAccountLookup, type GitHubRepositoryLookup } from './people.ts';
import { buildOrigin, registerUploads } from './uploads.ts';
import type { MonitorEnv } from '../url-monitor.ts';
import { randomToken, SESSION_COOKIE, SESSION_DAYS, signSession, verifySession } from './session.ts';

export interface GitHubProfile { github_id: string; login: string; name: string | null; avatar_url: string | null }

export interface OAuthClient {
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<GitHubProfile>;
}

export interface PortalConfig {
  githubClientId?: string;
  githubClientSecret?: string;
  sessionSecret?: string;
  // Public base URL of the portal, used for the OAuth callback (https://portal.vaultlearninggames.org).
  baseUrl: string;
  // GitHub logins that become Vault admins when they sign in (bootstrap).
  vaultAdmins: string[];
  // The "Need support?" link (the Slack invitation). Left out: the default; '': no link.
  supportUrl?: string;
  oauth?: OAuthClient; // injected in tests
  githubAccount?: GitHubAccountLookup; // injected in tests
  githubRepository?: GitHubRepositoryLookup; // injected in tests
}

type ReleaseResult = { release: Release; url: string };
type PromoteResult = { current: string; previous: string | null; rollback: boolean; url: string };
export interface PortalDeps extends AppDeps {
  approveRelease(studio: Studio, game: Game, version: string, ref: string | undefined, actor: string): Promise<ReleaseResult>;
  promoteRelease(studio: Studio, game: Game, version: string, actor: string): Promise<PromoteResult>;
  previewUrl(studio: Studio, game: Game, ref: string): string;
  // Building a test build from the portal (uploads.ts): presigned PUTs, then finalize. Shared with the CI routes.
  startUpload(studio: Studio, game: Game, ref: { type: 'branch' | 'tag'; name: string }, sha: string, actor: string, files: unknown, presignSeconds?: number):
    Promise<{ upload_id: string; url: string; files: { path: string; url: string; headers: Record<string, string> }[] }>;
  finishUpload(uploadId: string, allowed: (game: Game) => boolean, auditActor: string, auditDetail: Record<string, unknown>): Promise<{ url: string }>;
  linkSameNamedListing(studio: Studio, game: Game): void;
  monitorEnv: MonitorEnv;
}

function githubOAuth(clientId: string, clientSecret: string): OAuthClient {
  return {
    authorizeUrl: (state, redirectUri) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: 'read:user', state, allow_signup: 'false' })}`,
    async exchange(code, redirectUri) {
      const tok = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      }).then((r) => r.json() as Promise<{ access_token?: string; error_description?: string }>);
      if (!tok.access_token) throw new Error(tok.error_description || 'GitHub sign-in failed');
      const u = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vault-portal' },
      }).then((r) => r.json() as Promise<{ id: number; login: string; name: string | null; avatar_url: string | null }>);
      if (!u.id || !u.login) throw new Error('GitHub did not return a profile');
      return { github_id: String(u.id), login: u.login, name: u.name, avatar_url: u.avatar_url };
    },
  };
}

// ---------- formatting ----------
export const ROLE_LABEL: Record<StudioRole, string> = { viewer: 'Viewer', maintainer: 'Maintainer', admin: 'Studio admin' };
export const VAULT_LABEL: Record<VaultRole, string> = { none: '—', release_manager: 'Release manager', admin: 'Vault admin' };
export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} days ago`;
  return iso.slice(0, 10);
}
const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
export const who = (actor: string) => actor.replace(/^(github|user):/, '');
export const pill = (kind: 'ok' | 'run' | 'bad' | 'wait' | 'off' | 'brass', text: string) => html`<span class="pill p-${kind}">${text}</span>`;

// ---------- page layout ----------
// Content hashes of portal.css/js, so a deploy changes their URLs and browsers never use stale copies.
let assetVersion = 'dev';
// The Vault Game Library wordmark (white and teal), shown on a dark badge so it reads in both themes.
const logo = () => html`<img class="logo" src="/assets/vault-logo.png?v=${assetVersion}" alt="Vault Game Library" width="454" height="75">`;
// "Need support?": the invitation to the Slack workspace and the channel to join there, in the sidebar's foot (every
// signed-in page) and on the sign-in page. Set by registerPortal, like assetVersion; '' shows nothing.
let supportUrl = DEFAULT_SUPPORT_URL;
const supportLink = (text: string) => html`<a href="${supportUrl}" target="_blank" rel="noopener" title="Opens the Slack invitation in a new tab; join the ${SUPPORT_CHANNEL} channel">${text} ↗</a>`;
// The staging portal says so at the top of every page, signed in or not: what's saved there is for previewing and is
// overwritten whenever the Vault code changes, so real content belongs on production. Which system this is comes from
// the portal's own address (PORTAL_URL): the deploy refuses a staging environment whose PORTAL_URL doesn't contain
// "staging", and a production one whose does. Set by registerPortal, like supportUrl; '' on production.
let stagingBanner: Html | '' = '';
export function stagingProductionUrl(baseUrl: string): string | null {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return null; }
  if (!/staging/i.test(u.hostname)) return null;
  const host = u.hostname.replace(/-staging(?=\.)/i, '').replace(/^staging\./i, '');
  return host !== u.hostname && !/staging/i.test(host) ? `${u.protocol}//${host}` : '';
}
function stagingBannerFor(baseUrl: string): Html | '' {
  const prod = stagingProductionUrl(baseUrl);
  if (prod === null) return '';
  return html`<div class="env-banner" role="note" aria-label="This is the staging portal">
    <strong><span aria-hidden="true">⚠</span> Staging portal: for previewing features, not for content.</strong>
    <span>Settings, game data and anything else saved here apply only to staging, and are overwritten whenever the Vault code changes.
    Make real changes, and preview them, on the production portal${prod ? html`: <a href="${prod}/">${new URL(prod).host}</a>` : ''}.</span></div>`;
}
interface Nav { user: User; studio?: Studio; memberships: (Membership & { studio_slug: string; studio_name: string })[]; allStudios: Studio[] }
function layout(title: string, nav: Nav | null, body: Html | string, active = ''): string {
  const u = nav?.user;
  const staff = u && u.vault_role !== 'none';
  const studios = staff ? nav!.allStudios.map((s) => ({ slug: s.slug, name: s.name })) : (nav?.memberships ?? []).map((m) => ({ slug: m.studio_slug, name: m.studio_name }));
  const cur = nav?.studio;
  const side = nav ? html`
    <aside class="side" aria-label="Portal navigation">
      <a class="brand" href="/">${logo()}</a>
      ${studios.length ? html`<label class="studio-sw"><span>Studio</span>
        <select onchange="location.href='/s/'+this.value" aria-label="Studio">
          ${cur ? '' : html`<option value="">Choose…</option>`}
          ${studios.map((s) => html`<option value="${s.slug}" ${cur?.slug === s.slug ? 'selected' : ''}>${s.name}</option>`)}
        </select></label>` : ''}
      <nav class="nav">
        ${cur ? html`
          <a href="/s/${cur.slug}" class="${active === 'studio' ? 'on' : ''}">Games</a>
          <a href="/s/${cur.slug}/files" class="${active === 'files' ? 'on' : ''}">Files</a>
          <a href="/s/${cur.slug}/register" class="${active === 'register' ? 'on' : ''}">Upload builds</a>
          <a href="/s/${cur.slug}/analytics" class="${active === 'studio-analytics' ? 'on' : ''}">Analytics</a>
          <a href="/s/${cur.slug}/members" class="${active === 'members' ? 'on' : ''}">Members</a>` : ''}
        ${staff ? html`
          <div class="nav-sep">Vault</div>
          <a href="/vault" class="${active === 'vault' ? 'on' : ''}">Release requests</a>
          <a href="/vault/listings" class="${active === 'vault-listings' ? 'on' : ''}">Game Catalog</a>
          <a href="/vault/site-checks" class="${active === 'site-checks' ? 'on' : ''}">Site checks</a>
          <a href="/vault/analytics" class="${active === 'analytics' ? 'on' : ''}">Analytics</a>
          <a href="/vault/studios" class="${active === 'vault-studios' ? 'on' : ''}">Studios</a>
          <a href="/vault/people" class="${active === 'people' ? 'on' : ''}">People</a>
          <a href="/vault/activity" class="${active === 'activity' ? 'on' : ''}">Activity</a>` : ''}
      </nav>
      <div class="side-foot">
        ${supportUrl ? html`<p class="support">${supportLink('Need support?')} <span>Join our Slack, then the <b>${SUPPORT_CHANNEL}</b> channel.</span></p>` : ''}
        <div class="me">${u!.avatar_url ? html`<img src="${u!.avatar_url}&s=48" alt="" width="24" height="24">` : ''}<span><b>${u!.login}</b>${staff ? html`<br><span class="muted">${VAULT_LABEL[u!.vault_role]}</span>` : ''}</span></div>
        <form method="post" action="/logout"><button class="btn sm" type="submit">Sign out</button></form>
      </div>
    </aside>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escape(title)} · Vault Studio Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/portal.css?v=${assetVersion}"></head><body${stagingBanner ? ' class="staging"' : ''}>${stagingBanner}
<div class="${nav ? 'shell' : 'shell solo'}">${side}<main id="main">${body}</main></div>
<script src="/assets/portal.js?v=${assetVersion}" defer></script></body></html>`;
}

export const head = (title: string | Html, sub?: string | Html, actions?: Html | string, crumbs?: Html) => html`
  ${crumbs ? html`<div class="crumbs">${crumbs}</div>` : ''}
  <div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;

export function registerPortal(app: Hono, deps: PortalDeps) {
  const { db } = deps;
  const cfg = deps.portal;
  const configured = !!(cfg.sessionSecret && (cfg.oauth || (cfg.githubClientId && cfg.githubClientSecret)));
  const oauth = cfg.oauth ?? (cfg.githubClientId && cfg.githubClientSecret ? githubOAuth(cfg.githubClientId, cfg.githubClientSecret) : null);
  const callbackUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/auth/callback`;
  const secure = cfg.baseUrl.startsWith('https://');
  const admins = new Set(cfg.vaultAdmins.map((l) => l.toLowerCase()));
  supportUrl = cfg.supportUrl ?? DEFAULT_SUPPORT_URL;
  stagingBanner = stagingBannerFor(cfg.baseUrl);

  // Browsers that reach the portal on the service's default *.run.app address are sent to the portal's
  // real address (GitHub sign-in only returns there). The API and health check keep answering on both.
  const canonical = new URL(cfg.baseUrl);
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (host.endsWith('.run.app') && host !== canonical.host && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
      const url = new URL(c.req.url);
      return c.redirect(`${canonical.origin}${url.pathname}${url.search}`, 301);
    }
    return next();
  });

  // Static assets, read once at startup.
  const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)));
  const css = asset('portal.css'), js = asset('portal.js'), logoPng = asset('vault-logo.png');
  assetVersion = createHash('sha256').update(css).update(js).update(logoPng).digest('hex').slice(0, 10);
  const immutable = 'public, max-age=31536000, immutable';
  app.get('/assets/portal.css', (c) => c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': immutable }));
  app.get('/assets/portal.js', (c) => c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': immutable }));
  app.get('/assets/vault-logo.png', (c) => c.body(logoPng, 200, { 'Content-Type': 'image/png', 'Cache-Control': immutable }));

  // ---------- identity & permissions ----------
  function currentUser(c: Context): User | null {
    if (!cfg.sessionSecret) return null;
    const uid = verifySession(getCookie(c, SESSION_COOKIE), cfg.sessionSecret);
    return uid === null ? null : db.userById(uid) ?? null;
  }
  const isStaff = (u: User) => u.vault_role !== 'none';
  const canRelease = (u: User) => u.vault_role === 'release_manager' || u.vault_role === 'admin';
  const isVaultAdmin = (u: User) => u.vault_role === 'admin';
  const roleIn = (u: User, s: Studio) => db.roleIn(s.id, u.login);
  const canView = (u: User, s: Studio) => isStaff(u) || !!roleIn(u, s);
  const canRequest = (u: User, s: Studio) => canRelease(u) || ['maintainer', 'admin'].includes(roleIn(u, s) ?? '');
  // Switching between approved releases (make current / roll back): Vault release staff always; studio
  // maintainers and admins unless Vault has frozen the game.
  const canSwitch = (u: User, s: Studio, g: Game) => canRelease(u) || (!g.frozen_at && ['maintainer', 'admin'].includes(roleIn(u, s) ?? ''));
  const canManageMembers = (u: User, s: Studio) => isVaultAdmin(u) || roleIn(u, s) === 'admin';
  // Deleting a game from Vault: its studio's admins and Vault staff.
  const canDeleteGame = (u: User, s: Studio) => isStaff(u) || roleIn(u, s) === 'admin';
  const navFor = (u: User, studio?: Studio): Nav => ({ user: u, studio, memberships: db.membershipsForLogin(u.login), allStudios: db.studios() });
  const actor = (u: User) => `user:${u.login}`;
  // Site listings (listings.ts): shown with each game, since a game is its listing and/or its CDN game.
  const listingHelpers = { db, deps, page: (c: Context, t: string, b: Html, o?: { studio?: Studio; active?: string; status?: number }) => page(c, t, b, o),
    denied: (c: Context, m: string, st?: number) => denied(c, m, st), signedIn: (c: Context) => signedIn(c), studioFor: (c: Context, u: User) => studioFor(c, u),
    apiUser: (c: Context) => apiUser(c), actor, isStaff, canRelease, isVaultAdmin, roleIn };
  const LP = listingPieces(listingHelpers);
  // The "Upload builds" page (/s/:studio/register), zip uploads and URL monitors.
  const UP = registerUploads(app, listingHelpers);
  // Analytics (analytics.ts): Vault → Analytics, each studio's Analytics page, and each game's Analytics tab.
  const AN = registerAnalytics(app, listingHelpers, deps.analytics ?? new Analytics({}));

  function page(c: Context, title: string, body: Html, opts: { studio?: Studio; active?: string; status?: number } = {}) {
    const u = currentUser(c)!;
    return c.html(layout(title, navFor(u, opts.studio), body, opts.active ?? ''), (opts.status ?? 200) as 200);
  }
  function denied(c: Context, message: string, status = 403) {
    const u = currentUser(c);
    return c.html(layout('No access', u ? navFor(u) : null, html`${head('No access', message)}<p><a href="/">Back to the portal</a></p>`), status as 403);
  }
  // Page guard: signed in (else redirect to sign-in), and the studio exists and is visible to them.
  function signedIn(c: Context): User | Response {
    const u = currentUser(c);
    if (u) return u;
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  function studioFor(c: Context, u: User): Studio | Response {
    const s = db.studioBySlug(c.req.param('studio') ?? '');
    if (!s || !canView(u, s)) return denied(c, 'That studio doesn’t exist, or you aren’t a member of it.', 404);
    return s;
  }
  // API guard: JSON only, same-site requests only (custom header + SameSite=Lax cookie).
  function apiUser(c: Context): User {
    if (c.req.header('X-Requested-With') !== 'vault-portal') fail(403, 'bad request origin');
    const u = currentUser(c);
    if (!u) fail(401, 'Sign in again: your session has ended.');
    return u;
  }
  function apiStudioGame(c: Context, u: User) {
    const studio = db.studioBySlug(c.req.param('studio') ?? '');
    if (!studio || !canView(u, studio)) fail(404, 'unknown studio');
    const game = db.game(studio.id, c.req.param('game') ?? '');
    if (!game) fail(404, 'unknown game');
    return { studio, game };
  }

  // ---------- sign-in ----------
  app.get('/login', (c) => {
    if (currentUser(c)) return c.redirect('/');
    const next = c.req.query('next') ?? '/';
    const body = html`<div class="login">
      <div class="brand big">${logo()}</div>
      <h1>Studio Portal</h1>
      <p>Publish your games to classrooms. Your studio controls testing on staging; Vault reviews every release.</p>
      ${configured
        ? html`<a class="btn pri big" href="/auth/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a>
               <p class="small muted">We only read your GitHub name and picture.</p>`
        : html`<p class="fix">Sign-in isn’t set up yet: the GitHub OAuth app and session secret are missing.</p>`}
      ${c.req.query('error') ? html`<p class="err">${c.req.query('error')}</p>` : ''}
      ${supportUrl ? html`<p class="small muted">Need support? ${supportLink('Join our Slack')} and ask in the <b>${SUPPORT_CHANNEL}</b> channel.</p>` : ''}
    </div>`;
    return c.html(layout('Sign in', null, body));
  });

  app.get('/auth/github', (c) => {
    if (!oauth || !configured) return c.redirect('/login');
    const state = randomToken();
    const next = c.req.query('next') ?? '/';
    setCookie(c, 'vault_oauth', `${state}|${next.startsWith('/') && !next.startsWith('//') ? next : '/'}`, { httpOnly: true, secure, sameSite: 'Lax', path: '/auth', maxAge: 600 });
    return c.redirect(oauth.authorizeUrl(state, callbackUrl));
  });

  app.get('/auth/callback', async (c) => {
    if (!oauth || !configured) return c.redirect('/login');
    const [state, next = '/'] = (getCookie(c, 'vault_oauth') ?? '').split('|');
    deleteCookie(c, 'vault_oauth', { path: '/auth' });
    if (!state || state !== c.req.query('state') || !c.req.query('code')) return c.redirect('/login?error=' + encodeURIComponent('Sign-in expired. Try again.'));
    let profile: GitHubProfile;
    try {
      profile = await oauth.exchange(c.req.query('code')!, callbackUrl);
    } catch (err) {
      return c.redirect('/login?error=' + encodeURIComponent((err as Error).message));
    }
    const user = db.upsertUser(profile);
    if (admins.has(user.login.toLowerCase()) && user.vault_role !== 'admin') db.setVaultRole(user.id, 'admin');
    const invited = db.takeVaultInvite(user.login);
    if (invited && user.vault_role === 'none') {
      db.setVaultRole(user.id, invited);
      db.audit(actor(user), 'vault.role', user.login, { role: invited, from: 'none', invited: true });
    }
    db.audit(actor(user), 'portal.sign_in', user.login);
    setCookie(c, SESSION_COOKIE, signSession(user.id, cfg.sessionSecret!), { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
    return c.redirect(next);
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/login');
  });

  // ---------- home ----------
  app.get('/', (c) => {
    const u = signedIn(c);
    if (u instanceof Response) return u;
    const mine = db.membershipsForLogin(u.login);
    if (mine.length === 1 && !isStaff(u)) return c.redirect(`/s/${mine[0].studio_slug}`);
    const studios = isStaff(u) ? db.studios() : db.studios().filter((s) => mine.some((m) => m.studio_id === s.id));
    if (!studios.length) {
      return page(c, 'Welcome', html`${head(`Welcome, ${u.name || u.login}`, 'You’re signed in, but you aren’t a member of any studio yet.')}
        <div class="card"><p>Ask your studio’s admin (or Vault) to add your GitHub username: <code>${u.login}</code></p></div>`);
    }
    const rows = studios.map((s) => {
      const games = db.gamesForStudio(s.id);
      const released = games.filter((g) => db.currentRelease(g.id)).length;
      return html`<tr><td class="proj"><a href="/s/${s.slug}"><b>${s.name}</b></a><span>${s.slug}</span></td>
        <td class="r num">${games.length}</td><td class="r num">${released}</td>
        <td>${roleIn(u, s) ? ROLE_LABEL[roleIn(u, s)!] : html`<span class="muted">Vault staff</span>`}</td></tr>`;
    });
    return page(c, 'Studios', html`${head('Studios', 'Choose a studio.')}
      <div class="tbl-wrap"><table><thead><tr><th>Studio</th><th class="r">Games</th><th class="r">Live for classrooms</th><th>Your role</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  });

  // ---------- studio dashboard ----------
  app.get('/s/:studio', (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    const s = studioFor(c, u); if (s instanceof Response) return s;
    // A game is its site listing and/or its CDN game: listings first (with their CDN game, if connected), then
    // CDN games that aren't on the site yet.
    const listings = db.listings({ studioId: s.id }) as ListingRow[];
    const cdnGames = db.gamesForStudio(s.id);
    const linked = new Set(listings.map((l) => l.game_id));
    const entries: { l: ListingRow | null; g: Game | null }[] = [
      ...listings.map((l) => ({ l, g: l.game_id ? cdnGames.find((g) => g.id === l.game_id) ?? null : null })),
      ...cdnGames.filter((g) => !linked.has(g.id)).map((g) => ({ l: null, g })),
    ];
    let onCdn = 0, ready = 0;
    const testVersions = cdnGames.reduce((n, g) => n + db.liveBuilds(g.id).length, 0);   // per CDN game (a collection counts once)
    const openRequests = db.releaseRequests({ status: 'requested' }).filter((r) => r.studio_slug === s.slug);
    const rows = entries.map(({ l, g }) => {
      const builds = g ? db.liveBuilds(g.id) : [];
      const cur = g ? db.currentRelease(g.id) : undefined;
      const playsCdn = l?.published?.play_source === 'cdn' && !!cur;
      if (playsCdn) onCdn++; else if (cur && l) ready++;
      const shown = builds.slice(0, 3);
      const slug = l?.slug ?? g!.slug;
      return html`<tr>
        <td class="proj"><a href="/s/${s.slug}/g/${slug}"><b>${l?.draft.title || slug}</b></a><span>${l ? html`/games/${l.slug}/` : 'not on the site'}${g ? html` · CDN <span class="mono">${g.slug}</span>` : ''}</span></td>
        <td>${LP.publishing(l) || (l?.published ? pill('ok', 'Published') : pill('off', 'Testing Only'))}</td>
        <td>${LP.hosting(l, g)}${cur && !playsCdn && l ? html`<br><span class="small">${pill('ok', `CDN ${cur.version} ready`)}</span>` : ''}</td>
        <td>${g ? (builds.length ? html`<div class="refs">${shown.map((bd) => html`<a class="ref-chip ${bd.ref_type}" href="${deps.previewUrl(s, g, bd.ref_name)}" title="${bd.ref_type} · ${ago(bd.updated_at)}">${bd.ref_name}</a>`)}${builds.length > shown.length ? html`<span class="muted small">+${builds.length - shown.length}</span>` : ''}</div>` : html`<span class="muted small">No test versions</span>`)
          : html`<span class="muted small">Not on the CDN yet</span>`}</td>
        <td>${cur ? html`<span class="rel">${cur.version}</span> <span class="muted small">${ago(cur.approved_at)}</span>` : html`<span class="muted small">—</span>`}</td></tr>`;
    });
    const body = html`${head(s.name, html`Every ${s.name} game on Vault. Games are hosted at their <b>web address</b> until they move to the <b>Vault CDN</b>: staging is yours to test on, production is what classrooms play, released by Vault.`,
      html`<a class="btn" href="/s/${s.slug}/register">Upload builds</a>`)}
      <div class="kpis four">
        <div class="kpi"><div class="v">${entries.length}</div><div class="l">Games</div></div>
        <div class="kpi"><div class="v">${onCdn}</div><div class="l">Hosted on the Vault CDN</div></div>
        <div class="kpi"><div class="v">${ready}</div><div class="l">CDN release ready to switch</div></div>
        <div class="kpi"><div class="v">${testVersions}</div><div class="l">Test versions on staging</div></div>
      </div>
      ${openRequests.length ? html`<p class="small">${pill('wait', `${openRequests.length} release request${openRequests.length > 1 ? 's' : ''} waiting for Vault`)}</p>` : ''}
      ${entries.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th>Status</th><th>Hosted by</th><th>Staging (testing)</th><th>Production</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<div class="card"><p>No games yet. <a href="/s/${s.slug}/register">Upload a build</a>, or ask Vault to add your games to the site.</p></div>`}
      ${LP.canEdit(u, s) ? html`<div class="card" style="margin-top:18px"><h2>Add a game to the site</h2><form data-api="/portal/api/s/${s.slug}/listings" data-then="reload" class="inline-form">
          <label class="field"><span class="lab">Title</span><input name="title" required autocomplete="off"></label>
          <label class="field"><span class="lab">Page address</span><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" autocomplete="off" placeholder="my-game"></label>
          <button class="btn pri">Add</button><span class="err" role="status" aria-live="polite"></span></form>
          <p class="small muted">It is hosted at its web address until it has a release on the Vault CDN.</p></div>` : ''}`;
    return page(c, s.name, body, { studio: s, active: 'studio' });
  });

  // ---------- file browser ----------
  // Read-only view of the studio's folder on the staging or production CDN, one folder level at a time.
  app.get('/s/:studio/files', async (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    const s = studioFor(c, u); if (s instanceof Response) return s;
    const env = c.req.query('env') === 'production' ? 'production' : 'staging';
    const store = env === 'production' ? deps.production : deps.staging;
    const publicUrl = env === 'production' ? deps.prodPublicUrl : deps.stagingPublicUrl;
    // `path` is relative to the studio folder: "" or "game/ref/Build/".
    let path = c.req.query('path') ?? '';
    if (path && !path.endsWith('/')) path += '/';
    if (path && !isSafeFilePath(path.slice(0, -1))) return denied(c, 'That isn’t a valid folder.', 404);
    const link = (p: string, e = env) => `/s/${s.slug}/files?${new URLSearchParams({ ...(e === 'production' ? { env: e } : {}), ...(p ? { path: p } : {}) })}`;
    const parts = path.split('/').filter(Boolean);
    const crumbs = html`<a href="${link('')}">${s.slug}</a>${parts.map((part, i) => html` / ${i === parts.length - 1 ? part : html`<a href="${link(parts.slice(0, i + 1).join('/') + '/')}">${part}</a>`}`)}`;
    const toggle = html`<div class="seg" role="group" aria-label="Bucket">
      <a href="${link(path, 'staging')}" class="${env === 'staging' ? 'on' : ''}">Staging</a>
      <a href="${link(path, 'production')}" class="${env === 'production' ? 'on' : ''}">Production</a></div>`;
    const title = html`Files`;
    const sub = html`<span class="mono">${publicUrl}/${s.slug}/${path}</span>`;
    if (!store) return page(c, 'Files', html`${head(title, sub, toggle, crumbs)}<div class="card"><p class="muted">Production isn’t configured on this server.</p></div>`, { studio: s, active: 'files' });

    const prefix = `${s.slug}/${path}`;
    const token = c.req.query('next') || undefined;
    const listing = await store.browse(prefix, token);
    const name = (key: string) => key.slice(prefix.length);
    const kind = (key: string) => {
      const h = headersFor(key);
      return h.contentType.split(';')[0] + (h.contentEncoding ? ` · ${h.contentEncoding}` : '');
    };
    const rows = [
      ...(parts.length ? [html`<tr><td colspan="5"><a href="${link(parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '')}">↰ Up</a></td></tr>`] : []),
      ...listing.folders.map((f) => html`<tr><td class="mono"><a href="${link(f.slice(s.slug.length + 1))}">📁 ${name(f)}</a></td><td class="muted">Folder</td><td class="r muted">—</td><td class="r muted">—</td><td></td></tr>`),
      ...listing.files.map((f) => html`<tr><td class="mono">${name(f.key)}</td><td class="small muted">${kind(f.key)}</td><td class="r">${mb(f.size)}</td>
        <td class="r small" title="${f.modified ?? ''}">${f.modified ? ago(f.modified) : '—'}</td>
        <td class="r"><a href="${publicUrl}/${f.key}" target="_blank" rel="noopener" aria-label="Open ${name(f.key)}">Open ↗</a></td></tr>`),
    ];
    const empty = !listing.folders.length && !listing.files.length;
    const more = listing.next ? html`<p><a class="btn" href="${link(path)}&amp;next=${encodeURIComponent(listing.next)}">Show more</a></p>` : '';
    const body = html`${head(title, sub, toggle, crumbs)}
      ${empty && !token ? html`<div class="card"><p class="muted">${parts.length ? 'This folder is empty.' : env === 'production' ? 'Nothing released to production yet.' : 'Nothing on staging yet.'}</p></div>`
        : html`<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Type</th><th class="r">Size</th><th class="r">Modified</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${more}`}`;
    return page(c, 'Files', body, { studio: s, active: 'files' });
  });

  // ---------- game page ----------
  // The Vault CDN side of a game: staging test versions, production releases, release requests, and their dialogs.
  function cdnPanels(u: User, s: Studio, g: Game): { main: Html; side: Html; dialogs: Html } {
    const builds = db.liveBuilds(g.id);
    const releases = db.releases(g.id);
    const cur = db.currentRelease(g.id);
    const requests = db.releaseRequests({ gameId: g.id });
    const release = canRelease(u), request = canRequest(u, s);
    const stable = `${deps.prodPublicUrl}/${s.slug}/${g.slug}/`;
    const api = `/portal/api/s/${s.slug}/g/${g.slug}`;
    // A build that didn't come from a push (a .zip uploaded here, or a copy of a monitored web address) has no commit.
    const buildRows = builds.map((b: Build) => { const origin = buildOrigin(b.commit_sha); const type = origin === 'upload' ? 'upload' : b.ref_type; return html`<tr>
      <td><span class="mono">${b.ref_name}</span> <span class="tag">${origin ?? b.ref_type}</span></td>
      <td class="small">${origin ? html`<span class="muted">${origin === 'upload' ? 'a .zip uploaded here' : 'copied from its web address'}</span>` : g.repository ? html`<a class="mono" href="https://github.com/${g.repository}/commit/${b.commit_sha}">${b.commit_sha.slice(0, 7)}</a>` : html`<span class="muted">uploaded by Vault</span>`}</td>
      <td class="small num">${b.file_count} files · ${mb(b.total_bytes)}</td>
      <td class="small">${ago(b.updated_at)}<br><span class="muted">by ${b.actor}</span></td>
      <td class="small"><a href="${deps.previewUrl(s, g, b.ref_name)}" target="_blank" rel="noopener">Play ↗</a></td>
      <td class="r">${release
        ? html`<button class="btn sm brass" data-open="release" data-ref="${b.ref_name}" data-type="${type}">Release…</button>`
        : request ? html`<button class="btn sm" data-open="request" data-ref="${b.ref_name}" data-type="${type}">Request release…</button>` : ''}</td></tr>`; });
    const switcher = canSwitch(u, s, g);
    const relRows = releases.map((r) => {
      const isCur = cur?.id === r.id;
      const back = !!cur && cur.id > r.id;
      const status = isCur ? pill('brass', '★ Current') : r.withdrawn_at ? html`<span title="${r.withdrawn_note ?? ''}">${pill('bad', 'Withdrawn')}</span>` : pill('off', 'Previous');
      const actions: Html[] = [];
      if (switcher && !isCur && !r.withdrawn_at) actions.push(html`<form data-api="${api}/promote" data-busy="Copying ${r.version} into place (${mb(r.total_bytes)}). This can take a minute; keep this page open." data-confirm="${back ? `Roll ${g.slug} back to ${r.version}? Classrooms get it immediately.` : `Make ${r.version} the version classrooms get?`}">
          <input type="hidden" name="version" value="${r.version}"><button class="btn sm">${back ? 'Roll back to this' : 'Make current'}</button><span class="err" role="status" aria-live="polite"></span></form>`);
      if (release && !isCur && !r.withdrawn_at) actions.push(html`<button class="btn sm" data-open="withdraw" data-ref="${r.version}">Withdraw…</button>`);
      if (release && r.withdrawn_at) actions.push(html`<form data-api="${api}/withdraw" data-then="reload" data-confirm="Allow ${r.version} to be made current again?"><input type="hidden" name="ref" value="${r.version}"><input type="hidden" name="restore" value="1"><button class="btn sm">Restore</button><span class="err" role="status" aria-live="polite"></span></form>`);
      return html`<tr>
        <td class="mono">${r.version}</td>
        <td>${status}${r.withdrawn_at && r.withdrawn_note ? html`<br><span class="small muted">“${r.withdrawn_note}”</span>` : ''}</td>
        <td class="small">from <span class="mono">${r.source_ref}</span>${r.commit_sha && g.repository && !buildOrigin(r.commit_sha) ? html` · <a class="mono" href="https://github.com/${g.repository}/commit/${r.commit_sha}">${r.commit_sha.slice(0, 7)}</a>` : ''}</td>
        <td class="small">${r.approved_at.slice(0, 10)} · ${who(r.approved_by)}</td>
        <td class="small"><a href="${deps.prodPublicUrl}/${s.slug}/${g.slug}/_releases/${r.version}/" target="_blank" rel="noopener">Play ↗</a></td>
        <td class="r"><div class="row-actions">${actions}</div></td></tr>`;
    });
    const reqRows = requests.map((r) => html`<tr>
      <td class="mono">${r.version}</td><td class="small">from <span class="mono">${r.ref}</span></td>
      <td>${r.status === 'requested' ? pill('wait', 'Waiting for Vault') : r.status === 'approved' ? pill('ok', 'Approved') : r.status === 'rejected' ? pill('bad', 'Sent back') : pill('off', 'Withdrawn')}</td>
      <td class="small">${who(r.requested_by)} · ${ago(r.created_at)}${r.notes ? html`<br><span class="muted">“${r.notes}”</span>` : ''}${r.decision_note ? html`<br><span class="muted">Vault: “${r.decision_note}”</span>` : ''}</td>
      <td class="r">${r.status === 'requested' && release ? html`<a class="btn sm" href="/vault#req-${r.id}">Review</a>` : ''}
        ${r.status === 'requested' && (r.requested_by === actor(u) || canManageMembers(u, s)) ? html`<form data-api="/portal/api/requests/${r.id}/withdraw" data-confirm="Withdraw this request?"><button class="btn sm">Withdraw</button><span class="err" role="status" aria-live="polite"></span></form>` : ''}</td></tr>`);
    const main = html`<div class="grid">
          <div class="card"><h2>Staging · test versions <small>every build you upload · branches and uploads are kept 90 days after their last change</small></h2>
            ${builds.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Version</th><th>Commit</th><th>Size</th><th>Published</th><th>Preview</th><th></th></tr></thead><tbody>${buildRows}</tbody></table></div>`
              : html`<p class="muted">Nothing on staging yet. <a href="/s/${s.slug}/register">Upload a build</a>: from GitHub, as a .zip, or from a web address.</p>`}${UP.monitorNote(s, g)}</div>
          <div class="card"><h2>Production · released versions <small>immutable; only Vault releases new versions${g.frozen_at ? '; frozen by Vault' : '; maintainers choose which approved version is current'}</small></h2>
            ${releases.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Release</th><th>Status</th><th>Built from</th><th>Approved</th><th>Link</th><th></th></tr></thead><tbody>${relRows}</tbody></table></div>`
              : html`<p class="muted">Nothing released yet.${request ? ' Choose “Request release” on a test version above.' : ''}</p>`}</div>
          ${requests.length ? html`<div class="card"><h2>Release requests</h2><div class="tbl-wrap"><table><thead><tr><th>Version</th><th>Build</th><th>Status</th><th>Requested</th><th></th></tr></thead><tbody>${reqRows}</tbody></table></div></div>` : ''}
        </div>`;
    const side = html`<div class="grid" style="align-content:start">
          <div class="card"><h2>Live for classrooms</h2>${cur ? html`<div class="big-rel">${cur.version}</div><p class="small muted">approved ${cur.approved_at.slice(0, 10)} by ${who(cur.approved_by)}</p>` : html`<p class="muted">No Public Releases</p>`}
            ${cur ? html`<p class="small">Stable link (always the current release):<br><a class="mono wrap" href="${stable}" target="_blank" rel="noopener">${stable}</a></p>` : ''}
            ${g.frozen_at ? html`<p class="small">${pill('wait', 'Frozen')} by ${who(g.frozen_by ?? '')} ${ago(g.frozen_at)}${g.frozen_note ? html`: “${g.frozen_note}”` : ''}. Only Vault can change the current release.</p>` : ''}
            ${release ? (g.frozen_at
              ? html`<form data-api="${api}/freeze" data-then="reload" data-confirm="Let ${s.name} switch versions again?"><input type="hidden" name="frozen" value=""><button class="btn sm">Unfreeze</button><span class="err" role="status" aria-live="polite"></span></form>`
              : html`<form data-api="${api}/freeze" data-then="reload" class="inline-form"><input type="hidden" name="frozen" value="1"><input name="note" required placeholder="Why (e.g. study until Dec 15)" aria-label="Reason for freezing"><button class="btn sm">Freeze</button><span class="err" role="status" aria-live="polite"></span></form>`) : ''}</div>
          ${canDeleteGame(u, s) ? html`<div class="card danger"><h2>Danger zone</h2>
            <p class="small">Delete <b class="mono">${g.slug}</b> from Vault: every test version on staging${releases.length ? html`, <b>all ${releases.length} production release${releases.length > 1 ? 's' : ''}</b> (classrooms lose the game)` : ''} and its history here.${db.listingsForGame(g.id).length ? ' Its site listing stays, but is no longer hosted on the CDN.' : ''} This can’t be undone.</p>
            <p class="small muted">If the repository’s workflow still publishes, its next push adds the game back. Remove the workflow first.</p>
            <form data-api="${api}/delete" data-then="/s/${s.slug}" data-busy="Deleting ${g.slug}’s files. This can take a minute; keep this page open.">
              <label class="field"><span class="lab">Type <b class="mono">${g.slug}</b> to confirm</span><input name="confirm" required autocomplete="off" spellcheck="false" aria-label="Type ${g.slug} to confirm"></label>
              <button class="btn danger">Delete game</button><span class="err" role="status" aria-live="polite"></span></form></div>` : ''}
          <div class="card small"><h2>How releasing works</h2><ol class="tight">
            <li><a href="/s/${s.slug}/register">Upload a build</a> (a push from GitHub, a .zip, or a monitored web address); it appears above as a test version. From GitHub, a version tag like <code>v1.2</code> is best.</li>
            <li>Test it on staging, then ${release ? html`choose <b>Release…</b>` : request ? html`choose <b>Request release…</b>` : 'a maintainer requests a release'}.</li>
            <li>Vault copies that exact build to production and makes it current. Earlier releases stay available for rollback.</li>
            <li>Maintainers can switch between approved releases or roll back at any time, unless Vault has frozen the game or withdrawn a release.</li></ol></div>
        </div>`;
    const dialogs = html`${release ? html`<dialog id="withdraw"><form data-api="${api}/withdraw" class="dlg" data-then="reload">
        <h2>Withdraw a release</h2>
        <p class="small"><b class="mono" data-fill="ref"></b> stays on production at its version link, but nobody can make it current again until Vault restores it.</p>
        <input type="hidden" name="ref"><label class="field"><span>Why</span><input name="note" required placeholder="e.g. logs student names; fixed in 0.1.2"></label>
        <div class="dlg-foot"><span class="err" role="status" aria-live="polite"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn">Withdraw</button></div></form></dialog>` : ''}
      ${release ? html`<dialog id="release"><form data-api="${api}/release" class="dlg" data-then="reload" data-busy="Copying the build to production. This can take a few minutes; keep this page open.">
        <h2>Release to classrooms</h2>
        <p class="small">Copies the staging build <b class="mono" data-fill="ref"></b> to production. A version name can be used only once.</p>
        <input type="hidden" name="ref">
        <label class="field"><span class="lab">Version name</span><input name="version" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" placeholder="v1.2"><span class="hint">Shown to Vault and in the release history.</span></label>
        <label class="check"><input type="checkbox" name="makeCurrent" checked> Make it the version classrooms get now</label>
        <p class="warn-branch small" hidden>This is a branch, not a tag, so it may change after you test it. A tag is safer.</p>
        <div class="dlg-foot"><span class="err" role="status" aria-live="polite"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn brass">Release</button></div>
      </form></dialog>` : ''}
      ${request && !release ? html`<dialog id="request"><form data-api="${api}/request" class="dlg" data-then="reload">
        <h2>Request a release</h2>
        <p class="small">Asks Vault to test <b class="mono" data-fill="ref"></b> and release it to classrooms.</p>
        <input type="hidden" name="ref">
        <label class="field"><span class="lab">Version name</span><input name="version" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" placeholder="v1.2"></label>
        <label class="field"><span class="lab">Notes for Vault</span><textarea name="notes" placeholder="What changed, what to check"></textarea></label>
        <div class="dlg-foot"><span class="err" role="status" aria-live="polite"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn pri">Send request</button></div>
      </form></dialog>` : ''}`;
    return { main, side, dialogs };
  }

  // A game's page: its site listing and/or its CDN game. Games already on the site that are only hosted at a
  // web address have just a listing; once they're on the Vault CDN, the same page switches them over.
  app.get('/s/:studio/g/:game', async (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    const s = studioFor(c, u); if (s instanceof Response) return s;
    const slug = c.req.param('game');
    let l = db.listing(slug) as ListingRow | undefined;
    if (l && l.studio_id !== s.id) l = undefined;
    let g: Game | null = l?.game_id ? db.gameById(l.game_id) ?? null : null;
    if (!l) {
      g = db.game(s.id, slug) ?? null;
      if (!g) {
        // A listing that moved to another studio: follow it there, if they can see that studio.
        const moved = db.listing(slug) as ListingRow | undefined;
        const home = moved && db.studioById(moved.studio_id);
        if (home && canView(u, home)) return c.redirect(`/s/${home.slug}/g/${slug}`);
        return denied(c, 'That game doesn’t exist.', 404);
      }
      const lgs = db.listingsForGame(g.id);
      if (lgs.length === 1) return c.redirect(`/s/${s.slug}/g/${lgs[0].slug}${c.req.query('tab') ? `?tab=${c.req.query('tab')}` : ''}`);
    }
    const asked = c.req.query('tab');
    const tab = asked === 'cdn' || asked === 'listing' || asked === 'analytics' ? asked : l || (g && db.listingsForGame(g.id).length) ? 'listing' : 'cdn';
    const title = l?.draft.title || g!.slug;
    const sub = html`${l?.published ? html`<a href="https://vaultlearninggames.org/games/${l.slug}/" target="_blank" rel="noopener">vaultlearninggames.org/games/${l.slug}/</a>` : l ? html`<span class="muted">vaultlearninggames.org/games/${l.slug}/ (not published)</span>` : html`<span class="muted">not on the site</span>`}
      ${g?.repository ? html` · <a href="https://github.com/${g.repository}" title="${g.repository}">GitHub Repo</a>` : ''}`;
    const tabs = html`<div class="tabs"><a href="?tab=listing" class="${tab === 'listing' ? 'on' : ''}">Site listing</a><a href="?tab=cdn" class="${tab === 'cdn' ? 'on' : ''}">Vault CDN${g ? html` · ${db.currentRelease(g.id)?.version ?? 'no release'}` : ''}</a><a href="?tab=analytics" class="${tab === 'analytics' ? 'on' : ''}">Analytics</a></div>`;
    let content: Html | string;
    let dialogs: Html | string = '';
    if (tab === 'analytics') content = await AN.gameTab(u, s, l ?? null, c);
    else if (tab === 'listing') {
      if (l) { const ed = LP.editor(u, s, l, g); content = html`<div class="grid g-main">${ed.form}<div class="grid" style="align-content:start">${ed.side}</div></div>`; }
      else {
        const served = db.listingsForGame(g!.id) as ListingRow[];
        content = served.length
          ? html`<div class="card"><h2>Site games in this CDN game</h2><div class="tbl-wrap"><table><thead><tr><th>Game</th><th>Folder</th><th>Site</th></tr></thead><tbody>${served.map((x) => html`<tr><td class="proj"><a href="/s/${s.slug}/g/${x.slug}"><b>${x.draft.title || x.slug}</b></a><span>/games/${x.slug}/</span></td><td class="mono small">${x.draft.cdn_path || '/'}</td><td>${LP.state(x)}</td></tr>`)}</tbody></table></div></div>`
          : LP.createListingCard(u, s, g!);
      }
    } else if (g) {
      const p = cdnPanels(u, s, g);
      content = html`<div class="grid g-main">${p.main}${p.side}</div>`;
      dialogs = p.dialogs;
    } else content = LP.linkCard(u, s, l!);
    const body = html`${head(title, sub, g ? html`<a class="btn" href="/s/${s.slug}/files?path=${encodeURIComponent(g.slug + '/')}">Browse files</a>` : '', html`<a href="/s/${s.slug}">${s.name}</a> / ${title}`)}
      ${LP.playCard(u, s, l ?? null, g)}
      ${tabs}${content}${dialogs}`;
    return page(c, title, body, { studio: s, active: 'studio' });
  });

  // ---------- Vault staff ----------
  app.get('/vault', (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    if (!isStaff(u)) return denied(c, 'Only Vault staff can see this page.');
    const open = db.releaseRequests({ status: 'requested' });
    const decided = db.releaseRequests({}).filter((r) => r.status !== 'requested').slice(0, 15);
    const cards = open.map((r) => {
      const s = db.studioBySlug(r.studio_slug)!, g = db.game(s.id, r.game_slug)!;
      const b = db.build(g.id, r.ref);
      const cur = db.currentRelease(g.id);
      return html`<div class="card req" id="req-${r.id}">
        <h2><span><a href="/s/${s.slug}/g/${g.slug}">${s.slug}/${g.slug}</a> <span class="rel">${r.version}</span></span><small>requested ${ago(r.created_at)} by ${who(r.requested_by)}</small></h2>
        <table class="kv"><tbody>
          <tr><th>Staging build</th><td>${b && b.status === 'live' ? html`<a href="${deps.previewUrl(s, g, r.ref)}" target="_blank" rel="noopener" class="mono">${r.ref}</a> (${b.ref_type}) · commit <span class="mono">${b.commit_sha.slice(0, 7)}</span> · ${mb(b.total_bytes)} · published ${ago(b.updated_at)}` : html`<span class="err">${r.ref} is no longer on staging</span>`}</td></tr>
          <tr><th>Live now</th><td>${cur ? html`<span class="rel">${cur.version}</span>` : 'nothing yet'}</td></tr>
          ${r.notes ? html`<tr><th>Notes</th><td>${r.notes}</td></tr>` : ''}
        </tbody></table>
        ${canRelease(u) ? html`<div class="req-actions">
          <form data-api="/portal/api/requests/${r.id}/approve" data-then="reload" data-confirm="Release ${g.slug} ${r.version} to production?" data-busy="Copying ${b ? mb(b.total_bytes) : 'the build'} to production. This can take a few minutes; keep this page open."><label class="check"><input type="checkbox" name="makeCurrent" checked> Make it current</label><button class="btn brass">Approve and release</button><span class="err" role="status" aria-live="polite"></span></form>
          <form data-api="/portal/api/requests/${r.id}/reject" data-then="reload" class="inline-form"><input name="note" placeholder="Why it’s being sent back" required aria-label="Reason"><button class="btn">Send back</button><span class="err" role="status" aria-live="polite"></span></form>
        </div>` : ''}</div>`;
    });
    const switches = db.auditFor(['release.promote', 'release.rollback'], 10).map((a) => {
      const d = a.detail_json ? JSON.parse(a.detail_json) as { from: string | null; to: string } : null;
      return html`<tr><td>${a.target.replace(/\/$/, '')}</td><td>${a.action === 'release.rollback' ? pill('wait', 'Rolled back') : pill('ok', 'Made current')} <span class="mono">${d?.from ?? '—'} → ${d?.to ?? '?'}</span></td><td class="small">${who(a.actor)} · ${ago(a.at)}</td></tr>`;
    });
    const hist = decided.map((r) => html`<tr><td>${r.studio_slug}/${r.game_slug}</td><td class="mono">${r.version}</td><td>${r.status === 'approved' ? pill('ok', 'Approved') : r.status === 'rejected' ? pill('bad', 'Sent back') : pill('off', 'Withdrawn')}</td><td class="small">${r.decided_by ? who(r.decided_by) : '—'} · ${ago(r.decided_at)}</td></tr>`);
    const body = html`${head('Release requests', 'Studios ask for releases here. Test the staging build before approving; approval copies that exact build to production.')}
      ${open.length ? cards : html`<div class="card"><p class="muted">No open requests.</p></div>`}
      ${switches.length ? html`<h3 class="sec">Recent version switches</h3><div class="tbl-wrap"><table><thead><tr><th>Game</th><th>Change</th><th>By</th></tr></thead><tbody>${switches}</tbody></table></div>` : ''}
      ${hist.length ? html`<h3 class="sec">Recently decided</h3><div class="tbl-wrap"><table><thead><tr><th>Game</th><th>Version</th><th>Decision</th><th>By</th></tr></thead><tbody>${hist}</tbody></table></div>` : ''}`;
    return page(c, 'Release requests', body, { active: 'vault' });
  });

  app.get('/vault/activity', (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    if (!isStaff(u)) return denied(c, 'Only Vault staff can see this page.');
    const rows = db.recentAudit(100).map((a) => html`<tr><td class="small num">${a.at.slice(0, 16).replace('T', ' ')}</td><td class="small">${who(a.actor)}</td><td class="mono small">${a.action}</td><td class="mono small">${a.target}</td></tr>`);
    return page(c, 'Activity', html`${head('Activity', 'The last 100 changes: publishes, releases, sign-ins and membership changes.')}<div class="tbl-wrap"><table><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table></div>`, { active: 'activity' });
  });

  // ---------- portal API (JSON, same-site, signed in) ----------
  const versionOf = (v: unknown) => { if (!isVersionName(v)) fail(400, 'Use a version name like v1.2 or m3.2 (letters, numbers, dots, dashes).'); return v; };
  const refOf = (v: unknown) => { const r = typeof v === 'string' ? sanitizeRefName(v) : null; if (!r) fail(400, 'Choose a staging build.'); return r; };

  app.post('/portal/api/s/:studio/g/:game/release', async (c) => {
    const u = apiUser(c);
    if (!canRelease(u)) fail(403, 'Only Vault release managers can release.');
    const { studio, game } = apiStudioGame(c, u);
    const b = await jsonBody(c);
    const out = await deps.approveRelease(studio, game, versionOf(b.version), refOf(b.ref), actor(u));
    const promoted = b.makeCurrent ? await deps.promoteRelease(studio, game, out.release.version, actor(u)) : null;
    return c.json({ ok: true, url: out.url, current: promoted?.current ?? null });
  });

  app.post('/portal/api/s/:studio/g/:game/promote', async (c) => {
    const u = apiUser(c);
    const { studio, game } = apiStudioGame(c, u);
    if (!canSwitch(u, studio, game)) {
      fail(403, game.frozen_at && roleIn(u, studio) && roleIn(u, studio) !== 'viewer'
        ? `Vault has frozen ${game.slug}${game.frozen_note ? ` (${game.frozen_note})` : ''}; ask Vault to change the current release.`
        : 'Only maintainers can change the current release.');
    }
    return c.json({ ok: true, ...(await deps.promoteRelease(studio, game, versionOf((await jsonBody(c)).version), actor(u))) });
  });

  // Vault: withdraw a release so it can't be made current (or restore it). Body: { ref: version, note, restore? }
  app.post('/portal/api/s/:studio/g/:game/withdraw', async (c) => {
    const u = apiUser(c);
    if (!canRelease(u)) fail(403, 'Only Vault release managers can withdraw releases.');
    const { studio, game } = apiStudioGame(c, u);
    const b = await jsonBody(c);
    const r = db.release(game.id, versionOf(b.ref));
    if (!r) fail(404, 'unknown release');
    const target = `${studio.slug}/${game.slug}/${r.version}`;
    if (b.restore) {
      db.setWithdrawn(r.id, null, null);
      db.audit(actor(u), 'release.restore', target);
    } else {
      if (db.currentRelease(game.id)?.id === r.id) fail(409, `${r.version} is current. Make another release current first.`);
      const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
      if (!note) fail(400, 'Say why it’s being withdrawn; the studio sees this.');
      db.setWithdrawn(r.id, actor(u), note);
      db.audit(actor(u), 'release.withdraw', target, { note });
    }
    return c.json({ ok: true });
  });

  // Studio admins and Vault staff: delete a game from Vault (its staging and production files, then its records).
  // Body: { confirm } must be the game's slug.
  app.post('/portal/api/s/:studio/g/:game/delete', async (c) => {
    const u = apiUser(c);
    const { studio, game } = apiStudioGame(c, u);
    if (!canDeleteGame(u, studio)) fail(403, 'Only studio admins and Vault staff can delete games.');
    const b = await jsonBody(c);
    if (typeof b.confirm !== 'string' || b.confirm.trim() !== game.slug) fail(400, `Type ${game.slug} to confirm.`);
    const prefix = `${studio.slug}/${game.slug}/`;
    const staged = (await deps.staging.list(prefix)).map((o) => o.key);
    if (staged.length) await deps.staging.deleteKeys(staged);
    const released = deps.production ? (await deps.production.list(prefix)).map((o) => o.key) : [];
    if (released.length) await deps.production!.deleteKeys(released);
    const releases = db.releases(game.id).length;
    db.deleteGame(game.id);
    db.audit(actor(u), 'game.delete', prefix, { repository: game.repository, releases, stagingFiles: staged.length, productionFiles: released.length });
    return c.json({ ok: true });
  });

  // Vault: freeze a game so only Vault can switch its current release (e.g. during a study). Body: { frozen, note }
  app.post('/portal/api/s/:studio/g/:game/freeze', async (c) => {
    const u = apiUser(c);
    if (!canRelease(u)) fail(403, 'Only Vault release managers can freeze games.');
    const { studio, game } = apiStudioGame(c, u);
    const b = await jsonBody(c);
    const target = `${studio.slug}/${game.slug}/`;
    if (b.frozen) {
      const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
      if (!note) fail(400, 'Say why it’s frozen; the studio sees this.');
      db.setFrozen(game.id, actor(u), note);
      db.audit(actor(u), 'game.freeze', target, { note });
    } else {
      db.setFrozen(game.id, null, null);
      db.audit(actor(u), 'game.unfreeze', target);
    }
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/g/:game/request', async (c) => {
    const u = apiUser(c);
    const { studio, game } = apiStudioGame(c, u);
    if (!canRequest(u, studio)) fail(403, 'Only maintainers can request releases.');
    const b = await jsonBody(c);
    const version = versionOf(b.version), ref = refOf(b.ref);
    const build = db.build(game.id, ref);
    if (!build || build.status !== 'live') fail(404, `${ref} isn’t on staging.`);
    if (db.release(game.id, version)) fail(409, `${version} has already been released; choose a new version name.`);
    if (db.releaseRequests({ gameId: game.id, status: 'requested' }).some((r) => r.version === version)) fail(409, `There’s already an open request for ${version}.`);
    const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim().slice(0, 2000) : null;
    const r = db.createReleaseRequest({ game_id: game.id, ref, version, notes, requested_by: actor(u) });
    db.audit(actor(u), 'release.request', `${studio.slug}/${game.slug}/${version}`, { ref });
    return c.json({ ok: true, id: r.id });
  });

  function requestFor(c: Context, u: User) {
    const r = db.releaseRequest(Number(c.req.param('id')));
    if (!r) fail(404, 'unknown request');
    const g = db.gameById(r.game_id)!, s = db.studioById(g.studio_id)!;
    if (!canView(u, s)) fail(404, 'unknown request');
    if (r.status !== 'requested') fail(409, 'This request has already been decided.');
    return { r, g, s };
  }

  app.post('/portal/api/requests/:id/approve', async (c) => {
    const u = apiUser(c);
    if (!canRelease(u)) fail(403, 'Only Vault release managers can approve.');
    const { r, g, s } = requestFor(c, u);
    const b = await jsonBody(c);
    await deps.approveRelease(s, g, r.version, r.ref, actor(u));
    if (b.makeCurrent) await deps.promoteRelease(s, g, r.version, actor(u));
    db.decideReleaseRequest(r.id, 'approved', actor(u), null);
    return c.json({ ok: true });
  });

  app.post('/portal/api/requests/:id/reject', async (c) => {
    const u = apiUser(c);
    if (!canRelease(u)) fail(403, 'Only Vault release managers can send requests back.');
    const { r, g, s } = requestFor(c, u);
    const b = await jsonBody(c);
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) : '';
    if (!note) fail(400, 'Say why it’s being sent back.');
    db.decideReleaseRequest(r.id, 'rejected', actor(u), note);
    db.audit(actor(u), 'release.reject', `${s.slug}/${g.slug}/${r.version}`, { note });
    return c.json({ ok: true });
  });

  app.post('/portal/api/requests/:id/withdraw', async (c) => {
    const u = apiUser(c);
    const { r, g, s } = requestFor(c, u);
    if (r.requested_by !== actor(u) && !canManageMembers(u, s)) fail(403, 'Only the requester or a studio admin can withdraw this.');
    db.decideReleaseRequest(r.id, 'withdrawn', actor(u), null);
    db.audit(actor(u), 'release.withdraw', `${s.slug}/${g.slug}/${r.version}`);
    return c.json({ ok: true });
  });

  // A studio's website, which the catalog publishes. Body: { website } ('' clears it).
  app.post('/portal/api/s/:studio/website', async (c) => {
    const u = apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !canManageMembers(u, s)) fail(403, 'Only studio admins can change the studio’s website.');
    let website: string | null;
    try { website = studioWebsite((await jsonBody(c)).website); } catch (err) { fail(400, (err as Error).message); }
    if ((s.website || null) !== website) {
      db.setStudioWebsite(s.id, website);
      db.audit(actor(u), 'studio.website', s.slug, { from: s.website || null, to: website });
    }
    return c.json({ ok: true, website });
  });

  registerListingPages(app, listingHelpers);
  registerFeaturedApi(app, listingHelpers);
  registerSiteChecks(app, listingHelpers);
  registerListingAssetsApi(app, listingHelpers);
  registerListingPreview(app, listingHelpers);
  registerListingMakers(app, listingHelpers);
  registerImageMigration(app, listingHelpers);
  registerPeople(app, { ...listingHelpers, canManageMembers, vaultAdmins: cfg.vaultAdmins, githubAccount: cfg.githubAccount ?? githubAccount, githubRepository: cfg.githubRepository ?? githubRepository });
}
