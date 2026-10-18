// The blog editor's image editor: a modal opened with an image file (picked, dropped or pasted). It crops (free, or a
// preset ratio such as the blog catalog's 3:2), resizes (at most MAX_WIDTH wide) and compresses to WebP (JPEG where
// the browser can't encode WebP) on a canvas, shows the size before and after, takes the alt text, then uploads the
// result to POST /portal/api/blog/:slug/images (src/portal/blog-images.ts), which answers with the image's CDN URL.
//
// An ES module: its pure functions (crop rectangles, output size, byte labels) are tested with node:test; openImageEditor
// only runs in a browser.

export const MAX_WIDTH = 1600;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // MAX_BLOG_IMAGE_BYTES in src/portal/blog-images.ts
export const MIN_CROP = 16;
export const DEFAULT_QUALITY = 0.82;
export const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';
// Crop presets; ratio is width / height (null: free). "Catalog" is the blog catalog's card image (.blog-img, 3:2).
export const CROP_PRESETS = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'catalog', label: 'Catalog card (3:2)', ratio: 3 / 2 },
  { id: '16:9', label: 'Wide (16:9)', ratio: 16 / 9 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '1:1', label: 'Square (1:1)', ratio: 1 },
];

export const uploadUrl = (slug) => `/portal/api/blog/${encodeURIComponent(slug)}/images`;

// The largest rectangle of `ratio` centered in a w x h image (the whole image when ratio is null). Integer pixels.
export function presetCrop(w, h, ratio) {
  if (!ratio) return { x: 0, y: 0, w, h };
  let cw = w, ch = Math.round(w / ratio);
  if (ch > h) { ch = h; cw = Math.round(h * ratio); }
  cw = Math.min(w, Math.max(1, cw)); ch = Math.min(h, Math.max(1, ch));
  return { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch };
}

// `r` kept inside a w x h image, at least MIN_CROP (or the image, if smaller) on each side, and of `ratio` if given
// (the height follows the width). Integer pixels.
export function clampCrop(r, w, h, ratio) {
  const min = Math.min(MIN_CROP, w, h);
  let cw = Math.round(Math.max(min, Math.min(w, r.w)));
  let ch = Math.round(Math.max(min, Math.min(h, r.h)));
  if (ratio) {
    ch = Math.round(cw / ratio);
    if (ch > h) { ch = h; cw = Math.round(h * ratio); }
    if (cw > w) { cw = w; ch = Math.round(w / ratio); }
    cw = Math.max(1, cw); ch = Math.max(1, ch);
  }
  const x = Math.round(Math.max(0, Math.min(w - cw, r.x)));
  const y = Math.round(Math.max(0, Math.min(h - ch, r.y)));
  return { x, y, w: cw, h: ch };
}

// The output size for a crop: as wide as asked (never wider than the crop or maxWidth), the height in proportion.
export function outputSize(cropW, cropH, width = MAX_WIDTH, maxWidth = MAX_WIDTH) {
  const want = Math.floor(Number(width) || cropW);
  const ow = Math.max(1, Math.min(cropW, maxWidth, want));
  return { width: ow, height: Math.max(1, Math.round(cropH * ow / cropW)) };
}

// 1234 -> "1.2 KB", 2500000 -> "2.4 MB".
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// "Saves 72%" / "4% larger" for the before and after sizes.
export function sizeChange(before, after) {
  if (!before || !Number.isFinite(after)) return '';
  const pct = Math.round((1 - after / before) * 100);
  return pct >= 0 ? `saves ${pct}%` : `${-pct}% larger`;
}

// Whether a file looks like an image the editor can take (the server checks the bytes again).
export const isImageFile = (f) => !!f && /^image\/(jpeg|png|webp|gif)$/i.test(f.type || '');

// The first image file in a DataTransfer (drop) or ClipboardData (paste), or null.
export function imageFromTransfer(dt) {
  if (!dt) return null;
  for (const f of Array.from(dt.files || [])) if (isImageFile(f)) return f;
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file' && /^image\//i.test(it.type)) { const f = it.getAsFile(); if (isImageFile(f)) return f; }
  }
  return null;
}

// Every image file in a DataTransfer or ClipboardData, in order (a drop of several files adds them all).
export function imageFilesFromTransfer(dt) {
  if (!dt) return [];
  const files = Array.from(dt.files || []).filter(isImageFile);
  if (files.length) return files;
  const out = [];
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file' && /^image\//i.test(it.type)) { const f = it.getAsFile(); if (isImageFile(f)) out.push(f); }
  }
  return out;
}

// Uploads a blob as multipart field "file". Resolves to the server's JSON ({ key, url, ... }); rejects with its error.
export async function uploadImage(slug, blob, name = 'image', fetchFn = fetch) {
  const fd = new FormData();
  fd.append('file', blob, name);
  const res = await fetchFn(uploadUrl(slug), { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-Requested-With': 'vault-portal' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The upload failed (HTTP ${res.status}).`);
  return data;
}

// ---------- the modal (browser only) ----------
const el = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
  return e;
};

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// The cropped, resized image: WebP, or JPEG when the browser's canvas can't encode WebP (it hands back PNG instead).
async function encode(img, crop, size, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, size.width, size.height);
  const webp = await toBlob(canvas, 'image/webp', quality);
  if (webp && webp.type === 'image/webp') return webp;
  // JPEG has no transparency: paint white under the image first.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size.width, size.height);
  return toBlob(canvas, 'image/jpeg', quality);
}

// Opens the editor for `file`. Options: slug (the saved post's slug, where it uploads), alt (initial alt text),
// withAlt (show the alt text field; the featured image uses the post title), title. Resolves to { url, alt, bytes }
// once uploaded, or null when cancelled.
export function openImageEditor(file, opts = {}) {
  return new Promise((resolve) => {
    let img = null, objectUrl = null, natural = { w: 0, h: 0 }, crop = { x: 0, y: 0, w: 0, h: 0 }, ratio = null;
    let result = null, encodeSeq = 0, encodeTimer = null, busy = false;
    const isGif = file.type === 'image/gif';

    const canvas = el('canvas', { class: 'bie-canvas', tabindex: '0', 'aria-label': 'Crop area. Arrow keys move the crop, Shift+arrow keys resize it.' });
    const presetSel = el('select', { 'aria-label': 'Crop', onchange: () => { ratio = CROP_PRESETS.find((p) => p.id === presetSel.value)?.ratio ?? null; crop = presetCrop(natural.w, natural.h, ratio); changed(); } },
      ...CROP_PRESETS.map((p) => el('option', { value: p.id }, p.label)));
    const widthInput = el('input', { type: 'number', min: '16', max: String(MAX_WIDTH), step: '1', value: String(MAX_WIDTH), 'aria-label': 'Width in pixels', oninput: () => changed() });
    const qualityInput = el('input', { type: 'range', min: '0.4', max: '0.95', step: '0.01', value: String(DEFAULT_QUALITY), 'aria-label': 'Quality', oninput: () => changed() });
    const original = el('input', { type: 'checkbox', checked: isGif, onchange: () => changed() });
    const altInput = el('input', { type: 'text', maxlength: '500', value: opts.alt || '', placeholder: 'What the image shows' });
    const dims = el('span', { class: 'muted' });
    const sizes = el('p', { class: 'bie-sizes', 'aria-live': 'polite' });
    const msg = el('p', { class: 'err', role: 'alert' });
    const cancelBtn = el('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'Cancel');
    const okBtn = el('button', { type: 'button', class: 'btn pri', onclick: upload }, 'Upload and use');
    const lab = (text, input) => el('label', { class: 'field' }, el('span', { class: 'lab' }, text), input);

    const dlg = el('dialog', { class: 'bie', 'aria-label': opts.title || 'Edit image' },
      el('div', { class: 'bie-bar' }, el('strong', null, opts.title || 'Edit image'), dims),
      el('div', { class: 'bie-body' },
        el('div', { class: 'bie-stage' }, canvas),
        el('div', { class: 'bie-side' },
          lab('Crop', presetSel),
          lab(`Width (max ${MAX_WIDTH} px)`, widthInput),
          lab('Quality', qualityInput),
          el('label', { class: 'bie-check' }, original, ' Upload the original file unchanged', isGif ? el('span', { class: 'muted' }, ' (keeps GIF animation)') : null),
          opts.withAlt === false ? null : lab('Alt text', altInput),
          sizes, msg)),
      el('div', { class: 'bie-actions' }, cancelBtn, okBtn));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!busy) close(null); });
    document.body.append(dlg);
    dlg.showModal();

    function close(value) {
      clearTimeout(encodeTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      dlg.close();
      dlg.remove();
      resolve(value);
    }

    // ----- the crop area: the image scaled to fit, the crop as a bright rectangle with a resize handle -----
    let scale = 1;
    const HANDLE = 14;
    function draw() {
      if (!img) return;
      const maxW = Math.min(720, window.innerWidth - 380), maxH = Math.min(520, window.innerHeight - 220);
      scale = Math.min(1, Math.max(120, maxW) / natural.w, Math.max(120, maxH) / natural.h);
      canvas.width = Math.round(natural.w * scale); canvas.height = Math.round(natural.h * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const s = { x: crop.x * scale, y: crop.y * scale, w: crop.w * scale, h: crop.h * scale };
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(s.x, s.y, s.w, s.h);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
      ctx.fillStyle = '#fff';
      ctx.fillRect(s.x + s.w - HANDLE, s.y + s.h - HANDLE, HANDLE, HANDLE);
    }
    let drag = null;
    const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; };
    canvas.addEventListener('pointerdown', (e) => {
      if (!img || original.checked) return;
      const p = at(e);
      const inHandle = p.x >= crop.x + crop.w - HANDLE / scale && p.x <= crop.x + crop.w && p.y >= crop.y + crop.h - HANDLE / scale && p.y <= crop.y + crop.h;
      const inside = p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h;
      drag = inHandle ? { mode: 'resize', p, start: { ...crop } } : inside ? { mode: 'move', p, start: { ...crop } } : { mode: 'new', p, start: { x: p.x, y: p.y, w: 0, h: 0 } };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = at(e), dx = p.x - drag.p.x, dy = p.y - drag.p.y, s = drag.start;
      if (drag.mode === 'move') crop = clampCrop({ ...s, x: s.x + dx, y: s.y + dy }, natural.w, natural.h, ratio);
      else if (drag.mode === 'resize') crop = clampCrop({ ...s, w: s.w + dx, h: s.h + dy }, natural.w, natural.h, ratio);
      else crop = clampCrop({ x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), w: Math.abs(dx), h: Math.abs(dy) }, natural.w, natural.h, ratio);
      draw();
    });
    const endDrag = () => { if (drag) { drag = null; changed(); } };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d || !img || original.checked) return;
      e.preventDefault();
      const step = Math.max(1, Math.round(natural.w / 100));
      crop = e.shiftKey
        ? clampCrop({ ...crop, w: crop.w + d[0] * step, h: crop.h + d[1] * step }, natural.w, natural.h, ratio)
        : clampCrop({ ...crop, x: crop.x + d[0] * step, y: crop.y + d[1] * step }, natural.w, natural.h, ratio);
      changed();
    });

    // ----- re-encode (debounced) after each change, to show the size it will upload -----
    function changed() {
      draw();
      const orig = original.checked;
      presetSel.disabled = widthInput.disabled = qualityInput.disabled = orig;
      const size = outputSize(crop.w, crop.h, widthInput.value);
      dims.textContent = img ? (orig ? `${natural.w} × ${natural.h} px` : `crop ${crop.w} × ${crop.h} → ${size.width} × ${size.height} px`) : '';
      result = null;
      okBtn.disabled = true;
      clearTimeout(encodeTimer);
      const seq = ++encodeSeq;
      encodeTimer = setTimeout(async () => {
        if (!img) return;
        const blob = orig ? file : await encode(img, crop, size, Number(qualityInput.value));
        if (seq !== encodeSeq) return;
        if (!blob) { msg.textContent = 'This browser could not encode the image.'; return; }
        result = blob;
        const type = blob.type === 'image/webp' ? 'WebP' : blob.type === 'image/jpeg' ? 'JPEG' : blob.type.replace('image/', '').toUpperCase();
        sizes.textContent = `Before: ${formatBytes(file.size)} · After: ${formatBytes(blob.size)} ${type} (${sizeChange(file.size, blob.size)})`;
        const tooBig = blob.size > MAX_UPLOAD_BYTES;
        msg.textContent = tooBig ? `That is more than ${formatBytes(MAX_UPLOAD_BYTES)}: make it smaller or lower the quality.` : '';
        okBtn.disabled = tooBig || busy;
      }, 150);
    }

    async function upload() {
      if (!result || busy) return;
      if (!opts.slug) { msg.textContent = 'Save the post first: images are stored under its slug.'; return; }
      busy = true; okBtn.disabled = cancelBtn.disabled = true;
      okBtn.innerHTML = '<span class="spin" aria-hidden="true"></span> Uploading…';
      msg.textContent = '';
      try {
        const ext = result.type === 'image/webp' ? 'webp' : result.type === 'image/jpeg' ? 'jpg' : (file.name.split('.').pop() || 'img');
        const data = await uploadImage(opts.slug, result, `image.${ext}`);
        close({ url: data.url, alt: altInput.value.trim(), bytes: data.bytes });
      } catch (e) {
        msg.textContent = e instanceof TypeError ? 'Could not reach the portal. Check your connection and try again.' : e.message;
        busy = false; okBtn.disabled = cancelBtn.disabled = false; okBtn.textContent = 'Upload and use';
      }
    }

    loadImage(file).then(({ img: i, url }) => {
      img = i; objectUrl = url;
      natural = { w: i.naturalWidth, h: i.naturalHeight };
      crop = presetCrop(natural.w, natural.h, null);
      widthInput.value = String(Math.min(MAX_WIDTH, natural.w));
      changed();
      canvas.focus();
    }, (e) => { msg.textContent = e.message; });
  });
}

// Makes `target` take an image file by drop or paste, and returns an "Upload image…" button with a hidden file picker.
// Each calls onPick(file); the caller opens the editor with it.
export function imageDropTarget(target, onPick) {
  const picker = el('input', { type: 'file', accept: ACCEPT, hidden: true, onchange: () => { const f = picker.files && picker.files[0]; picker.value = ''; if (f) onPick(f); } });
  const btn = el('button', { type: 'button', class: 'btn sm', onclick: () => picker.click() }, 'Upload image…');
  target.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    target.classList.add('bie-drop');
  });
  target.addEventListener('dragleave', () => target.classList.remove('bie-drop'));
  target.addEventListener('drop', (e) => {
    target.classList.remove('bie-drop');
    const f = imageFromTransfer(e.dataTransfer);
    if (!f) return;
    e.preventDefault(); e.stopPropagation();
    onPick(f);
  });
  target.addEventListener('paste', (e) => {
    const f = imageFromTransfer(e.clipboardData);
    if (!f) return;
    e.preventDefault();
    onPick(f);
  });
  return el('span', { class: 'bie-up' }, btn, picker);
}

// Makes `target` a drop zone for several image files (drag and drop, or paste) and returns an "Upload images…" button
// with a hidden multi-file picker. Each calls onPick(files) with the image files, in order. While files are dragged
// over it, `target` has the class bie-drop.
export function imagesDropTarget(target, onPick, label = 'Upload images…') {
  const picker = el('input', { type: 'file', accept: ACCEPT, multiple: true, hidden: true,
    onchange: () => { const fs = Array.from(picker.files || []).filter(isImageFile); picker.value = ''; if (fs.length) onPick(fs); } });
  const btn = el('button', { type: 'button', class: 'btn sm', onclick: () => picker.click() }, label);
  let depth = 0;
  const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  target.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; target.classList.add('bie-drop'); });
  target.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    target.classList.add('bie-drop');
  });
  target.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) target.classList.remove('bie-drop'); });
  target.addEventListener('drop', (e) => {
    depth = 0;
    target.classList.remove('bie-drop');
    const fs = imageFilesFromTransfer(e.dataTransfer);
    if (!fs.length) return;
    e.preventDefault(); e.stopPropagation();
    onPick(fs);
  });
  target.addEventListener('paste', (e) => {
    const fs = imageFilesFromTransfer(e.clipboardData);
    if (!fs.length) return;
    e.preventDefault();
    onPick(fs);
  });
  return el('span', { class: 'bie-up' }, btn, picker);
}
