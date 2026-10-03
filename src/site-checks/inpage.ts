// Functions that run INSIDE the page (page.evaluate). Each must be self-contained: it is sent to the browser as
// source text, so it can't use anything else from this module (only types are imported, and those vanish).
import type { ImageSeen, LinkKind, ViewSeen } from '../site-checks.ts';

export const LCP_SCRIPT = `window.__lcp = null; try { new PerformanceObserver(function (l) { var e = l.getEntries().pop(); if (e) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}`;

// The site's player takes each Play button's game address off the button (href becomes "#play") and keeps it out of
// the page. This runs before the page's scripts and notes the address on the button as it is taken, so the engine
// knows which game a button opens without clicking it.
export const PLAY_SCRIPT = `(function () { var set = Element.prototype.setAttribute; Element.prototype.setAttribute = function (name, value) {
  try { if (name === 'href' && value === '#play' && this.tagName === 'A' && !this.hasAttribute('data-check-game')) set.call(this, 'data-check-game', this.href); } catch (e) {}
  return set.apply(this, arguments); }; })();`;

export interface PageData {
  images: ImageSeen[];
  links: { url: string; fragment: string; raw: string; text: string; kind: LinkKind }[];
  ids: string[];
  text: string;
  title: string;
  heading: string;
  plays: { wired: string[]; newTab: string[] };   // game addresses: opened in the site's player, and in a new tab
  refs: Record<string, string>;                    // address → the element that asks for it (the first one, up to 3000)
}

// Down the page in steps (so lazy images load) and back up. Bounded to about four seconds.
export function scrollThrough(): Promise<void> {
  return new Promise((resolve) => {
    let y = 0, steps = 0;
    const step = () => {
      const height = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (y >= height || steps++ >= 40) { window.scrollTo(0, 0); resolve(); return; }
      y += Math.max(200, Math.round(innerHeight * 0.8));
      window.scrollTo(0, y);
      setTimeout(step, 100);
    };
    step();
  });
}

// Gives images that have started arriving (lazy ones the scroll just reached) a few seconds to finish, so they are
// measured and judged as loaded or broken rather than caught half-way.
export function waitForImages(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const pending = [...document.querySelectorAll('img')].filter((i) => (i.currentSrc || i.src) && !i.complete);
    if (!pending.length) return resolve();
    let left = pending.length;
    const one = () => { if (--left <= 0) resolve(); };
    for (const i of pending) { i.addEventListener('load', one, { once: true }); i.addEventListener('error', one, { once: true }); }
    setTimeout(resolve, maxMs);
  });
}

export function navigationTiming(): { ttfb: number | null; domContentLoaded: number | null; load: number | null; lcp: number | null } {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const ms = (v: number | undefined | null) => (v && v > 0 ? Math.round(v) : null);
  return { ttfb: ms(nav?.responseStart), domContentLoaded: ms(nav?.domContentLoadedEventEnd), load: ms(nav?.loadEventEnd), lcp: ms((window as unknown as { __lcp?: number }).__lcp) };
}

export function collectPage(): PageData {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const links: PageData['links'] = [];
  const add = (raw: string | null, kind: LinkKind, text: string) => {
    if (raw === null) return;
    let url = raw, fragment = '';
    try { const u = new URL(raw, document.baseURI); fragment = u.hash.replace(/^#/, ''); u.hash = ''; url = u.href; } catch { /* kept as written; the contract reports it */ }
    links.push({ url, fragment, raw, text: text.slice(0, 80), kind });
  };
  for (const a of document.querySelectorAll('a[href]')) {
    const img = a.querySelector('img[alt]');
    add(a.getAttribute('href'), 'link', clean(a.textContent) || clean(a.getAttribute('aria-label')) || clean(img?.getAttribute('alt')) || clean(a.getAttribute('title')));
  }
  for (const e of document.querySelectorAll('iframe[src]')) add(e.getAttribute('src'), 'frame', clean(e.getAttribute('title')));
  // Only forms a GET can follow: a form that posts answers a GET with "not found" or "not allowed" by design.
  for (const e of document.querySelectorAll('form[action]')) {
    if ((e.getAttribute('action') ?? '').trim() && (e.getAttribute('method') ?? 'get').trim().toLowerCase() === 'get') add(e.getAttribute('action'), 'form', '');
  }
  for (const e of document.querySelectorAll('video[src], source[src]')) add(e.getAttribute('src'), 'link', '');
  for (const e of document.querySelectorAll('link[rel="canonical"]')) add(e.getAttribute('href'), 'meta', 'canonical');
  for (const e of document.querySelectorAll('meta[property="og:image"]')) add(e.getAttribute('content'), 'meta', 'og:image');

  const images: ImageSeen[] = [];
  const alts: string[] = [];
  for (const img of document.querySelectorAll('img')) {
    const alt = clean(img.getAttribute('alt'));
    if (alt) alts.push(alt);
    const src = img.currentSrc || img.src;
    if (!src) continue;
    const r = img.getBoundingClientRect();
    // Broken means it finished and has nothing to show; one still arriving (a slow or lazy image) isn't broken.
    images.push({ src, loaded: !img.complete || img.naturalWidth > 0, natural: [img.naturalWidth, img.naturalHeight], shown: [r.width, r.height] });
  }

  // Which element asks for each file, so a missing one can be found in the page's source.
  const refs: Record<string, string> = {};
  let nrefs = 0;
  const ref = (raw: string | null | undefined, what: string) => {
    if (!raw || nrefs >= 3000) return;
    try { const u = new URL(raw.trim(), document.baseURI); u.hash = ''; if (!(u.href in refs)) { refs[u.href] = what; nrefs++; } } catch { /* not an address */ }
  };
  const srcset = (v: string | null) => (v ?? '').split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
  for (const e of document.querySelectorAll('img')) {
    ref(e.getAttribute('src'), 'img'); ref(e.currentSrc, 'img');
    for (const u of srcset(e.getAttribute('srcset'))) ref(u, 'img srcset');
  }
  for (const e of document.querySelectorAll('picture source[srcset]')) for (const u of srcset(e.getAttribute('srcset'))) ref(u, 'picture source');
  for (const e of document.querySelectorAll('script[src]')) ref(e.getAttribute('src'), 'script');
  for (const e of document.querySelectorAll('link[href]')) ref(e.getAttribute('href'), `link rel=${(e.getAttribute('rel') ?? '').trim() || '?'}`);
  for (const e of document.querySelectorAll('video[src], audio[src], source[src], track[src], embed[src], input[type=image][src]')) ref(e.getAttribute('src'), e.tagName.toLowerCase());
  for (const e of document.querySelectorAll('video[poster]')) ref(e.getAttribute('poster'), 'video poster');
  for (const e of document.querySelectorAll('object[data]')) ref(e.getAttribute('data'), 'object');
  for (const e of document.querySelectorAll('iframe[src]')) ref(e.getAttribute('src'), 'iframe');
  for (const e of document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) ref(e.getAttribute('content'), `meta ${e.getAttribute('property') ?? e.getAttribute('name')}`);
  for (const e of document.querySelectorAll('[style*="url("]')) {
    for (const m of (e.getAttribute('style') ?? '').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) ref(m[1], `${e.tagName.toLowerCase()} style`);
  }

  const ids = [...document.querySelectorAll('[id]')].map((e) => e.id).concat([...document.querySelectorAll('a[name]')].map((e) => e.getAttribute('name') ?? ''));

  // textContent, not innerText (which skips what is hidden and is slow); but textContent glues blocks together
  // ("</p><p>" has no space between), so blocks get a space around them first. Inline tags (a drop cap's span) don't.
  const copy = document.body ? (document.body.cloneNode(true) as HTMLElement) : null;
  let body = '';
  if (copy) {
    for (const e of copy.querySelectorAll('script, style, noscript, template, svg')) e.remove();
    for (const e of copy.querySelectorAll('p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, br, tr, td, th, table, section, article, header, footer, nav, main, aside, blockquote, pre, figure, figcaption, form, button, option, select, dt, dd, dl, hr, summary, details, address, textarea, label')) {
      e.insertAdjacentText('beforebegin', ' ');
      e.insertAdjacentText('afterend', ' ');
    }
    body = copy.textContent ?? '';
  }
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  const text = clean([document.title, description, body, ...alts].join('\n'));

  const plays = { wired: [] as string[], newTab: [] as string[] };
  const label = /^\s*(play( game| now)?|launch game)\s*$/i;
  for (const a of document.querySelectorAll('a[href]')) {
    if (!label.test(a.textContent ?? '')) continue;
    if (a.hasAttribute('data-vault-play')) { plays.wired.push(a.getAttribute('data-check-game') ?? ''); continue; }
    try {
      const u = new URL(a.getAttribute('href') ?? '', document.baseURI);
      if (/^https?:$/.test(u.protocol) && u.host !== location.host) plays.newTab.push(u.href);
    } catch { /* not an address */ }
  }
  return { images, links, ids, text, title: document.title, heading: clean(document.querySelector('h1')?.textContent), plays, refs };
}

// Whether the game's own document shows something.
export function hasVisibleContent(): boolean {
  const body = document.body;
  if (!body) return false;
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  if ([...body.querySelectorAll('canvas, iframe, img, video, svg, object, embed')].some(shown)) return true;
  return (body.innerText ?? '').trim().length > 0 || body.scrollHeight > 50;
}

// One page at the browser's current width.
export function measureView(limits: { width: number; smallTextPx: number; tapTargetPx: number; overflowPx: number }): Omit<ViewSeen, 'path' | 'viewport' | 'width'> {
  const body = document.body, root = document.documentElement;
  // The width asked for, not innerWidth: a phone zooms out to fit a wide page and then reports the page's width.
  const width = limits.width;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (e: Element) => { let s = styles.get(e); if (!s) { s = getComputedStyle(e); styles.set(e, s); } return s; };
  // Short and stable: tag#id, or tag.class1.class2, or (for a bare element) its nearest named ancestor then the tag.
  const name = (e: Element) => {
    const tag = e.tagName.toLowerCase();
    if (e.id) return `${tag}#${e.id}`;
    const classes = [...e.classList].slice(0, 2);
    return classes.length ? `${tag}.${classes.join('.')}` : '';
  };
  const selector = (e: Element) => {
    const own = name(e);
    if (own) return own;
    for (let p = e.parentElement; p && p !== body && p !== root; p = p.parentElement) {
      const n = name(p);
      if (n) return `${n} ${e.tagName.toLowerCase()}`;
    }
    return e.tagName.toLowerCase();
  };
  // Not drawn, or drawn as nothing: a zero box, hidden, see-through, or clipped to a pixel (visually-hidden text).
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = style(e);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return r.width > 1 && r.height > 1;
  };
  const clipsSideways = (s: CSSStyleDeclaration) => /^(hidden|auto|scroll|clip)$/.test(s.overflowX);
  // Whether something between the element and the body is fixed in place or hides what sticks out of it.
  const contained = new Map<Element, boolean>();
  const isContained = (e: Element): boolean => {
    const p = e.parentElement;
    if (!p || p === body || p === root) return false;
    let v = contained.get(p);
    if (v === undefined) { const s = style(p); v = s.position === 'fixed' || clipsSideways(s) || isContained(p); contained.set(p, v); }
    return v;
  };

  let scrollWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
  const reaching: Element[] = [];
  if (body) {
    for (const e of [...body.querySelectorAll('*')].slice(0, 30000)) {
      const r = e.getBoundingClientRect();
      if (r.right <= width + limits.overflowPx || !visible(e)) continue;
      if (style(e).position === 'fixed' || isContained(e)) continue;
      reaching.push(e);
    }
  }
  const set = new Set(reaching);
  const outermost = reaching.filter((e) => { for (let p = e.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
  const offenders = outermost.map((e) => ({ selector: selector(e), right: Math.round(e.getBoundingClientRect().right) })).sort((a, b) => b.right - a.right).slice(0, 5);
  scrollWidth = Math.round(scrollWidth);

  const smallText: ViewSeen['smallText'] = [];
  if (body) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const done = new Set<Element>(), named = new Set<string>();
    for (let n = walker.nextNode(); n && smallText.length < 10; n = walker.nextNode()) {
      const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      const parent = n.parentElement;
      if (!parent || text.replace(/\s/g, '').length < 3 || done.has(parent) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
      const px = parseFloat(style(parent).fontSize);
      if (!(px < limits.smallTextPx) || !visible(parent)) continue;
      done.add(parent);
      const sel = selector(parent);
      if (named.has(sel)) continue;
      named.add(sel);
      smallText.push({ selector: sel, px: Math.round(px * 10) / 10, sample: text.slice(0, 60) });
    }
  }

  const smallTargets: ViewSeen['smallTargets'] = [];
  const seenTargets = new Set<string>();
  for (const e of document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button]')) {
    if (smallTargets.length >= 10) break;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || (r.width >= limits.tapTargetPx && r.height >= limits.tapTargetPx)) continue;
    if (!visible(e)) continue;
    // A link inside a line of text is exempt (WCAG 2.5.8): inline, and the paragraph has other text.
    const parent = e.parentElement;
    if (e.tagName === 'A' && style(e).display === 'inline' && parent && (parent.textContent ?? '').trim().length > (e.textContent ?? '').trim().length) continue;
    // A text link is as tall as its line of text; it is only hard to tap when it is also short (a one-letter link).
    if (e.tagName === 'A' && (e.textContent ?? '').trim() && !e.querySelector('img, svg') && r.width >= limits.tapTargetPx) continue;
    const sel = selector(e);
    if (seenTargets.has(sel)) continue;
    seenTargets.add(sel);
    const label = (e.textContent ?? '').replace(/\s+/g, ' ').trim() || e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLInputElement).value || '';
    smallTargets.push({ selector: sel, width: Math.round(r.width), height: Math.round(r.height), label: label.slice(0, 40) });
  }
  return { hasViewportMeta: !!document.querySelector('meta[name="viewport"]'), scrollWidth, offenders, smallText, smallTargets };
}
