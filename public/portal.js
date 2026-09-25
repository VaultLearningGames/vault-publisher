// Vault Studio Portal: progressive enhancement for forms, dialogs and the registration snippet.
(function () {
  // Forms with data-api POST their fields as JSON to that URL. data-confirm asks first (in-page, no confirm()),
  // data-then="reload" reloads on success, data-autosubmit submits when a select changes.
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

  async function submit(form) {
    const err = form.querySelector('.err');
    const btn = form.querySelector('button:not([type=button])');
    if (err) err.textContent = '';
    if (btn) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = 'Working…'; }
    try {
      const res = await fetch(form.dataset.api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' },
        body: JSON.stringify(formJson(form)),
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Something went wrong (HTTP ${res.status}).`);
      if (form.dataset.then === 'reload' || !form.hasAttribute('data-autosubmit')) location.reload();
      else if (btn) btn.textContent = 'Saved';
    } catch (e) {
      if (err) err.textContent = e.message; else alert(e.message);
      if (btn) { btn.removeAttribute('aria-busy'); btn.disabled = false; btn.textContent = btn.dataset.label; }
    }
  }

  // In-page confirmation: first click turns the button into "Click again to confirm".
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.dataset || !form.dataset.api) return;
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
    if (form && form.hasAttribute('data-autosubmit') && e.target.tagName === 'SELECT') submit(form);
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
