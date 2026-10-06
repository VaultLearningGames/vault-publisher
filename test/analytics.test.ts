import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Analytics, AnalyticsError, classify, httpTransport, TtlCache, type GaMethod } from '../src/analytics/ga.ts';
import { googleTokenSource } from '../src/analytics/google-auth.ts';
import {
  averageSeconds, basicPlaysRequest, localNow, pagesRequest, PLAYS_SINCE, playersRequest, playSeriesRequest, playsRequest, PRESETS, readPages, readPairs,
  readPlaces, readPlays, readSeries, readTopPages, realtimePlayersRequest, realtimeStudioRequest, selectionOf, topPagesRequest, trafficRequest,
  trafficSeriesRequest, type GaRequest, type GaResponse,
} from '../src/analytics/reports.ts';
import { loadLegacy, pagePaths } from '../src/analytics/pages.ts';
import { parseGaPropertyId } from '../src/config.ts';
import { EMPTY_LISTING } from '../src/listings.ts';
import { chart, datePicker, delta, duration, placesMap, playsNote, realtimeBody, view } from '../src/portal/analytics.ts';
import { fakeGa } from '../scripts/fake-ga.ts';
import { portalHarness } from './portal-harness.ts';

const TODAY = '2026-10-03';
const res = (dims: string[], mets: string[], rows: [string[], number[]][]): GaResponse => ({
  dimensionHeaders: dims.map((name) => ({ name })), metricHeaders: mets.map((name) => ({ name })),
  rows: rows.map(([d, m]) => ({ dimensionValues: d.map((value) => ({ value })), metricValues: m.map((v) => ({ value: String(v) })) })),
});

const sel = (range?: string, extra: { start?: string; end?: string; compare?: string } = {}, today = TODAY, hour = 12) => selectionOf({ range, ...extra }, today, hour);

describe('date ranges and requests', () => {
  test('the presets are Google Analytics’ and mean what they mean there; Last 28 days is the default', () => {
    // 2026-10-03 is a Saturday; weeks start on Sunday. "Last N days" end yesterday, as in GA.
    assert.deepEqual(PRESETS.map((p) => p.label), ['Today', 'Yesterday', 'This week (Sun – Today)', 'Last 7 days', 'Last week (Sun – Sat)', 'Last 28 days',
      'Last 30 days', 'This month', 'Last month', 'Last 90 days', 'Quarter to date', 'This year (Jan – Today)', 'Last calendar year']);
    const days = (r: string, today = TODAY) => { const x = sel(r, {}, today); return [x.current.start, x.current.end, x.previous.start, x.previous.end, x.vs, x.unit]; };
    assert.deepEqual(days('today'), [TODAY, TODAY, '2026-10-02', '2026-10-02', 'yesterday by this hour', 'hour']);
    assert.deepEqual(days('yesterday'), ['2026-10-02', '2026-10-02', '2026-10-01', '2026-10-01', 'the day before', 'hour']);
    assert.deepEqual(days('this-week'), ['2026-09-27', TODAY, '2026-09-20', '2026-09-26', 'the same days last week', 'day']);
    assert.deepEqual(days('this-week', '2026-09-30'), ['2026-09-27', '2026-09-30', '2026-09-20', '2026-09-23', 'the same days last week', 'day']);
    assert.deepEqual(days('last-week'), ['2026-09-20', '2026-09-26', '2026-09-13', '2026-09-19', 'the week before', 'day']);
    assert.deepEqual(days('last-7'), ['2026-09-26', '2026-10-02', '2026-09-19', '2026-09-25', 'the 7 days before', 'day']);
    assert.deepEqual(days('last-28'), ['2026-09-05', '2026-10-02', '2026-08-08', '2026-09-04', 'the 28 days before', 'day']);
    assert.deepEqual(days('this-month'), ['2026-10-01', TODAY, '2026-09-01', '2026-09-03', 'the same days last month', 'day']);
    assert.deepEqual(days('this-month', '2026-03-31').slice(2, 4), ['2026-02-01', '2026-02-28']);   // a shorter month before
    assert.deepEqual(days('last-month'), ['2026-09-01', '2026-09-30', '2026-08-01', '2026-08-31', 'the month before', 'day']);
    assert.deepEqual(days('last-90').slice(0, 2), ['2026-07-05', '2026-10-02']);
    assert.deepEqual(days('quarter'), ['2026-10-01', TODAY, '2026-07-01', '2026-07-03', 'the same days last quarter', 'day']);
    assert.deepEqual(days('quarter', '2026-02-15').slice(2, 4), ['2025-10-01', '2025-11-15']);
    assert.deepEqual(days('this-year'), ['2026-01-01', TODAY, '2025-01-01', '2025-10-03', 'the same days last year', 'month']);
    assert.deepEqual(days('this-year', '2028-02-29').slice(2, 4), ['2027-01-01', '2027-02-28']);
    assert.deepEqual(days('last-year'), ['2025-01-01', '2025-12-31', '2024-01-01', '2024-12-31', 'the year before', 'month']);
    assert.equal(sel().preset, 'last-28');
    assert.equal(sel('decade').preset, 'last-28');
    // The page's first ranges still work.
    assert.deepEqual(['day', 'week', 'month', 'quarter', 'year'].map((r) => sel(r).preset), ['today', 'this-week', 'this-month', 'quarter', 'this-year']);
  });

  test('a custom range: any days up to today, at most three years; anything else is the default', () => {
    const c = sel('custom', { start: '2026-09-10', end: '2026-09-19' });
    assert.deepEqual([c.preset, c.label, c.current, c.previous, c.vs, c.unit], ['custom', 'Custom', { start: '2026-09-10', end: '2026-09-19' }, { start: '2026-08-31', end: '2026-09-09' }, 'the 10 days before', 'day']);
    assert.equal(sel(undefined, { start: '2026-09-10', end: '2026-09-19' }).preset, 'custom');   // dates alone
    assert.equal(sel('custom', { start: '2026-09-10', end: '2026-09-10' }).unit, 'hour');
    assert.equal(sel('custom', { start: '2026-01-10', end: '2026-09-10' }).unit, 'month');
    for (const [start, end] of [['2026-09-19', '2026-09-10'], ['2026-09-10', '2026-10-04'], ['2023-01-01', '2026-09-10'], ['2026-02-30', '2026-03-03'], ['nope', '2026-09-10']]) {
      assert.equal(sel('custom', { start, end }).preset, 'last-28', `${start} – ${end}`);
    }
    assert.equal(sel('last-7', { start: '2026-09-10', end: '2026-09-19' }).current.start, '2026-09-26', 'a preset wins over dates');
    assert.equal(sel('last-7').compare, true);
    assert.equal(sel('last-7', { compare: '0' }).compare, false);
    assert.equal(sel('today', {}, TODAY, 9).toHour, 9);
    assert.equal(sel('yesterday', {}, TODAY, 9).toHour, 23);
  });

  test('today and the hour are the property’s, not the server’s', () => {
    const at = new Date('2026-10-03T03:30:00Z');   // 22:30 the day before in Chicago
    assert.deepEqual(localNow('America/Chicago', at), { today: '2026-10-02', hour: 22 });
    assert.deepEqual(localNow('UTC', at), { today: '2026-10-03', hour: 3 });
  });

  test('the chart asks for sessions and users, and plays, per point in each period; a game by its page', () => {
    const week = sel('this-week');
    assert.deepEqual(trafficSeriesRequest(week, {}), {
      dateRanges: [{ startDate: '2026-09-27', endDate: TODAY, name: 'current' }, { startDate: '2026-09-20', endDate: '2026-09-26', name: 'previous' }],
      dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }], limit: 10000,
    });
    assert.deepEqual(playSeriesRequest(week, {}).dimensionFilter, { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'play_start' } } });
    assert.deepEqual(trafficSeriesRequest(sel('last-7', { compare: '0' }), {}).dateRanges, [{ startDate: '2026-09-26', endDate: '2026-10-02', name: 'current' }]);
    assert.deepEqual(trafficSeriesRequest(sel('today'), {}).dimensions, [{ name: 'dateHour' }]);
    assert.deepEqual(trafficSeriesRequest(sel('this-year'), {}).dimensions, [{ name: 'yearMonth' }]);
    // A game's sessions and users: visits that showed its page or played it. The page, not game_slug: no custom
    // definitions needed, and the years before the play events are there too.
    const game = { game: 'wake', pages: ['/wake', '/wake/'] };
    assert.deepEqual(trafficSeriesRequest(week, game).dimensionFilter, { andGroup: { expressions: [
      { filter: { fieldName: 'eventName', inListFilter: { values: ['page_view', 'play_start'] } } },
      { filter: { fieldName: 'pagePath', inListFilter: { values: ['/wake', '/wake/'] } } },
    ] } });
    assert.match(JSON.stringify(playSeriesRequest(week, game)), /"pagePath"/);
    assert.match(JSON.stringify(playSeriesRequest(week, { game: 'wake' })), /"customEvent:game_slug".*"value":"wake"/);   // no pages known
    assert.deepEqual(trafficRequest(week).metrics, [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }]);
    assert.equal(trafficRequest(week).dimensionFilter, undefined);   // the whole site
  });

  test('a game’s page: its addresses old and new, page views, visitors and outbound clicks, in standard fields only', () => {
    const legacy = loadLegacy();
    assert.deepEqual(pagePaths('wake-tales-from-the-aqualab', legacy), ['/wake', '/wake/', '/game-cards/blog-post-title-one-kma9a', '/game-cards/blog-post-title-one-kma9a/']);
    assert.deepEqual(pagePaths('a-new-game', legacy), ['/a-new-game', '/a-new-game/']);
    assert.deepEqual(pagePaths('x', { x: { path: 'jowilder' } }), ['/jowilder', '/jowilder/']);
    const r = pagesRequest(sel('this-month'), ['/wake', '/wake/']);
    assert.deepEqual(r.dateRanges, [{ startDate: '2026-10-01', endDate: TODAY, name: 'current' }, { startDate: '2026-09-01', endDate: '2026-09-03', name: 'previous' }]);
    assert.deepEqual(r.dimensions, [{ name: 'eventName' }]);
    assert.deepEqual(r.metrics, [{ name: 'screenPageViews' }, { name: 'totalUsers' }, { name: 'eventCount' }]);
    assert.deepEqual(r.dimensionFilter, { andGroup: { expressions: [
      { filter: { fieldName: 'eventName', inListFilter: { values: ['page_view', 'click'] } } },
      { filter: { fieldName: 'pagePath', inListFilter: { values: ['/wake', '/wake/'] } } },
    ] } });
    const t = topPagesRequest(sel('this-year'), ['/wake', '/wake/', '/bloom/', '/wake']);
    assert.deepEqual(t.dateRanges, [{ startDate: '2026-01-01', endDate: TODAY }]);
    assert.deepEqual(t.dimensions, [{ name: 'pagePath' }, { name: 'eventName' }]);
    assert.match(JSON.stringify(t.dimensionFilter), /"pagePath","inListFilter":\{"values":\["\/wake","\/wake\/","\/bloom\/"\]\}/);
    for (const q of [r, t]) assert.doesNotMatch(JSON.stringify(q), /custom/);
  });

  test('plays, players and the site compare two named periods (one when not comparing); a game filters on game_slug', () => {
    const p = playsRequest(sel('this-month'), { game: 'wake' });
    assert.deepEqual(p.dateRanges, [{ startDate: '2026-10-01', endDate: TODAY, name: 'current' }, { startDate: '2026-09-01', endDate: '2026-09-03', name: 'previous' }]);
    assert.deepEqual(p.dimensions, [{ name: 'eventName' }, { name: 'customEvent:play_mode' }, { name: 'customEvent:game_slug' }]);
    assert.deepEqual(p.metrics, [{ name: 'eventCount' }, { name: 'customEvent:play_seconds' }]);
    assert.match(JSON.stringify(p.dimensionFilter), /"inListFilter":\{"values":\["play_start","play_heartbeat","play_end"\]\}.*"value":"wake"/);
    assert.deepEqual(playersRequest(sel('this-week'), {}).metrics, [{ name: 'totalUsers' }]);
    assert.doesNotMatch(JSON.stringify(playersRequest(sel('this-week'), {})), /game_slug/);
    
    assert.doesNotMatch(JSON.stringify(basicPlaysRequest(sel('this-week'))), /custom/);
    for (const q of [p, playersRequest(sel('this-week'), {}), trafficRequest(sel('this-month'))]) assert.doesNotMatch(JSON.stringify(q), /"hour"/);
    assert.deepEqual(playsRequest(sel('this-month', { compare: '0' }), {}).dateRanges, [{ startDate: '2026-10-01', endDate: TODAY, name: 'current' }]);
  });

  test('today is compared with yesterday up to the same hour', () => {
    const hours = { filter: { fieldName: 'hour', inListFilter: { values: ['00', '0', '01', '1', '02', '2'] } } };
    assert.deepEqual(trafficRequest(sel('today', {}, TODAY, 2)).dimensionFilter, hours);
    assert.deepEqual(playersRequest(sel('today', {}, TODAY, 2), {}).dimensionFilter, { andGroup: { expressions: [
      { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'play_start' } } }, hours,
    ] } });
    const at14 = sel('today', {}, TODAY, 14);
    for (const q of [playsRequest(at14, {}), basicPlaysRequest(at14, {}), pagesRequest(at14, ['/wake'])]) {
      assert.match(JSON.stringify(q), /"fieldName":"hour","inListFilter":\{"values":\["00","0",.*"13","14"\]\}/);
    }
    assert.equal(trafficRequest(sel('today', {}, TODAY, 23)).dimensionFilter, undefined);   // the whole day: no filter
    assert.equal(trafficRequest(sel('this-week', {}, TODAY, 2)).dimensionFilter, undefined);
    assert.equal(trafficRequest(sel('yesterday', {}, TODAY, 2)).dimensionFilter, undefined);   // a whole day before
  });

  test('a studio: all its games, by their pages, and by game_slug in the list of them', () => {
    const scope = { studio: 'fieldday', games: ['wake', 'bloom'], pages: ['/wake', '/wake/', '/bloom', '/bloom/'] };
    assert.match(JSON.stringify(trafficSeriesRequest(sel('this-week'), scope)), /"pagePath","inListFilter":\{"values":\["\/wake","\/wake\/","\/bloom","\/bloom\/"\]\}/);
    assert.match(JSON.stringify(playersRequest(sel('this-week'), scope)), /"pagePath","inListFilter"/);
    assert.match(JSON.stringify(playsRequest(sel('this-week'), scope)), /"fieldName":"customEvent:game_slug","inListFilter":\{"values":\["wake","bloom"\]\}/);
    assert.deepEqual(realtimeStudioRequest(['wake', 'bloom']).dimensionFilter, { filter: { fieldName: 'customUser:vault_game', inListFilter: { values: ['wake', 'bloom'] } } });
    assert.deepEqual(realtimeStudioRequest(['wake']).dimensions, realtimePlayersRequest({}).dimensions);
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
  const traffic = (dim: string, rows: [string, string, number, number][]) => res([dim, 'dateRange'], ['sessions', 'totalUsers'], rows.map(([k, r, a, b]) => [[k, r], [a, b]]));
  const playRows = (dim: string, rows: [string, string, number][]) => res([dim, 'dateRange'], ['eventCount'], rows.map(([k, r, n]) => [[k, r], [n]]));

  test('by day: sessions, users and plays at each day, the period before at the same place; no plays before they were counted', () => {
    const week = sel('this-week', {}, '2026-10-08');   // a Thursday: Sun Oct 4 – Thu Oct 8, against Sun Sep 27 – Thu Oct 1
    const s = readSeries(
      traffic('date', [['20261004', 'current', 10, 8], ['20261008', 'current', 12, 9], ['20260927', 'previous', 7, 5], ['20261001', 'previous', 3, 2]]),
      playRows('date', [['20261004', 'current', 4], ['20261008', 'current', 2], ['20260927', 'previous', 99]]), week, '2026-10-08', 12);
    assert.equal(PLAYS_SINCE, '2026-10-04');
    assert.deepEqual(s.labels, ['Oct 4', 'Oct 5', 'Oct 6', 'Oct 7', 'Oct 8']);
    assert.deepEqual([s.tips[0], s.prevTips[0], s.prevTips[4]], ['Sun Oct 4', 'Sun Sep 27', 'Thu Oct 1']);
    assert.deepEqual(s.sessions, { current: [10, 0, 0, 0, 12], previous: [7, 0, 0, 0, 3] });
    assert.deepEqual(s.users, { current: [8, 0, 0, 0, 9], previous: [5, 0, 0, 0, 2] });
    assert.deepEqual(s.plays, { current: [4, 0, 0, 0, 2], previous: [null, null, null, null, null] }, 'the week before had no play events');
    const off = readSeries(traffic('date', []), null, sel('this-week', { compare: '0' }, '2026-10-08'), '2026-10-08', 12);
    assert.equal(off.sessions.previous, null);
    assert.equal(off.plays, null, 'the plays report failed: no line');
  });

  test('a single day: hours, with the hours still to come today left empty', () => {
    const today = sel('today', {}, '2026-10-05', 10);
    const s = readSeries(traffic('dateHour', [['2026100509', 'current', 4, 3], ['2026100423', 'previous', 6, 6]]), playRows('dateHour', [['2026100509', 'current', 1]]), today, '2026-10-05', 10);
    assert.equal(s.labels.length, 24);
    assert.deepEqual([s.labels[9], s.tips[9], s.prevTips[9]], ['09:00', 'Oct 5, 09:00', 'Oct 4, 09:00']);
    assert.deepEqual([s.sessions.current[9], s.sessions.current[10], s.sessions.current[11]], [4, 0, null]);
    assert.equal(s.sessions.previous![23], 6);
    assert.equal(s.plays!.current[9], 1);
    // Yesterday is whole.
    const y = readSeries(traffic('dateHour', []), null, sel('yesterday', {}, '2026-10-05', 10), '2026-10-05', 10);
    assert.equal(y.sessions.current[23], 0);
  });

  test('longer ranges by month; a month cut by the range says which days', () => {
    const year = sel('this-year');   // Jan 1 – Oct 3, against Jan 1 – Oct 3, 2025
    const s = readSeries(traffic('yearMonth', [['202601', 'current', 100, 80], ['202610', 'current', 9, 7], ['202510', 'previous', 50, 40]]), playRows('yearMonth', []), year, TODAY, 0);
    assert.equal(s.unit, 'month');
    assert.deepEqual(s.labels, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
    assert.deepEqual([s.tips[0], s.tips[9], s.prevTips[9]], ['Jan 2026', 'Oct 1 – 3, 2026', 'Oct 1 – 3, 2025']);
    assert.deepEqual([s.sessions.current[0], s.sessions.current[9], s.sessions.previous![9]], [100, 9, 50]);
    assert.deepEqual(s.plays!.current, [null, null, null, null, null, null, null, null, null, null], 'October ends before the plays began (Oct 3)');
    const across = readSeries(traffic('yearMonth', []), null, sel('custom', { start: '2025-11-15', end: '2026-03-03' }), TODAY, 0);
    assert.deepEqual(across.labels, ['Nov 25', 'Dec 25', 'Jan 26', 'Feb 26', 'Mar 26']);
    assert.deepEqual([across.tips[0], across.tips[4]], ['Nov 15 – 30, 2025', 'Mar 1 – 3, 2026']);
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
    let now = Date.parse('2026-10-20T17:00:00Z');
    const a = new Analytics({ transport: fakeGa(['wake', 'bloom'], { log }), now: () => new Date(now) });
    const week = a.selection({ range: 'this-week' });
    assert.deepEqual(week.current, { start: '2026-10-18', end: '2026-10-20' });   // the property's today
    const ov = await a.overview(week, {});
    assert.equal(log.length, 5);   // plays, the chart's plays and its sessions and users, players, the site's totals
    assert.ok(ov.series.ok && ov.plays.ok && ov.players.ok && ov.traffic.ok);
    assert.ok(ov.series.value.sessions.current[0]! > 0 && ov.series.value.plays!.current[0]! > 0);
    await a.overview(week, {});
    assert.equal(log.length, 5);
    await a.realtime({}); await a.realtime({});
    assert.equal(log.length, 8);   // people by place, the total, and how many are playing
    now += 61_000;
    await a.realtime({});
    assert.equal(log.length, 11);
    await a.overview(week, { game: 'wake', pages: ['/wake', '/wake/'] });
    assert.equal(log.length, 17);  // and its page's report
  });

  test('a studio: its games’ plays, players and pages, and its players now', async () => {
    const log: { method: GaMethod; body: GaRequest }[] = [];
    const a = new Analytics({ transport: fakeGa(['wake', 'bloom', 'quiet'], { log }), now: () => new Date('2026-10-20T17:00:00Z') });
    const catalog = { wake: ['/wake', '/wake/'], bloom: ['/bloom', '/bloom/'] };
    const scope = { studio: 'fieldday', games: ['wake', 'bloom'], pages: Object.values(catalog).flat() };
    const ov = await a.overview(a.selection({ range: 'last-7' }), scope, catalog);
    assert.equal(log.length, 6);   // plays, the chart's two, players, its visits' totals, its games' pages
    assert.ok(ov.traffic.ok && ov.traffic.value.sessions.current > 0);
    assert.match(JSON.stringify(log.find((l) => JSON.stringify(l.body).includes('"sessions"'))!.body), /"pagePath","inListFilter"/);
    assert.ok(ov.pages?.ok && ov.pages.value.views.current > 0);
    assert.ok(ov.plays.ok && ov.plays.value.games.length === 2 && ov.plays.value.games.every((g) => g.slug !== 'quiet'));
    const rt = await a.realtime(scope);
    assert.equal(rt.who, 'players');
    assert.ok(rt.places.ok && rt.places.value.length > 0);
    assert.equal(log.length, 7);   // one realtime report
    assert.match(JSON.stringify(log[6].body), /"customUser:vault_game","inListFilter":\{"values":\["wake","bloom"\]\}/);
    const none = await a.realtime({ studio: 'empty', games: [], pages: [] });
    assert.ok(none.places.ok && none.places.value.length === 0);
    assert.equal(log.length, 7);   // a studio without games on the site asks nothing
  });

  test('a range before the play events: sessions and users go back, plays are said not to, top games by page views', async () => {
    const log: { method: GaMethod; body: GaRequest }[] = [];
    const a = new Analytics({ transport: fakeGa(['wake', 'bloom'], { log }), now: () => new Date('2026-10-20T17:00:00Z') });
    const catalog = { wake: ['/wake', '/wake/'], bloom: ['/bloom', '/bloom/'] };
    const sep = a.selection({ range: 'custom', start: '2026-09-01', end: '2026-09-30' });
    const ov = await a.overview(sep, {}, catalog);
    assert.ok(ov.series.ok && ov.series.value.sessions.current.every((v) => v! > 0));
    assert.ok(ov.series.value.plays!.current.every((v) => v === null));
    assert.ok(ov.topPages?.ok && ov.topPages.value.map((g) => g.slug).sort().join() === 'bloom,wake');
    assert.equal(log.length, 6);   // the five, then top pages because no game had plays
    const opts = { timeZone: 'America/Chicago', staff: true, realtimeUrl: '/rt', assets: { css: '', js: '', land: '' }, titleOf: (slug: string) => ({ title: slug.toUpperCase(), href: null }) };
    const page = String(view(ov, { places: { ok: true, value: [] }, visitors: null, who: 'players' }, { ...opts, scope: {}, base: '/vault/analytics' }));
    assert.match(page, /Sessions, plays and users/);
    assert.match(page, /<p class="ga-warn" role="note"><b>Plays weren’t counted before Oct 4, 2026<\/b>/);
    assert.match(page, /not counted for the 30 days before/);
    assert.match(page, /Top games <small>by page views, Sep 1 – Sep 30, 2026/);
    assert.match(page, /<b>WAKE<\/b>/);
    assert.match(page, /Play-button clicks/);
    const game = await a.overview(sep, { game: 'wake', pages: catalog.wake }, catalog);
    assert.ok(game.pages?.ok && game.pages.value.views.current > 0 && game.pages.value.clicks.current > 0);
    const gp = String(view(game, { places: { ok: true, value: [] }, visitors: null, who: 'players' }, { ...opts, staff: false, scope: { game: 'wake', pages: catalog.wake }, base: '/s/x/g/wake?tab=analytics' }));
    assert.match(gp, /Plays weren’t counted before Oct 4, 2026/);
    assert.match(gp, /The game’s page/);
    assert.match(gp, /Visits to the site that showed the game’s page or played it/);
    assert.match(gp, /outbound clicks from the game’s page/);
    // After the play events began, comparing with a period before them: said too.
    const week = a.selection({ range: 'last-7' });   // Oct 13 – 19, against Oct 6 – 12: no note
    assert.equal(playsNote(week), '');
    assert.match(String(playsNote(a.selection({ range: 'custom', start: '2026-10-04', end: '2026-10-05' }))), /so the 2 days before has none to compare with/);
    assert.equal(playsNote(a.selection({ range: 'custom', start: '2026-10-04', end: '2026-10-05', compare: '0' })), '');
  });

  test('without the play events at all, sessions and users are still drawn', async () => {
    const a = new Analytics({ transport: fakeGa(['wake'], { plays: false }), now: () => new Date('2026-10-20T17:00:00Z') });
    const ov = await a.overview(a.selection({ range: 'last-7' }), {});
    assert.ok(ov.series.ok && ov.series.value.sessions.current.every((v) => v! > 0));
    assert.ok(ov.series.value.plays!.current.every((v) => v === 0));
  });

  test('a property without click events: play clicks are just 0', async () => {
    const t = async (_m: GaMethod, body: GaRequest): Promise<GaResponse> =>
      (JSON.stringify(body).includes('"click"') ? res(['eventName', 'dateRange'], ['screenPageViews', 'totalUsers', 'eventCount'], [[['page_view', 'current'], [5, 3, 5]]]) : {});
    const a = new Analytics({ transport: t });
    const ov = await a.overview(a.selection({}), { game: 'wake', pages: ['/wake', '/wake/'] });
    assert.ok(ov.pages?.ok);
    assert.deepEqual(ov.pages.value.clicks, { current: 0, previous: 0 });
  });

  test('not connected without a property id; the site falls back to plain counts before the custom definitions exist', async () => {
    const week = selectionOf({ range: 'this-week' }, TODAY, 12);
    const off = await new Analytics({}).overview(week, {});
    assert.ok(!off.series.ok && off.series.error.kind === 'not_connected');
    const t = async (_m: GaMethod, body: GaRequest): Promise<GaResponse> => {
      if (JSON.stringify(body).includes('custom')) throw new AnalyticsError('setup', 'Field customEvent:play_mode is not a valid dimension.');
      return res(['eventName', 'dateRange'], ['eventCount'], [[['play_start', 'current'], [8]], [['play_start', 'previous'], [5]]]);
    };
    const site = await new Analytics({ transport: t }).overview(week, {});
    assert.ok(site.plays.ok);
    assert.equal(site.plays.value.timed, false);
    assert.deepEqual(site.plays.value.current, { plays: 8, timedPlays: 0, seconds: 0 });
    const game = await new Analytics({ transport: t }).overview(week, { game: 'wake' });
    assert.ok(!game.plays.ok && game.plays.error.kind === 'setup');
    // A game whose pages are known is counted on them: no custom definitions needed.
    const byPage = await new Analytics({ transport: t }).overview(week, { game: 'wake', pages: ['/wake', '/wake/'] });
    assert.ok(byPage.plays.ok && byPage.plays.value.current.plays === 8 && byPage.players.ok);
    assert.match(JSON.stringify(playersRequest(week, { game: 'wake', pages: ['/wake'] })), /"pagePath","inListFilter":\{"values":\["\/wake"\]/);
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
    const week = sel('this-week'), today = sel('today', {}, TODAY, 2);
    assert.match(String(delta(12, 10, week)), /class="d up">\+20% vs the same days last week/);
    assert.match(String(delta(19, 20, today)), /class="d down">-5\.0% vs yesterday by this hour/);
    assert.match(String(delta(20, 20, today)), /no change vs yesterday by this hour/);
    assert.match(String(delta(3, 0, week)), /new: none the same days last week/);
    assert.equal(String(delta(12, 10, sel('this-week', { compare: '0' }))), '<div class="d"></div>', 'not comparing');
    // Plays against a period before the play events: not a fall from nothing.
    const after = sel('custom', { start: '2026-10-04', end: '2026-10-05' }, '2026-10-06');
    assert.match(String(delta(12, 0, after, true)), /not counted for the 2 days before/);
    assert.match(String(delta(12, 0, after)), /new: none the 2 days before/, 'sessions were counted then');
    assert.match(String(delta(12, 3, sel('custom', { start: '2026-10-06', end: '2026-10-08' }, '2026-10-09'), true)), /the 3 days before only partly counted/);

    // The chart: a line each for sessions, plays and users, the period before dashed; tooltips with both.
    const t = (rows: [string, string, number, number][]) => res(['date', 'dateRange'], ['sessions', 'totalUsers'], rows.map(([k, r, a, b]) => [[k, r], [a, b]]));
    const s = readSeries(t([['20261004', 'current', 40, 30], ['20261005', 'current', 20, 10], ['20261002', 'previous', 30, 25]]),
      res(['date', 'dateRange'], ['eventCount'], [[['20261005', 'current'], [8]]]), after, '2026-10-06', 9);
    const svg = String(chart(s, after));
    assert.equal(svg.match(/<path class="ga-cur s\d"/g)?.length, 3);
    assert.equal(svg.match(/<path class="ga-prev s\d"/g)?.length, 3);
    assert.match(svg, /<path class="ga-cur s1" d="M0\.5 0L1\.5 50"/);   // sessions 40, 20 on a 0–40 axis
    assert.match(svg, /<path class="ga-cur s2" d="M0\.5 100L1\.5 80"/);   // plays 0, 8 (counted from Oct 4)
    assert.match(svg, /<path class="ga-prev s2" d=""/);                  // none counted the days before
    assert.match(svg, /<title>Sun Oct 4: 40 sessions · 0 plays · 30 users\nFri Oct 2: 30 sessions · plays not counted yet · 25 users<\/title>/);
    const alone = { ...after, compare: false };
    assert.doesNotMatch(String(chart(readSeries(t([['20261004', 'current', 40, 30]]), null, alone, '2026-10-06', 9), alone)), /ga-prev|Oct 2/);
    const hours = readSeries(t([]), null, sel('today', {}, TODAY, 2), TODAY, 2);
    const hsvg = String(chart(hours, sel('today', {}, TODAY, 2)));
    assert.equal(hsvg.match(/<path class="ga-cur/g)?.length, 2, 'no plays line when its report failed');
    assert.match(hsvg, /<title>Oct 3, 05:00: later today<\/title>/);
  });

  test('the date range picker: GA’s presets with their dates, a custom range, compare; the page’s own query kept', () => {
    const html = String(datePicker('/s/fieldday/g/wake?tab=analytics&range=today', sel('last-7')));
    assert.match(html, /<summary><span class="ga-dl">Last 7 days<\/span> <b>Sep 26 – Oct 2, 2026<\/b> <span class="ga-vs">vs Sep 19 – Sep 25, 2026<\/span><\/summary>/);
    assert.match(html, /<form class="ga-dp" method="get" action="\/s\/fieldday\/g\/wake">/);
    assert.match(html, /<input type="hidden" name="tab" value="analytics">/);
    assert.doesNotMatch(html, /name="range" value="today">/, 'the old range is replaced, not kept');
    assert.match(html, /value="last-7" data-start="2026-09-26" data-end="2026-10-02" checked>/);
    assert.match(html, /value="last-month" data-start="2026-09-01" data-end="2026-09-30" >/);
    assert.equal(html.match(/type="radio"/g)?.length, 14);   // Custom and the 13 presets
    assert.match(html, /<input type="date" name="start" value="2026-09-26" max="2026-10-03" required>/);
    assert.match(html, /<input type="hidden" name="compare" value="0"><input type="checkbox" name="compare" value="1" checked>/);
    assert.doesNotMatch(String(datePicker('/vault/analytics', sel('last-7', { compare: '0' }))), /ga-vs|value="1" checked/);
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
    assert.match(page, /value="quarter" data-start="[\d-]+" data-end="[\d-]+" checked>/);
    assert.match(page, /<span class="ga-dl">Quarter to date<\/span>/);
    assert.match(page, /compared with the same days last quarter/);
    assert.match(page, /Sessions, plays and users/);
    assert.match(page, /<form class="ga-dp" method="get" action="\/vault\/analytics">/);
    assert.match(page, /Unique players/);
    assert.match(page, /Average play time/);
    assert.match(page, /Page views/);
    assert.match(page, /Sessions/);
    assert.match(page, /Top games/);
    assert.match(page, /href="\/s\/ucalgary\/g\/transformations-quest\?tab=analytics"><b>Transformations Quest<\/b>/);
    assert.match(page, /href="\/s\/ucalgary\/analytics"/);   // each game's studio's page
    assert.match(await (await h.as('rm', 'release_manager').get('/vault/analytics?range=week')).text(), /<span class="ga-dl">This week \(Sun – Today\)<\/span>/);
    // The form sends compare=0, then compare=1 when ticked: the last counts. Comparing is the default.
    const cmp = async (q: string) => /class="ga-vs"/.test(await (await h.as('rm', 'release_manager').get(`/vault/analytics?range=last-7${q}`)).text());
    assert.deepEqual([await cmp(''), await cmp('&compare=0'), await cmp('&compare=0&compare=1')], [true, false, true]);
    const custom = await (await h.as('rm', 'release_manager').get('/vault/analytics?range=custom&start=2026-09-01&end=2026-09-10')).text();
    assert.match(custom, /<span class="ga-dl">Custom<\/span> <b>Sep 1 – Sep 10, 2026<\/b>/);
    assert.match(custom, /Plays weren’t counted before Oct 4, 2026/);
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
    assert.doesNotMatch(mine, /Top games|The website/);
    assert.match(mine, /<input type="hidden" name="tab" value="analytics">/);
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

  test('a studio’s Analytics page: its games, for every member (viewers too) and Vault staff', async () => {
    const h = setup(fake());
    const viewer = h.as('mia', 'none', 'viewer');
    const page = await (await viewer.get('/s/fieldday/analytics?range=month')).text();
    assert.match(page, /href="\/s\/fieldday\/analytics" class="on">Analytics<\/a>/);
    assert.match(page, /<span class="ga-dl">This month<\/span>/);
    assert.match(page, /Unique players/);
    assert.match(page, /Top games/);
    assert.match(page, /href="\/s\/fieldday\/g\/wake\?tab=analytics"><b>Wake<\/b>/);
    assert.doesNotMatch(page, /Transformations Quest|The website/);   // its games only; no site figures
    assert.match(page, /data-realtime="\/portal\/analytics\/realtime\?studio=fieldday"/);
    assert.match(page, /Playing now/);
    assert.match(page, /<form class="ga-dp" method="get" action="\/s\/fieldday\/analytics">/);
    assert.match(await (await viewer.get('/s/fieldday')).text(), /href="\/s\/fieldday\/analytics"/);   // in the studio's nav
    assert.equal((await viewer.get('/s/ucalgary/analytics')).status, 404);
    assert.equal((await h.as('rm', 'release_manager').get('/s/ucalgary/analytics')).status, 200);
    assert.equal((await viewer.get('/portal/analytics/realtime?studio=fieldday')).status, 200);
    assert.equal((await viewer.get('/portal/analytics/realtime?studio=ucalgary')).status, 404);
    assert.equal((await viewer.get('/portal/analytics/realtime?studio=nope')).status, 404);
    // A studio without games on the site.
    h.db.createStudio({ slug: 'empty', name: 'Empty Studio', github_owner: '', github_owner_id: 'vault:empty' });
    const empty = await (await h.as('rm', 'release_manager').get('/s/empty/analytics')).text();
    assert.match(empty, /None of this studio’s games are on the site/);
    assert.doesNotMatch(empty, /ga-chart/);
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
