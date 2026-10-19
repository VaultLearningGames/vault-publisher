// The blog editor's formatting commands (portal-blog-editor.js imports this). Every document.execCommand call the editor
// makes is here, so the rest of the editor doesn't depend on it and it can be replaced in one place: execCommand is
// deprecated, but every evergreen browser still supports it, which is fine for an admin-only tool.
// Whatever these produce, the server sanitizes on save (sanitizeParagraphHtml in src/blog/blocks.ts): only p, br,
// strong/b, em/i, u, s/strike/del, a, ul/ol/li, blockquote, h2-h4, code and span, and data-indent="1".."4" on blocks.

// Inline and list commands the format bar offers, by name.
export const INLINE = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough', bullets: 'insertUnorderedList', numbers: 'insertOrderedList', clear: 'removeFormat' };
// The block styles of the "Style" picker: the element each one makes.
export const STYLES = [['p', 'Paragraph'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['blockquote', 'Quote']];
export const MAX_INDENT = 4;
const INDENTABLE = ['P', 'LI', 'H2', 'H3', 'H4', 'BLOCKQUOTE'];

// A block's indent after a step of `delta` (+1 indent, -1 outdent), 0..MAX_INDENT.
export function stepIndent(current, delta) {
  const n = Number.parseInt(current, 10);
  return Math.max(0, Math.min(MAX_INDENT, (Number.isInteger(n) ? n : 0) + delta));
}

// Plain markup, no style attributes (so nothing the sanitizer would drop), and new lines as paragraphs.
export function setup(doc = document) {
  try { doc.execCommand('styleWithCSS', false, 'false'); doc.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) { /* optional */ }
}

export function run(name, value) {
  return document.execCommand(INLINE[name] || name, false, value);
}
export const insertText = (text) => document.execCommand('insertText', false, text);
export const createLink = (href) => document.execCommand('createLink', false, href);
export const unlink = () => document.execCommand('unlink', false);

// The selection's range clipped to `area` (a contenteditable), or null when neither end of it is in `area`. A selection
// dragged out of the section keeps only its part inside, so a style never reaches past the section.
export function rangeIn(area, sel = getSelection()) {
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const inStart = area.contains(r.startContainer), inEnd = area.contains(r.endContainer);
  if (!inStart && !inEnd) return null;
  const c = r.cloneRange();
  if (!inStart) c.setStart(area, 0);
  if (!inEnd) c.setEnd(area, area.childNodes.length);
  return c;
}

// The parts of an inline CSS style the browser may write instead of a tag, as the tags the sanitizer keeps.
export function styleTags(style) {
  const s = String(style || '').toLowerCase();
  const prop = (name) => (new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]*)`).exec(s) || [])[1]?.trim() || '';
  const weight = prop('font-weight');
  const deco = `${prop('text-decoration')} ${prop('text-decoration-line')}`;
  const tags = [];
  if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) tags.push('strong');
  if (/^(italic|oblique)/.test(prop('font-style'))) tags.push('em');
  if (/\bunderline\b/.test(deco)) tags.push('u');
  if (/\bline-through\b/.test(deco)) tags.push('s');
  return tags;
}

// The section's HTML to save. Even with styleWithCSS off the browser sometimes writes a style as a <span style=...>
// (merging blocks, styling text next to styled text); the sanitizer drops style attributes, so such a span becomes the
// tags it stands for (strong, em, u, s) and spans and fonts are unwrapped. The section itself is left as it is.
export function htmlOf(area) {
  const root = area.cloneNode(true);
  // Innermost first, so replacing one never detaches another still to do.
  for (const el of [...root.querySelectorAll('span, font')].reverse()) {
    let inner = el.ownerDocument.createDocumentFragment();
    inner.append(...el.childNodes);
    for (const tag of styleTags(el.getAttribute('style')).reverse()) {
      const w = el.ownerDocument.createElement(tag);
      w.append(inner);
      inner = w;
    }
    el.replaceWith(inner);
  }
  return root.innerHTML;
}

// The block element around the caret inside `area` (a contenteditable), or null.
export function currentBlock(area) {
  const s = getSelection();
  if (!s || !s.rangeCount) return null;
  let n = s.getRangeAt(0).startContainer;
  if (n.nodeType !== 1) n = n.parentElement;
  while (n && n !== area) {
    if (INDENTABLE.includes(n.tagName)) return n;
    n = n.parentElement;
  }
  return null;
}

// The current block's style ('p', 'h2', ..., 'blockquote'), for the Style picker.
export function currentStyle(area) {
  const b = currentBlock(area);
  if (!b) return 'p';
  const q = b.closest('blockquote');
  if (q && area.contains(q)) return 'blockquote';
  const tag = b.tagName.toLowerCase();
  return tag === 'li' ? 'p' : tag;
}

// Sets the current block's style; picking Quote again on a quote turns it back into a paragraph.
export function setStyle(area, tag) {
  const next = tag === 'blockquote' && currentStyle(area) === 'blockquote' ? 'p' : tag;
  return document.execCommand('formatBlock', false, `<${next}>`);
}

// Indent (+1) or outdent (-1) the block around the caret, as data-indent; text not in a block is made a paragraph first.
export function indent(area, delta) {
  let b = currentBlock(area);
  if (!b) { document.execCommand('formatBlock', false, '<p>'); b = currentBlock(area); }
  if (!b) return false;
  const n = stepIndent(b.getAttribute('data-indent'), delta);
  if (n) b.setAttribute('data-indent', String(n)); else b.removeAttribute('data-indent');
  return true;
}

// Which inline formats are on at the caret, for the bar's pressed buttons.
export function active() {
  const on = {};
  for (const k of ['bold', 'italic', 'underline', 'strike']) {
    try { on[k] = document.queryCommandState(INLINE[k]); } catch (_) { on[k] = false; }
  }
  return on;
}
