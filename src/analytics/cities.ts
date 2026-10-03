// Cities' points on the analytics world map, by GA4's countryId and city (cities.json, made by scripts/world-cities.ts
// from GeoNames, CC BY 4.0). A city that isn't there (small towns, unusual spellings) is drawn at its country's point.
import { readFileSync } from 'node:fs';

export const cityKey = (countryId: string, city: string) =>
  `${countryId.toUpperCase()}|${city.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()}`;

let points: Record<string, [number, number]> | null = null;
export function cityPoint(countryId: string, city: string): [number, number] | null {
  if (!city || city === '(not set)') return null;
  points ??= JSON.parse(readFileSync(new URL('./cities.json', import.meta.url), 'utf8')) as Record<string, [number, number]>;
  return points[cityKey(countryId, city)] ?? null;
}
