// The blog post editor (/portal/blog/edit/:slug): the title, and the post's body as a list of blocks (heading,
// paragraph, image, divider) that can be added, moved (drag, or the Move up/down buttons) and deleted. The post is a
// Markdown file in the vault-site repository. Save PUTs the title and the blocks in the format of src/blog/blocks.ts
// to /portal/blog/:slug with the file's SHA the page was loaded with, and the server commits it; if the file changed
// in between, the server answers 409 and that is shown, nothing is overwritten.
//
// Beside the blocks, a settings panel (slug with a live URL and availability check, featured image, excerpt, author,
// Published/Private, publish date, tags). Edits autosave about 2 s after the last change to the portal's scratch
// storage (not a commit: only Save, Publish, Unpublish and Delete change the site); Preview shows the unsaved post as
// the site builds it; Publish commits with the publish date set. A new slug renames the post on Save.
//
// Image blocks and the featured image take an uploaded image (picker, drag and drop, or paste) through the image
// editor in portal-blog-image-editor.js: crop, resize, compress, alt text, then stored on the CDN under the post's slug.
//
// Two panes: the body, settings on the right. Each block is a section with a thin outline and a '+' before and after
// it to add a block there; clicking a section selects it and shows its trash button, which asks before deleting. Clicking into a text block shows its format
// bar (style, bold, italic, underline, strikethrough, link, lists, quote, indent); the commands are in
// portal-blog-editor-commands.js, and the server sanitizes the HTML they make.
//
// This file is an ES module so its pure functions (serialize, deserialize, reorder, slugs, tags, autosave timing) can be tested with node:test;
// the page itself is set up by the IIFE at the bottom, which only runs in a browser.

import { imageDropTarget, imagesDropTarget, openImageEditor } from './portal-blog-image-editor.js';
import { LAYOUTS, LAYOUT_LABELS, MAX_DESCRIPTION, MAX_TITLE, newImageId, normalizeImageBlock } from './portal-blog-image-block.js';
import * as commands from './portal-blog-editor-commands.js';

export const BLOCK_TYPES = ['heading', 'paragraph', 'image', 'divider'];
// What the editor calls each block type. The stored type stays 'paragraph' (saved posts, the server and the site use
// it); a text block holds any number of paragraphs, lists and quotes with inline formatting.
export const BLOCK_LABELS = { heading: 'Heading', paragraph: 'Text', image: 'Image', divider: 'Divider' };
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
    case 'image': return { key, type, layout: 'stacked', align: '', images: [] };
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
    if (b && b.type === 'list' && Array.isArray(b.items)) {
      // The editor edits a list as paragraph HTML; the server writes it back as a Markdown list.
      const e = newBlock('paragraph');
      const tag = b.ordered ? 'ol' : 'ul';
      e.html = `<${tag}>${b.items.map((it) => `<li>${spansToHtml(it)}</li>`).join('')}</${tag}>`;
      out.push(e);
      continue;
    }
    if (!b || typeof b !== 'object' || !BLOCK_TYPES.includes(b.type)) continue;
    const e = newBlock(b.type);
    if (b.type === 'heading') { e.level = [2, 3, 4].includes(b.level) ? b.level : 2; e.text = String(b.text || ''); }
    else if (b.type === 'paragraph') e.html = typeof b.html === 'string' ? b.html : spansToHtml(b.children);
    else if (b.type === 'image') { const n = normalizeImageBlock(b); e.layout = n.layout; e.align = n.align || ''; e.images = n.images; }
    out.push(e);
  }
  return out;
}

// The editor's blocks -> the block JSON the server stores. Headings and paragraphs with no text are not content and
// are left out; an image block is kept even with no images yet (a draft may hold one; publishing asks for an image).
// Anything else is sent as it is, so the server's validation can say what's wrong with it.
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
      // With src, alt and caption mirroring the first image, for code that only knows a single image.
      out.push(normalizeImageBlock({ layout: e.layout, align: e.align, images: e.images || [] }));
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

// The body of the save request: the title and blocks, and the file's SHA as loaded (null for a post not committed yet).
export function saveBody(title, items, sha) {
  return { title: String(title || '').trim(), blocks: serializeBlocks(items), sha: sha ?? null };
}

// Links in paragraphs, as the server accepts them: http(s), mailto:, a path starting with one "/", or a #fragment.
export function isLinkHref(href) {
  const h = String(href || '').trim();
  if (!h || /\s/.test(h)) return false;
  if (h.startsWith('#')) return /^#[A-Za-z0-9_:.-]{0,200}$/.test(h);
  if (h.startsWith('/')) return !h.startsWith('//') && !h.startsWith('/\\');
  return /^(https?:\/\/[^/?#]+|mailto:.+)/i.test(h);
}

// ---------- settings ----------
export const MAX_SLUG = 80; // EDITOR_MAX_SLUG in src/portal/blog-admin.ts
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 50;

// "Héllo, World! 2026" -> "hello-world-2026", as the server normalizes editor slugs (src/blog/slug.ts + editorSlug).
export function slugify(input) {
  const s = String(input || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, MAX_SLUG).replace(/-+$/, '');
}

// Whether a loaded post's slug still follows its title, so typing a new title may change it: only for drafts (a
// published post's URL is out there), and only when the slug is the title's or the "untitled" a new draft gets.
export function isAutoSlug(slug, title, publishedAt) {
  if (publishedAt) return false;
  const s = String(slug || '');
  return !s || s === slugify(title) || /^untitled(-\d+)?$/.test(s);
}

// A tag name as the server stores it: trimmed, inner whitespace collapsed; '' when it isn't a usable name.
export function normalizeTag(name) {
  const t = String(name || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_TAG_LENGTH || /[\u0000-\u001f\u007f]/.test(t) || !slugify(t)) return '';
  return t;
}

// The tag list with `name` added: { tags, error }. Duplicates (same slug, so "Math" = "math") are not added again.
export function addTag(tags, name) {
  const list = (tags || []).slice();
  const t = normalizeTag(name);
  if (!t) return { tags: list, error: String(name || '').trim() ? `A tag is 1-${MAX_TAG_LENGTH} characters with letters or digits.` : '' };
  if (list.some((x) => slugify(x) === slugify(t))) return { tags: list, error: '' };
  if (list.length >= MAX_TAGS) return { tags: list, error: `A post may have at most ${MAX_TAGS} tags.` };
  list.push(t);
  return { tags: list, error: '' };
}

// An ISO date-time <-> the value of a datetime-local input, in the browser's time zone.
const pad = (n) => String(n).padStart(2, '0');
export function toLocalInput(iso) {
  const d = new Date(iso || '');
  if (!iso || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(String(value || ''))) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "Saved 12:04" (local time, 24-hour).
export const savedLabel = (date) => `Saved ${pad(date.getHours())}:${pad(date.getMinutes())}`;

// The settings part of the save body. The slug is left out while it is empty or known to be taken, so the rest of the
// post still saves (the server keeps the old slug).
export function settingsBody(s) {
  const out = {
    excerpt: String(s.excerpt || '').trim(),
    featured_image: String(s.featured_image || '').trim() || null,
    author: String(s.author || '').trim(),
    status: s.status === 'private' ? 'private' : 'published',
    published_at: s.published_at || null,
    tags: (s.tags || []).slice(),
  };
  const slug = slugify(s.slug);
  if (slug && !s.slugTaken) out.slug = slug;
  return out;
}

// Autosave as a pure state machine, so the timing rules can be tested without timers:
//   change(at)  an edit at time `at`: a save is due `delay` ms after the last edit
//   start()     a save began (only when autosaveDue() says so); edits during it make the next one due
//   done()      the save ended; a failed save is not retried until the next edit
//   stop()      no more autosaves (a conflict: the page must be reloaded first)
export const AUTOSAVE_DELAY = 2000;
export const autosaveInit = () => ({ dueAt: null, saving: false, stopped: false });
export function autosaveStep(state, action, delay = AUTOSAVE_DELAY) {
  switch (action.type) {
    case 'change': return state.stopped ? state : { ...state, dueAt: action.at + delay };
    case 'start': return { ...state, saving: true, dueAt: null };
    case 'done': return { ...state, saving: false };
    case 'stop': return { ...state, dueAt: null, stopped: true };
    default: return state;
  }
}
// Whether a save should start at time `now`.
export const autosaveDue = (state, now) => !state.stopped && !state.saving && state.dueAt !== null && now >= state.dueAt;

// Whether the settings panel is hidden, remembered in localStorage as '1' / '0'. No value, or no usable storage
// (private mode, disabled), means shown; a failed write still lets the panel be toggled for this page.
export const SETTINGS_COLLAPSED_KEY = 'vault-portal:blog-editor:settings-collapsed';
export function readSettingsCollapsed(storage) {
  try { return !!storage && storage.getItem(SETTINGS_COLLAPSED_KEY) === '1'; } catch (_) { return false; }
}
export function writeSettingsCollapsed(storage, collapsed) {
  try { if (storage) storage.setItem(SETTINGS_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (_) { /* in-session only */ }
}

// ---------- the page ----------
(function () {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('blog-editor');
  const dataEl = document.getElementById('blog-post-data');
  if (!root || !dataEl) return;
  commands.setup();
  const post = JSON.parse(dataEl.textContent || '{}');
  // The post's slug in the repository (its address here), and the file's SHA as loaded; both change on Save.
  let postSlug = root.dataset.slug;
  let sha = post.sha ?? null;
  let savedSlug = postSlug; // where images upload: the slug the server has, not the one being typed
  let items = deserializeBlocks(post.blocks);
  const els = new Map(); // block key -> its element
  let saving = false;
  // A Blog maintainer edits posts but doesn't publish, unpublish or delete them (or change when or whether they show).
  const canPublish = root.dataset.canPublish !== '0';

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
  const titleInput = h('input', { type: 'text', id: 'be-title', class: 'be-title', maxlength: '200', value: post.title || '', 'aria-label': 'Title', placeholder: 'Post title', oninput: onTitle });
  const list = h('div', { class: 'be-blocks', role: 'list', 'aria-label': 'Post body' });
  const status = h('p', { class: 'err status be-status', role: 'status', 'aria-live': 'polite' });
  const err = h('div', { class: 'be-err', role: 'alert' });
  const saveBtn = h('button', { type: 'button', class: 'btn pri', onclick: () => save() }, 'Save');
  const previewBtn = h('button', { type: 'button', class: 'btn', onclick: preview }, 'Preview');
  const publishBtn = h('button', { type: 'button', class: 'btn brass', onclick: publish }, 'Publish');
  const unpublishBtn = h('button', { type: 'button', class: 'btn', onclick: unpublish, hidden: true }, 'Unpublish');
  const deleteBtn = h('button', { type: 'button', class: 'btn danger', onclick: removePost }, 'Delete');
  const announce = h('p', { class: 'be-sr', 'aria-live': 'polite' });
  const siteUrl = String(root.dataset.siteUrl || '').replace(/\/+$/, '');

  // ----- settings -----
  const settings = {
    slug: post.slug || '', slugTaken: false, excerpt: post.excerpt || '', featured_image: post.featured_image || '', author: post.author || '',
    status: post.status === 'private' ? 'private' : 'published', published_at: post.published_at || null,
    tags: (post.tags || []).map((t) => (typeof t === 'string' ? t : t.name)),
  };
  let publishedAt = post.published_at || null; // as saved on the server
  let slugAuto = isAutoSlug(post.slug, post.title, post.published_at);
  const fieldId = (n) => `be-s-${n}`;
  const field = (name, label, input, ...extra) => h('div', { class: 'field' }, h('label', { for: fieldId(name) }, label), input, ...extra);

  const slugInput = h('input', { type: 'text', id: fieldId('slug'), maxlength: String(MAX_SLUG + 20), value: settings.slug, spellcheck: 'false', autocomplete: 'off',
    oninput: () => { slugAuto = false; setSlug(slugInput.value); } });
  const slugUrl = h('p', { class: 'muted be-url' });
  const slugMsg = h('p', { class: 'err be-slug-msg', 'aria-live': 'polite' });

  const imgInput = h('input', { type: 'url', id: fieldId('img'), value: settings.featured_image, placeholder: 'https://… or /path',
    oninput: () => { settings.featured_image = imgInput.value; showImg(); changed(); } });
  const imgPrev = h('img', { class: 'be-img-prev', alt: '', hidden: true });
  const imgMsg = h('p', { class: 'err' });
  const imgField = h('div', { class: 'be-img-drop' }, imgInput);
  imgField.append(imageDropTarget(imgField, async (file) => {
    const r = await editImage(file, { title: 'Featured image', withAlt: false });
    if (!r) return;
    imgInput.value = settings.featured_image = r.url;
    showImg(); changed(); say('Featured image uploaded.');
  }));
  function showImg() {
    const v = imgInput.value.trim();
    const ok = /^https:\/\/[^/?#\s]+\S*$/i.test(v) || (v.startsWith('/') && !v.startsWith('//') && !/\s/.test(v));
    imgPrev.hidden = !ok;
    if (ok) imgPrev.src = v;
    imgMsg.textContent = v && !ok ? 'Use an https address or a path starting with /.' : '';
  }

  const excerptInput = h('textarea', { id: fieldId('excerpt'), rows: '3', maxlength: '1000', oninput: () => { settings.excerpt = excerptInput.value; changed(); } });
  excerptInput.value = settings.excerpt;
  const authorInput = h('input', { type: 'text', id: fieldId('author'), maxlength: '200', value: settings.author, oninput: () => { settings.author = authorInput.value; changed(); } });

  const statusSwitch = h('input', { type: 'checkbox', role: 'switch', id: fieldId('status'), checked: settings.status === 'published',
    onchange: () => { settings.status = statusSwitch.checked ? 'published' : 'private'; statusText.textContent = statusLabel(); changed(); } });
  const statusLabel = () => (settings.status === 'published' ? 'Published: listed in the catalog' : 'Private: not listed in the catalog');
  const statusText = h('span', null, statusLabel());

  const dateInput = h('input', { type: 'datetime-local', id: fieldId('date'), value: toLocalInput(settings.published_at),
    onchange: () => { settings.published_at = fromLocalInput(dateInput.value); changed(); } });

  const tagInput = h('input', { type: 'text', id: fieldId('tags'), maxlength: String(MAX_TAG_LENGTH), list: fieldId('tag-options'), autocomplete: 'off', placeholder: 'Type a tag, Enter to add' });
  const tagOptions = h('datalist', { id: fieldId('tag-options') });
  const tagChips = h('ul', { class: 'be-chips', 'aria-label': 'Tags' });
  const tagMsg = h('p', { class: 'err', 'aria-live': 'polite' });
  const tagCount = h('span', { class: 'muted' });

  const stateLine = h('p', { class: 'be-state', role: 'status' });
  if (!canPublish) statusSwitch.disabled = dateInput.disabled = true;

  const panel = h('aside', { class: 'card be-settings', id: 'be-settings', 'aria-label': 'Post settings' },
    h('h2', null, 'Settings'),
    stateLine,
    field('slug', 'URL slug', slugInput, slugUrl, slugMsg),
    field('img', 'Featured image', imgField, imgPrev, imgMsg,
      h('p', { class: 'muted' }, 'Drop, paste or upload an image. The public blog uses the title as its alt text.')),
    field('excerpt', 'Excerpt', excerptInput, h('p', { class: 'muted' }, 'Shown in the catalog and in link previews.')),
    field('author', 'Author', authorInput),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Visibility'),
      h('label', { class: 'be-switch', for: fieldId('status') }, statusSwitch, statusText),
      h('p', { class: 'muted' }, 'Private hides the post from the catalog only; it is not secure.')),
    field('date', 'Published date', dateInput, h('p', { class: 'muted' }, 'Empty until the post is published. A date in the future schedules it.')),
    field('tags', h('span', null, 'Tags ', tagCount), tagInput, tagOptions, tagChips, tagMsg),
  );

  const previewFrame = h('iframe', { class: 'be-preview-frame', title: 'Preview of the post', sandbox: 'allow-popups allow-popups-to-escape-sandbox' });
  const previewDlg = h('dialog', { class: 'be-preview', 'aria-label': 'Preview' },
    h('div', { class: 'be-preview-bar' }, h('strong', null, 'Preview (unsaved changes included)'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => previewDlg.close() }, 'Close')),
    previewFrame);

  // Show/hide the settings to give the body the full width. Hidden settings keep their inputs and values, and are
  // still saved; the state is applied before the editor is first attached, so it doesn't flash.
  const settingsToggle = h('button', { type: 'button', class: 'btn be-settings-toggle', 'aria-controls': 'be-settings',
    onclick: () => { setCollapsed(!panel.hidden, true); settingsToggle.focus(); } });
  const layout = h('div', { class: 'be-layout' },
    h('div', { class: 'be-col' },
      h('div', { class: 'card be-head' }, h('div', { class: 'field' }, h('label', { for: 'be-title' }, 'Title'), titleInput)),
      h('div', { class: 'card be-body' }, inserter(0), list)),
    panel);
  function storage() { try { return window.localStorage; } catch (_) { return null; } }
  function setCollapsed(collapsed, remember) {
    if (collapsed && panel.contains(document.activeElement)) settingsToggle.focus();
    panel.hidden = collapsed;
    layout.classList.toggle('be-layout--settings-collapsed', collapsed);
    settingsToggle.textContent = collapsed ? 'Show settings' : 'Hide settings';
    settingsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (remember) writeSettingsCollapsed(storage(), collapsed);
  }
  setCollapsed(readSettingsCollapsed(storage()), false);

  root.append(
    layout,
    h('div', { class: 'be-bar' }, saveBtn, previewBtn, canPublish ? [publishBtn, unpublishBtn, deleteBtn] : null, status, settingsToggle),
    err, announce, previewDlg,
  );

  // ----- state -----
  const fullBody = (loadedSha) => ({ ...saveBody(titleInput.value, items, loadedSha), ...settingsBody(settings) });
  const snapshot = () => JSON.stringify(fullBody(null));
  // What the server has, autosaved or committed.
  let savedJson = snapshot();
  const dirty = () => snapshot() !== savedJson;
  let auto = autosaveInit();
  let autoTimer = null;
  function changed() {
    if (!saving) status.textContent = dirty() ? 'Unsaved changes' : '';
    if (dirty()) { auto = autosaveStep(auto, { type: 'change', at: Date.now() }); schedule(); }
  }
  // Runs the autosave when it is due; called after each edit and after each save.
  function schedule() {
    clearTimeout(autoTimer);
    if (auto.dueAt === null || auto.stopped) return;
    autoTimer = setTimeout(() => {
      if (!autosaveDue(auto, Date.now())) return schedule();
      if (dirty() && titleInput.value.trim()) autosave();
    }, Math.max(0, auto.dueAt - Date.now()));
  }

  function onTitle() {
    if (slugAuto) { slugInput.value = slugify(titleInput.value); setSlug(slugInput.value); }
    changed();
  }

  // ----- slug: the live URL and the availability check -----
  let slugTimer = null, slugSeq = 0;
  function setSlug(value) {
    settings.slug = value;
    settings.slugTaken = false;
    const s = slugify(value);
    slugUrl.textContent = `${siteUrl}/blog/${s || '…'}`;
    slugMsg.textContent = value.trim() && !s ? 'The slug needs letters or digits.' : '';
    clearTimeout(slugTimer);
    const seq = ++slugSeq;
    if (s) slugTimer = setTimeout(() => checkSlug(s, seq), 300);
    changed();
  }
  async function checkSlug(s, seq) {
    try {
      const res = await fetch(`/portal/blog/slug-check?slug=${encodeURIComponent(s)}&current=${encodeURIComponent(postSlug)}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'vault-portal' } });
      const data = await res.json();
      if (seq !== slugSeq || !res.ok) return;
      settings.slugTaken = !data.available;
      slugMsg.textContent = data.available ? '' : `Another post already uses /blog/${data.slug}. Choose a different slug; until then the post keeps its current URL.`;
      changed();
    } catch (_) { /* offline: the save will say so */ }
  }
  slugUrl.textContent = `${siteUrl}/blog/${slugify(settings.slug) || '…'}`;

  // ----- tags: type-ahead from existing tags, chips, at most MAX_TAGS -----
  function renderTags() {
    tagChips.replaceChildren(...settings.tags.map((t) => h('li', { class: 'be-chip' }, t,
      h('button', { type: 'button', class: 'be-chip-x', 'aria-label': `Remove tag ${t}`, title: 'Remove',
        onclick: () => { settings.tags = settings.tags.filter((x) => x !== t); tagMsg.textContent = ''; renderTags(); changed(); tagInput.focus(); } }, '✕'))));
    tagCount.textContent = `(${settings.tags.length}/${MAX_TAGS})`;
    tagInput.disabled = settings.tags.length >= MAX_TAGS;
  }
  function commitTag() {
    const r = addTag(settings.tags, tagInput.value);
    tagMsg.textContent = r.error;
    if (r.error) return;
    if (r.tags.length !== settings.tags.length) { settings.tags = r.tags; say(`Tag ${tagInput.value.trim()} added.`); }
    tagInput.value = '';
    renderTags();
    changed();
  }
  let tagTimer = null, tagSeq = 0;
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitTag(); }
    else if (e.key === 'Backspace' && !tagInput.value && settings.tags.length) { settings.tags = settings.tags.slice(0, -1); renderTags(); changed(); }
  });
  tagInput.addEventListener('input', (e) => {
    // Picking a suggestion from the datalist arrives as an input without a key press.
    if (!e.inputType || e.inputType === 'insertReplacementText') { const v = tagInput.value; if ([...tagOptions.options].some((o) => o.value === v)) { commitTag(); return; } }
    clearTimeout(tagTimer);
    const q = tagInput.value.trim(), seq = ++tagSeq;
    if (!q) { tagOptions.replaceChildren(); return; }
    tagTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/portal/blog/tags?q=${encodeURIComponent(q)}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'vault-portal' } });
        const data = await res.json();
        if (seq !== tagSeq || !res.ok) return;
        const have = new Set(settings.tags.map(slugify));
        tagOptions.replaceChildren(...(data.tags || []).filter((t) => !have.has(t.slug)).map((t) => h('option', { value: t.name })));
      } catch (_) { /* suggestions are optional */ }
    }, 200);
  });
  tagInput.addEventListener('blur', () => { if (tagInput.value.trim()) commitTag(); });

  // ----- where the post stands on the public blog -----
  function showState() {
    const url = `${siteUrl}/blog/${postSlug}/`;
    stateLine.replaceChildren();
    unpublishBtn.hidden = !canPublish || !publishedAt || !sha;
    if (!sha) { stateLine.append(h('span', { class: 'pill p-off' }, 'New'), ' Not in the website repository until you save it.'); publishBtn.textContent = 'Publish'; return; }
    if (!publishedAt) { stateLine.append(h('span', { class: 'pill p-off' }, 'Draft'), ' Not on the blog yet.'); publishBtn.textContent = 'Publish'; return; }
    const when = new Date(publishedAt);
    const future = when.getTime() > Date.now();
    stateLine.append(h('span', { class: `pill ${future ? 'p-wait' : 'p-ok'}` }, future ? 'Scheduled' : 'Published'),
      ` ${future ? 'Goes live' : 'Since'} ${when.toLocaleString()}. `,
      settings.status === 'private' ? 'Private: only people with the link see it. ' : '',
      future ? '' : h('a', { href: url, target: '_blank', rel: 'noopener' }, 'View on the blog'));
    publishBtn.textContent = 'Publish changes';
  }
  // Autosaved edits are kept by the portal, so only edits not even autosaved yet warn.
  window.addEventListener('beforeunload', (e) => { if (dirty() || saving) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });

  // ----- the '+' inserter: a button that opens a row of block types -----
  // `where`: 'before' or 'after' the block it is in (a number: the index, for the one above an empty post).
  function inserter(where) {
    const menu = h('div', { class: 'be-ins-menu', hidden: true, role: 'group', 'aria-label': 'Add a block' },
      ...BLOCK_TYPES.map((type) =>
        h('button', { type: 'button', class: 'btn sm', onclick: () => { close(); add(type, indexAfter()); } }, BLOCK_LABELS[type])));
    const label = where === 'before' ? 'Add a block above' : where === 'after' ? 'Add a block below' : 'Add a block here';
    const btn = h('button', { type: 'button', class: 'be-ins-btn', 'aria-expanded': 'false', title: label, 'aria-label': label, onclick: () => (menu.hidden ? open() : close()) }, '+');
    const wrap = h('div', { class: `be-ins${typeof where === 'string' ? ` be-ins-${where}` : ''}`, onkeydown: (e) => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } } }, btn, menu);
    function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); menu.querySelector('button').focus(); }
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    // The inserter at the top adds at 0; one inside a block adds right before or after that block, wherever it is now.
    const indexAfter = () => {
      const blk = wrap.closest('.be-block');
      if (!blk) return typeof where === 'number' ? where : 0;
      return items.findIndex((e) => e.key === blk.dataset.key) + (where === 'before' ? 0 : 1);
    };
    return wrap;
  }

  function add(type, index) {
    const item = newBlock(type);
    items = insertBlock(items, index, item);
    els.set(item.key, render(item));
    sync();
    changed();
    const el = els.get(item.key);
    (el.querySelector('[contenteditable]') || el.querySelector('input, select') || el.querySelector('.be-del')).focus();
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
      el.setAttribute('aria-label', `${BLOCK_LABELS[e.type]}, block ${i + 1} of ${items.length}`);
    });
  }
  const say = (msg) => { announce.textContent = ''; setTimeout(() => { announce.textContent = msg; }, 30); };

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
        e.dataTransfer.setData('text/plain', BLOCK_LABELS[item.type]);
        e.dataTransfer.setDragImage(el, 20, 20);
        el.classList.add('be-dragging');
      },
      ondragend: endDrag }, '⠿');
    const tools = h('div', { class: 'be-tools' },
      h('span', { class: 'be-type' }, BLOCK_LABELS[item.type]),
      h('button', { type: 'button', class: 'btn sm be-up', 'aria-label': 'Move up', title: 'Move up', onclick: () => move(key, idx() - 1, '.be-up') }, '↑'),
      h('button', { type: 'button', class: 'btn sm be-down', 'aria-label': 'Move down', title: 'Move down', onclick: () => move(key, idx() + 1, '.be-down') }, '↓'),
      h('button', { type: 'button', class: 'btn sm be-del', 'aria-label': 'Delete section', title: 'Delete section', 'aria-expanded': 'false', onclick: () => askDelete() }, trashIcon()));
    // Delete asks first, in place: "Delete this section?" with Delete and Cancel.
    const confirmBox = h('div', { class: 'be-confirm', role: 'alertdialog', 'aria-label': 'Confirm delete', hidden: true,
      onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); cancelDelete(); } } },
      h('span', null, `Delete this ${BLOCK_LABELS[item.type].toLowerCase()} section?`),
      h('button', { type: 'button', class: 'btn sm danger be-confirm-yes', onclick: () => remove(key) }, 'Delete'),
      h('button', { type: 'button', class: 'btn sm be-confirm-no', onclick: () => cancelDelete() }, 'Cancel'));
    function askDelete() { select(el); confirmBox.hidden = false; tools.querySelector('.be-del').setAttribute('aria-expanded', 'true'); confirmBox.querySelector('.be-confirm-no').focus(); }
    function cancelDelete() { confirmBox.hidden = true; const d = tools.querySelector('.be-del'); d.setAttribute('aria-expanded', 'false'); d.focus(); }
    const el = h('div', { class: `be-block be-${item.type}`, role: 'listitem', 'data-key': key },
      inserter('before'), handle, h('div', { class: 'be-main' }, tools, confirmBox, editorFor(item)), inserter('after'));
    return el;
  }
  const trashIcon = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '15'); svg.setAttribute('height', '15'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
    return svg;
  };

  // ----- the selected section: the one last clicked or focused; its trash button shows -----
  function select(el) {
    for (const x of list.querySelectorAll('.be-block.be-selected')) {
      if (x === el) continue;
      x.classList.remove('be-selected');
      const c = x.querySelector('.be-confirm'); if (c && !c.hidden) { c.hidden = true; x.querySelector('.be-del').setAttribute('aria-expanded', 'false'); }
    }
    if (el) el.classList.add('be-selected');
  }
  list.addEventListener('focusin', (e) => select(e.target.closest('.be-block')));
  list.addEventListener('mousedown', (e) => select(e.target.closest('.be-block')));
  document.addEventListener('mousedown', (e) => { if (!list.contains(e.target)) select(null); });

  function editorFor(item) {
    const set = (k) => (e) => { item[k] = e.target.value; changed(); };
    if (item.type === 'heading') {
      return h('div', { class: 'be-row' },
        h('select', { 'aria-label': 'Heading level', onchange: (e) => { item.level = Number(e.target.value); changed(); } },
          ...[2, 3, 4].map((n) => h('option', { value: String(n), selected: item.level === n }, `H${n}`))),
        h('input', { type: 'text', class: 'be-h-text', value: item.text, maxlength: '300', 'aria-label': 'Heading text', placeholder: 'Heading', oninput: set('text') }));
    }
    if (item.type === 'paragraph') return paragraphEditor(item);
    if (item.type === 'image') return imageBlockEditor(item);
    return h('hr', { class: 'be-hr' });
  }

  // An image block: its layout (slideshow, carousel, grid, stacked) and alignment, a drop zone that takes one or more
  // images (drag and drop, paste, or the picker; each goes through the image editor and is uploaded), and each image
  // with its thumbnail, title, description, alt text and link. The stored address is never shown: images change by
  // uploading. Images reorder by dragging their handle or with their Move up/down buttons.
  function imageBlockEditor(item) {
    const wrap = h('div', { class: 'be-img be-gallery' });
    const f = (label, input, cls) => h('label', { class: `field${cls ? ` ${cls}` : ''}` }, h('span', { class: 'lab' }, label), input);
    const check = (label, checked, onchange, hint) => h('label', { class: 'be-check' },
      h('input', { type: 'checkbox', checked, onchange: (e) => { onchange(e.target.checked); changed(); } }), ' ', label,
      hint ? h('span', { class: 'muted be-check-hint' }, hint) : null);

    const layoutName = `be-layout-${item.key}`;
    const layouts = h('div', { class: 'be-layouts', role: 'radiogroup', 'aria-label': 'Layout' },
      ...['slideshow', 'carousel', 'grid', 'stacked'].filter((l) => LAYOUTS.includes(l)).map((l) => h('label', { class: 'be-layout-opt' },
        h('input', { type: 'radio', name: layoutName, value: l, checked: item.layout === l, onchange: () => { item.layout = l; changed(); } }),
        layoutIcon(l), h('span', null, LAYOUT_LABELS[l]))));
    const alignSel = h('select', { 'aria-label': 'Alignment', onchange: (e) => { item.align = e.target.value; changed(); } },
      h('option', { value: '', selected: !item.align }, 'Default'),
      ...ALIGNS.map((a) => h('option', { value: a, selected: item.align === a }, a[0].toUpperCase() + a.slice(1))));

    const rows = h('ol', { class: 'be-gallery-list', 'aria-label': 'Images' });
    const drop = h('div', { class: 'be-dropzone' });
    const progress = h('p', { class: 'muted be-gallery-msg', 'aria-live': 'polite' });
    drop.append(imagesDropTarget(wrap, (files) => addFiles(files)), h('span', { class: 'muted' }, ' or drag and drop or paste images here'));

    async function addFiles(files) {
      for (let i = 0; i < files.length; i++) {
        progress.textContent = files.length > 1 ? `Image ${i + 1} of ${files.length}…` : '';
        const r = await editImage(files[i], { title: files.length > 1 ? `Image ${i + 1} of ${files.length}` : 'Image' });
        if (!r) continue;
        item.images.push({ id: newImageId(), url: r.url, alt: r.alt || '', title: '', description: '', showTitle: true, showDescription: true, link: '', linkTarget: '_self' });
        drawRows(); changed(); say('Image uploaded.');
      }
      progress.textContent = '';
    }

    let dragId = null;
    function moveImage(id, to, focusSel) {
      const from = item.images.findIndex((x) => x.id === id);
      if (from < 0 || to < 0 || to >= item.images.length || to === from) return;
      item.images = moveBlock(item.images, from, to);
      drawRows(); changed();
      say(`Image moved to position ${to + 1} of ${item.images.length}.`);
      if (focusSel) { const b = rows.querySelector(`[data-id="${id}"] ${focusSel}`); if (b && !b.disabled) b.focus(); }
    }
    function drawRows() {
      rows.replaceChildren(...item.images.map((img, i) => imageRow(img, i)));
      rows.hidden = !item.images.length;
    }
    function imageRow(img, i) {
      const n = item.images.length;
      const set = (k) => (e) => { img[k] = e.target.value; changed(); };
      const row = h('li', { class: 'be-gimg', 'data-id': img.id, 'aria-label': `Image ${i + 1} of ${n}`,
        ondragover: (e) => { if (!dragId || dragId === img.id) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; row.classList.add('be-drop-before'); },
        ondragleave: () => row.classList.remove('be-drop-before'),
        ondrop: (e) => {
          if (!dragId) return;
          e.preventDefault(); e.stopPropagation();
          row.classList.remove('be-drop-before');
          const from = item.images.findIndex((x) => x.id === dragId);
          moveImage(dragId, from < i ? i - 1 : i);
          dragId = null;
        } },
        h('span', { class: 'be-handle', draggable: 'true', title: 'Drag to reorder', 'aria-hidden': 'true',
          ondragstart: (e) => { e.stopPropagation(); dragId = img.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `Image ${i + 1}`); },
          ondragend: () => { dragId = null; } }, '⠿'),
        h('img', { class: 'be-img-prev', src: img.url, alt: img.alt ? `Image ${i + 1}: ${img.alt}` : `Image ${i + 1}` }),
        h('div', { class: 'be-img-fields' },
          f('Title', h('input', { type: 'text', value: img.title, maxlength: String(MAX_TITLE), oninput: set('title') })),
          f('Alt text', h('input', { type: 'text', value: img.alt, maxlength: '500', placeholder: 'What the image shows', oninput: set('alt') })),
          f('Description', h('textarea', { rows: '2', maxlength: String(MAX_DESCRIPTION), oninput: set('description') }, img.description), 'be-span'),
          h('div', { class: 'be-checks be-span' },
            check('Show title', img.showTitle, (v) => { img.showTitle = v; }),
            check('Show description', img.showDescription, (v) => { img.showDescription = v; })),
          f('Link', h('input', { type: 'url', value: img.link, placeholder: 'https://… or /path (optional)', oninput: set('link') })),
          h('div', { class: 'be-checks' },
            check('Open link in new window', img.linkTarget === '_blank', (v) => { img.linkTarget = v ? '_blank' : '_self'; }))),
        h('div', { class: 'be-gimg-tools' },
          h('button', { type: 'button', class: 'btn sm be-gimg-up', 'aria-label': `Move image ${i + 1} up`, title: 'Move up', disabled: i === 0, onclick: () => moveImage(img.id, i - 1, '.be-gimg-up') }, '↑'),
          h('button', { type: 'button', class: 'btn sm be-gimg-down', 'aria-label': `Move image ${i + 1} down`, title: 'Move down', disabled: i === n - 1, onclick: () => moveImage(img.id, i + 1, '.be-gimg-down') }, '↓'),
          h('button', { type: 'button', class: 'btn sm be-del', 'aria-label': `Remove image ${i + 1}`, title: 'Remove image',
            onclick: () => {
              item.images = item.images.filter((x) => x.id !== img.id); drawRows(); changed(); say('Image removed.');
              // Focus stays in the block: the next image's (or else the last one's) Remove, or the upload button.
              const dels = rows.querySelectorAll('.be-del');
              (dels[Math.min(i, dels.length - 1)] || drop.querySelector('button')).focus();
            } }, trashIcon())));
      return row;
    }
    drawRows();
    wrap.append(
      h('div', { class: 'be-gallery-opts' }, layouts, f('Alignment', alignSel)),
      rows, drop, progress);
    return wrap;
  }
  // Line icons for the layouts: a big image over thumbnails, one between brackets, a 2x2 grid, two stacked.
  function layoutIcon(l) {
    const paths = {
      slideshow: '<rect x="4" y="3" width="24" height="15" rx="1"/><rect x="4" y="21" width="7" height="6"/><rect x="12.5" y="21" width="7" height="6"/><rect x="21" y="21" width="7" height="6"/>',
      carousel: '<rect x="8" y="6" width="16" height="20" rx="1"/><path d="M5 8v16M27 8v16"/>',
      grid: '<rect x="5" y="5" width="10" height="10"/><rect x="17" y="5" width="10" height="10"/><rect x="5" y="17" width="10" height="10"/><rect x="17" y="17" width="10" height="10"/>',
      stacked: '<rect x="6" y="4" width="20" height="11" rx="1"/><rect x="6" y="17" width="20" height="11" rx="1"/>',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('width', '32'); svg.setAttribute('height', '32'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="1.6">${paths[l]}</g>`;
    return svg;
  }

  // The image editor for a picked, dropped or pasted file; resolves to { url, alt } once uploaded, or null.
  async function editImage(file, opts) {
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type || '')) { status.textContent = 'Choose a JPEG, PNG, WebP or GIF image.'; return null; }
    return openImageEditor(file, { ...opts, slug: savedSlug });
  }

  // A contenteditable text section with a format bar that shows while it has focus: style (paragraph, headings, quote),
  // bold, italic, underline, strikethrough, link, bulleted and numbered lists, quote, outdent/indent, clear formatting.
  function paragraphEditor(item) {
    const area = h('div', { class: 'be-p', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Text' });
    area.innerHTML = item.html;
    const update = () => { item.html = area.innerHTML; changed(); };
    area.addEventListener('input', () => { linkErr.textContent = ''; update(); });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey && commands.currentBlock(area)?.tagName === 'LI') { e.preventDefault(); act(() => commands.indent(area, e.shiftKey ? -1 : 1)); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const map = { b: 'bold', i: 'italic', u: 'underline' };
      if (map[k]) { e.preventDefault(); cmd(map[k]); }
      else if (k === 'k') { e.preventDefault(); openLink(); }
      else if (k === ']' || k === '[') { e.preventDefault(); act(() => commands.indent(area, k === ']' ? 1 : -1)); }
    });
    // Paste as plain text: formatting from elsewhere is mostly not allowed in a post.
    area.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text === undefined || text === null) return;
      e.preventDefault();
      commands.insertText(text);
    });
    let range = null;
    const keep = () => { const s = getSelection(); if (s.rangeCount && area.contains(s.anchorNode)) range = s.getRangeAt(0).cloneRange(); };
    const restore = () => { area.focus(); if (range) { const s = getSelection(); s.removeAllRanges(); s.addRange(range); } };
    // Runs a command on the kept selection, then saves the change and refreshes the bar.
    function act(fn) { restore(); fn(); update(); keep(); refresh(); }
    const cmd = (name) => act(() => commands.run(name));

    const linkInput = h('input', { type: 'text', placeholder: 'https://…, mailto:… or /path', 'aria-label': 'Link address' });
    const linkNew = h('input', { type: 'checkbox', 'aria-label': 'Open in a new tab' });
    const linkErr = h('span', { class: 'err' });
    const linkBox = h('span', { class: 'be-link', hidden: true },
      linkInput,
      h('label', { class: 'be-link-new' }, linkNew, ' New tab'),
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
      const has = a && area.contains(a);
      linkInput.value = has ? a.getAttribute('href') || '' : '';
      linkNew.checked = !!has && a.getAttribute('target') === '_blank';
      linkErr.textContent = '';
      linkBox.hidden = false;
      linkInput.focus();
    }
    function applyLink() {
      const href = linkInput.value.trim();
      if (!href) { linkBox.hidden = true; act(() => commands.unlink()); return; }
      if (!isLinkHref(href)) { linkErr.textContent = 'Use an http(s) address, a mailto: link, a path starting with / or a #fragment.'; return; }
      linkBox.hidden = true;
      act(() => {
        commands.createLink(href);
        // The link just made (the selection is inside it): new tab or not.
        const s = getSelection();
        const n = s.rangeCount ? s.getRangeAt(0).commonAncestorContainer : null;
        const links = n ? [...(n.nodeType === 1 ? n.querySelectorAll('a') : []), (n.nodeType === 1 ? n : n.parentElement).closest('a')] : [];
        for (const a of links) if (a && area.contains(a) && a.getAttribute('href') === href) {
          if (linkNew.checked) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); } else { a.removeAttribute('target'); a.removeAttribute('rel'); }
        }
      });
    }
    area.addEventListener('keyup', () => { keep(); refresh(); });
    area.addEventListener('mouseup', () => { keep(); refresh(); });
    area.addEventListener('focus', () => refresh());
    area.addEventListener('blur', keep);

    // Bar buttons don't take focus on mousedown, so the selection in the section stays.
    const tb = (label, title, fn, name) => h('button', { type: 'button', class: 'btn sm be-fb', title, 'aria-label': title, 'aria-pressed': name ? 'false' : undefined, 'data-cmd': name,
      onmousedown: (e) => e.preventDefault(), onclick: fn }, label);
    const style = h('select', { class: 'be-style', 'aria-label': 'Text style', title: 'Text style',
      onchange: () => act(() => commands.setStyle(area, style.value)) },
      ...commands.STYLES.map(([tag, label]) => h('option', { value: tag }, label)));
    const sep = () => h('span', { class: 'be-fb-sep', 'aria-hidden': 'true' });
    const toolbar = h('div', { class: 'be-tb be-fbar', role: 'toolbar', 'aria-label': 'Formatting' },
      style, sep(),
      tb(h('b', null, 'B'), 'Bold (Ctrl+B)', () => cmd('bold'), 'bold'),
      tb(h('i', null, 'I'), 'Italic (Ctrl+I)', () => cmd('italic'), 'italic'),
      tb(h('u', null, 'U'), 'Underline (Ctrl+U)', () => cmd('underline'), 'underline'),
      tb(h('s', null, 'S'), 'Strikethrough', () => cmd('strike'), 'strike'),
      sep(),
      tb('🔗', 'Link (Ctrl+K); empty address removes it', openLink),
      tb('•≡', 'Bulleted list', () => cmd('bullets')),
      tb('1≡', 'Numbered list', () => cmd('numbers')),
      tb('❝', 'Block quote', () => act(() => commands.setStyle(area, 'blockquote'))),
      sep(),
      tb('⇤', 'Outdent (Ctrl+[)', () => act(() => commands.indent(area, -1))),
      tb('⇥', 'Indent (Ctrl+])', () => act(() => commands.indent(area, 1))),
      tb('T̸', 'Clear formatting', () => cmd('clear')),
      linkBox, linkErr);
    // The bar's state at the caret: the block's style and which inline formats are on.
    function refresh() {
      if (!area.contains(document.activeElement) && document.activeElement !== area) return;
      style.value = commands.currentStyle(area);
      const on = commands.active();
      for (const b of toolbar.querySelectorAll('[data-cmd]')) b.setAttribute('aria-pressed', on[b.dataset.cmd] ? 'true' : 'false');
    }
    return h('div', { class: 'be-para' }, toolbar, area);
  }

  // ----- save -----
  const send = (method, url, body) => fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const errorText = (data, res, what) => data.message || data.error || `${what} (HTTP ${res.status}).`;
  // A 409 conflict: the file changed in the repository since it was loaded. No more autosaves until a reload.
  function conflicted(data) {
    auto = autosaveStep(auto, { type: 'stop' });
    showError(data.message || 'This post was changed elsewhere since you loaded it.', true);
  }
  // After a commit: the post as the repository has it now (a rename moves the page to the new address).
  function committed(p) {
    sha = p.sha;
    publishedAt = p.published_at;
    savedSlug = p.slug;
    if (p.slug !== postSlug) {
      postSlug = p.slug;
      root.dataset.slug = p.slug;
      history.replaceState(null, '', `/portal/blog/edit/${encodeURIComponent(p.slug)}`);
    }
  }

  // Saves the post: a commit to the website repository. Resolves to whether it saved.
  let current = null; // the save in flight
  function save(publishing) {
    if (current) return current;
    const body = fullBody(sha);
    if (!body.title) { showError('The title must not be empty.'); titleInput.focus(); return Promise.resolve(false); }
    current = doSave(body, publishing).finally(() => { current = null; });
    return current;
  }
  async function doSave(body, publishing) {
    const sent = JSON.stringify({ ...body, sha: null });
    saving = true;
    auto = autosaveStep(auto, { type: 'start' });
    clearTimeout(autoTimer);
    const btn = publishing ? publishBtn : saveBtn;
    saveBtn.disabled = publishBtn.disabled = true;
    btn.innerHTML = `<span class="spin" aria-hidden="true"></span> ${publishing ? 'Publishing' : 'Saving'}…`;
    status.textContent = publishing ? 'Publishing…' : 'Saving…';
    let ok = false;
    try {
      const res = await send(publishing ? 'POST' : 'PUT', `/portal/blog/${encodeURIComponent(postSlug)}${publishing ? '/publish' : ''}`, body);
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.error === 'conflict') { conflicted(data); status.textContent = 'Not saved'; return false; }
      if (res.status === 409 && data.error === 'slug_taken') {
        settings.slugTaken = true;
        slugMsg.textContent = 'Another post already uses this slug. Choose a different one; until then the post keeps its current URL.';
        if (panel.hidden) setCollapsed(false, true); // the message is in the settings: show them
      }
      // TODO: the server's other validation errors (data.errors) are plain strings with no field, shown in showError;
      // once they name their field, show the settings when one of them is a settings field.
      if (!res.ok) {
        showError(errorText(data, res, 'Something went wrong'), false, data.errors);
        status.textContent = 'Not saved';
        return false;
      }
      showError('');
      committed(data.post);
      if (data.move && data.move.status !== 'done') showError(`The post was renamed, but its old images couldn’t be removed from the CDN: ${data.move.error || 'unknown error'}.`);
      if (publishing) {
        settings.published_at = publishedAt;
        dateInput.value = toLocalInput(publishedAt);
        slugAuto = false;
        savedJson = snapshot();
      } else {
        savedJson = sent;
      }
      status.textContent = dirty() ? `${savedLabel(new Date())}; newer changes not saved yet` : savedLabel(new Date());
      showState();
      if (publishing) say(stateLine.textContent);
      ok = true;
      return true;
    } catch (e) {
      showError('Could not reach the portal. Check your connection and try again.');
      status.textContent = 'Not saved';
      return false;
    } finally {
      saving = false;
      auto = autosaveStep(auto, { type: 'done', ok });
      schedule();
      saveBtn.disabled = publishBtn.disabled = false;
      saveBtn.textContent = 'Save';
      showState();
    }
  }

  // Autosave: to the portal's scratch storage, not the repository. Nothing on the site changes.
  async function autosave() {
    if (current) return;
    const body = fullBody(sha);
    const sent = JSON.stringify({ ...body, sha: null });
    saving = true;
    auto = autosaveStep(auto, { type: 'start' });
    let ok = false;
    try {
      const res = await send('PUT', `/portal/blog/${encodeURIComponent(postSlug)}/autosave`, body);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { status.textContent = `Not autosaved: ${errorText(data, res, 'error')}`; return; }
      savedJson = sent;
      status.textContent = dirty() ? 'Unsaved changes' : `Autosaved ${savedLabel(new Date()).slice(6)}; Save to put it on the site`;
      ok = true;
    } catch (e) {
      status.textContent = 'Not autosaved: offline';
    } finally {
      saving = false;
      auto = autosaveStep(auto, { type: 'done', ok });
      schedule();
    }
  }

  // ----- preview: the unsaved post built by the site, in a panel -----
  async function preview() {
    previewBtn.disabled = true;
    try {
      const res = await send('POST', `/portal/blog/${encodeURIComponent(postSlug)}/preview`, fullBody(sha));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showError(errorText(data, res, 'Could not render the preview'), false, data.errors);
        return;
      }
      showError('');
      // A sandboxed frame without scripts or the portal's origin: the post's HTML can't reach the session.
      previewFrame.srcdoc = await res.text();
      previewDlg.showModal();
    } catch (e) {
      showError('Could not reach the portal. Check your connection and try again.');
    } finally {
      previewBtn.disabled = false;
    }
  }

  // ----- publish: one commit of the post with the publish date set (now, unless one is set) -----
  async function publish() {
    if (current) await current;
    await save(true);
  }

  // ----- unpublish: back to a draft (one commit); edits not saved yet stay in the editor -----
  async function unpublish() {
    if (current) await current;
    if (!sha || !confirm('Take this post off the blog? It stays in the repository as a draft.')) return;
    unpublishBtn.disabled = true;
    try {
      const res = await send('POST', `/portal/blog/${encodeURIComponent(postSlug)}/unpublish`, { sha });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.error === 'conflict') { conflicted(data); return; }
      if (!res.ok) { showError(errorText(data, res, 'Could not unpublish'), false, data.errors); return; }
      showError('');
      committed(data.post);
      settings.published_at = null;
      dateInput.value = '';
      showState();
      changed();
      say(stateLine.textContent);
    } catch (e) {
      showError('Could not reach the portal. Check your connection and try again.');
    } finally {
      unpublishBtn.disabled = false;
    }
  }

  // ----- delete: removes the post's folder from the repository (one commit) -----
  async function removePost() {
    if (current) await current;
    if (!confirm(sha ? 'Delete this post from the website repository? Its page goes away when the site rebuilds.' : 'Discard this new post?')) return;
    deleteBtn.disabled = true;
    try {
      const res = await send('DELETE', `/portal/blog/${encodeURIComponent(postSlug)}`, { sha });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.error === 'conflict') { conflicted(data); return; }
      if (!res.ok) { showError(errorText(data, res, 'Could not delete'), false, data.errors); return; }
      savedJson = snapshot();
      location.href = '/portal/blog';
    } catch (e) {
      showError('Could not reach the portal. Check your connection and try again.');
    } finally {
      deleteBtn.disabled = false;
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
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        savedJson = snapshot();
        // The autosave of the older version would come back on reload; the latest committed post is wanted.
        await send('DELETE', `/portal/blog/${encodeURIComponent(postSlug)}/autosave`).catch(() => {});
        location.reload();
      } }, 'Reload the latest version'));
    err.append(box);
  }

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) { /* older browsers: <div>s, which the server reduces to text */ }
  items.forEach((e) => els.set(e.key, render(e)));
  sync();
  renderTags();
  showImg();
  showState();
  if (post.autosaved_at) status.textContent = `Autosaved changes from ${new Date(post.autosaved_at).toLocaleString()}; Save to put them on the site`;
})();
