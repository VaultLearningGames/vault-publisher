// The one-time import of the Squarespace snapshot (vault-site's data/squarespace/games.json) into a portal's
// listings: layout and theme, hero background and logo art, card and SEO fields, page address and aliases, and every
// game image re-hosted through card A's crop/compress config (src/migrations/legacy-games/).
//
//   node scripts/import-legacy-games.ts --portal https://portal.vaultlearninggames-staging.org \
//     --source ../vault-site/data/squarespace/games.json [--apply] [--site https://vaultlearninggames.org] \
//     [--out legacy-import] [--summary FILE] [--token TOKEN] [--budget-seconds N]
//   node scripts/import-legacy-games.ts --portal URL --rollback [--apply]
//
// A dry run (the default) plans every game, downloads and compresses every image and has the portal check each one
// (nothing is stored or written), and writes the report. --apply stores the images (originals kept under _legacy/),
// writes the listings, then plans once more and fails unless that second run would change nothing.
// The source is only read. Images that are site paths are downloaded from --site (default: the production site).
// Needs the dev dependencies (sharp). The token is --token, else $ADMIN_TASK_TOKEN, else a GitHub Actions OIDC token.
//
// Writes to --out (default ./legacy-import): report.json (the portal's report, plus every image's result),
// report.md (counts, the pages that visibly change, conflicts, dates, dropped title styling), urls-before.tsv and
// urls-after.tsv (URL, expected status, game, kind — the input of vault-site's redirect test and visual gate).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compressForField } from '../src/migrations/legacy-games/compress.ts';
import { resolveSource } from '../src/migrations/legacy-games/images.ts';
import { slimLegacy, parseLegacy } from '../src/migrations/legacy-games/legacy.ts';
import type { ImageJob, LegacyReport } from '../src/migrations/legacy-games/types.ts';
import { urlListText } from '../src/migrations/legacy-games/urls.ts';
import { IMAGE_FIELDS } from '../src/portal/image-fields.ts';

const CONCURRENCY = 3;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

const { values: opt } = parseArgs({
  options: {
    portal: { type: 'string' }, source: { type: 'string' }, apply: { type: 'boolean' }, rollback: { type: 'boolean' },
    site: { type: 'string' }, out: { type: 'string' }, summary: { type: 'string' }, token: { type: 'string' },
    audience: { type: 'string' }, 'budget-seconds': { type: 'string' },
  },
});
if (!opt.portal || (!opt.source && !opt.rollback)) {
  console.error('usage: node scripts/import-legacy-games.ts --portal URL --source games.json [--apply] [--site URL] [--out DIR]\n       node scripts/import-legacy-games.ts --portal URL --rollback [--apply]');
  process.exit(2);
}
const portal = opt.portal.replace(/\/+$/, '');
const apply = !!opt.apply;
const site = (opt.site ?? 'https://vaultlearninggames.org').replace(/\/+$/, '');
const outDir = opt.out ?? 'legacy-import';
const deadline = opt['budget-seconds'] ? Date.now() + Number(opt['budget-seconds']) * 1000 : Infinity;

async function token(): Promise<string> {
  const given = opt.token ?? process.env.ADMIN_TASK_TOKEN;
  if (given) return given;
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('no token: pass --token, or run in a workflow job with "id-token: write"');
  const res = await fetch(`${url}&audience=${encodeURIComponent(opt.audience ?? 'vault-publisher')}`, { headers: { Authorization: `bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub refused an OIDC token (HTTP ${res.status})`);
  return ((await res.json()) as { value: string }).value;
}

async function call(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${portal}/v1/admin/legacy-games${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(280_000),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 1000) }; }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${json?.error ?? ''}`);
  return json;
}

const kb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`);

if (opt.rollback) {
  const r = await call('/rollback', { dry_run: !apply });
  console.log(JSON.stringify(r, null, 2));
  console.log(`legacy import rollback${apply ? '' : ' (dry run: nothing was changed)'}: ${r.games.filter((g: any) => g.draft.length || g.published.length).length} game(s)`);
  process.exit(0);
}

const data = slimLegacy(parseLegacy(readFileSync(opt.source!, 'utf8')));
const plan = (dry: boolean): Promise<LegacyReport> => call('/plan', { games: data, source: opt.source, dry_run: dry });

// 1. The plan (always a dry run first).
const first = await plan(true);
const jobs: ImageJob[] = first.games.flatMap((g) => g.jobs);
console.log(`legacy import: ${first.counts.games} games in the snapshot (${first.counts.hero} hero, ${first.counts.standard} standard, ${first.counts.pathDiffers} path≠slug), ${first.counts.matched} matched, ${first.counts.unmatched} unmatched; ${jobs.length} images to re-host${apply ? '' : ' (dry run)'}`);
for (const w of first.warnings) console.log(`  warning: ${w}`);

// 2. Every image: download, crop and compress like card A's tool, send (the portal checks it; --apply stores it).
type Result = { job: ImageJob; url?: string; to?: string; in?: { w: number; h: number }; out?: { w: number; h: number; bytes: number; mime: string }; original?: number; cropped?: number; upscaled?: boolean; error?: string };
const results: Result[] = [];
const queue = [...jobs];
let left = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    if (Date.now() > deadline) { left++; continue; }
    const r: Result = { job };
    results.push(r);
    try {
      const url = resolveSource(job.source, site);
      if (!url) throw new Error(`“${job.source}” isn’t a link or a site path`);
      r.url = url;
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const original = new Uint8Array(await res.arrayBuffer());
      if (original.length > MAX_DOWNLOAD_BYTES) throw new Error('the original is over 30 MB');
      r.original = original.length;
      const c = await compressForField(original, IMAGE_FIELDS[job.field]);
      Object.assign(r, { in: c.in, out: c.out, cropped: c.cropped, upscaled: c.upscaled });
      const sent = await call('/image', {
        slug: job.slug, field: job.field, index: job.index, from: job.from, source: job.source, source_url: url,
        image: Buffer.from(c.bytes).toString('base64'), in: c.in, cropped: c.cropped, upscaled: c.upscaled, quality: c.quality, dry_run: !apply,
      });
      r.to = sent.record?.to;
      console.log(`  ${apply ? (sent.already ? 'already' : 'stored') : 'checked'} ${job.slug} ${job.field}${job.index !== undefined ? `[${job.index}]` : ''}: ${c.in.w}×${c.in.h} ${kb(original.length)} → ${c.out.w}×${c.out.h} ${c.out.mime.replace('image/', '')} ${kb(c.out.bytes)}${c.cropped > 0.01 ? `, cropped ${Math.round(c.cropped * 100)}%` : ''}${c.upscaled ? ', enlarged' : ''}`);
    } catch (err) {
      r.error = (err as Error).message;
      console.log(`  FAILED ${job.slug} ${job.field}${job.index !== undefined ? `[${job.index}]` : ''} (${job.source}): ${r.error}`);
    }
  }
}));
const failed = results.filter((r) => r.error);

// 3. With --apply: write the listings, then check that a second run would change nothing.
let report = first;
let secondRun: { changed: string[] } | null = null;
if (apply) {
  report = await plan(false);
  console.log(`legacy import: wrote ${report.written} listing(s)`);
  const again = await plan(true);
  secondRun = { changed: again.games.filter((g) => g.match !== 'unmatched' && !g.unchanged).map((g) => g.slug) };
  console.log(secondRun.changed.length ? `second run would still change: ${secondRun.changed.join(', ')}` : 'second run: no-op');
}

// The pages that visibly change: the portal's list, plus (on a dry run, before anything is recorded) the crops and
// enlargements this run measured.
const changed = new Map(report.changedPages.map((p) => [p.slug, { ...p, why: [...p.why] }]));
if (!apply) {
  for (const r of results) {
    const why = [
      ...(r.cropped && r.cropped > 0.01 ? [`${r.job.field}${r.job.index !== undefined ? ` ${r.job.index + 1}` : ''}: cropped to the field's shape (${Math.round(r.cropped * 100)}% of the picture cut).`] : []),
      ...(r.upscaled ? [`${r.job.field}: the original was narrower than the field's minimum and was enlarged.`] : []),
      ...(r.error ? [`${r.job.field}: the image could not be re-hosted (${r.error}).`] : []),
    ];
    if (!why.length) continue;
    const g = report.games.find((x) => x.slug === r.job.slug);
    const p = changed.get(r.job.slug) ?? { slug: r.job.slug, path: g?.path ?? r.job.slug, why: [] };
    p.why.push(...why);
    changed.set(r.job.slug, p);
  }
}
const changedPages = [...changed.values()].sort((a, b) => a.slug.localeCompare(b.slug));

// 4. The report files.
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, changedPages, images: results, imagesLeft: left, secondRun }, null, 2) + '\n');
writeFileSync(join(outDir, 'urls-before.tsv'), urlListText(report.urls.before));
writeFileSync(join(outDir, 'urls-after.tsv'), urlListText(report.urls.after));
const c = report.counts, e = report.expected;
const md = [
  `# games.json import — ${apply ? 'applied' : 'dry run'} on ${portal}`, '',
  `Snapshot: ${c.games} games (expected ${e.games}), ${c.hero} hero (${e.hero}), ${c.standard} standard (${e.standard}), ${c.pathDiffers} path≠slug (${e.pathDiffers}), ${c.seoTitle} SEO titles (${e.seoTitle}), ${c.seoDescription} SEO descriptions (${e.seoDescription}), ${c.titleScaled} scaled titles (${e.titleScaled}).`,
  `Portal: ${c.listings} listings; ${c.matched} matched, ${c.unmatched} unmatched, ${c.inverted} matched on an inverted key/path.`,
  `Images: ${results.length - failed.length} ${apply ? 're-hosted' : 'checked'}, ${failed.length} failed${left ? `, ${left} left (time budget)` : ''}. Listings written: ${report.written}.${secondRun ? ` Second run: ${secondRun.changed.length ? `would change ${secondRun.changed.join(', ')}` : 'no-op'}.` : ''}`,
  '', ...report.warnings.map((w) => `- warning: ${w}`), '',
  `## Pages that visibly change (${changedPages.length}) — for review`, '',
  ...changedPages.map((p) => `- **${p.slug}** (/${p.path}/): ${p.why.join(' ')}`), '',
  `## Title styling not imported (${report.titleStylingDropped.length})`, '', ...report.titleStylingDropped.map((s) => `- ${s}`), '',
  `## Record date ≠ old page date (${report.createdAtDifferences.length}; the record's date is kept)`, '',
  ...report.createdAtDifferences.map((d) => `- ${d.slug}: record ${d.record}, old page ${d.legacy} (${d.diffDays} days)`), '',
  `## Conflicts (kept as a person set them)`, '',
  ...report.games.flatMap((g) => g.conflicts.map((x) => `- ${g.slug}: ${x}`)), '',
  `## Card strings not in the option lists (dropped)`, '',
  ...report.games.flatMap((g) => g.dropped.unmatchedStrings.map((u) => `- ${g.slug} ${u.field}: “${u.string}”`)), '',
  `## Images that failed (${failed.length})`, '', ...failed.map((r) => `- ${r.job.slug} ${r.job.field} (${r.job.source}): ${r.error}`), '',
  `## URLs: ${report.urls.before.length} served today, ${report.urls.after.length} after; lost: ${report.lostUrls.length}`, '',
  ...report.lostUrls.map((u) => `- LOST ${u.url} (${u.game})`), '',
].join('\n');
writeFileSync(join(outDir, 'report.md'), md);
if (opt.summary) appendFileSync(opt.summary, md + '\n');
console.log(`legacy import: report in ${outDir}/ (report.md, report.json, urls-before.tsv, urls-after.tsv)`);

if (failed.length || left || report.lostUrls.length || secondRun?.changed.length) process.exit(1);
