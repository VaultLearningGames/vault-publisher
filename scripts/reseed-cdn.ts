// Staging only: after a re-seed, copies production's released games from production's CDN bucket into staging's
// (src/cdn-seed.ts), so the games staging's re-seeded database says are released play on staging's site. Run by
// .github/workflows/reseed-staging.yml; see docs/staging-reseed.md.
//
//   node scripts/reseed-cdn.ts [--dry-run] [--summary FILE]
//
// From the environment: R2_ACCOUNT_ID; SEED_CDN_BUCKET with R2_SEED_CDN_ACCESS_KEY_ID/_SECRET_ACCESS_KEY (production's
// CDN bucket, a read-only token); CDN_BUCKET with R2_CDN_ACCESS_KEY_ID/_SECRET_ACCESS_KEY (staging's CDN bucket).
// A dry run lists both buckets and writes nothing. Exits 1 (with a GitHub ::error:: line) when production's bucket
// can't be read or any file failed to copy.
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SEED_ACCESS_HELP, SeedAccessError, seedBucketProblem, seedCdn } from '../src/cdn-seed.ts';
import { createR2Storage } from '../src/storage.ts';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, summary: { type: 'string' } } });
const env = (name: string) => process.env[name]?.trim() ?? '';
const fail = (message: string): never => {
  console.error(`::error::${message}`);
  if (values.summary) appendFileSync(values.summary, `**Copying production's releases to staging's CDN failed:** ${message}\n`);
  process.exit(1);
};

const sourceBucket = env('SEED_CDN_BUCKET'), targetBucket = env('CDN_BUCKET');
const problem = seedBucketProblem(sourceBucket, targetBucket);
if (problem) fail(problem);
if (!env('R2_ACCOUNT_ID')) fail('R2_ACCOUNT_ID isn\'t set');
if (!env('R2_SEED_CDN_ACCESS_KEY_ID') || !env('R2_SEED_CDN_SECRET_ACCESS_KEY')) fail(`no key for production's CDN bucket. ${SEED_ACCESS_HELP}`);
if (!env('R2_CDN_ACCESS_KEY_ID') || !env('R2_CDN_SECRET_ACCESS_KEY')) fail('no key for staging\'s CDN bucket (R2_CDN_ACCESS_KEY_ID, R2_CDN_SECRET_ACCESS_KEY)');

const source = createR2Storage({ accountId: env('R2_ACCOUNT_ID'), accessKeyId: env('R2_SEED_CDN_ACCESS_KEY_ID'), secretAccessKey: env('R2_SEED_CDN_SECRET_ACCESS_KEY'), bucket: sourceBucket });
const target = createR2Storage({ accountId: env('R2_ACCOUNT_ID'), accessKeyId: env('R2_CDN_ACCESS_KEY_ID'), secretAccessKey: env('R2_CDN_SECRET_ACCESS_KEY'), bucket: targetBucket });

try {
  const r = await seedCdn({ source: { list: source.list, get: source.get }, target, dryRun: values['dry-run'], log: (line) => console.log(line) });
  const verb = values['dry-run'] ? 'Would copy' : 'Copied';
  const line = `${verb} ${r.copied} file(s), ${(r.bytes / 1e6).toFixed(1)} MB, from ${sourceBucket} to ${targetBucket} (${r.games} released game(s), ${r.wanted} file(s) wanted; ${r.failed.length} failed).`;
  console.log(line);
  if (values.summary) appendFileSync(values.summary, `${line}\n`);
  for (const f of r.failed.slice(0, 20)) console.error(`failed: ${f.key}: ${f.error}`);
  if (r.failed.length) fail(`${r.failed.length} file(s) didn't copy, e.g. ${r.failed[0].key}: ${r.failed[0].error}. Run the re-seed again to retry them.`);
} catch (err) {
  fail(err instanceof SeedAccessError ? err.message : `${(err as Error).message}`);
}
