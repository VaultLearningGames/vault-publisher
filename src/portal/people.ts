// People and studios: each studio's Members page (studio admins and Vault admins), Vault's People page (everyone and
// every membership) and Vault's Studios page (creating studios and editing their name, website and GitHub organization).
// Memberships are keyed by GitHub username, so people can be added before they first sign in: until then they show as
// "invited", and the membership takes effect the first time they sign in with GitHub.
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { studioWebsite, StudioNotEmptyError, type Db, type Studio, type StudioRole, type StudioSource, type User, type VaultRole } from '../db.ts';
import { isSlug } from '../paths.ts';
import { html, type Html } from './html.ts';
import { ago, head, pill, ROLE_LABEL, VAULT_LABEL, who } from './routes.ts';

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

interface Helpers {
  db: Db;
  page(c: Context, title: string, body: Html, opts?: { studio?: Studio; active?: string; status?: number }): Response | Promise<Response>;
  denied(c: Context, message: string, status?: number): Response | Promise<Response>;
  signedIn(c: Context): User | Response;
  studioFor(c: Context, u: User): Studio | Response;
  apiUser(c: Context): User;
  actor(u: User): string;
  isStaff(u: User): boolean;
  isVaultAdmin(u: User): boolean;
  canManageMembers(u: User, s: Studio): boolean;
  vaultAdmins: string[];
  githubAccount: GitHubAccountLookup;
}

const ROLES: StudioRole[] = ['viewer', 'maintainer', 'admin'];
const SOURCE_LABEL: Record<StudioSource, string> = { file: 'studios.json', import: 'Listing import', portal: 'Portal' };
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_NAME = 100;
const errSlot = html`<span class="err" role="status" aria-live="polite"></span>`;

function loginOf(v: unknown): string {
  const login = typeof v === 'string' ? v.trim().replace(/^@/, '') : '';
  if (!GITHUB_LOGIN.test(login)) fail(400, 'That isn’t a valid GitHub username.');
  return login;
}
function roleOf(v: unknown): StudioRole {
  if (!ROLES.includes(v as StudioRole)) fail(400, 'Choose a role.');
  return v as StudioRole;
}
function nameOf(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!name) fail(400, 'Give the studio a name.');
  if (name.length > MAX_NAME) fail(400, `The name is too long (at most ${MAX_NAME} characters).`);
  return name;
}
function websiteOf(v: unknown): string | null {
  try { return studioWebsite(v); } catch (err) { fail(400, (err as Error).message); }
}
// "fielddaylab", "@fielddaylab" or "https://github.com/fielddaylab" → "fielddaylab"; '' for none.
function githubOwnerOf(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^@/, '').replace(/\/+$/, '') : '';
  if (s && !GITHUB_LOGIN.test(s)) fail(400, 'That isn’t a valid GitHub organization name.');
  return s;
}

export function registerPeople(app: Hono, h: Helpers) {
  const { db } = h;

  // ---------- shared rules ----------
  // Studio admins manage their own studio's members; Vault admins manage every studio's. A studio admin can't leave the
  // studio without a signed-in admin (Vault admins can, e.g. to hand a studio over).
  function guardLastAdmin(u: User, s: Studio, login: string, newRole: StudioRole | null) {
    if (h.isVaultAdmin(u) || db.roleIn(s.id, login) !== 'admin' || newRole === 'admin') return;
    const others = db.signedInAdmins(s.id).filter((l) => l.toLowerCase() !== login.toLowerCase());
    if (!others.length) fail(409, `${login} is ${s.name}’s only studio admin. Make someone else a studio admin first (they must have signed in).`);
  }
  function setMember(u: User, s: Studio, login: string, role: StudioRole) {
    if (!h.canManageMembers(u, s)) fail(403, 'Only studio admins can manage members.');
    const from = db.roleIn(s.id, login) ?? null;
    if (from === role) return;
    guardLastAdmin(u, s, login, role);
    db.setMembership(s.id, login, role, h.actor(u));
    db.audit(h.actor(u), 'member.set', `${s.slug}:${login}`, { role, from, invited: !db.userByLogin(login) });
  }
  function removeMember(u: User, s: Studio, login: string) {
    if (!h.canManageMembers(u, s)) fail(403, 'Only studio admins can manage members.');
    const from = db.roleIn(s.id, login);
    if (!from) fail(404, `${login} isn’t a member of ${s.name}.`);
    guardLastAdmin(u, s, login, null);
    db.removeMembership(s.id, login);
    db.audit(h.actor(u), 'member.remove', `${s.slug}:${login}`, { role: from });
  }
  const studioOf = (slug: unknown, u: User) => {
    const s = typeof slug === 'string' ? db.studioBySlug(slug) : undefined;
    if (!s || !(h.isStaff(u) || db.roleIn(s.id, u.login))) fail(404, 'unknown studio');
    return s;
  };
  const status = (login: string, users: Map<string, User>) => {
    const known = users.get(login.toLowerCase());
    return known ? html`<span>${known.name ? `${known.name} · ` : ''}signed in ${ago(known.last_login_at)}</span>` : html`<span>${pill('wait', 'Invited')} hasn’t signed in yet</span>`;
  };
  const usersByLogin = () => new Map(db.users().map((x) => [x.login.toLowerCase(), x]));
  const roleSelect = (name: string, selected: StudioRole | null, label: string) => html`<select name="${name}" aria-label="${label}">${ROLES.map((r) => html`<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`)}</select>`;

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
        <td>${manage ? html`<form data-api="${api}" data-autosubmit><input type="hidden" name="login" value="${m.github_login}">${roleSelect('role', m.role, `Role for ${m.github_login}`)}${errSlot}</form>` : ROLE_LABEL[m.role]}</td>
        <td class="small">${who(m.added_by)} · ${m.created_at.slice(0, 10)}</td>
        <td class="r">${manage ? html`<form data-api="${api}/remove" data-then="reload" data-confirm="${users.has(m.github_login.toLowerCase()) ? `Remove ${m.github_login} from ${s.name}?` : `Cancel ${m.github_login}’s invitation?`}"><input type="hidden" name="login" value="${m.github_login}"><button class="btn sm">${users.has(m.github_login.toLowerCase()) ? 'Remove' : 'Cancel invite'}</button>${errSlot}</form>` : ''}</td></tr>`);
    const invited = members.filter((m) => !users.has(m.github_login.toLowerCase())).length;
    const body = html`${head('Members', `People who can see ${s.name}’s games. They sign in with GitHub.`, '', html`<a href="/s/${s.slug}">${s.name}</a> / Members`)}
      <div class="grid g-main"><div class="grid">
        <div class="tbl-wrap"><table><thead><tr><th>GitHub user</th><th>Role</th><th>Added</th><th></th></tr></thead><tbody>${rows.length ? rows : html`<tr><td colspan="4" class="muted">No members yet.</td></tr>`}</tbody></table></div>
        ${invited ? html`<p class="small muted">${invited} invited: they get access the first time they sign in to the portal with that GitHub account.</p>` : ''}
        ${manage ? html`<div class="card"><h2>Add someone</h2><form data-api="${api}" data-then="reload" class="inline-form">
          <label class="field"><span class="lab">GitHub username</span><input name="login" required autocomplete="off" placeholder="octocat"></label>
          <label class="field"><span class="lab">Role</span>${roleSelect('role', 'maintainer', 'Role')}</label>
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
          ${h.isVaultAdmin(u) ? html`<p><a href="/vault/studios/${s.slug}">Edit the studio’s name and GitHub organization</a></p>` : ''}</div>
        <div class="card small"><h2>Roles</h2><ul class="tight">
        <li><b>Viewer</b>: sees the studio’s games, test versions and releases.</li>
        <li><b>Maintainer</b>: also edits site listings, requests releases and switches between approved releases.</li>
        <li><b>Studio admin</b>: also manages members and the studio’s website. A studio always keeps at least one studio admin who has signed in.</li>
        <li><b>Vault staff</b> release, promote and roll back; Vault admins manage every studio’s members.</li></ul></div></div></div>`;
    return h.page(c, 'Members', body, { studio: s, active: 'members' });
  });

  app.post('/portal/api/s/:studio/members', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !h.canManageMembers(u, s)) fail(403, 'Only studio admins can manage members.');
    const b = await jsonBody(c);
    setMember(u, s, loginOf(b.login), roleOf(b.role));
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/members/remove', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !h.canManageMembers(u, s)) fail(403, 'Only studio admins can manage members.');
    removeMember(u, s, loginOf((await jsonBody(c)).login));
    return c.json({ ok: true });
  });

  // ---------- Vault: everyone ----------
  app.get('/vault/people', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const admin = h.isVaultAdmin(u);
    const users = db.users();
    const known = new Set(users.map((x) => x.login.toLowerCase()));
    const byLogin = new Map<string, ReturnType<Db['allMemberships']>>();
    for (const m of db.allMemberships()) {
      const k = m.github_login.toLowerCase();
      byLogin.set(k, [...(byLogin.get(k) ?? []), m]);
    }
    const vaultInvites = new Map(db.vaultInvites().map((v) => [v.github_login.toLowerCase(), v]));
    const invitedLogins = [...new Set([...byLogin.keys(), ...vaultInvites.keys()].filter((k) => !known.has(k)))]
      .map((k) => byLogin.get(k)?.[0].github_login ?? vaultInvites.get(k)!.github_login);
    const studiosCell = (login: string) => {
      const ms = byLogin.get(login.toLowerCase()) ?? [];
      if (!ms.length) return html`<span class="muted">—</span>`;
      return html`<div class="mem-list">${ms.map((m) => admin
        ? html`<div class="mem"><a href="/s/${m.studio_slug}/members">${m.studio_name}</a>
            <form data-api="/portal/api/s/${m.studio_slug}/members" data-autosubmit><input type="hidden" name="login" value="${m.github_login}">${roleSelect('role', m.role, `${m.github_login}’s role in ${m.studio_name}`)}${errSlot}</form>
            <form data-api="/portal/api/s/${m.studio_slug}/members/remove" data-then="reload" data-confirm="Remove ${m.github_login} from ${m.studio_name}?"><input type="hidden" name="login" value="${m.github_login}"><button class="btn sm" aria-label="Remove ${m.github_login} from ${m.studio_name}">Remove</button>${errSlot}</form></div>`
        : html`<div class="mem"><a href="/s/${m.studio_slug}/members">${m.studio_name}</a> <span class="muted">${ROLE_LABEL[m.role]}</span></div>`)}</div>`;
    };
    const rows = [
      ...users.map((x) => html`<tr><td class="proj"><b>${x.login}</b><span>${x.name ?? ''}</span></td><td>${studiosCell(x.login)}</td>
        <td>${admin && x.id !== u.id ? html`<form data-api="/portal/api/vault/users/${x.id}/role" data-autosubmit><select name="role" aria-label="Vault role for ${x.login}">${(['none', 'release_manager', 'admin'] as VaultRole[]).map((r) => html`<option value="${r}" ${r === x.vault_role ? 'selected' : ''}>${r === 'none' ? 'No Vault role' : VAULT_LABEL[r]}</option>`)}</select>${errSlot}</form>` : VAULT_LABEL[x.vault_role]}</td>
        <td class="small">${ago(x.last_login_at)}</td></tr>`),
      ...invitedLogins.map((login) => html`<tr><td class="proj"><b>${login}</b><span>${pill('wait', 'Invited')}</span></td><td>${studiosCell(login)}</td>
        <td class="small">${vaultInvites.get(login.toLowerCase()) ? html`${VAULT_LABEL[vaultInvites.get(login.toLowerCase())!.vault_role]} <span class="muted">(at first sign-in)</span>` : html`<span class="muted">—</span>`}</td><td class="small muted">Never</td></tr>`),
    ];
    const studios = db.studios();
    const body = html`${head('People', 'Everyone who has signed in, and everyone invited to a studio who hasn’t yet. Vault roles are for Vault staff; studio roles can also be managed by each studio’s admins on its Members page.')}
      ${admin ? html`<div class="card" style="margin-bottom:16px"><h2>Add someone</h2><form data-api="/portal/api/vault/members" data-then="reload" class="inline-form">
          <label class="field"><span class="lab">GitHub username</span><input name="login" required autocomplete="off" placeholder="octocat"></label>
          <label class="field"><span class="lab">Studio</span><select name="studio"><option value="">No studio</option>${studios.map((s) => html`<option value="${s.slug}">${s.name}</option>`)}</select></label>
          <label class="field"><span class="lab">Studio role</span>${roleSelect('role', 'maintainer', 'Studio role')}</label>
          <label class="field"><span class="lab">Vault role</span><select name="vaultRole" aria-label="Vault role">${(['none', 'release_manager', 'admin'] as VaultRole[]).map((r) => html`<option value="${r}">${r === 'none' ? 'No Vault role' : VAULT_LABEL[r]}</option>`)}</select></label>
          <button class="btn pri">Add</button>${errSlot}</form>
          <p class="small muted">Give them a studio, a Vault role, or both. People who haven’t signed in yet show as invited, and get their Vault role when they first sign in with that GitHub account. Nothing is emailed.</p></div>` : ''}
      <div class="tbl-wrap"><table><thead><tr><th>GitHub user</th><th>Studios</th><th>Vault role</th><th>Last sign-in</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="small muted">Release managers release, promote and roll back. Vault admins also manage people, studios and every studio’s members. ${h.vaultAdmins.length ? `Always admins: ${h.vaultAdmins.join(', ')}.` : ''}</p>`;
    return h.page(c, 'People', body, { active: 'people' });
  });

  // Vault admins: add anyone from the People page, to a studio (with a studio role) and/or with a Vault role.
  // Body: { login, studio?, role?, vaultRole? }. Someone who hasn't signed in gets the Vault role at first sign-in.
  app.post('/portal/api/vault/members', async (c) => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can do this here; studio admins use their studio’s Members page.');
    const b = await jsonBody(c);
    const login = loginOf(b.login);
    const vaultRole = (b.vaultRole ?? 'none') as VaultRole;
    if (!['none', 'release_manager', 'admin'].includes(vaultRole)) fail(400, 'Choose a Vault role.');
    const s = b.studio ? studioOf(b.studio, u) : null;
    if (!s && vaultRole === 'none') fail(400, 'Choose a studio, a Vault role, or both.');
    if (vaultRole !== 'none') {
      const target = db.userByLogin(login);
      if (target?.id === u.id) fail(400, 'You can’t change your own Vault role.');
      if (target) {
        if (target.vault_role !== vaultRole) {
          db.setVaultRole(target.id, vaultRole);
          db.audit(h.actor(u), 'vault.role', target.login, { role: vaultRole, from: target.vault_role });
        }
      } else {
        db.setVaultInvite(login, vaultRole, h.actor(u));
        db.audit(h.actor(u), 'vault.invite', login, { role: vaultRole });
      }
    }
    if (s) setMember(u, s, login, roleOf(b.role));
    return c.json({ ok: true });
  });

  app.post('/portal/api/vault/users/:id/role', async (c) => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can change Vault roles.');
    const target = db.userById(Number(c.req.param('id')));
    if (!target) fail(404, 'unknown user');
    if (target.id === u.id) fail(400, 'You can’t change your own Vault role.');
    const role = (await jsonBody(c)).role;
    if (!['none', 'release_manager', 'admin'].includes(role as string)) fail(400, 'Choose a role.');
    db.setVaultRole(target.id, role as VaultRole);
    db.audit(h.actor(u), 'vault.role', target.login, { role, from: target.vault_role });
    return c.json({ ok: true });
  });

  // ---------- Vault: studios ----------
  const githubCell = (s: Studio) => s.github_owner
    ? html`<a href="https://github.com/${s.github_owner}" target="_blank" rel="noopener">${s.github_owner}</a>`
    : html`<span class="muted">none (Vault uploads its games)</span>`;
  const sourceCell = (s: Studio) => s.source ? pill(s.source === 'file' ? 'brass' : 'off', SOURCE_LABEL[s.source]) : html`<span class="muted">—</span>`;
  const studioFields = (s: Partial<Studio> | null, withSlug: boolean, locked = false) => html`<div class="fields">
      <label class="field"><span class="lab">Name</span><input name="name" required maxlength="${MAX_NAME}" value="${s?.name ?? ''}" ${locked ? 'readonly' : ''} autocomplete="off" placeholder="Learning Games Lab"></label>
      ${withSlug ? html`<label class="field"><span class="lab">Short name (web address)</span><input name="slug" required pattern="[a-z0-9]([a-z0-9\\-]{0,62}[a-z0-9])?" maxlength="64" autocomplete="off" placeholder="lgl"><span class="hint">Lowercase letters, numbers and dashes. Used in the portal and in its games’ CDN addresses; it can’t be changed later.</span></label>` : ''}
      <label class="field"><span class="lab">Website</span><input name="website" type="url" maxlength="300" value="${s?.website ?? ''}" placeholder="https://example.org" autocomplete="off"><span class="hint">Optional. The site links the studio’s name to it.</span></label>
      <label class="field"><span class="lab">GitHub organization</span><input name="github" maxlength="60" value="${s?.github_owner ?? ''}" ${locked ? 'readonly' : ''} autocomplete="off" placeholder="fielddaylab"><span class="hint">Optional. Repositories in it can publish test versions to this studio. Leave it empty for a studio whose games Vault uploads.</span></label>
    </div>`;

  app.get('/vault/studios', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const admin = h.isVaultAdmin(u);
    const rows = db.studioSummaries().map((s) => html`<tr>
      <td class="proj"><a href="/vault/studios/${s.slug}"><b>${s.name}</b></a><span class="mono">${s.slug}</span></td>
      <td class="small">${s.website ? html`<a href="${s.website}" target="_blank" rel="noopener">${s.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>` : html`<span class="muted">—</span>`}</td>
      <td class="small">${githubCell(s)}</td>
      <td class="r num"><a href="/s/${s.slug}">${s.listings}</a></td><td class="r num">${s.cdn_games}</td>
      <td class="r num"><a href="/s/${s.slug}/members">${s.members}</a>${s.invited ? html` <span class="muted small">+${s.invited} invited</span>` : ''}</td></tr>`);
    const body = html`${head('Studios', 'Every studio on Vault. Studios listed in studios.json get their name and GitHub organization from that file; the rest are managed here.')}
      <div class="tbl-wrap"><table><thead><tr><th>Studio</th><th>Website</th><th>GitHub</th><th class="r">Published Games</th><th class="r">CDN games</th><th class="r">Members</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${admin ? html`<div class="card" style="margin-top:18px"><h2>New studio</h2><form data-api="/portal/api/vault/studios" data-then="reload">
          ${studioFields(null, true)}
          <p style="margin-top:14px"><button class="btn pri">Create studio</button> ${errSlot}</p></form>
          <p class="small muted">Then add its people on its Members page (or on People). Its first studio admin can add the rest.</p></div>` : ''}`;
    return h.page(c, 'Studios', body, { active: 'vault-studios' });
  });

  app.get('/vault/studios/:slug', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const s = db.studioSummaries().find((x) => x.slug === c.req.param('slug'));
    if (!s) return h.denied(c, 'That studio doesn’t exist.', 404);
    const admin = h.isVaultAdmin(u);
    const fromFile = s.source === 'file';
    const body = html`${head(s.name, html`<span class="mono">${s.slug}</span> · ${s.listings} published games · ${s.cdn_games} CDN games · ${s.members} members${s.invited ? ` (+${s.invited} invited)` : ''}`,
      html`<a class="btn" href="/s/${s.slug}">Games</a> <a class="btn" href="/s/${s.slug}/members">Members</a>`, html`<a href="/vault/studios">Studios</a> / ${s.name}`)}
      <div class="grid g-main"><div class="grid" style="align-content:start">
        ${admin ? html`<div class="card"><h2>Edit</h2>
          ${fromFile ? html`<p class="small">${pill('brass', 'studios.json')} This studio’s name and GitHub organization come from <span class="mono">studios.json</span> and are reset from it at every deploy; change them there. Its website can be changed here.</p>` : ''}
          <form data-api="/portal/api/vault/studios/${s.slug}" data-then="reload">
            ${studioFields(s, false, fromFile)}
            <p style="margin-top:14px"><button class="btn pri">Save</button> ${errSlot}</p></form></div>
          ${admin ? html`<div class="card"><h2>Delete</h2>
            <p class="small">Only an empty studio can be deleted: its CDN games and site listings must be gone first. Its members go with it. Only the studio's own rows are removed, so nothing other studios or the publisher's repositories rely on changes.</p>
            ${fromFile ? html`<p class="small">${pill('brass', 'studios.json')} This studio is listed in <span class="mono">studios.json</span>; remove that entry from the repository or it comes back at the next deploy.</p>` : ''}
            <form data-api="/portal/api/vault/studios/${s.slug}/delete" data-then="/vault/studios" data-confirm="${s.members + s.invited ? `Delete ${s.name} and remove its ${s.members + s.invited} member(s)?` : `Delete ${s.name}?`}"><button class="btn">Delete studio</button> ${errSlot}</form></div>` : ''}</div>`
        : html`<div class="card"><table class="kv"><tbody><tr><th>Name</th><td>${s.name}</td></tr><tr><th>Website</th><td>${s.website || '—'}</td></tr><tr><th>GitHub</th><td>${githubCell(s)}</td></tr></tbody></table></div>`}
      </div><div class="grid" style="align-content:start">
        <div class="card small"><h2>About</h2><table class="kv"><tbody>
          <tr><th>Created by</th><td>${sourceCell(s)}</td></tr>
          <tr><th>GitHub</th><td>${githubCell(s)}${s.github_owner ? html`<br><span class="muted mono">owner id ${s.github_owner_id}</span>` : ''}</td></tr></tbody></table>
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
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can create studios.');
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
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can edit studios.');
    const s = db.studioBySlug(c.req.param('slug'));
    if (!s) fail(404, 'unknown studio');
    const b = await jsonBody(c);
    const name = nameOf(b.name);
    const website = websiteOf(b.website);
    const github = githubOwnerOf(b.github);
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    if (name !== s.name || github.toLowerCase() !== s.github_owner.toLowerCase()) {
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
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can delete studios.');
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
