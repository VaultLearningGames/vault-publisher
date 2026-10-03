// Makes the analytics map's city points from GeoNames' cities15000 (every city of 15,000 people or more; CC BY 4.0,
// geonames.org): src/analytics/cities.json maps "<country code>|<city name>" (lowercase, accents dropped; GA4's countryId
// and city) to the city's point on public/world-map.svg (see projection.ts). Where names repeat in a country the most
// populous city wins; big cities are also found by their English and other ASCII names (GA writes "Cologne", GeoNames
// "Köln"). Run once by hand; the output is committed, so nothing is downloaded at build or run time.
//   node scripts/world-cities.ts path/to/cities15000.txt   (from https://download.geonames.org/export/dump/cities15000.zip)
import { readFileSync, writeFileSync } from 'node:fs';
import { cityKey } from '../src/analytics/cities.ts';
import { project } from '../src/analytics/projection.ts';

const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'))
  .map((f) => ({ name: f[1], ascii: f[2], alts: f[3], lat: +f[4], lon: +f[5], cc: f[8], pop: +f[14] }))
  .sort((a, b) => b.pop - a.pop);
const r = (n: number) => Math.round(n * 10) / 10;
const out: Record<string, [number, number]> = {};
for (const c of rows) {
  const [x, y] = project(c.lon, c.lat);
  const names = [c.name, c.ascii, ...(c.pop >= 500_000 ? c.alts.split(',').filter((a) => /^[A-Za-z .'-]{3,40}$/.test(a)) : [])];
  for (const n of names) { const k = cityKey(c.cc, n); if (!(k in out)) out[k] = [r(x), r(y)]; }
}
writeFileSync(new URL('../src/analytics/cities.json', import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(out).length} names for ${rows.length} cities`);
