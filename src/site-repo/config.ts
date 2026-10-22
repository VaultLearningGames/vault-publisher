// How the portal commits to vault-site, read from the environment when used (never at import, so the portal boots and
// its tests run without any of it):
//   VAULT_SITE_GITHUB_TOKEN   the bot user's (vault-portal-bot) fine-grained token: vault-site only, Contents
//                             read/write, plus Actions write (portal/site-rebuild.ts starts the site's deploy runs)
//   VAULT_SITE_REPO           owner/name (default VaultLearningGames/vault-site)
//   VAULT_SITE_BRANCH         the branch read from and committed to; default by system: the production portal
//                             (SITE_REBUILD_ENVIRONMENT=production, set by deploy.yml) commits to "production", every
//                             other portal (staging, local) to "staging". A commit there is what deploys the site.
//   VAULT_SITE_API_BASE       the GitHub API (default https://api.github.com)
//   SITE_COMMIT_AUTHOR_NAME   the commits' author and committer (default vault-portal-bot)
//   SITE_COMMIT_AUTHOR_EMAIL  (default vault-portal-bot@users.noreply.github.com)
//   SITE_PUBLISHING_ENABLED   false (or 0, no, off) refuses every write to vault-site at once; read on every write
import { userInfo } from 'node:os';
import { SiteRepoConfigError } from './types.ts';

type Env = Record<string, string | undefined>;

export const DEFAULT_SITE_REPO = 'VaultLearningGames/vault-site';
export const STAGING_SITE_BRANCH = 'staging';
export const PRODUCTION_SITE_BRANCH = 'production';
export const DEFAULT_API_BASE = 'https://api.github.com';
export const DEFAULT_COMMIT_AUTHOR = { name: 'vault-portal-bot', email: 'vault-portal-bot@users.noreply.github.com' };

export interface CommitIdentity { name: string; email: string }

export interface SiteRepoConfig {
  token: string;
  repo: string;
  branch: string;
  apiBase: string;
  author: CommitIdentity;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// The vault-site branch this portal commits to: VAULT_SITE_BRANCH, else the system's own branch.
export function siteBranchFor(env: Env = process.env): string {
  const set = env.VAULT_SITE_BRANCH?.trim();
  if (set) return set;
  return env.SITE_REBUILD_ENVIRONMENT?.trim() === 'production' ? PRODUCTION_SITE_BRANCH : STAGING_SITE_BRANCH;
}

// Whether the portal may write to vault-site: on unless SITE_PUBLISHING_ENABLED is false, 0, no or off.
export function sitePublishingEnabled(env: Env = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.SITE_PUBLISHING_ENABLED ?? '').trim());
}

export function commitIdentity(env: Env = process.env): CommitIdentity {
  const name = env.SITE_COMMIT_AUTHOR_NAME?.trim() || DEFAULT_COMMIT_AUTHOR.name;
  const email = env.SITE_COMMIT_AUTHOR_EMAIL?.trim() || DEFAULT_COMMIT_AUTHOR.email;
  if (/[\u0000-\u001f<>]/.test(name)) throw new SiteRepoConfigError('SITE_COMMIT_AUTHOR_NAME is not a name.');
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw new SiteRepoConfigError('SITE_COMMIT_AUTHOR_EMAIL is not an email address.');
  return { name, email };
}

export function isBranchName(b: string): boolean {
  return !!b && !/[\s~^:?*[\\\u0000-\u001f\u007f]|\.\.|^\/|\/$|^-|@\{|\.lock$/.test(b);
}

// A single-line trailer value: whatever could break the commit message out of its last line is removed.
const trailerValue = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

// The commit message ending with the trailer naming the portal user (git interpret-trailers reads it).
export function withPortalUserTrailer(message: string, portalUser: string): string {
  const user = trailerValue(portalUser);
  if (!user) throw new SiteRepoConfigError('A commit to the website repository needs the portal user who made it.');
  const body = message.replace(/\s+$/, '').replace(/\n+Portal-User: [^\n]*$/, '');
  return `${body}\n\nPortal-User: ${user}\n`;
}

// The Portal-User of a commit a script makes (scripts/export-blog.ts, import-squarespace-blog.ts): PORTAL_USER, else
// script:<the operating-system user>.
export function scriptPortalUser(env: Env = process.env): string {
  const set = env.PORTAL_USER?.trim();
  if (set) return set;
  let who = env.USER || env.USERNAME || '';
  try { who ||= userInfo().username; } catch { /* no user database */ }
  return `script:${who || 'unknown'}`;
}

export function readSiteRepoConfig(env: Env = process.env): SiteRepoConfig {
  const token = env.VAULT_SITE_GITHUB_TOKEN?.trim() ?? '';
  if (!token) throw new SiteRepoConfigError('VAULT_SITE_GITHUB_TOKEN is not set: the portal cannot read or write the website repository.');
  const repo = env.VAULT_SITE_REPO?.trim() || DEFAULT_SITE_REPO;
  if (!REPO_RE.test(repo)) throw new SiteRepoConfigError(`VAULT_SITE_REPO must be owner/name, not "${repo}".`);
  const branch = siteBranchFor(env);
  if (!isBranchName(branch)) throw new SiteRepoConfigError(`VAULT_SITE_BRANCH "${branch}" is not a branch name.`);
  const apiBase = (env.VAULT_SITE_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(apiBase); } catch { throw new SiteRepoConfigError(`VAULT_SITE_API_BASE "${apiBase}" is not a URL.`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SiteRepoConfigError(`VAULT_SITE_API_BASE "${apiBase}" is not an http(s) URL.`);
  return { token, repo, branch, apiBase, author: commitIdentity(env) };
}
