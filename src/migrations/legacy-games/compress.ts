// The server-side equivalent of card A's browser image tool, for the images the import re-hosts: the same field rows
// (portal/image-fields.ts) and the same steps (public/portal-image-tool.js: the crop rectangle computeCropRect at
// zoom 1, centred; then planCompression: WebP at each quality step, then 15% narrower down to the field's minimum
// width, PNG/JPEG only where WebP can't be made), with sharp doing what the canvas does in the browser. The portal
// checks the result exactly like an upload (validateFieldImage) before it stores it.
//
// sharp is a dev dependency (the portal image has no image library): only scripts/import-legacy-games.ts loads
// this, never the server.
import { computeCropRect, planCompression } from '../../../public/portal-image-tool.js';
import type { ImageFieldSpec } from '../../portal/image-fields.ts';
import { cropLoss } from './images.ts';

export interface Compressed {
  bytes: Uint8Array;
  mime: string;
  quality: number;
  in: { w: number; h: number };
  out: { w: number; h: number; bytes: number; quality: number; mime: string };
  // The crop cut part of the picture away (a different shape from the field's), as a share of its area.
  cropped: number;
  // The source was narrower than the field's minimum width and was enlarged to it (it may look soft).
  upscaled: boolean;
}

type Sharp = typeof import('sharp')['default'];
let sharpLib: Sharp | null = null;
async function sharp(): Promise<Sharp> {
  if (!sharpLib) sharpLib = (await import('sharp')).default;
  return sharpLib;
}

const MIME_FORMAT: Record<string, 'webp' | 'jpeg' | 'png'> = { 'image/webp': 'webp', 'image/jpeg': 'jpeg', 'image/png': 'png' };

export async function compressForField(source: Uint8Array, spec: ImageFieldSpec): Promise<Compressed> {
  const s = await sharp();
  // As shown: EXIF orientation applied (a photo stored sideways), first frame only (a GIF).
  const upright = await s(source, { animated: false }).rotate().toBuffer();
  const meta = await s(upright).metadata();
  const imgW = meta.width ?? 0, imgH = meta.height ?? 0;
  if (!imgW || !imgH) throw new Error('not an image the encoder can read');
  const crop = computeCropRect({ imgW, imgH, aspect: spec.aspect });
  // Too narrow for the field: enlarged to its minimum width (the browser tool would refuse it; every existing image
  // must move, so it's enlarged and reported for review instead).
  const upscaled = crop.sw < spec.minWidth;
  const srcW = upscaled ? spec.minWidth : crop.sw;
  const srcH = upscaled ? Math.round((crop.sh * spec.minWidth) / crop.sw) : crop.sh;
  const region = await s(upright).extract({ left: crop.sx, top: crop.sy, width: crop.sw, height: crop.sh }).toBuffer();

  const encode = async (w: number, h: number, mime: string, quality: number) => {
    const fmt = MIME_FORMAT[mime];
    let img = s(region).resize({ width: w, height: h, fit: 'fill' });
    if (spec.format === 'opaque') img = img.flatten({ background: '#ffffff' });
    const q = Math.round(quality * 100);
    const buf = fmt === 'webp' ? await img.webp({ quality: q, alphaQuality: q, effort: 5 }).toBuffer()
      : fmt === 'jpeg' ? await img.jpeg({ quality: q, mozjpeg: true }).toBuffer()
      : await img.png({ compressionLevel: 9, palette: false }).toBuffer();
    return { size: buf.length, type: mime, buf };
  };
  const plan = await planCompression(encode, spec, srcW, srcH);
  if (!plan.ok) {
    throw new Error(plan.reason === 'cap' ? `even at the smallest size and quality it is ${plan.bestSize} bytes, over the ${spec.maxBytes}-byte cap`
      : plan.reason === 'small' ? `the crop is ${plan.width} px wide, under the ${spec.minWidth} px minimum` : 'the encoder made neither type');
  }
  const bytes = new Uint8Array(plan.blob.buf);
  return {
    bytes, mime: plan.mime, quality: plan.quality,
    in: { w: imgW, h: imgH },
    out: { w: plan.outW, h: plan.outH, bytes: bytes.length, quality: plan.quality, mime: plan.mime },
    cropped: cropLoss(imgW, imgH, spec.aspect),
    upscaled,
  };
}
