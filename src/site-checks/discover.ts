// Finding the site's pages: its sitemap (or sitemap index).
import type { Getter } from './net.ts';
import { errorOf } from './net.ts';

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

// Every address in a sitemap's text, and whether it is an index of other sitemaps.
export function parseSitemap(xml: string): { index: boolean; urls: string[] } {
  const urls = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decode(m[1]));
  return { index: /<sitemapindex[\s>]/i.test(xml), urls };
}

// All page addresses the site lists. Never throws: a site with no sitemap just has none.
export async function readSitemap(get: Getter, origin: string, signal?: AbortSignal): Promise<{ urls: string[]; note: string }> {
  const urls: string[] = [];
  const seen = new Set<string>();
  const visit = async (url: string, depth: number): Promise<string> => {
    if (seen.has(url) || seen.size > 60) return '';
    seen.add(url);
    try {
      const res = await get(url, 20_000, signal);
      if (res.status >= 400) { res.close(); return `${url} answers HTTP ${res.status}`; }
      const parsed = parseSitemap(await res.text(20_000_000));
      if (parsed.index && depth < 2) {
        let note = '';
        for (const child of parsed.urls) note ||= await visit(child, depth + 1);
        return note;
      }
      urls.push(...parsed.urls);
      return '';
    } catch (e) { return `${url}: ${errorOf(e).message}`; }
  };
  const note = await visit(`${origin}/sitemap.xml`, 0);
  return { urls: [...new Set(urls)], note };
}
