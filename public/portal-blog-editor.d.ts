// Types for portal-blog-editor.js (a browser module), so its pure block functions can be tested from TypeScript.
import type { Align, Block, Span } from '../src/blog/blocks.ts';

export type EditorBlock =
  | { key: string; type: 'heading'; level: 2 | 3 | 4; text: string }
  | { key: string; type: 'paragraph'; html: string }
  | { key: string; type: 'image'; src: string; alt: string; caption: string; align: Align | '' }
  | { key: string; type: 'divider' };

export const BLOCK_TYPES: Block['type'][];
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
