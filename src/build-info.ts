// The running portal's build identity: which Deploy (portal) run built it, from which commit, and when —
// shown under the top-left logo (src/portal/routes.ts, public/portal.js) for debugging.
//
// Deploy (portal) sets these on the Cloud Run service (deploy.yml's env_vars) from the workflow run's own
// context. They are per-revision, so rolling back to an older revision shows that revision's own build.
// Local development and tests have none of them, so they fall back: build "dev", sha "local", builtAt null.
// The endpoint (GET /api/build-info) answers only with these three values — never any other environment,
// secret or hostname.

export interface BuildInfo {
  build: string;        // "<run_number>-<short_sha>", e.g. "482-a1b2c3d"; "dev" without the variables
  sha: string;          // the full commit SHA the deploy ran, or "local" without it
  builtAt: string | null; // ISO-8601 UTC time of the deploy, or null without it
}

let memo: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (memo) return memo;
  const number = (process.env.VAULT_BUILD_NUMBER ?? '').trim();
  const sha = (process.env.VAULT_BUILD_SHA ?? '').trim();
  const builtAt = (process.env.VAULT_BUILD_TIME ?? '').trim() || null;
  memo = {
    build: number ? `${number}-${sha.slice(0, 7) || 'local'}` : 'dev',
    sha: sha || 'local',
    builtAt,
  };
  return memo;
}
