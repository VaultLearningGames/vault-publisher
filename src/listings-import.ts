// One-time import of the game pages from the Hugo site prototype (github.com/fielddaylab/vault-rebuild) into site
// listings. Input: that repo's migration/games-export.json (Hugo's own dump of every game page) and
// migration/import-overrides.json (tested play URLs, new-tab games, player fits, and studios for pages without one).
import type { Db, Studio } from './db.ts';
import { isSlug } from './paths.ts';
import { normalize, problems, type ListingFields } from './listings.ts';

export interface ExportedPage { slug: string; title: string; params: Record<string, unknown> }
export interface Override { play_url?: string; embed?: boolean; fit?: string; studio?: string }
export interface ImportResult {
  created: string[];                 // listings created and published
  drafts: { slug: string; why: string[] }[];   // created, but not publishable yet
  skipped: { slug: string; why: string }[];
  studiosCreated: string[];
}

export const slugify = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v] : []);

// Hugo front matter → listing fields.
export function fieldsFromPage(p: ExportedPage, o: Override = {}): ListingFields {
  const q = p.params;
  return normalize({
    title: p.title,
    short_description: q.short_description,
    about: q.about_this_game,
    makers: asList(q.makers),
    grades: asList(q.grades),
    subjects: asList(q.subjects),
    topics: asList(q.topics),
    standards: asList(q.standards),
    related_curriculum: q.related_curriculum ?? '',
    gameplay_video: q.gameplay_video ?? '',
    hero_image: q.hero_image ?? '',
    thumb_image: q.thumb_image ?? q.thumb ?? '',
    screenshots: asList(q.screenshots),
    play_source: 'url',
    play_url: o.play_url ?? q.game_url ?? '',
    embed: o.embed ?? true,
    fit: o.fit ?? '',
  });
}

// `studioSlugs` gives short names for studios the import creates (e.g. "PhET Interactive Simulations: CU Boulder" → "phet").
// `opts.only` imports just those pages (the others aren't reported); `opts.dryRun` reports what an import would do
// and writes nothing.
export function importListings(db: Db, pages: ExportedPage[], overrides: Record<string, Override>, actor: string, studioSlugs: Record<string, string> = {},
  opts: { only?: string[]; dryRun?: boolean } = {}): ImportResult {
  const result: ImportResult = { created: [], drafts: [], skipped: [], studiosCreated: [] };
  const byName = new Map(db.studios().map((s) => [s.name.toLowerCase(), s]));
  const studioNamed = (name: string): Studio => {
    const found = byName.get(name.toLowerCase());
    if (found) return found;
    // A studio Vault manages until it joins with its own GitHub organization (like mit-education-arcade).
    let slug = (isSlug(studioSlugs[name]) ? studioSlugs[name] : slugify(name)) || 'studio';
    while (db.studioBySlug(slug) || result.studiosCreated.includes(slug)) slug += '-2';
    if (opts.dryRun) {
      const planned: Studio = { id: -1, slug, name, github_owner: '', github_owner_id: `vault:${slug}` };
      byName.set(name.toLowerCase(), planned);
      result.studiosCreated.push(slug);
      return planned;
    }
    db.syncStudios([{ slug, name, github_owner: '', github_owner_id: `vault:${slug}` }], 'import');
    const s = db.studioBySlug(slug)!;
    byName.set(name.toLowerCase(), s);
    result.studiosCreated.push(slug);
    db.audit(actor, 'studio.create', slug, { name, via: 'listing import' });
    return s;
  };
  for (const p of pages) {
    if (opts.only && !opts.only.includes(p.slug)) continue;
    if (!isSlug(p.slug)) { result.skipped.push({ slug: p.slug, why: 'not a valid slug' }); continue; }
    if (db.listing(p.slug)) { result.skipped.push({ slug: p.slug, why: 'already has a listing' }); continue; }
    const o = overrides[p.slug] ?? {};
    const fields = fieldsFromPage(p, o);
    const makerName = o.studio || fields.makers[0];
    if (!makerName) { result.skipped.push({ slug: p.slug, why: 'no studio (makers is empty and no override)' }); continue; }
    if (!fields.makers.length) fields.makers = [makerName];
    const studio = studioNamed(makerName);
    const l = opts.dryRun ? null : db.createListing(studio.id, p.slug, fields, actor);
    const why = problems(fields, { forPublish: true, cdnReady: false });
    if (why.length) { result.drafts.push({ slug: p.slug, why }); continue; }
    if (l) db.publishListing(l.id, actor);
    result.created.push(p.slug);
  }
  if (opts.dryRun) return result;
  db.audit(actor, 'listings.import', 'vault-rebuild', {
    created: result.created.length, drafts: result.drafts.length, skipped: result.skipped.length, studios: result.studiosCreated,
    ...(opts.only ? { listings: [...result.created, ...result.drafts.map((d) => d.slug)] } : {}),
  });
  return result;
}
