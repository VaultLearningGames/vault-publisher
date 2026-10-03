// Play analytics for a game page: Google Analytics 4 events for each play of the game, with how long it was played.
// Loaded as a module by partials/vault-play-analytics.html, only on game pages of a build that has a measurement id
// (params.analytics.google), after gtag. The event schema is in docs/analytics.md:
//   play_start      a play began: the in-page player opened (play_mode "player"), or the game opened in a new tab
//                   ("new_tab"; its length can't be measured: the game runs in another tab, on another site)
//   play_heartbeat  every 30 s while the player is open and the page is visible: play_seconds since the last event
//   play_end        the player closed, or the page was hidden or left: the rest of the play's seconds
// play_seconds adds up: the total of play_seconds over a play's events is how long the game was open and on screen.
// Every event carries game_slug (the listing's slug in the portal), studio (its studio's slug), play_mode and play_id.
//
// createPlayTracker is the timing logic, without the page (unit-tested in test/play-analytics.test.ts); install()
// connects it to the page and gtag.

export const HEARTBEAT_MS = 30_000;

/**
 * @param {{ send(name: string, params: Record<string, unknown>, beacon: boolean): void, now(): number,
 *   every(fn: () => void, ms: number): unknown, cancel(handle: unknown): void, visible(): boolean,
 *   game: string, studio: string, newId(): string, heartbeatMs?: number }} o
 */
export function createPlayTracker(o) {
  const beat = o.heartbeatMs ?? HEARTBEAT_MS;
  // The play in the player: its id, milliseconds on screen not yet reported, since when it has been on screen (null
  // while the page is hidden), the heartbeat timer, and whether it has been reported up to date by a play_end.
  let play = null;
  const base = () => ({ game_slug: o.game, studio: o.studio });

  // Count the time on screen since `since`. A gap longer than two heartbeats means the timer didn't run (the computer
  // slept, or the browser stopped the page's timers): only up to two heartbeats of it are counted.
  function bank() {
    if (!play || play.since === null) return;
    const t = o.now();
    play.ms += Math.max(0, Math.min(t - play.since, 2 * beat));
    play.since = t;
  }
  // Whole seconds to report now; the rest carries over to the next event, so nothing is lost to rounding.
  function take() {
    bank();
    const s = Math.floor(play.ms / 1000);
    play.ms -= s * 1000;
    return s;
  }
  function startTimer() { if (play && play.timer === null) play.timer = o.every(heartbeat, beat); }
  function stopTimer() { if (play && play.timer !== null) { o.cancel(play.timer); play.timer = null; } }

  function heartbeat() {
    if (!play || play.since === null) return;
    const s = take();
    if (s > 0) o.send('play_heartbeat', { ...base(), play_mode: 'player', play_id: play.id, play_seconds: s }, false);
  }

  function end(reason) {
    if (!play) return;
    const s = take();
    stopTimer();
    const fresh = play.since !== null || s > 0 || !play.reported;
    if (fresh) o.send('play_end', { ...base(), play_mode: 'player', play_id: play.id, play_seconds: s, end_reason: reason }, true);
    play = null;
  }

  return {
    /** A play began. mode: "player" (the in-page player opened) or "new_tab". */
    start(mode) {
      if (play) end('restart');
      const id = o.newId();
      o.send('play_start', { ...base(), play_mode: mode, play_id: id }, false);
      if (mode !== 'player') return;
      play = { id, ms: 0, since: o.visible() ? o.now() : null, timer: null, reported: false };
      if (play.since !== null) startTimer();
    },
    /** The player closed. */
    close() { end('close'); },
    /** The page left (pagehide): report the rest with a beacon. */
    leave() { end('unload'); },
    /** The page's visibility changed. Hidden: report what's on the clock and stop counting; visible: count again. */
    visibility(visible) {
      if (!play) return;
      if (visible) {
        if (play.since === null) { play.since = o.now(); startTimer(); }
        return;
      }
      if (play.since === null) return;
      const s = take();
      play.since = null;
      stopTimer();
      o.send('play_end', { ...base(), play_mode: 'player', play_id: play.id, play_seconds: s, end_reason: 'hidden' }, true);
      play.reported = true;
    },
    /** For tests: the play in progress, if any. */
    get active() { return play ? { id: play.id, counting: play.since !== null } : null; },
  };
}

// The links the player and the page treat as a game's Play button (the same test as partials/vault-player.html).
const PLAY_LABEL = /^\s*(play( game| now)?|launch game)\s*$/i;

export function install(win = window) {
  const doc = win.document;
  const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
  const game = meta('vault:game');
  if (!game || typeof win.gtag !== 'function') return null;
  const gtag = win.gtag;
  // A user property, so the realtime report (which can't see event parameters) can tell which game someone is playing.
  const send = (name, params, beacon) => {
    if (name === 'play_start') gtag('set', 'user_properties', { vault_game: game });
    gtag('event', name, beacon ? { ...params, transport_type: 'beacon' } : params);
  };
  const tracker = createPlayTracker({
    send, game, studio: meta('vault:studio-slug'),
    now: () => Date.now(), every: (fn, ms) => win.setInterval(fn, ms), cancel: (h) => win.clearInterval(h),
    visible: () => doc.visibilityState !== 'hidden',
    newId: () => (win.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`),
  });
  // The player says when it opens and closes (partials/vault-player.html).
  doc.addEventListener('vault-player:open', () => tracker.start('player'));
  doc.addEventListener('vault-player:close', () => tracker.close());
  // A Play button the player leaves alone opens the game in a new tab (games that can't be shown in a frame).
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || a.hasAttribute('data-vault-play') || !PLAY_LABEL.test(a.textContent || '')) return;
    let url;
    try { url = new URL(a.getAttribute('href'), win.location.href); } catch { return; }
    if (url.host !== win.location.host && /^https?:$/.test(url.protocol)) tracker.start('new_tab');
  }, true);
  doc.addEventListener('visibilitychange', () => tracker.visibility(doc.visibilityState !== 'hidden'));
  win.addEventListener('pagehide', () => tracker.leave());
  return tracker;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') install();
