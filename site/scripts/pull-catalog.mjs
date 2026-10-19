#!/usr/bin/env node
// Save the published game listings from the Vault Studio Portal to data/catalog.json, which
// content/games/_content.gotmpl turns into the game pages, and the public blog (/v1/blog) to data/blog.json, which
// content/blog/_content.gotmpl turns into the /blog pages and feeds.
//
//   npm run catalog                                      # from https://portal.vaultlearninggames.org
//   VAULT_PORTAL=http://localhost:4181 npm run catalog   # from a local portal (vault-publisher: node scripts/dev-portal.ts)
//
// If the portal can't be reached, the existing data/catalog.json is kept and the build carries on with it; the same
// for data/blog.json. With neither the portal nor a saved file, the build fails: it never quietly ships an empty site
// or blog. A portal that has no /v1/blog yet (404: one deployed before the blog was built by the site) gives an empty
// blog, with a warning. blog.json is rewritten only when its content changed.
//   BLOG_DATA_FIXTURE=site/data-fixtures/blog.sample.json   copy that file to data/blog.json instead (tests, local builds)
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const portal = (process.env.VAULT_PORTAL || 'https://portal.vaultlearninggames.org').replace(/\/+$/, '');
const out = join(import.meta.dirname, '..', 'data', 'catalog.json');
const blogOut = join(import.meta.dirname, '..', 'data', 'blog.json');

try {
  const res = await fetch(`${portal}/v1/catalog`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const catalog = await res.json();
  if (!Array.isArray(catalog.games)) throw new Error('not a catalog');
  await writeFile(out, JSON.stringify(catalog, null, 1) + '\n');
  console.log(`catalog: ${catalog.games.length} games from ${portal}`);
} catch (err) {
  const kept = await readFile(out, 'utf8').then((t) => JSON.parse(t).games.length).catch(() => null);
  if (kept === null) { console.error(`catalog: couldn't reach ${portal} (${err.message}) and there's no data/catalog.json yet`); process.exit(1); }
  console.warn(`catalog: couldn't reach ${portal} (${err.message}); keeping data/catalog.json (${kept} games)`);
}

const EMPTY_BLOG = { version: 1, posts: [], tags: [], redirects: [] };
const isBlog = (b) => !!b && Array.isArray(b.posts) && Array.isArray(b.tags) && Array.isArray(b.redirects);
// Writes data/blog.json unless it already holds exactly this.
async function saveBlog(blog) {
  const text = JSON.stringify(blog, null, 2) + '\n';
  if (await readFile(blogOut, 'utf8').catch(() => null) === text) return false;
  await writeFile(blogOut, text);
  return true;
}

try {
  let blog, from;
  if (process.env.BLOG_DATA_FIXTURE) {
    from = process.env.BLOG_DATA_FIXTURE;
    blog = JSON.parse(await readFile(from, 'utf8'));
  } else {
    from = portal;
    const res = await fetch(`${portal}/v1/blog`, { signal: AbortSignal.timeout(20000) });
    if (res.status === 404) {
      console.warn(`blog: ${portal} has no /v1/blog yet; building an empty blog`);
      blog = EMPTY_BLOG;
    } else {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      blog = await res.json();
    }
  }
  if (!isBlog(blog)) throw new Error('not a blog');
  const changed = await saveBlog(blog);
  console.log(`blog: ${blog.posts.length} posts, ${blog.tags.length} tags from ${from}${changed ? '' : ' (unchanged)'}`);
} catch (err) {
  const kept = await readFile(blogOut, 'utf8').then((t) => JSON.parse(t)).then((b) => (isBlog(b) ? b.posts.length : null)).catch(() => null);
  if (kept === null) { console.error(`blog: couldn't get the blog (${err.message}) and there's no data/blog.json yet`); process.exit(1); }
  console.warn(`blog: couldn't get the blog (${err.message}); keeping data/blog.json (${kept} posts)`);
}
