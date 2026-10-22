// Vault Studio Portal: progressive enhancement for forms and dialogs. (The Upload builds page has its own setup.js.)
(function () {
  // Forms with data-api POST their fields as JSON to that URL. data-confirm asks first (in-page, no confirm()),
  // data-then="reload" reloads on success (data-then="/path" goes there; data-then="go" opens the url the API returns),
  // data-autosubmit submits when a select or checkbox changes (a checkbox flips back if that fails). Forms with
  // data-upload POST their file input's file as the request body to that URL.
  function formJson(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    }
    return out;
  }

  // While a request runs: spinner on the button, a status line (data-busy text) and every other button in the
  // same card/dialog disabled, so a slow production copy can't be double-submitted or contradicted mid-way.
  let busy = 0;
  window.addEventListener('beforeunload', (e) => { if (busy) e.preventDefault(); });
  async function submit(form, changed) {
    const err = form.querySelector('.err');
    const btn = form.querySelector('button:not([type=button])');
    const scope = form.closest('.card, dialog') || form;
    const locked = [...scope.querySelectorAll('button, input, select')].filter((el) => !el.disabled);
    if (err) { err.textContent = ''; err.classList.remove('status'); }
    if (btn) { btn.dataset.armed = ''; btn.dataset.label = btn.dataset.label || btn.textContent; }
    const fields = formJson(form);
    const upload = form.dataset.upload;
    const file = upload && form.querySelector('input[type=file]').files[0];
    if (upload && file && file.size > 2 * 1024 * 1024) { if (err) err.textContent = 'The image is too big: at most 2 MB.'; return; }
    locked.forEach((el) => { el.disabled = true; });
    if (btn) { btn.setAttribute('aria-busy', 'true'); btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Working…'; }
    if (err && form.dataset.busy) { err.classList.add('status'); err.textContent = form.dataset.busy; }
    busy++;
    try {
      const res = await fetch(upload || form.dataset.api, {
        method: 'POST',
        headers: { 'Content-Type': upload ? file.type || 'application/octet-stream' : 'application/json', 'X-Requested-With': 'vault-portal' },
        body: upload ? file : JSON.stringify(fields),
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Something went wrong (HTTP ${res.status}).`);
      busy--;
      if (form.dataset.then === 'go' && body.url) {
        if (btn) btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Done, opening…';
        location.href = body.url;
      } else if ((form.dataset.then || '').startsWith('/')) {
        if (btn) btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Done…';
        location.href = form.dataset.then;
      } else if (form.dataset.then === 'reload' || !form.hasAttribute('data-autosubmit')) {
        if (btn) btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Done, refreshing…';
        location.reload();
      } else {
        locked.forEach((el) => { el.disabled = false; });
        if (btn) { btn.removeAttribute('aria-busy'); btn.textContent = 'Saved'; }
      }
    } catch (e) {
      busy--;
      locked.forEach((el) => { el.disabled = false; });
      if (changed && changed.type === 'checkbox') changed.checked = !changed.checked;
      if (err) { err.classList.remove('status'); err.textContent = e.message; } else alert(e.message);
      if (btn) { btn.removeAttribute('aria-busy'); btn.textContent = btn.dataset.label; }
    }
  }

  // In-page confirmation: first click turns the button into "Click again to confirm".
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.dataset || !(form.dataset.api || form.dataset.upload)) return;
    e.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button:not([type=button])');
    if (form.dataset.confirm && btn && btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.dataset.label = btn.textContent;
      btn.textContent = 'Confirm';
      const err = form.querySelector('.err');
      if (err) { err.style.color = 'var(--ink-2)'; err.textContent = form.dataset.confirm; }
      setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; if (err) { err.textContent = ''; err.style.color = ''; } } }, 6000);
      return;
    }
    const err = form.querySelector('.err');
    if (err) err.style.color = '';
    submit(form);
  });
  document.addEventListener('change', (e) => {
    const form = e.target.form;
    if (!form || !form.hasAttribute('data-autosubmit') || (e.target.tagName !== 'SELECT' && e.target.type !== 'checkbox')) return;
    // data-open-after="id": ticking the box opens that accordion section once the page reloads.
    if (form.dataset.openAfter && e.target.type === 'checkbox') setOpen(form.dataset.openAfter, e.target.checked);
    submit(form, e.target);
  });

  // Accordions: a button with aria-controls="id" and aria-expanded shows and hides that element. Open sections are
  // remembered for this tab, so they stay open when a Save reloads the page.
  const OPEN_KEY = 'vault-portal-open';
  const openSet = () => { try { return new Set(JSON.parse(sessionStorage.getItem(OPEN_KEY) || '[]')); } catch (_) { return new Set(); } };
  function setOpen(id, open) {
    const s = openSet();
    if (open) s.add(id); else s.delete(id);
    try { sessionStorage.setItem(OPEN_KEY, JSON.stringify([...s])); } catch (_) { /* private mode: not remembered */ }
  }
  function show(btn, open) {
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    if (!panel) return;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
  const toggles = document.querySelectorAll('button.feat-open[aria-controls]');
  const remembered = openSet();
  toggles.forEach((btn) => show(btn, remembered.has(btn.getAttribute('aria-controls'))));
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button.feat-open[aria-controls]');
    if (!btn) return;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    show(btn, open);
    setOpen(btn.getAttribute('aria-controls'), open);
  });

  // Listing image pickers (data-upload-image) open the image tool, public/portal-image-tool.js (its own module).

  // The listing editor's "Made by" chooser (data-makers="its API"). The makers are checkboxes named makers:NAME, saved
  // in page order: the ticked ones, then every other studio. Here the unticked studios move into the "Add a studio…"
  // dropdown; choosing one ticks it and puts it last, and unticking a studio puts it back. "Add a new studio…" opens the
  // name and website fields ("Add studio" posts them), and "Create studio" (data-maker-create, click twice) makes a
  // studio of a maker that isn't one.
  document.querySelectorAll('[data-makers]').forEach((box) => {
    const chips = box.querySelector('.maker-chips');
    const select = box.querySelector('.maker-add select');
    if (!select) return; // read-only
    const fresh = box.querySelector('.maker-new');
    const [name, website] = fresh.querySelectorAll('input');
    const err = box.querySelector(':scope > .err');
    const say = (msg, status) => { err.style.color = ''; err.classList.toggle('status', !!status); err.textContent = msg; };
    const boxOf = (item) => item.querySelector('input');
    const nameOf = (item) => boxOf(item).name.slice('makers:'.length);
    const find = (n) => [...chips.children].find((item) => nameOf(item).trim().toLowerCase() === n.trim().toLowerCase());
    const refill = () => {
      select.querySelectorAll('option[data-studio]').forEach((o) => o.remove());
      for (const n of [...chips.children].filter((item) => item.hidden).map(nameOf).sort((a, b) => a.localeCompare(b))) {
        const o = new Option(n, n);
        o.dataset.studio = '';
        select.insertBefore(o, select.lastElementChild);
      }
      select.value = '';
    };
    const choose = (item) => { boxOf(item).checked = true; item.hidden = false; chips.append(item); refill(); };
    const close = () => { fresh.open = false; name.value = ''; website.value = ''; };
    // What follows a name that isn't a studio's ("not a studio yet"…); nothing once it is one.
    const note = (item, text) => {
      item.querySelectorAll('.maker-note, [data-maker-create]').forEach((el) => el.remove());
      item.toggleAttribute('data-studio', !text);
      if (!text) return;
      const span = document.createElement('span');
      span.className = 'maker-note';
      span.textContent = text;
      boxOf(item).parentElement.append(' ', span);
    };
    const post = async (fields) => {
      busy++;
      try {
        const res = await fetch(box.dataset.makers, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' },
          body: JSON.stringify(fields),
          credentials: 'same-origin',
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Something went wrong (HTTP ${res.status}).`);
        return body;
      } finally {
        busy--;
      }
    };
    for (const item of chips.children) item.hidden = !boxOf(item).checked;
    box.classList.add('js');
    refill();

    select.addEventListener('change', () => {
      const picked = select.value;
      if (picked === '+') { select.value = ''; fresh.open = true; name.focus(); return; }
      const item = picked && find(picked);
      if (item) { choose(item); say(`${picked} added. Save to keep it.`, true); }
    });
    chips.addEventListener('change', (e) => {
      const item = e.target.closest('.maker');
      if (e.target.checked || !item.hasAttribute('data-studio')) return;
      item.hidden = true;
      refill();
      say(`${nameOf(item)} taken off; it’s back in the list. Save to keep it off.`, true);
      select.focus();
    });
    box.addEventListener('click', async (e) => {
      if (e.target.closest('[data-maker-cancel]')) { close(); say(''); select.focus(); return; }
      const add = e.target.closest('[data-maker-add]');
      const create = e.target.closest('[data-maker-create]');
      if (add) {
        if (!name.value.trim()) { say('Give the studio a name.'); name.focus(); return; }
        if (!website.reportValidity()) return;
        add.disabled = true;
        try {
          const made = await post({ name: name.value, website: website.value });
          let item = find(made.name);
          if (!item) {
            item = document.createElement('span');
            item.className = 'maker';
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.name = `makers:${made.name}`;
            label.append(input, ` ${made.name}`);
            item.append(label);
          }
          note(item, made.note);
          choose(item);
          close();
          say(made.studio ? `${made.name} added. Save to keep it.` : `${made.name} added: ${made.note}. Save to send it to Vault.`, true);
          select.focus();
        } catch (ex) {
          say(ex.message);
        } finally {
          add.disabled = false;
        }
      } else if (create) {
        if (create.dataset.armed !== '1') {
          create.dataset.armed = '1';
          create.dataset.label = create.textContent;
          create.textContent = 'Confirm';
          say(`Create the studio ${create.dataset.makerCreate}${create.dataset.website ? ` (${create.dataset.website})` : ''}?`, true);
          setTimeout(() => { if (create.dataset.armed === '1') { create.dataset.armed = ''; create.textContent = create.dataset.label; say(''); } }, 6000);
          return;
        }
        create.dataset.armed = '';
        create.disabled = true;
        try {
          const made = await post({ name: create.dataset.makerCreate, website: create.dataset.website });
          note(create.closest('.maker'), made.note);
          say(`${made.name} is a studio now.`, true);
        } catch (ex) {
          create.disabled = false;
          create.textContent = create.dataset.label;
          say(ex.message);
        }
      }
    });
    // Enter in the new studio's fields adds the studio; it doesn't save the whole listing.
    fresh.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); fresh.querySelector('[data-maker-add]').click(); }
    });
  });

  // Listing preview buttons (data-preview): post the editor's current, unsaved fields and show the result on the
  // site. The tab is opened during the click (so popup blockers allow it) and pointed at the preview once it exists.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-preview]');
    if (!btn) return;
    const form = btn.form || btn.closest('form');
    const err = btn.parentElement.querySelector(':scope > .err') || (form && form.querySelector('.form-foot .err'));
    const say = (msg, status) => { if (err) { err.style.color = ''; err.classList.toggle('status', !!status); err.textContent = msg; } };
    const tab = window.open('about:blank', '_blank');
    if (tab) { try { tab.opener = null; tab.document.title = 'Preparing preview…'; tab.document.body.textContent = 'Preparing the preview…'; } catch (_) { /* cross-origin */ } }
    const label = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    say('Preparing the preview…', true);
    try {
      const res = await fetch(btn.dataset.preview, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' },
        body: JSON.stringify(formJson(form)),
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Something went wrong (HTTP ${res.status}).`);
      const url = body.urls[Number(btn.dataset.site) || 0].url;
      if (tab && !tab.closed) { tab.location.href = url; say('Preview opened in a new tab (it lasts 30 minutes; nothing was saved).', true); }
      else { say(''); if (err) { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open the preview'; err.classList.add('status'); err.append(a); } }
    } catch (ex) {
      if (tab && !tab.closed) tab.close();
      say(ex.message);
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = label;
    }
  });

  // Site checks: a click anywhere on a check's row (not on a link or a control) opens its details like its button, and
  // a #check-NAME address opens that check's. Each details table ([data-findings]) filters as you type, sorts by a
  // column (its header button; again for the other way), and copies the rows it shows as CSV.
  document.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-details]');
    if (!row || e.target.closest('a, button, input, summary, details')) return;
    const btn = row.querySelector('button.feat-open');
    if (btn) btn.click();
  });
  if (/^#check-[a-z]+$/.test(location.hash)) {
    const btn = document.querySelector(`${location.hash}[data-details] button.feat-open`);
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
  }
  document.querySelectorAll('[data-findings]').forEach((box) => {
    const body = box.querySelector('tbody');
    const rows = [...body.rows];
    const count = box.querySelector('[data-count]');
    const value = (td) => td.dataset.v || '';
    const shown = () => rows.filter((r) => !r.hidden);
    const say = (n) => { count.textContent = n === rows.length ? `${n} ${n === 1 ? 'thing' : 'things'}` : `${n} of ${rows.length}`; };
    box.querySelector('[data-filter]').addEventListener('input', (e) => {
      const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
      for (const r of rows) {
        const text = [...r.cells].map(value).join(' ').toLowerCase();
        r.hidden = !words.every((w) => text.includes(w));
      }
      say(shown().length);
    });
    box.querySelectorAll('[data-sort]').forEach((btn) => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.sort);
      const th = btn.closest('th');
      const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
      th.closest('tr').querySelectorAll('th').forEach((h) => h.setAttribute('aria-sort', 'none'));
      th.setAttribute('aria-sort', dir);
      const key = (r) => { const td = r.cells[i]; return td.dataset.s !== undefined ? Number(td.dataset.s) : value(td).toLowerCase(); };
      const sorted = rows.slice().sort((a, b) => {
        const x = key(a), y = key(b);
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return dir === 'ascending' ? c : -c;
      });
      body.append(...sorted);
    }));
    const copy = box.querySelector('[data-copy-csv]');
    copy.addEventListener('click', async () => {
      const field = (s) => { const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const head = [...box.querySelectorAll('thead th')].map((th) => field(th.textContent.trim()));
      const list = shown();
      const csv = [head.join(','), ...list.map((r) => [...r.cells].map((td) => field(value(td))).join(','))].join('\r\n') + '\r\n';
      const label = copy.dataset.label || (copy.dataset.label = copy.textContent);
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(csv);
        else {
          const t = document.createElement('textarea');
          t.value = csv; t.style.position = 'fixed'; t.style.opacity = '0';
          document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
        }
        copy.textContent = `Copied ${list.length} ${list.length === 1 ? 'row' : 'rows'}`;
      } catch (_) {
        copy.textContent = 'Couldn’t copy';
      }
      setTimeout(() => { copy.textContent = label; }, 2500);
    });
  });

  // Dialogs: buttons with data-open="id" fill the dialog's ref fields and open it.
  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) {
      const dlg = document.getElementById(open.dataset.open);
      if (!dlg) return;
      const ref = open.dataset.ref || '';
      dlg.querySelectorAll('input[name=ref]').forEach((i) => { i.value = ref; });
      dlg.querySelectorAll('[data-fill=ref]').forEach((el) => { el.textContent = ref; });
      const v = dlg.querySelector('input[name=version]');
      if (v) v.value = open.dataset.type === 'tag' ? ref : '';
      const w = dlg.querySelector('.warn-branch');
      if (w) w.hidden = open.dataset.type !== 'branch';
      const er = dlg.querySelector('.err'); if (er) er.textContent = '';
      dlg.showModal();
      if (v) v.focus();
    }
    if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
  });
})();

// The deploy bar (src/deploy-status.ts): while a deploy of this system runs, "Deploying: about N min left" and a
// progress bar from the time it has run over the time a run usually takes; while a portal action's deploy is
// scheduled, a line saying so. It asks once when the page loads, then every 15 s while it shows something, else every
// 60 s (another user's action schedules a deploy too). The portal is what's being deployed, so a request may fail while it
// restarts: then the bar keeps the last answer (also kept for the next page in sessionStorage) and asks again.
(function () {
  const bar = document.getElementById('deploy-bar');
  if (!bar) return;
  const POLL_MS = 15000, IDLE_POLL_MS = 60000, KEEP_MS = 10 * 60000, KEY = 'vault-deploy-status', DISMISSED = 'vault-deploy-dismissed';
  const LABEL = { portal: 'the portal and site', site: 'the site' };
  let state = null, timer = 0, clock = 0;
  const valid = (s) => s && Array.isArray(s.deploys);
  try { const s = bar.dataset.state && JSON.parse(bar.dataset.state); if (valid(s)) state = s; } catch (e) { /* none */ }
  if (!state) {
    try { const k = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (k && valid(k.state) && Date.now() - k.at < KEEP_MS) state = k.state; } catch (e) { /* none */ }
  }
  const dismissed = () => { try { return JSON.parse(sessionStorage.getItem(DISMISSED) || '[]'); } catch (e) { return []; } };
  const shown = () => (state ? state.deploys.filter((d) => d.state === 'running' || !dismissed().includes(d.url)) : []);
  const scheduled = () => (state && state.scheduled && state.scheduled.since ? state.scheduled : null);
  const runLink = (d, text) => {
    const a = document.createElement('a');
    if (/^https:\/\/github\.com\//.test(d.url || '')) a.href = d.url;
    a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
    return a;
  };

  // As formatDeployEta (src/deploy-eta.ts): relative to now, never a clock time.
  const etaText = (iso) => {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return null;
    const min = Math.ceil((t - Date.now()) / 60000);
    if (!(min > 0)) return 'It should be live shortly.';
    if (min < 60) return `Estimated completion in about ${min} min.`;
    const h = Math.floor(min / 60), m = min % 60;
    return `Estimated completion in about ${h} h${m ? ` ${m} min` : ''}.`;
  };

  function render() {
    const list = shown();
    bar.replaceChildren();
    bar.hidden = !list.length && !scheduled();
    if (scheduled()) {
      const row = document.createElement('div');
      row.className = 'deploy-row scheduled';
      const b = document.createElement('b');
      const eta = etaText(scheduled().deployEtaAt);
      b.textContent = 'A deploy is scheduled — some recent changes may not be live yet.' + (eta ? ` ${eta}` : '');
      if (eta) b.title = scheduled().deployEtaAt;
      row.append(b);
      bar.append(row);
    }
    for (const d of list) {
      const row = document.createElement('div');
      row.className = 'deploy-row';
      const b = document.createElement('b');
      const what = document.createElement('span');
      what.textContent = `(${LABEL[d.kind] || d.kind})`;
      if (d.state === 'failed') {
        row.classList.add('failed');
        b.textContent = 'Deploy failed';
        const x = document.createElement('button');
        x.type = 'button'; x.className = 'deploy-x'; x.textContent = '×'; x.setAttribute('aria-label', 'Dismiss');
        x.addEventListener('click', () => {
          try { sessionStorage.setItem(DISMISSED, JSON.stringify(dismissed().concat(d.url).slice(-20))); } catch (e) { /* ignore */ }
          render();
        });
        row.append(b, what, runLink(d, 'View the run'), x);
      } else {
        const elapsed = Math.max(0, (Date.now() - Date.parse(d.startedAt)) / 1000);
        const expected = Math.max(1, Number(d.expectedSeconds) || 180);
        const left = expected - elapsed;
        b.textContent = left > 0 ? `Deploying: about ${Math.max(1, Math.ceil(left / 60))} min left` : 'Deploying: taking longer than usual';
        if (left <= 0) row.classList.add('late');
        const track = document.createElement('div');
        track.className = 'deploy-track';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
        const pct = Math.min(100, Math.round((elapsed / expected) * 100));
        track.setAttribute('aria-valuenow', String(pct));
        const fill = document.createElement('div');
        fill.className = 'deploy-fill'; fill.style.width = `${pct}%`;
        track.append(fill);
        row.append(b, what, track, runLink(d, 'Details'));
      }
      bar.append(row);
    }
    clearInterval(clock);
    if (list.some((d) => d.state === 'running')) clock = setInterval(render, 5000);
    else if (scheduled() && scheduled().deployEtaAt) clock = setInterval(render, 60000);
    return list.length > 0 || !!scheduled();
  }

  async function poll() {
    try {
      const res = await fetch(bar.dataset.src, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const s = res.ok ? await res.json() : null;
      if (valid(s)) {
        state = s;
        try { sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), state })); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* restarting: keep the last answer */ }
    clearTimeout(timer);
    timer = setTimeout(poll, render() ? POLL_MS : IDLE_POLL_MS);
  }
  render();
  poll();
})();

// The sidebar fits the viewport (portal.css .side): while the staging banner or deploy bar above it is in view, it starts
// that far down the screen, so it's that much shorter and the signed-in user at its foot stays on screen.
(function () {
  const shell = document.querySelector('.shell');
  if (!shell || !shell.querySelector(':scope > .side')) return;
  const root = document.documentElement;
  let frame = 0;
  function update() {
    frame = 0;
    const top = Math.max(0, Math.round(shell.getBoundingClientRect().top));
    root.style.setProperty('--side-offset', top + 'px');
  }
  const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(queue);   // the banners wrap, and the deploy bar shows and hides
    for (let el = shell.previousElementSibling; el; el = el.previousElementSibling) ro.observe(el);
  }
  update();
})();

// Staging banner: count down to the next sync from production.
(function () {
  const el = document.querySelector('.env-sync[data-sync-at]');
  if (!el) return;
  const out = el.querySelector('.env-sync-left');
  const at = () => new Date(el.getAttribute('data-sync-at')).getTime();
  const DAY = 86400000;
  const tick = () => {
    let ms = at() - Date.now();
    if (ms <= 0 && ms > -30 * 60000) { out.textContent = 'syncing now, reload in a few minutes'; return; }
    while (ms <= 0) ms += DAY;   // the page was rendered before an earlier sync: count to the next daily one
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
    out.textContent = 'in ' + (h ? h + ' h ' : '') + (m % 60) + ' min';
  };
  tick(); setInterval(tick, 30000);
})();

// Character counters (the SEO fields of the listing editor): an input or textarea with data-count shows its live
// length in the span whose id is its own id plus "-count" ("123 / 160"); over the recommended length it goes red.
(function () {
  for (const input of document.querySelectorAll('input[data-count], textarea[data-count]')) {
    const out = document.getElementById(`${input.id}-count`);
    if (!out) continue;
    const max = Number(input.getAttribute('data-count')) || 0;
    const update = () => {
      out.textContent = `${input.value.length}` + (max ? ` / ${max}` : '');
      out.classList.toggle('over', max > 0 && input.value.length > max);
    };
    input.addEventListener('input', update);
    update();
  }
})();

// Build number under the logo (build-info.ts, via /api/build-info): which deploy built this portal, for
// debugging. Every .portal-build (the sidebar's and the sign-in page's) gets the text "build <build>" and a
// title with the full SHA and build time (the time omitted when unknown). A failed fetch or bad answer just
// leaves the line empty: it never throws and never blocks the rest of the portal.
(function () {
  const els = document.querySelectorAll('.portal-build');
  if (!els.length) return;
  (async () => {
    try {
      const res = await fetch('/api/build-info', { credentials: 'same-origin' });
      if (!res.ok) return;
      const info = await res.json();
      if (!info || typeof info.build !== 'string') return;
      const title = [typeof info.sha === 'string' ? info.sha : '', typeof info.builtAt === 'string' ? info.builtAt : ''].filter(Boolean).join(' · ');
      for (const el of els) {
        el.textContent = `build ${info.build}`;
        if (title) el.setAttribute('title', title);
      }
    } catch { /* no build info: leave the line empty */ }
  })();
})();
