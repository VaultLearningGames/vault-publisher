// Reading Google Analytics 4 for the portal's analytics pages: the Data API v1beta (runReport, runRealtimeReport) on
// the property GA_PROPERTY_ID, as the portal's own Google identity (google-auth.ts), with answers cached (reports 10
// minutes, realtime 60 seconds) so page views don't spend the property's quota. Every failure becomes an
// AnalyticsError whose kind the pages explain: not connected, no access, a definition not registered yet, or other.
import { googleTokenSource, NoCredentialsError, type TokenSource } from './google-auth.ts';
import {
  basicPlaysRequest, localNow, pagesRequest, periods, playersRequest, playsRequest, readBasicPlays, readPages, readPairs, readPlaces,
  readPlays, readSeries, readTopPages, realtimePlayersRequest, realtimeVisitorPlacesRequest, realtimeVisitorsRequest, seriesRequest,
  siteRequest, topPagesRequest, type GamePages, type GaRequest, type GaResponse, type PageStats, type Pair, type Period, type Place,
  type PlayStats, type RangeKey, type Scope, type Series,
} from './reports.ts';

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

export interface Overview {
  range: RangeKey;
  periods: { current: Period; previous: Period };
  series: Result<Series>;
  views: Result<Series>;         // page views (of the game's page), from the same report as series
  plays: Result<PlayStats>;
  players: Result<Pair>;
  site: Result<Record<'screenPageViews' | 'sessions' | 'totalUsers', Pair>> | null;   // whole site only
  pages: Result<PageStats> | null;          // a game with known pages only
  topPages: Result<GamePages[]> | null;     // whole site only, when no game has plays (before the custom definitions)
}
// who: whose places these are; 'visitors' (everyone on the site) when the site can't yet tell players apart.
export interface Realtime { places: Result<Place[]>; visitors: Result<number> | null; who: 'players' | 'visitors' }

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

  // catalog: every game's page paths (pages.ts), for the site's top games by page views.
  async overview(range: RangeKey, scope: Scope, catalog: Record<string, string[]> = {}): Promise<Overview> {
    const { today, hour } = localNow(this.timeZone, this.now());
    const series = this.call('runReport', seriesRequest(range, today, scope));
    const plays = this.call('runReport', playsRequest(range, today, scope)).then(readPlays).catch((err: unknown) => {
      // Before the custom definitions exist the site, and a game by its pages, still have play counts (but no lengths,
      // and no games).
      if (err instanceof AnalyticsError && err.kind === 'setup' && (!scope.game || scope.pages?.length)) return this.call('runReport', basicPlaysRequest(range, today, scope)).then(readBasicPlays);
      throw err;
    });
    const paths = Object.values(catalog).flat();
    // The site's top games by page views, asked for only when no game has plays.
    const top = scope.game || !paths.length ? null
      : plays.then((p) => p.games.length, () => 0).then((n) => (n ? null : settle(this.call('runReport', topPagesRequest(range, today, paths)).then((r) => readTopPages(r, catalog)))));
    const [plainSeries, views, playStats, players, site, pages, topPages] = await Promise.all([
      settle(series.then((r) => readSeries(r, range, today, hour))),
      settle(series.then((r) => readSeries(r, range, today, hour, 'page_view'))),
      settle(plays),
      settle(this.call('runReport', playersRequest(range, today, scope)).then((r) => readPairs(r, ['totalUsers']).totalUsers)),
      scope.game ? null : settle(this.call('runReport', siteRequest(range, today)).then((r) => readPairs(r, ['screenPageViews', 'sessions', 'totalUsers']))),
      scope.game && scope.pages?.length ? settle(this.call('runReport', pagesRequest(range, today, scope.pages)).then(readPages)) : null,
      top,
    ]);
    return { range, periods: periods(range, today), series: plainSeries, views, plays: playStats, players, site, pages, topPages };
  }

  async realtime(scope: Scope): Promise<Realtime> {
    let who: Realtime['who'] = 'players';
    const players = this.call('runRealtimeReport', realtimePlayersRequest(scope)).then(readPlaces).catch((err: unknown) => {
      if (err instanceof AnalyticsError && err.kind === 'setup' && !scope.game) {
        who = 'visitors';
        return this.call('runRealtimeReport', realtimeVisitorPlacesRequest()).then(readPlaces);
      }
      throw err;
    });
    const [places, visitors] = await Promise.all([
      settle(players),
      scope.game ? null : settle(this.call('runRealtimeReport', realtimeVisitorsRequest()).then((r) => readPairs(r, ['activeUsers']).activeUsers.current)),
    ]);
    return { places, visitors, who };
  }
}
