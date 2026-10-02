// Publish the built website to its R2 bucket (src/site-sync.ts): upload every file of the build, then delete what
// the build no longer has.
//   node scripts/site-sync.ts [site/public] [--dry-run] [--allow-mass-delete]
// Environment: R2_ACCOUNT_ID, SITE_BUCKET, R2_SITE_ACCESS_KEY_ID, R2_SITE_SECRET_ACCESS_KEY (a key for that one
// bucket: Object Read & Write).
import { createR2Storage } from '../src/storage.ts';
import { syncSite } from '../src/site-sync.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dir = args.find((a) => !a.startsWith('--')) ?? 'site/public';
const env = (name: string): string => {
  const v = process.env[name]?.trim();
  if (!v) { console.error(`site-sync: ${name} is not set`); process.exit(2); }
  return v;
};
const bucketName = env('SITE_BUCKET');
const bucket = createR2Storage({ accountId: env('R2_ACCOUNT_ID'), accessKeyId: env('R2_SITE_ACCESS_KEY_ID'), secretAccessKey: env('R2_SITE_SECRET_ACCESS_KEY'), bucket: bucketName });

try {
  const t0 = Date.now();
  const r = await syncSite(dir, bucket, { dryRun: flags.has('--dry-run'), allowMassDelete: flags.has('--allow-mass-delete'), log: (l) => console.log(`site-sync: ${l}`) });
  console.log(flags.has('--dry-run') ? 'site-sync: dry run, nothing changed' : `site-sync: ${r.uploaded} files uploaded to ${bucketName}, ${r.deleted.length} deleted, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error(`site-sync: ${(err as Error).message}`);
  process.exit(1);
}
