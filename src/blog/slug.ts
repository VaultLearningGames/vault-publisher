// Blog slugs: lowercase ASCII words joined by single hyphens, at most 100 characters.
export const MAX_SLUG = 100;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isBlogSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_SLUG && SLUG_RE.test(s);
}

// "Héllo, World! 2026" -> "hello-world-2026". Returns '' when nothing usable is left.
export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, MAX_SLUG).replace(/-+$/, '');
}

// The first of base, base-2, base-3, ... that `taken` reports free. Keeps the result within MAX_SLUG.
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  const root = base || 'post';
  if (!taken(root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}
