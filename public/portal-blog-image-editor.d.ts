// Types for portal-blog-image-editor.js (a browser module), so its pure functions can be tested from TypeScript.
export interface CropRect { x: number; y: number; w: number; h: number }

export const MAX_WIDTH: number;
export const MAX_UPLOAD_BYTES: number;
export const MIN_CROP: number;
export const DEFAULT_QUALITY: number;
export const MIN_ZOOM: number;
export const MAX_ZOOM: number;
export const ACCEPT: string;
export const CROP_PRESETS: { id: string; label: string; ratio: number | null }[];
export const DROPZONE_LABEL: string;
export const DROPZONE_HINT: string;
export function uploadUrl(slug: string): string;
export function presetCrop(w: number, h: number, ratio: number | null): CropRect;
export function clampCrop(r: CropRect, w: number, h: number, ratio: number | null): CropRect;
export function zoomCrop(crop: CropRect, w: number, h: number, ratio: number | null, zoom: number): CropRect;
export function cropZoom(crop: CropRect, w: number, h: number, ratio: number | null): number;
export function outputSize(cropW: number, cropH: number, width?: number | string, maxWidth?: number): { width: number; height: number };
export function formatBytes(n: number): string;
export function sizeChange(before: number, after: number): string;
export function isImageFile(f: { type?: string } | null | undefined): boolean;
export function imageFromTransfer(dt: unknown): File | null;
export function imageFilesFromTransfer(dt: unknown): File[];
export function uploadImage(slug: string, blob: Blob, name?: string, fetchFn?: typeof fetch): Promise<{ key: string; url: string; contentType: string; bytes: number; created: boolean }>;
export function fetchImageBlob(url: string, fetchFn?: (input: string, init?: RequestInit) => Promise<Response>): Promise<Blob | null>;
export function openImageEditor(file: Blob, opts?: { slug?: string; alt?: string; withAlt?: boolean; title?: string; aspect?: number; maxWidth?: number }): Promise<{ url: string; alt: string; bytes: number } | null>;
export function imageDropTarget(target: HTMLElement, onPick: (file: File) => void): HTMLElement;
export function imagesDropTarget(target: HTMLElement, onPick: (files: File[]) => void, label?: string): HTMLElement;
export function imageDropzone(o?: { id?: string; label?: string; hint?: string; aspect?: number; onPick?: (file: File) => void; onAdjust?: () => void; onRemove?: () => void }): {
  root: HTMLElement; show(url: string): void; adjustable(ok: boolean, why?: string): void;
};
