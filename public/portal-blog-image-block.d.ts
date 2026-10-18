// Types for portal-blog-image-block.js (shared by the server and the browser editor).
export type ImageLayout = 'stacked' | 'grid' | 'carousel' | 'slideshow';
export type ImageAlign = 'left' | 'center' | 'right' | 'wide' | 'full';
export type LinkTarget = '_self' | '_blank';

export interface ImageItem {
  id: string; url: string; alt: string; title: string; description: string;
  showTitle: boolean; showDescription: boolean; link: string; linkTarget: LinkTarget;
}
export interface ImageBlock {
  type: 'image'; layout: ImageLayout; align?: ImageAlign; images: ImageItem[];
  src?: string; alt?: string; caption?: string;
}

export const LAYOUTS: ImageLayout[];
export const DEFAULT_LAYOUT: ImageLayout;
export const LAYOUT_LABELS: Record<ImageLayout, string>;
export const LINK_TARGETS: LinkTarget[];
export const ALIGNS: ImageAlign[];
export const MAX_IMAGES: number;
export const MAX_TITLE: number;
export const MAX_DESCRIPTION: number;
export const MAX_ALT: number;
export function cleanTitle(s: unknown): string;
export function cleanDescription(s: unknown): string;
export function newImageId(): string;
export function normalizeImageItem(v: unknown, i?: number): ImageItem;
export function visibleCaption(img: ImageItem): string;
export function normalizeImageBlock(b: unknown): ImageBlock;
export function isImageLink(href: string): boolean;
