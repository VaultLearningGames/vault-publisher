// Types for portal-blog-tags.js (shared by the server and the blog editor).
export interface TagCount { name: string; count: number }

export const MAX_TAGS: number;
export const MAX_TAG_LENGTH: number;
export const DEFAULT_TAG_LIMIT: number;
export const MAX_TAG_LIMIT: number;
export function normalizeTag(input: unknown): string | null;
export function tagKey(name: string): string;
export function sanitizeTags(list: unknown, keep?: readonly string[]): string[];
export function addTag(tags: string[], name: string): { tags: string[]; error: string };
export function tagLimit(value: unknown): number;
export function rankTags(tagLists: Iterable<readonly unknown[] | null | undefined>, q?: string, limit?: number): TagCount[];
