// People and studios: each studio's Members page (studio.maintain_users and vault.users.maintain manage it), Vault's
// People page (vault.users.maintain: everyone, their Vault permissions and every membership) and Vault's Studios page (creating studios and editing their name, website and GitHub organization).
// Memberships are keyed by GitHub username, so people can be added before they first sign in: until then they show as
// "invited", and the membership takes effect the first time they sign in with GitHub.
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { REPOSITORY_ID, REPOSITORY_NAME, studioGithubOrg, studioWebsite, StudioNotEmptyError, type Db, type Studio, type StudioSource, type User } from '../db.ts';
import {
  impliedStudioPermissions, normalizeStudioPermissions, normalizeVaultPermissions, PermissionError, permissionsFromBody, STUDIO_PERMISSION_HINT,
  STUDIO_PERMISSION_LABEL, STUDIO_PERMISSIONS, VAULT_PERMISSION_HINT, VAULT_PERMISSION_LABEL, VAULT_PERMISSIONS, type StudioPermission, type VaultPermission,
} from '../permissions.ts';
import { slugify } from '../listings-import.ts';
import { isSlug } from '../paths.ts';
import { html, type Html } from './html.ts';
import { ago, head, pill, studioPermissionText, who } from './routes.ts';

export interface GitHubAccount { id: string; login: string }
// Resolves a GitHub organization (or user) to its numeric id; null if GitHub has no such account.
export type GitHubAccountLookup = (login: string) => Promise<GitHubAccount | null>;

// Unauthenticated GitHub API (60 requests an hour per address), which is plenty for creating studios by hand.
// Organizations first; a studio can also publish from a personal account.
export const githubAccount: GitHubAccountLookup = async (login) => {
  for (const kind of ['orgs', 'users']) {
    const r = await fetch(`https://api.github.com/${kind}/${encodeURIComponent(login)}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vault-portal' },
    });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
    const j = (await r.json()) as { id?: number; login?: string };
    if (j.id && j.login) return { id: String(j.id), login: j.login };
  }
  return null;
};

export interface GitHubRepository { id: string; name: string }
// Resolves "owner/name" to GitHub's numeric repository id; null if GitHub shows no such repository (which is also
// what it answers for a private one).
export type GitHubRepositoryLookup = (name: string) => Promise<GitHubRepository | null>;

// Unauthenticated, like githubAccount, so it only sees public repositories.
export const githubRepository: GitHubRepositoryLookup = async (name) => {
  const r = await fetch(`https://api.github.com/repos/${name.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vault-portal' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}`);
  const j = (await r.json()) as { id?: number; full_name?: string };
  return j.id && j.full_name ? { id: String(j.id), name: j.full_name } : null;
};

interface Helpers {
  db: Db;
  page(c: Context, title: string, body: Html, opts?: { studio?: Studio; active?: string; status?: number }): Response | Promise<Response>;
  denied(c: Context, message: string, status?: number): Response | Promise<Response>;
  signedIn(c: Context): User | Response;
  studioFor(c: Context, u: User): Studio | Response;
  apiUser(c: Context): User;
  actor(u: User): string;
  isStaff(u: User): boolean;
  isMember(u: User, s: Studio): boolean;
  vaultCan(u: User, p: VaultPermission): boolean;
  studioCan(u: User, s: Studio, p: StudioPermission): boolean;
  canManageMembers(u: User, s: Studio): boolean;
  vaultAdmins: string[];
  githubAccount: GitHubAccountLookup;
  githubRepository: GitHubRepositoryLookup;
}

const SOURCE_LABEL: Record<StudioSource, string> = { file: 'studios.json', import: 'Listing import', portal: 'Portal' };
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_NAME = 100;
const errSlot = html`<span class="err" role="status" aria-live="polite"></span>`;

function loginOf(v: unknown): string {
  const login = typeof v === 'string' ? v.trim().replace(/^@/, '') : '';
  if (!GITHUB_LOGIN.test(login)) fail(400, 'That isn’t a valid GitHub username.');
  return login;
}
const NO_MEMBERS = 'Only studio members who maintain users can manage members.';
const NO_PEOPLE = 'Only Vault staff who can maintain users can do this.';
// A body's permissions (permissionsFromBody), validated: 400 for anything outside the sets (permissions.ts).
function studioPermissionsOf(b: Record<string, unknown>): StudioPermission[] {
  let ps: StudioPermission[];
  try { ps = normalizeStudioPermissions(permissionsFromBody(b, STUDIO_PERMISSIONS, 'studio.')); } catch (err) { if (err instanceof PermissionError) fail(400, err.message); throw err; }
  if (!ps.length && b.role !== undefined) fail(400, 'Studio roles were replaced by permissions: send permissions (studio.view, studio.edit, studio.request_publish, studio.maintain_users).');
  if (!ps.length) fail(400, 'Give them at least the View permission (use Remove to take someone out of the studio).');
  return ps;
}
function vaultPermissionsOf(b: Record<string, unknown>): VaultPermission[] {
  try { return normalizeVaultPermissions(permissionsFromBody(b, VAULT_PERMISSIONS, 'vault.')); } catch (err) { if (err instanceof PermissionError) fail(400, err.message); throw err; }
}
export function nameOf(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!name) fail(400, 'Give the studio a name.');
  if (name.length > MAX_NAME) fail(400, `The name is too long (at most ${MAX_NAME} characters).`);
  return name;
}
export function websiteOf(v: unknown): string | null {
  try { return studioWebsite(v); } catch (err) { fail(400, (err as Error).message); }
}
// "fielddaylab", "@fielddaylab" or "https://github.com/fielddaylab" → "fielddaylab"; '' for none.
function githubOwnerOf(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^@/, '').replace(/\/+$/, '') : '';
  if (s && !GITHUB_LOGIN.test(s)) fail(400, 'That isn’t a valid GitHub organization name.');
  return s;
}
// "owner/name", "https://github.com/owner/name" or "…/name.git" → "owner/name".
function repositoryNameOf(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '') : '';
  if (!REPOSITORY_NAME.test(s)) fail(400, 'Type the repository as OWNER/NAME, for example VaultLearningGames/hosted-shadowspect.');
  return s;
}
// GitHub's numeric repository id, typed by hand for a private repository; '' for none.
function repositoryIdOf(v: unknown): string {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (s && !REPOSITORY_ID.test(s)) fail(400, 'The repository id is a number (gh api repos/OWNER/NAME --jq .id).');
  return s;
}

// A studio made from a game's "Made by" chooser (listing-makers.ts): a name and a website, as on Vault → Studios'
// "New studio" form with the GitHub organization left empty, so Vault manages it (owner id "vault:SLUG"). Its short
// name is made from its name, as the listing import does. The caller decides who may do this.
export function createManagedStudio(db: Db, actor: string, input: { name: unknown; website: unknown }, detail: Record<string, unknown> = {}): Studio {
  const name = nameOf(input.name);
  if (db.studios().some((s) => s.name.toLowerCase() === name.toLowerCase())) fail(409, `There’s already a studio named ${name}.`);
  const website = websiteOf(input.website);
  let slug = slugify(name).replace(/-+$/, '') || 'studio';
  while (db.studioBySlug(slug) || db.studioByOwnerId(`vault:${slug}`)) slug = `${slug.slice(0, 61).replace(/-+$/, '')}-2`;
  const s = db.createStudio({ slug, name, github_owner: '', github_owner_id: `vault:${slug}`, website });
  db.audit(actor, 'studio.create', slug, { name, github: null, github_owner_id: s.github_owner_id, website, via: 'made by', ...detail });
  return s;
}

export function registerPeople(app: Hono, h: Helpers) {
  const { db } = h;

  // ---------- shared rules ----------
  // Members with studio.maintain_users manage their own studio's members; vault.users.maintain manages every studio's.
  // They can give any studio permission in that studio, but a studio always keeps a signed-in member who maintains
  // users (vault.users.maintain can take the last one away, e.g. to hand a studio over).
  function guardLastMaintainer(u: User, s: Studio, login: string, next: readonly StudioPermission[] | null) {
    if (h.vaultCan(u, 'vault.users.maintain') || next?.includes('studio.maintain_users')) return;
    if (!db.studioPermissionsOf(s.id, login).includes('studio.maintain_users')) return;
    const others = db.signedInUserMaintainers(s.id).filter((l) => l.toLowerCase() !== login.toLowerCase());
    if (!others.length) fail(409, `${login} is the only member of ${s.name} who maintains users. Give someone else Maintain users first (they must have signed in).`);
  }
  function setMember(u: User, s: Studio, login: string, permissions: StudioPermission[]) {
    if (!h.canManageMembers(u, s)) fail(403, NO_MEMBERS);
    const was = db.membership(s.id, login);
    const from = was?.permissions ?? null;
    if (from && from.length === permissions.length && from.every((p) => permissions.includes(p))) return;
    guardLastMaintainer(u, s, login, permissions);
    db.setMembership(s.id, login, permissions, h.actor(u));
    db.audit(h.actor(u), 'member.set', `${s.slug}:${login}`, { permissions, from, invited: !db.userByLogin(login) });
  }
  function removeMember(u: User, s: Studio, login: string) {
    if (!h.canManageMembers(u, s)) fail(403, NO_MEMBERS);
    const from = db.membership(s.id, login)?.permissions;
    if (!from) fail(404, `${login} isn’t a member of ${s.name}.`);
    guardLastMaintainer(u, s, login, null);
    db.removeMembership(s.id, login);
    db.audit(h.actor(u), 'member.remove', `${s.slug}:${login}`, { permissions: from });
  }
  const studioOf = (slug: unknown, u: User) => {
    const s = typeof slug === 'string' ? db.studioBySlug(slug) : undefined;
    if (!s || !(h.isStaff(u) || h.isMember(u, s))) fail(404, 'unknown studio');
    return s;
  };
  const status = (login: string, users: Map<string, User>) => {
    const known = users.get(login.toLowerCase());
    return known ? html`<span>${known.name ? `${known.name} · ` : ''}signed in ${ago(known.last_login_at)}</span>` : html`<span>${pill('wait', 'Invited')} hasn’t signed in yet</span>`;
  };
  const usersByLogin = () => new Map(db.users().map((x) => [x.login.toLowerCase(), x]));
  // The permission editors: one labelled checkbox per permission, named by its id (portal.js sends them as booleans).
  // Implied permissions (normalizeStudioPermissions) show checked and disabled. With `label`, each is for that person.
  const studioChecks = (held: readonly StudioPermission[], who = '') => {
    const implied = impliedStudioPermissions(held);
    return html`<span class="perm-checks">${STUDIO_PERMISSIONS.map((p) => html`<label class="check" title="${STUDIO_PERMISSION_HINT[p]}"><input type="checkbox" name="${p}" ${held.includes(p) || implied.includes(p) ? 'checked' : ''} ${implied.includes(p) ? 'disabled' : ''} aria-label="${STUDIO_PERMISSION_LABEL[p]}${who ? `: ${who}` : ''}"> ${STUDIO_PERMISSION_LABEL[p]}</label>`)}</span>`;
  };
  const vaultChecks = (held: readonly VaultPermission[], who = '', locked = false) =>
    html`<span class="perm-checks">${VAULT_PERMISSIONS.map((p) => html`<label class="check" title="${VAULT_PERMISSION_HINT[p]}"><input type="checkbox" name="${p}" ${held.includes(p) ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="${VAULT_PERMISSION_LABEL[p]}${who ? `: ${who}` : ''}"> ${VAULT_PERMISSION_LABEL[p]}</label>`)}</span>`;
  const vaultText = (held: readonly VaultPermission[]) => held.map((p) => VAULT_PERMISSION_LABEL[p]).join(', ') || '—';
  const permissionList = (labels: Record<string, string>, hints: Record<string, string>) =>
    html`<ul class="tight">${Object.keys(labels).map((p) => html`<li><b>${labels[p]}</b>: ${hints[p]}</li>`)}</ul>`;

  // ---------- a studio's members ----------
  app.get('/s/:studio/members', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    const s = h.studioFor(c, u); if (s instanceof Response) return s;
    const manage = h.canManageMembers(u, s);
    const api = `/portal/api/s/${s.slug}/members`;
    const users = usersByLogin();
    const members = db.memberships(s.id);
    const rows = members.map((m) => html`<tr>
        <td class="proj"><b>${m.github_login}</b>${status(m.github_login, users)}</td>
        <td>${manage ? html`<form data-api="${api}" data-autosubmit data-then="reload"><input type="hidden" name="login" value="${m.github_login}">${studioChecks(m.permissions, m.github_login)}${errSlot}</form>` : studioPermissionText(m.permissions)}</td>
        <td class="small">${who(m.added_by)} · ${m.created_at.slice(0, 10)}</td>
        <td class="r">${manage ? html`<form data-api="${api}/remove" data-then="reload" data-confirm="${users.has(m.github_login.toLowerCase()) ? `Remove ${m.github_login} from ${s.name}?` : `Cancel ${m.github_login}’s invitation?`}"><input type="hidden" name="login" value="${m.github_login}"><button class="btn sm">${users.has(m.github_login.toLowerCase()) ? 'Remove' : 'Cancel invite'}</button>${errSlot}</form>` : ''}</td></tr>`);
    const invited = members.filter((m) => !users.has(m.github_login.toLowerCase())).length;
    const body = html`${head('Members', `People who can see ${s.name}’s games. They sign in with GitHub.`, '', html`<a href="/s/${s.slug}">${s.name}</a> / Members`)}
      <div class="grid g-main"><div class="grid">
        <div class="tbl-wrap"><table><thead><tr><th>GitHub user</th><th>Permissions</th><th>Added</th><th></th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="4" class="muted">No members yet.</td></tr>`}</tbody></table></div>
        ${invited ? html`<p class="small muted">${invited} invited: they get access the first time they sign in to the portal with that GitHub account.</p>` : ''}
        ${manage ? html`<div class="card"><h2>Add someone</h2><form data-api="${api}" data-then="reload" class="inline-form">
          <label class="field"><span class="lab">GitHub username</span><input name="login" required autocomplete="off" placeholder="octocat"></label>
          <div class="field"><span class="lab">Permissions</span>${studioChecks(['studio.view'])}</div>
          <button class="btn pri">Add</button>${errSlot}</form>
          <p class="small muted">Nothing is emailed. Send them the portal’s address; people who haven’t signed in yet show as invited until they do.</p></div>` : ''}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card small" id="studio"><h2>Studio</h2>
          <table class="kv"><tbody><tr><th>Name</th><td>${s.name}</td></tr>
            <tr><th>Website</th><td>${s.website ? html`<a href="${s.website}" target="_blank" rel="noopener">${s.website}</a>` : html`<span class="muted">none</span>`}</td></tr></tbody></table>
          ${manage ? html`<form data-api="/portal/api/s/${s.slug}/website" data-then="reload" class="inline-form">
            <label class="field"><span class="lab">Website</span><input name="website" type="url" maxlength="300" value="${s.website ?? ''}" placeholder="https://example.org" autocomplete="off"></label>
            <button class="btn">Save</button>${errSlot}</form>` : ''}
          <p class="muted">vaultlearninggames.org links ${s.name} to it wherever it’s named as a game’s maker.</p>
          ${h.vaultCan(u, 'vault.content.edit') ? html`<p><a href="/vault/studios/${s.slug}">Edit the studio’s name and GitHub organization</a></p>` : ''}</div>
        <div class="card small"><h2>Permissions</h2>${permissionList(STUDIO_PERMISSION_LABEL, STUDIO_PERMISSION_HINT)}
          <p class="muted">Edit, Request publish and Maintain users each include View. A studio always keeps at least one member who maintains users and has signed in. Vault staff release, publish and roll back.</p></div></div></div>`;
    return h.page(c, 'Members', body, { studio: s, active: 'members' });
  });

  // Body: { login, permissions: [...] } or the editor's checkboxes ({ login, "studio.edit": true, ... }).
  app.post('/portal/api/s/:studio/members', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !h.canManageMembers(u, s)) fail(403, NO_MEMBERS);
    const b = await jsonBody(c);
    setMember(u, s, loginOf(b.login), studioPermissionsOf(b));
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/members/remove', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !h.canManageMembers(u, s)) fail(403, NO_MEMBERS);
    removeMember(u, s, loginOf((await jsonBody(c)).login));
    return c.json({ ok: true });
  });

  // ---------- Vault: everyone ----------
  app.get('/vault/people', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.vaultCan(u, 'vault.users.maintain')) return h.denied(c, NO_PEOPLE);
    const users = db.users();
    const known = new Set(users.map((x) => x.login.toLowerCase()));
    const byLogin = new Map<string, ReturnType<Db['allMemberships']>>();
    for (const m of db.allMemberships()) {
      const k = m.github_login.toLowerCase();
      byLogin.set(k, [...(byLogin.get(k) ?? []), m]);
    }
    const staff = db.staffPermissions();
    const invitedLogins = [...new Set([...byLogin.keys(), ...staff.keys()].filter((k) => !known.has(k)))]
      .map((k) => byLogin.get(k)?.[0].github_login ?? staff.get(k)!.github_login);
    // Vault permissions: checkboxes, except your own (so nobody locks themselves out).
    const vaultCell = (login: string) => {
      const held = staff.get(login.toLowerCase())?.permissions ?? [];
      if (login.toLowerCase() === u.login.toLowerCase()) return html`${vaultText(held)} <span class="muted">(you)</span>`;
      return html`<form data-api="/portal/api/vault/permissions" data-autosubmit><input type="hidden" name="login" value="${login}">${vaultChecks(held, login)}${errSlot}</form>${known.has(login.toLowerCase()) || !held.length ? '' : html` <span class="muted small">(at first sign-in)</span>`}`;
    };
    const studiosCell = (login: string) => {
      const ms = byLogin.get(login.toLowerCase()) ?? [];
      if (!ms.length) return html`<span class="muted">—</span>`;
      return html`<div class="mem-list">${ms.map((m) => html`<div class="mem"><a href="/s/${m.studio_slug}/members">${m.studio_name}</a>
            <form data-api="/portal/api/s/${m.studio_slug}/members" data-autosubmit data-then="reload"><input type="hidden" name="login" value="${m.github_login}">${studioChecks(m.permissions, `${m.github_login} in ${m.studio_name}`)}${errSlot}</form>
            <form data-api="/portal/api/s/${m.studio_slug}/members/remove" data-then="reload" data-confirm="Remove ${m.github_login} from ${m.studio_name}?"><input type="hidden" name="login" value="${m.github_login}"><button class="btn sm" aria-label="Remove ${m.github_login} from ${m.studio_name}">Remove</button>${errSlot}</form></div>`)}</div>`;
    };
    const rows = [
      ...users.map((x) => html`<tr><td class="proj"><b>${x.login}</b><span>${x.name ?? ''}</span></td><td>${studiosCell(x.login)}</td>
        <td class="small">${vaultCell(x.login)}</td><td class="small">${ago(x.last_login_at)}</td></tr>`),
      ...invitedLogins.map((login) => html`<tr><td class="proj"><b>${login}</b><span>${pill('wait', 'Invited')}</span></td><td>${studiosCell(login)}</td>
        <td class="small">${vaultCell(login)}</td><td class="small muted">Never</td></tr>`),
    ];
    const studios = db.studios();
    const body = html`${head('People', 'Everyone who has signed in, and everyone given a studio or Vault permission who hasn’t yet. Vault permissions are for Vault staff; studio permissions can also be managed on each studio’s Members page by its members who maintain users.')}
      <div class="card" style="margin-bottom:16px"><h2>Add someone</h2><form data-api="/portal/api/vault/members" data-then="reload" class="inline-form">
          <label class="field"><span class="lab">GitHub username</span><input name="login" required autocomplete="off" placeholder="octocat"></label>
          <label class="field"><span class="lab">Studio</span><select name="studio"><option value="">No studio</option>${studios.map((s) => html`<option value="${s.slug}">${s.name}</option>`)}</select></label>
          <div class="field"><span class="lab">Studio permissions</span>${studioChecks(['studio.view'])}</div>
          <div class="field"><span class="lab">Vault permissions</span>${vaultChecks([])}</div>
          <button class="btn pri">Add</button>${errSlot}</form>
          <p class="small muted">Give them a studio, Vault permissions, or both. People who haven’t signed in yet show as invited; their permissions apply when they first sign in with that GitHub account. Nothing is emailed.</p></div>
      <div class="tbl-wrap"><table><thead><tr><th>GitHub user</th><th>Studios</th><th>Vault permissions</th><th>Last sign-in</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="card small" style="margin-top:16px"><h2>Vault permissions</h2>${permissionList(VAULT_PERMISSION_LABEL, VAULT_PERMISSION_HINT)}
        <p class="muted">Anyone with a Vault permission is Vault staff: they see the Vault pages and every studio. ${h.vaultAdmins.length ? `Always every permission: ${h.vaultAdmins.join(', ')}.` : ''}</p></div>`;
    return h.page(c, 'People', body, { active: 'people' });
  });

  // vault.users.maintain: add anyone from the People page, to a studio (with studio permissions) and/or with Vault
  // permissions. Body: { login, studio?, "studio.view": true, ..., "vault.content.edit": true, ... }.
  app.post('/portal/api/vault/members', async (c) => {
    const u = h.apiUser(c);
    if (!h.vaultCan(u, 'vault.users.maintain')) fail(403, `${NO_PEOPLE} Members who maintain a studio’s users use its Members page.`);
    const b = await jsonBody(c);
    const login = loginOf(b.login);
    const vault = vaultPermissionsOf(b);
    const s = b.studio ? studioOf(b.studio, u) : null;
    if (!s && !vault.length) fail(400, 'Choose a studio, Vault permissions, or both.');
    if (vault.length) setStaff(u, login, vault);
    if (s) setMember(u, s, login, studioPermissionsOf(b));
    return c.json({ ok: true });
  });

  // vault.users.maintain: replace someone's Vault permissions, by GitHub login, signed in or not (permissions given
  // before someone's first sign-in apply from it). Body: { login, permissions: [...] } or the editor's checkboxes.
  app.post('/portal/api/vault/permissions', async (c) => {
    const u = h.apiUser(c);
    if (!h.vaultCan(u, 'vault.users.maintain')) fail(403, NO_PEOPLE);
    const b = await jsonBody(c);
    const login = loginOf(b.login);
    setStaff(u, login, vaultPermissionsOf(b));
    return c.json({ ok: true, pending: !db.userByLogin(login) });
  });
  function setStaff(u: User, login: string, permissions: VaultPermission[]) {
    if (login.toLowerCase() === u.login.toLowerCase()) fail(400, 'You can’t change your own Vault permissions.');
    const from = db.setVaultPermissions(login, permissions, h.actor(u));
    if (from) db.audit(h.actor(u), 'vault.permissions', login, { permissions, from, invited: !db.userByLogin(login) });
  }

  // ---------- Vault: studios ----------
  const githubCell = (s: Studio) => {
    const org = studioGithubOrg(s);
    return org
      ? html`<a href="https://github.com/${org}" target="_blank" rel="noopener">${org}</a>`
      : html`<span class="muted">No GitHub organization configured</span>`;
  };
  const sourceCell = (s: Studio) => s.source ? pill(s.source === 'file' ? 'brass' : 'off', SOURCE_LABEL[s.source]) : html`<span class="muted">—</span>`;
  const studioFields = (s: Partial<Studio> | null, withSlug: boolean, locked = false) => html`<div class="fields">
      <label class="field"><span class="lab">Name</span><input name="name" required maxlength="${MAX_NAME}" value="${s?.name ?? ''}" ${locked ? 'readonly' : ''} autocomplete="off" placeholder="Learning Games Lab"></label>
      ${withSlug ? html`<label class="field"><span class="lab">Short name (web address)</span><input name="slug" required pattern="[a-z0-9]([a-z0-9\\-]{0,62}[a-z0-9])?" maxlength="64" autocomplete="off" placeholder="lgl"><span class="hint">Lowercase letters, numbers and dashes. Used in the portal and in its games’ CDN addresses; it can’t be changed later.</span></label>` : ''}
      <label class="field"><span class="lab">Website</span><input name="website" type="url" maxlength="300" value="${s?.website ?? ''}" placeholder="https://example.org" autocomplete="off"><span class="hint">Optional. The site links the studio’s name to it.</span></label>
      <label class="field"><span class="lab">GitHub organization</span><input name="github" maxlength="60" value="${studioGithubOrg(s) ?? ''}" ${locked ? 'readonly' : ''} autocomplete="off" placeholder="none"><span class="hint">Optional. Repositories in it can publish test versions to this studio. Leave it empty for a studio whose games Vault uploads.</span></label>
    </div>`;

  app.get('/vault/studios', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const editsContent = h.vaultCan(u, 'vault.content.edit');
    const rows = db.studioSummaries().map((s) => html`<tr>
      <td class="proj"><a href="/vault/studios/${s.slug}"><b>${s.name}</b></a><span class="mono">${s.slug}</span></td>
      <td class="small">${s.website ? html`<a href="${s.website}" target="_blank" rel="noopener">${s.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>` : html`<span class="muted">—</span>`}</td>
      <td class="small">${githubCell(s)}</td>
      <td class="r num"><a href="/s/${s.slug}">${s.listings}</a></td><td class="r num">${s.cdn_games}</td>
      <td class="r num"><a href="/s/${s.slug}/members">${s.members}</a>${s.invited ? html` <span class="muted small">+${s.invited} invited</span>` : ''}</td></tr>`);
    const body = html`${head('Studios', 'Every studio on Vault. Studios listed in studios.json get their name and GitHub organization from that file; the rest are managed here.')}
      <div class="tbl-wrap"><table><thead><tr><th>Studio</th><th>Website</th><th>GitHub</th><th class="r">Published Games</th><th class="r">CDN games</th><th class="r">Members</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${editsContent ? html`<div class="card" style="margin-top:18px"><h2>New studio</h2><form data-api="/portal/api/vault/studios" data-then="reload">
          ${studioFields(null, true)}
          <p style="margin-top:14px"><button class="btn pri">Create studio</button> ${errSlot}</p></form>
          <p class="small muted">Then add its people on its Members page (or on People). Its first member who maintains users can add the rest.</p></div>` : ''}`;
    return h.page(c, 'Studios', body, { active: 'vault-studios' });
  });

  // Single repositories assigned to a studio: they publish for it whatever organization owns them, so one
  // organization (VaultLearningGames) can hold several studios' games. vault.content.edit adds and removes them; the ones
  // studios.json lists are read-only here.
  const repositoriesCard = (s: Studio, editsContent: boolean) => {
    const api = `/portal/api/vault/studios/${s.slug}/repositories`;
    const rows = db.studioRepositories(s.id).map((r) => html`<tr>
      <td class="proj"><a href="https://github.com/${r.repository}" target="_blank" rel="noopener"><b>${r.repository}</b></a><span class="mono">repository id ${r.repository_id}</span></td>
      <td class="small">${r.source === 'file' ? pill('brass', 'studios.json') : html`${who(r.created_by)} · ${r.created_at.slice(0, 10)}`}</td>
      <td class="r">${editsContent && r.source === 'portal' ? html`<form data-api="${api}/remove" data-then="reload" data-confirm="Stop ${r.repository} publishing for ${s.name}? The games it already published stay with ${s.name}."><input type="hidden" name="id" value="${r.repository_id}"><button class="btn sm">Remove</button>${errSlot}</form>` : ''}</td></tr>`);
    return html`<div class="card" id="repositories"><h2>Repositories that publish for this studio</h2>
      <p class="small">A repository listed here publishes its test versions to ${s.name}, whatever GitHub organization it is in. ${studioGithubOrg(s) ? html`Every other repository in <b>${studioGithubOrg(s)}</b> publishes to ${s.name} too.` : html`${s.name} has no GitHub organization of its own, so only these repositories can publish to it.`}</p>
      <div class="tbl-wrap"><table><thead><tr><th>Repository</th><th>Added</th><th></th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="3" class="muted">None.</td></tr>`}</tbody></table></div>
      ${editsContent ? html`<form data-api="${api}" data-then="reload" class="inline-form" style="margin-top:14px">
          <label class="field"><span class="lab">Repository</span><input name="repository" required maxlength="150" autocomplete="off" placeholder="VaultLearningGames/hosted-game"></label>
          <label class="field"><span class="lab">Repository id (private repositories)</span><input name="id" inputmode="numeric" pattern="[0-9]*" maxlength="19" autocomplete="off" placeholder="looked up on GitHub"></label>
          <button class="btn pri">Add</button>${errSlot}</form>
        <p class="small muted">The portal looks up a public repository’s id on GitHub. It can’t see a private one, so type its id too: <span class="mono">gh api repos/OWNER/NAME --jq .id</span>. Repositories listed in <span class="mono">studios.json</span> are changed there.</p>` : ''}</div>`;
  };

  // Body: { repository: "owner/name", id?: "123" }. The id is GitHub's when GitHub shows the repository; a typed id
  // is used only when it doesn't (a private repository), and must agree with GitHub's when it does.
  app.post('/portal/api/vault/studios/:slug/repositories', async (c) => {
    const u = h.apiUser(c);
    if (!h.vaultCan(u, 'vault.content.edit')) fail(403, 'Only Vault staff who can edit game/studio content can change which repositories publish for a studio.');
    const s = db.studioBySlug(c.req.param('slug'));
    if (!s) fail(404, 'unknown studio');
    const b = await jsonBody(c);
    let name = repositoryNameOf(b.repository);
    const typedId = repositoryIdOf(b.id);
    let found: GitHubRepository | null = null;
    let lookupError = '';
    try { found = await h.githubRepository(name); } catch (err) { lookupError = (err as Error).message; }
    if (!found && !typedId) {
      if (lookupError) fail(503, `Couldn’t check ${name} with GitHub (${lookupError}). Try again, or type the repository id.`);
      fail(400, `GitHub shows no public repository called ${name}. If it is private, type its repository id too (gh api repos/${name} --jq .id).`);
    }
    if (found && typedId && found.id !== typedId) fail(400, `GitHub says ${found.name}’s id is ${found.id}, not ${typedId}.`);
    const id = found?.id ?? typedId;
    if (found) name = found.name;
    const existing = db.repositoryBinding(id);
    if (existing) {
      const other = db.studioById(existing.studio_id);
      if (existing.studio_id === s.id) fail(409, `${existing.repository} already publishes for ${s.name}.`);
      fail(409, `${existing.repository} already publishes for ${other?.name ?? 'another studio'}${existing.source === 'file' ? ' (set in studios.json)' : ''}; remove it there first.`);
    }
    db.bindRepository({ repository_id: id, repository: name, studio_id: s.id, created_by: h.actor(u), source: 'portal' });
    db.audit(h.actor(u), 'studio.repository.add', `${s.slug}:${name}`, { repository_id: id, checked_with_github: !!found });
    return c.json({ ok: true, repository: name, repository_id: id });
  });

  // Body: { id }. Games the repository already published stay with the studio.
  app.post('/portal/api/vault/studios/:slug/repositories/remove', async (c) => {
    const u = h.apiUser(c);
    if (!h.vaultCan(u, 'vault.content.edit')) fail(403, 'Only Vault staff who can edit game/studio content can change which repositories publish for a studio.');
    const s = db.studioBySlug(c.req.param('slug'));
    if (!s) fail(404, 'unknown studio');
    const id = repositoryIdOf((await jsonBody(c)).id);
    const r = id ? db.repositoryBinding(id) : undefined;
    if (!r || r.studio_id !== s.id) fail(404, `That repository doesn’t publish for ${s.name}.`);
    if (r.source === 'file') fail(409, `${r.repository} is assigned to ${s.name} in studios.json; remove it there.`);
    db.unbindRepository(r.repository_id);
    db.audit(h.actor(u), 'studio.repository.remove', `${s.slug}:${r.repository}`, { repository_id: r.repository_id });
    return c.json({ ok: true });
  });

  app.get('/vault/studios/:slug', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const s = db.studioSummaries().find((x) => x.slug === c.req.param('slug'));
    if (!s) return h.denied(c, 'That studio doesn’t exist.', 404);
    const editsContent = h.vaultCan(u, 'vault.content.edit');
    const fromFile = s.source === 'file';
    const body = html`${head(s.name, html`<span class="mono">${s.slug}</span> · ${s.listings} published games · ${s.cdn_games} CDN games · ${s.members} members${s.invited ? ` (+${s.invited} invited)` : ''}`,
      html`<a class="btn" href="/s/${s.slug}">Games</a> <a class="btn" href="/s/${s.slug}/members">Members</a>`, html`<a href="/vault/studios">Studios</a> / ${s.name}`)}
      <div class="grid g-main"><div class="grid" style="align-content:start">
        ${editsContent ? html`<div class="card"><h2>Edit</h2>
          ${fromFile ? html`<p class="small">${pill('brass', 'studios.json')} This studio’s name and GitHub organization come from <span class="mono">studios.json</span> and are reset from it at every deploy; change them there. Its website can be changed here.</p>` : ''}
          <form data-api="/portal/api/vault/studios/${s.slug}" data-then="reload">
            ${studioFields(s, false, fromFile)}
            <p style="margin-top:14px"><button class="btn pri">Save</button> ${errSlot}</p></form></div>
          ${repositoriesCard(s, true)}
          ${editsContent ? html`<div class="card"><h2>Delete</h2>
            <p class="small">Only an empty studio can be deleted: its CDN games and site listings must be gone first. Its members go with it. Only the studio's own rows are removed, so nothing other studios or the publisher's repositories rely on changes.</p>
            ${fromFile ? html`<p class="small">${pill('brass', 'studios.json')} This studio is listed in <span class="mono">studios.json</span>; remove that entry from the repository or it comes back at the next deploy.</p>` : ''}
            <form data-api="/portal/api/vault/studios/${s.slug}/delete" data-then="/vault/studios" data-confirm="${s.members + s.invited ? `Delete ${s.name} and remove its ${s.members + s.invited} member(s)?` : `Delete ${s.name}?`}"><button class="btn">Delete studio</button> ${errSlot}</form></div>` : ''}`
        : html`<div class="card"><table class="kv"><tbody><tr><th>Name</th><td>${s.name}</td></tr><tr><th>Website</th><td>${s.website || '—'}</td></tr><tr><th>GitHub</th><td>${githubCell(s)}</td></tr></tbody></table></div>
          ${repositoriesCard(s, false)}`}
      </div><div class="grid" style="align-content:start">
        <div class="card small"><h2>About</h2><table class="kv"><tbody>
          <tr><th>Created by</th><td>${sourceCell(s)}</td></tr>
          <tr><th>GitHub</th><td>${githubCell(s)}${studioGithubOrg(s) ? html`<br><span class="muted mono">owner id ${s.github_owner_id}</span>` : ''}</td></tr></tbody></table>
          <p class="muted">Changing the GitHub organization changes which repositories can publish to ${s.name}. A CDN game stays with the repository that first published it.</p></div>
      </div></div>`;
    return h.page(c, s.name, body, { active: 'vault-studios' });
  });

  // The GitHub owner (login + numeric id) for a studio: GitHub's for an organization, or "vault:SLUG" for none.
  async function ownerFor(github: string, slug: string, current?: Studio): Promise<{ github_owner: string; github_owner_id: string }> {
    let owner: { github_owner: string; github_owner_id: string };
    if (!github) {
      owner = { github_owner: '', github_owner_id: current?.github_owner_id.startsWith('vault:') ? current.github_owner_id : `vault:${slug}` };
    } else if (current && current.github_owner.toLowerCase() === github.toLowerCase()) {
      return { github_owner: current.github_owner, github_owner_id: current.github_owner_id };
    } else {
      let acct: GitHubAccount | null;
      try { acct = await h.githubAccount(github); } catch (err) { fail(503, `Couldn’t check ${github} with GitHub (${(err as Error).message}). Try again, or leave the organization empty for now.`); }
      if (!acct) fail(400, `GitHub has no organization or user called ${github}.`);
      owner = { github_owner: acct.login, github_owner_id: acct.id };
    }
    const taken = db.studioByOwnerId(owner.github_owner_id);
    if (taken && taken.id !== current?.id) fail(409, owner.github_owner ? `${owner.github_owner} already publishes to ${taken.name}.` : `Another studio (${taken.name}) already uses ${owner.github_owner_id}.`);
    return owner;
  }

  // Body: { name, slug, website, github }
  app.post('/portal/api/vault/studios', async (c) => {
    const u = h.apiUser(c);
    if (!h.vaultCan(u, 'vault.content.edit')) fail(403, 'Only Vault staff who can edit game/studio content can create studios.');
    const b = await jsonBody(c);
    const name = nameOf(b.name);
    const slug = typeof b.slug === 'string' ? b.slug.trim() : '';
    if (!isSlug(slug)) fail(400, 'Use a short name of lowercase letters, numbers and dashes (e.g. lgl), starting and ending with a letter or number.');
    if (db.studioBySlug(slug)) fail(409, `There’s already a studio called ${slug}.`);
    if (db.studios().some((s) => s.name.toLowerCase() === name.toLowerCase())) fail(409, `There’s already a studio named ${name}.`);
    const website = websiteOf(b.website);
    const owner = await ownerFor(githubOwnerOf(b.github), slug);
    const s = db.createStudio({ slug, name, ...owner, website });
    db.audit(h.actor(u), 'studio.create', slug, { name, github: owner.github_owner || null, github_owner_id: owner.github_owner_id, website, via: 'portal' });
    return c.json({ ok: true, slug: s.slug });
  });

  // Body: { name, website, github }. studios.json studios: only the website (the file sets the rest at every deploy).
  app.post('/portal/api/vault/studios/:slug', async (c) => {
    const u = h.apiUser(c);
    if (!h.vaultCan(u, 'vault.content.edit')) fail(403, 'Only Vault staff who can edit game/studio content can edit studios.');
    const s = db.studioBySlug(c.req.param('slug'));
    if (!s) fail(404, 'unknown studio');
    const b = await jsonBody(c);
    const name = nameOf(b.name);
    const website = websiteOf(b.website);
    const github = githubOwnerOf(b.github);
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    if (name !== s.name || github.toLowerCase() !== (studioGithubOrg(s) ?? '').toLowerCase()) {
      if (s.source === 'file') fail(409, `${s.name}’s name and GitHub organization come from studios.json; change them there.`);
      if (name !== s.name && db.studios().some((x) => x.id !== s.id && x.name.toLowerCase() === name.toLowerCase())) fail(409, `There’s already a studio named ${name}.`);
      const owner = await ownerFor(github, s.slug, s);
      if (name !== s.name) changes.name = { from: s.name, to: name };
      if (owner.github_owner_id !== s.github_owner_id) changes.github = { from: s.github_owner || s.github_owner_id, to: owner.github_owner || owner.github_owner_id };
      db.updateStudio(s.id, { name, ...owner });
    }
    if ((s.website || null) !== website) {
      db.setStudioWebsite(s.id, website);
      changes.website = { from: s.website || null, to: website };
    }
    if (Object.keys(changes).length) db.audit(h.actor(u), 'studio.update', s.slug, changes);
    return c.json({ ok: true });
  });

  // Remove an empty studio. Refused (409) while it still owns CDN games or site listings; its members go with it.
  // The removal is scoped to the studio's own id, so a GitHub owner id it shares (for instance with the publisher's
  // own organization) reaches no other studio's records.
  app.post('/portal/api/vault/studios/:slug/delete', (c) => {
    const u = h.apiUser(c);
    if (!h.vaultCan(u, 'vault.content.edit')) fail(403, 'Only Vault staff who can edit game/studio content can delete studios.');
    const s = db.studioBySlug(c.req.param('slug'));
    if (!s) fail(404, 'unknown studio');
    try {
      const r = db.removeStudio(s.id, { actor: h.actor(u) });
      return c.json({ ok: true, studio: r.studio.slug, members_removed: r.memberships.length, warnings: r.warnings });
    } catch (err) {
      if (err instanceof StudioNotEmptyError) fail(409, err.message, { games: err.blockers.games, listings: err.blockers.listings });
      throw err;
    }
  });
}
