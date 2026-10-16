// Writes the sample blog the site builds from in tests and local builds (BLOG_DATA_FIXTURE): GET /v1/blog's payload
// (src/blog/publicPayload.ts) for a seeded in-memory database. Next to the posts it shows there are a private post (a
// page, noindex, in no list), a draft, a scheduled post and a post that was renamed (an old-slug redirect).
//   node scripts/blog-sample.ts [site/data-fixtures/blog.sample.json]
import { writeFile } from 'node:fs/promises';
import { Db } from '../src/db.ts';
import { BlogRepo, type BlogPostInput } from '../src/blog/repo.ts';
import { buildBlogPayload } from '../src/blog/publicPayload.ts';

const out = process.argv[2] ?? 'site/data-fixtures/blog.sample.json';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const CDN = 'https://cdn.vaultlearninggames.org/site';
const repo = new BlogRepo(new Db(':memory:').sqlite);
const post = (p: Partial<BlogPostInput> & Pick<BlogPostInput, 'slug' | 'title'>) => repo.create({
  blocks: [], excerpt: '', featured_image: null, author: 'Vault Team', status: 'published', published_at: null, tags: [], ...p,
});

post({ slug: 'welcome-to-the-vault-blog', title: 'Welcome to the Vault blog', published_at: '2026-10-01T15:00:00.000Z',
  excerpt: 'News from the Vault Learning Games Library.', featured_image: `${CDN}/welcome-to-the-vault-blog/${'a'.repeat(64)}.jpg`,
  tags: ['News', 'Teachers'], blocks: [
    { type: 'heading', level: 2, text: 'Why a blog?' },
    { type: 'paragraph', html: '<p>Games, research and <strong>classroom</strong> ideas, with <a href="https://fielddaylab.wisc.edu">Field Day Lab</a>.</p>' },
    { type: 'image', src: `${CDN}/welcome-to-the-vault-blog/${'b'.repeat(64)}.png`, alt: 'Students playing', caption: 'A class trying Wake', align: 'wide' },
    { type: 'divider' },
    { type: 'heading', level: 3, text: 'What comes next' },
    { type: 'paragraph', children: [{ text: 'More posts ' }, { text: 'soon', marks: ['italic'] }, { text: '.' }] },
  ] });
const renamed = post({ slug: 'old-research-notes', title: 'Research notes', published_at: '2026-10-08T15:00:00.000Z',
  tags: ['Research', 'News'], blocks: [
    { type: 'paragraph', html: '<p>What we learned from a year of play data.</p><ul><li>Players return</li><li>Teachers share</li></ul>' },
    { type: 'image', src: `${CDN}/research-notes/${'c'.repeat(64)}.webp`, alt: 'A chart', align: 'center' },
  ] });
repo.update(renamed.id, { ...renamed, slug: 'research-notes', tags: renamed.tags.map((t) => t.name) });
post({ slug: 'a-private-note', title: 'A private note', status: 'private', published_at: '2026-10-05T15:00:00.000Z', tags: ['Secret'],
  blocks: [{ type: 'paragraph', html: '<p>Only for people with the link.</p>' }] });
post({ slug: 'a-draft', title: 'A draft', tags: ['Drafts'], blocks: [{ type: 'paragraph', html: '<p>Not yet.</p>' }] });
post({ slug: 'a-scheduled-post', title: 'A scheduled post', published_at: '2027-01-01T15:00:00.000Z', tags: ['Later'] });

await writeFile(out, JSON.stringify(buildBlogPayload(repo.sqlite, { now: NOW }), null, 2) + '\n');
console.log(`blog sample: ${out}`);
