// What the analytics pages ask Google Analytics (Data API v1beta request bodies) and how the answers are read. Pure:
// no network, no clock (callers pass "today" and the hour in the property's time zone). The events are those the
// website's game pages send (site/themes/vault-squarespace/static/sq/js/vault-play-analytics.js; docs/analytics.md).

export type RangeKey = 'day' | 'week' | 'month' | 'quarter' | 'year';
export interface RangeDef {
  label: string; long: string;
  previous: string;              // the period before, whole
  same: string;                  // what the period so far is compared with
  unit: 'hour' | 'day' | 'month';
}
// Calendar periods: this one so far (it always holds today), compared with the same days of the one before (today
// with yesterday up to the same hour). The chart draws the whole period, the days still to come empty. Weeks start
// on Sunday (a US school audience; the property's days are America/Chicago days).
export const RANGES: Record<RangeKey, RangeDef> = {
  day: { label: 'Day', long: 'Today', previous: 'yesterday', same: 'yesterday by this hour', unit: 'hour' },
  week: { label: 'Week', long: 'This week', previous: 'last week', same: 'the same days last week', unit: 'day' },
  month: { label: 'Month', long: 'This month', previous: 'last month', same: 'the same days last month', unit: 'day' },
  quarter: { label: 'Quarter', long: 'This quarter', previous: 'last quarter', same: 'the same days last quarter', unit: 'day' },
  year: { label: 'Year', long: 'This year', previous: 'last year', same: 'the same days last year', unit: 'month' },
};
export const RANGE_KEYS = Object.keys(RANGES) as RangeKey[];
export const rangeOf = (v: string | undefined): RangeKey => (v && v in RANGES ? (v as RangeKey) : 'month');

export const PLAY_EVENTS = ['play_start', 'play_heartbeat', 'play_end'];
// Custom definitions registered in GA (Admin → Custom definitions): event-scoped dimensions game_slug, studio,
// play_mode; event-scoped metric play_seconds; user-scoped dimension vault_game (the realtime report's only way to
// tell games apart). A property without them refuses requests naming them (400) and the pages say so.
export const DIM_GAME = 'customEvent:game_slug';
export const DIM_MODE = 'customEvent:play_mode';
export const MET_SECONDS = 'customEvent:play_seconds';
export const DIM_RT_GAME = 'customUser:vault_game';

export interface Period { start: string; end: string }   // YYYY-MM-DD, inclusive
// What a view covers. A game: its slug and its page paths on the site (pages.ts). A studio: its slug, its games on the
// site and all their page paths. Neither: the whole site.
export interface Scope { game?: string; studio?: string; games?: string[]; pages?: string[] }

// ---------- dates ----------
const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);   // m from 0; overflow rolls
const monthEnd = (y: number, m: number) => ymd(y, m + 1, 0);
// The same day n months away, or that month's last day when it is shorter (Mar 31 → Feb 28).
function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1, day = Number(d.slice(8, 10));
  const end = monthEnd(y, m + n);
  return Number(end.slice(8, 10)) < day ? end : ymd(y, m + n, day);
}

// The date and hour now in the GA property's time zone (its reports' days are that zone's days).
export function localNow(timeZone: string, now: Date): { today: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

// current: this period so far (to today); previous: the same days of the one before; *Full: the whole periods.
export interface Periods { current: Period; previous: Period; currentFull: Period; previousFull: Period }
export function periods(range: RangeKey, today: string): Periods {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
  if (range === 'day' || range === 'week') {
    const back = range === 'day' ? 0 : new Date(`${today}T00:00:00Z`).getUTCDay();   // Sunday: 0
    const n = range === 'day' ? 1 : 7;
    const cs = addDays(today, -back), ps = addDays(cs, -n);
    return {
      current: { start: cs, end: today }, previous: { start: ps, end: addDays(today, -n) },
      currentFull: { start: cs, end: addDays(cs, n - 1) }, previousFull: { start: ps, end: addDays(cs, -1) },
    };
  }
  const months = range === 'month' ? 1 : range === 'quarter' ? 3 : 12;
  const first = range === 'month' ? m : range === 'quarter' ? m - (m % 3) : 0;
  const cs = ymd(y, first, 1), ps = ymd(y, first - months, 1);
  return {
    current: { start: cs, end: today }, previous: { start: ps, end: addMonths(today, -months) },
    currentFull: { start: cs, end: monthEnd(y, first + months - 1) }, previousFull: { start: ps, end: addDays(cs, -1) },
  };
}

// ---------- requests ----------
type Expr = Record<string, unknown>;
const eventIn = (names: string[]): Expr => names.length === 1
  ? { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: names[0] } } }
  : { filter: { fieldName: 'eventName', inListFilter: { values: names } } };
const exact = (fieldName: string, value: string): Expr => ({ filter: { fieldName, stringFilter: { matchType: 'EXACT', value } } });
const inList = (fieldName: string, values: string[]): Expr => ({ filter: { fieldName, inListFilter: { values: [...new Set(values)] } } });
const all = (...e: Expr[]): Expr => (e.length === 1 ? e[0] : { andGroup: { expressions: e } });
// A game by game_slug, or a studio's games by the list of them.
const withGame = (scope: Scope, field: string, ...e: Expr[]) =>
  all(...e, ...(scope.game ? [exact(field, scope.game)] : scope.games ? [inList(field, scope.games)] : []));
const pathIn = (paths: string[]): Expr => inList('pagePath', paths);
// Today against yesterday: both days up to this hour (GA's hour is "00"–"23"; the single digits too, to be safe).
const hoursTo = (range: RangeKey, hour: number): Expr[] => (range !== 'day' || hour >= 23 ? []
  : [inList('hour', Array.from({ length: hour + 1 }, (_, h) => (h < 10 ? [`0${h}`, String(h)] : [String(h)])).flat())]);
const twoRanges = (range: RangeKey, today: string) => {
  const p = periods(range, today);
  return [{ startDate: p.current.start, endDate: p.current.end, name: 'current' }, { startDate: p.previous.start, endDate: p.previous.end, name: 'previous' }];
};

export type GaRequest = Record<string, unknown>;

// Plays (play_start) and page views by hour (day) or by day, from the start of the previous period to today, in one
// range: split into the two periods and the two events when read. A game is its page (play events are sent from it),
// so no custom definitions are needed and the years of page views before the play events are there too.
export function seriesRequest(range: RangeKey, today: string, scope: Scope): GaRequest {
  const p = periods(range, today);
  return {
    dateRanges: [{ startDate: p.previousFull.start, endDate: p.current.end }],
    dimensions: [{ name: RANGES[range].unit === 'hour' ? 'dateHour' : 'date' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: byGame(scope, eventIn(['play_start', 'page_view'])),
    limit: 10000,
  };
}

// Plays, timed plays and seconds played, per game, event and mode, in each period. hour: now (for Day).
export function playsRequest(range: RangeKey, today: string, scope: Scope, hour = 23): GaRequest {
  return {
    dateRanges: twoRanges(range, today),
    dimensions: [{ name: 'eventName' }, { name: DIM_MODE }, { name: DIM_GAME }],
    metrics: [{ name: 'eventCount' }, { name: MET_SECONDS }],
    dimensionFilter: withGame(scope, DIM_GAME, eventIn(PLAY_EVENTS), ...hoursTo(range, hour)),
    limit: 10000,
  };
}

// A game (or a studio's games) by its pages when they're known, else by game_slug.
const byGame = (scope: Scope, ...e: Expr[]) => (scope.pages?.length ? all(...e, pathIn(scope.pages)) : withGame(scope, DIM_GAME, ...e));

// Plays without the custom definitions: play_start counts only (a game: on its page).
export function basicPlaysRequest(range: RangeKey, today: string, scope: Scope = {}, hour = 23): GaRequest {
  return { dateRanges: twoRanges(range, today), dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: byGame(scope, eventIn(['play_start']), ...hoursTo(range, hour)) };
}

// People who started a play, in each period (users can't be added up across rows, so this is its own report).
export function playersRequest(range: RangeKey, today: string, scope: Scope, hour = 23): GaRequest {
  return { dateRanges: twoRanges(range, today), metrics: [{ name: 'totalUsers' }], dimensionFilter: byGame(scope, eventIn(['play_start']), ...hoursTo(range, hour)) };
}

// The whole site: page views, sessions and visitors in each period.
export function siteRequest(range: RangeKey, today: string, hour = 23): GaRequest {
  const h = hoursTo(range, hour);
  return { dateRanges: twoRanges(range, today), metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }], ...(h.length ? { dimensionFilter: all(...h) } : {}) };
}

// A game's pages (or a studio's games' pages) in each period: page views, visitors (users of its page_view rows) and
// outbound link clicks from them (enhanced measurement's "click" event, outbound links only: the old site's Play
// button linked out to the game).
export function pagesRequest(range: RangeKey, today: string, paths: string[], hour = 23): GaRequest {
  return {
    dateRanges: twoRanges(range, today), dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'eventCount' }],
    dimensionFilter: all(eventIn(['page_view', 'click']), pathIn(paths), ...hoursTo(range, hour)),
  };
}
// Every game page's views and outbound clicks this period: the site's top games before there are plays by game.
export function topPagesRequest(range: RangeKey, today: string, paths: string[]): GaRequest {
  const p = periods(range, today).current;
  return {
    dateRanges: [{ startDate: p.start, endDate: p.end }], dimensions: [{ name: 'pagePath' }, { name: 'eventName' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'eventCount' }],
    dimensionFilter: all(eventIn(['page_view', 'click']), pathIn(paths)), limit: 10000,
  };
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
// A studio's players now: those whose vault_game is one of its games (the players' report, by the list of them).
export function realtimeStudioRequest(games: string[]): GaRequest {
  return { ...realtimePlayersRequest({}), dimensionFilter: inList(DIM_RT_GAME, games) };
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
  labels: string[];              // one per point, e.g. "Sun Sep 27", "14:00" or "Jan"
  current: (number | null)[];    // null: a point still to come (later hours today, later days)
  previous: (number | null)[];   // the whole previous period; null: past its end (a shorter month or quarter)
  totals: { current: number; previous: number };   // this period so far, and the same days (hours) of the one before
  partial?: number;              // the point still being counted, when it is a month (Year): drawn apart
}
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dayLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const compact = (d: string) => d.replaceAll('-', '');

// event: which event's counts (rows without eventName count as it).
export function readSeries(res: GaResponse, range: RangeKey, today: string, hourNow: number, event = 'play_start'): Series {
  const def = RANGES[range];
  const counts = new Map<string, number>();
  for (const r of rowsOf(res)) {
    if ((r.dims.eventName ?? event) !== event) continue;
    const k = r.dims.dateHour ?? r.dims.date ?? '';
    counts.set(k, (counts.get(k) ?? 0) + (r.mets.eventCount ?? 0));
  }
  const p = periods(range, today);
  const labels: string[] = [], current: (number | null)[] = [], previous: (number | null)[] = [];
  const sum = (from: string, to: string) => { let s = 0; for (let d = from; d <= to; d = addDays(d, 1)) s += counts.get(compact(d)) ?? 0; return s; };
  if (def.unit === 'hour') {
    const at = (d: string, h: number) => counts.get(`${compact(d)}${String(h).padStart(2, '0')}`) ?? 0;
    let prevSoFar = 0;
    for (let h = 0; h < 24; h++) {
      labels.push(`${String(h).padStart(2, '0')}:00`);
      current.push(h > hourNow ? null : at(p.current.start, h));
      previous.push(at(p.previous.start, h));
      if (h <= hourNow) prevSoFar += at(p.previous.start, h);
    }
    return { range, labels, current, previous, totals: { current: current.reduce<number>((s, v) => s + (v ?? 0), 0), previous: prevSoFar } };
  }
  if (def.unit === 'day') {
    const n = daysBetween(p.currentFull.start, p.currentFull.end) + 1;
    for (let i = 0; i < n; i++) {
      const d = addDays(p.currentFull.start, i), pd = addDays(p.previousFull.start, i);
      labels.push(range === 'week' ? `${WEEKDAYS[i]} ${dayLabel(d)}` : dayLabel(d));
      current.push(d > today ? null : counts.get(compact(d)) ?? 0);
      previous.push(pd > p.previousFull.end ? null : counts.get(compact(pd)) ?? 0);
    }
  }
  let partial: number | undefined;
  if (def.unit === 'month') {
    const y = Number(today.slice(0, 4));
    if (today !== monthEnd(y, Number(today.slice(5, 7)) - 1)) partial = Number(today.slice(5, 7)) - 1;
    for (let m = 0; m < 12; m++) {
      const ms = ymd(y, m, 1), me = monthEnd(y, m);
      labels.push(MONTHS[m]);
      current.push(ms > today ? null : sum(ms, me < today ? me : today));
      previous.push(sum(ymd(y - 1, m, 1), monthEnd(y - 1, m)));
    }
  }
  return { range, labels, current, previous, totals: { current: sum(p.current.start, p.current.end), previous: sum(p.previous.start, p.previous.end) }, ...(partial === undefined ? {} : { partial }) };
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

export interface PageStats { views: Pair; visitors: Pair; clicks: Pair }
export function readPages(res: GaResponse): PageStats {
  const out: PageStats = { views: { current: 0, previous: 0 }, visitors: { current: 0, previous: 0 }, clicks: { current: 0, previous: 0 } };
  for (const r of rowsOf(res)) {
    const p = periodOf(r);
    if (!p) continue;
    out.views[p] += r.mets.screenPageViews ?? 0;
    if (r.dims.eventName === 'page_view') out.visitors[p] += r.mets.totalUsers ?? 0;
    if (r.dims.eventName === 'click') out.clicks[p] += r.mets.eventCount ?? 0;
  }
  return out;
}
export interface GamePages { slug: string; views: number; clicks: number }
// Rows by page path, added up per game (catalog: each game's paths); other pages are left out. Most views first.
export function readTopPages(res: GaResponse, catalog: Record<string, string[]>): GamePages[] {
  const slugOf = new Map(Object.entries(catalog).flatMap(([slug, paths]) => paths.map((p) => [p, slug] as const)));
  const games = new Map<string, GamePages>();
  for (const r of rowsOf(res)) {
    const slug = slugOf.get(r.dims.pagePath ?? '');
    if (!slug) continue;
    const g = games.get(slug) ?? { slug, views: 0, clicks: 0 };
    g.views += r.mets.screenPageViews ?? 0;
    if (r.dims.eventName === 'click') g.clicks += r.mets.eventCount ?? 0;
    games.set(slug, g);
  }
  return [...games.values()].filter((g) => g.views > 0 || g.clicks > 0).sort((a, b) => b.views - a.views || a.slug.localeCompare(b.slug));
}

// Average seconds per timed play (player plays), or null when there were none: then the length is unknown, not zero.
export const averageSeconds = (t: PlayTotals): number | null => (t.timedPlays > 0 ? t.seconds / t.timedPlays : null);

export interface Place { countryId: string; country: string; city: string; users: number }
export function readPlaces(res: GaResponse): Place[] {
  return rowsOf(res).map((r) => ({ countryId: r.dims.countryId ?? '', country: r.dims.country ?? '', city: r.dims.city ?? '', users: r.mets.activeUsers ?? 0 }))
    .filter((p) => p.users > 0).sort((a, b) => b.users - a.users);
}
