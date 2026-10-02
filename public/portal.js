// Vault Studio Portal: progressive enhancement for forms, dialogs and the registration snippet.
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

  // Listing image pickers (data-upload-image): upload the chosen file as soon as it's picked; the server saves its URL
  // in the draft, and here it goes into the field (screenshots: a new last line) and its preview, keeping other edits.
  document.addEventListener('change', async (e) => {
    const input = e.target;
    if (!input.dataset || !input.dataset.uploadImage) return;
    const file = input.files[0];
    const err = input.parentElement.querySelector('.err');
    const say = (msg, status) => { if (err) { err.classList.toggle('status', !!status); err.textContent = msg; } };
    if (!file) return;
    const max = Number(input.dataset.max);
    if (max && file.size > max) { say(`The image is too big: at most ${max / 1024 / 1024} MB.`); input.value = ''; return; }
    input.disabled = true;
    say('Uploading…', true);
    busy++;
    try {
      const res = await fetch(input.dataset.uploadImage, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Requested-With': 'vault-portal' },
        body: file,
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Something went wrong (HTTP ${res.status}).`);
      const field = document.getElementById(`f-${input.dataset.field}`);
      if (field) {
        if (field.tagName === 'TEXTAREA') {
          const lines = field.value.split('\n').map((l) => l.trim()).filter(Boolean);
          if (!lines.includes(body.url)) lines.push(body.url);
          field.value = lines.join('\n');
        } else field.value = body.url;
      }
      const prev = document.querySelector(`[data-prev-for="${input.dataset.field}"]`);
      if (prev) {
        const a = document.createElement('a');
        a.href = body.url; a.target = '_blank'; a.rel = 'noopener';
        const img = document.createElement('img');
        img.className = 'feat-thumb'; img.src = body.url; img.alt = '';
        a.append(img);
        if (field && field.tagName === 'TEXTAREA') prev.append(a); else prev.replaceChildren(a);
      }
      say('Uploaded and saved to the draft.', true);
    } catch (ex) {
      say(ex.message);
    } finally {
      busy--;
      input.disabled = false;
      input.value = '';
    }
  });

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
      if (w) w.hidden = open.dataset.type === 'tag';
      const er = dlg.querySelector('.err'); if (er) er.textContent = '';
      dlg.showModal();
      if (v) v.focus();
    }
    if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
  });

  // Register page: live workflow snippet.
  const data = document.getElementById('reg-data');
  if (data) {
    const snippets = JSON.parse(data.textContent);
    const game = document.getElementById('reg-game');
    const out = document.getElementById('reg-snippet');
    const echo = document.getElementById('reg-echo');
    const draw = () => {
      const slug = (game.value || 'my-game').toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const kind = document.querySelector('input[name=reg-kind]:checked').value;
      out.textContent = snippets[kind].replace(/GAME/g, slug);
      echo.textContent = slug;
    };
    game.addEventListener('input', draw);
    document.querySelectorAll('input[name=reg-kind]').forEach((r) => r.addEventListener('change', draw));
    draw();
    document.getElementById('reg-copy').addEventListener('click', (e) => {
      navigator.clipboard.writeText(out.textContent).then(() => { e.target.textContent = 'Copied'; }).catch(() => {
        const r = document.createRange(); r.selectNodeContents(out); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        e.target.textContent = 'Press ⌘C';
      });
    });
  }
})();
