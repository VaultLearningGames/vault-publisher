// The portal's permissions: the single source of truth for what each one is called, what it allows and how a set of
// them is checked. Two small fixed sets:
//   Vault permissions, held by Vault staff (by GitHub login, so they can be given before someone first signs in):
//     vault.users.maintain  Vault's People page: everyone's Vault permissions and every studio's members.
//     vault.content.edit    Any studio's games and site listings: approving releases and publishing (making them live),
//                           studios and their repositories, freezing, uploading and deleting games.
//     vault.blog.edit       The blog: creating, editing, publishing, unpublishing and deleting posts.
//   Studio permissions, held per studio membership:
//     studio.view            The studio's games, test versions, releases and analytics.
//     studio.edit            Edits its site listings and games: uploads builds, connects and deletes games.
//     studio.request_publish Asks Vault to publish: release requests, submitting listings, switching between releases
//                            Vault approved (unless the game is frozen).
//     studio.maintain_users  Its members (and their permissions) and the studio's website.
// Anyone with a Vault permission is Vault staff: they see the Vault pages and every studio. The only implication is
// normalizeStudioPermissions's: every studio permission implies studio.view.

export const VAULT_PERMISSIONS = ['vault.users.maintain', 'vault.content.edit', 'vault.blog.edit'] as const;
export type VaultPermission = (typeof VAULT_PERMISSIONS)[number];
export const STUDIO_PERMISSIONS = ['studio.view', 'studio.edit', 'studio.request_publish', 'studio.maintain_users'] as const;
export type StudioPermission = (typeof STUDIO_PERMISSIONS)[number];

export const VAULT_PERMISSION_LABEL: Record<VaultPermission, string> = {
  'vault.users.maintain': 'Maintain users',
  'vault.content.edit': 'Edit game/studio content',
  'vault.blog.edit': 'Edit blog posts',
};
export const STUDIO_PERMISSION_LABEL: Record<StudioPermission, string> = {
  'studio.view': 'View',
  'studio.edit': 'Edit',
  'studio.request_publish': 'Request publish',
  'studio.maintain_users': 'Maintain users',
};
export const VAULT_PERMISSION_HINT: Record<VaultPermission, string> = {
  'vault.users.maintain': 'gives and takes away Vault permissions, and manages every studio’s members.',
  'vault.content.edit': 'edits any studio’s games and site listings, approves releases and publishes them, and manages studios.',
  'vault.blog.edit': 'creates, edits, publishes and deletes blog posts.',
};
export const STUDIO_PERMISSION_HINT: Record<StudioPermission, string> = {
  'studio.view': 'sees the studio’s games, test versions, releases and analytics.',
  'studio.edit': 'edits site listings, uploads builds, and connects and deletes games.',
  'studio.request_publish': 'asks Vault to release a test version or publish a listing, and switches between releases Vault approved.',
  'studio.maintain_users': 'manages members and their permissions, and the studio’s website.',
};

export const isVaultPermission = (v: unknown): v is VaultPermission => VAULT_PERMISSIONS.includes(v as VaultPermission);
export const isStudioPermission = (v: unknown): v is StudioPermission => STUDIO_PERMISSIONS.includes(v as StudioPermission);

// A value outside the sets above, or something that isn't a list of them.
export class PermissionError extends Error {}

function listOf<P extends string>(v: unknown, all: readonly P[], what: string): P[] {
  if (!Array.isArray(v)) throw new PermissionError(`${what} must be a list.`);
  for (const p of v) if (!all.includes(p as P)) throw new PermissionError(`${typeof p === 'string' ? p : JSON.stringify(p)} isn’t a ${what.toLowerCase().replace(/s$/, '')}.`);
  return all.filter((p) => v.includes(p));
}

// A set of Vault permissions, in canonical order, with nothing implied. Throws PermissionError for anything else.
export function normalizeVaultPermissions(v: unknown): VaultPermission[] {
  return listOf(v, VAULT_PERMISSIONS, 'Vault permissions');
}
// A set of studio permissions, in canonical order, with what they imply (every one implies studio.view). Throws
// PermissionError for anything else. The one place implications are applied.
export function normalizeStudioPermissions(v: unknown): StudioPermission[] {
  const ps = listOf(v, STUDIO_PERMISSIONS, 'Studio permissions');
  return ps.length ? STUDIO_PERMISSIONS.filter((p) => p === 'studio.view' || ps.includes(p)) : [];
}
// The studio permissions a set implies without choosing them (the editors show these checked and disabled).
export function impliedStudioPermissions(ps: readonly StudioPermission[]): StudioPermission[] {
  return ps.some((p) => p !== 'studio.view') ? ['studio.view'] : [];
}

// A form's permission checkboxes ({ "studio.edit": true, ... }) or { permissions: [...] }, as a list. A key that looks
// like a permission of this kind but isn't one is refused, so a typo can't silently drop a permission.
export function permissionsFromBody<P extends string>(b: Record<string, unknown>, all: readonly P[], prefix: 'vault.' | 'studio.'): unknown {
  if (b.permissions !== undefined) return b.permissions;
  const out: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!k.startsWith(prefix)) continue;
    if (!all.includes(k as P)) throw new PermissionError(`${k} isn’t a permission.`);
    if (v === true || v === 'on' || v === '1') out.push(k);
  }
  return out;
}

// Someone's permissions: their Vault ones and, by studio id, their studio ones (normalized).
export interface PermissionHolder {
  vault_permissions: readonly VaultPermission[];
  studio_permissions: ReadonlyMap<number, readonly StudioPermission[]>;
}
export const hasVaultPermission = (user: PermissionHolder, p: VaultPermission): boolean => user.vault_permissions.includes(p);
export const hasStudioPermission = (user: PermissionHolder, studioId: number, p: StudioPermission): boolean =>
  !!user.studio_permissions.get(studioId)?.includes(p);
export const isVaultStaff = (user: PermissionHolder): boolean => user.vault_permissions.length > 0;

// ---------- the old roles ----------
// Before these permissions there were roles: a Vault role on each user (users.vault_role: none, release_manager or
// admin, beside a separate blog.maintain permission) and a role on each membership (memberships.role: viewer,
// maintainer or admin). Those columns stay, written from the permissions below, so an older image run against the
// same database still sees roughly the same people; nothing here reads them except the one-time conversion (db.ts
// ensurePermissions) and memberships an older image wrote. Old roles map to permission sets only through here.
export type LegacyVaultRole = 'none' | 'release_manager' | 'admin';
export type LegacyStudioRole = 'viewer' | 'maintainer' | 'admin';
export const LEGACY_STUDIO_ROLES: readonly LegacyStudioRole[] = ['viewer', 'maintainer', 'admin'];

export function vaultPermissionsForLegacyRole(role: LegacyVaultRole): VaultPermission[] {
  return role === 'admin' ? [...VAULT_PERMISSIONS] : role === 'release_manager' ? ['vault.content.edit'] : [];
}
export function studioPermissionsForLegacyRole(role: LegacyStudioRole): StudioPermission[] {
  if (role === 'admin') return [...STUDIO_PERMISSIONS];
  return role === 'maintainer' ? ['studio.view', 'studio.edit', 'studio.request_publish'] : ['studio.view'];
}
export function legacyVaultRole(ps: readonly VaultPermission[]): LegacyVaultRole {
  return ps.includes('vault.users.maintain') ? 'admin' : ps.includes('vault.content.edit') ? 'release_manager' : 'none';
}
export function legacyStudioRole(ps: readonly StudioPermission[]): LegacyStudioRole {
  if (ps.includes('studio.maintain_users')) return 'admin';
  return ps.includes('studio.edit') || ps.includes('studio.request_publish') ? 'maintainer' : 'viewer';
}
