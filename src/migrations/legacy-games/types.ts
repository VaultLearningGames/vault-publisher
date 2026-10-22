// The one-time import of the Squarespace snapshot (vault-site's data/squarespace/games.json, card D of
// "Retire Squarespace data"): the 99 games' page layout and theme, hero background and logo art, card and
// SEO fields, their old page addresses and the re-host of every game image through card A's compress/crop
// config. The portal carries no games.json of its own: the script reads it from --source (read-only) and
// writes only into the listings the portal already has (it never creates a game).
import type { ListingFields } from '../../listings.ts';

// One section of a legacy game page (a Squarespace fluid-engine section; the "white" and "black-bold"
// themes are the two page colours the old site used).
export interface LegacySection {
  theme?: unknown;
  height?: unknown;
  bg?: { catalog?: unknown; src?: unknown } | null;
  blocks?: LegacyBlock[];
}

// One block of a section. `role` names what the block is: logo, cover, shot1..shot4, titleimg (the hero
// layout's logo art), heading, text, button, accordion. `catalog` is the file's path in the old Hugo site
// ("games/x/img/hero.jpg"); `src` is its Squarespace address ("/sq/img/games/…").
export interface LegacyBlock {
  role?: unknown;
  catalog?: unknown;
  src?: unknown;
  ratio?: unknown;
  fit?: unknown;
  [k: string]: unknown;
}

// One entry of games.json (keyed by the catalog slug). Only the fields the import reads are typed; the rest
// (sections' grid, title_html, …) belong to the site's templates and are ignored here.
export interface LegacyGame {
  path?: unknown;
  layout?: unknown;
  date?: unknown;
  card_id?: unknown;
  card_image?: { catalog?: unknown; src?: unknown } | null;
  card_title?: unknown;
  card_excerpt?: unknown;
  card_categories?: unknown;
  card_tags?: unknown;
  seo_title?: unknown;
  seo_description?: unknown;
  title_scaled?: unknown;
  sections?: LegacySection[];
  [k: string]: unknown;
}

export interface LegacyData {
  _note?: unknown;
  games: Record<string, LegacyGame>;
}

// The image fields the import re-hosts, each with its row in portal/image-fields.ts (card A's config).
export type LegacyImageField = 'hero_image' | 'thumb_image' | 'screenshots' | 'hero_background' | 'logo_image';

// One image to move: `from` is the listing's current value ('' when the field is empty in both the draft and the
// published listing), `source` what to download and compress (the current value, or the old page's image).
export interface ImageJob {
  slug: string;
  field: LegacyImageField;
  index?: number;       // screenshots filled from the old page: where in the list the image goes
  from: string;
  source: string;
  fromLegacy: boolean;  // the image comes from games.json, not from the listing
}

// What one re-hosted image became (kept in the processed record): the new CDN URL and object, the backup of the
// original, and what the compression did.
export interface ImageRecord {
  field: LegacyImageField;
  index?: number;
  from: string;
  source: string;
  to: string;
  key: string;
  backupKey: string;
  in: { w: number; h: number } | null;
  out: { w: number; h: number; bytes: number; quality: number | null; mime: string };
  cropped: number;      // the share of the picture the crop cut away (0: the image already had the field's shape)
  upscaled: boolean;    // the source was under the field's minimum width and was enlarged
  applied: boolean;     // the listing's fields point at it (a legacy fill is applied once, never re-imported over an edit)
  at: string;
}

// The result of one image of a run (or why it failed).
export interface ImageJobResult {
  job: ImageJob;
  to?: string;
  record?: ImageRecord;
  error?: string;
}

// What the run writes for one text/layout field: the value to store and what it replaced (null: the field
// was empty, the default).
export interface FieldWrite {
  field: keyof ListingFields;
  from: unknown;
  to: unknown;
}

// One game of the run report.
export interface GameReport {
  slug: string;
  path: string;                    // the legacy address (the page's old URL)
  match: 'exact' | 'mapped' | 'inverted' | 'unmatched';
  layout: 'hero' | 'standard' | null;
  theme: 'light' | 'dark' | null;
  date: { record: string; legacy: string | null; diffDays: number } | null; // null: no legacy date
  visualChanges: string[];         // why this page looks different from the legacy page (for review)
  fields: FieldWrite[];            // the text/layout fields the run writes
  jobs: ImageJob[];                // images still to re-host (the script compresses and sends each)
  images: ImageRecord[];           // images re-hosted (by this run or an earlier one)
  dropped: {
    titleScaled?: boolean;         // per-game title styling (decision 8): the title renders from the template
    logoBlock?: boolean;           // a standard page's logo block: kept as the logo art, which the standard layout may not draw
    legacyTheme?: string;          // a section theme the portal doesn't offer
    legacyLayout?: string;         // a layout the portal doesn't offer
    unmatchedStrings: { field: 'card_categories' | 'card_tags'; string: string }[];
  };
  conflicts: string[];             // a field a person already set differently: kept, not overwritten
  warnings: string[];
  unchanged: boolean;              // true: the run writes nothing for this game (second run)
}

// The whole run: what it read, what it changed (or would change), and the URLs the site must keep serving.
export interface LegacyReport {
  ran_at: string;
  by: string;
  source: string;
  dry_run: boolean;
  // The snapshot's own shape, as measured by the run (the card's measured state; a mismatch is a warning).
  counts: {
    games: number;
    hero: number;
    standard: number;
    pathDiffers: number;
    seoTitle: number;
    seoDescription: number;
    titleScaled: number;
    listings: number;              // the portal's total listings (the run touches only the matched ones)
    matched: number;
    unmatched: number;             // snapshot entries with no portal listing (never created by the import)
    inverted: number;
  };
  expected: { games: number; hero: number; standard: number; pathDiffers: number; seoTitle: number; seoDescription: number; titleScaled: number };
  games: GameReport[];
  changedPages: { slug: string; path: string; why: string[] }[]; // the pages that visibly change (for djgagnon's review)
  createdAtDifferences: { slug: string; record: string; legacy: string; diffDays: number }[]; // kept: the record's date
  titleStylingDropped: string[];   // games whose per-game title styling (title_scaled) is not imported (decision 8)
  lostUrls: { url: string; game: string; kind: string }[]; // "before" URLs no listing keeps (should be empty)
  written: number;                 // games whose listing the run wrote (0 on a dry run, and on a second run)
  warnings: string[];
  urls: {
    // Every URL the legacy site serves today (before) and the address the catalog expresses after the import:
    // the site must keep each "before" URL resolving (200 or 301). D-site's redirect test fetches these.
    before: { url: string; game: string; kind: 'page' | 'card'; expect: '200' | '301' }[];
    after: { url: string; game: string; kind: 'page' | 'alias' | 'card'; expect: '200' | '301' }[];
  };
}

// The settings record (LEGACY_PROCESSED_KEY): per game, what the import moved and wrote, from → to, for the draft and
// the published listing. It is what makes a second run a no-op (a value that is a recorded "to" is left alone, so a
// person's later edit is never re-imported over) and what --rollback restores.
export interface LegacyProcessedGame {
  images: ImageRecord[];
  fields: { draft: { [field: string]: { from: unknown; to: unknown } }; published: { [field: string]: { from: unknown; to: unknown } } };
}
export type LegacyProcessed = Record<string, LegacyProcessedGame>;
