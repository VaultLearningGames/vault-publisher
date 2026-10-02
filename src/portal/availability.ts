// Game availability: whether every game on the site still loads, from the daily check-games workflow
// (scripts/check-games.ts, posted to POST /v1/admin/game-checks). Vault → Game Catalog shows the latest run's
// Testing Status per game in a few columns; a game's page shows it as one line (availabilityLine). Older runs
// stay in the database.
import type { Db, GameCheckRow } from '../db.ts';
import type { GameCheck, Level } from '../game-checks.ts';
import { html, type Html } from './html.ts';
import { ago, pill } from './routes.ts';
import { deriveTestingStatus, type TestingStatus } from './testingStatus.ts';

// The badge a testing status wears: red = Failure, amber = Needs Review, green = Passing. The label is
// always in the text, so the meaning never rides on color alone.
const statusPill = (s: TestingStatus) => (s === 'Failure' ? pill('bad', 'Failure') : s === 'Needs Review' ? pill('wait', 'Needs Review') : pill('ok', 'Passing'));
const levelPill = (l: Level) => statusPill(deriveTestingStatus(l));
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const why = (g: GameCheck) => (g.level === 'ok' ? 'The play address loaded' : g.problems.join('; '));

// The latest result for one site game, for its page in the portal (empty until a check has seen it).
export function availabilityLine(db: Db, slug: string, staff: boolean): Html | string {
  const run = db.gameCheck();
  const g = run?.games.find((x) => x.slug === slug);
  if (!run || !g) return '';
  return html`<p class="small">${levelPill(g.level)} ${why(g)} · checked ${ago(run.checked_at)}${staff ? html` · <a href="/vault/listings#game-${g.slug}">all games</a>` : ''}</p>`;
}

// The Game Catalog table's testing-status columns (status with its reason on hover, response time, when),
// from the latest run. Games no check has seen yet are Needs Review, with dashes for the rest.
export const AVAILABILITY_HEADS = html`<th>Testing Status</th><th class="r">Response</th><th>Checked</th>`;
export function availabilityCells(run: (GameCheckRow & { games: GameCheck[] }) | undefined, slug: string): Html {
  const g = run?.games.find((x) => x.slug === slug);
  if (!run || !g) return html`<td><span class="avail" title="No check has seen this game yet">${statusPill('Needs Review')}</span></td><td class="r muted">—</td><td class="muted">—</td>`;
  const when = run.source ? html`<a href="${run.source}" target="_blank" rel="noopener" title="The GitHub run that checked it">${ago(run.checked_at)}</a>` : ago(run.checked_at);
  return html`<td><span class="avail" title="${why(g)}">${statusPill(deriveTestingStatus(g.level))}</span></td><td class="r num">${secs(g.ms)}</td><td class="small nowrap">${when}</td>`;
}
