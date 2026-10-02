// Vault → Site checks: the battery of tests run against the live website (games load, missing assets, broken links,
// spelling, large files and slow loading, responsive design; see site-checks.ts). The check-site workflow runs them
// on a GitHub runner and posts each finished run (POST /v1/admin/site-checks); this shows the latest run and the
// recent ones, and each run's findings.
import type { Hono } from 'hono';
import type { SiteCheckRow } from '../db.ts';
import { CHECK_LABEL, CHECKS, type CheckName, type Finding, type SiteCheckRun } from '../site-checks.ts';
import { html, type Html } from './html.ts';
import type { ListingHelpers } from './listings.ts';
import { ago, head, pill, who } from './routes.ts';

const secs = (ms: number) => (ms >= 600 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const isWeb = (s: string) => /^https?:\/\//i.test(s);
const cut = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const SHOWN_PER_CHECK = 500;

const statusPill = (s: SiteCheckRun['status']) => (s === 'done' ? pill('ok', 'Done') : pill('bad', 'Didn’t finish'));
const when = (iso: string) => html`<span title="${iso.slice(0, 16).replace('T', ' ')} UTC">${ago(iso)}</span>`;
const number = (n: number, kind: 'bad' | 'wait') => (n ? html`<b class="n-${kind}">${n}</b>` : html`<span class="muted">0</span>`);
const startedBy = (r: { started_by: string }) => (r.started_by === 'cli' ? 'a command line' : who(r.started_by));
const checksText = (checks: CheckName[]) => (checks.length === CHECKS.length ? 'All six' : checks.map((c) => CHECK_LABEL[c]).join(', '));

export function registerSiteChecks(app: Hono, h: ListingHelpers) {
  const { db } = h;

  // One finding's "Where": its first page, and the others folded away.
  const where = (f: Finding, site: string) => {
    const link = (p: string) => (p ? html`<a href="${site}${p}" target="_blank" rel="noopener" class="mono">${p}</a>` : html`<span class="muted">The site as a whole</span>`);
    const others = f.pages.slice(1);
    if (!others.length && f.count <= 1) return link(f.page);
    const unlisted = f.count - f.pages.length;
    return html`${link(f.page)}<details class="more"><summary class="small">and ${f.count - 1} more</summary>
      <ul>${others.map((p) => html`<li>${link(p)}</li>`)}${unlisted > 0 ? html`<li class="muted small">and ${unlisted} more not listed</li>` : ''}</ul></details>`;
  };
  // What the finding is about: a link to it when it is a web address; always cut short, with the whole in the tooltip.
  const target = (t: string) => (isWeb(t) ? html`<a class="mono cut" href="${t.split(' ')[0]}" target="_blank" rel="noopener" title="${t}">${cut(t)}</a>` : html`<span class="mono cut" title="${t}">${cut(t)}</span>`);

  function summaryTable(run: SiteCheckRun) {
    if (!run.summaries.length) return '';
    const rows = run.summaries.map((s) => {
      const state = s.status === 'skipped' ? pill('off', 'Skipped') : s.status === 'error' ? pill('bad', 'Error') : s.fail ? pill('bad', 'Failing') : s.warn ? pill('wait', 'Worth a look') : pill('ok', 'Fine');
      return html`<tr><td>${state}</td><td>${CHECK_LABEL[s.check]}${s.status !== 'done' && s.note ? html`<br><span class="small ${s.status === 'error' ? 'err' : 'muted'}">${s.note}</span>` : ''}</td>
        <td class="r num">${s.status === 'done' ? s.checked : '—'}</td><td class="r num">${number(s.fail, 'bad')}</td><td class="r num">${number(s.warn, 'wait')}</td><td class="r num small nowrap">${s.status === 'skipped' ? '—' : secs(s.ms)}</td></tr>`;
    });
    return html`<div class="tbl-wrap"><table class="site-checks"><thead><tr><th>Result</th><th>Check</th><th class="r">Looked at</th><th class="r">Failing</th><th class="r">Worth a look</th><th class="r">Time</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function findingsTables(run: SiteCheckRun): Html {
    const site = run.site.replace(/\/+$/, '');
    return html`${run.checks.map((check) => {
      const mine = run.findings.filter((f) => f.check === check);
      if (!mine.length) return '';
      const rows = mine.slice(0, SHOWN_PER_CHECK).map((f) => html`<tr><td>${f.level === 'fail' ? pill('bad', 'Failing') : pill('wait', 'Worth a look')}</td><td class="what">${f.message}</td><td>${target(f.target)}</td><td class="where">${where(f, site)}</td></tr>`);
      return html`<h3 class="sec" id="check-${check}">${CHECK_LABEL[check]} <span class="muted small">${mine.length} ${mine.length === 1 ? 'thing' : 'things'}</span></h3>
        <div class="tbl-wrap"><table class="site-checks"><thead><tr><th>Level</th><th>What</th><th>Target</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${mine.length > SHOWN_PER_CHECK ? html`<p class="small muted">Showing the first ${SHOWN_PER_CHECK} of ${mine.length}.</p>` : ''}`;
    })}`;
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
          ${latest.run.summaries.length ? summaryTable(latest.run) : ''}</div>`
      : html`<div class="card" style="margin-top:16px"><p class="muted">No site checks have run yet.</p></div>`;

    const rows = runs.map((r: SiteCheckRow) => html`<tr><td class="nowrap"><a href="/vault/site-checks/${r.id}">${when(r.started_at)}</a></td>
      <td class="small">${startedBy(r)}${r.source ? html` · <a href="${r.source}" target="_blank" rel="noopener">GitHub run ↗</a>` : ''}</td>
      <td class="small">${checksText(r.checks)}</td><td class="r num">${r.pages}</td><td class="r num">${r.games}</td>
      <td class="r num">${number(r.fail_count, 'bad')}</td><td class="r num">${number(r.warn_count, 'wait')}</td><td>${statusPill(r.status)}</td></tr>`);
    const table = html`<h3 class="sec">Recent runs</h3><div class="tbl-wrap"><table class="site-checks"><thead><tr><th>Started</th><th>By</th><th>Checks</th><th class="r">Pages</th><th class="r">Games</th><th class="r">Failing</th><th class="r">Worth a look</th><th>Status</th></tr></thead>
      <tbody>${rows.length ? rows : html`<tr><td colspan="8" class="muted">Nothing has run yet.</td></tr>`}</tbody></table></div>`;

    const actions = html`<a class="btn brass" href="https://github.com/${h.deps.adminRepository}/actions/workflows/check-site.yml" target="_blank" rel="noopener">Run the checks ↗</a>`;
    const sub = 'Tests of the live website in a browser: games load, missing files, broken links, spelling, large files and slow loading, and phone, tablet and laptop layouts. They run in GitHub each day, and can be started there.';
    return h.page(c, 'Site checks', html`${head('Site checks', sub, actions)}${lastCard}${table}`, { active: 'site-checks' });
  });

  app.get('/vault/site-checks/:id', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const id = Number(c.req.param('id'));
    const row = Number.isInteger(id) ? db.siteCheck(id) : undefined;
    if (!row) return h.denied(c, 'That run doesn’t exist, or it is older than the last 60.', 404);
    const run = row.run;
    const took = Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at));
    const sub = html`${run.site} · started ${ago(run.started_at)} by ${startedBy(run)}${run.source ? html` · <a href="${run.source}" target="_blank" rel="noopener">GitHub run ↗</a>` : ''} · took ${took >= 90_000 ? `${Math.round(took / 60_000)} min` : `${Math.round(took / 1000)} s`} · ${checksText(run.checks)}`;
    const state = html`<p>${statusPill(run.status)} ${run.status === 'done' ? oneLine(run) : html`<span class="err">${run.error ?? 'The run did not finish.'}</span>`}</p>`;
    const crumbs = html`<a href="/vault/site-checks">Site checks</a>`;
    const nothing = run.status === 'done' && !run.findings.length ? html`<div class="card"><p>${pill('ok', 'All clear')} The checks found nothing to fix.</p></div>` : '';
    return h.page(c, 'Site check', html`${head(`Site check, ${row.started_at.slice(0, 16).replace('T', ' ')} UTC`, sub, undefined, crumbs)}
      <div class="card">${state}${summaryTable(run)}</div>${nothing}${findingsTables(run)}`, { active: 'site-checks' });
  });
}
