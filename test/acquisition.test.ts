// Where plays come from: the acquisition request, its reader and the portal card.
//
// The point of all of this is a question Vault has to be able to answer with numbers — "how much of a game's traffic
// do we supply, next to a partner who links to it?" Before source_channel, a play that came through Vault carried no
// source at all: the game's own analytics is served from the Vault CDN, so a vaultlearninggames.org referrer is a
// self-referral GA discards, and every Vault play landed in "(direct)" while the partner got a named row. These tests
// pin the parts that keep Vault's own contribution countable.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquisitionRequest, DIM_GAME, DIM_SOURCE, DIM_SOURCE_REFERRER, readAcquisition, selectionOf, sourceLabel,
  type GaResponse,
} from '../src/analytics/reports.ts';
import { acquisitionCard, acquisitionRows } from '../src/portal/analytics.ts';

const TODAY = '2026-10-03';
const sel = (range = 'last-28') => selectionOf({ range }, TODAY, 12);
// A GA answer shaped like the acquisition report's: channel, origin, period, plays.
const answer = (rows: [string, string, string, number][]): GaResponse => ({
  dimensionHeaders: [{ name: DIM_SOURCE }, { name: DIM_SOURCE_REFERRER }, { name: 'dateRange' }],
  metricHeaders: [{ name: 'eventCount' }],
  rows: rows.map(([ch, origin, period, n]) => ({
    dimensionValues: [{ value: ch }, { value: origin }, { value: period }],
    metricValues: [{ value: String(n) }],
  })),
});

describe('the acquisition request', () => {
  test('counts play_start by channel and origin, most plays first, in both periods', () => {
    const r = acquisitionRequest(sel(), {});
    assert.deepEqual(r.dimensions, [{ name: DIM_SOURCE }, { name: DIM_SOURCE_REFERRER }]);
    assert.deepEqual(r.metrics, [{ name: 'eventCount' }]);
    assert.deepEqual(r.orderBys, [{ metric: { metricName: 'eventCount' }, desc: true }]);
    assert.equal((r.dateRanges as { name: string }[]).length, 2, 'the period before, for the change column');
    assert.match(JSON.stringify(r.dimensionFilter), /play_start/);
  });

  test('a game’s view asks only for that game’s plays', () => {
    const r = acquisitionRequest(sel(), { game: 'jo-wilder-and-the-capitol-case' });
    const f = JSON.stringify(r.dimensionFilter);
    assert.match(f, /jo-wilder-and-the-capitol-case/);
    assert.match(f, new RegExp(DIM_GAME.replace(':', ':')));
  });
});

describe('reading the answer', () => {
  test('plays per channel in each period, with the origins seen, most plays first', () => {
    const a = readAcquisition(answer([
      ['pbswi', 'https://pbswisconsineducation.org/', 'current', 611],
      ['vault', '', 'current', 434],
      ['vault', '', 'previous', 400],
      ['pbswi', 'https://pbswisconsineducation.org/', 'previous', 700],
      ['other', 'https://classroom.google.com/', 'current', 1],
    ]));
    assert.deepEqual(a.total, { current: 1046, previous: 1100 });
    assert.deepEqual(a.sources.map((s) => [s.channel, s.plays.current, s.plays.previous]), [
      ['pbswi', 611, 700], ['vault', 434, 400], ['other', 1, 0],
    ]);
    assert.deepEqual(a.sources[0].origins, ['https://pbswisconsineducation.org/']);
    assert.deepEqual(a.sources[0].label, 'PBS Wisconsin Education');
    assert.deepEqual(a.sources[1].label, 'Vault', 'Vault is a named source, not "(direct)"');
  });

  test('a channel’s several origins are collected, and "(not set)" is never one of them', () => {
    const a = readAcquisition(answer([
      ['pbswi', 'https://pbswisconsineducation.org/', 'current', 5],
      ['pbswi', 'https://www.pbswisconsineducation.org/', 'current', 3],
      ['vault', '(not set)', 'current', 2],
    ]));
    assert.deepEqual(a.sources[0].origins, ['https://pbswisconsineducation.org/', 'https://www.pbswisconsineducation.org/']);
    assert.deepEqual(a.sources.find((s) => s.channel === 'vault')!.origins, [], 'no origin is better than a fake one');
  });

  test('plays recorded before the channel shipped stay their own row, named Unattributed', () => {
    const a = readAcquisition(answer([['(not set)', '', 'current', 90], ['vault', '', 'current', 10]]));
    const unattributed = a.sources.find((s) => s.channel === '(not set)')!;
    assert.equal(unattributed.label, 'Unattributed');
    assert.equal(unattributed.plays.current, 90);
    assert.equal(sourceLabel(''), 'Unattributed', 'an empty channel reads the same way');
  });

  test('an unknown channel keeps its own name rather than being dropped', () => {
    const a = readAcquisition(answer([['someoneelse', 'https://example.org/', 'current', 4]]));
    assert.deepEqual([a.sources[0].channel, a.sources[0].label], ['someoneelse', 'someoneelse']);
  });
});

describe('the share of plays', () => {
  test('shares are of the plays whose source is known, so Unattributed can’t skew them', () => {
    const { attributed, rows } = acquisitionRows(readAcquisition(answer([
      ['pbswi', '', 'current', 60], ['vault', '', 'current', 40], ['(not set)', '', 'current', 900],
    ])));
    assert.equal(attributed, 100, 'the 900 unmeasured plays are excluded from the denominator');
    assert.deepEqual(rows.map((s) => s.channel), ['(not set)', 'pbswi', 'vault'], 'ordered by plays');
  });

  test('the card shows each source’s share and names Vault', () => {
    const stats = readAcquisition(answer([
      ['pbswi', 'https://pbswisconsineducation.org/', 'current', 611],
      ['vault', '', 'current', 434],
    ]));
    const h = String(acquisitionCard({ ok: true, value: stats }, sel(), true));
    assert.match(h, /PBS Wisconsin Education/);
    assert.match(h, /Vault/);
    assert.match(h, /58\.5%/, '611 of 1045 attributed plays');
    assert.match(h, /41\.5%/, '434 of 1045 — Vault’s own contribution, countable');
    assert.doesNotMatch(h, /\(direct\)/, 'a Vault play is never reported as direct');
  });

  test('no report asked for: no card; a property without the definition says so and the page still works', async () => {
    assert.equal(acquisitionCard(null, sel(), true), '');
    const { AnalyticsError } = await import('../src/analytics/ga.ts');
    const h = String(acquisitionCard({ ok: false, error: new AnalyticsError('setup', 'source_channel') }, sel(), true));
    assert.match(h, /doesn’t know/);
    assert.match(h, /source_channel/);
  });

  test('no plays in the range: the card says so instead of an empty table', () => {
    const h = String(acquisitionCard({ ok: true, value: readAcquisition(answer([])) }, sel(), true));
    assert.match(h, /No plays in this range/);
  });
});
