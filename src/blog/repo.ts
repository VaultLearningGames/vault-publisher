// The blog post's fields as the portal's editor and API work with them. Posts are Markdown files in the vault-site
// repository (blog/siteRepo.ts; site-content/post-file.ts maps a file to these fields and back). The portal's old
// blog tables (db.ts v17, v18) are left in place, unused.
import type { Block } from './blocks.ts';

export type BlogStatus = 'published' | 'private';
export interface BlogTag { slug: string; name: string }
export interface BlogPostInput {
  slug: string; title: string; blocks: Block[]; excerpt: string; featured_image: string | null; author: string;
  status: BlogStatus; published_at: string | null; tags: string[];
}
