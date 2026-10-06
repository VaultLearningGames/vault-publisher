// What the analytics pages ask Google Analytics (Data API v1beta request bodies) and how the answers are read. Pure:
// no network, no clock (callers pass "today" and the hour in the property's time zone). The events are those the
// website's game pages send (site/themes/vault-squarespace/static/sq/js/vault-play-analytics.js; docs/analytics.md).

// The date range picked on the page, the way Google Analytics' picker offers it: a preset (its labels, in its order)
// or a custom start and end, and whether to compare with the period before. Days are the property's days.
export type PresetKey = 'today' | 'yesterday' | 'this-week' | 'last-7' | 'last-week' | 'last-28' | 'last-30' | 'this-month'
  | 'last-month' | 'last-90' | 'quarter' | 'this-year' | 'last-year';
export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: 'this-week', label: 'This week (Sun – Today)' },
  { key: 'last-7', label: 'Last 7 days' }, { key: 'last-week', label: 'Last week (Sun – Sat)' }, { key: 'last-28', label: 'Last 28 days' },
  { key: 'last-30', label: 'Last 30 days' }, { key: 'this-month', label: 'This month' }, { key: 'last-month', label: 'Last month' },
  { key: 'last-90', label: 'Last 90 days' }, { key: 'quarter', label: 'Quarter to date' }, { key: 'this-year', label: 'This year (Jan – Today)' },
  { key: 'last-year', label: 'Last calendar year' },
];
export const DEFAULT_PRESET: PresetKey = 'last-28';
// The page's first ranges (Day … Year), so links and bookmarks to them still work.
const OLD_RANGES: Record<string, PresetKey> = { day: 'today', week: 'this-week', month: 'this-month', quarter: 'quarter', year: 'this-year' };
// The longest custom range: GA answers longer ones, but a chart of them says little and costs the property's quota.
export const MAX_DAYS = 3 * 366;

// The first day the site sent play events: plays, players and play time before it are 0 because they weren't
// counted, not because no one played.
export const PLAYS_SINCE = '2026-10-04';

export interface Period { start: string; end: string }   // YYYY-MM-DD, inclusive
export interface Selection {
  preset: PresetKey | 'custom';
  label: string;                  // "Last 28 days", "Custom"
  current: Period;
  previous: Period;               // the period it is compared with (asked for only when compare is on)
  compare: boolean;
  vs: string;                     // what the period before is, for "+5% vs …"
  unit: 'hour' | 'day' | 'month'; // the chart's points: a single day by hour, up to 92 days by day, longer by month
  toHour: number;                 // today: compared with yesterday up to this hour; otherwise 23 (whole days)
  today: string;                  // in the property's time zone, when the selection was made
}
// What a view covers. A game: its slug and its page paths on the site (pages.ts). A studio: its slug, its games on the
// site and all their page paths. Neither: the whole site.
export interface Scope { game?: string; studio?: string; games?: string[]; pages?: string[] }

// ---------- dates ----------
const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);   // m from 0; overflow rolls
const monthEnd = (y: number, m: number) => ymd(y, m + 1, 0);
// The same day n months away, or that month's last day when it is shorter (Mar 31 → Feb 28).
function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1, day = Number(d.slice(8, 10));
  const end = monthEnd(y, m + n);
  return Number(end.slice(8, 10)) < day ? end : ymd(y, m + n, day);
}
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && addDays(v, 0) === v;

// The date and hour now in the GA property's time zone (its reports' days are that zone's days).
export function localNow(timeZone: string, now: Date): { today: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

// A preset's days, and what it is compared with. Periods that run to today (this week, month, quarter, year) are
// compared with the same days of the one before; whole calendar periods with the one before; the rest (today,
// yesterday, the last N days, a custom range) with as many days just before.
export function presetPeriods(key: PresetKey, today: string): { current: Period; previous?: Period; vs?: string } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - 1;
  const yesterday = addDays(today, -1);
  const lastDays = (n: number) => ({ current: { start: addDays(today, -n), end: yesterday } });
  const sunday = addDays(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
  switch (key) {
    case 'today': return { current: { start: today, end: today }, previous: { start: yesterday, end: yesterday }, vs: 'yesterday by this hour' };
    case 'yesterday': return { current: { start: yesterday, end: yesterday } };
    case 'this-week': return { current: { start: sunday, end: today }, previous: { start: addDays(sunday, -7), end: addDays(today, -7) }, vs: 'the same days last week' };
    case 'last-week': return { current: { start: addDays(sunday, -7), end: addDays(sunday, -1) }, vs: 'the week before' };
    case 'last-7': return lastDays(7);
    case 'last-28': return lastDays(28);
    case 'last-30': return lastDays(30);
    case 'last-90': return lastDays(90);
    case 'this-month': return { current: { start: ymd(y, m, 1), end: today }, previous: { start: ymd(y, m - 1, 1), end: addMonths(today, -1) }, vs: 'the same days last month' };
    case 'last-month': return { current: { start: ymd(y, m - 1, 1), end: monthEnd(y, m - 1) }, previous: { start: ymd(y, m - 2, 1), end: monthEnd(y, m - 2) }, vs: 'the month before' };
    case 'quarter': {
      const q = m - (m % 3);
      return { current: { start: ymd(y, q, 1), end: today }, previous: { start: ymd(y, q - 3, 1), end: addMonths(today, -3) }, vs: 'the same days last quarter' };
    }
    case 'this-year': return { current: { start: ymd(y, 0, 1), end: today }, previous: { start: ymd(y - 1, 0, 1), end: addMonths(today, -12) }, vs: 'the same days last year' };
    case 'last-year': return { current: { start: ymd(y - 1, 0, 1), end: ymd(y - 1, 11, 31) }, previous: { start: ymd(y - 2, 0, 1), end: ymd(y - 2, 11, 31) }, vs: 'the year before' };
  }
}

// The page's query (?range=PRESET, or ?range=custom&start=…&end=…, and compare=0 to turn comparing off) as a
// Selection. Anything it can't use (an unknown preset, dates out of order, in the future or too far apart) is the
// default, Last 28 days.
export function selectionOf(q: { range?: string; start?: string; end?: string; compare?: string }, today: string, hour: number): Selection {
  const compare = q.compare !== '0';
  const key = q.range && OLD_RANGES[q.range] ? OLD_RANGES[q.range] : q.range;
  let preset: PresetKey | 'custom' = DEFAULT_PRESET;
  let p: { current: Period; previous?: Period; vs?: string } = presetPeriods(DEFAULT_PRESET, today);
  if (PRESETS.some((x) => x.key === key)) { preset = key as PresetKey; p = presetPeriods(preset, today); }
  else if ((key === 'custom' || (!key && (q.start || q.end))) && isDate(q.start) && isDate(q.end) && q.start <= q.end && q.end <= today && daysBetween(q.start, q.end) < MAX_DAYS) {
    preset = 'custom'; p = { current: { start: q.start, end: q.end } };
  }
  const n = daysBetween(p.current.start, p.current.end) + 1;
  const previous = p.previous ?? { start: addDays(p.current.start, -n), end: addDays(p.current.start, -1) };
  const vs = p.vs ?? (n === 1 ? 'the day before' : `the ${n} days before`);
  const label = preset === 'custom' ? 'Custom' : PRESETS.find((x) => x.key === preset)!.label;
  return { preset, label, current: p.current, previous, compare, vs, unit: n === 1 ? 'hour' : n <= 92 ? 'day' : 'month', toHour: p.current.end === today && n === 1 ? hour : 23, today };
}

export const PLAY_EVENTS = ['play_start', 'play_heartbeat', 'play_end'];
// Custom definitions registered in GA (Admin → Custom definitions): event-scoped dimensions game_slug, studio,
// play_mode; event-scoped metric play_seconds; user-scoped dimension vault_game (the realtime report's only way to
// tell games apart). A property without them refuses requests naming them (400) and the pages say so.
export const DIM_GAME = 'customEvent:game_slug';
export const DIM_MODE = 'customEvent:play_mode';
export const MET_SECONDS = 'customEvent:play_seconds';
export const DIM_RT_GAME = 'customUser:vault_game';

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
const hoursTo = (sel: Selection): Expr[] => (sel.toHour >= 23 ? []
  : [inList('hour', Array.from({ length: sel.toHour + 1 }, (_, h) => (h < 10 ? [`0${h}`, String(h)] : [String(h)])).flat())]);
// The period, and the one before it when comparing; named, so each row of the answer says which it is in.
const ranges = (sel: Selection) => [
  { startDate: sel.current.start, endDate: sel.current.end, name: 'current' },
  ...(sel.compare ? [{ startDate: sel.previous.start, endDate: sel.previous.end, name: 'previous' }] : []),
];
const timeDim = (sel: Selection) => ({ name: sel.unit === 'hour' ? 'dateHour' : sel.unit === 'month' ? 'yearMonth' : 'date' });

export type GaRequest = Record<string, unknown>;

// A game (or a studio's games) by its pages when they're known, else by game_slug.
const byGame = (scope: Scope, ...e: Expr[]) => (scope.pages?.length ? all(...e, pathIn(scope.pages)) : withGame(scope, DIM_GAME, ...e));
// Whose sessions and users: the whole site's, or a game's (a studio's games'): visits that showed its page or started
// one of its plays. Standard fields only, so these go back through the Squarespace years.
const visits = (scope: Scope): Expr[] => (scope.game || scope.studio ? [byGame(scope, eventIn(['page_view', 'play_start']))] : []);
const filtered = (e: Expr[]) => (e.length ? { dimensionFilter: all(...e) } : {});

// The chart's sessions and users per hour (one day), day (up to 92) or month, in each period. Users are counted per
// point, so they don't add up to the period's (trafficRequest has those).
export function trafficSeriesRequest(sel: Selection, scope: Scope): GaRequest {
  return { dateRanges: ranges(sel), dimensions: [timeDim(sel)], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }], ...filtered(visits(scope)), limit: 10000 };
}
// The chart's plays (play_start) per point, in each period. A game is its page (play events are sent from it), so no
// custom definitions are needed.
export function playSeriesRequest(sel: Selection, scope: Scope): GaRequest {
  return { dateRanges: ranges(sel), dimensions: [timeDim(sel)], metrics: [{ name: 'eventCount' }], dimensionFilter: byGame(scope, eventIn(['play_start'])), limit: 10000 };
}
// Page views, sessions and users in each period: the website's figures, and the chart's totals for any view.
export function trafficRequest(sel: Selection, scope: Scope = {}): GaRequest {
  return { dateRanges: ranges(sel), metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }], ...filtered([...visits(scope), ...hoursTo(sel)]) };
}

// Plays, timed plays and seconds played, per game, event and mode, in each period.
export function playsRequest(sel: Selection, scope: Scope): GaRequest {
  return {
    dateRanges: ranges(sel),
    dimensions: [{ name: 'eventName' }, { name: DIM_MODE }, { name: DIM_GAME }],
    metrics: [{ name: 'eventCount' }, { name: MET_SECONDS }],
    dimensionFilter: withGame(scope, DIM_GAME, eventIn(PLAY_EVENTS), ...hoursTo(sel)),
    limit: 10000,
  };
}

// Plays without the custom definitions: play_start counts only (a game: on its page).
export function basicPlaysRequest(sel: Selection, scope: Scope = {}): GaRequest {
  return { dateRanges: ranges(sel), dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: byGame(scope, eventIn(['play_start']), ...hoursTo(sel)) };
}

// People who started a play, in each period (users can't be added up across rows, so this is its own report).
export function playersRequest(sel: Selection, scope: Scope): GaRequest {
  return { dateRanges: ranges(sel), metrics: [{ name: 'totalUsers' }], dimensionFilter: byGame(scope, eventIn(['play_start']), ...hoursTo(sel)) };
}

// A game's pages (or a studio's games' pages) in each period: page views, visitors (users of its page_view rows) and
// outbound link clicks from them (enhanced measurement's "click" event, outbound links only: the old site's Play
// button linked out to the game).
export function pagesRequest(sel: Selection, paths: string[]): GaRequest {
  return {
    dateRanges: ranges(sel), dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'eventCount' }],
    dimensionFilter: all(eventIn(['page_view', 'click']), pathIn(paths), ...hoursTo(sel)),
  };
}
// Every game page's views and outbound clicks this period: the site's top games before there are plays by game.
export function topPagesRequest(sel: Selection, paths: string[]): GaRequest {
  return {
    dateRanges: [{ startDate: sel.current.start, endDate: sel.current.end }], dimensions: [{ name: 'pagePath' }, { name: 'eventName' }],
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

// The chart: sessions, plays and users at each point of the period, and of the period before at the same place (the
// first day with the first day, and so on; null past its end, or when not comparing).
export interface Line { current: (number | null)[]; previous: (number | null)[] | null }
export interface Series {
  unit: Selection['unit'];
  labels: string[];              // the x axis, e.g. "Oct 5", "14:00" or "Jan"
  tips: string[];                // each point in full, for its tooltip: "Mon Oct 5", "Oct 5, 14:00", "Oct 1 – 6, 2026"
  prevTips: string[];            // the same for the period before
  sessions: Line;
  users: Line;
  plays: Line | null;            // null: GA couldn't answer; a point before PLAYS_SINCE is null (not counted then)
}
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dayLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
export const longDate = (d: string) => `${dayLabel(d)}, ${d.slice(0, 4)}`;
export const spanLabel = (p: Period) => (p.start === p.end ? longDate(p.start)
  : p.start.slice(0, 4) === p.end.slice(0, 4) ? `${dayLabel(p.start)} – ${longDate(p.end)}` : `${longDate(p.start)} – ${longDate(p.end)}`);
const compact = (d: string) => d.replaceAll('-', '');

// The points of a period: each one's key in the answer (dateHour, date or yearMonth), its days, and labels.
interface Point { key: string; from: string; to: string; hour?: number; label: string; tip: string }
function points(p: Period, unit: Selection['unit']): Point[] {
  if (unit === 'hour') return Array.from({ length: 24 }, (_, h) => {
    const hh = String(h).padStart(2, '0');
    return { key: `${compact(p.start)}${hh}`, from: p.start, to: p.start, hour: h, label: `${hh}:00`, tip: `${dayLabel(p.start)}, ${hh}:00` };
  });
  const out: Point[] = [];
  if (unit === 'day') {
    for (let d = p.start; d <= p.end; d = addDays(d, 1)) out.push({ key: compact(d), from: d, to: d, label: dayLabel(d), tip: `${WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${dayLabel(d)}` });
    return out;
  }
  const oneYear = p.start.slice(0, 4) === p.end.slice(0, 4);
  for (let d = p.start; d <= p.end;) {
    const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1, end = monthEnd(y, m) < p.end ? monthEnd(y, m) : p.end;
    const whole = d.endsWith('-01') && end === monthEnd(y, m);
    out.push({ key: `${y}${String(m + 1).padStart(2, '0')}`, from: d, to: end, label: oneYear ? MONTHS[m] : `${MONTHS[m]} ${String(y).slice(2)}`,
      tip: whole ? `${MONTHS[m]} ${y}` : `${dayLabel(d)} – ${Number(end.slice(8, 10))}, ${y}` });
    d = addDays(end, 1);
  }
  return out;
}

// Reads the chart's two reports (trafficSeriesRequest, playSeriesRequest). today and hour: now, so the hours still to
// come today are left empty.
export function readSeries(traffic: GaResponse, plays: GaResponse | null, sel: Selection, today: string, hour: number): Series {
  const values = (res: GaResponse) => {
    const out = { current: new Map<string, Record<string, number>>(), previous: new Map<string, Record<string, number>>() };
    for (const r of rowsOf(res)) {
      const p = periodOf(r);
      if (!p) continue;
      const k = r.dims.dateHour ?? r.dims.yearMonth ?? r.dims.date ?? '';
      const m = out[p].get(k) ?? {};
      for (const [n, v] of Object.entries(r.mets)) m[n] = (m[n] ?? 0) + v;
      out[p].set(k, m);
    }
    return out;
  };
  const t = values(traffic), pl = plays ? values(plays) : null;
  const cur = points(sel.current, sel.unit), prev = sel.compare ? points(sel.previous, sel.unit) : [];
  const later = (pt: Point) => pt.from > today || (pt.hour !== undefined && pt.from === today && pt.hour > hour);
  const line = (pick: (period: 'current' | 'previous', pt: Point) => number | null): Line => ({
    current: cur.map((pt) => (later(pt) ? null : pick('current', pt))),
    previous: sel.compare ? cur.map((_, i) => (prev[i] ? pick('previous', prev[i]) : null)) : null,
  });
  return {
    unit: sel.unit, labels: cur.map((p) => p.label), tips: cur.map((p) => p.tip), prevTips: cur.map((_, i) => prev[i]?.tip ?? ''),
    sessions: line((period, pt) => t[period].get(pt.key)?.sessions ?? 0),
    users: line((period, pt) => t[period].get(pt.key)?.totalUsers ?? 0),
    plays: pl ? line((period, pt) => (pt.to < PLAYS_SINCE ? null : pl[period].get(pt.key)?.eventCount ?? 0)) : null,
  };
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
