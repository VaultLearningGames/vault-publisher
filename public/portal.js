// Vault Studio Portal: progressive enhancement for forms, dialogs and the registration snippet.
(function () {
  // Forms with data-api POST their fields as JSON to that URL. data-confirm asks first (in-page, no confirm()),
  // data-then="reload" reloads on success, data-autosubmit submits when a select or checkbox changes (a checkbox flips
  // back if that fails). Forms with data-upload POST their file input's file as the request body to that URL.
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
      if (form.dataset.then === 'reload' || !form.hasAttribute('data-autosubmit')) {
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
    if (form && form.hasAttribute('data-autosubmit') && (e.target.tagName === 'SELECT' || e.target.type === 'checkbox')) submit(form, e.target);
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
