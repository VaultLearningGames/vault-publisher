// The blog's image block: a collection of images shown in one layout. Shared by the server (src/blog/blocks.ts
// validates and saves with it, src/site-content/markdown-blocks.ts writes and reads it) and the editor
// (portal-blog-editor.js loads and saves with it). A pure ES module with no browser or Node APIs.
//
//   { type: 'image', layout: 'stacked' | 'grid' | 'carousel' | 'slideshow', align?, images: ImageItem[],
//     src?, alt?, caption? }
//   ImageItem: { id, url, alt, title, description, showTitle, showDescription, link, linkTarget: '_self' | '_blank' }
//
// src, alt and caption mirror the first image (its url, alt and visible title), so code that only knows the older
// single-image block ({ type: 'image', src, alt, caption?, align? }) still shows the first image.

export const LAYOUTS = ['stacked', 'grid', 'carousel', 'slideshow'];
export const DEFAULT_LAYOUT = 'stacked';
export const LAYOUT_LABELS = { slideshow: 'Slideshow', carousel: 'Carousel', grid: 'Grid', stacked: 'Stacked' };
export const LINK_TARGETS = ['_self', '_blank'];
export const ALIGNS = ['left', 'center', 'right', 'wide', 'full'];
export const MAX_IMAGES = 50;
export const MAX_TITLE = 300;
export const MAX_DESCRIPTION = 2000;
export const MAX_ALT = 500;

const str = (v) => (typeof v === 'string' ? v : '');
// A title is one line; a description keeps single line breaks but no blank lines (a blank line ends a Markdown block).
export const cleanTitle = (s) => str(s).replace(/\s+/g, ' ').trim();
export const cleanDescription = (s) => str(s).replace(/\r\n?/g, '\n').replace(/[ \t]*\n[ \t\n]*/g, '\n').trim();

let seq = 0;
// A fresh image id (the editor's reorder key). Random where the platform has crypto, else a counter.
export function newImageId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `img-${c.randomUUID().slice(0, 8)}`;
  return `img-${Date.now().toString(36)}${(++seq).toString(36)}`;
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// One image with every field set to its default when missing or of the wrong type; unknown keys are dropped. `i` is
// its position, which names it (img-<i+1>) when it has no usable id, so normalizing twice gives the same result.
export function normalizeImageItem(v, i = 0) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return {
    id: typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : `img-${i + 1}`,
    url: str(o.url).trim(),
    alt: str(o.alt).trim(),
    title: cleanTitle(o.title),
    description: cleanDescription(o.description),
    showTitle: typeof o.showTitle === 'boolean' ? o.showTitle : true,
    showDescription: typeof o.showDescription === 'boolean' ? o.showDescription : true,
    link: str(o.link).trim(),
    linkTarget: o.linkTarget === '_blank' ? '_blank' : '_self',
  };
}

// The caption a single-image renderer shows: the visible title (and description), or '' for none.
export function visibleCaption(img) {
  const parts = [];
  if (img.showTitle && img.title) parts.push(img.title);
  if (img.showDescription && img.description) parts.push(img.description);
  return parts.join(' — ');
}

// Any image block, the older single-image shape included, in the collection shape with its mirror fields. Idempotent.
// The older { src, alt, caption, align } becomes one stacked image whose title is the caption (shown, as it was);
// one with no src becomes no images.
export function normalizeImageBlock(b) {
  const o = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  let images;
  if (Array.isArray(o.images)) images = o.images.map(normalizeImageItem);
  else {
    const url = str(o.src || o.url).trim();
    images = url ? [normalizeImageItem({ id: 'img-1', url, alt: o.alt, title: o.caption })] : [];
  }
  // Ids are reorder keys: a repeated one is renamed so each stays unique.
  const seen = new Set();
  images.forEach((img, i) => {
    if (seen.has(img.id)) { let n = i + 1; while (seen.has(`img-${n}`)) n++; img.id = `img-${n}`; }
    seen.add(img.id);
  });
  const out = { type: 'image', layout: LAYOUTS.includes(o.layout) ? o.layout : DEFAULT_LAYOUT };
  if (ALIGNS.includes(o.align)) out.align = o.align;
  out.images = images;
  const first = images[0];
  if (first) {
    out.src = first.url;
    out.alt = first.alt;
    const caption = visibleCaption(first);
    if (caption) out.caption = caption;
  }
  return out;
}

// Whether a link on an image is acceptable: absolute http(s), mailto:, or a root-relative path (as paragraph links).
export function isImageLink(href) {
  if (typeof href !== 'string' || !href || href.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(href)) return false;
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\');
  let u;
  try { u = new URL(href); } catch { return false; }
  if (u.protocol === 'mailto:') return href.length > 'mailto:'.length;
  return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
}
