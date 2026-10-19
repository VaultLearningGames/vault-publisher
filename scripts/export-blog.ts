// The one-time export of the portal database's blog posts to vault-site (src/blog/export.ts): one
// content/blog/<slug>/index.md per post, with its tags and its old slugs as aliases. Existing files are never touched,
// so it can be run again: a second run writes nothing. Dry run by default.
//
//   node scripts/export-blog.ts --out ../vault-site            dry run against a vault-site checkout
//   node scripts/export-blog.ts --out ../vault-site --yes      writes the files (commit them in vault-site)
//   node scripts/export-blog.ts --github --yes                 one commit per new post, through the Contents API
//                                                              (VAULT_SITE_GITHUB_TOKEN, VAULT_SITE_REPO, ...: src/site-content/config.ts)
//
// The database is opened read-only, from --db or $DB_PATH (default data/publisher.db); the blog tables may be the
// originals or the retired_blog_* copies (Db.retireBlogTables). Exits 1 when any post could not be exported.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { exportBlog, type ExportTarget } from '../src/blog/export.ts';
import { createSiteContentClient, DEFAULT_BLOG_DIR } from '../src/site-content/index.ts';
import { scriptPortalUser, withPortalUserTrailer } from '../src/site-repo/config.ts';

const { values } = parseArgs({
  options: { out: { type: 'string' }, github: { type: 'boolean' }, yes: { type: 'boolean' }, db: { type: 'string' }, 'blog-dir': { type: 'string' } },
});
if (!values.out === !values.github) {
  console.error('usage: node scripts/export-blog.ts (--out VAULT-SITE-DIR | --github) [--yes] [--db PATH] [--blog-dir content/blog]   (dry run without --yes)');
  process.exit(2);
}
const dbPath = values.db ?? process.env.DB_PATH ?? 'data/publisher.db';
if (!existsSync(dbPath)) { console.error(`no database at ${dbPath}`); process.exit(2); }
const sqlite = new DatabaseSync(dbPath, { readOnly: true });

let target: ExportTarget;
if (values.out) {
  const blogDir = resolve(values.out, values['blog-dir'] ?? DEFAULT_BLOG_DIR);
  const file = (slug: string) => join(blogDir, slug, 'index.md');
  target = {
    read: (slug) => readFile(file(slug), 'utf8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; }),
    async create(slug, raw) {
      await mkdir(join(blogDir, slug), { recursive: true });
      await writeFile(file(slug), raw, { flag: 'wx' });   // never over a file that appeared meanwhile
    },
  };
} else {
  const client = createSiteContentClient();
  target = {
    read: async (slug) => (await client.getPost(slug))?.raw ?? null,
    async create(slug, raw) { await client.putPost(slug, raw, { sha: null, message: withPortalUserTrailer(`blog: export ${slug} from the portal database`, scriptPortalUser()) }); },
  };
}

const report = await exportBlog(sqlite, target, { dryRun: !values.yes });
for (const r of report.results) console.log(`${r.outcome.padEnd(9)} ${r.slug}${r.error ? `: ${r.error}` : ''}`);
const c = report.counts;
console.log(`\n${c.created} ${values.yes ? 'created' : 'to create'}, ${c.unchanged} unchanged, ${c.kept} kept (the file differs; left alone), ${c.error} errors`);
if (!values.yes && c.created) console.error('Dry run: nothing was written. Re-run with --yes.');
process.exit(c.error ? 1 : 0);
