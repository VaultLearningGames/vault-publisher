// The import of Field Day Lab's Medium blog (https://medium.com/@fielddaylab) into vault-site (src/blog/import/medium.ts,
// medium-apply.ts): fetch takes a snapshot, apply writes it, rollback removes it. Dry run unless --yes; nothing here
// runs in CI or tests. See docs/blog-import.md.
//
//   node scripts/import-medium-fielddaylab.ts fetch [--dir data/blog-import/medium] [--cdn URL] [--export DIR] [--urls FILE] [--limit N]
//       Discovers the posts (best effort, the union of: the RSS feed, the profile's JSON stream page by page, the
//       sitemaps, the profile pages; plus the HTML files of Medium's own export in --export DIR/posts and the addresses
//       listed in --urls FILE, one per line), deduplicated by Medium post id, logging how many each source found. Reads
//       each post (the feed's or the export's copy, else its page), downloads every image to <dir>/images/<sha-256>.<ext>
//       and writes <dir>/medium-posts.json with the converted posts and each image's CDN copy (site/<slug>/...).
//
//   node scripts/import-medium-fielddaylab.ts apply (--out VAULT-SITE-DIR | --github) [--yes] [--skip-images]
//       Uploads the images to the Vault CDN bucket (R2_ACCOUNT_ID, R2_CDN_ACCESS_KEY_ID, R2_CDN_SECRET_ACCESS_KEY,
//       CDN_BUCKET), then creates content/blog/<slug>/index.md for each post not imported yet. No other post changes.
//
//   node scripts/import-medium-fielddaylab.ts rollback (--out VAULT-SITE-DIR | --github) [--yes]
//       Deletes every post with a "medium:" import_source, and nothing else.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { IMAGE_CACHE } from '../src/assets.ts';
import {
  applyMediumImport, checkMediumSnapshot, importSourceOf, rollbackMediumImport, type MediumExistingPost, type MediumReport, type MediumTarget,
} from '../src/blog/import/medium-apply.ts';
import {
  canonicalPostUrl, discoverUrls, MEDIUM_FEED, MEDIUM_PROFILE, MEDIUM_USER, mediumPostId, mediumSlug, parsePostPage, parseRssFeed,
  parseStreamPage, postImages, postToRecord, sitemapLocs, type Discovered, type MediumPost, type MediumRecord, type MediumSnapshot,
} from '../src/blog/import/medium.ts';
import type { ImportImage } from '../src/blog/import/squarespace.ts';
import { buildImageKey, contentHash, imageUrl, sniffImageType } from '../src/blog/imageKey.ts';
import { MAX_SLUG } from '../src/blog/slug.ts';
import { createSiteContentClient, DEFAULT_BLOG_DIR, parsePostFile } from '../src/site-content/index.ts';
import { scriptPortalUser, withPortalUserTrailer } from '../src/site-repo/config.ts';
import { createR2Storage, objectExists } from '../src/storage.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' }, cdn: { type: 'string' }, out: { type: 'string' }, github: { type: 'boolean' }, yes: { type: 'boolean' },
    'skip-images': { type: 'boolean' }, 'blog-dir': { type: 'string' }, export: { type: 'string' }, urls: { type: 'string' }, limit: { type: 'string' },
  },
});
const command = positionals[0];
const dir = resolve(values.dir ?? 'data/blog-import/medium');
const snapshotPath = join(dir, 'medium-posts.json');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; vault-portal blog import)';

if (command === 'fetch') await fetchSnapshot();
else if (command === 'apply') await apply();
else if (command === 'rollback') await rollback();
else {
  console.error('usage: node scripts/import-medium-fielddaylab.ts fetch [--dir DIR] [--cdn URL] [--export DIR] [--urls FILE] [--limit N]\n'
    + '       node scripts/import-medium-fielddaylab.ts apply (--out VAULT-SITE-DIR | --github) [--yes] [--skip-images] [--dir DIR]\n'
    + '       node scripts/import-medium-fielddaylab.ts rollback (--out VAULT-SITE-DIR | --github) [--yes]');
  process.exit(2);
}

async function getText(url: string, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'): Promise<string> {
  const res = await fetch(url, { headers: { Accept: accept, 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.text();
}

// One discovery source; a source that fails is logged and counts 0.
async function source(name: string, found: Map<string, Discovered>, counts: Record<string, number>, run: () => Promise<Discovered[]>) {
  try {
    const got = await run();
    counts[name] = new Set(got.map((d) => d.id)).size;
    for (const d of got) if (!found.has(d.id)) found.set(d.id, d);
    console.log(`discovery ${name}: ${counts[name]} posts`);
  } catch (err) {
    counts[name] = 0;
    console.error(`discovery ${name}: failed (${(err as Error).message})`);
  }
}

async function fetchSnapshot() {
  const cdn = (values.cdn ?? process.env.CDN_PUBLIC_URL ?? 'https://cdn.vaultlearninggames.org').replace(/\/+$/, '');
  const found = new Map<string, Discovered>();
  const counts: Record<string, number> = {};
  // Full copies of posts, by id: the feed's and the export's (no page fetch needed for those).
  const full = new Map<string, MediumPost>();
  const hints = new Map<string, { title: string; publishedAt: string | null; author: string | null }>();

  await source('rss', found, counts, async () => {
    const posts = parseRssFeed(await getText(MEDIUM_FEED, 'application/rss+xml,application/xml'));
    for (const p of posts) full.set(p.id, p);
    return posts.map((p) => ({ id: p.id, url: p.url, source: 'rss' }));
  });
  await source('stream', found, counts, async () => {
    const out: Discovered[] = [];
    let to: string | null = null;
    for (let page = 0; page < 100; page++) {
      const url = `${MEDIUM_PROFILE}/latest?format=json&limit=100${to ? `&to=${encodeURIComponent(to)}` : ''}`;
      const got = parseStreamPage(await getText(url, 'application/json'));
      const fresh = got.posts.filter((p) => !out.some((d) => d.id === p.id));
      for (const p of fresh) { out.push({ id: p.id, url: canonicalPostUrl(p.url), source: 'stream' }); hints.set(p.id, p); }
      if (!got.next || !fresh.length || got.next === to) break;
      to = got.next;
    }
    return out;
  });
  await source('sitemap', found, counts, async () => {
    const out: Discovered[] = [];
    const queue = [`https://${MEDIUM_USER}.medium.com/sitemap/sitemap.xml`, `${MEDIUM_PROFILE}/sitemap/sitemap.xml`];
    const seen = new Set<string>();
    let errors = 0;
    while (queue.length && seen.size < 200) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      let xml: string;
      try { xml = await getText(url, 'application/xml'); } catch { errors++; continue; }
      for (const loc of sitemapLocs(xml)) {
        if (/sitemap|\.xml$/i.test(new URL(loc, url).pathname) && !mediumPostId(loc)) queue.push(loc);
      }
      out.push(...discoverUrls(xml, 'sitemap'));
    }
    if (errors === seen.size) throw new Error('no sitemap could be read');
    return out;
  });
  await source('profile', found, counts, async () => {
    const out: Discovered[] = [];
    let ok = 0;
    for (const url of [MEDIUM_PROFILE, `${MEDIUM_PROFILE}/archive`, `https://${MEDIUM_USER}.medium.com/`]) {
      try { out.push(...discoverUrls(await getText(url), 'profile')); ok++; } catch { /* the next one */ }
    }
    if (!ok) throw new Error('no profile page could be read');
    return out;
  });
  if (values.export) {
    await source('export', found, counts, async () => {
      const postsDir = existsSync(join(values.export!, 'posts')) ? join(values.export!, 'posts') : values.export!;
      const out: Discovered[] = [];
      for (const f of (await readdir(postsDir)).filter((n) => n.endsWith('.html')).sort()) {
        if (f.startsWith('draft_')) { console.log(`skipped  ${f}: a draft`); continue; }
        const p = parsePostPage(await readFile(join(postsDir, f), 'utf8'));
        if (!p) { console.error(`export   ${f}: no Medium post id`); continue; }
        full.set(p.id, p);
        out.push({ id: p.id, url: p.url, source: 'export' });
      }
      return out;
    });
  }
  if (values.urls) {
    await source('urls', found, counts, async () => {
      const lines = (await readFile(values.urls!, 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      return lines.flatMap((l) => { const id = mediumPostId(l); return id ? [{ id, url: canonicalPostUrl(l), source: 'urls' }] : []; });
    });
  }
  counts.total = found.size;
  console.log(`discovered ${found.size} posts in all`);

  // Each post's full copy.
  const skipped: MediumSnapshot['skipped'] = [];
  const posts: MediumPost[] = [];
  let list = [...found.values()];
  if (values.limit) list = list.slice(0, Number(values.limit));
  for (const d of list) {
    let post = full.get(d.id) ?? null;
    if (!post) {
      try { post = parsePostPage(await getText(d.url), d.url); } catch (err) { skipped.push({ sourceUrl: d.url, reason: (err as Error).message }); console.error(`skipped  ${d.url}: ${(err as Error).message}`); continue; }
    }
    if (!post) { skipped.push({ sourceUrl: d.url, reason: 'not a Medium post page' }); console.error(`skipped  ${d.url}: not a Medium post page`); continue; }
    const hint = hints.get(d.id);
    post = { ...post, id: d.id, title: post.title || hint?.title || '', publishedAt: post.publishedAt ?? hint?.publishedAt ?? null, author: post.author ?? hint?.author ?? null };
    if (!post.publishedAt) { skipped.push({ sourceUrl: d.url, reason: 'no publish date' }); console.error(`skipped  ${d.url}: no publish date`); continue; }
    if (!post.bodyHtml.trim()) { skipped.push({ sourceUrl: d.url, reason: 'no body (Medium may have served a sign-in or challenge page)' }); console.error(`skipped  ${d.url}: no body`); continue; }
    posts.push(post);
  }

  // Slugs, oldest first so an older post keeps the plain one; a clash between two Medium posts gets the id.
  posts.sort((a, b) => a.publishedAt!.localeCompare(b.publishedAt!));
  const slugOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const p of posts) {
    let slug = mediumSlug(p.url, p.title);
    if (taken.has(slug)) slug = `${slug.slice(0, MAX_SLUG - p.id.length - 1).replace(/-+$/, '')}-${p.id}`;
    taken.add(slug);
    slugOf.set(p.id, slug);
  }

  await mkdir(join(dir, 'images'), { recursive: true });
  const images: Record<string, ImportImage> = {};
  const records: MediumRecord[] = [];
  for (const p of posts) {
    const slug = slugOf.get(p.id)!;
    for (const original of postImages(p)) {
      if (images[original]) continue;
      try { images[original] = await download(original, slug, cdn); } catch (err) { console.error(`  image ${original}: ${(err as Error).message}`); }
    }
    try {
      const record = postToRecord(p, { slug, image: (u) => images[u]?.url ?? null, postSlug: (id) => slugOf.get(id) ?? null });
      records.push(record);
      console.log(`fetched  ${record.slug} (${record.author_name}, ${record.publishedAt.slice(0, 10)})${record.warnings.length ? `\n  ${record.warnings.join('\n  ')}` : ''}`);
    } catch (err) {
      skipped.push({ sourceUrl: p.url, reason: (err as Error).message });
      console.error(`skipped  ${p.url}: ${(err as Error).message}`);
    }
  }
  records.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
  const snapshot: MediumSnapshot = { version: 1, kind: 'medium', source: MEDIUM_PROFILE, fetchedAt: new Date().toISOString(), discovered: counts, images, posts: records, skipped };
  checkMediumSnapshot(snapshot);
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`\n${records.length} posts, ${Object.keys(images).length} images, ${skipped.length} skipped -> ${snapshotPath}`);
}

async function download(url: string, slug: string, cdn: string): Promise<ImportImage> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
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

function target(): MediumTarget {
  if (!values.out === !values.github) { console.error(`${command} needs --out VAULT-SITE-DIR or --github`); process.exit(2); }
  const sourceOf = (raw: string, slug: string) => {
    try { return importSourceOf(parsePostFile(raw).frontMatter); } catch { console.error(`unreadable ${slug}: taken as not imported`); return null; }
  };
  if (values.out) {
    const blogDir = resolve(values.out, values['blog-dir'] ?? DEFAULT_BLOG_DIR);
    const file = (slug: string) => join(blogDir, slug, 'index.md');
    const read = (slug: string) => readFile(file(slug), 'utf8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
    return {
      async list() {
        const out: MediumExistingPost[] = [];
        for (const e of await readdir(blogDir, { withFileTypes: true }).catch(() => [])) {
          if (!e.isDirectory()) continue;
          const raw = await read(e.name);
          if (raw !== null) out.push({ slug: e.name, source: sourceOf(raw, e.name) });
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
  }
  const client = createSiteContentClient();
  const message = (verb: string, slug: string) => withPortalUserTrailer(`blog: ${verb} ${slug} (the Medium blog import)`, scriptPortalUser());
  return {
    async list() {
      const out: MediumExistingPost[] = [];
      for (const ref of await client.listPosts()) {
        const got = await client.getPost(ref.slug);
        if (got) out.push({ slug: ref.slug, source: sourceOf(got.raw, ref.slug) });
      }
      return out;
    },
    read: async (slug) => (await client.getPost(slug))?.raw ?? null,
    async create(slug, raw) { await client.putPost(slug, raw, { sha: null, message: message('import', slug) }); },
    async remove(slug) {
      const got = await client.getPost(slug);
      if (got) await client.deletePost(slug, { sha: got.sha, message: message('roll back', slug) });
    },
  };
}

function report(r: MediumReport, dryRun: boolean) {
  for (const x of r.results) console.log(`${x.outcome.padEnd(9)} ${x.slug}${x.sourceUrl ? ` <- ${x.sourceUrl}` : ''}${x.error ? `: ${x.error}` : ''}`);
  const c = r.counts;
  console.log(`\n${c.created} ${dryRun ? 'to create' : 'created'}, ${c.unchanged} unchanged, ${c.kept} kept (the file differs; left alone), `
    + `${c.deleted} ${dryRun ? 'to delete' : 'deleted'}, ${c.error} errors`);
  if (dryRun && (c.created || c.deleted)) console.error('Dry run: nothing was written. Re-run with --yes.');
  process.exit(c.error ? 1 : 0);
}

async function apply() {
  if (!existsSync(snapshotPath)) { console.error(`no snapshot at ${snapshotPath}; run fetch first`); process.exit(2); }
  const snapshot = checkMediumSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8')));
  const dryRun = !values.yes;
  const t = target();

  if (!values['skip-images']) {
    const env = process.env;
    const ready = env.R2_ACCOUNT_ID && env.R2_CDN_ACCESS_KEY_ID && env.R2_CDN_SECRET_ACCESS_KEY && env.CDN_BUCKET;
    if (!ready && !dryRun) { console.error('the images need R2_ACCOUNT_ID, R2_CDN_ACCESS_KEY_ID, R2_CDN_SECRET_ACCESS_KEY and CDN_BUCKET (or --skip-images)'); process.exit(2); }
    const storage = ready ? createR2Storage({ accountId: env.R2_ACCOUNT_ID!, accessKeyId: env.R2_CDN_ACCESS_KEY_ID!, secretAccessKey: env.R2_CDN_SECRET_ACCESS_KEY!, bucket: env.CDN_BUCKET! }) : null;
    let failed = false;
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
  report(await applyMediumImport(snapshot, t, { dryRun }), dryRun);
}

async function rollback() {
  const dryRun = !values.yes;
  report(await rollbackMediumImport(target(), { dryRun }), dryRun);
}
