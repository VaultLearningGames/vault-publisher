// Vault → Game availability: whether every game on the site still loads, from the daily check-games workflow
// (scripts/check-games.ts, posted to POST /v1/admin/game-checks). Vault staff only. A game's page also shows its
// latest result (availabilityLine).
import type { Hono } from 'hono';
import type { Db } from '../db.ts';
import { sortForReport, type GameCheck, type Level } from '../game-checks.ts';
import { html, type Html } from './html.ts';
import type { ListingHelpers } from './listings.ts';
import { ago, head, pill } from './routes.ts';

// A function, not a table: routes.ts (which defines pill) imports this module, so it isn't ready at load time.
const levelPill = (l: Level) => (l === 'fail' ? pill('bad', 'Failing') : l === 'warn' ? pill('wait', 'Check') : pill('ok', 'Loads'));
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const hostOf = (url: string | null) => { try { return url ? new URL(url).host : ''; } catch { return url ?? ''; } };

// The latest result for one site game, for its page in the portal (empty until a check has seen it).
export function availabilityLine(db: Db, slug: string, staff: boolean): Html | string {
  const run = db.gameCheck();
  const g = run?.games.find((x) => x.slug === slug);
  if (!run || !g) return '';
  return html`<p class="small">${levelPill(g.level)} ${g.level === 'ok' ? 'The play address loaded' : g.problems.join('; ')} · checked ${ago(run.checked_at)}${staff ? html` · <a href="/vault/availability#${g.slug}">details</a>` : ''}</p>`;
}

export function registerAvailabilityPages(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const workflow = `https://github.com/${h.deps.adminRepository}/actions/workflows/check-games.yml`;

  app.get('/vault/availability', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const asked = Number(c.req.query('run'));
    const run = Number.isInteger(asked) && asked > 0 ? db.gameCheck(asked) : db.gameCheck();
    const history = db.gameChecks(30);
    const actions = html`<a class="btn" href="${workflow}" target="_blank" rel="noopener">Run a check ↗</a>`;
    if (!run) {
      const body = html`${head('Game availability', 'Whether every game on the site still loads, checked daily.', actions)}
        <div class="card"><p class="muted">${c.req.query('run') ? 'That run isn’t kept any more.' : 'No checks yet. The check-games workflow posts here once a day; run it from GitHub Actions to check now.'}</p></div>`;
      return h.page(c, 'Game availability', body, { active: 'vault-availability' });
    }
    const latest = history[0]?.id === run.id;
    const rows = sortForReport(run.games).map((g) => row(g));
    const kpi = (v: number | string, l: string) => html`<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    const sub = html`Whether each game on <a href="${run.site}" target="_blank" rel="noopener">${hostOf(run.site)}</a> loads for players: its play address answers, and games shown in the site’s player allow being framed by the site. ${latest ? 'Latest check' : html`<b>An older check</b> (<a href="/vault/availability">see the latest</a>)`}: ${run.checked_at.slice(0, 16).replace('T', ' ')} UTC${run.source ? html`, <a href="${run.source}" target="_blank" rel="noopener">GitHub run</a>` : ''}.`;
    const hist = history.map((r) => html`<tr><td class="small num"><a href="/vault/availability?run=${r.id}">${r.id === run.id ? html`<b>${r.checked_at.slice(0, 16).replace('T', ' ')}</b>` : r.checked_at.slice(0, 16).replace('T', ' ')}</a></td>
      <td>${r.fail_count ? pill('bad', `${r.fail_count} failing`) : pill('ok', 'none failing')} ${r.warn_count ? pill('wait', `${r.warn_count} to check`) : ''}</td>
      <td class="r num">${r.ok_count + r.warn_count + r.fail_count}</td>
      <td class="small">${r.source ? html`<a href="${r.source}" target="_blank" rel="noopener">GitHub run ↗</a>` : '—'}</td></tr>`);
    const body = html`${head('Game availability', sub, actions)}
      <div class="kpis four">
        ${kpi(run.fail_count, 'Failing')}${kpi(run.warn_count, 'Worth a look')}${kpi(run.ok_count, 'Load')}${kpi(ago(run.checked_at), 'Checked')}
      </div>
      <div class="tbl-wrap"><table class="avail"><thead><tr><th>Game</th><th>Result</th><th>Why</th><th class="r">HTTP</th><th class="r">Time</th></tr></thead>
        <tbody>${rows.length ? rows : html`<tr><td colspan="5" class="muted">No games were checked.</td></tr>`}</tbody></table></div>
      <p class="small muted">Failing: unreachable, an error status, or it refuses to load inside the site’s player. Worth a look: slow (over 5 s), moved to another site, only loaded on a retry, or bot protection turned the checker away (open it in a browser to be sure).</p>
      <h3 class="sec">Recent checks</h3>
      <div class="tbl-wrap"><table><thead><tr><th>When (UTC)</th><th>Result</th><th class="r">Games</th><th>Run</th></tr></thead><tbody>${hist}</tbody></table></div>`;
    return h.page(c, 'Game availability', body, { active: 'vault-availability' });
  });
}

function row(g: GameCheck): Html {
  const moved = g.final_url && g.final_url !== g.url;
  const line = (label: string, value: Html | string) => html`<div><span class="muted">${label}:</span> ${value}</div>`;
  const details = html`<details><summary>Details</summary>
    ${line('Play address', html`<a class="mono" href="${g.url}" target="_blank" rel="noopener">${g.url}</a>`)}
    ${moved ? line('Ended up at', html`<span class="mono">${g.final_url}</span>`) : ''}
    ${g.redirects.length > 1 ? line('Redirects', html`<span class="mono">${g.redirects.join(' → ')}</span>`) : ''}
    ${line('Opens', g.embed ? 'in the site’s player' : 'in a new tab')}
    ${g.framing ? line('Framing', html`${g.framing.allowed ? 'allowed' : html`<span class="err">blocked</span>`} (${g.framing.reason})`) : ''}
    ${g.error ? line('Error', html`<span class="mono">${g.error}</span>`) : ''}
    ${g.attempts > 1 ? line('Tries', String(g.attempts)) : ''}
  </details>`;
  return html`<tr id="${g.slug}"><td class="proj"><a href="/s/${g.studio}/g/${g.slug}"><b>${g.title || g.slug}</b></a>
      <span>${g.source === 'cdn' ? 'Vault CDN' : hostOf(g.url)}${g.embed ? '' : ' (new tab)'}</span></td>
    <td>${levelPill(g.level)}</td>
    <td class="small">${g.problems.length ? g.problems.join('; ') : html`<span class="muted">—</span>`}${details}</td>
    <td class="r num">${g.status ?? '—'}</td><td class="r num">${secs(g.ms)}</td></tr>`;
}
