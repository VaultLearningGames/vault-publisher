// Types for portal-blog-editor-commands.js (a browser module), so its pure parts can be tested from TypeScript.
export const INLINE: Record<'bold' | 'italic' | 'underline' | 'strike' | 'bullets' | 'numbers' | 'clear', string>;
export const STYLES: [tag: 'p' | 'h2' | 'h3' | 'h4' | 'blockquote', label: string][];
export const MAX_INDENT: number;
export function stepIndent(current: string | number | null | undefined, delta: number): number;
export function setup(doc?: Document): void;
export function run(name: string, value?: string): boolean;
export function insertText(text: string): boolean;
export function createLink(href: string): boolean;
export function unlink(): boolean;
export function currentBlock(area: HTMLElement): HTMLElement | null;
export function currentStyle(area: HTMLElement): 'p' | 'h2' | 'h3' | 'h4' | 'blockquote';
export function setStyle(area: HTMLElement, tag: string): boolean;
export function indent(area: HTMLElement, delta: number): boolean;
export function active(): Record<'bold' | 'italic' | 'underline' | 'strike', boolean>;
export function rangeIn(area: HTMLElement, sel?: Selection | null): Range | null;
export function styleTags(style: string | null | undefined): ('strong' | 'em' | 'u' | 's')[];
export function htmlOf(area: HTMLElement): string;
