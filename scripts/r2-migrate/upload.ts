// Copies one no-pipeline game's static build from DoIT (mirrored to a local folder) into Cloudflare R2,
// idempotently, then verifies every file over the public URL. See README.md (the runbook).
//
//   node scripts/r2-migrate/upload.ts --game <slug> --source <localDir> [--dry-run] [--verify-only] [--force]
//
//   --dry-run      print the planned key / size / content-type / encoding for every file; no network at all
//   --verify-only  HEAD every file at R2_PUBLIC_BASE_URL and diff it against the local copy; no writes
//   --force        re-upload files even when R2 already has the same key and size
//
// Credentials come only from the environment (never from the manifest or the code):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
// Point them at the staging builds bucket first, verify, then repeat for the production CDN bucket.
// The script never deletes anything, and the DoIT copies must stay in place until production is verified.
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { headersForPath } from './lib/headers.ts';
import { findGame, loadManifest, markVerified, playUrl, type ManifestGame } from './lib/manifest.ts';
import { keyFor, shouldSkip } from './lib/mapping.ts';
import { diffAll, type FileSpec, type RemoteHead, type VerifyReport } from './lib/verify.ts';

const USAGE = `usage: node scripts/r2-migrate/upload.ts --game <slug> --source <localDir> [--dry-run] [--verify-only] [--force]

  --game         a slug from scripts/r2-migrate/manifest.json
  --source       the local folder mirrored from DoIT (the complete build directory)
  --dry-run      print the plan (key, size, type, encoding); makes no network calls, needs no credentials
  --verify-only  check the existing R2 copy over the public URL (HEAD every file); no writes
  --force        upload every file, even ones R2 already has with the same size
`;

interface LocalFile {
  path: string; // relative to the build folder, forward slashes
  size: number;
  full: string;
}

const mb = (n: number) => (n / 1024 ** 2).toFixed(1);

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function die(message: string): never {
  console.error(`r2-migrate: ${message}`);
  process.exit(1);
}

// Every regular file under `dir`, recursive, with the OS-junk/dotfile filters applied to every level.
async function collectFiles(dir: string): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (shouldSkip(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push({ path: relative(dir, full).split(sep).join('/'), size: (await stat(full)).size, full });
      else console.warn(`r2-migrate: skipping ${full} (not a regular file)`);
    }
  };
  await walk(dir);
  return out;
}

function specsFor(game: ManifestGame, files: LocalFile[]): FileSpec[] {
  return files.map((f) => {
    const h = headersForPath(f.path);
    return { key: keyFor(game.r2Prefix, f.path), size: f.size, ...h };
  });
}

// One HEAD against the public URL; a network failure is recorded as status null, not thrown.
async function headOnce(url: string): Promise<RemoteHead> {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  const head: RemoteHead = {
    status: res.status,
    length: res.headers.get('content-length') === null ? null : Number(res.headers.get('content-length')),
    contentType: res.headers.get('content-type'),
    contentEncoding: res.headers.get('content-encoding'),
  };
  await res.body?.cancel();
  return head;
}

async function headAll(specs: FileSpec[], base: string): Promise<Map<string, RemoteHead>> {
  const out = new Map<string, RemoteHead>();
  for (const s of specs) {
    const url = `${base.replace(/\/+$/, '')}/${s.key.split('/').map(encodeURIComponent).join('/')}`;
    let head: RemoteHead = { status: null };
    for (let attempt = 1; attempt <= 2 && head.status === null; attempt++) {
      try {
        head = await headOnce(url);
      } catch {
        head = { status: null };
      }
    }
    out.set(s.key, head);
    process.stderr.write(`\r  checked ${out.size}/${specs.length}`);
  }
  process.stderr.write('\n');
  return out;
}

// The whole verification: report + exit. Marks the manifest verified and prints the play URL on success.
async function verifyAndFinish(game: ManifestGame, specs: FileSpec[], base: string, manifestFile: string, verb: string): Promise<void> {
  process.stderr.write(`Verifying ${specs.length} files at ${base}/…\n`);
  const report: VerifyReport = diffAll(specs, await headAll(specs, base));
  for (const d of report.diffs) console.log(`  FAIL ${d.key}: ${d.issues.join('; ')}`);
  if (report.ok !== report.total) {
    die(`${verb} finished with ${report.diffs.length} of ${report.total} files not verified (${report.ok} ok). Re-run when the copy is complete; nothing was deleted.`);
  }
  const changed = await markVerified(manifestFile, game.slug);
  console.log(`✔ ${game.displayName}: ${report.total} files verified at ${base}/${game.r2Prefix}/`);
  console.log(changed
    ? `  manifest status is now "verified" — commit scripts/r2-migrate/manifest.json`
    : `  manifest already "verified"`);
  console.log(`  portal play URL to paste into the game's listing: ${playUrl(game, base)}`);
}

async function main(): Promise<void> {
  let values: Record<string, string | boolean>;
  try {
    ({ values } = parseArgs({
      options: {
        game: { type: 'string' },
        source: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'verify-only': { type: 'boolean' },
        force: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(USAGE + `\n${(err as Error).message}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!values.game || !values.source || (values['dry-run'] && values['verify-only'])) {
    console.error(USAGE);
    process.exit(2);
  }

  const manifestFile = fileURLToPath(new URL('./manifest.json', import.meta.url));
  const game = findGame(await loadManifest(manifestFile), values.game as string);

  const source = values.source as string;
  const srcStat = await stat(source).catch(() => die(`source folder ${source} does not exist`));
  if (!srcStat.isDirectory()) die(`source ${source} is not a directory`);
  const files = await collectFiles(source);
  if (!files.length) die(`no files under ${source}`);
  if (!files.some((f) => f.path === game.entryFile)) console.warn(`r2-migrate: warning: ${game.entryFile} not at the top of ${source} — the play URL may 404`);
  const specs = specsFor(game, files);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const base = env('R2_PUBLIC_BASE_URL');

  if (values['dry-run']) {
    console.log(`[dry-run] ${game.displayName} (${game.slug}): ${files.length} files, ${mb(totalBytes)} MB from ${source}`);
    console.log(`[dry-run] R2 prefix ${game.r2Prefix}/ — key, size, content-type, encoding per file:`);
    for (const s of specs) {
      console.log(`  ${s.key}  ${s.size}  ${s.contentType}${s.contentEncoding ? ` + ${s.contentEncoding}` : ''}`);
    }
    console.log(`[dry-run] entry file: ${game.entryFile} → ${base ? playUrl(game, base) : '<R2_PUBLIC_BASE_URL>/' + game.r2Prefix + '/' + game.entryFile}`);
    console.log(`[dry-run] nothing was uploaded or changed${base ? '' : ' (no credentials read at all)'}`);
    return;
  }

  if (values['verify-only']) {
    if (!base) die('R2_PUBLIC_BASE_URL is not set (the public URL of the bucket, e.g. https://builds.vaultlearninggames.org)');
    await verifyAndFinish(game, specs, base, manifestFile, 'Verify');
    return;
  }

  // Full upload: S3-compatible API writes, then the public-URL verification. Staging and production run
  // the same command with different values; the operator chooses which bucket these names hold.
  const accountId = env('R2_ACCOUNT_ID') ?? die('R2_ACCOUNT_ID is not set');
  const accessKeyId = env('R2_ACCESS_KEY_ID') ?? die('R2_ACCESS_KEY_ID is not set');
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY') ?? die('R2_SECRET_ACCESS_KEY is not set');
  const bucket = env('R2_BUCKET') ?? die('R2_BUCKET is not set');
  if (!base) die('R2_PUBLIC_BASE_URL is not set (the copy is verified over its public URL before the portal may point at it)');
  const force = Boolean(values.force);

  // The standard R2 S3 URL for the account; R2_ENDPOINT may point at a local S3-compatible store
  // (localstack, minio) for tests. Credentials still come only from the environment.
  const endpoint = env('R2_ENDPOINT') ?? `https://${accountId}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    // Newer SDKs add CRC32 checksums to PUTs by default, which R2 rejects (same as src/storage.ts).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  // What R2 already holds under the prefix; same key + same size means "unchanged, skip" (idempotent re-runs).
  const prefix = `${game.r2Prefix}/`;
  const remote = new Map<string, number>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key) remote.set(o.Key, o.Size ?? 0);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const extras = [...remote.keys()].filter((k) => !specs.some((s) => s.key === k));
  if (extras.length) console.log(`r2-migrate: ${extras.length} objects already under ${prefix} are not in ${source} — left in place (nothing is ever deleted):`);
  for (const k of extras.slice(0, 10)) console.log(`  ${k}`);
  if (extras.length > 10) console.log(`  … and ${extras.length - 10} more`);

  console.log(`Uploading ${game.displayName} (${game.slug}) to ${bucket}/${prefix} — ${files.length} files, ${mb(totalBytes)} MB`);
  let uploaded = 0, skipped = 0, bytes = 0;
  const byKey = new Map<string, FileSpec>(specs.map((s) => [s.key, s]));
  for (const f of files) {
    const s = byKey.get(keyFor(game.r2Prefix, f.path))!;
    if (!force && remote.get(s.key) === s.size) {
      skipped += 1;
      process.stderr.write(`\r  skipped ${skipped} unchanged, uploaded ${uploaded} (${mb(bytes)} MB)\r`);
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const body = new Uint8Array(await readFile(f.full));
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: s.key,
            Body: body,
            ContentLength: s.size,
            ContentType: s.contentType,
            ...(s.contentEncoding ? { ContentEncoding: s.contentEncoding } : {}),
            CacheControl: s.cacheControl,
          }),
        );
        break;
      } catch (err) {
        if (attempt >= 3) die(`upload of ${f.path} failed after 3 attempts: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    uploaded += 1;
    bytes += f.size;
    process.stderr.write(`\r  uploaded ${uploaded}/${files.length} (${mb(bytes)} MB)\r`);
  }
  process.stderr.write('\n');
  console.log(`Upload done: ${uploaded} uploaded, ${skipped} unchanged (same key + size), ${extras.length} pre-existing objects left in place.`);
  await verifyAndFinish(game, specs, base, manifestFile, 'Upload');
}

void main().catch((err) => die((err as Error).message));
