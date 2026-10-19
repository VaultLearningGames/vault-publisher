import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markdownToBlocks, blocksToMarkdown, htmlToBlocks } from '../src/site-content/markdown-blocks.ts';
import { validateBlocks } from '../src/blog/blocks.ts';

const body = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8').split(/\n---\n/).slice(1).join('\n---\n').replace(/^\n/, '');

for (const f of ['post-keys.md', 'post-playing.md', 'post-welcome.md']) {
  test(`${f}: written back has no raw HTML, no markers, no escaped shortcodes, and is stable`, () => {
    const once = blocksToMarkdown(markdownToBlocks(body(f)));
    assert.doesNotMatch(once, /vault:html|&#123;|&lt;|&gt;|<(?!!--)(?<!\{\{<)|\\\{/);
    assert.equal(blocksToMarkdown(markdownToBlocks(once)), once);
  });
}

test('image block uses the site image shortcode with align=', () => {
  const md = blocksToMarkdown([{ type: 'image', src: 'https://x.org/a.jpg', alt: 'A', caption: 'C', align: 'wide' }]);
  assert.equal(md, '{{< image src="https://x.org/a.jpg" alt="A" caption="C" align="wide" >}}\n');
  assert.deepEqual(markdownToBlocks(md), [{ type: 'image', src: 'https://x.org/a.jpg', alt: 'A', caption: 'C', align: 'wide' }]);
});

test('the earlier portal escaped image shortcode is read as an image', () => {
  const old = '<!-- vault:html -->\n&#123;{&lt; image src="https://x.org/a.jpg" alt="A" align="left" &gt;}}';
  assert.deepEqual(markdownToBlocks(old), [{ type: 'image', src: 'https://x.org/a.jpg', alt: 'A', align: 'left' }]);
});

test('editor HTML becomes Markdown', () => {
  const md = blocksToMarkdown([{ type: 'paragraph', html: '<p>Hi <strong>there</strong> and <em>you</em>,<br>see <a href="/x">this</a>.</p><h3>Head</h3><p>Two</p>' }]);
  assert.equal(md, 'Hi **there** and *you*,\\\nsee [this](/x).\n\n### Head\n\nTwo\n');
});

test('editor HTML outside the Markdown vocabulary is rejected with a message', () => {
  assert.match(String(htmlToBlocks('<table></table>')), /not supported/);
  const r = validateBlocks([{ type: 'paragraph', html: '<blockquote>q</blockquote>' }]);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /not supported on the site/);
  assert.equal(validateBlocks([{ type: 'paragraph', html: '<p data-indent="2">x</p>' }]).ok, false);
});

test('lists: Markdown lists are list blocks and round-trip; editor list HTML becomes a Markdown list', () => {
  const md = 'Intro.\n\n- one **bold**\n- two [l](/x)\n\n1. a\n2. b\n';
  const blocks = markdownToBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'list', 'list']);
  assert.equal(blocksToMarkdown(blocks), md);
  assert.equal(blocksToMarkdown([{ type: 'paragraph', html: '<ul><li>x</li><li>y <em>z</em></li></ul>' }]), '- x\n- y *z*\n');
  assert.equal(validateBlocks([{ type: 'list', ordered: false, items: [[{ text: 'a' }]] }]).ok, true);
});
