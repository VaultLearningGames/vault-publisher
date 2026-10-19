// A whole blog post file (content/blog/<slug>/index.md): front matter (frontmatter.ts) and the body as blocks
// (markdown-blocks.ts). parsePostFile keeps what it needs to write the file back byte for byte: serializePostFile of an
// unchanged parse is the file again, and a changed post rewrites only what changed (the body is rewritten only when
// its blocks changed).
import { isDeepStrictEqual } from 'node:util';
import type { Block } from '../blog/blocks.ts';
import type { BlogPostInput, BlogStatus } from '../blog/repo.ts';
import { serializeFrontMatter, splitFrontMatter, type FrontMatter, type FrontMatterLayout } from './frontmatter.ts';
import { blocksToMarkdown, markdownToBlocks } from './markdown-blocks.ts';

export interface PostFile {
  frontMatter: FrontMatter;
  blocks: Block[];
  // How the file was written, for serializePostFile: absent for a new post.
  source?: { layout: FrontMatterLayout; body: string; blocks: Block[] };
}

// Throws FrontMatterError when the front matter can't be read.
export function parsePostFile(raw: string): PostFile {
  const { frontMatter, layout, body } = splitFrontMatter(raw);
  const blocks = markdownToBlocks(body);
  return { frontMatter, blocks, source: { layout, body, blocks: structuredClone(blocks) } };
}

const canon = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

export function serializePostFile(post: PostFile): string {
  const src = post.source;
  const eol = src?.layout.eol ?? '\n';
  const body = src && isDeepStrictEqual(canon(src.blocks), canon(post.blocks)) ? src.body : blocksToMarkdown(post.blocks, eol);
  return serializeFrontMatter(post.frontMatter, body, src?.layout);
}

// ---------- the portal's post fields ----------
// A draft is a post with no published_at (the portal's model): written `draft: true` with no date. A private post is
// status 'private'. The slug is the post's folder, not front matter.

export function postInputFromFile(slug: string, post: PostFile): BlogPostInput {
  const fm = post.frontMatter;
  return {
    slug, title: fm.title, blocks: post.blocks, excerpt: fm.description, featured_image: fm.featured_image, author: fm.author,
    status: (fm.private ? 'private' : 'published') satisfies BlogStatus, published_at: fm.draft ? null : fm.date, tags: [...fm.tags],
  };
}

// The post's fields applied to a file (or a new one): its other front matter and its layout are kept.
export function applyPostInput(input: Omit<BlogPostInput, 'slug'>, prev?: PostFile): PostFile {
  const fm: FrontMatter = prev ? { ...prev.frontMatter, extra: { ...prev.frontMatter.extra } } : {
    title: '', date: null, draft: false, private: false, author: '', description: '', featured_image: null, tags: [], aliases: [], extra: {},
  };
  fm.title = input.title;
  fm.description = input.excerpt;
  fm.featured_image = input.featured_image;
  fm.author = input.author;
  fm.private = input.status === 'private';
  fm.draft = input.published_at === null;
  // A draft keeps no date; an unchanged date keeps the way it was written.
  if (input.published_at === null) fm.date = null;
  else if (fm.date === null || Date.parse(fm.date) !== Date.parse(input.published_at)) fm.date = input.published_at;
  fm.tags = [...input.tags];
  return { frontMatter: fm, blocks: input.blocks, source: prev?.source };
}
