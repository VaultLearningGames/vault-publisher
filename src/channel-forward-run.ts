// Running a CDN wrapper's outer page without a browser, to see which parameters it forwards to its inner frame.
//
// src/channel-forwarding.ts judges the sets; this gets them. The honest way to learn what STUDIO/GAME/index.html
// forwards is to run its code, so that is what happens here: the inline <script>s are pulled out of the HTML and
// executed in a node:vm sandbox with the smallest DOM that a click-to-play page uses — a `location` on the probe
// query, a `document` whose querySelector/getElementById/createElement hand back fake elements that record what is
// assigned to `src`, and `addEventListener` which fires DOMContentLoaded/load straight away. Whatever ends up on an
// element whose address names `iframe.html` is the answer.
//
// There is no network, no file system and no process access inside the sandbox: a wrapper's script can only touch
// the stubs below, so running an untrusted game wrapper here is safe. A script that needs something the sandbox
// doesn't have throws, and the throw is returned as `error` rather than raised — a wrapper that cannot be executed
// is reported as such (and compared by what its source declares) instead of failing the whole check.
import { createContext, runInContext } from 'node:vm';
import {
  declaredForwarding, declaredMatch, paramsOf, probeQuery, type Forwarding,
} from './channel-forwarding.ts';

/** Where a wrapper's page lives when it is run, so a relative iframe address resolves the way the CDN serves it. */
export const WRAPPER_BASE = 'https://cdn.vaultlearninggames-staging.org/studio/game/';

/** Every inline script in an HTML document, in order; scripts with a `src` are skipped (nothing is fetched). */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const [, attrs, body] of html.matchAll(re)) {
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=\s*['"]?(?!text\/javascript|application\/javascript|module)/i.test(attrs)) continue;
    if (body.trim()) out.push(body);
  }
  return out;
}

/** The addresses an executed page assigned, in the order assigned. */
export interface RunObservation {
  /** Every value assigned to an element's `src` (or set with setAttribute('src')). */
  srcs: string[];
  /** The address of the inner frame, the last assignment naming iframe.html, or null. */
  iframeSrc: string | null;
  /** Why nothing could be observed (the script threw), or null. */
  error: string | null;
}

interface FakeElement {
  tagName: string;
  src: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  [key: string]: unknown;
}

const INNER = /iframe\.html/i;

/**
 * Runs `html`'s inline scripts over `?query` and reports the addresses they built. `iframeSelector` is not needed:
 * every element the scripts touch is recorded, and the inner frame is recognised by its address.
 */
export function runWrapper(html: string, query = probeQuery(), base = WRAPPER_BASE): RunObservation {
  const srcs: string[] = [];
  const url = `${base}index.html?${query}`;
  type Handler = (event?: unknown) => void;
  const handlers: { type: string; fn: Handler }[] = [];

  const element = (tagName: string): FakeElement => {
    const attrs = new Map<string, string>();
    const el: FakeElement = {
      tagName: tagName.toUpperCase(),
      // Recording through a setter, so `frame.src = …` is captured exactly like setAttribute('src', …).
      setAttribute(name: string, value: string) {
        attrs.set(String(name).toLowerCase(), String(value));
        if (String(name).toLowerCase() === 'src') srcs.push(String(value));
      },
      getAttribute(name: string) { return attrs.get(String(name).toLowerCase()) ?? null; },
      removeAttribute(name: string) { attrs.delete(String(name).toLowerCase()); },
      appendChild(child: unknown) { return child; },
      insertBefore(child: unknown) { return child; },
      removeChild(child: unknown) { return child; },
      addEventListener() {},
      removeEventListener() {},
      contentWindow: null,
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      children: [],
      childNodes: [],
      parentNode: null,
      click() {},
      focus() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      get src() { return attrs.get('src') ?? ''; },
      set src(value: string) { attrs.set('src', String(value)); srcs.push(String(value)); },
      get innerHTML() { return ''; },
      set innerHTML(value: string) {
        // A wrapper that writes its frame as markup is forwarding too: read the src out of what it wrote.
        for (const [, v] of String(value).matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)) srcs.push(v);
      },
      get textContent() { return ''; },
      set textContent(_v: string) {},
    } as unknown as FakeElement;
    return el;
  };

  const anyElement = element('div');
  const frame = element('iframe');
  const document = {
    readyState: 'loading',
    referrer: '',
    title: '',
    cookie: '',
    documentElement: anyElement,
    head: anyElement,
    body: anyElement,
    createElement: (tag: string) => element(tag),
    createTextNode: () => ({}),
    getElementById: (id: string) => (/frame|game|play|iframe/i.test(id) ? frame : anyElement),
    querySelector: (sel: string) => (/iframe|frame|game|play/i.test(sel) ? frame : anyElement),
    querySelectorAll: (sel: string) => (/iframe|frame/i.test(sel) ? [frame] : []),
    getElementsByTagName: (tag: string) => (/iframe/i.test(tag) ? [frame] : [anyElement]),
    getElementsByClassName: () => [anyElement],
    addEventListener: (type: string, fn: Handler) => { handlers.push({ type: String(type), fn }); },
    removeEventListener: () => {},
    write: (markup: string) => { for (const [, v] of String(markup).matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)) srcs.push(v); },
    writeln: () => {},
  };

  const location = {
    href: url,
    search: query ? `?${query}` : '',
    origin: new URL(url).origin,
    protocol: new URL(url).protocol,
    host: new URL(url).host,
    hostname: new URL(url).hostname,
    pathname: new URL(url).pathname,
    hash: '',
    replace() {},
    assign() {},
    reload() {},
    toString: () => url,
  };

  const sandbox: Record<string, unknown> = {
    document,
    location,
    URL,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout: (fn: () => void) => { try { fn(); } catch { /* a timer the page never needed */ } return 0; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn: () => void) => { try { fn(); } catch { /* ditto */ } return 0; },
    cancelAnimationFrame: () => {},
    addEventListener: (type: string, fn: Handler) => { handlers.push({ type: String(type), fn }); },
    removeEventListener: () => {},
    navigator: { userAgent: 'vault-forwarding-check', language: 'en-US', sendBeacon: () => true },
    screen: { width: 1280, height: 800 },
    innerWidth: 1280,
    innerHeight: 800,
    // A wrapper may report through either; neither is allowed to reach a network from here.
    gtag: () => {},
    ga: () => {},
    dataLayer: [],
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    // The top frame IS the wrapper, so it is not embedded: parent === self, as the CDN serves it.
    frameElement: null,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  (document as unknown as Record<string, unknown>).defaultView = sandbox;

  const context = createContext(sandbox);
  let error: string | null = null;
  for (const [i, script] of inlineScripts(html).entries()) {
    try {
      runInContext(script, context, { filename: `wrapper-inline-${i}.js`, timeout: 5000 });
    } catch (err) {
      error ??= (err as Error).message.split('\n')[0];
    }
  }
  // The page is ready: whatever it waited for, fire now (a wrapper that builds its frame on DOMContentLoaded).
  (document as { readyState: string }).readyState = 'complete';
  for (const { type, fn } of [...handlers]) {
    if (!/^(DOMContentLoaded|load|readystatechange|pageshow)$/i.test(type)) continue;
    try { fn.call(sandbox, { type }); } catch (err) { error ??= (err as Error).message.split('\n')[0]; }
  }

  const absolute = srcs.map((s) => { try { return new URL(s, url).toString(); } catch { return s; } });
  const inner = absolute.filter((s) => INNER.test(s));
  return {
    srcs: absolute,
    iframeSrc: inner.length ? inner[inner.length - 1] : null,
    error: srcs.length ? null : error,
  };
}

/**
 * What one wrapper forwards: executed when its script runs and builds an inner address, else the set its source
 * declares (with the reason the execution gave nothing). Never throws.
 */
export function forwardingOf(what: string, html: string, query = probeQuery(), base = WRAPPER_BASE): Forwarding {
  let seen: RunObservation;
  try {
    seen = runWrapper(html, query, base);
  } catch (err) {
    seen = { srcs: [], iframeSrc: null, error: (err as Error).message.split('\n')[0] };
  }
  if (seen.iframeSrc) {
    return { what, params: paramsOf(seen.iframeSrc), iframeSrc: seen.iframeSrc, how: 'executed', note: null };
  }
  const declared = declaredForwarding(html);
  const why = seen.error
    ? `its inline script could not be run here (${seen.error})`
    : seen.srcs.length
      ? `its script set ${seen.srcs.length} address(es) but none naming iframe.html`
      : 'its script set no address at all';
  return {
    what,
    params: declaredMatch(declared, query),
    iframeSrc: '',
    how: 'declared',
    note: `${why}; the set below is what its source names (${declared.names.concat(declared.prefixes.map((p) => `${p}*`)).join(', ') || 'nothing'})`,
  };
}
