// Analytics pages: the date range picker (a preset fills in its dates, editing a date picks Custom); the realtime card,
// refreshed every minute while the page is on screen, and its map made zoomable (buttons, double-click, pinch or
// ctrl/⌘-scroll, drag to pan), keeping the view across refreshes (src/portal/analytics.ts).
(function () {
  var box = document.querySelector('.ga-dates');
  if (!box) return;
  var form = box.querySelector('form'), start = form.querySelector('[name=start]'), end = form.querySelector('[name=end]');
  var custom = form.querySelector('[name=range][value=custom]');
  function check() {
    var days = (Date.parse(end.value) - Date.parse(start.value)) / 86400000;
    end.setCustomValidity(start.value && end.value && days < 0 ? 'The end date is before the start date.'
      : days >= 3 * 366 ? 'Pick at most three years.' : '');
  }
  form.addEventListener('change', function (e) {
    var t = e.target;
    if (t.name === 'range' && t.value !== 'custom') { start.value = t.getAttribute('data-start'); end.value = t.getAttribute('data-end'); }
    if (t === start || t === end) custom.checked = true;
    check();
  });
  // Keep the address short: a preset needs no dates, and comparing (the default) needs no compare.
  form.addEventListener('submit', function () {
    var r = form.querySelector('[name=range]:checked');
    if (r && r.value !== 'custom') start.disabled = end.disabled = true;
    var cmp = form.querySelectorAll('[name=compare]');
    if (cmp[1].checked) cmp[0].disabled = cmp[1].disabled = true;
  });
  function close() { form.reset(); check(); box.open = false; }
  box.querySelector('[data-cancel]').addEventListener('click', close);
  document.addEventListener('click', function (e) { if (box.open && !box.contains(e.target)) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.open) { close(); box.querySelector('summary').focus(); } });
})();

(function () {
  var box = document.querySelector('[data-realtime]');
  if (!box) return;
  var view = null;   // { x, y, w } of the map's viewBox; null: the whole world

  function setup() {
    var map = box.querySelector('[data-map]');
    if (!map) return;
    var svg = map.querySelector('svg');
    var size = map.getAttribute('data-map').split(' ').map(Number), W = size[0], H = size[1];
    var dots = svg.querySelectorAll('circle[data-r]');
    function apply() {
      var v = view || { x: 0, y: 0, w: W };
      map.classList.toggle('zoomed', !!view);
      svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.w * H / W);
      var z = W / v.w;
      for (var i = 0; i < dots.length; i++) dots[i].setAttribute('r', (+dots[i].getAttribute('data-r') / Math.pow(z, 0.75)).toFixed(2));
    }
    function clamp(v) {
      var w = Math.max(W / 16, Math.min(W, v.w)), h = w * H / W;
      return w >= W ? null : { x: Math.max(0, Math.min(W - w, v.x)), y: Math.max(0, Math.min(H - h, v.y)), w: w };
    }
    // Zoom by factor f (>1: in) about a point given as fractions of the map's width and height.
    function zoom(f, fx, fy) {
      var v = view || { x: 0, y: 0, w: W }, w = v.w / f;
      view = clamp({ x: v.x + (v.w - w) * fx, y: v.y + (v.w - w) * H / W * fy, w: w });
      apply();
    }
    function frac(e) { var r = svg.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; }
    map.querySelector('.ga-zoom').hidden = false;
    map.querySelector('.ga-zoom').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var k = b.getAttribute('data-zoom');
      if (k === 'reset') { view = null; apply(); } else zoom(k === 'in' ? 2 : 0.5, 0.5, 0.5);
    });
    svg.addEventListener('dblclick', function (e) { var f = frac(e); zoom(e.shiftKey ? 0.5 : 2, f[0], f[1]); });
    svg.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.metaKey) return;   // plain scrolling still scrolls the page
      e.preventDefault();
      var f = frac(e); zoom(Math.exp(-e.deltaY / 200), f[0], f[1]);
    }, { passive: false });
    var drag = null;
    svg.addEventListener('pointerdown', function (e) {
      if (!view) return;
      drag = { x: e.clientX, y: e.clientY, v: view, scale: view.w / svg.getBoundingClientRect().width };
      svg.setPointerCapture(e.pointerId); svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', function (e) {
      if (!drag) return;
      view = clamp({ x: drag.v.x - (e.clientX - drag.x) * drag.scale, y: drag.v.y - (e.clientY - drag.y) * drag.scale, w: drag.v.w });
      apply();
    });
    function end() { drag = null; svg.classList.remove('dragging'); }
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    apply();
  }
  setup();

  if (!window.fetch) return;
  var url = box.getAttribute('data-realtime');
  function refresh() {
    if (document.visibilityState === 'hidden') return;
    fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'vault-portal' } })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (h) { if (h !== null) { box.innerHTML = h; setup(); } })
      .catch(function () {});
  }
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
})();

// Top games: Load more asks for the next page (offset: the rows shown) and appends its rows, skipping any already
// shown; the button goes once every game is listed. A failed request says so and leaves the button to try again.
(function () {
  if (!window.fetch) return;
  var buttons = document.querySelectorAll('[data-more]');
  Array.prototype.forEach.call(buttons, function (btn) {
    var card = btn.closest('.ga-games'), body = card.querySelector('tbody'), status = btn.parentNode.querySelector('[role=status]');
    var busy = false;
    btn.addEventListener('click', function () {
      if (busy) return;
      busy = true; btn.disabled = true; btn.textContent = 'Loading…'; status.textContent = '';
      // The offset counts the games' rows only: the pinned Total row has no data-slug.
      var url = btn.getAttribute('data-more'), shown = body.querySelectorAll('tr[data-slug]').length;
      url += (url.indexOf('?') < 0 ? '?' : '&') + 'offset=' + shown + '&limit=' + btn.getAttribute('data-limit');
      fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'vault-portal', Accept: 'application/json' } })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (d) {
          var have = {};
          Array.prototype.forEach.call(body.querySelectorAll('tr[data-slug]'), function (tr) { have[tr.getAttribute('data-slug')] = true; });
          var t = document.createElement('tbody');
          d.items.forEach(function (g) {
            if (have[g.slug]) return;
            have[g.slug] = true;
            t.innerHTML = g.html;
            if (t.firstElementChild) body.appendChild(t.firstElementChild);
          });
          if (!d.hasMore || !d.items.length) btn.parentNode.removeChild(btn);
          status.textContent = body.querySelectorAll('tr[data-slug]').length + ' of ' + d.total + ' games';
        })
        .catch(function () { status.textContent = 'Couldn’t load more games. Try again.'; })
        .then(function () { busy = false; btn.disabled = false; btn.textContent = 'Load more'; });
    });
  });
})();
