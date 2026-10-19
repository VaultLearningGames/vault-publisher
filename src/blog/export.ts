// The one-time export of the portal's old blog tables (db.ts v17: blog_posts, blog_tags, blog_post_tags,
// blog_slug_redirects; retired_blog_* once retireBlogTables has run) to Markdown files in vault-site,
// content/blog/<slug>/index.md, written the way the portal's editor writes them (site-content/post-file.ts). A post's
// tags become its `tags` (their names), its old slugs its `aliases` (/blog/<old>/).
// Idempotent and safe to repeat: a post whose file already exists is never overwritten. It is "unchanged" when the
// file is what the export would write, else "kept" (edited since, in the portal or by hand). A second run writes nothing.
// scripts/export-blog.ts runs it against a vault-site checkout or the repository on GitHub.
import type { DatabaseSync } from 'node:sqlite';
import { validateBlocks } from './blocks.ts';
import type { BlogPostInput, BlogStatus } from './repo.ts';
import { aliasFor } from './siteRepo.ts';
import { isBlogSlug } from './slug.ts';
import { applyPostInput, serializePostFile } from '../site-content/post-file.ts';

export interface ExportPost { input: BlogPostInput; aliases: string[] }
export interface ExportProblem { slug: string; error: string }

// The blog tables' names in this database: the originals, or the retired copies; null when there are neither.
export function blogTables(sqlite: DatabaseSync): { posts: string; tags: string; postTags: string; redirects: string } | null {
  const has = (t: string) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  for (const p of ['', 'retired_']) {
    if (has(`${p}blog_posts`)) {
      return { posts: `${p}blog_posts`, tags: `${p}blog_tags`, postTags: `${p}blog_post_tags`, redirects: `${p}blog_slug_redirects` };
    }
  }
  return null;
}

interface PostRow {
  id: number; slug: string; title: string; blocks: string; excerpt: string; featured_image: string | null; author: string;
  status: string; published_at: string | null;
}

// Every post in the tables, as the editor's fields plus its aliases, in slug order. Posts that can't be exported
// (a bad slug or body) are returned as problems instead.
export function readBlogPosts(sqlite: DatabaseSync): { posts: ExportPost[]; problems: ExportProblem[] } {
  const t = blogTables(sqlite);
  if (!t) return { posts: [], problems: [] };
  const has = (name: string) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const rows = sqlite.prepare(`SELECT id, slug, title, blocks, excerpt, featured_image, author, status, published_at FROM ${t.posts} ORDER BY slug`).all() as unknown as PostRow[];
  const tagsOf = has(t.tags) && has(t.postTags)
    ? sqlite.prepare(`SELECT g.name FROM ${t.postTags} pt JOIN ${t.tags} g ON g.id = pt.tag_id WHERE pt.post_id = ? ORDER BY g.name COLLATE NOCASE, g.name`)
    : null;
  const oldSlugsOf = has(t.redirects) ? sqlite.prepare(`SELECT old_slug FROM ${t.redirects} WHERE post_id = ? ORDER BY old_slug`) : null;
  const posts: ExportPost[] = [];
  const problems: ExportProblem[] = [];
  for (const r of rows) {
    if (!isBlogSlug(r.slug)) { problems.push({ slug: r.slug, error: 'not a blog slug' }); continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(r.blocks); } catch { problems.push({ slug: r.slug, error: 'its blocks are not JSON' }); continue; }
    const checked = validateBlocks(parsed);
    if (!checked.ok) { problems.push({ slug: r.slug, error: `its blocks are invalid: ${checked.errors.slice(0, 3).join('; ')}` }); continue; }
    const tags = tagsOf ? (tagsOf.all(r.id) as { name: string }[]).map((x) => x.name) : [];
    const aliases = oldSlugsOf
      ? (oldSlugsOf.all(r.id) as { old_slug: string }[]).map((x) => x.old_slug).filter((s) => s !== r.slug).map(aliasFor)
      : [];
    posts.push({
      input: {
        slug: r.slug, title: r.title, blocks: checked.blocks, excerpt: r.excerpt ?? '', featured_image: r.featured_image || null,
        author: r.author ?? '', status: (r.status === 'private' ? 'private' : 'published') satisfies BlogStatus,
        published_at: r.published_at || null, tags: [...new Set(tags)],
      },
      aliases,
    });
  }
  return { posts, problems };
}

// The post's index.md, as the export writes it.
export function exportPostFile(post: ExportPost): string {
  const { slug: _slug, ...input } = post.input;
  const file = applyPostInput(input);
  file.frontMatter = { ...file.frontMatter, aliases: [...post.aliases] };
  return serializePostFile(file);
}

// Where posts are written: a vault-site checkout's folder, or the repository through the Contents API.
export interface ExportTarget {
  // The post's file as it is now, or null when there is none.
  read(slug: string): Promise<string | null>;
  create(slug: string, raw: string): Promise<void>;
}

export type ExportOutcome = 'created' | 'unchanged' | 'kept' | 'error';
export interface ExportReport {
  results: { slug: string; outcome: ExportOutcome; error?: string }[];
  counts: Record<ExportOutcome, number>;
}

export async function exportBlog(sqlite: DatabaseSync, target: ExportTarget, o: { dryRun?: boolean } = {}): Promise<ExportReport> {
  const { posts, problems } = readBlogPosts(sqlite);
  const results: ExportReport['results'] = problems.map((p) => ({ slug: p.slug, outcome: 'error' as const, error: p.error }));
  for (const post of posts) {
    const slug = post.input.slug;
    try {
      const raw = exportPostFile(post);
      const now = await target.read(slug);
      if (now === null) {
        if (!o.dryRun) await target.create(slug, raw);
        results.push({ slug, outcome: 'created' });
      } else {
        results.push({ slug, outcome: now === raw ? 'unchanged' : 'kept' });
      }
    } catch (err) {
      results.push({ slug, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  results.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const counts: Record<ExportOutcome, number> = { created: 0, unchanged: 0, kept: 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  return { results, counts };
}
