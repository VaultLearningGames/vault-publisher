// Blog post tags: how a typed tag becomes a stored one, and how existing tags are ranked as suggestions. Shared by the
// server (src/portal/blog-admin.ts sanitizes saved tags with it, src/blog/siteRepo.ts ranks existing tags) and the
// editor (portal-blog-editor.js adds chips with it). A pure ES module with no browser or Node APIs.
// Tags compare case-insensitively: "Math" and "math" are one tag (tagKey).

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const DEFAULT_TAG_LIMIT = 20;
export const MAX_TAG_LIMIT = 100;

// "  #Game   Design " -> "Game Design": trimmed, inner whitespace collapsed, leading '#' dropped. null when nothing
// is left, it is over MAX_TAG_LENGTH characters, or it has control characters or no letter or digit.
export function normalizeTag(input) {
  if (typeof input !== 'string') return null;
  const t = input.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim();
  if (!t || t.length > MAX_TAG_LENGTH || /[\u0000-\u001f\u007f]/.test(t) || !/[\p{L}\p{N}]/u.test(t)) return null;
  return t;
}

// The key tags compare by.
export const tagKey = (name) => String(name).toLowerCase();

// A tag list as saved: each entry normalized, unusable ones dropped, duplicates (case-insensitively) after the first
// dropped, at most MAX_TAGS. Entries of `keep` (the post's tags as they are) are kept as they are, so saving a post
// doesn't change tags it already has.
export function sanitizeTags(list, keep = []) {
  const kept = new Set((keep || []).filter((t) => typeof t === 'string'));
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = typeof raw === 'string' && kept.has(raw.trim()) ? raw.trim() : normalizeTag(raw);
    if (t === null || seen.has(tagKey(t))) continue;
    seen.add(tagKey(t));
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// The tag list with `name` added: { tags, error }. A tag already there (case-insensitively) isn't added again.
export function addTag(tags, name) {
  const list = (tags || []).slice();
  const t = normalizeTag(String(name ?? ''));
  if (t === null) {
    return { tags: list, error: String(name ?? '').trim().replace(/^#+/, '').trim() ? `A tag is 1-${MAX_TAG_LENGTH} characters with letters or digits.` : '' };
  }
  if (list.some((x) => tagKey(x) === tagKey(t))) return { tags: list, error: '' };
  if (list.length >= MAX_TAGS) return { tags: list, error: `A post may have at most ${MAX_TAGS} tags.` };
  list.push(t);
  return { tags: list, error: '' };
}

// The `limit` query parameter: DEFAULT_TAG_LIMIT unless it is a whole number, then clamped to 1..MAX_TAG_LIMIT.
export function tagLimit(value) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+$/.test(s)) return DEFAULT_TAG_LIMIT;
  return Math.min(MAX_TAG_LIMIT, Math.max(1, Number(s)));
}

// Existing tags from every post's tag list, as [{ name, count }]: count is the number of posts with the tag; one entry
// per tag (case-insensitively) named by its most used spelling. Only tags containing `q` (case-insensitively, a
// leading '#' ignored); most used first, then by name; at most `limit`.
export function rankTags(tagLists, q = '', limit = DEFAULT_TAG_LIMIT) {
  const needle = tagKey(String(q ?? '').replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim());
  const byKey = new Map(); // key -> { count, spellings: Map<name, uses> }
  for (const tags of tagLists) {
    const inPost = new Set();
    for (const raw of tags || []) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim();
      if (!name) continue;
      const k = tagKey(name);
      let e = byKey.get(k);
      if (!e) byKey.set(k, (e = { count: 0, spellings: new Map() }));
      e.spellings.set(name, (e.spellings.get(name) ?? 0) + 1);
      if (!inPost.has(k)) { inPost.add(k); e.count++; }
    }
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const out = [];
  for (const [k, e] of byKey) {
    if (needle && !k.includes(needle)) continue;
    const name = [...e.spellings].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))[0][0];
    out.push({ name, count: e.count });
  }
  out.sort((a, b) => b.count - a.count || byName(tagKey(a.name), tagKey(b.name)) || byName(a.name, b.name));
  return out.slice(0, Math.max(0, limit));
}
