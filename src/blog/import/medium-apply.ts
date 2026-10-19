// Applying the Medium snapshot (data/blog-import/medium/medium-posts.json, import/medium.ts) to vault-site: each post
// becomes content/blog/<slug>/index.md, published with its original date and byline, written the way the portal's
// editor writes it, with `import_source: "medium:<id>"` in its front matter. Unlike the Squarespace import, no other
// post is ever changed or deleted.
// Idempotent: a post is found again by its marker, whatever its slug, and is never overwritten ("unchanged" when it is
// what the import would write, else "kept": edited since). A slug already used by a post that isn't this import's gets
// "-fdl" (then -2, -3, ...), and links between imported posts follow it. Rollback deletes exactly the posts with a
// "medium:" marker.
import { validateBlocks } from '../blocks.ts';
import { isBlogSlug, MAX_SLUG, uniqueSlug } from '../slug.ts';
import { applyPostInput, serializePostFile } from '../../site-content/post-file.ts';
import type { PostFile } from '../../site-content/post-file.ts';
import { SOURCE_PREFIX, sourceMarker, type MediumRecord, type MediumSnapshot } from './medium.ts';
import { recordInput } from './squarespace.ts';

export interface MediumExistingPost { slug: string; source: string | null }

export interface MediumTarget {
  // Every post there is, and its import_source (null for none).
  list(): Promise<MediumExistingPost[]>;
  read(slug: string): Promise<string | null>;
  create(slug: string, raw: string): Promise<void>;
  remove(slug: string): Promise<void>;
}

export type MediumOutcome = 'created' | 'unchanged' | 'kept' | 'deleted' | 'error';
export interface MediumReport {
  results: { slug: string; sourceUrl?: string; outcome: MediumOutcome; error?: string }[];
  counts: Record<MediumOutcome, number>;
}

// A front matter value in the form the file keeps verbatim (frontmatter.ts `extra`).
const quoted = (s: string) => JSON.stringify(s);

// The import_source a post file's front matter carries (unquoted), or null.
export function importSourceOf(fm: PostFile['frontMatter']): string | null {
  const raw = fm.extra.import_source;
  if (raw === undefined) return null;
  const v = raw.replace(/^import_source\s*:\s*/, '').trim();
  try { return v.startsWith('"') ? String(JSON.parse(v)) : v.replace(/^'(.*)'$/, '$1'); } catch { return v; }
}

export function isMediumImport(source: string | null): boolean {
  return !!source && source.startsWith(SOURCE_PREFIX);
}

// A snapshot read from JSON, checked: every post a blog slug (each once), a Medium id (each once) and valid blocks.
export function checkMediumSnapshot(value: unknown): MediumSnapshot {
  const s = value as MediumSnapshot;
  if (!s || typeof s !== 'object' || s.version !== 1 || s.kind !== 'medium' || !Array.isArray(s.posts) || typeof s.fetchedAt !== 'string') {
    throw new Error('not a Medium import snapshot (version 1)');
  }
  const slugs = new Set<string>();
  const ids = new Set<string>();
  for (const p of s.posts) {
    if (!isBlogSlug(p.slug)) throw new Error(`"${String(p.slug)}" is not a blog slug`);
    if (slugs.has(p.slug)) throw new Error(`${p.slug} is in the snapshot twice`);
    if (typeof p.mediumId !== 'string' || !/^[0-9a-f]{8,16}$/.test(p.mediumId)) throw new Error(`${p.slug}: no Medium id`);
    if (ids.has(p.mediumId)) throw new Error(`Medium post ${p.mediumId} is in the snapshot twice`);
    slugs.add(p.slug); ids.add(p.mediumId);
    const r = validateBlocks(p.blocks);
    if (!r.ok) throw new Error(`${p.slug}: invalid blocks: ${r.errors.slice(0, 3).join('; ')}`);
    if (!p.title || typeof p.publishedAt !== 'string' || Number.isNaN(Date.parse(p.publishedAt))) throw new Error(`${p.slug}: a title and a publish date are required`);
    if (!p.author_name) throw new Error(`${p.slug}: an author is required`);
  }
  return s;
}

// The post's index.md as the import writes it.
export function mediumPostFile(r: MediumRecord): string {
  const post = applyPostInput(recordInput(r));
  post.frontMatter.extra.import_source = `import_source: ${quoted(sourceMarker(r.mediumId))}`;
  post.frontMatter.extra.import_source_url = `import_source_url: ${quoted(r.sourceUrl)}`;
  return serializePostFile(post);
}

// Where each snapshot post goes (snapshot slug -> blog slug): its earlier import's slug, else its own unless another
// post has it (then "-fdl", -2, ...).
export function planSlugs(snapshot: Pick<MediumSnapshot, 'posts'>, existing: MediumExistingPost[]): Map<string, string> {
  const bySource = new Map(existing.filter((p) => p.source).map((p) => [p.source!, p.slug]));
  const taken = new Set(existing.map((p) => p.slug));
  const plan = new Map<string, string>();
  for (const p of snapshot.posts) {
    const had = bySource.get(sourceMarker(p.mediumId));
    if (had) plan.set(p.slug, had);
  }
  for (const s of plan.values()) taken.add(s);
  for (const p of [...snapshot.posts].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
    if (plan.has(p.slug)) continue;
    let slug = p.slug;
    if (taken.has(slug)) {
      const base = `${p.slug.slice(0, MAX_SLUG - 4).replace(/-+$/, '')}-fdl`;
      slug = uniqueSlug(base, (s) => taken.has(s));
    }
    taken.add(slug);
    plan.set(p.slug, slug);
  }
  return plan;
}

// The record with its planned slug, and links to other imported posts pointing at theirs.
function relink(r: MediumRecord, plan: Map<string, string>): MediumRecord {
  const moved = [...plan].filter(([from, to]) => from !== to);
  if (!moved.length) return r;
  let json = JSON.stringify(r.blocks);
  for (const [from, to] of moved) json = json.replaceAll(new RegExp(`/blog/${from}/(?=\\\\?")`, 'g'), `/blog/${to}/`);
  return { ...r, slug: plan.get(r.slug) ?? r.slug, blocks: JSON.parse(json) };
}

const count = (results: MediumReport['results']) => {
  const counts: Record<MediumOutcome, number> = { created: 0, unchanged: 0, kept: 0, deleted: 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  return { results, counts };
};

export async function applyMediumImport(snapshot: MediumSnapshot, target: MediumTarget, o: { dryRun?: boolean } = {}): Promise<MediumReport> {
  const results: MediumReport['results'] = [];
  const existing = await target.list();
  const plan = planSlugs(snapshot, existing);
  for (const post of snapshot.posts) {
    const slug = plan.get(post.slug)!;
    try {
      const raw = mediumPostFile(relink(post, plan));
      const now = await target.read(slug);
      if (now === null) {
        if (!o.dryRun) await target.create(slug, raw);
        results.push({ slug, sourceUrl: post.sourceUrl, outcome: 'created' });
      } else {
        results.push({ slug, sourceUrl: post.sourceUrl, outcome: now === raw ? 'unchanged' : 'kept' });
      }
    } catch (err) {
      results.push({ slug, sourceUrl: post.sourceUrl, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return count(results);
}

// Deletes every post the Medium import wrote (a "medium:" import_source), and nothing else.
export async function rollbackMediumImport(target: MediumTarget, o: { dryRun?: boolean } = {}): Promise<MediumReport> {
  const results: MediumReport['results'] = [];
  for (const p of (await target.list()).filter((x) => isMediumImport(x.source)).sort((a, b) => a.slug.localeCompare(b.slug))) {
    try {
      if (!o.dryRun) await target.remove(p.slug);
      results.push({ slug: p.slug, outcome: 'deleted' });
    } catch (err) {
      results.push({ slug: p.slug, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return count(results);
}
