// Applying the Squarespace snapshot (data/blog-import/squarespace-posts.json, import/squarespace.ts) to vault-site:
// each imported post becomes content/blog/<slug>/index.md, written the way the portal's editor writes it, and the
// placeholder posts are deleted (hard delete: their folders are removed).
// Idempotent and safe to repeat, like the export (blog/export.ts): a post whose file already exists is never
// overwritten ("unchanged" when it is what the import would write, else "kept": edited since). Placeholders are the
// posts that were there before the import: not imported, and dated before the snapshot was taken (or undated);
// `keep` spares some. A second run writes nothing, and a post written after the snapshot is never a placeholder.
// scripts/import-squarespace-blog.ts runs it against a vault-site checkout or the repository on GitHub.
import { validateBlocks } from '../blocks.ts';
import { isBlogSlug } from '../slug.ts';
import { applyPostInput, serializePostFile } from '../../site-content/post-file.ts';
import { recordInput, type ImportRecord, type ImportSnapshot } from './squarespace.ts';

export interface ExistingPost { slug: string; date: string | null }

// Where posts are written: a vault-site checkout's folder, or the repository through the Contents API.
export interface ImportTarget {
  list(): Promise<ExistingPost[]>;
  // The post's file as it is now, or null when there is none.
  read(slug: string): Promise<string | null>;
  create(slug: string, raw: string): Promise<void>;
  remove(slug: string): Promise<void>;
}

export type ImportOutcome = 'created' | 'unchanged' | 'kept' | 'deleted' | 'error';
export interface ImportReport {
  results: { slug: string; outcome: ImportOutcome; error?: string }[];
  counts: Record<ImportOutcome, number>;
}

// A snapshot read from JSON, checked: every post a blog slug (each once) with valid blocks.
export function checkSnapshot(value: unknown): ImportSnapshot {
  const s = value as ImportSnapshot;
  if (!s || typeof s !== 'object' || s.version !== 1 || !Array.isArray(s.posts) || typeof s.fetchedAt !== 'string') {
    throw new Error('not a Squarespace import snapshot (version 1)');
  }
  const seen = new Set<string>();
  for (const p of s.posts) {
    if (!isBlogSlug(p.slug)) throw new Error(`"${String(p.slug)}" is not a blog slug`);
    if (seen.has(p.slug)) throw new Error(`${p.slug} is in the snapshot twice`);
    seen.add(p.slug);
    const r = validateBlocks(p.blocks);
    if (!r.ok) throw new Error(`${p.slug}: invalid blocks: ${r.errors.slice(0, 3).join('; ')}`);
    if (!p.title || typeof p.publishedAt !== 'string' || Number.isNaN(Date.parse(p.publishedAt))) throw new Error(`${p.slug}: a title and a publish date are required`);
  }
  return s;
}

// The post's index.md, as the import writes it.
export function importPostFile(r: ImportRecord): string {
  return serializePostFile(applyPostInput(recordInput(r)));
}

// The posts the import deletes: those already there that it doesn't write, dated before `fetchedAt` or undated.
export function placeholderSlugs(existing: ExistingPost[], snapshot: Pick<ImportSnapshot, 'posts' | 'fetchedAt'>, keep: string[] = []): string[] {
  const imported = new Set(snapshot.posts.map((p) => p.slug));
  const spared = new Set(keep);
  const before = Date.parse(snapshot.fetchedAt);
  return existing
    .filter((p) => !imported.has(p.slug) && !spared.has(p.slug))
    .filter((p) => p.date === null || Number.isNaN(Date.parse(p.date)) || Date.parse(p.date) < before)
    .map((p) => p.slug)
    .sort();
}

export async function applyImport(snapshot: ImportSnapshot, target: ImportTarget, o: { dryRun?: boolean; keep?: string[] } = {}): Promise<ImportReport> {
  const results: ImportReport['results'] = [];
  const existing = await target.list();
  const doomed = placeholderSlugs(existing, snapshot, o.keep);
  for (const post of snapshot.posts) {
    try {
      const raw = importPostFile(post);
      const now = await target.read(post.slug);
      if (now === null) {
        if (!o.dryRun) await target.create(post.slug, raw);
        results.push({ slug: post.slug, outcome: 'created' });
      } else {
        results.push({ slug: post.slug, outcome: now === raw ? 'unchanged' : 'kept' });
      }
    } catch (err) {
      results.push({ slug: post.slug, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Placeholders go only once every imported post is in place, so a failed import leaves the blog as it was.
  const failed = results.some((r) => r.outcome === 'error');
  for (const slug of doomed) {
    if (failed) { results.push({ slug, outcome: 'error', error: 'not deleted: the import had errors' }); continue; }
    try {
      if (!o.dryRun) await target.remove(slug);
      results.push({ slug, outcome: 'deleted' });
    } catch (err) {
      results.push({ slug, outcome: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  const counts: Record<ImportOutcome, number> = { created: 0, unchanged: 0, kept: 0, deleted: 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  return { results, counts };
}
