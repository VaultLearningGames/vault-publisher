// The public blog is part of the website, which Hugo builds from the portal's /v1/blog (publicPayload.ts). A change
// to a public post (publish, unpublish, edit or delete of a post that was or is viewable) asks GitHub to rebuild and
// publish the site: a workflow_dispatch of deploy.yml for this system's environment with site_only, which leaves the
// portal alone. Drafts never do.
//
// Debounced: each request (re)starts a wait of `debounceMs`, and only when it runs out is one build dispatched, so an
// editor's burst of autosaves is one build. A request while a dispatch is in flight waits for it, then starts a new
// wait. POST /portal/api/blog/republish dispatches at once (flush).
//
// Off unless the system has a token (SITE_REBUILD_TOKEN, a GitHub token that may run the repository's workflows) and
// an environment (SITE_REBUILD_ENVIRONMENT: staging or production; the deploy sets it).
export const DEFAULT_DEBOUNCE_MS = 60_000;
export const WORKFLOW = 'deploy.yml';

export interface SiteRebuildConfig {
  token?: string;
  repository: string;
  environment?: string;
  // The branch the workflow runs from: main for staging, production for production, unless set.
  ref?: string;
  debounceMs?: number;
}

export interface SiteRebuilderOptions extends SiteRebuildConfig {
  fetch?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (msg: string) => void;
}

export type RebuildStatus = { pending: boolean; dispatches: number; last_error: string | null; environment: string | null };

export class SiteRebuilder {
  private readonly o: SiteRebuilderOptions;
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private dispatches = 0;
  private lastError: string | null = null;
  constructor(o: SiteRebuilderOptions) { this.o = o; }

  get enabled(): boolean { return !!this.o.token && !!this.o.environment && !!this.o.repository; }
  get environment(): string | null { return this.o.environment ?? null; }
  get ref(): string { return this.o.ref || (this.o.environment === 'production' ? 'production' : 'main'); }

  status(): RebuildStatus {
    return { pending: this.timer !== null || this.again, dispatches: this.dispatches, last_error: this.lastError, environment: this.environment };
  }

  // A public post changed: one build after the burst. False when off.
  request(): boolean {
    if (!this.enabled) return false;
    if (this.inFlight) { this.again = true; return true; }
    this.arm();
    return true;
  }

  // Dispatches now (any waiting request is folded into it). Rejects when off or GitHub refuses.
  async flush(): Promise<void> {
    if (!this.enabled) throw new Error('site rebuilds are off on this system');
    this.disarm();
    if (this.inFlight) await this.inFlight.catch(() => undefined);
    this.again = false;
    await this.run();
  }

  private arm() {
    this.disarm();
    const set = this.o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.timer = set(() => { this.timer = null; void this.run().catch(() => undefined); }, this.o.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private disarm() {
    if (this.timer === null) return;
    (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private run(): Promise<void> {
    const p = this.dispatch().finally(() => {
      if (this.inFlight === p) this.inFlight = null;
      if (this.again) { this.again = false; this.arm(); }
    });
    this.inFlight = p;
    return p;
  }

  private async dispatch(): Promise<void> {
    const f = this.o.fetch ?? fetch;
    const repo = this.o.repository.split('/').map(encodeURIComponent).join('/');
    const log = this.o.log ?? ((m) => console.error(m));
    try {
      const res = await f(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.o.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'vault-publisher' },
        body: JSON.stringify({ ref: this.ref, inputs: { environment: this.o.environment, site_only: 'true' } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      this.dispatches++;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      log(`blog site rebuild: ${this.lastError}`);
      throw err;
    }
  }
}
