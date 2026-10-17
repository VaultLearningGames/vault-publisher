// The blog's posts in the vault-site repository, as the portal's editor works with them: the S4 client
// (site-content/github-client.ts) plus the post-list cache, the post file mapping (front matter + Markdown body <->
// the editor's fields and blocks) and the rules the editor needs. A post is <blogDir>/<slug>/index.md on the
// configured branch (main); its blob SHA is the conflict check.
//   listPosts()                                   every post's slug, title, date, draft, private, tags, author, sha
//   getPost(slug)                                 { slug, sha, input, aliases } or null
//   savePost(slug, input, expectedSha, message)   creates (expectedSha null: the file must not exist) or updates
//   renamePost(old, new, input, expectedSha, message)  one commit: the folder moved, /blog/<old>/ added to aliases
//   deletePost(slug, expectedSha, message)        one commit removing the post's folder
// Every write is one commit. Errors: SaveConflictError (the SHA isn't the file's any more), PostSlugTakenError (create
// or rename onto a post that exists), SiteContentError (GitHub; status 0 for the network), SiteContentConfigError,
// FrontMatterError (a file whose front matter can't be read, on load or update).
import type { BlogPostInput } from './repo.ts';
import { isBlogSlug } from './slug.ts';
import {
  applyPostInput, createPostListCache, createSiteContentClient, parsePostFile, postInputFromFile, SaveConflictError, serializePostFile,
  SiteContentError, type PostListCache, type PostListEntry, type SiteContentClient,
} from '../site-content/index.ts';

export class PostSlugTakenError extends Error {
  readonly slug: string;
  constructor(slug: string) { super(`There is already a post at /blog/${slug}/.`); this.name = 'PostSlugTakenError'; this.slug = slug; }
}

export interface RepoPostSummary {
  slug: string; sha: string; title: string; date: string | null; draft: boolean; private: boolean; tags: string[]; author: string;
  parseError?: boolean; error?: string;
}

export interface RepoPost {
  slug: string;
  sha: string;
  input: BlogPostInput;
  aliases: string[];
}

export interface WriteOutcome { slug: string; sha: string; commit: string }

// A post's old address, as Hugo aliases take it.
export const aliasFor = (slug: string) => `/blog/${slug}/`;
const aliasSlug = (a: string) => /^\/?blog\/([^/]+)\/?$/.exec(a.trim())?.[1];

export class SiteBlogRepo {
  readonly client: SiteContentClient;
  readonly cache: PostListCache;

  constructor(o: { client?: SiteContentClient; cache?: PostListCache } = {}) {
    this.client = o.client ?? createSiteContentClient();
    this.cache = o.cache ?? createPostListCache({ client: this.client });
  }

  async listPosts(o?: { refresh?: boolean }): Promise<RepoPostSummary[]> {
    const entries = await this.cache.list(o);
    return entries.map(summary);
  }

  // Whether a post (or an old slug of one, which its aliases claim) is at `slug`; `except` is the post being renamed.
  async slugTaken(slug: string, except?: string): Promise<boolean> {
    const posts = await this.cache.list();
    return posts.some((p) => p.slug !== except && (p.slug === slug || (p.frontMatter?.aliases ?? []).some((a) => aliasSlug(a) === slug)));
  }

  async getPost(slug: string): Promise<RepoPost | null> {
    const got = await this.client.getPost(slug);
    if (!got) return null;
    const file = parsePostFile(got.raw);
    return { slug, sha: got.sha, input: postInputFromFile(slug, file), aliases: [...file.frontMatter.aliases] };
  }

  // The file at `slug` as loaded at expectedSha, parsed (for its layout and other front matter); conflict when it moved.
  private async loaded(slug: string, expectedSha: string) {
    const got = await this.client.getPost(slug);
    if (!got || got.sha !== expectedSha) throw new SaveConflictError(`${slug}/index.md`, got?.sha);
    return parsePostFile(got.raw);
  }

  async savePost(slug: string, input: Omit<BlogPostInput, 'slug'>, expectedSha: string | null, message: string): Promise<WriteOutcome> {
    checkSlug(slug);
    let raw: string;
    if (expectedSha === null) {
      if (await this.client.getPost(slug)) throw new PostSlugTakenError(slug);
      raw = serializePostFile(applyPostInput(input));
    } else {
      raw = serializePostFile(applyPostInput(input, await this.loaded(slug, expectedSha)));
    }
    let r;
    try { r = await this.client.putPost(slug, raw, { sha: expectedSha, message }); } catch (err) {
      // A create that lost a race: the file appeared meanwhile.
      if (expectedSha === null && err instanceof SaveConflictError) throw new PostSlugTakenError(slug);
      throw err;
    }
    this.cache.remember({ slug, path: r.path, sha: r.sha }, raw);
    return { slug, sha: r.sha, commit: r.commit };
  }

  async renamePost(oldSlug: string, newSlug: string, input: Omit<BlogPostInput, 'slug'>, expectedSha: string, message: string): Promise<WriteOutcome> {
    checkSlug(oldSlug); checkSlug(newSlug);
    const prev = await this.loaded(oldSlug, expectedSha);
    if (await this.client.getPost(newSlug)) throw new PostSlugTakenError(newSlug);
    const file = applyPostInput(input, prev);
    // The old address redirects to the new one; an alias for the new slug itself (a rename back) would loop.
    const aliases = file.frontMatter.aliases.filter((a) => aliasSlug(a) !== newSlug);
    if (!aliases.some((a) => aliasSlug(a) === oldSlug)) aliases.push(aliasFor(oldSlug));
    file.frontMatter = { ...file.frontMatter, aliases };
    const raw = serializePostFile(file);
    let r;
    try { r = await this.client.renamePost(oldSlug, newSlug, { sha: expectedSha, message, raw }); } catch (err) {
      if (err instanceof SiteContentError && err.code === 'slug_taken') throw new PostSlugTakenError(newSlug);
      throw err;
    }
    this.cache.forget(oldSlug);
    this.cache.remember({ slug: newSlug, path: r.path, sha: r.sha }, raw);
    return { slug: newSlug, sha: r.sha, commit: r.commit };
  }

  async deletePost(slug: string, expectedSha: string, message: string): Promise<{ commit: string }> {
    checkSlug(slug);
    const r = await this.client.deletePost(slug, { sha: expectedSha, message });
    this.cache.forget(slug);
    return r;
  }

  // Every existing tag whose name starts with `prefix` (case-insensitively), from the posts' front matter.
  async searchTags(prefix: string, limit = 10): Promise<string[]> {
    const p = prefix.toLowerCase();
    const seen = new Map<string, string>();
    for (const e of await this.cache.list()) for (const t of e.frontMatter?.tags ?? []) {
      if (t.toLowerCase().startsWith(p) && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).slice(0, limit);
  }
}

function checkSlug(slug: string) {
  if (!isBlogSlug(slug)) throw new SiteContentError(400, 'bad_slug', `"${String(slug).slice(0, 80)}" is not a blog slug.`);
}

function summary(e: PostListEntry): RepoPostSummary {
  const fm = e.frontMatter;
  if (!fm) return { slug: e.slug, sha: e.sha, title: e.slug, date: null, draft: false, private: false, tags: [], author: '', parseError: true, ...(e.error ? { error: e.error } : {}) };
  return { slug: e.slug, sha: e.sha, title: fm.title || e.slug, date: fm.draft ? null : fm.date, draft: fm.draft, private: fm.private, tags: [...fm.tags], author: fm.author };
}
