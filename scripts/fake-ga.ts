// A made-up Google Analytics property, for the dev portal (scripts/dev-portal.ts) and tests: answers the analytics
// pages' requests (src/analytics/reports.ts) with plausible, repeatable numbers for the given games.
import type { GaMethod, GaTransport } from '../src/analytics/ga.ts';
import type { GaRequest, GaResponse } from '../src/analytics/reports.ts';
import { addDays } from '../src/analytics/reports.ts';

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 2 ** 32; };

export function fakeGa(games: string[], opts: { log?: { method: GaMethod; body: GaRequest }[] } = {}): GaTransport {
  const weight = (slug: string) => 0.2 + 2 * hash(`w${slug}`) ** 2;
  return async (method, body) => {
    opts.log?.push({ method, body });
    const json = JSON.stringify(body);
    const game = json.match(/"fieldName":"custom(?:Event|User):(?:game_slug|vault_game)","stringFilter":\{"matchType":"EXACT","value":"([^"]+)"/)?.[1];
    const scale = game ? weight(game) / games.reduce((s, g) => s + weight(g), 0) : 1;
    const dims = ((body.dimensions as { name: string }[] | undefined) ?? []).map((d) => d.name);
    const mets = ((body.metrics as { name: string }[] | undefined) ?? []).map((m) => m.name);
    const ranges = (body.dateRanges as { startDate: string; endDate: string; name?: string }[] | undefined) ?? [];
    const res = (rows: [string[], number[]][]): GaResponse => ({
      dimensionHeaders: [...dims, ...(ranges.length > 1 ? ['dateRange'] : [])].map((name) => ({ name })),
      metricHeaders: mets.map((name) => ({ name })),
      rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(Math.round(v)) })) })),
    });
    // Plays on a day: a school-week rhythm, growing over time.
    const daily = (d: string) => {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      const age = (Date.parse('2026-12-31') - Date.parse(d)) / 86400_000;
      return Math.max(0, (dow === 0 || dow === 6 ? 70 : 260) * (1 - age / 1200) * (0.75 + 0.5 * hash(d)) * scale);
    };
    if (method === 'runRealtimeReport') {
      if (!dims.length) return res([[[], [Math.round(140 * scale) + 3]]]);
      const places: [string, string, string, number][] = [['US', 'United States', 'Madison', 14], ['US', 'United States', 'Chicago', 9], ['US', 'United States', 'Austin', 6],
        ['US', 'United States', 'Seattle', 4], ['CA', 'Canada', 'Calgary', 5], ['GB', 'United Kingdom', 'London', 3], ['IN', 'India', 'Bengaluru', 2], ['AU', 'Australia', 'Sydney', 2], ['BR', 'Brazil', 'São Paulo', 1]];
      return res(places.map(([id, c, city, n]) => [[id, c, city], [Math.max(game ? 0 : 1, Math.round(n * scale * (game ? 6 : 1)))]] as [string[], number[]]).filter(([, [n]]) => n > 0));
    }
    if (dims[0] === 'date' || dims[0] === 'dateHour') {
      const rows: [string[], number[]][] = [];
      for (let d = ranges[0].startDate; d <= ranges[0].endDate; d = addDays(d, 1)) {
        const day = d.replaceAll('-', '');
        if (dims[0] === 'date') rows.push([[day], [daily(d)]]);
        else for (let hr = 0; hr < 24; hr++) rows.push([[`${day}${String(hr).padStart(2, '0')}`], [daily(d) * (hr >= 8 && hr <= 15 ? 0.11 : 0.012)]]);
      }
      return res(rows);
    }
    const span = (r: { startDate: string; endDate: string }) => { let s = 0; for (let d = r.startDate; d <= r.endDate; d = addDays(d, 1)) s += daily(d); return s; };
    const named = (i: number) => ranges[i]?.name ?? `date_range_${i}`;
    if (dims.includes('eventName')) {
      const rows: [string[], number[]][] = [];
      ranges.forEach((r, i) => {
        const total = span(r);
        for (const g of game ? [game] : games) {
          const share = game ? 1 : weight(g) / games.reduce((s, x) => s + weight(x), 0);
          const plays = total * share, secs = plays * 0.85 * (240 + 600 * hash(`d${g}`));
          const d = (ev: string, mode: string) => dims.map((n) => (n === 'eventName' ? ev : n.endsWith('play_mode') ? mode : g));
          rows.push([d('play_start', 'player'), [plays * 0.85, 0].slice(0, mets.length)], [d('play_start', 'new_tab'), [plays * 0.15, 0].slice(0, mets.length)]);
          if (dims.length > 1) rows.push([d('play_heartbeat', 'player'), [secs / 30, secs * 0.8]], [d('play_end', 'player'), [plays, secs * 0.2]]);
        }
        rows.forEach((row) => { if (row[0].length === dims.length) row[0].push(named(i)); });
      });
      return res(dims.length > 1 ? rows : rows.reduce((acc, [d, m]) => {
        const hit = acc.find(([x]) => x.join() === d.join()); if (hit) hit[1][0] += m[0]; else acc.push([d, [...m]]); return acc;
      }, [] as [string[], number[]][]));
    }
    // Totals per period: players, or the site's page views, sessions and visitors.
    return res(ranges.map((r, i) => {
      const t = span(r);
      return [[named(i)], mets.map((m) => (m === 'totalUsers' ? t * (json.includes('play_start') ? 0.55 : 1.6) : m === 'sessions' ? t * 2.1 : t * 6.3))];
    }));
  };
}
