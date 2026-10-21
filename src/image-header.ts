// An image's type, pixel size and whether it can be transparent, read from the file's first bytes (no image library:
// PNG's IHDR, JPEG's start-of-frame marker, WebP's VP8 / VP8L / VP8X header). Used to check uploads before they're
// stored (src/portal/image-fields.ts). Anything it can't read is null.
export interface ImageHeader {
  type: 'png' | 'jpeg' | 'webp';
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  alpha: boolean;
}

const at = (b: Uint8Array, i: number, bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
const ascii = (b: Uint8Array, i: number, s: string) => at(b, i, [...s].map((c) => c.charCodeAt(0)));
const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

export function readImageHeader(b: Uint8Array): ImageHeader | null {
  const ok = (h: ImageHeader) => (h.width > 0 && h.height > 0 ? h : null);
  // PNG: the signature, then the IHDR chunk (width, height, bit depth, colour type: 4 and 6 have alpha; 3 may have a tRNS).
  if (at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (b.length < 26 || !ascii(b, 12, 'IHDR')) return null;
    const colour = b[25];
    return ok({ type: 'png', contentType: 'image/png', width: be32(b, 16), height: be32(b, 20), alpha: colour === 4 || colour === 6 || colour === 3 });
  }
  // JPEG: walk the markers to the first start-of-frame (SOF0–SOF15, except DHT C4, JPG C8 and DAC CC).
  if (at(b, 0, [0xff, 0xd8, 0xff])) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return ok({ type: 'jpeg', contentType: 'image/jpeg', width: be16(b, i + 7), height: be16(b, i + 5), alpha: false });
      }
      if (m === 0xd9 || m === 0xda) return null;
      i += 2 + be16(b, i + 2);
    }
    return null;
  }
  // WebP: RIFF....WEBP, then the first chunk.
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    const webp = (width: number, height: number, alpha: boolean) => ok({ type: 'webp', contentType: 'image/webp', width, height, alpha });
    if (ascii(b, 12, 'VP8 ') && b.length >= 30 && at(b, 23, [0x9d, 0x01, 0x2a])) return webp(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff, false);
    if (ascii(b, 12, 'VP8L') && b.length >= 25 && b[20] === 0x2f) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return webp((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, ((bits >>> 28) & 1) === 1);
    }
    if (ascii(b, 12, 'VP8X') && b.length >= 30) return webp(le24(b, 24) + 1, le24(b, 27) + 1, (b[20] & 0x10) !== 0);
    return null;
  }
  return null;
}
