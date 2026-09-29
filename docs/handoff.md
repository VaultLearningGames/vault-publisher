# Handoff: Vault game publishing

For whoever takes this over (person or agent). Read this first, then `README.md`, `docs/setup.md` and
`docs/fielddaylab-migration.md`. State as of 2026-09-25.

Mirrored in gbrain: this page is `vault-publisher/handoff-to-hermes-2026-09-25`, and the other three are
`vault-publisher/readme`, `vault-publisher/setup` and `vault-publisher/fielddaylab-migration`. The repo copies are the
source of truth when they differ.

## What it is

Vault Learning Games hosts web games from several studios (Field Day Lab is one). This repo is the whole publishing
system:

- **Staging CDN**, which studios control: every branch and tag of a game →
  `https://builds.vaultlearninggames.org/STUDIO/GAME/BRANCH/`
- **Production CDN**, which Vault controls: `https://cdn.vaultlearninggames.org/STUDIO/GAME/` serves the current
  release in place (bookmarks always get the current version). Every approved release is kept, unchanged, at
  `STUDIO/GAME/_releases/VERSION/`.
- **Publisher API and studio portal**: one Cloud Run service, `vault-publisher`, at
  **https://portal.vaultlearninggames.org**. The old address `https://vault-publisher-3rlcoyes6a-uc.a.run.app` still
  answers the API, and its pages redirect to the portal.

```
game repo push ──► unity-build.yml@v1 ──► publish-preview.yml@v1 ──(GitHub OIDC)──► publisher ──► presigned PUTs ──► R2 staging
portal "Release" / release.yml ──► publisher copies staging build ──► R2 production _releases/VERSION/
portal "Make current" / rollback ──► publisher copies _releases/VERSION/ over STUDIO/GAME/ (index.html last, stale files removed)
```

## Where things are

| Thing | Where |
|---|---|
| Service, portal, reusable workflows, composite action | `github.com/VaultLearningGames/vault-publisher` (public). Node 24, TypeScript run directly, Hono, `node:sqlite` |
| Test game (simulated build, safe to publish and release any time) | `VaultLearningGames/vault-publisher-test` → studio `vault`, game `publisher-test` |
| Portal design prototype (not functional) | `VaultLearningGames/vault-portal-prototype`, served on `http://fddatateam:8070` (campus VPN) |
| Game repos | `github.com/fielddaylab/*` (studio slug `fieldday`) |
| GCP | project `wcer-field-day-ogd-1798`, region `us-central1` (shared with fielddaysite and OpenGameData) |
| Database | SQLite at `/data/publisher.db` in the container, replicated by Litestream to GCS `wcer-field-day-ogd-1798-vault-publisher-db` |
| Buckets | Cloudflare R2 `builds-vaultlearninggames` (test builds) and `cdn-vaultlearninggames` (releases), in the Cloudflare account "Public Games Cooperative". Staging has its own pair; see `docs/setup.md` |
| Secrets | GCP Secret Manager: `vault-publisher-r2-*` (staging), `vault-publisher-r2-prod-*`, `vault-portal-github-client-secret`, `vault-portal-session-secret` |
| Studios | `studios.json` (slug ↔ GitHub org id); synced at startup |
| Nightly cleanup | Cloud Scheduler → `POST /v1/tasks/cleanup` (removes staging previews idle 90 days) |

Code map: `src/app.ts` (API, approve/promote), `src/releases.ts` (copying and production layout), `src/storage.ts`
(R2), `src/db.ts` (schema + migrations, append only), `src/portal/routes.ts` (all portal pages and portal API),
`public/portal.{css,js}`, `.github/workflows/*.yml` (deploy, tests, and the reusable workflows studios call),
`action/` (the publish action).

## Permissions model

- **CI publishing**: a game repo's GitHub OIDC token. The first repository to publish a game name owns it, matched by
  numeric repo id, so renames are fine.
- **Portal**: GitHub sign-in. Vault roles are `release_manager` and `admin` (set on `/vault/people`; bootstrap admins
  come from the `VAULT_ADMINS` var). Studio roles are `viewer`, `maintainer` and `admin` (set on each studio's Members
  page).
- **Releasing** a new version into production: Vault release managers only (portal, or the `release.yml` workflow in
  this repo's `production` environment).
- **Make current / roll back** between approved releases: Vault release managers, plus studio maintainers and admins,
  unless Vault has **frozen** the game. Vault can **withdraw** a release so nobody can make it current again.

## Day-to-day operations

- **Develop**: `npm install && npm test` (all tests must pass). Run `node scripts/dev-portal.ts` for a local portal on
  :4181 with example data and a fake sign-in (`boss` = Vault admin, `ada` = studio admin, `mia` = maintainer,
  `vera` = viewer).
- **Deploy**: push to `main`. `deploy.yml` builds and deploys Cloud Run (one instance, min = max = 1). Watch it with
  `gh run watch`, then check `https://portal.vaultlearninggames.org/health`.
- **Logs**: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="vault-publisher"' --project wcer-field-day-ogd-1798 --freshness=1h`
- **Reusable workflow changes**: studios pin `@v1`, a moving tag. Only after a change is tested with
  `vault-publisher-test`, cut `v1.x.y` and move `v1` to it (`git tag -f v1 && git push -f origin v1`). Current: `v1.1.0`.
- **Add a studio**: add it to `studios.json` (GitHub org id from `gh api orgs/NAME --jq .id`), deploy, and add members
  in the portal.
- **Add a game**: the studio adds one workflow file (see the README or the portal's "Register a game" page). Unity
  games pass `UNITY_EMAIL`, `UNITY_PASSWORD` and `UNITY_SERIAL` explicitly, because `secrets: inherit` doesn't cross
  organizations. The repo needs the `VAULT_PUBLISHER_URL` variable.
- **Release**: in the portal, open the Vault release-request queue or a game page and use Release…. Or run
  `release.yml` with `action`, `studio`, `game`, `version` and `ref`. The studio for Vault's own repos is `vault`, not
  `fieldday`.
- **Rotate a secret**: add a new Secret Manager version, then roll a revision with
  `gcloud run services update vault-publisher --region us-central1 --project wcer-field-day-ogd-1798 --update-labels=rotated=$(date +%s)`.
  Secret values are entered by a human at a hidden prompt (`read -rs`), never pasted into chat or logs.

## Rules decided by David (don't change without asking)

- **One Unity build at a time.** Concurrent builds exhaust the Unity license ("0 free entitlements"). Keep "one build
  per branch; newer cancels older"; don't change seats or concurrency.
- **Branch names**: never put `preview` or `milestone` in a branch name for Field Day games. The framework then picks
  the PREVIEW config, which doesn't compile (`RenderMgr.cs` `s_DebugCameraClearColor`). Use `dev-*` for migration
  branches.
- **Don't merge anything into a game's `production` branch, and don't delete other people's branches,** without
  David's OK.
- **No extra production-environment checks** on `release.yml` yet. **No GCS backup** of R2 releases (R2 is trusted).
- **No Cloudflare Worker** in the play path. Production is plain R2 plus a URL rewrite rule, and switching copies files.
- Keep the fielddaylab org `GCP_*` variables: fielddaysite's `cloudrun.yml` uses them.
- fddatateam is reached over the campus VPN, not Tailscale.
- For the fielddaysite repo, live-site updates go to `doit-production`. `production` only reaches Cloud Run.

## Open work, in priority order

1. **Litestream and Cloud Run hardening.** During deploys the old and new instances briefly both replicate the database.
   CPU is also throttled between requests, which slows Litestream and background work. Check whether a restart could
   restore an older generation, and make deploys safe. Turning off CPU throttling costs about $40/month more, so get
   David's approval before changing billing.
2. **Aqualab (`wake`)**: PRs [fielddaylab/wake#47](https://github.com/fielddaylab/wake/pull/47) (→ develop) and
   [fielddaylab/wake#48](https://github.com/fielddaylab/wake/pull/48) (→ production) have passed test builds and are
   waiting for David's decision to merge.
3. **Migrate the remaining Unity games** (table A in `docs/fielddaylab-migration.md`): Bloom, Headlines (needs a
   `production` trigger), Emerald and project-hercules each get a develop PR and a production PR. Then the
   spacefab-prototype, astrolab-prototype and art-testbed prototypes. Copy the pilot workflow (`spacefab`'s
   `.github/workflows`), use `dev-vault-staging` branches, and build one repo at a time.
4. **Copy games from DoIT** (table B): a one-time job over the campus VPN (rsync from DoIT, then upload to staging).
   It needs an admin-only upload path in the publisher, which doesn't exist yet. Targets are listed in the table.
5. **The Yard** (`yardgames` with submodules) as one game with a folder per game.
6. **Production releases** for each migrated game, then **retire DoIT**: 301 `/play/GAME/ci/production/` (and
   `thermovr/ci/desktop`) to the production CDN, 410 all other `/play/*/ci/`, and repoint Squarespace links. Then
   remove the `doit` jobs from game workflows.
7. Small items:
   - Fix the PREVIEW compile error in the Field Day framework (`RenderMgr.cs`).
   - Set the fielddaylab org variable `VAULT_PUBLISHER_URL` to `https://portal.vaultlearninggames.org` (needs an org
     admin).
   - Clean up the old `fielddaylab/` folder in the staging bucket (David's call).
   - Write studio-facing docs before the first outside studio.
   - Revisit per-studio origins before an outside studio publishes, since all studios share one CDN origin today.

## Access Hermes needs (David grants these)

- **GitHub**:
  - Member of `VaultLearningGames` with write access to `vault-publisher` and `vault-publisher-test`, and to add the
    `v1` tag.
  - Write access to the `fielddaylab` game repos being migrated.
  - A required reviewer on this repo's `production` environment only if Hermes should run `release.yml`.
- **Portal**: sign in once at https://portal.vaultlearninggames.org, then David sets the Vault role on `/vault/people`
  (`release_manager` to release; `admin` to manage people).
- **GCP** (project `wcer-field-day-ogd-1798`):
  - `roles/run.viewer` and `roles/logging.viewer` to watch deploys and logs.
  - `roles/secretmanager.secretVersionAdder` on the vault secrets only if Hermes rotates them. Hermes doesn't need to
    read secret values; deploys run through GitHub Actions and Workload Identity Federation.
- **Cloudflare**: nothing for day-to-day work. Bucket and domain rule changes stay with David.
- **Unity**: nothing. Builds use the org secrets.
