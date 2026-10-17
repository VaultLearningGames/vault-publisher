// The deploy bar: whether a deploy of this system is running, read from GitHub Actions. Two workflows deploy it: this
// repository's "Deploy (portal and site)" and vault-site's "Deploy (site)". A run counts for this system when it is on
// the system's branch (main is staging, production is production). The portal asks GitHub at most once per
// CACHE_MS, whatever the number of pages open; without DEPLOY_STATUS_GITHUB_TOKEN nothing here runs.

export type DeployKind = 'portal' | 'site';
export type DeployEnvironment = 'staging' | 'production';

export interface DeployWorkflow { kind: DeployKind; repo: string; workflow: string; fallbackSeconds: number }
export const DEPLOY_WORKFLOWS: readonly DeployWorkflow[] = [
  { kind: 'portal', repo: 'VaultLearningGames/vault-publisher', workflow: 'Deploy (portal and site)', fallbackSeconds: 180 },
  { kind: 'site', repo: 'VaultLearningGames/vault-site', workflow: 'Deploy (site)', fallbackSeconds: 120 },
];
export const DEFAULT_STAGING_BRANCH = 'main';
export const DEFAULT_PRODUCTION_BRANCH = 'production';
export const CACHE_MS = 15_000;
// A failed run is shown this long after it ended.
export const FAILURE_WINDOW_MS = 10 * 60_000;
// Runs whose durations make the expected time.
export const MEDIAN_OF = 5;

// The fields of GitHub's workflow run object that are used here.
export interface WorkflowRun {
  id: number;
  name: string | null;
  head_branch: string | null;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at: string;
  html_url: string;
}

export interface Deploy {
  kind: DeployKind;
  state: 'running' | 'failed';
  // When the run started (ISO), and how long a run of its workflow usually takes.
  startedAt: string;
  expectedSeconds: number;
  url: string;
}
// scheduled: a deploy a portal action asked for that hasn't started yet (markDeployPending, below).
export interface DeployStatus { deploys: Deploy[]; scheduled?: { since: string; reason: string | null } | null }

const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);
export const isActive = (run: Pick<WorkflowRun, 'status'>) => ACTIVE.has(run.status ?? '');

interface Selector { workflowName: string; branch: string }
const startOf = (r: WorkflowRun) => Date.parse(r.run_started_at || r.created_at);
const matching = (runs: WorkflowRun[], s: Selector) => runs.filter((r) => r.name === s.workflowName && r.head_branch === s.branch);

// The active run of that workflow on that branch (any event: push, workflow_dispatch...): the one that started first,
// since the deploy's concurrency group runs them one at a time. null when none is queued or running.
export function selectActiveRun(runs: WorkflowRun[], s: Selector): WorkflowRun | null {
  const active = matching(runs, s).filter(isActive);
  if (!active.length) return null;
  return active.reduce((a, b) => (startOf(b) < startOf(a) ? b : a));
}

// The latest run of that workflow on that branch, if it failed (or timed out) in the last FAILURE_WINDOW_MS. A newer
// run, of any outcome or still running, replaces it; a cancelled run is not a failure.
export function selectRecentFailure(runs: WorkflowRun[], s: Selector & { now: number }): WorkflowRun | null {
  const all = matching(runs, s);
  if (!all.length) return null;
  const latest = all.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
  if (latest.status !== 'completed' || !['failure', 'timed_out'].includes(latest.conclusion ?? '')) return null;
  const age = s.now - Date.parse(latest.updated_at);
  return age >= 0 && age <= FAILURE_WINDOW_MS ? latest : null;
}

// How long a run usually takes: the median duration of the last MEDIAN_OF successful runs, in whole seconds, or
// fallbackSeconds when there are none.
export function medianDurationSeconds(runs: WorkflowRun[], s: Selector & { fallbackSeconds: number }): number {
  const durations = matching(runs, s)
    .filter((r) => r.status === 'completed' && r.conclusion === 'success')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MEDIAN_OF)
    .map((r) => (Date.parse(r.updated_at) - startOf(r)) / 1000)
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (!durations.length) return s.fallbackSeconds;
  const mid = durations.length >> 1;
  const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  return Math.round(median);
}

// What the bar shows for one workflow's runs: its active run, else its recent failure, else nothing.
export function deployFor(runs: WorkflowRun[], wf: DeployWorkflow, branch: string, now: number): Deploy | null {
  const s = { workflowName: wf.workflow, branch };
  const expectedSeconds = medianDurationSeconds(runs, { ...s, fallbackSeconds: wf.fallbackSeconds });
  const active = selectActiveRun(runs, s);
  if (active) return { kind: wf.kind, state: 'running', startedAt: new Date(startOf(active)).toISOString(), expectedSeconds, url: active.html_url };
  const failed = selectRecentFailure(runs, { ...s, now });
  if (failed) return { kind: wf.kind, state: 'failed', startedAt: new Date(startOf(failed)).toISOString(), expectedSeconds, url: failed.html_url };
  return null;
}

// Which branch's deploys are this system's. The staging portal (the one with the staging banner) is staging; a portal
// deployed as production (SITE_REBUILD_ENVIRONMENT=production, set by deploy.yml) is production; anything else (local,
// tests) shows no bar.
export function deployBranch(opts: { isStaging: boolean; environment?: string; stagingBranch?: string; productionBranch?: string }): string | null {
  if (opts.isStaging) return opts.stagingBranch?.trim() || DEFAULT_STAGING_BRANCH;
  if (opts.environment?.trim() === 'production') return opts.productionBranch?.trim() || DEFAULT_PRODUCTION_BRANCH;
  return null;
}

export type RunsFetcher = (wf: DeployWorkflow, branch: string) => Promise<WorkflowRun[]>;

// Reads a workflow's latest runs on a branch from GitHub's API: the workflow's id (by its name; kept for the life of
// the process), then its runs.
export function githubRunsFetcher(token: string, opts: { apiBase?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): RunsFetcher {
  const api = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const ids = new Map<string, number>();
  async function get<T>(path: string): Promise<T> {
    const res = await doFetch(`${api}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vault-portal' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }
  return async (wf, branch) => {
    const key = `${wf.repo}\n${wf.workflow}`;
    let id = ids.get(key);
    if (id === undefined) {
      const list = await get<{ workflows?: { id: number; name: string }[] }>(`/repos/${wf.repo}/actions/workflows?per_page=100`);
      id = list.workflows?.find((w) => w.name === wf.workflow)?.id;
      if (id === undefined) throw new Error(`${wf.repo} has no workflow "${wf.workflow}"`);
      ids.set(key, id);
    }
    const q = new URLSearchParams({ branch, per_page: '30' });
    const out = await get<{ workflow_runs?: WorkflowRun[] }>(`/repos/${wf.repo}/actions/workflows/${id}/runs?${q}`);
    return out.workflow_runs ?? [];
  };
}

// The deploy status, asked of GitHub at most once per CACHE_MS (concurrent callers share one request). When GitHub
// can't be read the last answer stands for up to STALE_MS, then nothing is shown: the bar never shows an error.
export const STALE_MS = 2 * 60_000;
export class DeployStatusCache {
  private value: DeployStatus | null = null;
  private fetchedAt = -Infinity;   // when value was last read successfully
  private triedAt = -Infinity;     // when GitHub was last asked
  private pending: Promise<DeployStatus> | null = null;
  private readonly fetchRuns: RunsFetcher;
  private readonly branch: string;
  private readonly opts: { now?: () => number; workflows?: readonly DeployWorkflow[] };
  constructor(fetchRuns: RunsFetcher, branch: string, opts: { now?: () => number; workflows?: readonly DeployWorkflow[] } = {}) {
    this.fetchRuns = fetchRuns;
    this.branch = branch;
    this.opts = opts;
  }

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  // The last answer, without asking GitHub (for rendering a page): null when none is fresh enough.
  peek(): DeployStatus | null {
    return this.value && this.now() - this.fetchedAt <= STALE_MS ? this.value : null;
  }

  get(): Promise<DeployStatus> {
    const now = this.now();
    if (now - this.triedAt < CACHE_MS) return this.pending ?? Promise.resolve(this.peek() ?? { deploys: [] });
    this.triedAt = now;
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async refresh(): Promise<DeployStatus> {
    try {
      const workflows = this.opts.workflows ?? DEPLOY_WORKFLOWS;
      const runs = await Promise.all(workflows.map((wf) => this.fetchRuns(wf, this.branch)));
      const now = this.now();
      const deploys = workflows.map((wf, i) => deployFor(runs[i], wf, this.branch, now)).filter((d): d is Deploy => d !== null);
      this.value = { deploys };
      this.fetchedAt = now;
      return this.value;
    } catch {
      return this.peek() ?? { deploys: [] };
    }
  }
}

// ---------- a deploy scheduled by a portal action ----------
// A portal action whose change only reaches the site with a build (a blog commit, which vault-site's workflow deploys;
// a listing published or taken off, or the featured games changed, which the next "Rebuild the site only" run takes)
// marks a deploy as scheduled, and the bar says so on every page, for everyone, until it is over: a deploy of this
// system seen running since then takes over (it shows its own row), markDeployComplete clears it, or it expires after
// DEPLOY_PENDING_TTL_MINUTES (default 30). Kept in the settings table (key 'deploy_status'), so a restart or a second
// instance agrees. Nothing here throws: a failing bar never breaks the action that set it.
export const SCHEDULED_KEY = 'deploy_status';
export const DEFAULT_PENDING_TTL_MINUTES = 30;
export interface SettingsStore { setting(key: string): string | undefined; setSetting(key: string, value: string): void }
export interface ScheduledDeployRecord { pending: boolean; since: string | null; reason: string | null; updatedAt: string }
export interface ScheduledDeploy { since: string; reason: string | null }

export function pendingTtlMinutes(raw: string | undefined = process.env.DEPLOY_PENDING_TTL_MINUTES): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_PENDING_TTL_MINUTES;
}

function readRecord(store: SettingsStore): ScheduledDeployRecord | null {
  const raw = store.setting(SCHEDULED_KEY);
  if (!raw) return null;
  const r = JSON.parse(raw) as Partial<ScheduledDeployRecord>;
  return { pending: r.pending === true, since: typeof r.since === 'string' ? r.since : null, reason: typeof r.reason === 'string' ? r.reason : null, updatedAt: String(r.updatedAt ?? '') };
}
const writeRecord = (store: SettingsStore, r: ScheduledDeployRecord) => store.setSetting(SCHEDULED_KEY, JSON.stringify(r));
const cleared = (now: Date): ScheduledDeployRecord => ({ pending: false, since: null, reason: null, updatedAt: now.toISOString() });

// A deploy is scheduled. `since` stays from the first action while one is pending (a pending one past its TTL counts as
// over); the reason is the latest action's.
export function markDeployPending(store: SettingsStore, reason: string, now = new Date()): void {
  try {
    const cur = readRecord(store);
    const live = cur?.pending && cur.since && !expired(cur.since, now) ? cur.since : null;
    writeRecord(store, { pending: true, since: live ?? now.toISOString(), reason, updatedAt: now.toISOString() });
  } catch (err) {
    console.error(`deploy status: could not mark a deploy as scheduled: ${(err as Error).message}`);
  }
}

export function markDeployComplete(store: SettingsStore, now = new Date()): void {
  try {
    writeRecord(store, cleared(now));
  } catch (err) {
    console.error(`deploy status: could not clear the scheduled deploy: ${(err as Error).message}`);
  }
}

function expired(since: string, now: Date, ttlMinutes = pendingTtlMinutes()): boolean {
  const t = Date.parse(since);
  return !Number.isFinite(t) || now.getTime() - t > ttlMinutes * 60_000;
}

// The scheduled deploy, or null. One past its TTL is cleared (and saved cleared); null when the store can't be read.
export function getScheduledDeploy(store: SettingsStore, now = new Date(), ttlMinutes = pendingTtlMinutes()): ScheduledDeploy | null {
  try {
    const r = readRecord(store);
    if (!r?.pending || !r.since) return null;
    if (expired(r.since, now, ttlMinutes)) {
      writeRecord(store, cleared(now));
      return null;
    }
    return { since: r.since, reason: r.reason };
  } catch (err) {
    console.error(`deploy status: could not read the scheduled deploy: ${(err as Error).message}`);
    return null;
  }
}

// { pending, since } as the plan's callers want it.
export function getDeployStatus(store: SettingsStore, now = new Date()): { pending: boolean; since: string | null } {
  const s = getScheduledDeploy(store, now);
  return { pending: !!s, since: s?.since ?? null };
}

// The scheduled deploy once the running deploys are known: a deploy of this system running that started at or after
// it was scheduled (give or take SCHEDULE_SLACK_MS: the action marks it once its commit is in) is that deploy, so the
// schedule is over (and cleared).
export const SCHEDULE_SLACK_MS = 60_000;
export function settleScheduled(store: SettingsStore, deploys: readonly Deploy[], now = new Date()): ScheduledDeploy | null {
  const s = getScheduledDeploy(store, now);
  if (!s) return null;
  const since = Date.parse(s.since);
  if (deploys.some((d) => d.state === 'running' && Date.parse(d.startedAt) >= since - SCHEDULE_SLACK_MS)) {
    markDeployComplete(store, now);
    return null;
  }
  return s;
}
