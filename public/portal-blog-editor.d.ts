// Types for portal-blog-editor.js (a browser module), so its pure block functions can be tested from TypeScript.
import type { Align, Block, Span } from '../src/blog/blocks.ts';
import type { ImageItem, ImageLayout } from './portal-blog-image-block.js';

export type EditorBlock =
  | { key: string; type: 'heading'; level: 2 | 3 | 4; text: string }
  | { key: string; type: 'paragraph'; html: string }
  | { key: string; type: 'image'; layout: ImageLayout; align: Align | ''; images: ImageItem[] }
  | { key: string; type: 'divider' };

export const BLOCK_TYPES: Block['type'][];
export const BLOCK_LABELS: Record<Block['type'], string>;
export const ALIGNS: Align[];
export function escapeHtml(s: string): string;
export function spansToHtml(children: Span[]): string;
export function htmlHasText(html: string): boolean;
export function newBlock(type: Block['type']): EditorBlock;
export function deserializeBlocks(blocks: unknown): EditorBlock[];
export function serializeBlocks(items: EditorBlock[]): Block[];
export function moveBlock<T>(items: T[], from: number, to: number): T[];
export function insertBlock<T>(items: T[], index: number, item: T): T[];
export function removeBlock<T extends { key: string }>(items: T[], key: string): T[];
export function saveBody(title: string, items: EditorBlock[], updatedAt: string | null): { title: string; blocks: Block[]; updated_at: string | null };
export function isLinkHref(href: string): boolean;

export interface EditorSettings {
  slug: string; slugTaken?: boolean; excerpt: string; featured_image: string; author: string;
  published_at: string | null; tags: string[];
}
export interface AutosaveState { dueAt: number | null; saving: boolean; stopped: boolean }
export type AutosaveAction = { type: 'change'; at: number } | { type: 'start' } | { type: 'done'; ok?: boolean } | { type: 'stop' };

export const MAX_SLUG: number;
export const MAX_TAGS: number;
export const MAX_TAG_LENGTH: number;
export const AUTOSAVE_DELAY: number;
export function slugify(input: string): string;
export function isAutoSlug(slug: string, title: string, publishedAt: string | null): boolean;
export function normalizeTag(input: unknown): string | null;
export function tagOptions(suggestions: { name: string; count?: number }[] | null | undefined, typed: string, current: string[]): { name: string; count?: number; isNew: boolean }[];
export function addTag(tags: string[], name: string): { tags: string[]; error: string };
export function toLocalInput(iso: string | null): string;
export function fromLocalInput(value: string): string | null;
export function savedLabel(date: Date): string;
export function settingsBody(s: EditorSettings): {
  slug?: string; excerpt: string; featured_image: string | null; author: string;
  published_at: string | null; tags: string[];
};
export function autosaveInit(): AutosaveState;
export function autosaveStep(state: AutosaveState, action: AutosaveAction, delay?: number): AutosaveState;
export function autosaveDue(state: AutosaveState, now: number): boolean;
export const FEATURED_IMAGE_ASPECT: number;
export const FEATURED_IMAGE_OUTPUT_MAX_WIDTH: number;
export const FEATURED_IMAGE_CANT_ADJUST: string;
export function isFeaturedImageSrc(v: string): boolean;
