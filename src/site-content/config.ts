// Where the blog's Markdown lives: the vault-site repository on GitHub. Read from the environment when a client is
// first used, never at import, so the portal boots (and its tests run) without any of these set.
//   VAULT_SITE_GITHUB_TOKEN  a token that may read and write the repository's contents (required, at call time)
//   VAULT_SITE_REPO          owner/name (default VaultLearningGames/vault-site)
//   VAULT_SITE_BRANCH        the branch posts are read from and committed to (default: this system's, "staging" or
//                            "production"; site-repo/config.ts siteBranchFor). A commit there deploys the site.
//   VAULT_SITE_BLOG_DIR      the posts' folder: <dir>/<slug>/index.md (default content/blog)
//   VAULT_SITE_API_BASE      the GitHub API (default https://api.github.com)
//   SITE_COMMIT_AUTHOR_NAME/_EMAIL  the commits' author and committer (default the vault-portal-bot user)
// SITE_PUBLISHING_ENABLED=false refuses every write (github-client.ts; read on each write).
import { commitIdentity, isBranchName, siteBranchFor, STAGING_SITE_BRANCH, type CommitIdentity, DEFAULT_COMMIT_AUTHOR } from '../site-repo/config.ts';
import { SiteRepoConfigError } from '../site-repo/types.ts';
import { SiteContentConfigError } from './errors.ts';

export interface SiteContentConfig {
  token: string;
  repo: string;
  branch: string;
  blogDir: string;
  apiBase: string;
  author: CommitIdentity;
}

export const DEFAULT_REPO = 'VaultLearningGames/vault-site';
export const DEFAULT_BRANCH = STAGING_SITE_BRANCH;
export const DEFAULT_BLOG_DIR = 'content/blog';
export const DEFAULT_API_BASE = 'https://api.github.com';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// The settings, checked. Throws SiteContentConfigError when the token is missing or a setting is malformed.
export function readSiteContentConfig(env: Record<string, string | undefined> = process.env): SiteContentConfig {
  let author: CommitIdentity;
  try { author = commitIdentity(env); } catch (err) {
    throw err instanceof SiteRepoConfigError ? new SiteContentConfigError(err.message) : err;
  }
  return checkSiteContentConfig({
    token: env.VAULT_SITE_GITHUB_TOKEN?.trim() ?? '',
    repo: env.VAULT_SITE_REPO?.trim() || DEFAULT_REPO,
    branch: siteBranchFor(env),
    author,
    blogDir: env.VAULT_SITE_BLOG_DIR?.trim() || DEFAULT_BLOG_DIR,
    apiBase: env.VAULT_SITE_API_BASE?.trim() || DEFAULT_API_BASE,
  });
}

export function checkSiteContentConfig(c: Partial<SiteContentConfig>): SiteContentConfig {
  if (!c.token) throw new SiteContentConfigError('VAULT_SITE_GITHUB_TOKEN is not set: the portal cannot read or write the website repository.');
  const repo = c.repo || DEFAULT_REPO;
  if (!REPO_RE.test(repo)) throw new SiteContentConfigError(`VAULT_SITE_REPO must be owner/name, not "${repo}".`);
  const branch = c.branch || DEFAULT_BRANCH;
  if (!isBranchName(branch)) throw new SiteContentConfigError(`VAULT_SITE_BRANCH "${branch}" is not a branch name.`);
  const blogDir = (c.blogDir || DEFAULT_BLOG_DIR).replace(/^\/+|\/+$/g, '');
  if (!blogDir || blogDir.split('/').some((s) => s === '' || s === '.' || s === '..'))
    throw new SiteContentConfigError(`VAULT_SITE_BLOG_DIR "${c.blogDir}" is not a folder in the repository.`);
  const apiBase = (c.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(apiBase); } catch { throw new SiteContentConfigError(`VAULT_SITE_API_BASE "${apiBase}" is not a URL.`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SiteContentConfigError(`VAULT_SITE_API_BASE "${apiBase}" is not an http(s) URL.`);
  return { token: c.token, repo, branch, blogDir, apiBase, author: c.author ?? DEFAULT_COMMIT_AUTHOR };
}
