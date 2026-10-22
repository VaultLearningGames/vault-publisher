// Rebuild the public site after a listing's published state changes.
//
// The site is built from this portal's GET /v1/catalog at build time (vault-site's scripts/pull-catalog.mjs), so
// publishing or unpublishing a listing only reaches it when vault-site's *Deploy (site)* workflow runs again. This
// portal starts that run itself: a GitHub workflow_dispatch of the deploy workflow (deploy.yml, the file behind
// *Deploy (site)*; docs/ops-checklist.md) on the branch the portal commits to there (site-repo/config.ts: the
// staging portal "staging", the production portal "production"), with the run's "environment" input set to that
// same system (README: "Run workflow, choose the system"; `gh workflow run deploy.yml … -f environment=staging`).
//
// Coalesced in-process: several changes inside DEBOUNCE_MS (30 s) start ONE run, fired at the end of the window.
// The pending timer is unref()ed, so it never holds the process open (tests, shutdown). Nothing here throws and
// nothing blocks the listing action: a failed dispatch is logged, the action stands, and the deploy bar (the
// markDeployPending the caller already made) still says a deploy is scheduled until a run is seen. With several
// portal instances the run may start twice; the build is idempotent, so that is harmless.
//
// Re-publishing a listing that is already on the site (the published flag does not change) starts no run: the
// caller passes the reason only when the site's view of the listing actually changes.
//
// Needs VAULT_SITE_GITHUB_TOKEN with *Actions: write* on vault-site (docs/setup.md), the same token the portal
// commits Markdown with. SITE_DEPLOY_WORKFLOW overrides the workflow file name (default deploy.yml).
import { readSiteRepoConfig, sitePublishingEnabled } from '../site-repo/config.ts';

// How long the first change waits for more before the run starts; a later change extends the window to its own end.
export const SITE_REBUILD_DEBOUNCE_MS = 30_000;
// vault-site's *Deploy (site)* workflow file (docs/ops-checklist.md: "vault-site's .github/workflows/deploy.yml").
export const DEFAULT_SITE_DEPLOY_WORKFLOW = 'deploy.yml';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'vault-portal';
const DISPATCH_TIMEOUT_MS = 10_000;

export interface SiteRebuildDeps {
  fetch?: typeof fetch;
  // Settings instead of the environment's (tests).
  env?: Record<string, string | undefined>;
  now?: () => number;
  // The coalescing window; 0 fires the run at once.
  debounceMs?: number;
}

export type SiteRebuildOutcome =
  | { ok: true; repo: string; branch: string; workflow: string; reason: string }
  | { ok: false; error: string };

interface Pending { timer: NodeJS.Timeout; at: number; reasons: string[]; deps: SiteRebuildDeps }

let pending: Pending | null = null;

// The workflow file to dispatch: SITE_DEPLOY_WORKFLOW, else deploy.yml.
export function siteDeployWorkflow(env: Record<string, string | undefined> = process.env): string {
  return env.SITE_DEPLOY_WORKFLOW?.trim() || DEFAULT_SITE_DEPLOY_WORKFLOW;
}

// Schedule a rebuild of the public site after `reason` (e.g. "unpublish:wake"). The run starts at the end of the
// coalescing window; never throws, never blocks the caller (fire and forget).
export function requestSiteRebuild(reason: string, deps: SiteRebuildDeps = {}): void {
  const r = reason.trim();
  if (!r) return;
  const now = (deps.now ?? Date.now)();
  const ms = Math.max(0, deps.debounceMs ?? SITE_REBUILD_DEBOUNCE_MS);
  const reasons = pending ? [...pending.reasons, r] : [r];
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    pending = null;
    void dispatch({ reasons, deps });
  }, ms);
  timer.unref?.();
  pending = { timer, at: now, reasons, deps };
}

// Fire a pending rebuild now (tests, shutdown): the run the window was going to start, or null when none is pending.
export function flushPendingRebuild(): Promise<SiteRebuildOutcome | null> {
  if (!pending) return Promise.resolve(null);
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  return dispatch({ reasons: p.reasons, deps: p.deps, at: p.at });
}

// The dispatch itself: POST to GitHub's workflow_dispatch, 204 is success. Never throws; the outcome is logged.
async function dispatch(opts: { reasons: string[]; deps: SiteRebuildDeps; at?: number }): Promise<SiteRebuildOutcome> {
  const { deps } = opts;
  const env = deps.env ?? process.env;
  const reason = opts.reasons.join(', ');
  const doFetch = deps.fetch ?? globalThis.fetch;
  const redact = (s: string, token: string) => (token ? s.split(token).join('[redacted]') : s);
  try {
    if (!sitePublishingEnabled(env)) {
      const outcome: SiteRebuildOutcome = { ok: false, error: `site rebuild: SITE_PUBLISHING_ENABLED is off, so no site run is started (for ${reason}).` };
      console.error(outcome.error);
      return outcome;
    }
    const cfg = readSiteRepoConfig(env);
    const workflow = siteDeployWorkflow(env);
    // ref: the branch the portal commits to (staging/production, never main); the workflow's environment input
    // chooses the same system (README: "Run workflow, choose the system").
    const res = await doFetch(`${cfg.apiBase}/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: cfg.branch, inputs: { environment: cfg.branch } }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (res.status === 204) {
      const waited = opts.at !== undefined ? (deps.now ?? Date.now)() - opts.at : 0;
      return { ok: true, repo: cfg.repo, branch: cfg.branch, workflow, reason: `${reason} (coalesced ${opts.reasons.length} change${opts.reasons.length === 1 ? '' : 's'} over ${waited} ms)` };
    }
    const text = (await res.text().catch(() => '')).slice(0, 300);
    const outcome: SiteRebuildOutcome = { ok: false, error: `site rebuild: ${cfg.repo} ${workflow} on ${cfg.branch} (for ${reason}): GitHub ${res.status}${text ? ` ${text}` : ''}` };
    console.error(outcome.error);
    return outcome;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const token = env.VAULT_SITE_GITHUB_TOKEN?.trim() ?? '';
    const outcome: SiteRebuildOutcome = { ok: false, error: redact(`site rebuild: could not start the site's deploy run (for ${reason}): ${raw}`, token) };
    console.error(outcome.error);
    return outcome;
  }
}
