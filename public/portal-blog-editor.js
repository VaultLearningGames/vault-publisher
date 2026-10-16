// The blog post editor (/portal/blog/edit/:id): the title, and the post's body as a list of blocks (heading,
// paragraph, image, divider) that can be added, moved (drag, or the Move up/down buttons) and deleted. Save PUTs the
// title and the blocks in the format of src/blog/blocks.ts to /portal/blog/:id with the updated_at the page was
// loaded with; if someone else saved in between, the server answers 409 and that is shown, nothing is overwritten.
//
// This file is an ES module so its pure functions (serialize, deserialize, reorder) can be tested with node:test;
// the page itself is set up by the IIFE at the bottom, which only runs in a browser.

export const BLOCK_TYPES = ['heading', 'paragraph', 'image', 'divider'];
export const ALIGNS = ['left', 'center', 'right', 'wide', 'full'];

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Span paragraphs (B1's { children: [{ text, marks, href }] }) as the HTML the editor works with.
export function spansToHtml(children) {
  return (children || []).map((sp) => {
    let h = escapeHtml(sp.text || '').replace(/\n/g, '<br>');
    const marks = sp.marks || [];
    if (marks.includes('code')) h = `<code>${h}</code>`;
    if (marks.includes('italic')) h = `<em>${h}</em>`;
    if (marks.includes('bold')) h = `<strong>${h}</strong>`;
    if (sp.href) h = `<a href="${escapeHtml(sp.href)}">${h}</a>`;
    return h;
  }).join('');
}

// Whether paragraph HTML has any visible text (an empty contenteditable leaves "<br>" or "&nbsp;" behind).
export function htmlHasText(html) {
  return String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;| /g, '').trim() !== '';
}

let nextKey = 1;
// A new, empty block of a type, as the editor holds it.
export function newBlock(type) {
  const key = `b${nextKey++}`;
  switch (type) {
    case 'heading': return { key, type, level: 2, text: '' };
    case 'paragraph': return { key, type, html: '' };
    case 'image': return { key, type, src: '', alt: '', caption: '', align: '' };
    case 'divider': return { key, type };
    default: throw new Error(`Unknown block type "${type}"`);
  }
}

// Saved blocks (src/blog/blocks.ts) -> the editor's blocks: each gets a key, paragraphs become HTML, optional fields
// become ''. Unknown block types are dropped (the server never stores them).
export function deserializeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || !BLOCK_TYPES.includes(b.type)) continue;
    const e = newBlock(b.type);
    if (b.type === 'heading') { e.level = [2, 3, 4].includes(b.level) ? b.level : 2; e.text = String(b.text || ''); }
    else if (b.type === 'paragraph') e.html = typeof b.html === 'string' ? b.html : spansToHtml(b.children);
    else if (b.type === 'image') { e.src = String(b.src || ''); e.alt = String(b.alt || ''); e.caption = String(b.caption || ''); e.align = ALIGNS.includes(b.align) ? b.align : ''; }
    out.push(e);
  }
  return out;
}

// The editor's blocks -> the block JSON the server stores. Blocks left completely empty (a heading or paragraph with
// no text, an image with no fields filled in) are not content and are left out; anything else is sent as it is, so
// the server's validation can say what's wrong with it.
export function serializeBlocks(items) {
  const out = [];
  for (const e of items || []) {
    if (e.type === 'heading') {
      const text = String(e.text || '').replace(/\s+/g, ' ').trim();
      if (text) out.push({ type: 'heading', level: [2, 3, 4].includes(Number(e.level)) ? Number(e.level) : 2, text });
    } else if (e.type === 'paragraph') {
      const html = String(e.html || '').trim();
      if (htmlHasText(html)) out.push({ type: 'paragraph', html });
    } else if (e.type === 'image') {
      const src = String(e.src || '').trim(), alt = String(e.alt || '').trim(), caption = String(e.caption || '').trim();
      if (!src && !alt && !caption) continue;
      const b = { type: 'image', src, alt };
      if (caption) b.caption = caption;
      if (ALIGNS.includes(e.align)) b.align = e.align;
      out.push(b);
    } else if (e.type === 'divider') out.push({ type: 'divider' });
  }
  return out;
}

// A copy of the list with the item at `from` moved to index `to` (clamped). Out-of-range `from` returns a plain copy.
export function moveBlock(items, from, to) {
  const list = items.slice();
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return list;
  const dest = Math.max(0, Math.min(list.length - 1, Number.isInteger(to) ? to : from));
  const [item] = list.splice(from, 1);
  list.splice(dest, 0, item);
  return list;
}

// A copy with `item` inserted at `index` (clamped), and a copy without the item with key `key`.
export function insertBlock(items, index, item) {
  const list = items.slice();
  list.splice(Math.max(0, Math.min(list.length, index)), 0, item);
  return list;
}
export const removeBlock = (items, key) => items.filter((e) => e.key !== key);

// The body of the save request: only the title and blocks change here; other fields keep their value on the server.
export function saveBody(title, items, updatedAt) {
  return { title: String(title || '').trim(), blocks: serializeBlocks(items), updated_at: updatedAt };
}

// Links in paragraphs, as the server accepts them: http(s), mailto:, or a path starting with one "/".
export function isLinkHref(href) {
  const h = String(href || '').trim();
  if (!h || /\s/.test(h)) return false;
  if (h.startsWith('/')) return !h.startsWith('//') && !h.startsWith('/\\');
  return /^(https?:\/\/[^/?#]+|mailto:.+)/i.test(h);
}

// ---------- the page ----------
(function () {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('blog-editor');
  const dataEl = document.getElementById('blog-post-data');
  if (!root || !dataEl) return;
  const post = JSON.parse(dataEl.textContent || '{}');
  const id = root.dataset.id;
  let updatedAt = post.updated_at;
  let items = deserializeBlocks(post.blocks);
  const els = new Map(); // block key -> its element
  let saving = false;

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  };

  // ----- layout -----
  const titleInput = h('input', { type: 'text', id: 'be-title', class: 'be-title', maxlength: '200', value: post.title || '', 'aria-label': 'Title', placeholder: 'Post title', oninput: changed });
  const list = h('div', { class: 'be-blocks', role: 'list', 'aria-label': 'Post body' });
  const status = h('p', { class: 'err status be-status', role: 'status', 'aria-live': 'polite' });
  const err = h('div', { class: 'be-err', role: 'alert' });
  const saveBtn = h('button', { type: 'button', class: 'btn pri', onclick: save }, 'Save');
  const announce = h('p', { class: 'be-sr', 'aria-live': 'polite' });
  root.append(
    h('div', { class: 'card be-head' }, h('div', { class: 'field' }, h('label', { for: 'be-title' }, 'Title'), titleInput)),
    h('div', { class: 'card be-body' }, inserter(0), list),
    h('div', { class: 'be-bar' }, saveBtn, status),
    err, announce,
  );

  // ----- state -----
  let savedJson = JSON.stringify(saveBody(titleInput.value, items, null));
  const dirty = () => JSON.stringify(saveBody(titleInput.value, items, null)) !== savedJson;
  function changed() {
    if (!saving) status.textContent = dirty() ? 'Unsaved changes' : '';
  }
  window.addEventListener('beforeunload', (e) => { if (dirty() || saving) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });

  // ----- the '+' inserter: a button that opens a row of block types -----
  function inserter(at) {
    const menu = h('div', { class: 'be-ins-menu', hidden: true, role: 'group', 'aria-label': 'Add a block' },
      ...[['heading', 'Heading'], ['paragraph', 'Paragraph'], ['image', 'Image'], ['divider', 'Divider']].map(([type, label]) =>
        h('button', { type: 'button', class: 'btn sm', onclick: () => { close(); add(type, indexAfter()); } }, label)));
    const btn = h('button', { type: 'button', class: 'be-ins-btn', 'aria-expanded': 'false', title: 'Add a block here', 'aria-label': 'Add a block here', onclick: () => (menu.hidden ? open() : close()) }, '+');
    const wrap = h('div', { class: 'be-ins', onkeydown: (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } } }, btn, menu);
    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); menu.querySelector('button').focus(); }
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    // The inserter at the top adds at 0; one inside a block adds right after that block, wherever it is now.
    const indexAfter = () => { const blk = wrap.closest('.be-block'); return blk ? items.findIndex((e) => e.key === blk.dataset.key) + 1 : at; };
    return wrap;
  }

  function add(type, index) {
    const item = newBlock(type);
    items = insertBlock(items, index, item);
    els.set(item.key, render(item));
    sync();
    changed();
    const el = els.get(item.key);
    (el.querySelector('[contenteditable], input, select') || el.querySelector('.be-del')).focus();
  }

  function remove(key) {
    const i = items.findIndex((e) => e.key === key);
    if (i < 0) return;
    items = removeBlock(items, key);
    els.get(key).remove();
    els.delete(key);
    sync();
    changed();
    say('Block deleted.');
    const next = items[Math.min(i, items.length - 1)];
    if (next) els.get(next.key).querySelector('.be-del').focus(); else root.querySelector('.be-ins-btn').focus();
  }

  function move(key, to, focusSel) {
    const from = items.findIndex((e) => e.key === key);
    if (from < 0 || to < 0 || to >= items.length || to === from) return;
    items = moveBlock(items, from, to);
    sync();
    changed();
    say(`Moved to position ${to + 1} of ${items.length}.`);
    if (focusSel) { const b = els.get(key).querySelector(focusSel); if (b && !b.disabled) b.focus(); else els.get(key).querySelector('.be-handle').focus(); }
  }

  // Puts the block elements in the order of `items` (moving nodes keeps what's typed and the caret) and updates the
  // Move up/down buttons.
  function sync() {
    items.forEach((e, i) => {
      const el = els.get(e.key);
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
      el.querySelector('.be-up').disabled = i === 0;
      el.querySelector('.be-down').disabled = i === items.length - 1;
      el.setAttribute('aria-label', `${LABELS[e.type]}, block ${i + 1} of ${items.length}`);
    });
  }
  const say = (msg) => { announce.textContent = ''; setTimeout(() => { announce.textContent = msg; }, 30); };
  const LABELS = { heading: 'Heading', paragraph: 'Paragraph', image: 'Image', divider: 'Divider' };

  // ----- drag and drop (the handle drags its block) -----
  let dragKey = null;
  list.addEventListener('dragover', (e) => {
    if (!dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.be-block');
    list.querySelectorAll('.be-drop-before, .be-drop-after').forEach((x) => x.classList.remove('be-drop-before', 'be-drop-after'));
    if (over && over.dataset.key !== dragKey) {
      const r = over.getBoundingClientRect();
      over.classList.add(e.clientY < r.top + r.height / 2 ? 'be-drop-before' : 'be-drop-after');
    }
  });
  list.addEventListener('drop', (e) => {
    if (!dragKey) return;
    e.preventDefault();
    const over = e.target.closest('.be-block');
    if (over && over.dataset.key !== dragKey) {
      const from = items.findIndex((x) => x.key === dragKey);
      let to = items.findIndex((x) => x.key === over.dataset.key);
      if (over.classList.contains('be-drop-after')) to++;
      if (from < to) to--;
      move(dragKey, to);
    }
    endDrag();
  });
  function endDrag() {
    if (dragKey && els.get(dragKey)) els.get(dragKey).classList.remove('be-dragging');
    dragKey = null;
    list.querySelectorAll('.be-drop-before, .be-drop-after').forEach((x) => x.classList.remove('be-drop-before', 'be-drop-after'));
  }

  // ----- one block -----
  function render(item) {
    const key = item.key;
    const idx = () => items.findIndex((e) => e.key === key);
    const handle = h('span', { class: 'be-handle', draggable: 'true', title: 'Drag to move', 'aria-hidden': 'true',
      ondragstart: (e) => {
        dragKey = key;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', LABELS[item.type]);
        e.dataTransfer.setDragImage(el, 20, 20);
        el.classList.add('be-dragging');
      },
      ondragend: endDrag }, '⠿');
    const tools = h('div', { class: 'be-tools' },
      h('span', { class: 'be-type' }, LABELS[item.type]),
      h('button', { type: 'button', class: 'btn sm be-up', 'aria-label': 'Move up', title: 'Move up', onclick: () => move(key, idx() - 1, '.be-up') }, '↑'),
      h('button', { type: 'button', class: 'btn sm be-down', 'aria-label': 'Move down', title: 'Move down', onclick: () => move(key, idx() + 1, '.be-down') }, '↓'),
      h('button', { type: 'button', class: 'btn sm be-del', 'aria-label': 'Delete block', title: 'Delete block', onclick: () => remove(key) }, '✕'));
    const el = h('div', { class: `be-block be-${item.type}`, role: 'listitem', 'data-key': key },
      handle, h('div', { class: 'be-main' }, tools, editorFor(item)), inserter(0));
    return el;
  }

  function editorFor(item) {
    const set = (k) => (e) => { item[k] = e.target.value; changed(); };
    if (item.type === 'heading') {
      return h('div', { class: 'be-row' },
        h('select', { 'aria-label': 'Heading level', onchange: (e) => { item.level = Number(e.target.value); changed(); } },
          ...[2, 3, 4].map((n) => h('option', { value: String(n), selected: item.level === n }, `H${n}`))),
        h('input', { type: 'text', class: 'be-h-text', value: item.text, maxlength: '300', 'aria-label': 'Heading text', placeholder: 'Heading', oninput: set('text') }));
    }
    if (item.type === 'paragraph') return paragraphEditor(item);
    if (item.type === 'image') {
      const preview = h('img', { class: 'be-img-prev', alt: '', hidden: !item.src });
      const showPreview = () => { const ok = isLinkHref(item.src) && !/^(http:|mailto:)/i.test(item.src); preview.hidden = !ok; if (ok) preview.src = item.src; };
      showPreview();
      const f = (label, input) => h('label', { class: 'field' }, h('span', { class: 'lab' }, label), input);
      return h('div', { class: 'be-img' },
        h('div', { class: 'be-img-fields' },
          f('Image URL', h('input', { type: 'url', value: item.src, placeholder: 'https://… or /path', oninput: (e) => { item.src = e.target.value; showPreview(); changed(); } })),
          f('Alt text', h('input', { type: 'text', value: item.alt, maxlength: '500', placeholder: 'What the image shows', oninput: set('alt') })),
          f('Caption', h('input', { type: 'text', value: item.caption, maxlength: '1000', oninput: set('caption') })),
          f('Alignment', h('select', { onchange: set('align') },
            h('option', { value: '', selected: !item.align }, 'Default'),
            ...ALIGNS.map((a) => h('option', { value: a, selected: item.align === a }, a[0].toUpperCase() + a.slice(1)))))),
        preview);
    }
    return h('hr', { class: 'be-hr' });
  }

  // A contenteditable paragraph with a toolbar: bold, italic, link, bulleted and numbered lists.
  function paragraphEditor(item) {
    const area = h('div', { class: 'be-p', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Paragraph' });
    area.innerHTML = item.html;
    const update = () => { item.html = area.innerHTML; changed(); };
    area.addEventListener('input', () => { linkErr.textContent = ''; update(); });
    area.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'b' || k === 'i') { e.preventDefault(); cmd(k === 'b' ? 'bold' : 'italic'); }
      else if (k === 'k') { e.preventDefault(); openLink(); }
    });
    // Paste as plain text: formatting from elsewhere is mostly not allowed in a post.
    area.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text === undefined || text === null) return;
      e.preventDefault();
      document.execCommand('insertText', false, text);
    });
    let range = null;
    const keep = () => { const s = getSelection(); if (s.rangeCount && area.contains(s.anchorNode)) range = s.getRangeAt(0).cloneRange(); };
    const restore = () => { area.focus(); if (range) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); } };
    function cmd(name, value) { restore(); document.execCommand(name, false, value); update(); keep(); }

    const linkInput = h('input', { type: 'text', placeholder: 'https://…, mailto:… or /path', 'aria-label': 'Link address' });
    const linkErr = h('span', { class: 'err' });
    const linkBox = h('span', { class: 'be-link', hidden: true },
      linkInput,
      h('button', { type: 'button', class: 'btn sm', onclick: applyLink }, 'Apply'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { linkBox.hidden = true; restore(); } }, 'Cancel'));
    linkInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
      else if (e.key === 'Escape') { e.preventDefault(); linkBox.hidden = true; restore(); }
    });
    function openLink() {
      keep();
      if (!range || range.collapsed) { linkErr.textContent = 'Select some text to link first.'; return; }
      const a = (range.commonAncestorContainer.parentElement || area).closest('a');
      linkInput.value = a && area.contains(a) ? a.getAttribute('href') || '' : '';
      linkErr.textContent = '';
      linkBox.hidden = false;
      linkInput.focus();
    }
    function applyLink() {
      const href = linkInput.value.trim();
      if (!href) { linkBox.hidden = true; cmd('unlink'); return; }
      if (!isLinkHref(href)) { linkErr.textContent = 'Use an http(s) address, a mailto: link or a path starting with /.'; return; }
      linkBox.hidden = true;
      cmd('createLink', href);
    }
    area.addEventListener('keyup', keep);
    area.addEventListener('mouseup', keep);
    area.addEventListener('blur', keep);

    // Toolbar buttons don't take focus on mousedown, so the selection in the paragraph stays.
    const tb = (label, title, fn) => h('button', { type: 'button', class: 'btn sm', title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
    const toolbar = h('div', { class: 'be-tb', role: 'toolbar', 'aria-label': 'Paragraph formatting' },
      tb(h('b', null, 'B'), 'Bold (Ctrl+B)', () => cmd('bold')),
      tb(h('i', null, 'I'), 'Italic (Ctrl+I)', () => cmd('italic')),
      tb('Link', 'Link (Ctrl+K); empty address removes it', openLink),
      tb('• List', 'Bulleted list', () => cmd('insertUnorderedList')),
      tb('1. List', 'Numbered list', () => cmd('insertOrderedList')),
      linkBox, linkErr);
    return h('div', { class: 'be-para' }, toolbar, area);
  }

  // ----- save -----
  async function save() {
    if (saving) return;
    const body = saveBody(titleInput.value, items, updatedAt);
    if (!body.title) { showError('The title must not be empty.'); titleInput.focus(); return; }
    saving = true;
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spin" aria-hidden="true"></span> Saving…';
    showError('');
    try {
      const res = await fetch(`/portal/blog/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.current) {
        showError(data.error || 'This post was changed elsewhere since you loaded it.', true);
        status.textContent = 'Not saved';
        return;
      }
      if (!res.ok) {
        showError(data.error || `Something went wrong (HTTP ${res.status}).`, false, data.errors);
        status.textContent = 'Not saved';
        return;
      }
      updatedAt = data.post.updated_at;
      savedJson = JSON.stringify(saveBody(body.title, items, null));
      status.textContent = dirty() ? 'Saved; newer changes not saved yet' : 'Saved';
    } catch (e) {
      showError('Could not reach the portal. Check your connection and try again.');
      status.textContent = 'Not saved';
    } finally {
      saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  // Errors under the Save button; a conflict says so plainly and offers to reload (losing these edits).
  function showError(msg, conflict, list_) {
    err.replaceChildren();
    if (!msg) return;
    const box = h('div', { class: `card be-alert${conflict ? ' be-conflict' : ''}` },
      h('p', null, h('strong', null, conflict ? 'Not saved: someone else changed this post. ' : 'Not saved. '), msg));
    if (Array.isArray(list_) && list_.length) box.append(h('ul', null, ...list_.map((x) => h('li', null, String(x)))));
    if (conflict) box.append(h('p', { class: 'muted' }, 'Your edits are still here: copy anything you need before reloading.'),
      h('button', { type: 'button', class: 'btn', onclick: () => { savedJson = JSON.stringify(saveBody(titleInput.value, items, null)); location.reload(); } }, 'Reload the latest version'));
    err.append(box);
  }

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) { /* older browsers: <div>s, which the server reduces to text */ }
  items.forEach((e) => els.set(e.key, render(e)));
  sync();
})();
