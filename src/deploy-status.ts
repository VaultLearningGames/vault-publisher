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
export interface DeployStatus { deploys: Deploy[] }

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
