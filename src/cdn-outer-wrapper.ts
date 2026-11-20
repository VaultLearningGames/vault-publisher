// Analytics.2.4 (Analytics.2d): the OUTER layer of a CDN game's wrapper — its index.html — includes the
// shared snippet and builds the inner iframe's src with the forward helper, so the full
// vault_src / vault_referrer / vault_ch set reaches iframe.html and nothing else decides which params are
// forwarded.
//
// The "template" this card edits is the one Analytics.2a identified: the publisher generates no wrapper HTML of
// its own. Every CDN build (Unity WebGL from a game repository, a .zip uploaded through the portal, a web copy
// from a URL monitor, a build copied from another system) brings its own index.html and iframe.html, and the
// directory the player loads is assembled by the publisher's hosting step:
//
//   * the preview build — finishUpload() in src/app.ts — is what the player previews and what a release is cut
//     from, so it is the build the portal owns end to end. shipChannelLayer() below ships it complete: it ships
//     the shared snippet next to the wrappers (Analytics.2b's putChannelAsset), patches the build's own inner
//     wrapper (Analytics.2c's assembleInnerWrapper), and patches the build's own OUTER wrapper — the work of
//     this card, assembleOuterWrapper() below;
//   * the live release — makeLive() in src/releases.ts — then copies that whole directory into STUDIO/GAME/
//     unchanged (a release keeps whatever its preview build's wrapper files already carry), and it ships the
//     shared snippet into the live directory itself as well, so both layers' <script src="vault-channel.js">
//     always resolves even for a release cut from a preview build published before this card landed.
//
// The outer patch (assembleOuterWrapper) does exactly what the card asks, with nothing else:
//
//   * it includes the shared snippet unconditionally — <script src="vault-channel.js"></script> resolving
//     relative to the wrapper, next to it in the same build directory; no per-game key, flag or branch is
//     consulted, so a build without an analytics tag loads it just as a build with one does, and a snippet that
//     404s is an empty console, not an error, because the report is guarded (Analytics.1b);
//   * it wraps that in the VAULT_CHANNEL_LOGIC_START / VAULT_CHANNEL_LOGIC_END markers — the same literals the
//     inner layer (Analytics.2c) and the shared snippet carry, so the built outer page is diffable the way
//     src/channel-edge-cases.ts diffs the built inner page;
//   * and it is the ONLY place that decides which params are forwarded to the inner frame: it assigns the
//     frame's src with the snippet's own forward helper, vaultForwardParams('iframe.html') (Analytics.1c), and
//     it removes the static src attribute the build's iframe carried, so the frame loads exactly once and no
//     query string is ever assembled by hand in either wrapper layer (the inner hop is Analytics.2c's; this is
//     the outer one).
//
// Everything here is pure except shipChannelLayer's storage calls: the patches take the snippet and the wrapper
// pages as strings, so they are testable with no build, no network and no storage.
import { INNER_WRAPPER_PATH, assembleInnerWrapper, includeBlock } from './cdn-iframe.ts';
import { MARKER_END, MARKER_START } from './channel-edge-cases.ts';
import { headersFor, type ObjectHeaders } from './paths.ts';
import type { Storage } from './storage.ts';

/**
 * The forward call the outer layer makes: the one and only place in the outer wrapper that decides which params
 * reach the inner frame. vaultForwardParams() is the shared snippet's own helper (src/cdn/vault-channel.js,
 * Analytics.1c); the fallback is the bare relative path, which carries no query string — so when the snippet
 * somehow is not there, no hand-built '?vault_ch=…' string ever appears in its place.
 */

/**
 * The forward call the outer layer makes: the one and only place in the outer wrapper that decides which params
 * reach the inner frame. vaultForwardParams() is the shared snippet's own helper (src/cdn/vault-channel.js,
 * Analytics.1c); the fallback is the bare relative path, which carries no query string — so when the snippet
 * somehow is not there, no hand-built '?vault_ch=…' string ever appears in its place.
 */
export const FORWARD_CALL =
  "f.src = (typeof window.vaultForwardParams === 'function') ? window.vaultForwardParams('iframe.html') : 'iframe.html';";

/**
 * The include the outer wrapper carries: the shared snippet by its relative path (Analytics.2b ships it next to
 * the wrappers in every build directory), and the one line that assigns the inner frame's src through the
 * snippet's forward helper (the call above). The frame element itself is patched separately so that it carries
 * no src attribute at all — the frame loads exactly once, from this assignment.
 */
export const OUTER_INCLUDE =
  '<script src="vault-channel.js"></script>\n'
  + '<script>document.addEventListener(\'DOMContentLoaded\', function () { try {'
  + ' var f = document.getElementById(\'vault-game-frame\') || document.querySelector(\'iframe\');'
  + ` if (f) { ${FORWARD_CALL} } } catch (e) {} });</script>`;

/** The one element the outer wrapper's forward call addresses, when the build's own frame has no id yet. */
export const FRAME_ID = 'vault-game-frame';

/**
 * The block between the markers, as a built outer wrapper carries it: the shared core (verbatim from the
 * snippet, so a built page can be diffed against src/cdn/vault-channel.js the way the reconcile cards diff the
 * built inner page), followed by this layer's own include — the shared file's <script src> and the one forward
 * call. Every line of the core is a statement or a comment, so no indentation is needed: the shared core is
 * byte-identical in both built pages.
 */
export function outerChannelBlock(snippet: string): string {
  const core = includeBlock(snippet)
    .replace(/^VAULT_CHANNEL_LOGIC_START\n/, '')
    .replace(/VAULT_CHANNEL_LOGIC_END\n?\s*$/, '')
    .replace(/<script src="vault-channel\.js"><\/script>\n?/, '');
  return `${MARKER_START}
${core}
${OUTER_INCLUDE}
${MARKER_END}`;
}

/**
 * The outer document's marker block is the shared one (its text is not diffed here the way the inner one is —
 * this layer does not duplicate the snippet's core, it includes the file — but it must exist for the built page
 * to be recognised as carrying the block, and nothing may assemble a vault_* query string by hand).
 */
const HAND_ASSEMBLED = /["'`][^"'`]*\?vault_(?:ch|src|referrer)=/i;

/**
 * Whether the outer document already carries the shared block (a re-patch is a no-op): the marker pair is
 * present and no hand-assembled vault_* query string anywhere in the page.
 */
export const hasOuterBlock = (html: string): boolean =>
  html.includes('VAULT_CHANNEL_LOGIC_START') && html.includes('VAULT_CHANNEL_LOGIC_END') && !HAND_ASSEMBLED.test(html);

/** The first iframe element in a document, or null. */
function firstFrame(html: string): { start: number; end: number; element: string } | null {
  for (const m of html.matchAll(/<iframe\b[^>]*\/?>/gi)) {
    return { start: m.index!, end: m.index! + m[0].length, element: m[0] };
  }
  return null;
}

export interface OuterPatch {
  html: string;
  /** Whether the document changed (false: it already carried the block, or it was left alone). */
  changed: boolean;
  /** Whether the page carries an iframe the forward call can address. */
  frameFound: boolean;
  /** Why the document was left alone, or null. */
  problem: string | null;
}

/**
 * Patches one outer wrapper. The page is left exactly as it came when it is unrecognised (no <head>/<body>/
 * <html> to patch at, or no <iframe> to forward to) and named; when it carries the block already it is a no-op,
 * so a build uploaded twice (or re-copied) is never patched twice. Otherwise:
 *
 *   1. the marker block (the shared include plus the forward call) goes in right after </head>, else before
 *      <body>, else at the top — the scripts in it run before the page's own, the way Analytics.2c places the
 *      inner one;
 *   2. the first iframe — the game frame — is given id="vault-game-frame" when it has no id yet, and its static
 *      src attribute is removed (whichever value it carried), so nothing but the forward call assembles the
 *      frame's address: the frame loads exactly once, through vaultForwardParams('iframe.html').
 */
export function assembleOuterWrapper(html: string, snippet: string): OuterPatch {
  if (hasOuterBlock(html)) return { html, changed: false, frameFound: /<iframe\b/i.test(html), problem: null };

  const frame = firstFrame(html);
  if (frame === null) return { html, changed: false, frameFound: false, problem: 'the outer wrapper has no <iframe> to forward to; left unchanged' };

  // id it (if unnamed) and take its static src away: the forward call in the block below is the only writer.
  let element = frame.element;
  if (!/\bid\s*=/i.test(element)) element = element.replace(/^<iframe\b/i, `<iframe id="${FRAME_ID}"`);
  element = element.replace(/\bsrc\s*=\s*("[^"]*"|'[^']*')/i, '');

  const head = html.search(/<\/head\s*>/i);
  const body = head !== -1 ? -1 : html.search(/<body\b[^>]*>/i);
  const htmlTop = html.search(/<html\b[^>]*>/i);
  if (head === -1 && body === -1 && htmlTop === -1) {
    return { html, changed: false, frameFound: true, problem: 'the outer wrapper has no <head>, <body> or <html> tag to patch at; left unchanged' };
  }
  const at = head !== -1
    ? head + (html.match(/<\/head\s*>/i) as RegExpMatchArray)[0].length
    : body !== -1 ? body : htmlTop + (html.match(/<html\b[^>]*>/i) as RegExpMatchArray)[0].length;

  const html2 = html.slice(0, frame.start) + element + html.slice(frame.end);
  const at2 = at < frame.start ? at : at - (frame.element.length - element.length);
  const block = `${outerChannelBlock(snippet)}\n`;
  return { html: html2.slice(0, at2) + block + html2.slice(at2), changed: true, frameFound: true, problem: null };
}

/**
 * The preview build is the directory the player previews and a release is cut from, so the portal owns its
 * wrapper files end to end. This makes one preview build carry the whole channel story:
 *
 *   * the shared snippet, next to the wrappers, exactly as Analytics.2b's putChannelAsset() writes it (the
 *     bytes of src/cdn/vault-channel.js, never templated);
 *   * the build's own inner wrapper, patched by Analytics.2c's assembleInnerWrapper();
 *   * the build's own OUTER wrapper, patched by this card's assembleOuterWrapper().
 *
 * Unconditional and idempotent: every preview build gets it (no per-game key, no branch), and a wrapper that
 * already carries the block is left alone, so re-uploading a build changes nothing. A build without an
 * index.html is left entirely alone and named — nothing is invented for it.
 */
export async function shipChannelLayer(
  storage: Pick<Storage, 'get' | 'put' | 'list'>,
  prefix: string,
  snippet: string,
  cacheControl?: string,
): Promise<{ outer: OuterPatch | null; inner: { changed: boolean; problem: string | null } | null; snippetKey: string }> {
  if (!prefix.endsWith('/')) throw new Error('prefix must end in "/"');
  const indexKey = `${prefix}index.html`;
  const iframeKey = `${prefix}${INNER_WRAPPER_PATH}`;
  const objects = new Map((await storage.list(prefix)).map((o) => [o.key, o.size]));
  const snippetKey = `${prefix}vault-channel.js`;

  let outer: OuterPatch | null = null;
  if (objects.has(indexKey)) {
    outer = assembleOuterWrapper(new TextDecoder().decode((await storage.get(indexKey)) as Uint8Array), snippet);
    if (outer.changed) {
      const body = new TextEncoder().encode(outer.html);
      const h: ObjectHeaders = { ...headersFor('index.html') };
      if (cacheControl) h.cacheControl = cacheControl;
      await storage.put(indexKey, body, body.byteLength, h);
    }
  }
  let inner: { changed: boolean; problem: string | null } | null = null;
  if (objects.has(iframeKey)) {
    const p = assembleInnerWrapper(new TextDecoder().decode((await storage.get(iframeKey)) as Uint8Array), snippet);
    if (p.changed) {
      const body = new TextEncoder().encode(p.html);
      const h: ObjectHeaders = { ...headersFor(INNER_WRAPPER_PATH) };
      if (cacheControl) h.cacheControl = cacheControl;
      await storage.put(iframeKey, body, body.byteLength, h);
    }
    inner = { changed: p.changed, problem: p.problem };
  }
  return { outer, inner, snippetKey };
}
