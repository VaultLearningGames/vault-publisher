/* Vault (original design): the little behaviour the pages need. No dependencies. */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var $ = function (s, el) { return (el || doc).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || doc).querySelectorAll(s)); };

  /* Header: keep --hh equal to the header's height (sections start below the fixed header); burger menu. */
  var header = $('#header');
  function headerHeight() { if (header) root.style.setProperty('--hh', $('.hdr-inner', header).getBoundingClientRect().height + 'px'); }
  headerHeight();
  window.addEventListener('resize', headerHeight);
  var burger = $('.hdr-burger');
  if (burger) burger.addEventListener('click', function () {
    var open = root.classList.toggle('menu-open');
    burger.setAttribute('aria-expanded', open);
    burger.setAttribute('aria-label', open ? 'Close Menu' : 'Open Menu');
  });
  doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && root.classList.contains('menu-open')) burger.click(); });

  /* Accordions: one item open at a time. */
  $$('.sq-acc').forEach(function (acc) {
    acc.addEventListener('click', function (e) {
      var btn = e.target.closest('.acc-btn'); if (!btn) return;
      var item = btn.closest('.acc-item'), open = !item.classList.contains('is-open');
      $$('.acc-item.is-open', acc).forEach(function (i) { i.classList.remove('is-open'); $('.acc-btn', i).setAttribute('aria-expanded', 'false'); });
      item.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', String(open));
    });
  });

  /* Scaled text: a heading sized to fill its block's width, as Squarespace's "scaled text" does. */
  function scaleText() {
    $$('.sqsrte-scaled-text-container').forEach(function (c) {
      var t = $('.sqsrte-scaled-text', c); if (!t) return;
      t.style.fontSize = '100px';
      var w = t.getBoundingClientRect().width, cw = c.getBoundingClientRect().width;
      if (w && cw) t.style.fontSize = (100 * cw / w) + 'px';
    });
  }
  scaleText(); window.addEventListener('resize', scaleText);
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(scaleText);

  /* Highlighted words: a hand-drawn curved underline, the shape Squarespace's "underline curve" text highlight draws
     (a slight rise across the word ending in a small hook), redrawn to each word's size. */
  function squiggles() {
    $$('.hl-underline-curve').forEach(function (h) {
      var r = h.getBoundingClientRect(), w = r.width + 2, fs = parseFloat(getComputedStyle(h).fontSize) || 22, y = r.height - 0.03 * fs;
      var svg = $('.sq-squiggle', h);
      if (!svg) { svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'sq-squiggle'); svg.setAttribute('aria-hidden', 'true'); svg.appendChild(doc.createElementNS('http://www.w3.org/2000/svg', 'path')); h.appendChild(svg); }
      var k = fs / 22, d = 'M -1,' + y.toFixed(2) +
        ' c ' + (w * .125) + ',' + (-.77 * k) + ' ' + (w * .25) + ',' + (-2.38 * k) + ' ' + (w * .5) + ',' + (-3.08 * k) +
        ' c ' + (w * .25) + ',' + (-.7 * k) + ' ' + (w * .38) + ',0 ' + (w * .5) + ',' + (.28 * k) +
        ' c ' + (w * .024) + ',' + (.056 * k) + ' ' + (-w * .019) + ',' + (.798 * k) + ' ' + (-w * .02) + ',' + (.84 * k);
      svg.firstChild.setAttribute('d', d);
    });
  }
  squiggles(); window.addEventListener('resize', squiggles);
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(squiggles);

  /* The animated background's pause button. */
  $$('.sq-gen-pause').forEach(function (b) {
    b.addEventListener('click', function () {
      var on = b.closest('.sq-sec').classList.toggle('is-paused');
      b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Play background animation' : 'Pause background animation');
    });
  });

  /* Forms that aren't connected yet (params.forms.* empty) say so instead of posting. */
  $$('form[data-unconnected]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var m = $('.news-msg, .form-msg', f); if (m) m.hidden = false;
    });
  });

  /* Connected forms (data-vault-form): post to the Vault Studio Portal (/v1/forms/newsletter, /v1/forms/submit-game) with
     fetch and show the outcome the way the Squarespace blocks do (checked against vaultlearninggames.org's own scripts):
     - Join Vault (.news-form): while sending, a spinner replaces the button label; on success everything in the form
       is hidden and only "Thank you!" shows; an error is a red box (.field-error) above the fields.
     - Submit a Game (.sub-form): required fields are checked first (a red pill under each label that's missing, plus
       one at the top of the form); while sending, a pulsing dot replaces the button label; on success the form is
       hidden and "Thank you!" shows in its place; an error is the red pill at the top.
     Without JavaScript the forms post normally and the portal sends people back with #form-submitted or #form-error,
     which is shown on page load. */
  var ICON = '<svg width="15" height="15" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M7 1.556A5.444 5.444 0 1 0 7 12.444 5.444 5.444 0 0 0 7 1.556ZM0 7a7 7 0 1 1 14 0A7 7 0 0 1 0 7Z" fill="#fff"/><path d="M6.222 8.556V3.111h1.556v5.445H6.222ZM6.222 9.333h1.556v1.556H6.222Z" fill="#fff"/></svg>';
  var MSG = {
    news: 'Error processing form submission. Please reload and try again.',   /* Squarespace's own wording */
    sub: 'There was an error submitting the form.',
    required: '{0} is required.',
    email: 'Email addresses should follow the format user@domain.com.'
  };
  function isNews(f) { return f.classList.contains('news-form'); }
  function clearErrors(f) {
    $$('.field-error, .form-field-error', f).forEach(function (e) { e.parentNode.removeChild(e); });
    $$('[aria-invalid]', f).forEach(function (e) { e.removeAttribute('aria-invalid'); e.removeAttribute('aria-describedby'); });
  }
  function pill(text, id) {
    var p = doc.createElement('p'); p.className = 'form-field-error'; if (id) p.id = id;
    p.innerHTML = ICON; p.appendChild(doc.createTextNode(text)); return p;
  }
  function formError(f, text) {
    var e;
    if (isNews(f)) { e = doc.createElement('div'); e.className = 'field-error'; e.textContent = text; var fl = $('.news-fields', f); fl.parentNode.insertBefore(e, fl); }
    else { e = pill(text); e.classList.add('form-field-error--top'); f.insertBefore(e, f.firstChild); }
    e.setAttribute('role', 'alert'); e.setAttribute('tabindex', '-1'); e.focus({ preventScroll: isNews(f) });
  }
  function showSuccess(f) {
    clearErrors(f);
    var box = f.closest('.sq-form');   /* Squarespace's form block keeps its size: "Thank you!" sits at the top of it */
    if (box) box.style.minHeight = box.getBoundingClientRect().height + 'px';
    Array.prototype.forEach.call(f.children, function (c) { c.hidden = true; });
    var m = $('.news-msg, .form-msg', f); m.hidden = false;
    if (!isNews(f)) f.closest('.sq-form, .fb, section').scrollIntoView({ block: 'start' });
    else m.scrollIntoView({ block: 'nearest' });
  }
  function labelText(item) {
    var l = $('.form-label', item); if (!l) return '';
    var c = l.cloneNode(true); $$('.req', c).forEach(function (r) { r.remove(); }); return c.textContent.trim();
  }
  /* Submit a Game: the required fields (the form is novalidate so the checks look like Squarespace's, not the browser's). */
  function validate(f) {
    var first = null;
    $$('.form-item', f).forEach(function (item, i) {
      var inputs = $$('input, textarea', item), el = inputs[0]; if (!el) return;
      var need = inputs.some(function (x) { return x.required; }), bad = '';
      if (el.type === 'radio' || el.type === 'checkbox') { if (need && !inputs.some(function (x) { return x.checked; })) bad = MSG.required; }
      else if (need && !el.value.trim()) bad = MSG.required;
      else if (el.type === 'email' && el.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim())) bad = MSG.email;
      if (!bad) return;
      var id = 'err-' + (el.name || i), p = pill(bad.replace('{0}', labelText(item)), id);
      $('.form-label', item).insertAdjacentElement('afterend', p);
      inputs.forEach(function (x) { x.setAttribute('aria-invalid', 'true'); x.setAttribute('aria-describedby', id); });
      if (!first) first = el;
    });
    if (first) { formError(f, MSG.sub); first.focus(); }
    return !first;
  }
  function lock(f, on) {
    var b = $('[type=submit]', f), l = $('.news-btn-label', f);
    f.classList.toggle('submitting', on); b.disabled = on;
    if (on) b.setAttribute('aria-label', 'Submitting…'); else b.removeAttribute('aria-label');
    if (l) { if (on) { l.dataset.text = l.textContent; l.textContent = 'Submitting…'; } else if (l.dataset.text) l.textContent = l.dataset.text; }
  }
  $$('form[data-vault-form]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.fetch || !window.FormData) return;          /* very old browser: the normal POST + redirect */
      e.preventDefault();
      if (f.classList.contains('submitting')) return;
      clearErrors(f);
      if (!isNews(f) && !validate(f)) return;
      lock(f, true);
      fetch(f.action, { method: 'POST', body: new FormData(f), headers: { Accept: 'application/json' } })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            lock(f, false);
            if (r.ok && d && d.ok) { f.reset(); showSuccess(f); }
            else formError(f, (d && d.error) || (isNews(f) ? MSG.news : MSG.sub));
          });
        }, function () { lock(f, false); formError(f, isNews(f) ? MSG.news : MSG.sub); });
    });
  });
  /* After a no-JavaScript post: #form-submitted / #form-error, for the page's Submit a Game form if it has one,
     otherwise its (last) Join Vault sign-up. */
  function fromHash() {
    var h = location.hash; if (h !== '#form-submitted' && h !== '#form-error') return;
    var all = $$('form[data-vault-form]'), f = $('form.sub-form[data-vault-form]') || all[all.length - 1];
    if (f) { if (h === '#form-submitted') showSuccess(f); else { clearErrors(f); formError(f, isNews(f) ? MSG.news : MSG.sub); f.scrollIntoView({ block: 'center' }); } }
    if (history.replaceState) history.replaceState(history.state, '', location.pathname + location.search);
  }
  fromHash();
  window.addEventListener('hashchange', fromHash);

  /* Marquee: the heading scrolls sideways along a wave (an SVG textPath), like the Squarespace marquee block. */
  $$('.sq-marquee').forEach(function (mq) {
    var h = $('.mq-text', mq); if (!h) return;
    var items = $$('.mq-item', h).map(function (s) { return s.textContent; });
    var text = items.join('   ') + '   ';
    var amp = parseFloat(mq.dataset.amp) || 0, freq = parseFloat(mq.dataset.freq) || 0;
    var speed = parseFloat(mq.dataset.speed) || 1, dir = mq.dataset.dir === 'right' ? 1 : -1;
    var NS = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(NS, 'svg'), path = doc.createElementNS(NS, 'path');
    var id = 'mq' + Math.random().toString(36).slice(2);
    path.setAttribute('id', id); path.setAttribute('fill', 'none');
    var txt = doc.createElementNS(NS, 'text'), tp = doc.createElementNS(NS, 'textPath');
    tp.setAttribute('href', '#' + id); txt.appendChild(tp); svg.appendChild(path); svg.appendChild(txt);
    svg.setAttribute('aria-hidden', 'true');
    h.appendChild(svg); mq.classList.add('is-svg');
    var unit = 0, W = 0, H = 0, fs = 0, offset = 0, last = 0;
    function build() {
      fs = parseFloat(getComputedStyle(h).fontSize);
      W = mq.clientWidth; var a = amp / 100 * fs * 0.5; H = fs * 1.4 + 2 * a;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('height', H);
      var meas = doc.createElementNS(NS, 'text'); meas.textContent = text; svg.appendChild(meas);
      unit = meas.getComputedTextLength() || fs * text.length * 0.5; svg.removeChild(meas);
      var copies = Math.ceil((W * 1.6) / unit) + 2, total = unit * copies, d = 'M' + (-unit) + ' ' + (H / 2 + fs * 0.35);
      var wl = freq > 0 ? fs * 60 / freq : 0;   /* wave length in proportion to the type, as on Squarespace */
      for (var x = -unit; x <= total; x += 8) {
        var y = H / 2 + fs * 0.35 + (wl ? a * Math.sin((x / wl) * 2 * Math.PI) : 0);
        d += ' L' + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      path.setAttribute('d', d);
      tp.textContent = new Array(copies + 1).join(text);
    }
    build(); window.addEventListener('resize', build);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(build);
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    function tick(t) {
      if (last) offset = (offset + dir * speed * 60 * (t - last) / 1000 + unit) % unit;
      last = t; tp.setAttribute('startOffset', (offset).toFixed(1));
      if (!reduce) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });

  /* All Games grid on the home page: Grade / Subject / Maker (any selected value within a filter, all filters
     together), search, and 30 per page. The state lives in the URL query (?grade=5-8&subject=Math&page=2). */
  $$('.gg').forEach(function (gg) {
    var items = $$('.gg-item', gg), size = +gg.dataset.pageSize || 30, pager = $('.gg-pages', gg);
    var filters = $('.gg-filters', gg), search = $('.gg-search input', gg), empty = $('.gg-empty', gg);
    var sel = { grade: [], subject: [], maker: [] }, q = '', page = 1;
    var params = new URLSearchParams(location.search);
    Object.keys(sel).forEach(function (k) { sel[k] = params.getAll(k); });
    q = params.get('q') || ''; page = +params.get('page') || 1;
    if (search) search.value = q;
    function sync() {
      var p = new URLSearchParams();
      Object.keys(sel).forEach(function (k) { sel[k].forEach(function (v) { p.append(k, v); }); });
      if (q) p.set('q', q); if (page > 1) p.set('page', page);
      var s = p.toString(); history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + location.hash);
    }
    function labels() {
      $$('.gg-dd', gg).forEach(function (dd) {
        var k = dd.dataset.filter, v = sel[k];
        $('.gg-dd-val', dd).textContent = ' : ' + (v.length ? v.join(', ') : 'All');
        $$('.gg-dd-list button', dd).forEach(function (b) { b.setAttribute('aria-selected', String(v.indexOf(b.dataset.val) >= 0)); });
      });
    }
    function apply(scroll) {
      var shown = items.filter(function (it) {
        for (var k in sel) {
          if (!sel[k].length) continue;
          var have = (it.getAttribute('data-' + k) || '').split('|');
          if (!sel[k].some(function (v) { return have.indexOf(v) >= 0; })) return false;
        }
        return !q || it.dataset.text.indexOf(q.toLowerCase()) >= 0;
      });
      var pages = Math.max(1, Math.ceil(shown.length / size)); if (page > pages) page = pages;
      items.forEach(function (it) { it.hidden = true; });
      shown.slice((page - 1) * size, page * size).forEach(function (it) { it.hidden = false; });
      empty.hidden = shown.length > 0;
      pager.innerHTML = '';
      if (pages > 1) for (var i = 1; i <= pages; i++) {
        var b = doc.createElement('button'); b.type = 'button'; b.textContent = i;
        if (i === page) b.setAttribute('aria-current', 'page');
        b.addEventListener('click', (function (n) { return function () { page = n; apply(true); }; })(i));
        pager.appendChild(b);
      }
      labels(); sync();
      if (scroll) gg.scrollIntoView({ block: 'start' });
    }
    $$('.gg-dd', gg).forEach(function (dd) {
      var t = $('.gg-dd-toggle', dd);
      t.addEventListener('click', function () {
        var open = !dd.classList.contains('is-open');
        $$('.gg-dd.is-open', gg).forEach(function (o) { o.classList.remove('is-open'); $('.gg-dd-toggle', o).setAttribute('aria-expanded', 'false'); });
        dd.classList.toggle('is-open', open); t.setAttribute('aria-expanded', String(open));
      });
      $$('.gg-dd-list button', dd).forEach(function (b) {
        b.addEventListener('click', function () {
          var k = dd.dataset.filter, v = b.dataset.val, i = sel[k].indexOf(v);
          if (i >= 0) sel[k].splice(i, 1); else sel[k].push(v);
          page = 1; apply(false);
        });
      });
    });
    doc.addEventListener('click', function (e) {
      if (!e.target.closest('.gg-dd')) $$('.gg-dd.is-open', gg).forEach(function (o) { o.classList.remove('is-open'); $('.gg-dd-toggle', o).setAttribute('aria-expanded', 'false'); });
    });
    if (search) search.addEventListener('input', function () { q = search.value.trim(); page = 1; apply(false); });
    /* Phones (up to 500px wide): the filters are a panel that Filter slides in and its X (or Escape) closes. */
    var trig = $('.gg-mobile-trigger', gg), close = $('.gg-panel-close', gg);
    function panel(open, focus) {
      if (open === filters.classList.contains('is-open')) return;
      filters.classList.toggle('is-open', open); root.classList.toggle('gg-panel-open', open);
      if (trig) trig.setAttribute('aria-expanded', String(open));
      if (!open) $$('.gg-dd.is-open', gg).forEach(function (o) { o.classList.remove('is-open'); $('.gg-dd-toggle', o).setAttribute('aria-expanded', 'false'); });
      if (focus) { var f = open ? $('.gg-dd-toggle', filters) : trig; if (f) f.focus({ preventScroll: true }); }
    }
    if (trig) trig.addEventListener('click', function () { panel(true, true); });
    if (close) close.addEventListener('click', function () { panel(false, true); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && filters.classList.contains('is-open')) panel(false, true); });
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width: 501px)'), onWide = function () { if (wide.matches) panel(false, false); };
      if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
    }
    apply(false);
  });

  /* /game-cards: 20 cards per page with Squarespace's ?offset=<ms> links (the date of the last card shown). */
  $$('.blog-grid').forEach(function (grid) {
    var items = $$('.blog-item', grid), size = +grid.dataset.pageSize || 20;
    var older = $('.blog-older'), newer = $('.blog-newer');
    var off = +new URLSearchParams(location.search).get('offset') || 0, start = 0;
    if (off) { start = items.findIndex(function (it) { return +it.dataset.offset < off; }); if (start < 0) start = items.length; }
    items.forEach(function (it, i) { it.hidden = i < start || i >= start + size; });
    if (start + size < items.length) { older.hidden = false; older.href = location.pathname + '?offset=' + items[start + size - 1].dataset.offset; }
    if (start > 0) {
      newer.hidden = false;
      var prev = start - size;
      newer.href = prev <= 0 ? location.pathname : location.pathname + '?offset=' + items[prev - 1].dataset.offset;
    }
  });
})();
