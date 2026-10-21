// Types for portal-image-tool.js (a browser module), so its pure functions can be tested from TypeScript.
export interface Aspect { w: number; h: number }
export interface SourceRect { sx: number; sy: number; sw: number; sh: number }
// A field's row of src/portal/image-fields.ts, as the editor hands it over (data-image-spec).
export interface ToolSpec {
  label: string; aspect: Aspect | null; maxWidth: number; minWidth: number;
  quality: number; minQuality: number; maxBytes: number; format: 'opaque' | 'alpha';
}
export interface Encoded { size: number; type: string }
export type Plan<B extends Encoded = Encoded> =
  | { ok: true; blob: B; outW: number; outH: number; mime: string; quality: number }
  | { ok: false; reason: 'cap'; bestSize: number }
  | { ok: false; reason: 'small'; width: number }
  | { ok: false; reason: 'type' };

export const ZOOM_MIN: number;
export const ZOOM_MAX: number;
export const QUALITY_STEP: number;
export const WIDTH_STEP: number;
export const MAX_SOURCE_BYTES: number;
export const ACCEPT: string;
export function coverScale(imgW: number, imgH: number, boxW: number, boxH: number): number;
export function computeCropRect(o: { imgW: number; imgH: number; aspect?: Aspect | null; zoom?: number; panX?: number; panY?: number; rect?: SourceRect | null }): SourceRect;
export function panBy(pan: number, delta: number, size: number, crop: number): number;
export function computeOutputSize(sw: number, sh: number, aspect: Aspect | null, maxWidth: number): { outW: number; outH: number };
export function qualitySteps(spec: Pick<ToolSpec, 'quality' | 'minQuality'>): number[];
export function mimesFor(spec: Pick<ToolSpec, 'format'>): string[];
export function planCompression<B extends Encoded>(encode: (outW: number, outH: number, mime: string, quality: number) => Promise<B>, spec: ToolSpec, srcW: number, srcH: number): Promise<Plan<B>>;
export function formatBytes(n: number): string;
export function typeName(mime: string): string;
export function ratioLabel(aspect: Aspect | null): string;
export function refusal(plan: Plan, spec: ToolSpec): string;
export function uploadBlob(url: string, blob: Blob, fetchFn?: typeof fetch): Promise<{ url: string; field: string; value: string | string[] }>;
export function openImageTool(file: File, spec: ToolSpec, uploadUrl: string): Promise<{ url: string; field: string; value: string | string[] } | null>;
