// Reading the Squarespace snapshot (vault-site's data/squarespace/games.json): its shape checked, each game's layout,
// theme, art and card values pulled out of the old page's sections, and the snapshot's own counts (the card's
// measured state — 99 games, 88 standard, 11 hero, 12 path≠slug, 17 SEO titles, 13 SEO descriptions, 2 scaled
// titles; a mismatch is a warning, not a failure).
import { fail } from '../../app.ts';
import type { LegacyBlock, LegacyData, LegacyGame, LegacyReport } from './types.ts';

export const EXPECTED: LegacyReport['expected'] = { games: 99, hero: 11, standard: 88, pathDiffers: 12, seoTitle: 17, seoDescription: 13, titleScaled: 2 };

// The old page's section themes, as the portal's two (card B). "black-bold" was the hero pages' dark band.
const THEME_OF: Record<string, 'light' | 'dark'> = { white: 'light', 'white-bold': 'light', light: 'light', 'light-bold': 'light', black: 'dark', 'black-bold': 'dark', dark: 'dark', 'dark-bold': 'dark' };

export const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

// The snapshot as sent: the whole file ({ _note, games }) or just its games object, as JSON text or parsed.
export function parseLegacy(input: unknown): LegacyData {
  let v = input;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { fail(400, 'games isn’t valid JSON.'); } }
  const o = v as Record<string, unknown> | null;
  const games = o && typeof o === 'object' && !Array.isArray(o) && o.games && typeof o.games === 'object' && !Array.isArray(o.games) ? o.games : o;
  if (!games || typeof games !== 'object' || Array.isArray(games)) fail(400, 'games should be data/squarespace/games.json (its “games” object: slug → entry).');
  return { games: games as Record<string, LegacyGame> };
}

// Only what the import reads, so the request stays small (the sections' grid geometry is dropped).
export function slimLegacy(data: LegacyData): LegacyData {
  const games: Record<string, LegacyGame> = {};
  for (const [k, g] of Object.entries(data.games)) {
    const { path, layout, date, card_id, card_image, card_title, card_excerpt, card_categories, card_tags, seo_title, seo_description, title_scaled } = g ?? {};
    games[k] = {
      path, layout, date, card_id, card_image, card_title, card_excerpt, card_categories, card_tags, seo_title, seo_description, title_scaled,
      sections: (Array.isArray(g?.sections) ? g.sections : []).map((s) => ({
        theme: s?.theme, bg: s?.bg ? { src: s.bg.src, catalog: s.bg.catalog } : null,
        blocks: (Array.isArray(s?.blocks) ? s.blocks : []).map((b) => ({ role: b?.role, src: b?.src, catalog: b?.catalog, ratio: b?.ratio })),
      })),
    };
  }
  return { games };
}

// An image of the old page: its Squarespace address (what the live page shows), else its old Hugo path.
export function legacyImageSrc(o: { src?: unknown; catalog?: unknown } | null | undefined): string {
  return str(o?.src, 500) || str(o?.catalog, 500);
}

const blocks = (g: LegacyGame): LegacyBlock[] => (Array.isArray(g.sections) ? g.sections : []).flatMap((s) => (Array.isArray(s?.blocks) ? s.blocks : []));
const blockSrc = (g: LegacyGame, role: string) => legacyImageSrc(blocks(g).find((b) => b?.role === role) as { src?: unknown; catalog?: unknown } | undefined);

export interface LegacyValues {
  layout: 'hero' | 'standard' | null;
  rawLayout: string;
  theme: 'light' | 'dark' | null;
  rawTheme: string;
  mixedThemes: boolean;           // the old page's sections had more than one colour (the new page has one)
  heroBackground: string;         // the hero band's background (hero layout only)
  logo: string;                   // the hero's title image, else a standard page's logo block
  logoRole: 'titleimg' | 'logo' | null;
  cover: string;                  // a standard page's cover image
  shots: string[];                // shot1..shot4
  cardImage: string;
  date: string | null;            // ISO
  cardId: string;
  titleScaled: boolean;
}

export function legacyValues(g: LegacyGame): LegacyValues {
  const rawLayout = str(g.layout, 40).toLowerCase();
  const layout = rawLayout === 'hero' || rawLayout === 'standard' ? rawLayout : null;
  const sections = Array.isArray(g.sections) ? g.sections : [];
  const themes = sections.map((s) => str(s?.theme, 40).toLowerCase()).filter(Boolean);
  const rawTheme = themes[0] ?? '';
  const mapped = [...new Set(themes.map((t) => THEME_OF[t] ?? t))];
  const titleimg = blockSrc(g, 'titleimg');
  const logoBlock = blockSrc(g, 'logo');
  const d = str(g.date, 40);
  return {
    layout, rawLayout,
    theme: THEME_OF[rawTheme] ?? null, rawTheme,
    mixedThemes: mapped.length > 1,
    heroBackground: layout === 'hero' ? legacyImageSrc(sections.find((s) => s?.bg)?.bg ?? null) : '',
    logo: titleimg || logoBlock,
    logoRole: titleimg ? 'titleimg' : logoBlock ? 'logo' : null,
    cover: blockSrc(g, 'cover'),
    shots: ['shot1', 'shot2', 'shot3', 'shot4'].map((r) => blockSrc(g, r)).filter(Boolean),
    cardImage: legacyImageSrc(g.card_image ?? null),
    date: d && !Number.isNaN(Date.parse(d)) ? new Date(Date.parse(d)).toISOString() : null,
    cardId: str(g.card_id, 200).toLowerCase(),
    titleScaled: g.title_scaled !== undefined && g.title_scaled !== null && g.title_scaled !== false,
  };
}

// The snapshot's own shape (the matched counts are filled in by the run).
export function legacyCounts(data: LegacyData): Pick<LegacyReport['counts'], 'games' | 'hero' | 'standard' | 'pathDiffers' | 'seoTitle' | 'seoDescription' | 'titleScaled'> {
  const games = Object.entries(data.games);
  const v = games.map(([k, g]) => ({ k, g, l: legacyValues(g ?? {}) }));
  return {
    games: games.length,
    hero: v.filter((x) => x.l.layout === 'hero').length,
    standard: v.filter((x) => x.l.layout === 'standard').length,
    pathDiffers: v.filter((x) => str(x.g?.path, 200).toLowerCase() && str(x.g?.path, 200).toLowerCase() !== x.k).length,
    seoTitle: v.filter((x) => str(x.g?.seo_title)).length,
    seoDescription: v.filter((x) => str(x.g?.seo_description)).length,
    titleScaled: v.filter((x) => x.l.titleScaled).length,
  };
}

export function countWarnings(counts: ReturnType<typeof legacyCounts>): string[] {
  return (Object.keys(EXPECTED) as (keyof typeof EXPECTED)[])
    .filter((k) => counts[k] !== EXPECTED[k])
    .map((k) => `The snapshot has ${counts[k]} ${k} (the card measured ${EXPECTED[k]}).`);
}
