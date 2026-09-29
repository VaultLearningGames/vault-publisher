// Game availability: whether every game on the site still loads, from the daily check-games workflow
// (scripts/check-games.ts, posted to POST /v1/admin/game-checks). Vault → Site games shows the latest run's result
// per game in a few columns; a game's page shows it as one line (availabilityLine). Older runs stay in the database.
import type { Db, GameCheckRow } from '../db.ts';
import type { GameCheck, Level } from '../game-checks.ts';
import { html, type Html } from './html.ts';
import { ago, pill } from './routes.ts';

// A function, not a table: routes.ts (which defines pill) imports this module, so it isn't ready at load time.
const levelPill = (l: Level) => (l === 'fail' ? pill('bad', 'Failing') : l === 'warn' ? pill('wait', 'Check') : pill('ok', 'Loads'));
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const why = (g: GameCheck) => (g.level === 'ok' ? 'The play address loaded' : g.problems.join('; '));

// The latest result for one site game, for its page in the portal (empty until a check has seen it).
export function availabilityLine(db: Db, slug: string, staff: boolean): Html | string {
  const run = db.gameCheck();
  const g = run?.games.find((x) => x.slug === slug);
  if (!run || !g) return '';
  return html`<p class="small">${levelPill(g.level)} ${why(g)} · checked ${ago(run.checked_at)}${staff ? html` · <a href="/vault/listings#game-${g.slug}">all games</a>` : ''}</p>`;
}

// The Site games table's availability columns (result with its reason on hover, response time, when), from the
// latest run. Games it didn't check show dashes.
export const AVAILABILITY_HEADS = html`<th>Loads</th><th class="r">Response</th><th>Checked</th>`;
export function availabilityCells(run: (GameCheckRow & { games: GameCheck[] }) | undefined, slug: string): Html {
  const g = run?.games.find((x) => x.slug === slug);
  if (!run || !g) return html`<td class="muted">—</td><td class="r muted">—</td><td class="muted">—</td>`;
  const when = run.source ? html`<a href="${run.source}" target="_blank" rel="noopener" title="The GitHub run that checked it">${ago(run.checked_at)}</a>` : ago(run.checked_at);
  return html`<td><span class="avail" title="${why(g)}">${levelPill(g.level)}</span></td><td class="r num">${secs(g.ms)}</td><td class="small nowrap">${when}</td>`;
}
