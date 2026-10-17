// The blog's Markdown files in the vault-site repository, through GitHub's REST API (config.ts says which repository,
// branch and folder). A post is <blogDir>/<slug>/index.md; its blob SHA is the conflict check: a write names the SHA
// it was loaded at and fails with SaveConflictError (the editor's 409) when the file has changed since.
//   listPosts()                       every post's slug, path and SHA (one request: the branch's tree)
//   getPost(slug)                     the file as text (UTF-8, as stored: a BOM and CRLF are kept), or null
//   getBlob(sha)                      a file's text by its blob SHA
//   putPost(slug, raw, {sha, message})  creates (sha null) or updates (sha as loaded) index.md: one commit
//   deletePost(slug, {sha, message})  removes the post's folder: one commit
//   renamePost(from, to, {sha, message, raw?})  moves the post's folder (and optionally writes new text): one commit
// The token is sent only in the Authorization header and is never logged; it is removed from any error message.
import { Buffer } from 'node:buffer';
import { checkSiteContentConfig, readSiteContentConfig, type SiteContentConfig } from './config.ts';
import { SaveConflictError, SiteContentConfigError, SiteContentError } from './errors.ts';

export interface PostRef { slug: string; path: string; sha: string }
export interface PostContent extends PostRef { raw: string }
export interface WriteResult { slug: string; path: string; sha: string; commit: string }

export interface SiteContentClient {
  listPosts(): Promise<PostRef[]>;
  getPost(slug: string): Promise<PostContent | null>;
  getBlob(sha: string): Promise<string>;
  putPost(slug: string, raw: string, o: { sha: string | null; message: string }): Promise<WriteResult>;
  deletePost(slug: string, o: { sha: string; message: string }): Promise<{ commit: string }>;
  renamePost(from: string, to: string, o: { sha: string; message: string; raw?: string }): Promise<WriteResult>;
}

export interface SiteContentClientOptions {
  fetch?: typeof fetch;
  // Settings to use instead of the environment (tests); checked on first use like the environment's.
  config?: Partial<SiteContentConfig>;
  env?: Record<string, string | undefined>;
}

const USER_AGENT = 'vault-portal';
const API_VERSION = '2022-11-28';
// Times a folder move or delete is retried when the branch moved between reading it and committing.
const REF_RETRIES = 3;

// A post's folder name: one path segment, nothing that could leave the blog folder.
export function isPostSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && s !== '.' && s !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(s);
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
// Buffer keeps a BOM (TextDecoder would drop it).
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

interface Res { status: number; json: unknown }
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

export function createSiteContentClient(opts: SiteContentClientOptions = {}): SiteContentClient {
  let cfg: SiteContentConfig | undefined;
  const conf = () => (cfg ??= opts.config ? checkSiteContentConfig(opts.config) : readSiteContentConfig(opts.env));
  const redact = (s: string) => {
    const t = cfg?.token;
    return t ? s.split(t).join('[redacted]') : s;
  };

  async function request(method: string, path: string, body?: unknown): Promise<Res> {
    const c = conf();
    const doFetch = opts.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(`${c.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new SiteContentError(0, 'network', redact(`GitHub ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  }

  function fail(method: string, path: string, r: Res): never {
    const msg = typeof obj(r.json).message === 'string' ? String(obj(r.json).message) : '';
    const code = r.status === 401 ? 'unauthorized' : r.status === 403 || r.status === 429 ? (/rate limit/i.test(msg) || r.status === 429 ? 'rate_limited' : 'forbidden')
      : r.status === 404 ? 'not_found' : 'github_error';
    throw new SiteContentError(r.status, code, redact(`GitHub ${method} ${path}: ${r.status}${msg ? ` ${msg}` : ''}`));
  }

  async function call(method: string, path: string, body?: unknown, ok: number[] = [200, 201]): Promise<Res> {
    const r = await request(method, path, body);
    if (!ok.includes(r.status)) fail(method, path, r);
    return r;
  }

  const repoPath = () => `/repos/${conf().repo}`;
  const postPath = (slug: string) => `${conf().blogDir}/${slug}/index.md`;
  const checkSlug = (slug: string) => {
    if (!isPostSlug(slug)) throw new SiteContentError(400, 'bad_slug', `"${String(slug).slice(0, 80)}" is not a post folder name.`);
  };
  const contentsUrl = (path: string, ref: string) => `${repoPath()}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`;

  async function getBlob(sha: string): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new SiteContentError(400, 'bad_sha', 'Not a blob SHA.');
    const r = await call('GET', `${repoPath()}/git/blobs/${sha}`, undefined, [200]);
    const j = obj(r.json);
    if (j.encoding === 'base64' && typeof j.content === 'string') return unb64(j.content);
    if (j.encoding === 'utf-8' && typeof j.content === 'string') return j.content;
    throw new SiteContentError(502, 'github_error', `GitHub returned blob ${sha} in an unknown encoding.`);
  }

  // A post's index.md at a ref; null when there is none.
  async function getAt(slug: string, ref: string): Promise<PostContent | null> {
    const path = postPath(slug);
    const r = await call('GET', contentsUrl(path, ref), undefined, [200, 404]);
    if (r.status === 404) return null;
    const j = obj(r.json);
    if (j.type !== 'file' || typeof j.sha !== 'string') return null;
    // Files over 1 MB come without content; their blob has it.
    const raw = j.encoding === 'base64' && typeof j.content === 'string' && (j.content !== '' || j.size === 0) ? unb64(j.content) : await getBlob(j.sha);
    return { slug, path, sha: j.sha, raw };
  }

  // A conflict, with the file's SHA now when it can be had.
  async function conflict(slug: string): Promise<SaveConflictError> {
    const cur = await getAt(slug, conf().branch).catch(() => null);
    return new SaveConflictError(postPath(slug), cur?.sha);
  }

  async function listPosts(): Promise<PostRef[]> {
    const c = conf();
    const r = await call('GET', `${repoPath()}/git/trees/${encPath(c.branch)}?recursive=1`, undefined, [200]);
    const j = obj(r.json);
    const prefix = `${c.blogDir}/`;
    let posts: PostRef[];
    if (j.truncated !== true && Array.isArray(j.tree)) {
      posts = [];
      for (const e of j.tree.map(obj)) {
        if (e.type !== 'blob' || typeof e.path !== 'string' || typeof e.sha !== 'string' || !e.path.startsWith(prefix)) continue;
        const m = /^([^/]+)\/index\.md$/.exec(e.path.slice(prefix.length));
        if (m && isPostSlug(m[1])) posts.push({ slug: m[1], path: e.path, sha: e.sha });
      }
    } else {
      // Too big a tree for one answer: the blog folder, then each post's index.md.
      const d = await call('GET', contentsUrl(c.blogDir, c.branch), undefined, [200, 404]);
      const dirs = d.status === 404 || !Array.isArray(d.json) ? [] : d.json.map(obj).filter((e) => e.type === 'dir' && isPostSlug(e.name));
      posts = [];
      for (const dir of dirs) {
        const slug = String(dir.name);
        const f = await call('GET', contentsUrl(postPath(slug), c.branch), undefined, [200, 404]);
        const fj = obj(f.json);
        if (f.status === 200 && fj.type === 'file' && typeof fj.sha === 'string') posts.push({ slug, path: postPath(slug), sha: fj.sha });
      }
    }
    return posts.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  async function getPost(slug: string): Promise<PostContent | null> {
    checkSlug(slug);
    return getAt(slug, conf().branch);
  }

  async function putPost(slug: string, raw: string, o: { sha: string | null; message: string }): Promise<WriteResult> {
    checkSlug(slug);
    const c = conf();
    const path = postPath(slug);
    const r = await request('PUT', `${repoPath()}/contents/${encPath(path)}`,
      { message: o.message, content: b64(raw), branch: c.branch, ...(o.sha ? { sha: o.sha } : {}) });
    // 409: the SHA is not the file's; 422: "sha" missing (the file exists) or wrong; 404 with a SHA: the file is gone.
    const msg = String(obj(r.json).message ?? '');
    if (r.status === 409 || (r.status === 422 && /sha/i.test(msg)) || (r.status === 404 && o.sha)) throw await conflict(slug);
    if (r.status !== 200 && r.status !== 201) fail('PUT', path, r);
    const j = obj(r.json);
    return { slug, path, sha: String(obj(j.content).sha ?? ''), commit: String(obj(j.commit).sha ?? '') };
  }

  // Every file under a folder at a commit: [path, sha, mode]. null: no such folder.
  async function filesUnder(dir: string, ref: string): Promise<{ path: string; sha: string; mode: string }[] | null> {
    const r = await call('GET', contentsUrl(dir, ref), undefined, [200, 404]);
    if (r.status === 404 || !Array.isArray(r.json)) return null;
    const out: { path: string; sha: string; mode: string }[] = [];
    for (const e of r.json.map(obj)) {
      if (typeof e.path !== 'string' || typeof e.sha !== 'string') continue;
      if (e.type === 'dir') out.push(...(await filesUnder(e.path, ref)) ?? []);
      else if (e.type === 'file') out.push({ path: e.path, sha: e.sha, mode: '100644' });
      else if (e.type === 'symlink') out.push({ path: e.path, sha: e.sha, mode: '120000' });
      else throw new SiteContentError(422, 'unsupported', `${e.path} is a ${String(e.type)}; posts can only hold files.`);
    }
    return out;
  }

  // One commit on the branch built from the head: `change` reads the head (checking SHAs) and returns tree entries.
  // Retried from the start when the branch moved meanwhile, so the checks always hold for the commit's parent.
  async function commitChange(slug: string, message: string, change: (head: string) => Promise<Json[]>): Promise<string> {
    const c = conf();
    const refPath = `${repoPath()}/git/refs/heads/${encPath(c.branch)}`;
    for (let attempt = 0; ; attempt++) {
      const ref = await call('GET', `${repoPath()}/git/ref/heads/${encPath(c.branch)}`, undefined, [200]);
      const head = String(obj(obj(ref.json).object).sha ?? '');
      const commit = await call('GET', `${repoPath()}/git/commits/${head}`, undefined, [200]);
      const baseTree = String(obj(obj(commit.json).tree).sha ?? '');
      const entries = await change(head);
      const tree = await call('POST', `${repoPath()}/git/trees`, { base_tree: baseTree, tree: entries });
      const made = await call('POST', `${repoPath()}/git/commits`, { message, tree: String(obj(tree.json).sha ?? ''), parents: [head] });
      const sha = String(obj(made.json).sha ?? '');
      const upd = await request('PATCH', refPath, { sha, force: false });
      if (upd.status === 200) return sha;
      if (upd.status !== 422 && upd.status !== 409) fail('PATCH', refPath, upd);
      if (attempt + 1 >= REF_RETRIES) throw await conflict(slug);
    }
  }

  // The post's files at a commit, after checking index.md is at the SHA the caller loaded.
  async function loadedFiles(slug: string, sha: string, head: string) {
    const files = await filesUnder(`${conf().blogDir}/${slug}`, head);
    const index = files?.find((f) => f.path === postPath(slug));
    if (!files || !index || index.sha !== sha) throw await conflict(slug);
    return files;
  }

  async function deletePost(slug: string, o: { sha: string; message: string }): Promise<{ commit: string }> {
    checkSlug(slug);
    const commit = await commitChange(slug, o.message, async (head) =>
      (await loadedFiles(slug, o.sha, head)).map((f) => ({ path: f.path, mode: f.mode, type: 'blob', sha: null })));
    return { commit };
  }

  async function renamePost(from: string, to: string, o: { sha: string; message: string; raw?: string }): Promise<WriteResult> {
    checkSlug(from); checkSlug(to);
    if (from === to) throw new SiteContentError(400, 'bad_slug', 'A post is renamed to a different slug.');
    const blogDir = conf().blogDir;
    let indexSha = o.sha;
    if (o.raw !== undefined) {
      const blob = await call('POST', `${repoPath()}/git/blobs`, { content: b64(o.raw), encoding: 'base64' });
      indexSha = String(obj(blob.json).sha ?? '');
    }
    const commit = await commitChange(from, o.message, async (head) => {
      const files = await loadedFiles(from, o.sha, head);
      if (await filesUnder(`${blogDir}/${to}`, head)) throw new SiteContentError(409, 'slug_taken', `There is already a post at ${blogDir}/${to}.`);
      const oldPrefix = `${blogDir}/${from}/`, newPrefix = `${blogDir}/${to}/`;
      return files.flatMap((f) => [
        { path: newPrefix + f.path.slice(oldPrefix.length), mode: f.mode, type: 'blob', sha: f.path === postPath(from) ? indexSha : f.sha },
        { path: f.path, mode: f.mode, type: 'blob', sha: null },
      ]);
    });
    return { slug: to, path: postPath(to), sha: indexSha, commit };
  }

  // Errors carry no token: config errors never include it, and GitHub's messages are redacted above.
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try { return await fn(...a); } catch (err) {
      if (err instanceof SiteContentError || err instanceof SaveConflictError || err instanceof SiteContentConfigError) throw err;
      throw new SiteContentError(0, 'internal', redact(err instanceof Error ? err.message : String(err)));
    }
  };

  return {
    listPosts: guard(listPosts), getPost: guard(getPost), getBlob: guard(getBlob), putPost: guard(putPost),
    deletePost: guard(deletePost), renamePost: guard(renamePost),
  };
}
