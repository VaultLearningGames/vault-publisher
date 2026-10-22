// The listing editor's image tool, for every image field (src/portal/image-fields.ts, handed over as each picker's
// data-image-spec). Choosing a file opens a dialog: the crop is locked to the field's shape (free-form fields keep the
// whole image), zoomed with the slider or the mouse wheel and panned by dragging or with the arrow keys. The crop is
// drawn on a canvas at no more than the field's width (never upscaled) and compressed to WebP (JPEG where the browser
// can't encode WebP; PNG for fields that keep transparency), stepping the quality down and then the width, until it
// fits the field's byte cap; the dialog shows the size before and after, and refuses the image if it can't fit. Upload
// POSTs the result to the picker's data-upload-image URL (src/portal/listing-assets.ts, which checks it again and stores
// it on the Vault CDN); the new URL goes into the field and its preview, keeping unsaved edits elsewhere in the form.
//
// An ES module: its pure functions (crop rectangle, output size, compression plan) are tested with node:test; the
// dialog only runs in a browser.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const QUALITY_STEP = 0.07;
export const WIDTH_STEP = 0.85;
// The largest file the tool opens (it's only read in the browser, never uploaded as is).
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// The smallest scale at which an imgW × imgH image covers a boxW × boxH box.
export function coverScale(imgW, imgH, boxW, boxH) {
  return Math.max(boxW / imgW, boxH / imgH);
}

// The source rectangle (integer pixels) the crop takes from an imgW × imgH image. With an aspect {w, h}: at zoom 1 the
// largest rectangle of that shape, at zoom z (clamped to ZOOM_MIN…ZOOM_MAX) 1/z of it across; its width is the height
// times the ratio, rounded, so it's never more than half a pixel off the shape. panX and panY (-1…1, clamped) place it
// from one edge of the image to the other (0: centred), so it never leaves the image. Without an aspect: `rect` (a free
// crop, kept inside the image), else the whole image.
export function computeCropRect({ imgW, imgH, aspect = null, zoom = 1, panX = 0, panY = 0, rect = null }) {
  if (!aspect) {
    if (!rect) return { sx: 0, sy: 0, sw: imgW, sh: imgH };
    const sw = clamp(Math.round(rect.sw), 1, imgW), sh = clamp(Math.round(rect.sh), 1, imgH);
    return { sx: clamp(Math.round(rect.sx), 0, imgW - sw), sy: clamp(Math.round(rect.sy), 0, imgH - sh), sw, sh };
  }
  const a = aspect.w / aspect.h;
  const z = clamp(num(zoom, 1), ZOOM_MIN, ZOOM_MAX);
  const baseH = imgW / imgH >= a ? imgH : imgW / a;
  let sh = Math.max(1, Math.floor(baseH / z));
  let sw = Math.max(1, Math.round(sh * a));
  while (sw > imgW && sh > 1) { sh--; sw = Math.max(1, Math.round(sh * a)); }
  sw = Math.min(sw, imgW);
  const px = clamp(num(panX, 0), -1, 1), py = clamp(num(panY, 0), -1, 1);
  const sx = clamp(Math.round(((imgW - sw) / 2) * (1 + px)), 0, imgW - sw);
  const sy = clamp(Math.round(((imgH - sh) / 2) * (1 + py)), 0, imgH - sh);
  return { sx, sy, sw, sh };
}

// The pan after moving the crop by delta source pixels, in an image `size` across with a crop `crop` across.
export function panBy(pan, delta, size, crop) {
  const slack = (size - crop) / 2;
  return slack > 0 ? clamp(pan + delta / slack, -1, 1) : 0;
}

// The output size for a sw × sh crop: at most maxWidth wide (never wider than the crop: no upscaling); the height
// follows the aspect exactly (rounded), else the crop's own shape.
export function computeOutputSize(sw, sh, aspect, maxWidth) {
  const outW = Math.max(1, Math.floor(Math.min(sw, maxWidth)));
  const outH = aspect ? Math.max(1, Math.round((outW * aspect.h) / aspect.w)) : Math.max(1, Math.round((sh * outW) / sw));
  return { outW, outH };
}

// The qualities tried at each width: the field's quality, stepping down by QUALITY_STEP, ending at its minQuality.
export function qualitySteps(spec) {
  const out = [];
  for (let q = spec.quality; q > spec.minQuality + 1e-9; q -= QUALITY_STEP) out.push(Math.round(q * 100) / 100);
  out.push(spec.minQuality);
  return out;
}

// The types tried, best first: WebP, then the fallback for browsers that can't encode it.
export const mimesFor = (spec) => (spec.format === 'alpha' ? ['image/webp', 'image/png'] : ['image/webp', 'image/jpeg']);

// Compresses a srcW × srcH crop for `spec`: encode(outW, outH, mime, quality) resolves to a Blob (or anything with
// size and type). WebP at each of qualitySteps, then 15% narrower, down to the field's minWidth; if the encoder
// answers with another type (it can't make WebP), the fallback type instead (PNG ignores quality: one try per width).
// Resolves to { ok: true, blob, outW, outH, mime, quality } for the first that fits maxBytes, else { ok: false,
// reason: 'cap', bestSize } ('small': the crop is narrower than minWidth; 'type': the browser makes neither type).
export async function planCompression(encode, spec, srcW, srcH) {
  const start = computeOutputSize(srcW, srcH, spec.aspect, spec.maxWidth);
  if (start.outW < spec.minWidth) return { ok: false, reason: 'small', width: start.outW };
  const mimes = mimesFor(spec);
  let mime = mimes[0], bestSize = Infinity;
  for (let w = start.outW; ;) {
    const { outH: h } = computeOutputSize(w, (srcH * w) / srcW, spec.aspect, w);
    for (const quality of qualitySteps(spec)) {
      let blob = await encode(w, h, mime, quality);
      if (blob.type !== mime && mime === mimes[0]) { mime = mimes[1]; blob = await encode(w, h, mime, quality); }
      if (blob.type !== mime) return { ok: false, reason: 'type' };
      bestSize = Math.min(bestSize, blob.size);
      if (blob.size <= spec.maxBytes) return { ok: true, blob, outW: w, outH: h, mime, quality };
      if (mime === 'image/png') break;
    }
    if (w <= spec.minWidth) return { ok: false, reason: 'cap', bestSize };
    w = Math.max(spec.minWidth, Math.floor(w * WIDTH_STEP));
  }
}

export function formatBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1000 / 1000).toFixed(1)} MB`;
}

const TYPE_NAME = { 'image/webp': 'WebP', 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/avif': 'AVIF' };
export const typeName = (mime) => TYPE_NAME[mime] || 'image';
export const ratioLabel = (aspect) => (aspect ? `${aspect.w}:${aspect.h}` : 'any shape');

// Why planCompression's result can't be uploaded, for the dialog.
export function refusal(plan, spec) {
  if (plan.reason === 'small') return `This image is too small: the crop is ${plan.width} px wide, and the ${spec.label.toLowerCase()} needs at least ${spec.minWidth} px. Choose a larger image or zoom out.`;
  if (plan.reason === 'type') return 'This browser can’t make WebP, JPEG or PNG images. Try another browser.';
  return `Even at the smallest size and quality this image is ${formatBytes(plan.bestSize)}, over the ${formatBytes(spec.maxBytes)} limit. Zoom in, or choose a simpler image.`;
}

// POSTs the result as the request body; resolves to the API's answer ({ url, field, value }) or throws its error.
export async function uploadBlob(url, blob, fetchFn = fetch) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Requested-With': 'vault-portal' },
    body: blob,
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Something went wrong (HTTP ${res.status}).`);
  return body;
}

// ---------------------------------------------------------------- browser only ----------------------------------------

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
}

function canvasEncoder(img, rect, opaque) {
  return (w, h, mime, quality) => new Promise((resolve) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (opaque) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
    c.toBlob((b) => resolve(b || { size: Infinity, type: '' }), mime, quality);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t an image this browser can open.')); };
    img.src = url;
  });
}

// The dialog for one file and field. Resolves to the API's answer after a successful upload, or null if cancelled.
export function openImageTool(file, spec, uploadUrl) {
  return new Promise((resolve) => {
    let img = null, objectUrl = null, natural = { w: 0, h: 0 };
    let zoom = ZOOM_MIN, panX = 0, panY = 0, plan = null, seq = 0, timer = null, busy = false;
    const free = !spec.aspect;

    const stage = el('canvas', { class: 'iet-canvas', tabindex: '0', 'aria-label': free ? 'The image' : 'Crop. Drag or use the arrow keys to move the image; the mouse wheel zooms.' });
    const zoomInput = el('input', { type: 'range', min: String(ZOOM_MIN), max: String(ZOOM_MAX), step: '0.01', value: String(ZOOM_MIN), 'aria-label': 'Zoom',
      oninput: () => { zoom = Number(zoomInput.value); changed(); } });
    const shape = el('p', { class: 'small muted' }, free
      ? `${spec.label}: any shape, transparency kept. The whole image is used.`
      : `${spec.label}: ${ratioLabel(spec.aspect)}. Drag to choose what shows; zoom to crop closer.`);
    const sizes = el('p', { class: 'iet-sizes', 'aria-live': 'polite' });
    const msg = el('p', { class: 'err', role: 'alert' });
    const cancelBtn = el('button', { type: 'button', class: 'btn', onclick: () => { if (!busy) close(null); } }, 'Cancel');
    const okBtn = el('button', { type: 'button', class: 'btn pri', disabled: true, onclick: upload }, 'Upload');
    const dlg = el('dialog', { class: 'iet', 'aria-label': `${spec.label}: crop and upload` },
      el('div', { class: 'dlg' },
        el('h2', null, spec.label),
        shape,
        el('div', { class: 'iet-stage' }, stage),
        free ? null : el('label', { class: 'iet-zoom' }, el('span', { class: 'lab' }, 'Zoom'), zoomInput),
        sizes, msg,
        el('div', { class: 'dlg-foot' }, cancelBtn, okBtn)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!busy) close(null); });
    document.body.append(dlg);
    dlg.showModal();

    function close(value) {
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      dlg.close();
      dlg.remove();
      resolve(value);
    }
    const rect = () => computeCropRect({ imgW: natural.w, imgH: natural.h, aspect: spec.aspect, zoom, panX, panY });

    // The crop as it will look, scaled to the stage.
    let view = 1;
    function draw() {
      if (!img) return;
      const r = rect();
      const maxW = Math.min(640, window.innerWidth - 80), maxH = Math.min(420, window.innerHeight - 300);
      view = Math.min(maxW / r.sw, Math.max(120, maxH) / r.sh);
      stage.width = Math.max(1, Math.round(r.sw * view)); stage.height = Math.max(1, Math.round(r.sh * view));
      const ctx = stage.getContext('2d');
      ctx.clearRect(0, 0, stage.width, stage.height);
      ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, stage.width, stage.height);
    }
    function changed() {
      draw();
      okBtn.disabled = true;
      sizes.textContent = `Original: ${formatBytes(file.size)} (${natural.w} × ${natural.h} ${typeName(file.type)}). Compressing…`;
      clearTimeout(timer);
      timer = setTimeout(compress, 250);
    }
    async function compress() {
      const mine = ++seq, r = rect();
      const p = await planCompression(canvasEncoder(img, r, spec.format === 'opaque'), spec, r.sw, r.sh);
      if (mine !== seq) return;
      plan = p;
      const before = `Original: ${formatBytes(file.size)} (${natural.w} × ${natural.h} ${typeName(file.type)})`;
      if (p.ok) {
        sizes.textContent = `${before} → upload: ${formatBytes(p.blob.size)} (${p.outW} × ${p.outH} ${typeName(p.mime)}${p.mime === 'image/png' ? '' : `, quality ${Math.round(p.quality * 100)}%`}), limit ${formatBytes(spec.maxBytes)}.`;
        msg.textContent = '';
        okBtn.disabled = false;
      } else {
        sizes.textContent = `${before}.`;
        msg.textContent = refusal(p, spec);
      }
    }
    async function upload() {
      if (!plan || !plan.ok || busy) return;
      busy = true; okBtn.disabled = true; cancelBtn.disabled = true;
      msg.textContent = '';
      sizes.textContent = 'Uploading…';
      pending++;
      try {
        close(await uploadBlob(uploadUrl, plan.blob));
      } catch (ex) {
        msg.textContent = ex.message;
        sizes.textContent = '';
        okBtn.disabled = false; cancelBtn.disabled = false;
      } finally {
        busy = false;
        pending--;
      }
    }

    // Dragging moves the image under the crop (so the crop moves the other way).
    let drag = null;
    stage.addEventListener('pointerdown', (e) => { if (free || !img) return; drag = { x: e.clientX, y: e.clientY }; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = rect();
      panX = panBy(panX, -(e.clientX - drag.x) / view, natural.w, r.sw);
      panY = panBy(panY, -(e.clientY - drag.y) / view, natural.h, r.sh);
      drag = { x: e.clientX, y: e.clientY };
      changed();
    });
    stage.addEventListener('pointerup', () => { drag = null; });
    stage.addEventListener('wheel', (e) => {
      if (free || !img) return;
      e.preventDefault();
      zoom = clamp(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), ZOOM_MIN, ZOOM_MAX);
      zoomInput.value = String(zoom);
      changed();
    }, { passive: false });
    stage.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d || free || !img) return;
      e.preventDefault();
      const r = rect(), step = e.shiftKey ? 50 : 10;
      panX = panBy(panX, d[0] * step, natural.w, r.sw);
      panY = panBy(panY, d[1] * step, natural.h, r.sh);
      changed();
    });

    if (file.size > MAX_SOURCE_BYTES) { msg.textContent = `That file is ${formatBytes(file.size)}; choose one under ${formatBytes(MAX_SOURCE_BYTES)}.`; return; }
    loadImage(file).then(({ img: i, url }) => {
      img = i; objectUrl = url;
      natural = { w: i.naturalWidth, h: i.naturalHeight };
      changed();
    }, (ex) => { msg.textContent = ex.message; });
  });
}

// While an upload runs, leaving the page asks first.
let pending = 0;

function wire() {
  window.addEventListener('beforeunload', (e) => { if (pending) e.preventDefault(); });
  document.addEventListener('change', async (e) => {
    const input = e.target;
    if (!input.dataset || !input.dataset.uploadImage || !input.dataset.imageSpec) return;
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const say = (text, status) => { const err = input.parentElement.querySelector('.err'); if (err) { err.classList.toggle('status', !!status); err.textContent = text; } };
    say('');
    const body = await openImageTool(file, JSON.parse(input.dataset.imageSpec), input.dataset.uploadImage);
    if (!body) return;
    const field = document.getElementById(`f-${input.dataset.field}`);
    if (field) {
      if (field.tagName === 'TEXTAREA') {
        const lines = field.value.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.includes(body.url)) lines.push(body.url);
        field.value = lines.join('\n');
      } else field.value = body.url;
    }
    const prev = document.querySelector(`[data-prev-for="${input.dataset.field}"]`);
    if (prev) {
      const a = el('a', { href: body.url, target: '_blank', rel: 'noopener' }, el('img', { class: 'feat-thumb', src: body.url, alt: '' }));
      if (field && field.tagName === 'TEXTAREA') prev.append(a); else prev.replaceChildren(a);
    }
    say('Uploaded and saved to the draft.', true);
  });
}

if (typeof document !== 'undefined') wire();
