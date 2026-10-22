// A game page's colour theme follows its layout (card G of "Retire Squarespace data"): Hero pages are dark,
// Standard pages are light. Measured on the 100 production games (2026-10-22), the old theme was 100% predicted by
// the layout, and no site template supports Hero+Light or Standard+Dark — so the editor no longer asks. The stored
// `theme` stays (the catalog's shape doesn't change); every write sets it from the layout.
import { effectivePageLayout, type Theme } from './listing-layout.ts';

// The theme a layout gives: 'dark' for Hero, 'light' for anything else (Standard, and an empty or unknown layout,
// as the Standard default).
export function deriveTheme(pageLayout: unknown): Theme {
  return effectivePageLayout(pageLayout) === 'hero' ? 'dark' : 'light';
}
