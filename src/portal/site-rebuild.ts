// Rebuild the public site after a change to what it shows.
//
// The site is built from this portal's GET /v1/catalog at build time (vault-site's scripts/pull-catalog.mjs), so a
// change to a listing the site shows — publishing it, editing a published listing's fields, taking it off, moving it
// to another studio, re-pointing its images, changing the featured games — only reaches it when vault-site's
// *Deploy (site)* workflow runs again. This
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
// Re-publishing a listing that is already on the site starts a run when the published fields actually changed: the
// caller passes the reason only when the site's view of the listing changes (a save that changes nothing does not
// build).
//
// Credentials: the GitHub App this portal already commits Markdown with (VAULT_SITE_APP_ID and friends), or the
// legacy VAULT_SITE_GITHUB_TOKEN when that is all there is — site-content/config.ts, so there is nothing extra to
// set up for a rebuild to work. SITE_DEPLOY_WORKFLOW overrides the workflow file name (default deploy.yml).
//
// Two ways to start the run, because the credential decides what is possible:
//   workflow_dispatch  needs *Actions: write*. Preferred: it starts a run without writing to the repository.
//   an empty commit    needs only *Contents: write*, which the App has. deploy.yml runs `on: push` to the branch,
//                      so a commit to it starts exactly the same run. Used when dispatch is refused (403/404).
// The Apps installed on vault-site have contents:write and metadata:read only, so in production this takes the
// commit path; dispatch stays for a token that does have Actions: write.
import { sitePublishingEnabled, siteBranchFor, commitIdentity } from '../site-repo/config.ts';
import { readSiteContentConfig } from '../site-content/config.ts';
import { createInstallationTokenSource } from '../site-content/app-auth.ts';
import { markDeployPending, type SettingsStore } from '../deploy-status.ts';

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

// The site's content changed, so the built site is now out of date: say so on the deploy bar (markDeployPending) and
// start the build that makes it true (requestSiteRebuild). One call for both, because the two must never drift: a bar
// that promises a deploy nothing started is what left listing edits waiting for the catalog-check timer (David,
// 2026-10-22: "Any changes made to game or blog data … should directly trigger a site rebuild and deploy … I don't
// like the 15 minute timer for anything other than copying in the staging content from production").
//
// For listing/catalog changes only. A blog change is NOT one of these: the portal commits the post's Markdown to the
// site's branch, and vault-site's deploy runs on a push to it (deploy.yml `on: push`), so the commit is already the
// direct trigger; calling this there would build the same commit twice. Those call sites mark the bar only.
export function siteContentChanged(store: SettingsStore, reason: string, deps: SiteRebuildDeps = {}): void {
  markDeployPending(store, reason);
  requestSiteRebuild(reason, deps);
}

// Fire a pending rebuild now (tests, shutdown): the run the window was going to start, or null when none is pending.
export function flushPendingRebuild(): Promise<SiteRebuildOutcome | null> {
  if (!pending) return Promise.resolve(null);
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  return dispatch({ reasons: p.reasons, deps: p.deps, at: p.at });
}

// The credentials and target for a rebuild: the App when it is configured (preferred, and all production has), else
// the legacy token. Throws the underlying config error when neither is set.
async function siteAuth(env: Record<string, string | undefined>, doFetch: typeof fetch) {
  const branch = siteBranchFor(env);
  const c = readSiteContentConfig(env);   // accepts App *or* token; throws when neither is set
  const token = c.app ? await createInstallationTokenSource(c.app, c.apiBase, doFetch)() : c.token;
  return { token, repo: c.repo, branch, apiBase: c.apiBase, author: commitIdentity(env) };
}

// Start the run by committing to the branch: deploy.yml runs `on: push` to staging/production, so an empty commit
// (the same tree as its parent) starts the same build without changing a file. Needs only Contents: write.
async function rebuildByCommit(
  a: { token: string; repo: string; branch: string; apiBase: string; author: { name: string; email: string } },
  reason: string, doFetch: typeof fetch,
): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  const h = {
    Authorization: `Bearer ${a.token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json',
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await doFetch(`${a.apiBase}/repos/${a.repo}${path}`, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, text: text.slice(0, 200) };
  };
  const ref = `/git/refs/heads/${encodeURIComponent(a.branch)}`;
  const head = await api('GET', `/git/ref/heads/${encodeURIComponent(a.branch)}`);
  if (head.status !== 200) return { ok: false, error: `reading ${a.branch}: GitHub ${head.status} ${head.text}` };
  const headSha = String((head.json as { object?: { sha?: string } } | null)?.object?.sha ?? '');
  const parent = await api('GET', `/git/commits/${headSha}`);
  if (parent.status !== 200) return { ok: false, error: `reading commit ${headSha.slice(0, 7)}: GitHub ${parent.status} ${parent.text}` };
  const tree = String((parent.json as { tree?: { sha?: string } } | null)?.tree?.sha ?? '');
  // Same tree as the parent: nothing in the site's files changes, the push is only the trigger.
  const made = await api('POST', '/git/commits', {
    message: `chore: rebuild the site (${reason})\n\nThe portal's catalog changed, so the built site is out of date. Same tree as the parent:\nthis commit only starts Deploy (site) (deploy.yml, on: push).\n`,
    tree, parents: [headSha], author: a.author, committer: a.author,
  });
  if (made.status !== 201) return { ok: false, error: `committing to ${a.branch}: GitHub ${made.status} ${made.text}` };
  const sha = String((made.json as { sha?: string } | null)?.sha ?? '');
  const upd = await api('PATCH', ref, { sha, force: false });
  if (upd.status !== 200) return { ok: false, error: `moving ${a.branch} to ${sha.slice(0, 7)}: GitHub ${upd.status} ${upd.text}` };
  return { ok: true, commit: sha };
}

// The dispatch itself: workflow_dispatch when the credential may (204), otherwise a commit to the branch. Never
// throws; the outcome is logged.
async function dispatch(opts: { reasons: string[]; deps: SiteRebuildDeps; at?: number }): Promise<SiteRebuildOutcome> {
  const { deps } = opts;
  const env = deps.env ?? process.env;
  const reason = opts.reasons.join(', ');
  const doFetch = deps.fetch ?? globalThis.fetch;
  const redact = (s: string, token: string) => (token ? s.split(token).join('[redacted]') : s);
  let tok = '';
  try {
    if (!sitePublishingEnabled(env)) {
      const outcome: SiteRebuildOutcome = { ok: false, error: `site rebuild: SITE_PUBLISHING_ENABLED is off, so no site run is started (for ${reason}).` };
      console.error(outcome.error);
      return outcome;
    }
    const a = await siteAuth(env, doFetch);
    tok = a.token;
    const workflow = siteDeployWorkflow(env);
    const waited = () => (opts.at !== undefined ? (deps.now ?? Date.now)() - opts.at : 0);
    const coalesced = () => `${reason} (coalesced ${opts.reasons.length} change${opts.reasons.length === 1 ? '' : 's'} over ${waited()} ms)`;
    // ref: the branch the portal commits to (staging/production, never main); the workflow's environment input
    // chooses the same system (README: "Run workflow, choose the system").
    const res = await doFetch(`${a.apiBase}/repos/${a.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${a.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: a.branch, inputs: { environment: a.branch } }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (res.status === 204) return { ok: true, repo: a.repo, branch: a.branch, workflow, reason: coalesced() };
    const text = (await res.text().catch(() => '')).slice(0, 300);
    // No Actions: write (the Apps on vault-site have contents:write only), so start the same run with a commit.
    if (res.status === 403 || res.status === 404) {
      const c = await rebuildByCommit(a, reason, doFetch);
      if (c.ok) return { ok: true, repo: a.repo, branch: a.branch, workflow: `push to ${a.branch} (${c.commit.slice(0, 7)})`, reason: coalesced() };
      const outcome: SiteRebuildOutcome = { ok: false, error: redact(`site rebuild: ${a.repo} on ${a.branch} (for ${reason}): workflow_dispatch ${res.status}, then ${c.error}`, tok) };
      console.error(outcome.error);
      return outcome;
    }
    const outcome: SiteRebuildOutcome = { ok: false, error: redact(`site rebuild: ${a.repo} ${workflow} on ${a.branch} (for ${reason}): GitHub ${res.status}${text ? ` ${text}` : ''}`, tok) };
    console.error(outcome.error);
    return outcome;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const outcome: SiteRebuildOutcome = { ok: false, error: redact(redact(`site rebuild: could not start the site's deploy run (for ${reason}): ${raw}`, tok), env.VAULT_SITE_GITHUB_TOKEN?.trim() ?? '') };
    console.error(outcome.error);
    return outcome;
  }
}
