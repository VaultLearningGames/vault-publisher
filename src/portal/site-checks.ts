// Vault → Site checks: the battery of tests run against the live website (games load, missing assets, broken links,
// spelling, large files and slow loading, responsive design, game services; see site-checks.ts). The check-site workflow runs them
// on a GitHub runner and posts each finished run (POST /v1/admin/site-checks); this shows the latest run and the
// recent ones. Each check's row opens a table of what it found in that run (one row per problem, with the columns
// that make it actionable for that check: a missing file, its answer, the element that asks for it and the pages
// it is on, …), filterable and sortable in the page (portal.js, [data-findings]) and as CSV.
import type { Hono } from 'hono';
import type { SiteCheckRow } from '../db.ts';
import { CHECK_LABEL, CHECKS, MAX_PER_CHECK, type CheckName, type CheckSummary, type Finding, type SiteCheckRun } from '../site-checks.ts';
import { html, type Html } from './html.ts';
import type { ListingHelpers } from './listings.ts';
import { ago, head, pill, who } from './routes.ts';

const secs = (ms: number) => (ms >= 600 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const isWeb = (s: string) => /^https?:\/\//i.test(s);
const cut = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const size = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`);

const statusPill = (s: SiteCheckRun['status']) => (s === 'done' ? pill('ok', 'Done') : pill('bad', 'Didn’t finish'));
const when = (iso: string) => html`<span title="${iso.slice(0, 16).replace('T', ' ')} UTC">${ago(iso)}</span>`;
const number = (n: number, kind: 'bad' | 'wait') => (n ? html`<b class="n-${kind}">${n}</b>` : html`<span class="muted">0</span>`);
const startedBy = (r: { started_by: string }) => (r.started_by === 'cli' ? 'a command line' : who(r.started_by));
const checksText = (checks: CheckName[]) => (checks.length === CHECKS.length ? 'All seven' : checks.map((c) => CHECK_LABEL[c]).join(', '));

// ---------- the findings tables ----------
// One cell: what a person reads (html), what CSV and the filter get (text), and what it sorts by when that isn't the
// text (a number).
interface Cell { text: string; html?: Html | string; sort?: number }
interface Column { label: string; get: (f: Finding, site: string) => Cell; cls?: string }

const detail = (f: Finding, key: string) => f.detail?.[key] ?? null;
const str = (f: Finding, key: string) => { const v = detail(f, key); return v === null || v === '' ? null : String(v); };
const num = (f: Finding, key: string) => { const v = detail(f, key); return typeof v === 'number' ? v : null; };
const NONE: Cell = { text: '', html: html`<span class="muted">—</span>` };
const plain = (s: string | null, cls = ''): Cell => (s === null ? NONE : { text: s, html: cls ? html`<span class="${cls}">${cut(s, 200)}</span>` : cut(s, 300) });

// A web address: opens in a new tab; cut short, with the whole in the tooltip.
const address = (t: string): Cell => ({
  text: t,
  html: isWeb(t) ? html`<a class="mono cut" href="${t.split(' ')[0]}" target="_blank" rel="noopener" title="${t}">${cut(t)}</a>` : html`<span class="mono cut" title="${t}">${cut(t)}</span>`,
});
const sitePage = (site: string, p: string): Cell => (p ? { text: site + p, html: html`<a href="${site}${p}" target="_blank" rel="noopener" class="mono cut">${p}</a>` } : { text: '(the site as a whole)', html: html`<span class="muted">The site as a whole</span>` });

// The pages a finding is on: the first, and the others folded away.
const pagesCell = (f: Finding, site: string): Cell => {
  const link = (p: string) => sitePage(site, p).html;
  const others = f.pages.slice(1);
  const unlisted = f.count - f.pages.length;
  const text = f.pages.map((p) => p || '(site)').join(' ') + (unlisted > 0 ? ` (+${unlisted} more)` : '');
  if (!others.length && f.count <= 1) return { text, html: link(f.page), sort: f.count };
  return {
    text, sort: f.count,
    html: html`${link(f.page)}<details class="more"><summary class="small">and ${f.count - 1} more</summary>
      <ul>${others.map((p) => html`<li>${link(p)}</li>`)}${unlisted > 0 ? html`<li class="muted small">and ${unlisted} more not listed</li>` : ''}</ul></details>`,
  };
};

// What came back: the HTTP status, or the browser's or the network's error.
const answer = (f: Finding): Cell => {
  const status = num(f, 'status');
  if (status !== null) return { text: `HTTP ${status}`, html: html`<span class="mono nowrap">HTTP ${status}</span>`, sort: status };
  const error = str(f, 'error');
  return error ? { text: error, html: html`<span class="mono small">${cut(error, 160)}</span>`, sort: 1000 } : { ...NONE, sort: 1001 };
};

const LEVEL: Column = { label: 'Level', get: (f) => ({ text: f.level === 'fail' ? 'Failing' : 'Worth a look', html: f.level === 'fail' ? pill('bad', 'Failing') : pill('wait', 'Worth a look'), sort: f.level === 'fail' ? 0 : 1 }) };
const PROBLEM: Column = { label: 'Problem', cls: 'what', get: (f) => ({ text: f.message, html: f.message }) };
const WHERE = (label: string): Column => ({ label, cls: 'where', get: pagesCell });
const TARGET = (label: string): Column => ({ label, cls: 'addr', get: (f) => address(f.target) });

const COLUMNS: Record<CheckName, Column[]> = {
  assets: [
    LEVEL,
    { label: 'File', cls: 'addr', get: (f, site) => (f.code === 'page.failed' ? sitePage(site, f.target) : f.code === 'asset.script-error' ? plain(f.target, 'mono small') : address(f.target)) },
    { label: 'Answer', get: answer },
    { label: 'Asked for by', get: (f) => plain(str(f, 'element') ?? str(f, 'type'), 'mono small') },
    PROBLEM,
    WHERE('Used on'),
  ],
  links: [
    LEVEL,
    TARGET('Link to'),
    { label: 'Answer', get: answer },
    { label: 'Link text', get: (f) => plain(str(f, 'text')) },
    { label: 'Kind', get: (f) => plain(str(f, 'kind'), 'small') },
    PROBLEM,
    WHERE('On'),
  ],
  games: [
    LEVEL,
    { label: 'Game', cls: 'name', get: (f) => plain(str(f, 'game')) },
    PROBLEM,
    { label: 'Answer', get: answer },
    { label: 'Opens', get: (f) => { const e = detail(f, 'embed'); return e === null ? NONE : { text: e ? 'in the site’s player' : 'in a new tab', html: html`<span class="small">${e ? 'in the site’s player' : 'in a new tab'}</span>` }; } },
    { label: 'Load time', cls: 'r', get: (f) => { const ms = num(f, 'ms'); return ms === null ? { ...NONE, sort: -1 } : { text: secs(ms), html: html`<span class="nowrap">${secs(ms)}</span>`, sort: ms }; } },
    TARGET('Address'),
    WHERE('Game page'),
  ],
  spelling: [
    { label: 'Word', get: (f) => ({ text: f.target, html: html`<b>${f.target}</b>` }) },
    { label: 'Suggestion', get: (f) => plain(str(f, 'suggestion')) },
    { label: 'In context', cls: 'what', get: (f) => { const c = str(f, 'context'); return c ? { text: c, html: html`<span class="small">…${c}…</span>` } : { text: f.message, html: html`<span class="small">${f.message}</span>` }; } },
    WHERE('Pages'),
  ],
  performance: [
    LEVEL,
    { label: 'File or page', cls: 'addr', get: (f, site) => (f.target.startsWith('/') ? sitePage(site, f.target) : address(f.target)) },
    PROBLEM,
    { label: 'Size', cls: 'r', get: (f) => { const b = num(f, 'bytes'); return b === null ? { ...NONE, sort: -1 } : { text: String(b), html: html`<span class="nowrap">${size(b)}</span>`, sort: b }; } },
    { label: 'Time', cls: 'r', get: (f) => { const ms = num(f, 'ms'); return ms === null ? { ...NONE, sort: -1 } : { text: String(ms), html: html`<span class="nowrap">${secs(ms)}</span>`, sort: ms }; } },
    // A heavy page's biggest files, or whose file this is when it isn't the site's own.
    { label: 'What to fix first', get: (f) => {
      const biggest = str(f, 'biggest');
      if (biggest) { const lines = biggest.split('\n'); return { text: lines.join('; '), html: html`<ul class="small mono plain">${lines.map((l) => html`<li>${cut(l, 120)}</li>`)}</ul>` }; }
      return detail(f, 'thirdParty') === true ? plain(`another site’s file (${str(f, 'host') ?? '?'})`, 'small') : NONE;
    } },
    WHERE('Where'),
  ],
  responsive: [
    LEVEL,
    { label: 'Width', get: (f) => { const v = str(f, 'viewport'), w = num(f, 'width'); return v ? { text: `${v}${w ? ` (${w}px)` : ''}`, html: html`<span class="nowrap">${v}${w ? html` <span class="muted small">${w}px</span>` : ''}</span>`, sort: w ?? 0 } : NONE; } },
    { label: 'Element', get: (f) => plain(str(f, 'selector') ?? f.target, 'mono small') },
    PROBLEM,
    WHERE('Page'),
  ],
  services: [
    LEVEL,
    { label: 'Service', cls: 'name', get: (f) => plain(str(f, 'service')) },
    PROBLEM,
    { label: 'Answer', get: answer },
    { label: 'Time', cls: 'r', get: (f) => { const ms = num(f, 'ms'); return ms === null ? { ...NONE, sort: -1 } : { text: String(ms), html: html`<span class="nowrap">${secs(ms)}</span>`, sort: ms }; } },
    { label: 'It said', get: (f) => plain(str(f, 'body'), 'mono small') },
    TARGET('Address'),
  ],
};

export function findingsCsv(run: SiteCheckRun, check: CheckName): string {
  const site = run.site.replace(/\/+$/, '');
  const cols = COLUMNS[check];
  // A cell a spreadsheet would run as a formula is quoted as text.
  const field = (s: string) => { const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = run.findings.filter((f) => f.check === check).map((f) => [...cols.map((c) => c.get(f, site).text), f.code].map(field).join(','));
  return [[...cols.map((c) => c.label), 'Code'].map(field).join(','), ...rows].join('\r\n') + '\r\n';
}

export const detailsId = (runId: number, check: CheckName) => `details-${runId}-${check}`;

// The table of one check's findings in one run, for the row of the summary that opens it.
function findingsPanel(runId: number, run: SiteCheckRun, s: CheckSummary): Html {
  const site = run.site.replace(/\/+$/, '');
  const mine = run.findings.filter((f) => f.check === s.check);
  const unlisted = s.unlisted ? s.unlisted.warn + s.unlisted.fail : 0;
  const label = CHECK_LABEL[s.check];
  if (!mine.length) {
    return html`<p class="small muted findings-none">Details weren’t recorded for this run: it found ${s.fail + s.warn} ${s.fail + s.warn === 1 ? 'thing' : 'things'}, but didn’t list them.</p>`;
  }
  const cols = COLUMNS[s.check];
  const head = cols.map((c, i) => html`<th class="${c.cls === 'r' ? 'r' : ''}" aria-sort="none"><button type="button" class="th-sort" data-sort="${i}">${c.label}</button></th>`);
  const rows = mine.map((f) => html`<tr>${cols.map((c) => {
    const v = c.get(f, site);
    return html`<td class="${c.cls ?? ''}" data-v="${v.text}"${v.sort !== undefined ? html` data-s="${v.sort}"` : ''}>${v.html ?? v.text}</td>`;
  })}</tr>`);
  const n = mine.length;
  return html`<div class="findings" data-findings data-name="${label}">
      <div class="findings-bar">
        <input type="search" class="findings-filter" placeholder="Filter" aria-label="Filter what ${label.toLowerCase()} found" data-filter>
        <span class="small muted" data-count aria-live="polite">${n} ${n === 1 ? 'thing' : 'things'}</span>
        <span class="findings-acts"><button type="button" class="btn sm" data-copy-csv>Copy as CSV</button>
        <a class="btn sm" href="/vault/site-checks/${runId}/findings.csv?check=${s.check}" download>Download CSV</a></span>
      </div>
      <div class="tbl-wrap"><table class="site-checks findings-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      ${unlisted ? html`<p class="small muted">And ${unlisted} more not listed: a run keeps the ${MAX_PER_CHECK} worst of each check.</p>` : ''}
      ${run.detail_version ? '' : html`<p class="small muted">This run was recorded before the checks kept every detail, so some columns are empty.</p>`}
    </div>`;
}

export function registerSiteChecks(app: Hono, h: ListingHelpers) {
  const { db } = h;

  // A row for each check; a check that found something opens the table of what it found (its Details button, or a
  // click anywhere on the row).
  function summaryTable(runId: number, run: SiteCheckRun) {
    if (!run.summaries.length) return '';
    const rows = run.summaries.map((s) => {
      const state = s.status === 'skipped' ? pill('off', 'Skipped') : s.status === 'error' ? pill('bad', 'Error') : s.fail ? pill('bad', 'Failing') : s.warn ? pill('wait', 'Worth a look') : pill('ok', 'Fine');
      const found = s.fail + s.warn > 0 || run.findings.some((f) => f.check === s.check);
      const id = detailsId(runId, s.check);
      const open = found ? html` <button type="button" class="feat-open" aria-expanded="false" aria-controls="${id}" aria-label="Details: what ${CHECK_LABEL[s.check].toLowerCase()} found">Details<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : '';
      return html`<tr id="check-${s.check}"${found ? html` class="has-details" data-details="${id}"` : ''}><td>${state}</td><td><span class="check-name">${CHECK_LABEL[s.check]}${open}</span>${s.status !== 'done' && s.note ? html`<br><span class="small ${s.status === 'error' ? 'err' : 'muted'}">${s.note}</span>` : ''}</td>
        <td class="r num">${s.status === 'done' ? s.checked : '—'}</td><td class="r num">${number(s.fail, 'bad')}</td><td class="r num">${number(s.warn, 'wait')}</td><td class="r num small nowrap">${s.status === 'skipped' ? '—' : secs(s.ms)}</td></tr>
        ${found ? html`<tr class="feat-edit check-details" id="${id}" hidden><td colspan="6">${findingsPanel(runId, run, s)}</td></tr>` : ''}`;
    });
    return html`<div class="tbl-wrap"><table class="site-checks"><thead><tr><th>Result</th><th>Check</th><th class="r">Looked at</th><th class="r">Failing</th><th class="r">Worth a look</th><th class="r">Time</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const oneLine = (run: SiteCheckRun) => html`${run.counts.fail} failing, ${run.counts.warn} worth a look, across ${run.pages} pages and ${run.games} games.`;

  app.get('/vault/site-checks', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const runs = db.siteChecks(30);
    const latest = db.siteCheck();

    const lastCard = latest
      ? html`<div class="card" style="margin-top:16px"><div class="card-h"><span>Latest run ${statusPill(latest.status)}</span>
          <small>${when(latest.started_at)} · ${startedBy(latest)} · <a href="/vault/site-checks/${latest.id}">All the details</a></small></div>
          ${latest.run.status === 'done' ? html`<p>${oneLine(latest.run)}</p>` : html`<p class="err">${latest.error ?? 'The run did not finish.'}</p>`}
          ${latest.run.summaries.length ? summaryTable(latest.id, latest.run) : ''}</div>`
      : html`<div class="card" style="margin-top:16px"><p class="muted">No site checks have run yet.</p></div>`;

    const rows = runs.map((r: SiteCheckRow) => html`<tr><td class="nowrap"><a href="/vault/site-checks/${r.id}">${when(r.started_at)}</a></td>
      <td class="small">${startedBy(r)}${r.source ? html` · <a href="${r.source}" target="_blank" rel="noopener">GitHub run ↗</a>` : ''}</td>
      <td class="small">${checksText(r.checks)}</td><td class="r num">${r.pages}</td><td class="r num">${r.games}</td>
      <td class="r num">${number(r.fail_count, 'bad')}</td><td class="r num">${number(r.warn_count, 'wait')}</td><td>${statusPill(r.status)}</td></tr>`);
    const table = html`<h3 class="sec">Recent runs</h3><div class="tbl-wrap"><table class="site-checks"><thead><tr><th>Started</th><th>By</th><th>Checks</th><th class="r">Pages</th><th class="r">Games</th><th class="r">Failing</th><th class="r">Worth a look</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows : html`<tr><td colspan="8" class="muted">Nothing has run yet.</td></tr>`}</tbody></table></div>`;

    const actions = html`<a class="btn brass" href="https://github.com/${h.deps.adminRepository}/actions/workflows/check-site.yml" target="_blank" rel="noopener">Run the checks ↗</a>`;
    const sub = 'Tests of the live website in a browser: games load, missing files, broken links, spelling, large files and slow loading, phone, tablet and laptop layouts, and whether the services games depend on (player codes, the Open Game Data logger) answer. They run in GitHub each day, and can be started there. Open a check for the list of what it found.';
    return h.page(c, 'Site checks', html`${head('Site checks', sub, actions)}${lastCard}${table}`, { active: 'site-checks' });
  });

  const runFor = (id: string) => { const n = Number(id); return Number.isInteger(n) ? db.siteCheck(n) : undefined; };

  app.get('/vault/site-checks/:id', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const row = runFor(c.req.param('id'));
    if (!row) return h.denied(c, 'That run doesn’t exist, or it is older than the last 60.', 404);
    const run = row.run;
    const took = Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at));
    const sub = html`${run.site} · started ${ago(run.started_at)} by ${startedBy(run)}${run.source ? html` · <a href="${run.source}" target="_blank" rel="noopener">GitHub run ↗</a>` : ''} · took ${took >= 90_000 ? `${Math.round(took / 60_000)} min` : `${Math.round(took / 1000)} s`} · ${checksText(run.checks)}`;
    const state = html`<p>${statusPill(run.status)} ${run.status === 'done' ? oneLine(run) : html`<span class="err">${run.error ?? 'The run did not finish.'}</span>`}</p>`;
    const crumbs = html`<a href="/vault/site-checks">Site checks</a>`;
    const nothing = run.status === 'done' && !run.findings.length && !run.counts.fail && !run.counts.warn ? html`<div class="card"><p>${pill('ok', 'All clear')} The checks found nothing to fix.</p></div>` : '';
    const hint = run.summaries.some((s) => s.fail + s.warn > 0) ? html`<p class="small muted">Open a check for the list of what it found.</p>` : '';
    return h.page(c, 'Site check', html`${head(`Site check, ${row.started_at.slice(0, 16).replace('T', ' ')} UTC`, sub, undefined, crumbs)}
      <div class="card">${state}${hint}${summaryTable(row.id, run)}</div>${nothing}`, { active: 'site-checks' });
  });

  // One check's findings in one run as CSV, every column the details table has (and the finding's code).
  app.get('/vault/site-checks/:id/findings.csv', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const row = runFor(c.req.param('id'));
    if (!row) return h.denied(c, 'That run doesn’t exist, or it is older than the last 60.', 404);
    const check = c.req.query('check') as CheckName;
    if (!row.run.checks.includes(check)) return h.denied(c, `That run has no check called ${String(check ?? '')}.`, 404);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="site-check-${row.id}-${check}.csv"`);
    return c.body(findingsCsv(row.run, check));
  });
}
