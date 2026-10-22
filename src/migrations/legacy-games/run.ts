// The import's engine, in the portal (the admin endpoints in routes.ts call it): plan or apply the field writes for
// every game of the snapshot, accept one re-hosted image, roll the import back. The images are compressed outside
// the portal (scripts/import-legacy-games.ts, with compress.ts) and checked here like an upload.
//
//   1. dry run (the default): the report — what each game would get, the conflicts, the images to move, the
//      before/after URL lists — and nothing written.
//   2. --apply: each image is sent (acceptLegacyImage: checked against its field's row, the original kept under
//      _legacy/, the result stored in the game's _vault-assets/), then the fields are written (draft and published
//      the same way, without a new review, like cards A and C's backfills) and the report kept in settings.
//   3. A second run finds every value already moved and every field already written: no image, no write.
import { createHash } from 'node:crypto';
import { fail } from '../../app.ts';
import { assetKey, IMAGE_CACHE, sniffImage, type AssetKind } from '../../assets.ts';
import type { Db } from '../../db.ts';
import { markDeployPending } from '../../deploy-status.ts';
import { draftProblems, type ListingRow } from '../../listing-ops.ts';
import { normalize, type ListingFields } from '../../listings.ts';
import { IMAGE_FIELDS, validateFieldImage } from '../../portal/image-fields.ts';
import { studioOptions } from '../../portal/listing-enums.ts';
import { objectExists, type Storage } from '../../storage.ts';
import { applyImageRecords, backupKey, IMAGE_FIELD_KEYS, imageJobs } from './images.ts';
import { countWarnings, EXPECTED, legacyCounts, legacyValues } from './legacy.ts';
import { dayDiff, diffFields, planFields } from './plan.ts';
import { matchLegacyEntry } from './slug-map.ts';
import type { GameReport, ImageRecord, LegacyData, LegacyImageField, LegacyProcessed, LegacyProcessedGame, LegacyReport } from './types.ts';
import { afterUrls, beforeUrls, lostUrls } from './urls.ts';

export const LEGACY_REPORT_KEY = 'legacy_games_import';
export const LEGACY_PROCESSED_KEY = 'legacy_games_processed';
const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
// A legacy date this many days from the record's created date is reported (the record's date is kept).
const DATE_TOLERANCE_DAYS = 1;
// A crop that cuts more than this share of the picture is a visible change.
const CROP_VISIBLE = 0.01;

export interface LegacyDeps { db: Db; production: Storage | null; prodPublicUrl: string; fetch?: typeof fetch }

export function readProcessed(db: Db): LegacyProcessed {
  try {
    const v = JSON.parse(db.setting(LEGACY_PROCESSED_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v as LegacyProcessed : {};
  } catch { return {}; }
}
const emptyGame = (): LegacyProcessedGame => ({ images: [], fields: { draft: {}, published: {} } });

export function lastReport(db: Db): LegacyReport | null {
  try { return JSON.parse(db.setting(LEGACY_REPORT_KEY) ?? 'null'); } catch { return null; }
}

// ---------- plan / apply ----------
export function runLegacyImport(deps: LegacyDeps, data: LegacyData, actor: string, opts: { dryRun: boolean; source?: string }): LegacyReport {
  const { db } = deps;
  const studios = studioOptions(db);
  const processed = readProcessed(db);
  const snapshot = legacyCounts(data);
  const report: LegacyReport = {
    ran_at: new Date().toISOString(), by: actor, source: opts.source ?? 'data/squarespace/games.json', dry_run: opts.dryRun,
    counts: { ...snapshot, listings: db.listings().length, matched: 0, unmatched: 0, inverted: 0 },
    expected: EXPECTED,
    games: [], changedPages: [], createdAtDifferences: [], titleStylingDropped: [], lostUrls: [], written: 0,
    warnings: countWarnings(snapshot),
    urls: { before: [], after: [] },
  };
  let deployPending = false;

  for (const [key, entryIn] of Object.entries(data.games).sort(([a], [b]) => a.localeCompare(b))) {
    const entry = entryIn ?? {};
    const m = matchLegacyEntry(key, entry, (s) => !!db.listing(s));
    const lv = legacyValues(entry);
    report.urls.before.push(...beforeUrls(m.slug, m.path, lv.cardId));
    const g: GameReport = {
      slug: m.slug, path: m.path, match: m.match, layout: lv.layout, theme: lv.theme, date: null,
      visualChanges: [], fields: [], jobs: [], images: [],
      dropped: { unmatchedStrings: [] }, conflicts: [], warnings: [...m.warnings], unchanged: true,
    };
    report.games.push(g);
    if (m.match === 'unmatched') { report.counts.unmatched++; continue; }
    report.counts.matched++;
    if (m.match === 'inverted') report.counts.inverted++;

    const l = db.listing(m.slug) as ListingRow;
    const proc = processed[l.slug] ?? emptyGame();
    // A move of an existing value is (re)applied wherever the value still is; an image of the old page fills its
    // empty field once (applied), so a person who later removes it isn't overridden by a second run.
    const toApply = proc.images.filter((r) => r.from !== '' || !r.applied);

    const plan = (which: 'draft' | 'published') => {
      const version = l[which];
      if (!version) return null;
      const base = normalize({}, version);
      const fp = planFields({ slug: l.slug, path: m.path, legacy: entry, lv, fields: base, studios, written: proc.fields[which] });
      const next = applyImageRecords(fp.next, toApply);
      return { base, next, fp, writes: diffFields(base, next) };
    };
    const draft = plan('draft')!;
    const published = plan('published');
    g.fields = draft.writes;
    g.conflicts = draft.fp.conflicts;
    g.dropped.unmatchedStrings = draft.fp.unmatched;
    if (published && published.writes.some((w) => !draft.writes.some((d) => d.field === w.field))) g.warnings.push('the published listing differs from the draft: some fields are written only to one of them.');
    g.jobs = imageJobs(l.slug, l, lv, proc.images);
    g.images = proc.images;

    // What the old page had that the portal doesn't carry.
    if (!lv.layout) { g.dropped.legacyLayout = lv.rawLayout || '(none)'; g.warnings.push(`the old layout “${lv.rawLayout}” is neither hero nor standard: the layout is left as it is.`); }
    if (lv.rawTheme && !lv.theme) { g.dropped.legacyTheme = lv.rawTheme; g.warnings.push(`the old section colour “${lv.rawTheme}” is neither light nor dark: the theme is left as it is.`); }
    if (lv.titleScaled) { g.dropped.titleScaled = true; report.titleStylingDropped.push(l.slug); }
    if (lv.logoRole === 'logo' && lv.layout === 'standard') g.dropped.logoBlock = true;

    // The listing's date is the record's created date (decision 7): the old page's date is only compared.
    if (lv.date) {
      const diffDays = dayDiff(l.created_at, lv.date);
      g.date = { record: l.created_at, legacy: lv.date, diffDays };
      if (diffDays > DATE_TOLERANCE_DAYS) report.createdAtDifferences.push({ slug: l.slug, record: l.created_at, legacy: lv.date, diffDays });
    }

    // Why the page will look different from the old one (for the human review of the visual gate).
    const shown = published?.next ?? draft.next;
    const v = g.visualChanges;
    if (lv.titleScaled) v.push('per-game title styling (title_scaled) is not imported: the title renders from the template (decision 8).');
    if (lv.mixedThemes) v.push(`the old page's sections had more than one colour; the page has one theme (${shown.theme}).`);
    if (g.dropped.logoBlock) v.push('the old page’s logo block is kept as the logo art; the standard layout may not draw it.');
    if (lv.layout && shown.page_layout !== lv.layout) v.push(`hero/standard mismatch: the page is ${shown.page_layout}, the old page was ${lv.layout} (kept: a person chose it).`);
    if (lv.theme && shown.theme !== lv.theme) v.push(`the page is ${shown.theme}, the old page was ${lv.theme} (kept: a person chose it).`);
    for (const r of proc.images) {
      if (r.cropped > CROP_VISIBLE) v.push(`${r.field}${r.index !== undefined ? ` ${r.index + 1}` : ''}: cropped to the field's shape (${Math.round(r.cropped * 100)}% of the picture cut).`);
      if (r.upscaled) v.push(`${r.field}${r.index !== undefined ? ` ${r.index + 1}` : ''}: the original was narrower than the field's minimum and was enlarged (${r.in?.w}px → ${r.out.w}px).`);
    }
    if (v.length) report.changedPages.push({ slug: l.slug, path: m.path, why: [...v] });
    report.urls.after.push(...afterUrls(l.slug, shown.page_address || l.slug, shown.aliases));

    const writes = draft.writes.length || (published?.writes.length ?? 0);
    g.unchanged = !writes && !g.jobs.length;
    if (!writes) continue;
    // The same checks as a save: nothing the import writes may make the draft unsaveable.
    const was = new Set(draftProblems(db, l, draft.base, false, deps.prodPublicUrl));
    const fresh = draftProblems(db, l, draft.next, false, deps.prodPublicUrl).filter((p) => !was.has(p));
    if (fresh.length) { g.warnings.push(`not written: ${fresh.join(' ')}`); continue; }
    if (opts.dryRun) continue;

    db.setListingContent(l.id, draft.next, published?.next ?? null);
    const record = (which: 'draft' | 'published', ws: typeof draft.writes) => {
      for (const w of ws) proc.fields[which][w.field] = { from: Object.hasOwn(proc.fields[which], w.field) ? proc.fields[which][w.field].from : w.from, to: w.to };
    };
    record('draft', draft.writes);
    if (published) record('published', published.writes);
    for (const r of toApply) r.applied = true;
    processed[l.slug] = proc;
    report.written++;
    if (published?.writes.length) deployPending = true;
    db.audit(actor, 'listing.legacy-import', `${l.studio_slug}:${l.slug}`, {
      fields: draft.writes.map((w) => w.field), published: published?.writes.map((w) => w.field) ?? [], via: 'games.json import',
    });
  }

  const lost = lostUrls(report.urls);
  report.lostUrls = lost.map((u) => ({ url: u.url, game: u.game, kind: u.kind }));
  if (lost.length) report.warnings.push(`${lost.length} URL(s) served today would not be kept by any listing: ${lost.map((u) => u.url).join(', ')}.`);
  if (report.counts.unmatched) report.warnings.push(`${report.counts.unmatched} snapshot game(s) have no portal listing (never created by the import): ${report.games.filter((x) => x.match === 'unmatched').map((x) => x.slug).join(', ')}.`);

  if (!opts.dryRun) {
    db.setSetting(LEGACY_PROCESSED_KEY, JSON.stringify(processed));
    db.setSetting(LEGACY_REPORT_KEY, JSON.stringify(report));
    if (deployPending) markDeployPending(db, 'listing.legacy-import');
  }
  return report;
}

// ---------- one re-hosted image ----------
export interface ImageUpload {
  slug: string;
  field: LegacyImageField;
  index?: number;
  from: string;                 // the listing's value it replaces ('' for an image of the old page that fills an empty field)
  source: string;               // that value, or the old page's image path
  source_url: string;           // where the original was downloaded from (the backup is taken from there)
  image: Uint8Array;            // the compressed result
  in: { w: number; h: number } | null;
  cropped: number;
  upscaled: boolean;
  quality: number | null;
}

const sha16 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex').slice(0, 16);

// Checks one compressed image against its field's row (like an upload), keeps the original under _legacy/, stores
// the result as the game's own asset and records the move (the fields are rewritten by the next applying run).
// Sending the same image again changes nothing.
export async function acceptLegacyImage(deps: LegacyDeps, u: ImageUpload, actor: string, dryRun: boolean): Promise<{ already: boolean; record: ImageRecord }> {
  const { db } = deps;
  const l = db.listing(u.slug) as ListingRow | undefined;
  if (!l) fail(404, `no listing “${u.slug}”`);
  if (!IMAGE_FIELD_KEYS.includes(u.field)) fail(400, `field must be one of ${IMAGE_FIELD_KEYS.join(', ')}`);
  const spec = IMAGE_FIELDS[u.field];
  const proc = readProcessed(db)[l.slug] ?? emptyGame();
  const prior = proc.images.find((r) => r.field === u.field && r.from === u.from && r.source === u.source);
  if (prior) return { already: true, record: prior };

  // Only an image the import would move: the field's current value, or (from '') a field empty in both versions.
  const current = (f: ListingFields | null) => (!f ? [] : u.field === 'screenshots' ? f.screenshots ?? [] : [f[u.field] ?? ''].filter(Boolean) as string[]);
  const values = [...current(l.draft), ...current(l.published)];
  if (u.from ? !values.includes(u.from) || u.source !== u.from : values.length) fail(409, `${u.slug} ${u.field} no longer holds that value: run the import's plan again.`);
  if (!/^https?:\/\//i.test(u.source_url)) fail(400, 'source_url must be the http(s) address the original was downloaded from');

  const v = validateFieldImage(spec, u.image);
  if (!v.ok) fail(v.status, `${u.slug} ${u.field}: ${v.error}`);
  const ext = v.header.type === 'jpeg' ? 'jpg' : v.header.type;
  const key = assetKey(l.studio_slug, l.slug, spec.kind as AssetKind, u.image, ext);
  const record: ImageRecord = {
    field: u.field, ...(u.index !== undefined ? { index: u.index } : {}), from: u.from, source: u.source,
    to: `${deps.prodPublicUrl}/${key}`, key, backupKey: '',
    in: u.in, out: { w: v.header.width, h: v.header.height, bytes: u.image.length, quality: u.quality, mime: v.header.contentType },
    cropped: Math.max(0, Math.min(1, Number(u.cropped) || 0)), upscaled: !!u.upscaled, applied: false, at: new Date().toISOString(),
  };
  if (dryRun) return { already: false, record };
  const storage = deps.production;
  if (!storage) fail(503, 'The Vault CDN storage isn’t configured here, so images can’t be stored.');

  // The original, byte for byte, under _legacy/ (an object of this CDN is copied inside the bucket).
  const base = `${deps.prodPublicUrl.replace(/\/+$/, '')}/`;
  if (u.source_url.startsWith(base)) {
    const srcKey = decodeURIComponent(u.source_url.slice(base.length).split(/[?#]/)[0]);
    const extOf = /\.([a-z0-9]+)$/i.exec(srcKey)?.[1]?.toLowerCase() ?? 'bin';
    record.backupKey = backupKey(l.studio_slug, l.slug, spec.kind, sha16(u.source), extOf);
    if (!(await objectExists(storage, record.backupKey))) {
      await storage.copy(srcKey, record.backupKey, { contentType: mimeOfExt(extOf), cacheControl: IMAGE_CACHE });
    }
  } else {
    const original = await download(deps.fetch ?? fetch, u.source_url);
    const extOf = sniffImage(original.bytes)?.ext ?? /\.([a-z0-9]+)(?:[?#]|$)/i.exec(u.source_url)?.[1]?.toLowerCase() ?? 'bin';
    record.backupKey = backupKey(l.studio_slug, l.slug, spec.kind, sha16(u.source), extOf);
    if (!(await objectExists(storage, record.backupKey))) {
      await storage.put(record.backupKey, original.bytes, original.bytes.length, { contentType: original.contentType || mimeOfExt(extOf), cacheControl: IMAGE_CACHE });
    }
  }
  if (!(await objectExists(storage, key))) await storage.put(key, u.image, u.image.length, { contentType: v.header.contentType, cacheControl: IMAGE_CACHE });

  // Re-read after the awaits: other images of the run may have been recorded meanwhile.
  const all = readProcessed(db);
  const game = all[l.slug] ?? emptyGame();
  const again = game.images.find((r) => r.field === u.field && r.from === u.from && r.source === u.source);
  if (again) return { already: true, record: again };
  game.images.push(record);
  all[l.slug] = game;
  db.setSetting(LEGACY_PROCESSED_KEY, JSON.stringify(all));
  db.audit(actor, 'listing.legacy-image', `${l.studio_slug}:${l.slug}`, { field: u.field, from: u.from || u.source, to: record.to, backup: record.backupKey, bytes: u.image.length });
  return { already: false, record };
}

function mimeOfExt(ext: string): string {
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

async function download(doFetch: typeof fetch, url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  let res: Response;
  try { res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' }); }
  catch (err) { fail(503, `couldn’t download the original ${url}: ${(err as Error).message}`); }
  if (!res.ok) fail(503, `the original ${url} answered HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) fail(503, `the original ${url} is empty`);
  if (bytes.length > MAX_ORIGINAL_BYTES) fail(413, `the original ${url} is over ${MAX_ORIGINAL_BYTES / 1024 / 1024} MB`);
  return { bytes, contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim() };
}

// ---------- rollback ----------
// Every field the import wrote goes back to what it was, where it still holds what the import wrote (a person's
// later edit is kept). The records are cleared, so the next run imports again; the CDN objects (the new images and
// the _legacy/ originals) stay: they are immutable and may be in a site build.
export function rollbackLegacyImport(db: Db, actor: string, dryRun: boolean): { dry_run: boolean; games: { slug: string; draft: string[]; published: string[]; kept: string[] }[] } {
  const processed = readProcessed(db);
  const out: { slug: string; draft: string[]; published: string[]; kept: string[] }[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [slug, proc] of Object.entries(processed).sort(([a], [b]) => a.localeCompare(b))) {
    const l = db.listing(slug);
    if (!l) continue;
    const kept: string[] = [];
    const undo = (which: 'draft' | 'published') => {
      const version = l[which];
      if (!version) return { next: null, fields: [] as string[] };
      const next = normalize({}, version) as unknown as Record<string, unknown>;
      const fields: string[] = [];
      for (const [field, w] of Object.entries(proc.fields[which] ?? {})) {
        if (same(next[field], w.to)) { next[field] = w.from; fields.push(field); }
        else kept.push(`${which}.${field}`);
      }
      return { next: next as unknown as ListingFields, fields };
    };
    const d = undo('draft'), p = undo('published');
    out.push({ slug, draft: d.fields, published: p.fields, kept });
    if (dryRun || (!d.fields.length && !p.fields.length)) continue;
    db.setListingContent(l.id, d.next!, p.next);
    db.audit(actor, 'listing.legacy-import.rollback', slug, { draft: d.fields, published: p.fields, kept });
  }
  if (!dryRun) {
    db.setSetting(LEGACY_PROCESSED_KEY, '{}');
    if (out.some((g) => g.published.length)) markDeployPending(db, 'listing.legacy-import.rollback');
  }
  return { dry_run: dryRun, games: out };
}

