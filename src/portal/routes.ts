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
import type { Build, Game, Membership, Release, StudioRole, Studio, User, VaultRole } from '../db.ts';
import { isVersionName, sanitizeRefName } from '../paths.ts';
import { escape, html, raw, type Html } from './html.ts';
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
  // Public base URL of this service, used for the OAuth callback (e.g. https://…run.app).
  baseUrl: string;
  // GitHub logins that become Vault admins when they sign in (bootstrap).
  vaultAdmins: string[];
  oauth?: OAuthClient; // injected in tests
}

type ReleaseResult = { release: Release; url: string };
type PromoteResult = { current: string; previous: string | null; rollback: boolean; url: string };
export interface PortalDeps extends AppDeps {
  approveRelease(studio: Studio, game: Game, version: string, ref: string | undefined, actor: string): Promise<ReleaseResult>;
  promoteRelease(studio: Studio, game: Game, version: string, actor: string): Promise<PromoteResult>;
  previewUrl(studio: Studio, game: Game, ref: string): string;
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
const ROLE_LABEL: Record<StudioRole, string> = { viewer: 'Viewer', maintainer: 'Maintainer', admin: 'Studio admin' };
const VAULT_LABEL: Record<VaultRole, string> = { none: '—', release_manager: 'Release manager', admin: 'Vault admin' };
function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} days ago`;
  return iso.slice(0, 10);
}
const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const who = (actor: string) => actor.replace(/^(github|user):/, '');
const pill = (kind: 'ok' | 'run' | 'bad' | 'wait' | 'off' | 'brass', text: string) => html`<span class="pill p-${kind}">${text}</span>`;

// ---------- page layout ----------
// Content hashes of portal.css/js, so a deploy changes their URLs and browsers never use stale copies.
let assetVersion = 'dev';
interface Nav { user: User; studio?: Studio; memberships: (Membership & { studio_slug: string; studio_name: string })[]; allStudios: Studio[] }
function layout(title: string, nav: Nav | null, body: Html | string, active = ''): string {
  const u = nav?.user;
  const staff = u && u.vault_role !== 'none';
  const studios = staff ? nav!.allStudios.map((s) => ({ slug: s.slug, name: s.name })) : (nav?.memberships ?? []).map((m) => ({ slug: m.studio_slug, name: m.studio_name }));
  const cur = nav?.studio;
  const side = nav ? html`
    <aside class="side" aria-label="Portal navigation">
      <a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Vault</a>
      ${studios.length ? html`<label class="studio-sw"><span>Studio</span>
        <select onchange="location.href='/s/'+this.value" aria-label="Studio">
          ${cur ? '' : html`<option value="">Choose…</option>`}
          ${studios.map((s) => html`<option value="${s.slug}" ${cur?.slug === s.slug ? 'selected' : ''}>${s.name}</option>`)}
        </select></label>` : ''}
      <nav class="nav">
        ${cur ? html`
          <a href="/s/${cur.slug}" class="${active === 'studio' ? 'on' : ''}">Games</a>
          <a href="/s/${cur.slug}/register" class="${active === 'register' ? 'on' : ''}">Register a game</a>
          <a href="/s/${cur.slug}/members" class="${active === 'members' ? 'on' : ''}">Members</a>` : ''}
        ${staff ? html`
          <div class="nav-sep">Vault</div>
          <a href="/vault" class="${active === 'vault' ? 'on' : ''}">Release requests</a>
          <a href="/vault/people" class="${active === 'people' ? 'on' : ''}">People</a>
          <a href="/vault/activity" class="${active === 'activity' ? 'on' : ''}">Activity</a>` : ''}
      </nav>
      <div class="side-foot">
        <div class="me">${u!.avatar_url ? html`<img src="${u!.avatar_url}&s=48" alt="" width="24" height="24">` : ''}<span><b>${u!.login}</b>${staff ? html`<br><span class="muted">${VAULT_LABEL[u!.vault_role]}</span>` : ''}</span></div>
        <form method="post" action="/logout"><button class="btn sm" type="submit">Sign out</button></form>
      </div>
    </aside>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escape(title)} · Vault Studio Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/portal.css?v=${assetVersion}"></head><body>
<div class="${nav ? 'shell' : 'shell solo'}">${side}<main id="main">${body}</main></div>
<script src="/assets/portal.js?v=${assetVersion}" defer></script></body></html>`;
}

const head = (title: string | Html, sub?: string | Html, actions?: Html | string, crumbs?: Html) => html`
  ${crumbs ? html`<div class="crumbs">${crumbs}</div>` : ''}
  <div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;

// ---------- registration snippets ----------
const SNIPPETS = {
  unity: (studio: string, game: string) => `# .github/workflows/vault.yml
name: Vault
on: { push: {}, delete: {}, workflow_dispatch: {} }
permissions: { contents: read, id-token: write }
jobs:
  build:
    if: github.event_name != 'delete'
    uses: fielddaylab/vault-publisher/.github/workflows/unity-build.yml@v1
    secrets: inherit          # UNITY_EMAIL, UNITY_PASSWORD, UNITY_SERIAL
  preview:
    needs: build
    uses: fielddaylab/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: ${game}, artifact: "\${{ needs.build.outputs.artifact }}" }
  remove-preview:
    if: github.event_name == 'delete'
    uses: fielddaylab/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: ${game} }
# Publishes every branch and tag to https://cdn.vaultlearninggames-staging.org/${studio}/${game}/<branch>/`,
  committed: (studio: string, game: string) => `# .github/workflows/vault.yml
name: Vault
on: { push: {}, delete: {}, workflow_dispatch: {} }
permissions: { contents: read, id-token: write }
jobs:
  preview:
    uses: fielddaylab/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: ${game}, path: WebGL }   # the folder that contains index.html
# Publishes every branch and tag to https://cdn.vaultlearninggames-staging.org/${studio}/${game}/<branch>/`,
  action: (studio: string, game: string) => `# In an existing workflow, after your own build step:
    permissions: { contents: read, id-token: write }
    steps:
      # ... your build writes the web build to ./dist ...
      - uses: fielddaylab/vault-publisher/action@v1
        with:
          game: ${game}
          path: dist
          publisher-url: \${{ vars.VAULT_PUBLISHER_URL }}
# Publishes to https://cdn.vaultlearninggames-staging.org/${studio}/${game}/<branch>/`,
};

export function registerPortal(app: Hono, deps: PortalDeps) {
  const { db } = deps;
  const cfg = deps.portal;
  const configured = !!(cfg.sessionSecret && (cfg.oauth || (cfg.githubClientId && cfg.githubClientSecret)));
  const oauth = cfg.oauth ?? (cfg.githubClientId && cfg.githubClientSecret ? githubOAuth(cfg.githubClientId, cfg.githubClientSecret) : null);
  const callbackUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/auth/callback`;
  const secure = cfg.baseUrl.startsWith('https://');
  const admins = new Set(cfg.vaultAdmins.map((l) => l.toLowerCase()));

  // Static assets, read once at startup.
  const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)));
  const css = asset('portal.css'), js = asset('portal.js');
  assetVersion = createHash('sha256').update(css).update(js).digest('hex').slice(0, 10);
  const immutable = 'public, max-age=31536000, immutable';
  app.get('/assets/portal.css', (c) => c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': immutable }));
  app.get('/assets/portal.js', (c) => c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': immutable }));

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
  const canManageMembers = (u: User, s: Studio) => isVaultAdmin(u) || roleIn(u, s) === 'admin';
  const navFor = (u: User, studio?: Studio): Nav => ({ user: u, studio, memberships: db.membershipsForLogin(u.login), allStudios: db.studios() });
  const actor = (u: User) => `user:${u.login}`;

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
    return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
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
      <div class="brand big"><span class="mark" aria-hidden="true"></span>Vault</div>
      <h1>Studio Portal</h1>
      <p>Publish your games to classrooms. Your studio controls testing on staging; Vault reviews every release.</p>
      ${configured
        ? html`<a class="btn pri big" href="/auth/github?next=${encodeURIComponent(next)}">Sign in with GitHub</a>
               <p class="small muted">We only read your GitHub name and picture.</p>`
        : html`<p class="fix">Sign-in isn’t set up yet: the GitHub OAuth app and session secret are missing.</p>`}
      ${c.req.query('error') ? html`<p class="err">${c.req.query('error')}</p>` : ''}
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
    const games = db.gamesForStudio(s.id);
    let live = 0, released = 0;
    const openRequests = db.releaseRequests({ status: 'requested' }).filter((r) => r.studio_slug === s.slug);
    const rows = games.map((g) => {
      const builds = db.liveBuilds(g.id);
      live += builds.length;
      const cur = db.currentRelease(g.id);
      if (cur) released++;
      const shown = builds.slice(0, 4);
      return html`<tr>
        <td class="proj"><a href="/s/${s.slug}/g/${g.slug}"><b>${g.slug}</b></a><span><a class="muted" href="https://github.com/${g.repository}">${g.repository}</a></span></td>
        <td>${builds.length ? html`<div class="refs">${shown.map((b) => html`<a class="ref-chip ${b.ref_type}" href="${deps.previewUrl(s, g, b.ref_name)}" title="${b.ref_type} · ${ago(b.updated_at)}">${b.ref_name}</a>`)}${builds.length > shown.length ? html`<span class="muted small">+${builds.length - shown.length}</span>` : ''}</div>` : html`<span class="muted small">No test versions</span>`}</td>
        <td>${cur ? html`<span class="rel">${cur.version}</span> <span class="muted small">${ago(cur.approved_at)}</span>` : html`<span class="muted small">Not released</span>`}</td>
        <td class="r small">${builds[0] ? ago(builds[0].updated_at) : '—'}</td></tr>`;
    });
    const body = html`${head(s.name, html`Games on Vault. <b>Staging</b> is yours to test on; <b>production</b> is what classrooms play, released by Vault.`,
      html`<a class="btn" href="/s/${s.slug}/register">Register a game</a>`)}
      <div class="kpis four">
        <div class="kpi"><div class="v">${games.length}</div><div class="l">Games</div></div>
        <div class="kpi"><div class="v">${live}</div><div class="l">Test versions on staging</div></div>
        <div class="kpi"><div class="v">${released}</div><div class="l">Live for classrooms</div></div>
        <div class="kpi"><div class="v">${openRequests.length}</div><div class="l">Release requests open</div></div>
      </div>
      ${games.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th>Staging (testing)</th><th>Production (classrooms)</th><th class="r">Last build</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<div class="card"><p>No games yet. <a href="/s/${s.slug}/register">Register your first game</a>: it appears here after its first build.</p></div>`}`;
    return page(c, s.name, body, { studio: s, active: 'studio' });
  });

  // ---------- game page ----------
  app.get('/s/:studio/g/:game', (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    const s = studioFor(c, u); if (s instanceof Response) return s;
    const g = db.game(s.id, c.req.param('game'));
    if (!g) return denied(c, 'That game doesn’t exist.', 404);
    const builds = db.liveBuilds(g.id);
    const releases = db.releases(g.id);
    const cur = db.currentRelease(g.id);
    const requests = db.releaseRequests({ gameId: g.id });
    const release = canRelease(u), request = canRequest(u, s);
    const stable = `${deps.prodPublicUrl}/${s.slug}/${g.slug}/`;
    const api = `/portal/api/s/${s.slug}/g/${g.slug}`;
    const buildRows = builds.map((b: Build) => html`<tr>
      <td><span class="mono">${b.ref_name}</span> <span class="tag">${b.ref_type}</span></td>
      <td class="small"><a class="mono" href="https://github.com/${g.repository}/commit/${b.commit_sha}">${b.commit_sha.slice(0, 7)}</a></td>
      <td class="small num">${b.file_count} files · ${mb(b.total_bytes)}</td>
      <td class="small">${ago(b.updated_at)}<br><span class="muted">by ${b.actor}</span></td>
      <td class="small"><a href="${deps.previewUrl(s, g, b.ref_name)}" target="_blank" rel="noopener">Play ↗</a></td>
      <td class="r">${release
        ? html`<button class="btn sm brass" data-open="release" data-ref="${b.ref_name}" data-type="${b.ref_type}">Release…</button>`
        : request ? html`<button class="btn sm" data-open="request" data-ref="${b.ref_name}" data-type="${b.ref_type}">Request release…</button>` : ''}</td></tr>`);
    const relRows = releases.map((r) => {
      const isCur = cur?.id === r.id;
      return html`<tr>
        <td class="mono">${r.version}</td>
        <td>${isCur ? pill('brass', '★ Current') : pill('off', 'Previous')}</td>
        <td class="small">from <span class="mono">${r.source_ref}</span>${r.commit_sha ? html` · <a class="mono" href="https://github.com/${g.repository}/commit/${r.commit_sha}">${r.commit_sha.slice(0, 7)}</a>` : ''}</td>
        <td class="small">${r.approved_at.slice(0, 10)} · ${who(r.approved_by)}</td>
        <td class="small"><a href="${deps.prodPublicUrl}/${s.slug}/${g.slug}/${r.version}/" target="_blank" rel="noopener">Play ↗</a></td>
        <td class="r">${release && !isCur ? html`<form data-api="${api}/promote" data-confirm="${cur && cur.id > r.id ? `Roll ${g.slug} back to ${r.version}? Classrooms get it immediately.` : `Make ${r.version} the version classrooms get?`}">
          <input type="hidden" name="version" value="${r.version}"><button class="btn sm">${cur && cur.id > r.id ? 'Roll back to this' : 'Make current'}</button><span class="err"></span></form>` : ''}</td></tr>`;
    });
    const reqRows = requests.map((r) => html`<tr>
      <td class="mono">${r.version}</td><td class="small">from <span class="mono">${r.ref}</span></td>
      <td>${r.status === 'requested' ? pill('wait', 'Waiting for Vault') : r.status === 'approved' ? pill('ok', 'Approved') : r.status === 'rejected' ? pill('bad', 'Sent back') : pill('off', 'Withdrawn')}</td>
      <td class="small">${who(r.requested_by)} · ${ago(r.created_at)}${r.notes ? html`<br><span class="muted">“${r.notes}”</span>` : ''}${r.decision_note ? html`<br><span class="muted">Vault: “${r.decision_note}”</span>` : ''}</td>
      <td class="r">${r.status === 'requested' && release ? html`<a class="btn sm" href="/vault#req-${r.id}">Review</a>` : ''}
        ${r.status === 'requested' && (r.requested_by === actor(u) || canManageMembers(u, s)) ? html`<form data-api="/portal/api/requests/${r.id}/withdraw" data-confirm="Withdraw this request?"><button class="btn sm">Withdraw</button><span class="err"></span></form>` : ''}</td></tr>`);
    const body = html`${head(g.slug, html`<a href="https://github.com/${g.repository}">${g.repository}</a> · classrooms play <a href="${stable}" target="_blank" rel="noopener">${stable}</a>`, '', html`<a href="/s/${s.slug}">${s.name}</a> / ${g.slug}`)}
      <div class="grid g-main">
        <div class="grid">
          <div class="card"><h2>Staging · test versions <small>every branch and tag your builds publish · kept 90 days after the last push</small></h2>
            ${builds.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Version</th><th>Commit</th><th>Size</th><th>Published</th><th>Preview</th><th></th></tr></thead><tbody>${buildRows}</tbody></table></div>`
              : html`<p class="muted">Nothing on staging yet. Push to a branch once the workflow is in place (<a href="/s/${s.slug}/register">instructions</a>).</p>`}</div>
          <div class="card"><h2>Production · released versions <small>immutable; only Vault can release, promote or roll back</small></h2>
            ${releases.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Release</th><th>Status</th><th>Built from</th><th>Approved</th><th>Link</th><th></th></tr></thead><tbody>${relRows}</tbody></table></div>`
              : html`<p class="muted">Nothing released yet.${request ? ' Choose “Request release” on a test version above.' : ''}</p>`}</div>
          ${requests.length ? html`<div class="card"><h2>Release requests</h2><div class="tbl-wrap"><table><thead><tr><th>Version</th><th>Build</th><th>Status</th><th>Requested</th><th></th></tr></thead><tbody>${reqRows}</tbody></table></div></div>` : ''}
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><h2>Live for classrooms</h2>${cur ? html`<div class="big-rel">${cur.version}</div><p class="small muted">approved ${cur.approved_at.slice(0, 10)} by ${who(cur.approved_by)}</p>` : html`<p class="muted">Nothing yet.</p>`}
            <p class="small">Stable link (always the current release):<br><a class="mono" href="${stable}" target="_blank" rel="noopener">${stable}</a></p></div>
          <div class="card small"><h2>How releasing works</h2><ol class="tight">
            <li>Push a version tag (e.g. <code>v1.2</code>); it appears above as a test version.</li>
            <li>Test it on staging, then ${release ? html`choose <b>Release…</b>` : request ? html`choose <b>Request release…</b>` : 'a maintainer requests a release'}.</li>
            <li>Vault copies that exact build to production and makes it current. Earlier releases stay available for rollback.</li></ol></div>
        </div>
      </div>
      ${release ? html`<dialog id="release"><form data-api="${api}/release" class="dlg" data-then="reload">
        <h2>Release to classrooms</h2>
        <p class="small">Copies the staging build <b class="mono" data-fill="ref"></b> to production. A version name can be used only once.</p>
        <input type="hidden" name="ref">
        <label class="field"><span class="lab">Version name</span><input name="version" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" placeholder="v1.2"><span class="hint">Shown to Vault and in the release history.</span></label>
        <label class="check"><input type="checkbox" name="makeCurrent" checked> Make it the version classrooms get now</label>
        <p class="warn-branch small" hidden>This is a branch, not a tag, so it may change after you test it. A tag is safer.</p>
        <div class="dlg-foot"><span class="err"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn brass">Release</button></div>
      </form></dialog>` : ''}
      ${request && !release ? html`<dialog id="request"><form data-api="${api}/request" class="dlg" data-then="reload">
        <h2>Request a release</h2>
        <p class="small">Asks Vault to test <b class="mono" data-fill="ref"></b> and release it to classrooms.</p>
        <input type="hidden" name="ref">
        <label class="field"><span class="lab">Version name</span><input name="version" required pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" placeholder="v1.2"></label>
        <label class="field"><span class="lab">Notes for Vault</span><textarea name="notes" placeholder="What changed, what to check"></textarea></label>
        <div class="dlg-foot"><span class="err"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn pri">Send request</button></div>
      </form></dialog>` : ''}`;
    return page(c, g.slug, body, { studio: s, active: 'studio' });
  });

  // ---------- register instructions ----------
  app.get('/s/:studio/register', (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    const s = studioFor(c, u); if (s instanceof Response) return s;
    const snippets = JSON.stringify({ unity: SNIPPETS.unity(s.slug, 'GAME'), committed: SNIPPETS.committed(s.slug, 'GAME'), action: SNIPPETS.action(s.slug, 'GAME') });
    const body = html`${head('Register a game', html`A game registers itself the first time its repository publishes to Vault. Pick how it builds, name it, and add one workflow file.`, '', html`<a href="/s/${s.slug}">${s.name}</a> / Register`)}
      <div class="grid g-main"><div class="grid">
        <div class="card">
          <h2>1. Name it and choose how it builds</h2>
          <div class="fields">
            <label class="field"><span class="lab">Game name (web address)</span><input id="reg-game" value="my-game" autocomplete="off" pattern="[a-z0-9-]+"><span class="hint">Lowercase letters, numbers and dashes. Becomes <span class="mono">…/${s.slug}/<b id="reg-echo">my-game</b>/</span>. The first repository to publish it owns it.</span></label>
            <div class="field"><span class="lab">How it builds</span>
              <label class="check"><input type="radio" name="reg-kind" value="unity" checked> Unity, built in GitHub Actions</label>
              <label class="check"><input type="radio" name="reg-kind" value="committed"> The web build is committed to the repo</label>
              <label class="check"><input type="radio" name="reg-kind" value="action"> Our own build (npm, etc.) in GitHub Actions</label></div>
          </div>
        </div>
        <div class="card"><h2>2. Add this file to the repository <button class="btn sm" id="reg-copy" type="button">Copy</button></h2>
          <pre class="code" id="reg-snippet"></pre>
          <ul class="small tight">
            <li><b>Unity:</b> add the Unity licence as repository or organization secrets <code>UNITY_EMAIL</code>, <code>UNITY_PASSWORD</code>, <code>UNITY_SERIAL</code>.</li>
            <li>The organization variable <code>VAULT_PUBLISHER_URL</code> must be visible to the repository (public repositories on free GitHub plans).</li>
            ${s.slug === 'fieldday' ? html`<li><b>Field Day framework:</b> don’t use “preview” or “milestone” in branch names yet; they select a build configuration that currently fails to compile.</li>` : ''}
            <li>Your GitHub organization must be registered with Vault. ${s.github_owner ? html`This studio publishes from <b>github.com/${s.github_owner}</b>.` : html`<b>This studio has no GitHub organization registered yet; ask Vault.</b>`}</li>
          </ul></div>
        <div class="card"><h2>3. Push</h2>
          <p>Every push to a branch or tag builds and publishes a test version to <span class="mono">https://cdn.vaultlearninggames-staging.org/${s.slug}/GAME/BRANCH/</span>. The game then appears under <a href="/s/${s.slug}">Games</a>. Deleting a branch removes its test version.</p>
          <p>When a version is ready for classrooms, push a version tag, test it on staging, and choose <b>Request release</b> on the game’s page.</p></div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card small"><h2>No GitHub?</h2><p>Zip upload is coming. Until then, Vault can import a build for you: ask your Vault contact.</p></div>
        <div class="card small"><h2>What’s where</h2><ul class="tight">
          <li><b>Staging</b>: every branch and tag, for your team and playtesters. Not indexed by search engines.</li>
          <li><b>Production</b>: <span class="mono">cdn.vaultlearninggames.org/${s.slug}/GAME/</span>, only builds Vault has released.</li></ul></div>
      </div></div>
      <script type="application/json" id="reg-data">${raw(snippets.replace(/</g, '\\u003c'))}</script>`;
    return page(c, 'Register a game', body, { studio: s, active: 'register' });
  });

  // ---------- members ----------
  app.get('/s/:studio/members', (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    const s = studioFor(c, u); if (s instanceof Response) return s;
    const manage = canManageMembers(u, s);
    const api = `/portal/api/s/${s.slug}/members`;
    const users = new Map(db.users().map((x) => [x.login.toLowerCase(), x]));
    const rows = db.memberships(s.id).map((m) => {
      const known = users.get(m.github_login.toLowerCase());
      return html`<tr>
        <td class="proj"><b>${m.github_login}</b><span>${known ? (known.name || 'signed in ' + ago(known.last_login_at)) : 'hasn’t signed in yet'}</span></td>
        <td>${manage ? html`<form data-api="${api}" data-autosubmit><input type="hidden" name="login" value="${m.github_login}"><select name="role" aria-label="Role for ${m.github_login}">${(['viewer', 'maintainer', 'admin'] as StudioRole[]).map((r) => html`<option value="${r}" ${r === m.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`)}</select><span class="err"></span></form>` : ROLE_LABEL[m.role]}</td>
        <td class="small">${who(m.added_by)} · ${m.created_at.slice(0, 10)}</td>
        <td class="r">${manage ? html`<form data-api="${api}/remove" data-confirm="Remove ${m.github_login} from ${s.name}?"><input type="hidden" name="login" value="${m.github_login}"><button class="btn sm">Remove</button><span class="err"></span></form>` : ''}</td></tr>`;
    });
    const body = html`${head('Members', `People who can see ${s.name}’s games. They sign in with GitHub.`, '', html`<a href="/s/${s.slug}">${s.name}</a> / Members`)}
      <div class="grid g-main"><div class="grid">
        <div class="tbl-wrap"><table><thead><tr><th>GitHub user</th><th>Role</th><th>Added</th><th></th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="4" class="muted">No members yet.</td></tr>`}</tbody></table></div>
        ${manage ? html`<div class="card"><h2>Add someone</h2><form data-api="${api}" data-then="reload" class="inline-form">
          <label class="field"><span class="lab">GitHub username</span><input name="login" required autocomplete="off" placeholder="octocat"></label>
          <label class="field"><span class="lab">Role</span><select name="role"><option value="viewer">Viewer</option><option value="maintainer" selected>Maintainer</option><option value="admin">Studio admin</option></select></label>
          <button class="btn pri">Add</button><span class="err"></span></form>
          <p class="small muted">They can sign in right away; nothing is emailed.</p></div>` : ''}
      </div>
      <div class="card small" style="align-self:start"><h2>Roles</h2><ul class="tight">
        <li><b>Viewer</b>: sees the studio’s games, test versions and releases.</li>
        <li><b>Maintainer</b>: also requests releases.</li>
        <li><b>Studio admin</b>: also manages members.</li>
        <li><b>Vault staff</b> release, promote and roll back.</li></ul></div></div>`;
    return page(c, 'Members', body, { studio: s, active: 'members' });
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
          <form data-api="/portal/api/requests/${r.id}/approve" data-then="reload" data-confirm="Release ${g.slug} ${r.version} to production?"><label class="check"><input type="checkbox" name="makeCurrent" checked> Make it current</label><button class="btn brass">Approve and release</button><span class="err"></span></form>
          <form data-api="/portal/api/requests/${r.id}/reject" data-then="reload" class="inline-form"><input name="note" placeholder="Why it’s being sent back" required aria-label="Reason"><button class="btn">Send back</button><span class="err"></span></form>
        </div>` : ''}</div>`;
    });
    const hist = decided.map((r) => html`<tr><td>${r.studio_slug}/${r.game_slug}</td><td class="mono">${r.version}</td><td>${r.status === 'approved' ? pill('ok', 'Approved') : r.status === 'rejected' ? pill('bad', 'Sent back') : pill('off', 'Withdrawn')}</td><td class="small">${r.decided_by ? who(r.decided_by) : '—'} · ${ago(r.decided_at)}</td></tr>`);
    const body = html`${head('Release requests', 'Studios ask for releases here. Test the staging build before approving; approval copies that exact build to production.')}
      ${open.length ? cards : html`<div class="card"><p class="muted">No open requests.</p></div>`}
      ${hist.length ? html`<h3 class="sec">Recently decided</h3><div class="tbl-wrap"><table><thead><tr><th>Game</th><th>Version</th><th>Decision</th><th>By</th></tr></thead><tbody>${hist}</tbody></table></div>` : ''}`;
    return page(c, 'Release requests', body, { active: 'vault' });
  });

  app.get('/vault/people', (c) => {
    const u = signedIn(c); if (u instanceof Response) return u;
    if (!isStaff(u)) return denied(c, 'Only Vault staff can see this page.');
    const admin = isVaultAdmin(u);
    const rows = db.users().map((x) => {
      const studios = db.membershipsForLogin(x.login).map((m) => `${m.studio_slug} (${ROLE_LABEL[m.role]})`).join(', ');
      return html`<tr><td class="proj"><b>${x.login}</b><span>${x.name ?? ''}</span></td><td class="small">${studios || '—'}</td>
        <td>${admin && x.id !== u.id ? html`<form data-api="/portal/api/vault/users/${x.id}/role" data-autosubmit><select name="role" aria-label="Vault role for ${x.login}">${(['none', 'release_manager', 'admin'] as VaultRole[]).map((r) => html`<option value="${r}" ${r === x.vault_role ? 'selected' : ''}>${r === 'none' ? 'No Vault role' : VAULT_LABEL[r]}</option>`)}</select><span class="err"></span></form>` : VAULT_LABEL[x.vault_role]}</td>
        <td class="small">${ago(x.last_login_at)}</td></tr>`;
    });
    const body = html`${head('People', 'Everyone who has signed in. Vault roles are for Vault staff; studio roles are managed on each studio’s Members page.')}
      <div class="tbl-wrap"><table><thead><tr><th>GitHub user</th><th>Studios</th><th>Vault role</th><th>Last sign-in</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="small muted">Release managers release, promote and roll back. Vault admins also manage people and every studio’s members. ${cfg.vaultAdmins.length ? `Always admins: ${cfg.vaultAdmins.join(', ')}.` : ''}</p>`;
    return page(c, 'People', body, { active: 'people' });
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
    if (!canRelease(u)) fail(403, 'Only Vault release managers can change the current release.');
    const { studio, game } = apiStudioGame(c, u);
    return c.json({ ok: true, ...(await deps.promoteRelease(studio, game, versionOf((await jsonBody(c)).version), actor(u))) });
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

  app.post('/portal/api/s/:studio/members', async (c) => {
    const u = apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !canManageMembers(u, s)) fail(403, 'Only studio admins can manage members.');
    const b = await jsonBody(c);
    const login = typeof b.login === 'string' ? b.login.trim().replace(/^@/, '') : '';
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) fail(400, 'That isn’t a valid GitHub username.');
    if (!['viewer', 'maintainer', 'admin'].includes(b.role as string)) fail(400, 'Choose a role.');
    if (login.toLowerCase() === u.login.toLowerCase() && b.role !== 'admin' && !isVaultAdmin(u)) fail(400, 'You can’t lower your own role; ask another admin.');
    db.setMembership(s.id, login, b.role as StudioRole, actor(u));
    db.audit(actor(u), 'member.set', `${s.slug}:${login}`, { role: b.role });
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/members/remove', async (c) => {
    const u = apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !canManageMembers(u, s)) fail(403, 'Only studio admins can manage members.');
    const login = String((await jsonBody(c)).login ?? '');
    if (login.toLowerCase() === u.login.toLowerCase() && !isVaultAdmin(u)) fail(400, 'You can’t remove yourself; ask another admin.');
    db.removeMembership(s.id, login);
    db.audit(actor(u), 'member.remove', `${s.slug}:${login}`);
    return c.json({ ok: true });
  });

  app.post('/portal/api/vault/users/:id/role', async (c) => {
    const u = apiUser(c);
    if (!isVaultAdmin(u)) fail(403, 'Only Vault admins can change Vault roles.');
    const target = db.userById(Number(c.req.param('id')));
    if (!target) fail(404, 'unknown user');
    if (target.id === u.id) fail(400, 'You can’t change your own Vault role.');
    const role = (await jsonBody(c)).role;
    if (!['none', 'release_manager', 'admin'].includes(role as string)) fail(400, 'Choose a role.');
    db.setVaultRole(target.id, role as VaultRole);
    db.audit(actor(u), 'vault.role', target.login, { role });
    return c.json({ ok: true });
  });

}
