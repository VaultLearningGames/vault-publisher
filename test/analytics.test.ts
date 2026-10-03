import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Analytics, AnalyticsError, classify, httpTransport, TtlCache, type GaMethod } from '../src/analytics/ga.ts';
import { googleTokenSource } from '../src/analytics/google-auth.ts';
import {
  averageSeconds, basicPlaysRequest, localNow, pagesRequest, periods, playersRequest, playsRequest, rangeOf, readPages, readPairs,
  readPlaces, readPlays, readSeries, readTopPages, realtimePlayersRequest, seriesRequest, siteRequest, topPagesRequest,
  type GaRequest, type GaResponse,
} from '../src/analytics/reports.ts';
import { loadLegacy, pagePaths } from '../src/analytics/pages.ts';
import { parseGaPropertyId } from '../src/config.ts';
import { EMPTY_LISTING } from '../src/listings.ts';
import { chart, delta, duration, placesMap, realtimeBody, view } from '../src/portal/analytics.ts';
import { fakeGa } from '../scripts/fake-ga.ts';
import { portalHarness } from './portal-harness.ts';

const TODAY = '2026-10-03';
const res = (dims: string[], mets: string[], rows: [string[], number[]][]): GaResponse => ({
  dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: mets.map((name) => ({ name })),
  rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(v) })) })),
});

describe('periods and requests', () => {
  test('each range is a rolling period ending today, compared with the one just before', () => {
    assert.deepEqual(periods('day', TODAY), { current: { start: TODAY, end: TODAY }, previous: { start: '2026-10-02', end: '2026-10-02' } });
    assert.deepEqual(periods('week', TODAY), { current: { start: '2026-09-27', end: TODAY }, previous: { start: '2026-09-20', end: '2026-09-26' } });
    assert.deepEqual(periods('month', TODAY).previous, { start: '2026-08-05', end: '2026-09-03' });
    assert.deepEqual(periods('quarter', TODAY).current, { start: '2026-07-06', end: TODAY });
    assert.deepEqual(periods('year', TODAY), { current: { start: '2025-10-05', end: TODAY }, previous: { start: '2024-10-06', end: '2025-10-04' } });
    assert.equal(rangeOf('quarter'), 'quarter');
    assert.equal(rangeOf('decade'), 'month');
    assert.equal(rangeOf(undefined), 'month');
  });

  test('today and the hour are the property’s, not the server’s', () => {
    const at = new Date('2026-10-03T03:30:00Z');   // 22:30 the day before in Chicago
    assert.deepEqual(localNow('America/Chicago', at), { today: '2026-10-02', hour: 22 });
    assert.deepEqual(localNow('UTC', at), { today: '2026-10-03', hour: 3 });
  });

  test('the chart asks for play_start and page_view over both periods, by hour for a day; a game by its page', () => {
    assert.deepEqual(seriesRequest('week', TODAY, {}), {
      dateRanges: [{ startDate: '2026-09-20', endDate: TODAY }], dimensions: [{ name: 'date' }, { name: 'eventName' }], metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['play_start', 'page_view'] } } }, limit: 10000,
    });
    const day = seriesRequest('day', TODAY, { game: 'wake', pages: ['/wake', '/wake/'] });
    assert.deepEqual(day.dimensions, [{ name: 'dateHour' }, { name: 'eventName' }]);
    assert.deepEqual(day.dateRanges, [{ startDate: '2026-10-02', endDate: TODAY }]);
    // The page, not game_slug: no custom definitions needed, and the years before the play events have page views.
    assert.deepEqual(day.dimensionFilter, { andGroup: { expressions: [
      { filter: { fieldName: 'eventName', inListFilter: { values: ['play_start', 'page_view'] } } },
      { filter: { fieldName: 'pagePath', inListFilter: { values: ['/wake', '/wake/'] } } },
    ] } });
    assert.match(JSON.stringify(seriesRequest('week', TODAY, { game: 'wake' })), /"customEvent:game_slug".*"value":"wake"/);   // no pages known
  });

  test('a game’s page: its addresses old and new, page views, visitors and outbound clicks, in standard fields only', () => {
    const legacy = loadLegacy();
    assert.deepEqual(pagePaths('wake-tales-from-the-aqualab', legacy), ['/wake', '/wake/', '/game-cards/blog-post-title-one-kma9a', '/game-cards/blog-post-title-one-kma9a/']);
    assert.deepEqual(pagePaths('a-new-game', legacy), ['/a-new-game', '/a-new-game/']);
    assert.deepEqual(pagePaths('x', { x: { path: 'jowilder' } }), ['/jowilder', '/jowilder/']);
    const r = pagesRequest('month', TODAY, ['/wake', '/wake/']);
    assert.deepEqual(r.dateRanges, [{ startDate: '2026-09-04', endDate: TODAY, name: 'current' }, { startDate: '2026-08-05', endDate: '2026-09-03', name: 'previous' }]);
    assert.deepEqual(r.dimensions, [{ name: 'eventName' }]);
    assert.deepEqual(r.metrics, [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'eventCount' }]);
    assert.deepEqual(r.dimensionFilter, { andGroup: { expressions: [
      { filter: { fieldName: 'eventName', inListFilter: { values: ['page_view', 'click'] } } },
      { filter: { fieldName: 'pagePath', inListFilter: { values: ['/wake', '/wake/'] } } },
    ] } });
    const t = topPagesRequest('year', TODAY, ['/wake', '/wake/', '/bloom/', '/wake']);
    assert.deepEqual(t.dateRanges, [{ startDate: '2025-10-05', endDate: TODAY }]);
    assert.deepEqual(t.dimensions, [{ name: 'pagePath' }, { name: 'eventName' }]);
    assert.match(JSON.stringify(t.dimensionFilter), /"pagePath","inListFilter":\{"values":\["\/wake","\/wake\/","\/bloom\/"\]\}/);
    for (const q of [r, t]) assert.doesNotMatch(JSON.stringify(q), /custom/);
  });

  test('plays, players and the site compare two named periods; a game filters on game_slug', () => {
    const p = playsRequest('month', TODAY, { game: 'wake' });
    assert.deepEqual(p.dateRanges, [{ startDate: '2026-09-04', endDate: TODAY, name: 'current' }, { startDate: '2026-08-05', endDate: '2026-09-03', name: 'previous' }]);
    assert.deepEqual(p.dimensions, [{ name: 'eventName' }, { name: 'customEvent:play_mode' }, { name: 'customEvent:game_slug' }]);
    assert.deepEqual(p.metrics, [{ name: 'eventCount' }, { name: 'customEvent:play_seconds' }]);
    assert.match(JSON.stringify(p.dimensionFilter), /"inListFilter":\{"values":\["play_start","play_heartbeat","play_end"\]\}.*"value":"wake"/);
    assert.deepEqual(playersRequest('week', TODAY, {}).metrics, [{ name: 'totalUsers' }]);
    assert.doesNotMatch(JSON.stringify(playersRequest('week', TODAY, {})), /game_slug/);
    assert.deepEqual(siteRequest('year', TODAY).metrics, [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }]);
    assert.doesNotMatch(JSON.stringify(basicPlaysRequest('week', TODAY)), /custom/);
  });

  test('realtime tells games apart by the user property vault_game', () => {
    assert.deepEqual(realtimePlayersRequest({}).dimensions, [{ name: 'countryId' }, { name: 'country' }, { name: 'city' }]);
    // A player is anyone with vault_game set: realtime refuses eventName with activeUsers.
    assert.doesNotMatch(JSON.stringify(realtimePlayersRequest({})), /eventName/);
    assert.match(JSON.stringify(realtimePlayersRequest({})), /"fieldName":"customUser:vault_game","stringFilter":\{"matchType":"FULL_REGEXP","value":"\.\+"\}/);
    assert.doesNotMatch(JSON.stringify(realtimePlayersRequest({ game: 'wake' })), /eventName/);
    assert.match(JSON.stringify(realtimePlayersRequest({ game: 'wake' })), /"fieldName":"customUser:vault_game","stringFilter":\{"matchType":"EXACT","value":"wake"\}/);
    assert.equal(realtimePlayersRequest({}).dateRanges, undefined);
  });
});

describe('reading answers', () => {
  test('a week: one point per day in each period', () => {
    const s = readSeries(res(['date'], ['eventCount'], [[['20261003'], [5]], [['20260927'], [2]], [['20260926'], [7]], [['20260920'], [1]]]), 'week', TODAY, 12);
    assert.equal(s.labels.length, 7);
    assert.equal(s.labels[0], 'Sep 27');
    assert.deepEqual(s.current, [2, 0, 0, 0, 0, 0, 5]);
    assert.deepEqual(s.previous, [1, 0, 0, 0, 0, 0, 7]);
    assert.deepEqual(s.totals, { current: 7, previous: 8 });
  });

  test('a day: hours, with later hours today left empty', () => {
    const s = readSeries(res(['dateHour'], ['eventCount'], [[['2026100309'], [4]], [['2026100223'], [3]]]), 'day', TODAY, 10);
    assert.equal(s.labels[9], '09:00');
    assert.equal(s.current[9], 4);
    assert.equal(s.current[10], 0);
    assert.equal(s.current[11], null);
    assert.equal(s.previous[23], 3);
    assert.deepEqual(s.totals, { current: 4, previous: 3 });
  });

  test('a year: 52 weekly points', () => {
    const s = readSeries(res(['date'], ['eventCount'], [[['20251005'], [1]], [['20251011'], [2]], [['20251012'], [4]], [['20241006'], [9]]]), 'year', TODAY, 0);
    assert.equal(s.labels.length, 52);
    assert.equal(s.labels[0], 'Week of Oct 5');
    assert.deepEqual(s.current.slice(0, 2), [3, 4]);
    assert.equal(s.previous[0], 9);
  });

  test('plays, timed plays and seconds per period and per game', () => {
    const dims = ['eventName', 'customEvent:play_mode', 'customEvent:game_slug', 'dateRange'];
    const p = readPlays(res(dims, ['eventCount', 'customEvent:play_seconds'], [
      [['play_start', 'player', 'wake', 'current'], [10, 0]],
      [['play_start', 'new_tab', 'wake', 'current'], [2, 0]],
      [['play_heartbeat', 'player', 'wake', 'current'], [40, 1200]],
      [['play_end', 'player', 'wake', 'current'], [11, 300]],
      [['play_start', 'player', 'bloom', 'current'], [3, 0]],
      [['play_end', 'player', 'bloom', 'current'], [3, 90]],
      [['play_start', 'player', 'wake', 'previous'], [4, 0]],
      [['play_end', 'player', 'wake', 'previous'], [4, 400]],
      [['play_start', '(not set)', '(not set)', 'current'], [1, 0]],
    ]));
    assert.deepEqual(p.current, { plays: 16, timedPlays: 13, seconds: 1590 });
    assert.deepEqual(p.previous, { plays: 4, timedPlays: 4, seconds: 400 });
    assert.deepEqual(p.games.map((g) => [g.slug, g.plays, g.timedPlays, g.seconds]), [['wake', 12, 10, 1500], ['bloom', 3, 3, 90]]);
    assert.equal(averageSeconds(p.games[0]), 150);
    assert.equal(averageSeconds({ plays: 5, timedPlays: 0, seconds: 0 }), null);   // only new-tab plays: unknown, not 0
    assert.equal(p.timed, true);
  });

  test('the series of page views comes from the same answer as the plays', () => {
    const r = res(['date', 'eventName'], ['eventCount'], [[['20261003', 'play_start'], [2]], [['20261003', 'page_view'], [30]], [['20260920', 'page_view'], [11]]]);
    assert.deepEqual(readSeries(r, 'week', TODAY, 12).totals, { current: 2, previous: 0 });
    assert.deepEqual(readSeries(r, 'week', TODAY, 12, 'page_view').totals, { current: 30, previous: 11 });
  });

  test('a game page’s views, visitors and play clicks; top games by page views', () => {
    const p = readPages(res(['eventName', 'dateRange'], ['screenPageViews', 'totalUsers', 'eventCount'], [
      [['page_view', 'current'], [120, 80, 120]], [['click', 'current'], [0, 20, 31]],
      [['page_view', 'previous'], [90, 70, 90]],
    ]));
    assert.deepEqual(p, { views: { current: 120, previous: 90 }, visitors: { current: 80, previous: 70 }, clicks: { current: 31, previous: 0 } });
    assert.deepEqual(readPages({}), { views: { current: 0, previous: 0 }, visitors: { current: 0, previous: 0 }, clicks: { current: 0, previous: 0 } });
    const top = readTopPages(res(['pagePath', 'eventName'], ['screenPageViews', 'eventCount'], [
      [['/wake', 'page_view'], [50, 50]], [['/wake/', 'page_view'], [25, 25]], [['/wake', 'click'], [0, 9]],
      [['/bloom/', 'page_view'], [100, 100]], [['/about', 'page_view'], [999, 999]],
    ]), { 'wake-tales-from-the-aqualab': ['/wake', '/wake/'], bloom: ['/bloom', '/bloom/'], quiet: ['/quiet', '/quiet/'] });
    assert.deepEqual(top, [{ slug: 'bloom', views: 100, clicks: 0 }, { slug: 'wake-tales-from-the-aqualab', views: 75, clicks: 9 }]);
  });

  test('totals per period, and places', () => {
    assert.deepEqual(readPairs(res(['dateRange'], ['totalUsers'], [[['current'], [9]], [['previous'], [4]]]), ['totalUsers']), { totalUsers: { current: 9, previous: 4 } });
    assert.deepEqual(readPairs(res(['dateRange'], ['totalUsers'], [[['date_range_0'], [9]], [['date_range_1'], [4]]]), ['totalUsers']).totalUsers, { current: 9, previous: 4 });
    assert.deepEqual(readPairs(res([], ['activeUsers'], [[[], [7]]]), ['activeUsers']).activeUsers.current, 7);
    assert.deepEqual(readPlaces(res(['countryId', 'country', 'city'], ['activeUsers'], [[['CA', 'Canada', 'Calgary'], [2]], [['US', 'United States', 'Madison'], [5]], [['FR', 'France', 'Paris'], [0]]])),
      [{ countryId: 'US', country: 'United States', city: 'Madison', users: 5 }, { countryId: 'CA', country: 'Canada', city: 'Calgary', users: 2 }]);
    assert.deepEqual(readPairs({}, ['totalUsers']).totalUsers, { current: 0, previous: 0 });
  });
});

describe('the Google Analytics client', () => {
  test('errors are sorted into what the pages can explain', () => {
    assert.equal(classify(403, { error: { message: 'User does not have sufficient permissions for this property.', status: 'PERMISSION_DENIED' } }).kind, 'denied');
    assert.equal(classify(403, { error: { message: 'Google Analytics Data API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }).kind, 'api_disabled');
    assert.equal(classify(400, { error: { message: 'Field customEvent:game_slug is not a valid dimension.' } }).kind, 'setup');
    assert.equal(classify(401, null).kind, 'not_connected');
    assert.equal(classify(429, { error: { message: 'Exhausted property tokens' } }).kind, 'failed');
  });

  test('requests go to the property as the service account, and failures are classified', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return status === 200 ? Response.json({ rows: [] }) : Response.json({ error: { message: 'User does not have sufficient permissions for this property.' } }, { status });
    }) as typeof fetch;
    const t = httpTransport('123456789', async () => ({ token: 'tok', quotaProject: 'proj' }), f);
    assert.deepEqual(await t('runRealtimeReport', { metrics: [] }), { rows: [] });
    assert.equal(calls[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runRealtimeReport');
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');
    assert.equal((calls[0].init.headers as Record<string, string>)['x-goog-user-project'], 'proj');
    status = 403;
    await assert.rejects(t('runReport', {}), (e: AnalyticsError) => e.kind === 'denied');
    const noCreds = httpTransport('1', async () => { throw new Error('nope'); }, f);
    await assert.rejects(noCreds('runReport', {}), (e: AnalyticsError) => e.kind === 'not_connected');
  });

  test('tokens on Cloud Run come from the metadata server with the Analytics scope, and are reused', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => { urls.push(url); return Response.json({ access_token: `t${urls.length}`, expires_in: 3600 }); }) as typeof fetch;
    const src = googleTokenSource('https://www.googleapis.com/auth/analytics.readonly', { fetch: f, env: { K_SERVICE: 'vault-publisher-staging' } });
    assert.equal((await src()).token, 't1');
    assert.equal((await src()).token, 't1');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^http:\/\/metadata\.google\.internal\/.*\/token\?scopes=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fanalytics\.readonly$/);
    const none = googleTokenSource('x', { fetch: f, env: { CLOUDSDK_CONFIG: '/nonexistent' } });
    await assert.rejects(none(), /no Google credentials/);
  });

  test('answers are cached per request: reports 10 minutes, realtime a minute, failures a minute', async () => {
    let now = 0;
    const c = new TtlCache(() => now);
    let n = 0;
    const load = async () => ({ rows: [{ metricValues: [{ value: String(++n) }] }] });
    await c.get('a', 600_000, load); await c.get('a', 600_000, load);
    assert.equal(n, 1);
    now = 599_999; await c.get('a', 600_000, load); assert.equal(n, 1);
    now = 600_000; await c.get('a', 600_000, load); assert.equal(n, 2);
    let fails = 0;
    const bad = async (): Promise<GaResponse> => { fails++; throw new Error('x'); };
    await assert.rejects(c.get('b', 600_000, bad));
    now += 59_000; await assert.rejects(c.get('b', 600_000, bad)); assert.equal(fails, 1);
    now += 2_000; await assert.rejects(c.get('b', 600_000, bad)); assert.equal(fails, 2);
  });

  test('a page view asks once; the next within the cache time asks nothing', async () => {
    const log: { method: GaMethod; body: GaRequest }[] = [];
    let now = Date.parse('2026-10-03T17:00:00Z');
    const a = new Analytics({ transport: fakeGa(['wake', 'bloom'], { log }), now: () => new Date(now) });
    const ov = await a.overview('week', {});
    assert.equal(log.length, 4);   // series, plays, players, site
    assert.ok(ov.series.ok && ov.plays.ok && ov.players.ok && ov.site?.ok);
    await a.overview('week', {});
    assert.equal(log.length, 4);
    await a.realtime({}); await a.realtime({});
    assert.equal(log.length, 7);   // people by place, the total, and how many are playing
    now += 61_000;
    await a.realtime({});
    assert.equal(log.length, 10);
    await a.overview('week', { game: 'wake', pages: ['/wake', '/wake/'] });
    assert.equal(log.length, 14);  // no site report for a game; its page's report instead
  });

  test('before any play events: the chart and the top games fall back to page views', async () => {
    const log: { method: GaMethod; body: GaRequest }[] = [];
    const a = new Analytics({ transport: fakeGa(['wake', 'bloom'], { log, plays: false }), now: () => new Date('2026-10-03T17:00:00Z') });
    const catalog = { wake: ['/wake', '/wake/'], bloom: ['/bloom', '/bloom/'] };
    const ov = await a.overview('year', {}, catalog);
    assert.ok(ov.series.ok && ov.series.value.totals.current === 0);
    assert.ok(ov.views.ok && ov.views.value.totals.current > 0);
    assert.ok(ov.topPages?.ok && ov.topPages.value.map((g) => g.slug).sort().join() === 'bloom,wake');
    assert.equal(log.length, 5);   // series, plays, players, site, then top pages because no game had plays
    const page = String(view(ov, { places: { ok: true, value: [] }, visitors: null, who: 'players' }, {
      timeZone: 'America/Chicago', scope: {}, range: 'year', staff: true, base: '/vault/analytics', realtimeUrl: '/rt', assets: { css: '', js: '', land: '' },
      titleOf: (slug) => ({ title: slug.toUpperCase(), href: null }),
    }));
    assert.match(page, /Page views <small>Last 52 weeks/);
    assert.match(page, /No plays recorded in this range/);
    assert.match(page, /Top games <small>by page views, last 52 weeks/);
    assert.match(page, /<b>WAKE<\/b>/);
    assert.match(page, /Play-button clicks/);
    const game = await a.overview('year', { game: 'wake', pages: catalog.wake }, catalog);
    assert.ok(game.pages?.ok && game.pages.value.views.current > 0 && game.pages.value.clicks.current > 0);
    const gp = String(view(game, { places: { ok: true, value: [] }, visitors: null, who: 'players' }, {
      timeZone: 'America/Chicago', scope: { game: 'wake', pages: catalog.wake }, range: 'year', staff: false, base: '/s/x/g/wake?tab=analytics', realtimeUrl: '/rt', assets: { css: '', js: '', land: '' },
      titleOf: (slug) => ({ title: slug, href: null }),
    }));
    assert.match(gp, /Page views <small>Last 52 weeks/);
    assert.match(gp, /The game’s page/);
    assert.match(gp, /Visitors/);
    assert.match(gp, /Play-button clicks/);
    assert.match(gp, /outbound clicks from the game’s page/);
  });

  test('a property without click events: play clicks are just 0', async () => {
    const t = async (_m: GaMethod, body: GaRequest): Promise<GaResponse> =>
      (JSON.stringify(body).includes('"click"') ? res(['eventName', 'dateRange'], ['screenPageViews', 'totalUsers', 'eventCount'], [[['page_view', 'current'], [5, 3, 5]]]) : {});
    const ov = await new Analytics({ transport: t }).overview('week', { game: 'wake', pages: ['/wake', '/wake/'] });
    assert.ok(ov.pages?.ok);
    assert.deepEqual(ov.pages.value.clicks, { current: 0, previous: 0 });
  });

  test('not connected without a property id; the site falls back to plain counts before the custom definitions exist', async () => {
    const off = await new Analytics({}).overview('week', {});
    assert.ok(!off.series.ok && off.series.error.kind === 'not_connected');
    const t = async (_m: GaMethod, body: GaRequest): Promise<GaResponse> => {
      if (JSON.stringify(body).includes('custom')) throw new AnalyticsError('setup', 'Field customEvent:play_mode is not a valid dimension.');
      return res(['eventName', 'dateRange'], ['eventCount'], [[['play_start', 'current'], [8]], [['play_start', 'previous'], [5]]]);
    };
    const site = await new Analytics({ transport: t }).overview('week', {});
    assert.ok(site.plays.ok);
    assert.equal(site.plays.value.timed, false);
    assert.deepEqual(site.plays.value.current, { plays: 8, timedPlays: 0, seconds: 0 });
    const game = await new Analytics({ transport: t }).overview('week', { game: 'wake' });
    assert.ok(!game.plays.ok && game.plays.error.kind === 'setup');
    // A game whose pages are known is counted on them: no custom definitions needed.
    const byPage = await new Analytics({ transport: t }).overview('week', { game: 'wake', pages: ['/wake', '/wake/'] });
    assert.ok(byPage.plays.ok && byPage.plays.value.current.plays === 8 && byPage.players.ok);
    assert.match(JSON.stringify(playersRequest('week', TODAY, { game: 'wake', pages: ['/wake'] })), /"pagePath","inListFilter":\{"values":\["\/wake"\]/);
  });

  test('the site’s realtime map is everyone on the site, playing or browsing; a game’s is its players', async () => {
    let registered = false;
    const t = async (_m: GaMethod, body: GaRequest): Promise<GaResponse> => {
      if (JSON.stringify(body).includes('custom')) {
        if (!registered) throw new AnalyticsError('setup', 'Field customUser:vault_game is not a valid dimension.');
        return res(['countryId', 'country', 'city'], ['activeUsers'], [[['US', 'United States', 'Madison'], [1]]]);
      }
      return body.dimensions ? res(['countryId', 'country', 'city'], ['activeUsers'], [[['US', 'United States', 'Madison'], [3]]]) : res([], ['activeUsers'], [[[], [4]]]);
    };
    const rt = await new Analytics({ transport: t }).realtime({});
    assert.equal(rt.who, 'visitors');
    assert.ok(rt.places.ok && rt.places.value[0].users === 3);
    const body = String(realtimeBody(rt, { staff: false, land: '/land.svg', game: false }));
    assert.match(body, /<b>4<\/b> people on the site in the last 30 minutes/);
    assert.match(body, /<th class="r">On the site<\/th>/);
    assert.doesNotMatch(body, /couldn’t answer|playing a game/);
    const game = await new Analytics({ transport: t }).realtime({ game: 'wake' });
    assert.ok(!game.places.ok && game.places.error.kind === 'setup');
    registered = true;
    const now = await new Analytics({ transport: t }).realtime({});
    assert.ok(now.who === 'visitors' && now.places.ok && now.places.value[0].users === 3);
    assert.match(String(realtimeBody(now, { staff: false, land: '/land.svg', game: false })), /<b>4<\/b> people on the site in the last 30 minutes\.\s*<span class="muted">1 playing a game\.<\/span>/);
    const g = await new Analytics({ transport: t }).realtime({ game: 'wake' });
    assert.ok(g.who === 'players' && g.places.ok && g.places.value[0].users === 1);
  });

  test('the map has a dot per city, at its country when the city isn’t known', () => {
    const svg = String(placesMap([
      { countryId: 'US', country: 'United States', city: 'Madison', users: 4 },
      { countryId: 'US', country: 'United States', city: 'Chicago', users: 1 },
      { countryId: 'DE', country: 'Germany', city: 'Cologne', users: 2 },
      { countryId: 'FR', country: 'France', city: 'Nowheresville', users: 1 },
    ], '/land.svg', 'People on the site'));
    assert.equal(svg.match(/<circle /g)?.length, 4);
    assert.match(svg, /<circle cx="251.7" cy="116.4" r="12.0"[^>]*><title>Madison, United States: 4 on the site<\/title>/);
    assert.match(svg, /cx="519.3" cy="94.6"[^>]*><title>Cologne, Germany: 2/);
    assert.match(svg, /<title>Nowheresville, France: 1 on the site<\/title>/);
    assert.match(svg, /aria-label="People on the site in the last 30 minutes, by country: United States 5, Germany 2, France 1"/);
  });

  test('GA_PROPERTY_ID is the numeric property id', () => {
    assert.equal(parseGaPropertyId('123456789'), '123456789');
    assert.equal(parseGaPropertyId(' properties/123456789 '), '123456789');
    assert.equal(parseGaPropertyId('G-1KJ4W2B81F'), undefined);
    assert.equal(parseGaPropertyId(''), undefined);
  });
});

describe('formatting', () => {
  test('durations, changes and the chart', () => {
    assert.equal(duration(null), '—');
    assert.equal(duration(42.4), '42s');
    assert.equal(duration(312), '5m 12s');
    assert.equal(duration(3725), '1h 02m');
    assert.match(String(delta(12, 10, 'week')), /class="d up">\+20% vs the 7 days before/);
    assert.match(String(delta(19, 20, 'day')), /class="d down">-5\.0% vs yesterday/);
    assert.match(String(delta(20, 20, 'day')), /no change vs yesterday/);
    assert.match(String(delta(3, 0, 'week')), /new; none the 7 days before/);
    const svg = String(chart(readSeries(res(['dateHour'], ['eventCount'], [[['2026100301'], [4]]]), 'day', TODAY, 2)));
    assert.match(svg, /<path class="ga-cur" d="M0\.5 100L1\.5 0L2\.5 100"/);   // stops at the current hour
    assert.match(svg, /<title>05:00: later today \(yesterday: 0\)<\/title>/);
  });
});

describe('portal pages', () => {
  function setup(analytics?: Analytics) {
    const h = portalHarness(analytics ? { analytics } : {});
    const fd = h.db.studioBySlug('fieldday')!, uc = h.db.studioBySlug('ucalgary')!;
    for (const [s, slug, title] of [[fd, 'wake', 'Wake'], [uc, 'transformations-quest', 'Transformations Quest']] as const) {
      const l = h.db.createListing(s.id, slug, { ...EMPTY_LISTING, title, play_url: `https://${slug}.test/` }, 'test');
      h.db.publishListing(l.id, 'test');
    }
    return h;
  }
  const fake = () => new Analytics({ transport: fakeGa(['wake', 'transformations-quest']) });

  test('Vault → Analytics is Vault staff’s: the whole site', async () => {
    const h = setup(fake());
    const page = await (await h.as('rm', 'release_manager').get('/vault/analytics?range=quarter')).text();
    assert.match(page, /<h1>Analytics<\/h1>/);
    assert.match(page, /href="\/vault\/analytics\?range=quarter" class="on"/);
    assert.match(page, /Last 90 days/);
    assert.match(page, /Unique players/);
    assert.match(page, /Average play time/);
    assert.match(page, /Page views/);
    assert.match(page, /Top games/);
    assert.match(page, /href="\/s\/ucalgary\/g\/transformations-quest\?tab=analytics"><b>Transformations Quest<\/b>/);
    assert.match(page, /Top games <small>by plays/);
    assert.match(page, /<circle cx=/);
    assert.match(page, /href="\/vault\/analytics" class="on">Analytics/);
    assert.equal((await h.as('mia', 'none', 'maintainer').get('/vault/analytics')).status, 403);
    assert.equal((await h.app.request('/vault/analytics')).status, 302);
  });

  test('a game’s Analytics tab: its own studio and Vault staff only', async () => {
    const h = setup(fake());
    const mine = await (await h.as('mia', 'none', 'viewer').get('/s/fieldday/g/wake?tab=analytics&range=day')).text();
    assert.match(mine, /class="on">Analytics<\/a>/);
    assert.match(mine, /Today/);
    assert.match(mine, /data-realtime="\/portal\/analytics\/realtime\?game=wake"/);
    assert.doesNotMatch(mine, /Top games|Sessions/);
    assert.match(mine, /The game’s page/);
    assert.match(mine, /Play-button clicks/);
    assert.equal((await h.as('mia', 'none', 'viewer').get('/s/ucalgary/g/transformations-quest?tab=analytics')).status, 404);
    assert.equal((await h.as('rm', 'release_manager').get('/s/ucalgary/g/transformations-quest?tab=analytics')).status, 200);
    // The realtime card refresh follows the same rule.
    assert.equal((await h.as('mia', 'none', 'viewer').get('/portal/analytics/realtime?game=wake')).status, 200);
    assert.equal((await h.as('mia', 'none', 'viewer').get('/portal/analytics/realtime?game=transformations-quest')).status, 404);
    assert.equal((await h.as('mia', 'none', 'viewer').get('/portal/analytics/realtime')).status, 403);
    assert.match(await (await h.as('rm', 'release_manager').get('/portal/analytics/realtime')).text(), /on the site/);
  });

  test('not connected: one plain message instead of empty charts', async () => {
    const h = setup();
    const page = await (await h.as('rm', 'release_manager').get('/vault/analytics')).text();
    assert.match(page, /Analytics isn’t connected/);
    assert.match(page, /GA_PROPERTY_ID is not set/);   // the detail, for Vault staff
    assert.doesNotMatch(page, /ga-chart/);
    const studio = await (await h.as('mia', 'none', 'viewer').get('/s/fieldday/g/wake?tab=analytics')).text();
    assert.match(studio, /Analytics isn’t connected/);
    assert.doesNotMatch(studio, /GA_PROPERTY_ID/);
    const denied = setup(new Analytics({ transport: async () => { throw new AnalyticsError('denied', 'User does not have sufficient permissions for this property.'); } }));
    assert.match(await (await denied.as('rm', 'release_manager').get('/vault/analytics')).text(), /service account doesn’t have access/);
  });

  test('assets are served with content hashes', async () => {
    const h = setup(fake());
    const page = await (await h.as('rm', 'release_manager').get('/vault/analytics')).text();
    for (const a of ['analytics.css', 'analytics.js', 'world-map.svg']) {
      const url = page.match(new RegExp(`/assets/${a.replace('.', '\\.')}\\?v=[0-9a-f]{10}`))?.[0];
      assert.ok(url, a);
      const r = await h.app.request(url!);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('cache-control')!, /immutable/);
    }
  });
});
