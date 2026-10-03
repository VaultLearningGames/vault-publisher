// The Play gate's decision, for the in-page player (partials/vault-player.html inlines this file): can a game start in
// the space this browser gives it, and if not, what would help? Pure, so it is unit-tested (test/play-gate.test.ts).
//
//   need  {w, h}  the game's smallest play area, in CSS pixels (the listing's min_width × min_height, or the site's
//                 default, hugo.toml params.play): the space below the player's bar, which is what the game gets.
//   have  {w, h}  the player's play area now.
//   opts  bar         height of the player's bar (it stays on top whichever way the device is turned)
//         turnable    a phone or tablet, which can be turned the other way
//         screen      {w, h} the whole screen, the right way round for how the device is held now
//         fullscreen  the player can go full screen here (the bar and the browser's own bars then go away)
//         largest     {w, h} the biggest viewport a window could have on this screen (its available area less the
//                     browser's own bars), for "make the window bigger"; screen less nothing when unknown
//
// Answers {verdict, ...}:
//   play        it fits: start the game
//   rotate      it fits if the device is turned (to: 'landscape' | 'portrait'; turned: the area it would have)
//   fullscreen  it fits on this screen in full screen (and in a bigger window)
//   resize      a bigger window on this screen would fit it (full screen isn't available)
//   small       nothing this device can do fits it
(function (root) {
  function size(v) { return v && v.w > 0 && v.h > 0 ? { w: Math.floor(v.w), h: Math.floor(v.h) } : null; }

  function decide(need, have, opts) {
    opts = opts || {};
    need = size(need);
    have = size(have) || { w: 0, h: 0 };
    if (!need) return { verdict: 'play' };                       // no minimum: never in the way
    var fits = function (a) { return !!a && a.w >= need.w && a.h >= need.h; };
    if (fits(have)) return { verdict: 'play' };
    var bar = Math.max(0, opts.bar || 0);
    if (opts.turnable) {
      // Turned the other way the window's sides swap, and the bar still takes its height off the top.
      var turned = { w: have.h + bar, h: Math.max(0, have.w - bar) };
      if (fits(turned)) return { verdict: 'rotate', to: turned.w > turned.h ? 'landscape' : 'portrait', turned: turned };
    }
    var screen = size(opts.screen);
    if (screen && opts.fullscreen && fits(screen)) return { verdict: 'fullscreen' };
    // A computer's window can be made bigger: up to the largest viewport its screen allows, less the bar.
    var largest = size(opts.largest) || screen;
    if (largest && !opts.turnable && fits({ w: largest.w, h: largest.h - bar })) return { verdict: 'resize' };
    return { verdict: 'small' };
  }

  // "1024,768" (the page's <meta name="vault:min-size">) → {w: 1024, h: 768}; anything else → null.
  function parseSize(s) {
    var m = /^\s*(\d+)\s*[,x×]\s*(\d+)\s*$/.exec(String(s || ''));
    return m ? size({ w: +m[1], h: +m[2] }) : null;
  }

  root.VaultPlayGate = { decide: decide, parseSize: parseSize };
})(typeof window !== 'undefined' ? window : globalThis);
