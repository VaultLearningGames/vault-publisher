// Reading Google Analytics 4 for the portal's analytics pages: the Data API v1beta (runReport, runRealtimeReport) on
// the property GA_PROPERTY_ID, as the portal's own Google identity (google-auth.ts), with answers cached (reports 10
// minutes, realtime 60 seconds) so page views don't spend the property's quota. Every failure becomes an
// AnalyticsError whose kind the pages explain: not connected, no access, a definition not registered yet, or other.
import { googleTokenSource, NoCredentialsError, type TokenSource } from './google-auth.ts';
import {
  averageSeconds, basicPlaysRequest, blogReadsSeriesRequest, blogRequest, blogTotalsRequest, localNow, pagesRequest, playersRequest, playSeriesRequest, playsRequest, readBasicPlays, readBlog, readPages, readPairs, readPlaces,
  readPlays, readReads, readRealtimeGames, readRealtimePosts, readSeries, readShares, readTopPages, realtimeGamePlaysRequest, realtimeGamesRequest, realtimePlayersRequest, realtimeScreensRequest, realtimeStudioRequest, realtimeVisitorPlacesRequest, realtimeVisitorsRequest,
  selectionOf, sharesRequest, topPagesRequest, trafficRequest, trafficSeriesRequest, type BlogStats, type GamePages, type GaRequest, type LiveItem, type GaResponse, type Line, type PageStats, type Pair,
  type Place, type PlayStats, type Scope, type Selection, type Series, type ShareStats,
} from './reports.ts';
export { blogRequest, blogTotalsRequest, readBlog, readShares, sharesRequest, type BlogStats, type ShareStats } from './reports.ts';

export type GaMethod = 'runReport' | 'runRealtimeReport';
// Sends one request to the property and answers its JSON. Injected in tests and for local screenshots.
export type GaTransport = (method: GaMethod, body: GaRequest) => Promise<GaResponse>;

export type ErrorKind = 'not_connected' | 'denied' | 'api_disabled' | 'setup' | 'failed';
export class AnalyticsError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) { super(message); this.kind = kind; }
}

export const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const API = 'https://analyticsdata.googleapis.com/v1beta';

// The Data API's error answer, as an AnalyticsError.
export function classify(status: number, body: { error?: { message?: string; status?: string; details?: { reason?: string }[] } } | null): AnalyticsError {
  const msg = body?.error?.message ?? `HTTP ${status}`;
  const reasons = (body?.error?.details ?? []).map((d) => d.reason ?? '');
  if (reasons.includes('SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(msg)) return new AnalyticsError('api_disabled', msg);
  if (status === 401) return new AnalyticsError('not_connected', msg);
  if (status === 403) return new AnalyticsError('denied', msg);
  if (status === 400 && /custom(Event|User):|not a valid (dimension|metric)/i.test(msg)) return new AnalyticsError('setup', msg);
  if (status === 404) return new AnalyticsError('denied', msg);   // no such property, or not visible to this identity
  return new AnalyticsError('failed', msg);
}

export function httpTransport(propertyId: string, tokens: TokenSource, f: typeof fetch = fetch): GaTransport {
  return async (method, body) => {
    let tok;
    try { tok = await tokens(); } catch (err) {
      throw new AnalyticsError('not_connected', err instanceof NoCredentialsError ? err.message : `Google credentials: ${(err as Error).message}`);
    }
    const res = await f(`${API}/properties/${encodeURIComponent(propertyId)}:${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json', ...(tok.quotaProject ? { 'x-goog-user-project': tok.quotaProject } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((err: Error) => { throw new AnalyticsError('failed', `Google Analytics didn't answer: ${err.message}`); });
    if (!res.ok) throw classify(res.status, await res.json().catch(() => null));
    return (await res.json()) as GaResponse;
  };
}

// A cache of answers by request, with how long each kind is kept. Failures are kept for a minute, so a broken
// connection isn't retried on every page view; concurrent identical requests share one call.
export class TtlCache {
  private entries = new Map<string, { at: number; ttl: number; value: Promise<GaResponse> }>();
  private now: () => number;
  private max: number;
  constructor(now: () => number = Date.now, max = 300) { this.now = now; this.max = max; }
  get(key: string, ttlMs: number, load: () => Promise<GaResponse>): Promise<GaResponse> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < hit.ttl) return hit.value;
    const value = load();
    const entry = { at: t, ttl: ttlMs, value };
    this.entries.set(key, entry);
    value.catch(() => { if (this.entries.get(key) === entry) entry.ttl = Math.min(ttlMs, 60_000); });
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
  get size() { return this.entries.size; }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AnalyticsError };
const settle = <T>(p: Promise<T>): Promise<Result<T>> => p.then((value) => ({ ok: true as const, value }), (e: unknown) => ({
  ok: false as const, error: e instanceof AnalyticsError ? e : new AnalyticsError('failed', (e as Error)?.message ?? String(e)),
}));

export type Traffic = Record<'screenPageViews' | 'sessions' | 'totalUsers', Pair>;
// The view's top row of figures (src/portal/analytics.ts draws it above the plot): the website's and the plays'
// combined. Each is null when the view can't have it (a studio's or a game's: the website's and the blog's), when
// there was none, or when Google Analytics didn't answer.
export interface Headline {
  uniqueUsers: number | null;          // the site's visitors (browsers) in the period
  plays: number | null;
  pagesPerUser: number | null;         // the site's page views, per visitor (null with no visitors)
  blogReads: number | null;            // the site's blog posts opened
  avgPlaytimeSeconds: number | null;   // per timed play; null with none
}
export interface Overview {
  sel: Selection;
  series: Result<Series>;        // the chart: plays and users (sessions kept for its data, not drawn)
  traffic: Result<Traffic>;      // the view's page views, sessions and users in each period (the site: the website's figures)
  plays: Result<PlayStats>;
  players: Result<Pair>;
  pages: Result<PageStats> | null;          // a game's (or a studio's games') pages, when known
  topPages: Result<GamePages[]> | null;     // the site or a studio, when no game has plays (before the custom definitions)
  reads: Result<Line> | null;               // the site's blog reads per point (the row's Blog Reads, the chart's line); null: a studio's or a game's
  headline: Headline;                       // the top row's figures, for the range
}
// who: whose places these are: 'visitors' (everyone on the site, the site view) or 'players' (a game's or a studio's).
// The live panel: the games being played (and their plays: its own result, so failing alone leaves dashes) and, the
// site view only, the blog posts being read (null: not asked for).
export interface Live { games: Result<LiveItem[]>; plays: Result<null>; blogs: Result<LiveItem[]> | null }
export interface Realtime { places: Result<Place[]>; visitors: Result<number> | null; who: 'players' | 'visitors'; playing?: Result<number> }

export interface AnalyticsOptions {
  propertyId?: string;
  timeZone?: string;
  transport?: GaTransport;
  now?: () => Date;
  reportTtlMs?: number;
  realtimeTtlMs?: number;
}

export class Analytics {
  readonly connected: boolean;
  private transport: GaTransport | null;
  private cache: TtlCache;
  private now: () => Date;
  readonly timeZone: string;
  private reportTtl: number;
  private realtimeTtl: number;

  constructor(o: AnalyticsOptions) {
    this.now = o.now ?? (() => new Date());
    this.cache = new TtlCache(() => this.now().getTime());
    this.timeZone = o.timeZone || 'America/Chicago';
    this.transport = o.transport ?? (o.propertyId ? httpTransport(o.propertyId, googleTokenSource(SCOPE)) : null);
    this.connected = !!this.transport;
    this.reportTtl = o.reportTtlMs ?? 10 * 60_000;
    this.realtimeTtl = o.realtimeTtlMs ?? 60_000;
  }

  private call(method: GaMethod, body: GaRequest): Promise<GaResponse> {
    const t = this.transport;
    if (!t) return Promise.reject(new AnalyticsError('not_connected', 'GA_PROPERTY_ID is not set'));
    return this.cache.get(`${method} ${JSON.stringify(body)}`, method === 'runRealtimeReport' ? this.realtimeTtl : this.reportTtl, () => t(method, body));
  }

  // The date range picked on the page (?range=…&start=…&end=…&compare=…), with "today" in the property's time zone.
  selection(q: Parameters<typeof selectionOf>[0]): Selection {
    const { today, hour } = localNow(this.timeZone, this.now());
    return selectionOf(q, today, hour);
  }

  // catalog: every game's page paths (pages.ts) in the view (the site's, or the studio's), for its top games by page views.
  async overview(sel: Selection, scope: Scope, catalog: Record<string, string[]> = {}): Promise<Overview> {
    const { today, hour } = localNow(this.timeZone, this.now());
    const plays = this.call('runReport', playsRequest(sel, scope)).then(readPlays).catch((err: unknown) => {
      // Before the custom definitions exist the site, and a game by its pages, still have play counts (but no lengths,
      // and no games).
      if (err instanceof AnalyticsError && err.kind === 'setup' && (!scope.game || scope.pages?.length)) return this.call('runReport', basicPlaysRequest(sel, scope)).then(readBasicPlays);
      throw err;
    });
    const paths = Object.values(catalog).flat();
    // The site's (or the studio's) top games by page views, asked for only when no game has plays.
    const top = scope.game || !paths.length ? null
      : plays.then((p) => p.games.length, () => 0).then((n) => (n ? null : settle(this.call('runReport', topPagesRequest(sel, paths)).then((r) => readTopPages(r, catalog)))));
    // The chart: without the plays line if only that report fails.
    const playLine = this.call('runReport', playSeriesRequest(sel, scope)).catch(() => null);
    const series = this.call('runReport', trafficSeriesRequest(sel, scope)).then(async (r) => readSeries(r, await playLine, sel, today, hour));
    // The site's blog reads per point: the row's Blog Reads and the chart's line. Site-wide, so a studio's or a
    // game's view never asks for them.
    const site = !scope.game && !scope.studio;
    const reads = site ? settle(this.call('runReport', blogReadsSeriesRequest(sel)).then((r) => readReads(r, sel, today, hour))) : null;
    const [chart, traffic, playStats, players, pages, topPages, readsRes] = await Promise.all([
      settle(series),
      settle(this.call('runReport', trafficRequest(sel, scope)).then((r) => readPairs(r, ['screenPageViews', 'sessions', 'totalUsers']) as Traffic)),
      settle(plays),
      settle(this.call('runReport', playersRequest(sel, scope)).then((r) => readPairs(r, ['totalUsers']).totalUsers)),
      (scope.game || scope.studio) && scope.pages?.length ? settle(this.call('runReport', pagesRequest(sel, scope.pages)).then(readPages)) : null,
      top,
      reads,
    ]);
    const sum = (vals: (number | null)[] | null | undefined) => (vals ?? []).reduce<number>((t, v) => t + (v ?? 0), 0);
    const t = traffic.ok ? traffic.value : null, ps = playStats.ok ? playStats.value : null;
    return {
      sel, series: chart, traffic, plays: playStats, players, pages, topPages, reads: readsRes,
      headline: {
        uniqueUsers: site && t ? t.totalUsers.current : null,
        plays: ps ? ps.current.plays : null,
        pagesPerUser: site && t && t.totalUsers.current > 0 ? t.screenPageViews.current / t.totalUsers.current : null,
        blogReads: readsRes?.ok ? sum(readsRes.value.current) : null,
        avgPlaytimeSeconds: ps ? averageSeconds(ps.current) : null,
      },
    };
  }

  // The blog: its opens, readers and time on screen in each period, and per post (Vault → Analytics only).
  async blog(sel: Selection): Promise<Result<BlogStats>> {
    return settle(Promise.all([this.call('runReport', blogRequest(sel)), this.call('runReport', blogTotalsRequest(sel))]).then(([p, t]) => readBlog(p, t)));
  }
  // The chart's blog reads (opens of a post) per point, in each period: site-wide, so the site view's only.
  async blogReads(sel: Selection): Promise<Result<Line>> {
    const { today, hour } = localNow(this.timeZone, this.now());
    return settle(this.call('runReport', blogReadsSeriesRequest(sel)).then((r) => readReads(r, sel, today, hour)));
  }
  // The blog's share-button clicks (share_click), by post and network. Its own result: before the custom dimensions
  // network and post_slug are registered it fails ('setup') while the blog's other figures still show.
  async blogShares(sel: Selection): Promise<Result<ShareStats>> {
    return settle(this.call('runReport', sharesRequest(sel)).then(readShares));
  }

  // The site: everyone on it (playing or browsing) by place, and how many of them are playing. A game: its players. A
  // studio: the players of its games (none on the site: no one, without asking).
  async realtime(scope: Scope): Promise<Realtime> {
    if (scope.studio) {
      const games = scope.games ?? [];
      return { places: games.length ? await settle(this.call('runRealtimeReport', realtimeStudioRequest(games)).then(readPlaces)) : { ok: true, value: [] }, visitors: null, who: 'players' };
    }
    if (scope.game) {
      return { places: await settle(this.call('runRealtimeReport', realtimePlayersRequest(scope)).then(readPlaces)), visitors: null, who: 'players' };
    }
    const [places, visitors, playing] = await Promise.all([
      settle(this.call('runRealtimeReport', realtimeVisitorPlacesRequest()).then(readPlaces)),
      settle(this.call('runRealtimeReport', realtimeVisitorsRequest()).then((r) => readPairs(r, ['activeUsers']).activeUsers.current)),
      settle(this.call('runRealtimeReport', realtimePlayersRequest(scope)).then((r) => readPlaces(r).reduce((n, p) => n + p.users, 0))),
    ]);
    return { places, visitors, who: 'visitors', playing };
  }

  // What is being played and read now (the live panel under the map). games: a studio's games (none on the site: no
  // one, without asking), or null for every game. titles: the blog's posts' titles by slug, when the blog is shown.
  async live(games: string[] | null, window: number, titles: Promise<Map<string, string>> | null): Promise<Live> {
    if (games && !games.length) return { games: { ok: true, value: [] }, plays: { ok: true, value: null }, blogs: titles && { ok: true, value: [] } };
    const plays = this.call('runRealtimeReport', realtimeGamePlaysRequest(games, window));
    const [users, playsRes, blogs] = await Promise.all([
      settle(this.call('runRealtimeReport', realtimeGamesRequest(games, window))),
      settle(plays),
      titles ? settle(Promise.all([this.call('runRealtimeReport', realtimeScreensRequest(window)), titles]).then(([r, t]) => readRealtimePosts(r, t))) : null,
    ]);
    return {
      games: users.ok ? { ok: true, value: readRealtimeGames(users.value, playsRes.ok ? playsRes.value : null) } : users,
      plays: playsRes.ok ? { ok: true, value: null } : playsRes,
      blogs,
    };
  }
}
