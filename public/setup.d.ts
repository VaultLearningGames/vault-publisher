// Types for setup.js (a browser module), so its zip reading can be tested from TypeScript.
export interface ZipEntry {
  name: string; madeBy: number; flags: number; method: number; crc: number;
  compressedSize: number; size: number; attrs: number; offset: number;
}
export interface ZipLimits { zipBytes: number; files: number; totalBytes: number }
export const ZIP_LIMITS: ZipLimits;
export class ZipError extends Error {}
export function readZipDirectory(blob: Blob): Promise<ZipEntry[]>;
export function planZipUpload(entries: ZipEntry[], limits?: ZipLimits): { files: { path: string; size: number; entry: ZipEntry }[]; folder: string; total: number };
export function extractZipEntry(blob: Blob, entry: ZipEntry): Promise<Blob>;
export function workflowSnippet(o: { kind: 'build' | 'committed' | 'unity'; game: string; portal: string; production?: boolean; branch?: string; release?: boolean }): string;
