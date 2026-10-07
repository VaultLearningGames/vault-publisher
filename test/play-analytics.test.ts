// The website's play events (site/themes/vault-squarespace/static/sq/js/vault-play-analytics.js): the timing logic,
// and how it is connected to a game page.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error: a plain browser module (JavaScript, no types)
import { createPlayTracker, HEARTBEAT_MS, install } from '../site/themes/vault-squarespace/static/sq/js/vault-play-analytics.js';

type Sent = { name: string; params: Record<string, unknown>; beacon: boolean };
function rig(visible = true, source: Record<string, string> = {}) {
  let now = 1_000_000, visibleNow = visible, ids = 0;
  const sent: Sent[] = [];
  const timers = new Map<number, { fn: () => void; ms: number; next: number }>();
  let tid = 0;
  const t = createPlayTracker({
    send: (name: string, params: Record<string, unknown>, beacon: boolean) => sent.push({ name, params, beacon }),
    now: () => now, visible: () => visibleNow, game: 'wake', studio: 'fieldday', newId: () => `p${++ids}`, source,
    every: (fn: () => void, ms: number) => { timers.set(++tid, { fn, ms, next: now + ms }); return tid; },
    cancel: (h: number) => { timers.delete(h); },
  });
  // Advance the clock, running due timers as a browser would (none while the computer "sleeps").
  const advance = (ms: number, sleep = false) => {
    const end = now + ms;
    if (sleep) { now = end; for (const x of timers.values()) x.next = now + x.ms; return; }
    for (;;) {
      const due = [...timers.values()].filter((x) => x.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next; due.next += due.ms; due.fn();
    }
    now = end;
  };
  return { t, sent, advance, timers, setVisible: (v: boolean) => { visibleNow = v; t.visibility(v); } };
}
const total = (sent: Sent[]) => sent.reduce((s, e) => s + Number(e.params.play_seconds ?? 0), 0);

describe('play events', () => {
  test('a play in the player: start, a heartbeat every 30 s, and the rest at the end, by beacon', () => {
    const r = rig();
    r.t.start('player');
    assert.deepEqual(r.sent[0], { name: 'play_start', params: { game_slug: 'wake', studio: 'fieldday', play_mode: 'player', play_id: 'p1' }, beacon: false });
    r.advance(95_400);
    assert.deepEqual(r.sent.slice(1).map((e) => [e.name, e.params.play_seconds]), [['play_heartbeat', 30], ['play_heartbeat', 30], ['play_heartbeat', 30]]);
    r.t.close();
    const end = r.sent.at(-1)!;
    assert.deepEqual(end, { name: 'play_end', params: { game_slug: 'wake', studio: 'fieldday', play_mode: 'player', play_id: 'p1', play_seconds: 5, end_reason: 'close' }, beacon: true });
    assert.equal(total(r.sent), 95);
    assert.equal(r.timers.size, 0);
    assert.equal(r.t.active, null);
    r.advance(60_000);
    assert.equal(r.sent.length, 5);   // nothing after the close
    assert.equal(HEARTBEAT_MS, 30_000);
  });

  test('a hidden page stops the clock and reports at once; back on screen it counts again, same play', () => {
    const r = rig();
    r.t.start('player');
    r.advance(20_000);
    r.setVisible(false);
    assert.deepEqual([r.sent.at(-1)!.name, r.sent.at(-1)!.params.play_seconds, r.sent.at(-1)!.params.end_reason, r.sent.at(-1)!.beacon], ['play_end', 20, 'hidden', true]);
    assert.equal(r.timers.size, 0);
    r.advance(10 * 60_000);           // ten minutes in another tab: not counted, nothing sent
    assert.equal(r.sent.length, 2);
    r.setVisible(true);
    r.advance(40_000);
    r.t.close();
    assert.equal(total(r.sent), 60);
    assert.ok(r.sent.every((e) => e.params.play_id === 'p1'));
    assert.equal(r.sent.filter((e) => e.name === 'play_start').length, 1);
  });

  test('leaving the page ends the play; after a hidden report nothing is sent twice', () => {
    const r = rig();
    r.t.start('player');
    r.advance(12_000);
    r.t.leave();
    assert.deepEqual([r.sent.at(-1)!.name, r.sent.at(-1)!.params.play_seconds, r.sent.at(-1)!.params.end_reason], ['play_end', 12, 'unload']);
    const r2 = rig();
    r2.t.start('player');
    r2.advance(12_000);
    r2.setVisible(false);
    r2.t.leave();
    assert.equal(r2.sent.filter((e) => e.name === 'play_end').length, 1);
  });

  test('rounding carries over, so the seconds add up', () => {
    const r = rig();
    r.t.start('player');
    for (let i = 0; i < 10; i++) { r.advance(1_500); r.setVisible(false); r.setVisible(true); }
    r.t.close();
    assert.equal(total(r.sent), 15);
  });

  test('a computer asleep with the player open counts at most two heartbeats', () => {
    const r = rig();
    r.t.start('player');
    r.advance(3 * 3600_000, true);
    r.t.close();
    assert.equal(total(r.sent), 60);
  });

  test('an off-site acquisition source rides on every event of the play', () => {
    const src = { source_referrer: 'https://www.sciencegamecenter.org/', source_channel: 'sciencegamecenter' };
    const r = rig(true, src);
    r.t.start('player');
    r.advance(31_000);
    r.t.close();
    assert.ok(r.sent.length >= 3);
    for (const e of r.sent) {
      assert.equal(e.params.source_referrer, 'https://www.sciencegamecenter.org/');
      assert.equal(e.params.source_channel, 'sciencegamecenter');
    }
  });

  test('a new-tab play is counted but not timed; a second play ends the first', () => {
    const r = rig();
    r.t.start('new_tab');
    assert.deepEqual(r.sent[0].params, { game_slug: 'wake', studio: 'fieldday', play_mode: 'new_tab', play_id: 'p1' });
    assert.equal(r.t.active, null);
    r.advance(60_000);
    assert.equal(r.sent.length, 1);
    r.t.start('player');
    r.advance(10_000);
    r.t.start('player');
    assert.deepEqual(r.sent.slice(1).map((e) => [e.name, e.params.play_id, e.params.end_reason ?? '']), [['play_start', 'p2', ''], ['play_end', 'p2', 'restart'], ['play_start', 'p3', '']]);
  });

  test('a player opened while the page is hidden waits for it to be visible', () => {
    const r = rig(false);
    r.t.start('player');
    assert.deepEqual(r.t.active, { id: 'p1', counting: false });
    r.advance(60_000);
    r.setVisible(true);
    r.advance(5_000);
    r.t.close();
    assert.equal(total(r.sent), 5);
  });
});

describe('on a game page', () => {
  function page(metas: Record<string, string>, withGtag = true) {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const on = (k: string, fn: (e: any) => void) => { (listeners[k] ??= []).push(fn); };
    const calls: unknown[][] = [];
    const doc = {
      visibilityState: 'visible',
      querySelector: (sel: string) => { const name = sel.match(/name="([^"]+)"/)?.[1] ?? ''; return name in metas ? { getAttribute: () => metas[name] } : null; },
      addEventListener: (k: string, fn: (e: any) => void) => on(k, fn),
    };
    const win: any = {
      document: doc, location: { href: 'https://vaultlearninggames.org/wake#play', host: 'vaultlearninggames.org' },
      addEventListener: (k: string, fn: (e: any) => void) => on(`win:${k}`, fn),
      setInterval: () => 1, clearInterval: () => {}, crypto: { randomUUID: () => 'uuid' },
      ...(withGtag ? { gtag: (...a: unknown[]) => calls.push(a) } : {}),
    };
    const fire = (k: string, e: any = {}) => (listeners[k] ?? []).forEach((f) => f(e));
    return { tracker: install(win), calls, fire, doc };
  }
  const link = (href: string, text: string, wired = false) => ({ closest: () => ({ getAttribute: () => href, hasAttribute: (a: string) => wired && a === 'data-vault-play', textContent: text }) });

  test('the player’s open and close become play events, with the game in a user property', () => {
    const p = page({ 'vault:game': 'wake', 'vault:studio-slug': 'fieldday' });
    p.fire('vault-player:open');
    assert.deepEqual(p.calls[0], ['set', 'user_properties', { vault_game: 'wake' }]);
    assert.deepEqual(p.calls[1], ['event', 'play_start', { game_slug: 'wake', studio: 'fieldday', play_mode: 'player', play_id: 'uuid' }]);
    p.fire('vault-player:close');
    assert.equal((p.calls[2][2] as Record<string, unknown>).transport_type, 'beacon');
    assert.equal(p.calls[2][1], 'play_end');
  });

  test('a Play button the player leaves alone is a new-tab play; other links and the player’s own are not', () => {
    const p = page({ 'vault:game': 'angle-jungle', 'vault:studio-slug': 'saffron' });
    p.fire('click', { target: link('https://studiosaffron.itch.io/angle-jungle', 'Play Game') });
    p.fire('click', { target: link('#play', 'Play Game', true) });
    p.fire('click', { target: link('https://example.org/', 'About the studio') });
    p.fire('click', { target: link('/teachers', 'Play') });
    const events = p.calls.filter((c) => c[0] === 'event');
    assert.deepEqual(events, [['event', 'play_start', { game_slug: 'angle-jungle', studio: 'saffron', play_mode: 'new_tab', play_id: 'uuid' }]]);
  });

  test('nothing without a game or without gtag (a build without a measurement id)', () => {
    assert.equal(page({}).tracker, null);
    assert.equal(page({ 'vault:game': 'wake' }, false).tracker, null);
  });
});
