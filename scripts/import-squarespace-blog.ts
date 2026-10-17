// The one-time import of the Squarespace blog into vault-site (src/blog/import/): fetch takes a snapshot, apply writes
// it. Dry run by default; nothing here runs in CI or tests (they use the committed snapshot, never the network).
//
//   node scripts/import-squarespace-blog.ts fetch [--dir data/blog-import] [--cdn https://cdn.vaultlearninggames.org]
//       Reads https://vault-games-library.squarespace.com/blog?format=json, following pagination.nextPageUrl, then each
//       post's ?format=json. Drafts and scheduled posts are skipped. Downloads every image (cover and body) to
//       <dir>/images/<sha-256>.<ext> and writes <dir>/squarespace-posts.json: each post's sourceUrl, slug, title,
//       author_name, publishedAt, excerpt, tags (tags + categories), coverImageUrl, bodyHtml and blocks, and the map
//       from each original image address to its CDN copy (site/<slug>/<sha-256>.<ext> under --cdn). Commit both.
//
//   node scripts/import-squarespace-blog.ts apply (--out VAULT-SITE-DIR | --github) [--yes] [--keep a,b] [--skip-images]
//       Uploads the images to the Vault CDN bucket (R2_ACCOUNT_ID, R2_CDN_ACCESS_KEY_ID, R2_CDN_SECRET_ACCESS_KEY,
//       CDN_BUCKET; an image already there isn't written again), creates content/blog/<slug>/index.md for each post
//       that isn't there yet, then deletes the placeholder posts: every post already there that isn't imported and
//       is dated before the snapshot (or undated), except --keep. --github writes one commit per post through the
//       Contents API (VAULT_SITE_GITHUB_TOKEN, VAULT_SITE_REPO, ...: src/site-content/config.ts). Lists what it would
//       do without --yes. Exits 1 when anything failed; then no placeholder is deleted.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { IMAGE_CACHE } from '../src/assets.ts';
import { applyImport, checkSnapshot, type ExistingPost, type ImportTarget } from '../src/blog/import/apply.ts';
import {
  itemImages, itemToRecord, skipReason, sourceSlug, SQUARESPACE_ORIGIN, type ImportImage, type ImportRecord, type ImportSnapshot, type SquarespaceItem,
} from '../src/blog/import/squarespace.ts';
import { buildImageKey, contentHash, imageUrl, sniffImageType } from '../src/blog/imageKey.ts';
import { SiteBlogRepo } from '../src/blog/siteRepo.ts';
import { uniqueSlug } from '../src/blog/slug.ts';
import { createSiteContentClient, DEFAULT_BLOG_DIR, parsePostFile } from '../src/site-content/index.ts';
import { createR2Storage, objectExists } from '../src/storage.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' }, cdn: { type: 'string' }, out: { type: 'string' }, github: { type: 'boolean' }, yes: { type: 'boolean' },
    keep: { type: 'string' }, 'skip-images': { type: 'boolean' }, 'blog-dir': { type: 'string' },
  },
});
const command = positionals[0];
const dir = resolve(values.dir ?? 'data/blog-import');
const snapshotPath = join(dir, 'squarespace-posts.json');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

if (command === 'fetch') await fetchSnapshot();
else if (command === 'apply') await apply();
else {
  console.error('usage: node scripts/import-squarespace-blog.ts fetch [--dir DIR] [--cdn URL]\n'
    + '       node scripts/import-squarespace-blog.ts apply (--out VAULT-SITE-DIR | --github) [--yes] [--keep a,b] [--skip-images] [--dir DIR]');
  process.exit(2);
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'vault-portal blog import' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

async function fetchSnapshot() {
  const cdn = (values.cdn ?? process.env.CDN_PUBLIC_URL ?? 'https://cdn.vaultlearninggames.org').replace(/\/+$/, '');
  // The list, page by page.
  const listed: SquarespaceItem[] = [];
  const seenPages = new Set<string>();
  for (let url: string | null = `${SQUARESPACE_ORIGIN}/blog?format=json`; url && !seenPages.has(url);) {
    seenPages.add(url);
    const page = await getJson(url);
    listed.push(...((page.items as SquarespaceItem[] | undefined) ?? []));
    const p = page.pagination as { nextPage?: boolean; nextPageUrl?: string } | undefined;
    url = p?.nextPage !== false && p?.nextPageUrl ? new URL(p.nextPageUrl, SQUARESPACE_ORIGIN).href : null;
    if (url && !/[?&]format=json\b/.test(url)) url += (url.includes('?') ? '&' : '?') + 'format=json';
  }
  console.log(`${listed.length} posts listed`);

  await mkdir(join(dir, 'images'), { recursive: true });
  const images: Record<string, ImportImage> = {};
  const posts: ImportRecord[] = [];
  const skipped: ImportSnapshot['skipped'] = [];
  const taken = new Set<string>();
  // Oldest first, so an older post keeps the plain slug when two collide.
  listed.sort((a, b) => Number(a.publishOn ?? 0) - Number(b.publishOn ?? 0));
  for (const summary of listed) {
    const sourceUrl = new URL(summary.fullUrl ?? '/blog', SQUARESPACE_ORIGIN).href;
    const why = skipReason(summary);
    if (why) { skipped.push({ sourceUrl, reason: why }); console.log(`skipped  ${sourceUrl}: ${why}`); continue; }
    const full = await getJson(`${sourceUrl}?format=json`);
    const item = { ...summary, ...((full.item as SquarespaceItem | undefined) ?? {}) };
    const slug = uniqueSlug(sourceSlug(item), (s) => taken.has(s));
    for (const original of itemImages(item)) {
      if (images[original]) continue;
      try { images[original] = await download(original, slug, cdn); } catch (err) { console.error(`  image ${original}: ${(err as Error).message}`); }
    }
    const record = itemToRecord(item, { image: (u) => images[u]?.url ?? null, taken: (s) => taken.has(s) });
    taken.add(record.slug);
    posts.push(record);
    console.log(`fetched  ${record.slug}${record.warnings.length ? `\n  ${record.warnings.join('\n  ')}` : ''}`);
  }
  posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
  const snapshot: ImportSnapshot = { version: 1, source: `${SQUARESPACE_ORIGIN}/blog`, fetchedAt: new Date().toISOString(), images, posts, skipped };
  checkSnapshot(snapshot);
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`\n${posts.length} posts, ${Object.keys(images).length} images, ${skipped.length} skipped -> ${snapshotPath}`);
}

async function download(url: string, slug: string, cdn: string): Promise<ImportImage> {
  const res = await fetch(url, { headers: { 'User-Agent': 'vault-portal blog import' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('too big');
  const type = sniffImageType(bytes);
  if (!type) throw new Error('not a JPEG, PNG, WebP or GIF');
  const hash = contentHash(bytes);
  const file = `images/${hash}.${type.ext}`;
  await writeFile(join(dir, file), bytes);
  const key = buildImageKey(slug, hash, type.ext);
  return { key, url: imageUrl(cdn, key), file, contentType: type.contentType, bytes: bytes.length };
}

async function apply() {
  if (!values.out === !values.github) { console.error('apply needs --out VAULT-SITE-DIR or --github'); process.exit(2); }
  if (!existsSync(snapshotPath)) { console.error(`no snapshot at ${snapshotPath}; run fetch first`); process.exit(2); }
  const snapshot = checkSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8')));
  const dryRun = !values.yes;
  let failed = false;

  if (!values['skip-images']) {
    const env = process.env;
    const ready = env.R2_ACCOUNT_ID && env.R2_CDN_ACCESS_KEY_ID && env.R2_CDN_SECRET_ACCESS_KEY && env.CDN_BUCKET;
    if (!ready && !dryRun) { console.error('the images need R2_ACCOUNT_ID, R2_CDN_ACCESS_KEY_ID, R2_CDN_SECRET_ACCESS_KEY and CDN_BUCKET (or --skip-images)'); process.exit(2); }
    const storage = ready ? createR2Storage({ accountId: env.R2_ACCOUNT_ID!, accessKeyId: env.R2_CDN_ACCESS_KEY_ID!, secretAccessKey: env.R2_CDN_SECRET_ACCESS_KEY!, bucket: env.CDN_BUCKET! }) : null;
    for (const img of Object.values(snapshot.images)) {
      try {
        if (storage && await objectExists(storage, img.key)) { console.log(`image    ${img.key} (already there)`); continue; }
        const bytes = new Uint8Array(await readFile(join(dir, img.file)));
        if (!dryRun) await storage!.put(img.key, bytes, bytes.length, { contentType: img.contentType, cacheControl: IMAGE_CACHE });
        console.log(`image    ${img.key}${dryRun ? ' (to upload)' : ''}`);
      } catch (err) {
        failed = true;
        console.error(`image    ${img.key}: ${(err as Error).message}`);
      }
    }
    if (failed) { console.error('Some images could not be uploaded; no post was written.'); process.exit(1); }
  }

  const keep = (values.keep ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const message = (verb: string, slug: string) => `blog: ${verb} ${slug} (the Squarespace blog import)`;
  let target: ImportTarget;
  if (values.out) {
    const blogDir = resolve(values.out, values['blog-dir'] ?? DEFAULT_BLOG_DIR);
    const file = (slug: string) => join(blogDir, slug, 'index.md');
    const read = (slug: string) => readFile(file(slug), 'utf8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
    target = {
      async list() {
        const out: ExistingPost[] = [];
        for (const e of await readdir(blogDir, { withFileTypes: true }).catch(() => [])) {
          if (!e.isDirectory()) continue;
          const raw = await read(e.name);
          if (raw === null) continue;
          // A post whose front matter can't be read is left alone rather than taken for a placeholder.
          try { const fm = parsePostFile(raw).frontMatter; out.push({ slug: e.name, date: fm.draft ? null : fm.date }); } catch { console.error(`unreadable ${e.name}: left alone`); }
        }
        return out;
      },
      read,
      async create(slug, raw) {
        await mkdir(join(blogDir, slug), { recursive: true });
        await writeFile(file(slug), raw, { flag: 'wx' }); // never over a file that appeared meanwhile
      },
      async remove(slug) { await rm(join(blogDir, slug), { recursive: true }); },
    };
  } else {
    const client = createSiteContentClient();
    const repo = new SiteBlogRepo({ client });
    target = {
      async list() {
        return (await repo.listPosts({ refresh: true })).filter((p) => !p.parseError).map((p) => ({ slug: p.slug, date: p.draft ? null : p.date }));
      },
      read: async (slug) => (await client.getPost(slug))?.raw ?? null,
      async create(slug, raw) { await client.putPost(slug, raw, { sha: null, message: message('import', slug) }); },
      async remove(slug) {
        const got = await client.getPost(slug);
        if (got) await client.deletePost(slug, { sha: got.sha, message: message('delete placeholder', slug) });
      },
    };
  }

  const report = await applyImport(snapshot, target, { dryRun, keep });
  for (const r of report.results) console.log(`${r.outcome.padEnd(9)} ${r.slug}${r.error ? `: ${r.error}` : ''}`);
  const c = report.counts;
  console.log(`\n${c.created} ${dryRun ? 'to create' : 'created'}, ${c.unchanged} unchanged, ${c.kept} kept (the file differs; left alone), `
    + `${c.deleted} placeholders ${dryRun ? 'to delete' : 'deleted'}, ${c.error} errors`);
  if (dryRun && (c.created || c.deleted)) console.error('Dry run: nothing was written. Re-run with --yes.');
  process.exit(c.error ? 1 : 0);
}
