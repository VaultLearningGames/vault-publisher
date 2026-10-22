# Staging's re-seed and the CDN's game files

The daily re-seed ([setup.md, "Re-seeding staging's database"](setup.md#re-seeding-stagings-database)) gives staging a
copy of production's database. This page covers the step after it: copying the game files that database refers to.

## Why games 404 on staging (Beats Empire, 2026-10)

Symptom: on `vaultlearninggames-staging.org`, opening Beats Empire and pressing Play shows a 404 inside the player.

What the code does:

- A game hosted on the Vault CDN (`play_source: 'cdn'`) is played from `CDN_PUBLIC_URL/STUDIO/GAME/` (+ `cdn_path`),
  built when the catalog is read (`src/catalog.ts`, `catalogGame`), from the system's own `CDN_PUBLIC_URL`. On staging
  that is `cdn.vaultlearninggames-staging.org`, served from R2 `cdn-vaultlearninggames-staging`.
- Which release a game plays is a database row (`games.current_release_id`). The release's files are written by an
  approval on that system only (`src/releases.ts`), to that system's CDN bucket.
- The re-seed copies the database only. After it, staging's database says Beats Empire (and every other CDN game)
  has production's release, but staging's CDN bucket never received those files. The site's catalog pull still
  links them, and the player loads a URL with nothing behind it.

Against the three causes in the card:

- **A (files in production's bucket but not staging's): this is the cause.** Fixed by the copy below.
- **B (absolute production URLs stored in rows): not the cause.** The play URL isn't stored; it is resolved at read
  time from the system's `CDN_PUBLIC_URL`, so it is already environment-relative and nothing needs migrating. Listing
  images copied to the CDN are stored as absolute production CDN URLs (`cdn.vaultlearninggames.org/…/_vault-assets/…`);
  those are public and load on staging too. The copy also brings `_vault-assets/` over, so staging's own
  CDN URLs for them work as well.
- **C (a data difference):** possible for a single game, but not needed to explain this: every CDN-hosted game has
  the same gap.

The R2 buckets, not GCS, hold the builds; GCS holds only the database replicas.

## The copy (scripts/reseed-cdn.ts)

The last step of `.github/workflows/reseed-staging.yml` runs `node scripts/reseed-cdn.ts` (`src/cdn-seed.ts`):

- **One way:** production's CDN bucket is only listed and read, with an R2 token that can only read.
- **Additive:** nothing on staging is ever deleted (staging keeps its own test releases). An object already on
  staging under the same key and size is skipped, so a second run copies nothing and a run cut short carries on.
- **Scope**, per game (`STUDIO/GAME/`): the live copy players load, `current.json`, `_vault-assets/` (listing images and
  their smaller copies) and the current release's folder `_releases/VERSION/`, the version named by production's
  `current.json` (the same release production's database, and so staging's copy, names). Older releases are left
  out: switching a game back to one on staging fails until that release is approved there.
- Each file keeps the cache policy it has on production (release folders immutable, live files `no-cache`, images
  immutable).
- It runs after the database re-seed and the health check, so a failure here never undoes or blocks the re-seed; the
  workflow run fails red with the reason.

A dry run (lists both buckets, writes nothing):

```bash
node scripts/reseed-cdn.ts --dry-run    # with the variables below in the environment
```

## What it needs (one-time, by an admin)

R2 tokens are per bucket, and staging's own CDN token can't reach production's bucket. The copy needs:

1. An R2 API token with **Object Read only** on `cdn-vaultlearninggames` alone (R2 → Manage API tokens → Create;
   never Read & Write), stored in Secret Manager:

   ```bash
   newsecret vault-publisher-staging-r2-seed-cdn-access-key-id
   newsecret vault-publisher-staging-r2-seed-cdn-secret-access-key
   ```

2. The deploy service account (`GCP_DEPLOY_SERVICE_ACCOUNT`, which runs the workflow) able to read these and staging's
   own CDN key, and nothing more:

   ```bash
   for s in r2-seed-cdn-access-key-id r2-seed-cdn-secret-access-key r2-cdn-access-key-id r2-cdn-secret-access-key; do
     gcloud secrets add-iam-policy-binding vault-publisher-staging-$s \
       --member=serviceAccount:$DEPLOY_SA --role=roles/secretmanager.secretAccessor
   done
   ```

3. In the `staging` GitHub environment, the variable `SEED_CDN_BUCKET=cdn-vaultlearninggames` (`R2_ACCOUNT_ID` and
   `CDN_BUCKET` are already there for the deploy).

Until they exist, the step fails with a message naming what is missing; the database re-seed has already completed.
The script refuses to run unless `CDN_BUCKET` is staging's and `SEED_CDN_BUCKET` isn't.

## Manual remedy

If staging's games 404 after a re-seed: run *Re-seed staging's database* again (`gh workflow run reseed-staging.yml -R
VaultLearningGames/vault-publisher`; the copy only adds what is missing), then *Deploy (site)* on vault-site's
`staging` branch so the staging site's catalog is current.
