// What the analytics pages ask Google Analytics (Data API v1beta request bodies) and how the answers are read. Pure:
// no network, no clock (callers pass "today" in the property's time zone). The events are those the website's game
// pages send (site/themes/vault-squarespace/static/sq/js/vault-play-analytics.js; docs/analytics.md).

export type RangeKey = 'day' | 'week' | 'month' | 'quarter' | 'year';
export interface RangeDef { label: string; long: string; previous: string; days: number; bucketDays: number; hourly: boolean }
// Rolling periods ending today, each compared with the same length just before it. "Year" is 52 weeks, in weekly
// points, so both periods have whole weeks.
export const RANGES: Record<RangeKey, RangeDef> = {
  day: { label: 'Day', long: 'Today', previous: 'yesterday', days: 1, bucketDays: 1, hourly: true },
  week: { label: 'Week', long: 'Last 7 days', previous: 'the 7 days before', days: 7, bucketDays: 1, hourly: false },
  month: { label: 'Month', long: 'Last 30 days', previous: 'the 30 days before', days: 30, bucketDays: 1, hourly: false },
  quarter: { label: 'Quarter', long: 'Last 90 days', previous: 'the 90 days before', days: 90, bucketDays: 1, hourly: false },
  year: { label: 'Year', long: 'Last 52 weeks', previous: 'the 52 weeks before', days: 364, bucketDays: 7, hourly: false },
};
export const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];
export const rangeOf = (v: string | undefined): RangeKey => (v && v in RANGES ? (v as RangeKey) : 'month');

export const PLAY_EVENTS = ['play_start', 'play_heartbeat', 'play_end'];
// Custom definitions David registers in GA (Admin → Custom definitions): event-scoped dimensions game_slug, studio,
// play_mode; event-scoped metric play_seconds; user-scoped dimension vault_game (the realtime report's only way to
// tell games apart). Until they exist, requests naming them are refused (400) and the pages say so.
export const DIM_GAME = 'customEvent:game_slug';
export const DIM_MODE = 'customEvent:play_mode';
export const MET_SECONDS = 'customEvent:play_seconds';
export const DIM_RT_GAME = 'customUser:vault_game';

export interface Period { start: string; end: string }   // YYYY-MM-DD, inclusive
export interface Scope { game?: string }                // a game's slug; none: the whole site

// ---------- dates ----------
const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// The date and hour now in the GA property's time zone (its reports' days are that zone's days).
export function localNow(timeZone: string, now: Date): { today: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

export function periods(range: RangeKey, today: string): { current: Period; previous: Period } {
  const n = RANGES[range].days;
  return {
    current: { start: addDays(today, -(n - 1)), end: today },
    previous: { start: addDays(today, -(2 * n - 1)), end: addDays(today, -n) },
  };
}

// ---------- requests ----------
type Expr = Record<string, unknown>;
const eventIn = (names: string[]): Expr => names.length === 1
  ? { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: names[0] } } }
  : { filter: { fieldName: 'eventName', inListFilter: { values: names } } };
const exact = (fieldName: string, value: string): Expr => ({ filter: { fieldName, stringFilter: { matchType: 'EXACT', value } } });
const all = (...e: Expr[]): Expr => (e.length === 1 ? e[0] : { andGroup: { expressions: e } });
const withGame = (scope: Scope, field: string, ...e: Expr[]) => all(...e, ...(scope.game ? [exact(field, scope.game)] : []));
const twoRanges = (range: RangeKey, today: string) => {
  const p = periods(range, today);
  return [{ startDate: p.current.start, endDate: p.current.end, name: 'current' }, { startDate: p.previous.start, endDate: p.previous.end, name: 'previous' }];
};

export type GaRequest = Record<string, unknown>;

// Plays (play_start) over both periods, by hour (day) or by day, in one range: split into the two periods when read.
export function seriesRequest(range: RangeKey, today: string, scope: Scope): GaRequest {
  const p = periods(range, today);
  return {
    dateRanges: [{ startDate: p.previous.start, endDate: p.current.end }],
    dimensions: [{ name: RANGES[range].hourly ? 'dateHour' : 'date' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: withGame(scope, DIM_GAME, eventIn(['play_start'])),
    limit: 10000,
  };
}

// Plays, timed plays and seconds played, per game, event and mode, in each period.
export function playsRequest(range: RangeKey, today: string, scope: Scope): GaRequest {
  return {
    dateRanges: twoRanges(range, today),
    dimensions: [{ name: 'eventName' }, { name: DIM_MODE }, { name: DIM_GAME }],
    metrics: [{ name: 'eventCount' }, { name: MET_SECONDS }],
    dimensionFilter: withGame(scope, DIM_GAME, eventIn(PLAY_EVENTS)),
    limit: 10000,
  };
}

// The site's plays without the custom definitions (before they're registered): play_start counts only.
export function basicPlaysRequest(range: RangeKey, today: string): GaRequest {
  return { dateRanges: twoRanges(range, today), dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: eventIn(['play_start']) };
}

// People who started a play, in each period (users can't be added up across rows, so this is its own report).
export function playersRequest(range: RangeKey, today: string, scope: Scope): GaRequest {
  return { dateRanges: twoRanges(range, today), metrics: [{ name: 'totalUsers' }], dimensionFilter: withGame(scope, DIM_GAME, eventIn(['play_start'])) };
}

// The whole site: page views, sessions and visitors in each period.
export function siteRequest(range: RangeKey, today: string): GaRequest {
  return { dateRanges: twoRanges(range, today), metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }] };
}

// Realtime (the last 30 minutes), by country and city. Realtime reports can't see event parameters and refuse eventName
// with activeUsers ("cannot be queried together"), so a player is someone whose user property vault_game is set (the
// play script sets it on play_start), and a game's players are those whose vault_game is that game.
const PLACE_DIMS = [{ name: 'countryId' }, { name: 'country' }, { name: 'city' }];
const notSet = (fieldName: string): Expr => ({ notExpression: exact(fieldName, '(not set)') });
export function realtimePlayersRequest(scope: Scope): GaRequest {
  return {
    dimensions: PLACE_DIMS,
    metrics: [{ name: 'activeUsers' }],
    dimensionFilter: scope.game ? exact(DIM_RT_GAME, scope.game)
      : all({ filter: { fieldName: DIM_RT_GAME, stringFilter: { matchType: 'FULL_REGEXP', value: '.+' } } }, notSet(DIM_RT_GAME)),
    limit: 250,
  };
}
// Everyone on the site, by place: the site's map until vault_game is registered.
export function realtimeVisitorPlacesRequest(): GaRequest {
  return { dimensions: PLACE_DIMS, metrics: [{ name: 'activeUsers' }], limit: 250 };
}
export function realtimeVisitorsRequest(): GaRequest {
  return { metrics: [{ name: 'activeUsers' }] };
}

// ---------- reading answers ----------
export interface GaResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
}
export interface Row { dims: Record<string, string>; mets: Record<string, number> }
export function rowsOf(res: GaResponse): Row[] {
  const dh = (res.dimensionHeaders ?? []).map((h) => h.name), mh = (res.metricHeaders ?? []).map((h) => h.name);
  return (res.rows ?? []).map((r) => ({
    dims: Object.fromEntries(dh.map((n, i) => [n, r.dimensionValues?.[i]?.value ?? ''])),
    mets: Object.fromEntries(mh.map((n, i) => [n, Number(r.metricValues?.[i]?.value ?? 0) || 0])),
  }));
}
// Which period a row of a two-period report is in. GA adds a "dateRange" dimension holding the range's name.
const periodOf = (r: Row): 'current' | 'previous' | null => {
  const v = r.dims.dateRange ?? 'current';
  return v === 'current' || v === 'date_range_0' ? 'current' : v === 'previous' || v === 'date_range_1' ? 'previous' : null;
};

export interface Series {
  range: RangeKey;
  labels: string[];              // one per point, e.g. "Sep 29" or "14:00"
  current: (number | null)[];    // null: a point still in the future (later hours today)
  previous: number[];
  totals: { current: number; previous: number };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const compact = (d: string) => d.replaceAll('-', '');

export function readSeries(res: GaResponse, range: RangeKey, today: string, hourNow: number): Series {
  const def = RANGES[range];
  const counts = new Map<string, number>();
  for (const r of rowsOf(res)) {
    const k = r.dims.dateHour ?? r.dims.date ?? '';
    counts.set(k, (counts.get(k) ?? 0) + (r.mets.eventCount ?? 0));
  }
  const p = periods(range, today);
  const labels: string[] = [], current: (number | null)[] = [], previous: number[] = [];
  if (def.hourly) {
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      labels.push(`${hh}:00`);
      current.push(h > hourNow ? null : counts.get(`${compact(p.current.start)}${hh}`) ?? 0);
      previous.push(counts.get(`${compact(p.previous.start)}${hh}`) ?? 0);
    }
  } else {
    const n = def.days / def.bucketDays;
    const sum = (start: string) => { let s = 0; for (let d = 0; d < def.bucketDays; d++) s += counts.get(compact(addDays(start, d))) ?? 0; return s; };
    for (let i = 0; i < n; i++) {
      const cs = addDays(p.current.start, i * def.bucketDays);
      labels.push(def.bucketDays === 1 ? dayLabel(cs) : `Week of ${dayLabel(cs)}`);
      current.push(sum(cs));
      previous.push(sum(addDays(p.previous.start, i * def.bucketDays)));
    }
  }
  const add = (a: (number | null)[]) => a.reduce<number>((s, v) => s + (v ?? 0), 0);
  return { range, labels, current, previous, totals: { current: add(current), previous: add(previous) } };
}

export interface PlayTotals { plays: number; timedPlays: number; seconds: number }
export interface GamePlays extends PlayTotals { slug: string }
export interface PlayStats {
  current: PlayTotals; previous: PlayTotals;
  games: GamePlays[];           // this period, most plays first
  timed: boolean;               // false: from basicPlaysRequest (no custom definitions yet), so no durations or games
}
const zero = (): PlayTotals => ({ plays: 0, timedPlays: 0, seconds: 0 });
function addRow(t: PlayTotals, r: Row) {
  const ev = r.dims.eventName;
  if (ev === 'play_start') {
    t.plays += r.mets.eventCount ?? 0;
    if (r.dims[DIM_MODE] === 'player') t.timedPlays += r.mets.eventCount ?? 0;
  }
  if (PLAY_EVENTS.includes(ev)) t.seconds += r.mets[MET_SECONDS] ?? 0;
}
export function readPlays(res: GaResponse): PlayStats {
  const out = { current: zero(), previous: zero() };
  const games = new Map<string, GamePlays>();
  for (const r of rowsOf(res)) {
    const p = periodOf(r);
    if (!p) continue;
    addRow(out[p], r);
    const slug = r.dims[DIM_GAME];
    if (p === 'current' && slug && slug !== '(not set)') {
      if (!games.has(slug)) games.set(slug, { slug, ...zero() });
      addRow(games.get(slug)!, r);
    }
  }
  return { ...out, games: [...games.values()].filter((g) => g.plays > 0 || g.seconds > 0).sort((a, b) => b.plays - a.plays || a.slug.localeCompare(b.slug)), timed: true };
}
export function readBasicPlays(res: GaResponse): PlayStats {
  const out = { current: zero(), previous: zero() };
  for (const r of rowsOf(res)) { const p = periodOf(r); if (p) addRow(out[p], r); }
  return { ...out, games: [], timed: false };
}

export interface Pair { current: number; previous: number }
// A two-period report without dimensions: each metric's value in each period.
export function readPairs(res: GaResponse, metrics: string[]): Record<string, Pair> {
  const out: Record<string, Pair> = Object.fromEntries(metrics.map((m) => [m, { current: 0, previous: 0 }]));
  for (const r of rowsOf(res)) { const p = periodOf(r); if (p) for (const m of metrics) out[m][p] += r.mets[m] ?? 0; }
  return out;
}

// Average seconds per timed play (player plays), or null when there were none: then the length is unknown, not zero.
export const averageSeconds = (t: PlayTotals): number | null => (t.timedPlays > 0 ? t.seconds / t.timedPlays : null);

export interface Place { countryId: string; country: string; city: string; users: number }
export function readPlaces(res: GaResponse): Place[] {
  return rowsOf(res).map((r) => ({ countryId: r.dims.countryId ?? '', country: r.dims.country ?? '', city: r.dims.city ?? '', users: r.mets.activeUsers ?? 0 }))
    .filter((p) => p.users > 0).sort((a, b) => b.users - a.users);
}
