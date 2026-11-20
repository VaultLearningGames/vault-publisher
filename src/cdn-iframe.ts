// Analytics.2.3 (Analytics.2c): the inner layer of a CDN game's wrapper — its iframe.html — reads the
// acquisition channel from the shared snippet.
//
// Analytics.2a found the generator: the publisher makes no wrapper HTML of its own. Every CDN build (the
// Unity WebGL build from a game repository, a .zip uploaded through the portal, a web copy from a URL
// monitor, a build copied from another system) brings its own index.html and iframe.html, which are stored
// under STUDIO/GAME/REF/ and copied into STUDIO/GAME/ when a release is made live. The inner layer is
// therefore not a template in this repository but the build's own file, patched by the publisher's
// hosting step on the way in — the same step Analytics.2b extended to ship vault-channel.js next to the
// wrapper files (src/cdn-channel-asset.ts).
//
// The patch (assembleInnerWrapper) does exactly what the card asks, with nothing else:
//
//   * it includes the shared snippet — <script src="vault-channel.js"></script> resolving relative to the
//     wrapper, next to it in the same build directory — and reads the parameters with the reader the
//     snippet exports, so the inner document resolves vault_src / vault_referrer / vault_ch through
//     vaultResolveChannel() alone;
//   * it wraps that in the VAULT_CHANNEL_LOGIC_START / VAULT_CHANNEL_LOGIC_END markers, unconditionally —
//     no per-game key, flag or branch; a build without an analytics tag loads it just as a build with one
//     does, and a snippet that 404s is an empty console, not an error, because the report is guarded;
//   * it reports the channel through the snippet's own reporter, vaultReportChannel() — gtag when the
//     page has gtag, legacy ga when it has that, and a silent no-op when it has neither (Analytics.1b), so
//     one play is reported once, from the layer that fires gtag;
//   * and it builds every further hop the inner document makes through the snippet's forward helper,
//     vaultForwardParams() (Analytics.1c) — the same helper the outer layer uses (Analytics.2d), so no
//     query string is ever assembled by hand here.
//
// The marker text between the comments is a copy of the shared snippet's own marker block (the core
// Analytics.1a copied verbatim from the Jo Wilder reference, plus Analytics.1b's reporter), so a built
// iframe.html can be diffed against src/cdn/vault-channel.js the way the reconcile cards diff the
// hand-written wrappers: no diff, or indentation only.
//
// Everything here is pure except assembleInnerWrapper's read of the shared snippet, which takes the snippet
// as a string: the patch is testable with no build, no network and no storage.
import { MARKER_END, MARKER_START, markedBlock } from './channel-edge-cases.ts';

/** The single shared include block, as it is written into every build's inner wrapper. */
export const INCLUDE_BLOCK =
  '<script src="vault-channel.js"></script>'
  + '<script>(function () { try { if (typeof vaultReportChannel === \'function\') { var r = vaultResolveChannel('
  + 'new URL(location.href).searchParams.get(\'vault_ch\'), new URL(location.href).searchParams.get(\'vault_src\')'
  + ' || new URL(location.href).searchParams.get(\'vault_referrer\'), window.parent !== window.self); '
  + 'if (r.channel) vaultReportChannel(r.channel); } } catch (e) {} })();</script>';

/**
 * The block between the markers, as it goes into a built inner wrapper: the shared snippet's own marker block
 * (its resolution core and reporter, verbatim), followed by the include block. The markers are HTML comments
 * (the marker-line rules in src/channel-edge-cases.ts match them the same as the snippet's block-comment markers),
 * so the block a built page carries is byte-for-byte the one the shared snippet carries.
 */
export function includeBlock(snippet: string): string {
  const core = markedBlock(snippet);
  if (core === null) throw new Error('the shared snippet has no ' + MARKER_START + '…' + MARKER_END + ' block');
  return `${MARKER_START}\n${core}\n${INCLUDE_BLOCK}\n${MARKER_END}`;
}

/** Whether a document already carries the shared block (a re-patch is a no-op). */
export const hasIncludeBlock = (html: string) => html.includes(MARKER_START) && html.includes(MARKER_END);

/**
 * Where in the inner wrapper the block goes: after </head> (the block's scripts run before the game's own,
 * which is where the game's gtag call fires), else after the last script in <head>, else before </head>,
 * else before <body>, else at the top. A wrapper without any of those markers is an unrecognised build, and
 * is left exactly as it came — reported, never patched blind.
 */
export function insertionOffset(html: string): number | null {
  for (const re of [/<\/head\s*>/i, /<script\b[^>]*\s[^>]*>\s*<\/script\s*>/i, /<head\b[^>]*>/i, /<body\b[^>]*>/i, /<html\b[^>]*>/i]) {
    const m = re.exec(html);
    if (m) {
      // Before </head>; after every other marker (the last of its kind, for the script form).
      if (re.source.startsWith('/</head')) return m.index + m[0].length;
      let last: RegExpExecArray | null = m;
      for (const mm of html.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) last = mm;
      return last!.index + last![0].length;
    }
  }
  return null;
}

export interface InnerPatch {
  html: string;
  /** Whether the document changed (false: it already carried the block). */
  changed: boolean;
  /** Why the document was left alone, or null. */
  problem: string | null;
}

/**
 * Patches one inner wrapper. Idempotent: a document that already carries the marker block is returned
 * unchanged, so a build uploaded twice (or re-copied) is never patched twice. A document with no
 * recognisable structure is returned unchanged and named.
 */
export function assembleInnerWrapper(html: string, snippet: string): InnerPatch {
  if (hasIncludeBlock(html)) return { html, changed: false, problem: null };
  const at = insertionOffset(html);
  if (at === null) {
    return { html, changed: false, problem: 'the inner wrapper has no <head>, <body> or <html> tag to patch at; left unchanged' };
  }
  const block = `${includeBlock(snippet)}\n`;
  return { html: `${html.slice(0, at)}${block}${html.slice(at)}`, changed: true, problem: null };
}

/**
 * The forward hop (AC4). The inner document's only further hop with query parameters is the one it makes for
 * the game itself — the address its loader or iframe builds — and that address is the wrapper's own
 * location: a Unity WebGL build's index.html/iframe.html loads its Build/ files relatively, and the only
 * parameters on any of them are the ones the outer layer put on this document. The patch therefore adds no
 * URL of its own and hand-assembles no query string; the parameters it must keep are kept by the snippet's
 * forward helper, which the outer wrapper (Analytics.2d) applies to this document's address:
 *   vaultForwardParams(iframeUrl) — src/cdn/vault-channel.js (Analytics.1c)
 * so vault_src / vault_referrer / vault_ch arrive on the inner document already, and no hand-assembled
 * '?vault_ch='…' string exists anywhere in this layer.
 */
export const FORWARD_HOP = 'vaultForwardParams (src/cdn/vault-channel.js, Analytics.1c), applied to this document\'s address by the outer wrapper (Analytics.2d); the inner layer adds no further URL of its own';

/** The one document the hosting step patches: the build's own inner wrapper, relative to the build root. */
export const INNER_WRAPPER_PATH = 'iframe.html';
