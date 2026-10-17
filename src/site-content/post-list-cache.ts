// The post list with each post's front matter (not its body), cached so listing the blog doesn't read every file every
// time. The list (one GitHub request) is kept for ttlMs; front matter is kept by blob SHA, so a refresh reads only the
// files that changed. A post whose front matter can't be read is listed with frontMatter null and the reason, and the
// rest of the list is unaffected. Writes through the client should be told to the cache (remember / forget).
import { splitFrontMatter, type FrontMatter } from './frontmatter.ts';
import type { PostRef, SiteContentClient } from './github-client.ts';

export interface PostListEntry extends PostRef {
  frontMatter: FrontMatter | null;
  // Why frontMatter is null.
  error?: string;
}

export interface PostListCache {
  list(o?: { refresh?: boolean }): Promise<PostListEntry[]>;
  // A post was written (created, updated or renamed to this slug): its new SHA and text.
  remember(ref: PostRef, raw: string): void;
  // A post was deleted, or renamed away from this slug.
  forget(slug: string): void;
  // Drops everything: the next list() reads the list again (front matter of unchanged files is still reused).
  invalidate(): void;
}

export const DEFAULT_POST_LIST_TTL_MS = 60_000;
const FETCH_CONCURRENCY = 8;

type Parsed = { frontMatter: FrontMatter | null; error?: string };

function parse(raw: string): Parsed {
  try { return { frontMatter: splitFrontMatter(raw).frontMatter }; } catch (err) {
    return { frontMatter: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const bySlug = (a: PostRef, b: PostRef) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

export function createPostListCache(o: { client: SiteContentClient; ttlMs?: number; now?: () => number }): PostListCache {
  const ttl = o.ttlMs ?? DEFAULT_POST_LIST_TTL_MS;
  const now = o.now ?? Date.now;
  const bySha = new Map<string, Parsed>();
  let refs: PostRef[] | null = null;
  let loadedAt = 0;
  let inflight: Promise<PostRef[]> | null = null;
  // Bumped by every change, so a refresh that started before it doesn't overwrite it.
  let generation = 0;

  const entry = (r: PostRef): PostListEntry => {
    const p = bySha.get(r.sha) ?? { frontMatter: null, error: 'not read' };
    return { ...r, frontMatter: p.frontMatter && structuredClone(p.frontMatter), ...(p.error ? { error: p.error } : {}) };
  };

  // SHAs whose read failed (rather than whose text didn't parse), dropped before the next refresh.
  const failed = new Set<string>();

  async function readMissing(list: PostRef[]): Promise<void> {
    const todo = [...new Set(list.map((r) => r.sha).filter((sha) => !bySha.has(sha)))];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const sha = todo[next++];
        try { bySha.set(sha, parse(await o.client.getBlob(sha))); } catch (err) {
          // Listed as unreadable now; the next refresh tries again.
          bySha.set(sha, { frontMatter: null, error: err instanceof Error ? err.message : String(err) });
          failed.add(sha);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, todo.length) }, worker));
  }
  // The branch's list. Cached unless the cache changed while it was being read (then it may be older than that change).
  async function refresh(): Promise<PostRef[]> {
    const gen = generation;
    for (const sha of failed) bySha.delete(sha);
    failed.clear();
    const list = await o.client.listPosts();
    await readMissing(list);
    if (gen === generation) {
      refs = [...list].sort(bySlug);
      loadedAt = now();
      const live = new Set(refs.map((r) => r.sha));
      for (const sha of bySha.keys()) if (!live.has(sha)) bySha.delete(sha);
    }
    return [...list].sort(bySlug);
  }

  return {
    async list(opts) {
      if (opts?.refresh || !refs || now() - loadedAt >= ttl) {
        inflight ??= refresh().finally(() => { inflight = null; });
        const fresh = await inflight;
        return (refs ?? fresh).map(entry);
      }
      return (refs ?? []).map(entry);
    },
    remember(ref, raw) {
      generation++;
      bySha.set(ref.sha, parse(raw));
      if (refs) refs = [...refs.filter((r) => r.slug !== ref.slug), { slug: ref.slug, path: ref.path, sha: ref.sha }].sort(bySlug);
    },
    forget(slug) {
      generation++;
      if (refs) refs = refs.filter((r) => r.slug !== slug);
    },
    invalidate() {
      generation++;
      refs = null;
      loadedAt = 0;
    },
  };
}
