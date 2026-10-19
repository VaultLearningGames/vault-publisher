// SiteRepo over GitHub's REST API (git data), as the bot user whose token VAULT_SITE_GITHUB_TOKEN is (config.ts).
// commitChanges: read heads/<branch>, make a blob per written file, a tree on the head's tree, a commit whose parent is
// the head (author and committer: the bot; the message ends with the Portal-User trailer), then move the branch with
// force=false. When the branch moved meanwhile (422/409), the tree is rebuilt on the new head, at most 3 times, then
// SiteRepoConflictError. Reads are kept 30 s per branch and path; a commit forgets them.
// The token goes only in the Authorization header; it is never logged and is cut out of every error message.
import { Buffer } from 'node:buffer';
import { readSiteRepoConfig, sitePublishingEnabled, withPortalUserTrailer, type SiteRepoConfig } from './config.ts';
import { checkSitePath, SITE_CONTENT_ROOTS } from './paths.ts';
import {
  SitePathError, SitePublishingDisabledError, SiteRepoConfigError, SiteRepoConflictError, SiteRepoError,
  type CommitRequest, type SiteEntry, type SiteFile, type SiteRepo,
} from './types.ts';

export interface GitHubSiteRepoOptions {
  fetch?: typeof fetch;
  // Settings instead of the environment's (tests).
  config?: SiteRepoConfig;
  env?: Record<string, string | undefined>;
  roots?: readonly string[];
  cacheMs?: number;
  now?: () => number;
}

const USER_AGENT = 'vault-portal';
const API_VERSION = '2022-11-28';
export const COMMIT_ATTEMPTS = 3;
export const READ_CACHE_MS = 30_000;
const MAX_CHANGES = 500;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export class GitHubSiteRepo implements SiteRepo {
  private cfg?: SiteRepoConfig;
  private readonly opts: GitHubSiteRepoOptions;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(opts: GitHubSiteRepoOptions = {}) {
    this.opts = opts;
    if (opts.config) this.cfg = opts.config;
  }

  private conf(): SiteRepoConfig {
    return (this.cfg ??= readSiteRepoConfig(this.opts.env));
  }

  get branch(): string { return this.conf().branch; }

  private redact(s: string): string {
    const t = this.cfg?.token;
    return t ? s.split(t).join('[redacted]') : s;
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const c = this.conf();
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(`${c.apiBase}/repos/${c.repo}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new SiteRepoError(0, 'network', this.redact(`GitHub ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  private async call(method: string, path: string, body?: unknown, ok: number[] = [200, 201]) {
    const r = await this.request(method, path, body);
    if (!ok.includes(r.status)) this.fail(method, path, r);
    return r;
  }

  private fail(method: string, path: string, r: { status: number; json: unknown }): never {
    const msg = typeof obj(r.json).message === 'string' ? String(obj(r.json).message) : '';
    const code = r.status === 401 ? 'unauthorized' : r.status === 429 || (r.status === 403 && /rate limit/i.test(msg)) ? 'rate_limited'
      : r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found' : 'github_error';
    throw new SiteRepoError(r.status, code, this.redact(`GitHub ${method} ${path}: ${r.status}${msg ? ` ${msg}` : ''}`));
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    const ttl = this.opts.cacheMs ?? READ_CACHE_MS;
    if (hit && this.now() - hit.at < ttl) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (err) {
      if (err instanceof SiteRepoError || err instanceof SiteRepoConfigError) throw err;
      throw new SiteRepoError(0, 'internal', this.redact(err instanceof Error ? err.message : String(err)));
    }
  }

  private roots() { return this.opts.roots ?? SITE_CONTENT_ROOTS; }

  headSha(): Promise<string> {
    return this.guard(async () => {
      const r = await this.call('GET', `/git/ref/heads/${encPath(this.branch)}`, undefined, [200]);
      const sha = String(obj(obj(r.json).object).sha ?? '');
      if (!sha) throw new SiteRepoError(502, 'github_error', `GitHub gave no commit for the ${this.branch} branch.`);
      return sha;
    });
  }

  readFile(path: string): Promise<SiteFile | null> {
    return this.guard(async () => {
      const p = checkSitePath(path, this.roots());
      return this.cached(`file:${this.branch}:${p}`, async () => {
        const r = await this.call('GET', `/contents/${encPath(p)}?ref=${encodeURIComponent(this.branch)}`, undefined, [200, 404]);
        if (r.status === 404) return null;
        const j = obj(r.json);
        if (j.type !== 'file' || typeof j.sha !== 'string') return null;
        // Files over 1 MB come without content; their blob has it.
        const content = j.encoding === 'base64' && typeof j.content === 'string' && (j.content !== '' || j.size === 0)
          ? Buffer.from(j.content, 'base64').toString('utf8') : await this.blob(j.sha);
        return { content, sha: j.sha };
      });
    });
  }

  private async blob(sha: string): Promise<string> {
    const r = await this.call('GET', `/git/blobs/${encodeURIComponent(sha)}`, undefined, [200]);
    const j = obj(r.json);
    if (j.encoding === 'base64' && typeof j.content === 'string') return Buffer.from(j.content, 'base64').toString('utf8');
    if (j.encoding === 'utf-8' && typeof j.content === 'string') return j.content;
    throw new SiteRepoError(502, 'github_error', `GitHub returned blob ${sha} in an unknown encoding.`);
  }

  listDir(prefix: string): Promise<SiteEntry[]> {
    return this.guard(async () => {
      const dir = checkSitePath(prefix, this.roots(), { dir: true });
      return this.cached(`dir:${this.branch}:${dir}`, async () => {
        const r = await this.call('GET', `/git/trees/${encPath(this.branch)}?recursive=1`, undefined, [200]);
        const j = obj(r.json);
        if (j.truncated === true || !Array.isArray(j.tree))
          throw new SiteRepoError(502, 'too_large', 'The website repository is too large to list in one request.');
        const out: SiteEntry[] = [];
        for (const e of j.tree.map(obj)) {
          if (e.type === 'blob' && typeof e.path === 'string' && typeof e.sha === 'string' && e.path.startsWith(`${dir}/`)) out.push({ path: e.path, sha: e.sha });
        }
        return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      });
    });
  }

  commitChanges(req: CommitRequest): Promise<{ commitSha: string }> {
    return this.guard(async () => {
      // Read on every write, so turning publishing off takes effect at once.
      if (!sitePublishingEnabled(this.opts.env)) throw new SitePublishingDisabledError();
      if (!Array.isArray(req.changes) || req.changes.length === 0) throw new SitePathError('A commit needs at least one change.');
      if (req.changes.length > MAX_CHANGES) throw new SitePathError(`At most ${MAX_CHANGES} files change in one commit.`);
      const seen = new Set<string>();
      const changes = req.changes.map((ch) => {
        const path = checkSitePath(ch.path, this.roots());
        if (seen.has(path)) throw new SitePathError(`${path} is changed twice in one commit.`);
        seen.add(path);
        if (ch.content !== null && typeof ch.content !== 'string') throw new SitePathError(`${path}: the content must be text, or null to delete.`);
        return { path, content: ch.content };
      });
      const c = this.conf();
      const message = withPortalUserTrailer(String(req.message ?? ''), String(req.portalUser ?? ''));
      // The blobs don't depend on the head: made once, reused by every attempt.
      const blobs = new Map<string, string>();
      for (const ch of changes) if (ch.content !== null) {
        const b = await this.call('POST', '/git/blobs', { content: Buffer.from(ch.content, 'utf8').toString('base64'), encoding: 'base64' });
        blobs.set(ch.path, String(obj(b.json).sha ?? ''));
      }
      const tree = changes.map((ch) => ({ path: ch.path, mode: '100644', type: 'blob', sha: ch.content === null ? null : blobs.get(ch.path)! }));
      const when = new Date(this.now()).toISOString();
      const identity = { name: c.author.name, email: c.author.email, date: when };
      try {
        for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
          const head = await this.headSha();
          const commit = await this.call('GET', `/git/commits/${head}`, undefined, [200]);
          const baseTree = String(obj(obj(commit.json).tree).sha ?? '');
          // Deleting a file the head doesn't have is a no-op for us, an error for GitHub: leave it out.
          const entries = [];
          for (const e of tree) if (e.sha !== null || await this.existsAt(e.path, head)) entries.push(e);
          if (entries.length === 0) return { commitSha: head };
          const t = await this.call('POST', '/git/trees', { base_tree: baseTree, tree: entries });
          const made = await this.call('POST', '/git/commits',
            { message, tree: String(obj(t.json).sha ?? ''), parents: [head], author: identity, committer: identity });
          const sha = String(obj(made.json).sha ?? '');
          const refPath = `/git/refs/heads/${encPath(c.branch)}`;
          const upd = await this.request('PATCH', refPath, { sha, force: false });
          if (upd.status === 200) return { commitSha: sha };
          if (upd.status !== 422 && upd.status !== 409) this.fail('PATCH', refPath, upd);
        }
        throw new SiteRepoConflictError(c.branch);
      } finally {
        this.cache.clear();
      }
    });
  }

  private async existsAt(path: string, ref: string): Promise<boolean> {
    const r = await this.call('GET', `/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`, undefined, [200, 404]);
    return r.status === 200;
  }
}
