# One-time setup

Vault runs two complete, separate systems. They share code and nothing else: each has its own site, portal and
deployer, database, R2 buckets, keys and GitHub OAuth app.

| | Production | Staging |
|---|---|---|
| Public site (fielddaylab/vault-rebuild) | `vaultlearninggames.org` → Cloud Run `vault-site` | `vaultlearninggames-staging.org` → `vault-site-staging` |
| Portal and deployer (this repo) | `portal.vaultlearninggames.org` → `vault-publisher` | `portal.vaultlearninggames-staging.org` → `vault-publisher-staging` |
| Studios' test builds | `builds.vaultlearninggames.org` → R2 `builds-vaultlearninggames` | `builds.vaultlearninggames-staging.org` → `builds-vaultlearninggames-staging` |
| Releases | `cdn.vaultlearninggames.org` → R2 `cdn-vaultlearninggames` | `cdn.vaultlearninggames-staging.org` → `cdn-vaultlearninggames-staging` |
| Database (Litestream) | GCS `PROJECT-vault-publisher-db` | GCS `PROJECT-vault-publisher-staging-db`, first seeded from production's |
| Deployed from | the `production` branch | `main` |

Studios only ever use production. Staging is where Vault tries the next version; only
`VaultLearningGames/vault-publisher-test` publishes to it.

Throughout: `PROJECT=wcer-field-day-ogd-1798`, `REGION=us-central1`. Secret values are typed at hidden prompts, never
pasted into chat, logs or command lines.

```bash
PROJECT=wcer-field-day-ogd-1798 REGION=us-central1
gcloud config set project $PROJECT
```

## 1. Cloudflare R2 (Vault account)

**Buckets**, each with its custom domain (bucket → Settings → Custom Domains):

| Bucket | Custom domain | State |
|---|---|---|
| `cdn-vaultlearninggames` | `cdn.vaultlearninggames.org` | exists |
| `builds-vaultlearninggames` | `builds.vaultlearninggames.org` | new |
| `cdn-vaultlearninggames-staging` | `cdn.vaultlearninggames-staging.org` | exists, but holds production's test builds until step 5 |
| `builds-vaultlearninggames-staging` | `builds.vaultlearninggames-staging.org` | new |

**Rules** (on each zone, per hostname):
- every host: *URL rewrite*: when the path ends with `/`, rewrite it to the path + `index.html`;
- `builds.*` hosts: *Response header* `X-Robots-Tag: noindex, nofollow`, and a *Cache rule* with edge TTL 60 seconds;
- `cdn.vaultlearninggames-staging.org`: `X-Robots-Tag: noindex, nofollow` (keep what's there).

**API tokens** (R2 → Manage API tokens → Create, *Object Read & Write*), one per bucket, so a system's key can't reach
another bucket: four tokens. Keep each Access Key ID and Secret Access Key only until step 2 stores them. Also note
the **Account ID**.

Check each host: upload an `index.html` to `test/hello/` and open `https://HOST/test/hello/`, then delete it.

## 2. Google Cloud

### 2.1 Production: move to the new secret names and the new builds bucket

Each system's secrets are named after its service. The CDN key, OAuth secret and session secret are copied from the
old names unchanged (so signed-in users stay signed in); the builds key is the new `builds-vaultlearninggames` token.

```bash
copy() { gcloud secrets versions access latest --secret="$1" | gcloud secrets create "$2" --data-file=-; }
copy vault-publisher-r2-prod-access-key-id     vault-publisher-r2-cdn-access-key-id
copy vault-publisher-r2-prod-secret-access-key vault-publisher-r2-cdn-secret-access-key
copy vault-portal-github-client-secret         vault-publisher-github-client-secret
copy vault-portal-session-secret               vault-publisher-session-secret

newsecret() { printf '%s: ' "$1"; read -rs v; echo; printf '%s' "$v" | gcloud secrets create "$1" --data-file=-; unset v; }
newsecret vault-publisher-r2-builds-access-key-id        # builds-vaultlearninggames token
newsecret vault-publisher-r2-builds-secret-access-key

for s in r2-builds-access-key-id r2-builds-secret-access-key r2-cdn-access-key-id r2-cdn-secret-access-key github-client-secret session-secret; do
  gcloud secrets add-iam-policy-binding vault-publisher-$s \
    --member=serviceAccount:vault-publisher@$PROJECT.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
done
```

Delete the old secret names only after production runs on the new ones (step 5).

### 2.2 Staging: service account, database bucket, secrets

```bash
SA=vault-publisher-staging@$PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts create vault-publisher-staging --display-name "vault-publisher-staging (Cloud Run)"

gcloud storage buckets create gs://$PROJECT-vault-publisher-staging-db --location=$REGION --uniform-bucket-level-access
gcloud storage buckets update gs://$PROJECT-vault-publisher-staging-db --versioning
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-vault-publisher-staging-db --member=serviceAccount:$SA --role=roles/storage.objectAdmin
# Read-only on production's database, only to seed staging's first start (docker-entrypoint.sh).
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-vault-publisher-db --member=serviceAccount:$SA --role=roles/storage.objectViewer

newsecret vault-publisher-staging-r2-builds-access-key-id        # builds-vaultlearninggames-staging token
newsecret vault-publisher-staging-r2-builds-secret-access-key
newsecret vault-publisher-staging-r2-cdn-access-key-id           # cdn-vaultlearninggames-staging token
newsecret vault-publisher-staging-r2-cdn-secret-access-key
newsecret vault-publisher-staging-github-client-secret           # from step 3
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create vault-publisher-staging-session-secret --data-file=-

for s in r2-builds-access-key-id r2-builds-secret-access-key r2-cdn-access-key-id r2-cdn-secret-access-key github-client-secret session-secret; do
  gcloud secrets add-iam-policy-binding vault-publisher-staging-$s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

### 2.3 Site service accounts (no roles: nginx serving files)

```bash
gcloud iam service-accounts create vault-site --display-name "vault-site (Cloud Run)"
gcloud iam service-accounts create vault-site-staging --display-name "vault-site-staging (Cloud Run)"
```

### 2.4 Let the GitHub deploy account deploy as the new service accounts

```bash
DEPLOY_SA=...   # the GCP_DEPLOY_SERVICE_ACCOUNT variable
for a in vault-publisher-staging vault-site vault-site-staging; do
  gcloud iam service-accounts add-iam-policy-binding $a@$PROJECT.iam.gserviceaccount.com \
    --member=serviceAccount:$DEPLOY_SA --role=roles/iam.serviceAccountUser
done
```

**Workload Identity Federation:** the provider's attribute condition must allow `fielddaylab/vault-rebuild` as well as
`VaultLearningGames/vault-publisher`. Check it with `gcloud iam workload-identity-pools providers describe ...`, and
grant `roles/iam.workloadIdentityUser` on the deploy service account to the new repository's principal if needed.

## 3. GitHub OAuth app for the staging portal

In the VaultLearningGames organization: Settings → Developer settings → OAuth Apps → New:
*Vault Portal (staging)*, homepage `https://portal.vaultlearninggames-staging.org`, callback
`https://portal.vaultlearninggames-staging.org/auth/callback`. Its client ID goes in the staging variables below and
its secret in `vault-publisher-staging-github-client-secret` (2.2).

## 4. GitHub environments and variables

Each environment holds its system's variables. **Environments inherit repository variables**, so everything that
differs between the systems lives only in the environments (the deploy workflow also refuses mismatched values).
Repository level keeps only what's shared: `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`,
`GCP_REGION`, `R2_ACCOUNT_ID`.

```bash
R=VaultLearningGames/vault-publisher
gh api -X PUT repos/$R/environments/staging >/dev/null     # "production" exists (release.yml uses it)

setenv() { env=$1; shift; for kv in "$@"; do gh variable set "${kv%%=*}" --env "$env" --body "${kv#*=}" -R $R; done; }

setenv production SERVICE=vault-publisher \
  PUBLISHER_SERVICE_ACCOUNT=vault-publisher@$PROJECT.iam.gserviceaccount.com \
  BUILDS_BUCKET=builds-vaultlearninggames BUILDS_PUBLIC_URL=https://builds.vaultlearninggames.org \
  CDN_BUCKET=cdn-vaultlearninggames CDN_PUBLIC_URL=https://cdn.vaultlearninggames.org \
  PORTAL_URL=https://portal.vaultlearninggames.org SITE_URL=https://vaultlearninggames.org ADMIN_ENVIRONMENT=production \
  PREVIEW_SITES=Site=https://vaultlearninggames.org \
  LITESTREAM_BUCKET=$PROJECT-vault-publisher-db \
  TASK_INVOKER_EMAIL=vault-publisher-scheduler@$PROJECT.iam.gserviceaccount.com \
  PORTAL_GITHUB_CLIENT_ID=$(gh variable get PORTAL_GITHUB_CLIENT_ID -R $R) \
  VAULT_ADMINS=$(gh variable get VAULT_ADMINS -R $R)

setenv staging SERVICE=vault-publisher-staging \
  PUBLISHER_SERVICE_ACCOUNT=vault-publisher-staging@$PROJECT.iam.gserviceaccount.com \
  BUILDS_BUCKET=builds-vaultlearninggames-staging BUILDS_PUBLIC_URL=https://builds.vaultlearninggames-staging.org \
  CDN_BUCKET=cdn-vaultlearninggames-staging CDN_PUBLIC_URL=https://cdn.vaultlearninggames-staging.org \
  PORTAL_URL=https://portal.vaultlearninggames-staging.org SITE_URL=https://vaultlearninggames-staging.org ADMIN_ENVIRONMENT=staging \
  "PREVIEW_SITES=Squarespace=https://squarespace-design.vaultlearninggames-staging.org New=https://new-design.vaultlearninggames-staging.org" \
  LITESTREAM_BUCKET=$PROJECT-vault-publisher-staging-db LITESTREAM_SEED_BUCKET=$PROJECT-vault-publisher-db \
  TASK_INVOKER_EMAIL=vault-publisher-scheduler@$PROJECT.iam.gserviceaccount.com \
  PORTAL_GITHUB_CLIENT_ID=<staging OAuth app client ID> \
  VAULT_ADMINS=$(gh variable get VAULT_ADMINS -R $R)

# Then remove the repository-level copies so nothing can fall back to them.
for v in PUBLISHER_SERVICE_ACCOUNT LITESTREAM_BUCKET TASK_INVOKER_EMAIL PORTAL_GITHUB_CLIENT_ID VAULT_ADMINS; do
  gh variable delete $v -R $R
done
```

**fielddaylab/vault-rebuild** (the site) gets environments too:

```bash
S=fielddaylab/vault-rebuild
for e in staging production; do gh api -X PUT repos/$S/environments/$e >/dev/null; done
for kv in SERVICE=vault-site-staging SITE_URL=https://vaultlearninggames-staging.org/ \
  VAULT_PORTAL=https://portal.vaultlearninggames-staging.org "ROBOTS_TAG=noindex, nofollow" \
  SITE_SERVICE_ACCOUNT=vault-site-staging@$PROJECT.iam.gserviceaccount.com; do
  gh variable set "${kv%%=*}" --env staging --body "${kv#*=}" -R $S; done
for kv in SERVICE=vault-site SITE_URL=https://vaultlearninggames.org/ \
  VAULT_PORTAL=https://portal.vaultlearninggames.org ROBOTS_TAG=all \
  SITE_SERVICE_ACCOUNT=vault-site@$PROJECT.iam.gserviceaccount.com; do
  gh variable set "${kv%%=*}" --env production --body "${kv#*=}" -R $S; done
```

Point the test game at staging: `gh variable set VAULT_PUBLISHER_URL --body https://portal.vaultlearninggames-staging.org -R VaultLearningGames/vault-publisher-test`.

## 5. Move production's test builds, then deploy

The test builds studios have published so far are in `cdn-vaultlearninggames-staging`. Copy them into
`builds-vaultlearninggames` so the database's preview records still point at real files. For this copy, use one
temporary token with Read & Write on both buckets, and delete it afterwards.

```bash
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
printf 'Access key ID: '; read -rs RCLONE_CONFIG_R2_ACCESS_KEY_ID; echo; export RCLONE_CONFIG_R2_ACCESS_KEY_ID
printf 'Secret: '; read -rs RCLONE_CONFIG_R2_SECRET_ACCESS_KEY; echo; export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY

rclone copy r2:cdn-vaultlearninggames-staging r2:builds-vaultlearninggames --progress
```

1. Push to `production` (or run Deploy → production). Check `https://portal.vaultlearninggames.org/health` and a
   test build's link on a game page, which now points at `builds.vaultlearninggames.org`.
2. Run the `rclone copy` again to pick up anything published in between.
3. Check the counts match: `rclone size r2:cdn-vaultlearninggames-staging` and `rclone size r2:builds-vaultlearninggames`.
   Then empty the old bucket for staging's releases: `rclone delete r2:cdn-vaultlearninggames-staging`.
4. Delete the old secret names (`vault-publisher-r2-access-key-id`, `vault-publisher-r2-secret-access-key`,
   `vault-publisher-r2-prod-*`, `vault-portal-github-client-secret`, `vault-portal-session-secret`) and their tokens.
5. Add `https://builds.vaultlearninggames.org` to the CORS allowlists of game servers that test builds call (Aqualab's
   save server, OpenGameData logging if it checks origins).

Then deploy staging: push to `main`. On its first start it seeds its database from production's.

## 6. Custom domains

After each service's first deploy, map its domain. The domain must be verified for the project first
(`gcloud domains verify vaultlearninggames-staging.org`). Keep the Cloudflare DNS records **DNS only** (grey cloud)
until Google has issued the certificate.

```bash
gcloud beta run domain-mappings create --region=$REGION --service=vault-publisher-staging --domain=portal.vaultlearninggames-staging.org
gcloud beta run domain-mappings create --region=$REGION --service=vault-site-staging --domain=vaultlearninggames-staging.org
# Production site, when it replaces Squarespace:
# gcloud beta run domain-mappings create --region=$REGION --service=vault-site --domain=vaultlearninggames.org
```

## 7. Nightly cleanup (production only)

Already set up for production (skip if `gcloud scheduler jobs list --location=$REGION` shows it). Staging has too few builds to need it.

```bash
gcloud iam service-accounts create vault-publisher-scheduler --display-name "vault-publisher cleanup"
gcloud scheduler jobs create http vault-publisher-cleanup --location=$REGION \
  --schedule="0 8 * * *" --http-method=POST \
  --uri=https://portal.vaultlearninggames.org/v1/tasks/cleanup \
  --oidc-service-account-email=vault-publisher-scheduler@$PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience=vault-publisher-tasks
```

## 8. Website forms (Google Sheets)

The sites' newsletter and "submit your game" forms post to the portal (`POST /v1/forms/newsletter`,
`POST /v1/forms/submit-game`, src/forms.ts), which appends each submission as a row to a Google Sheet. Staging and
production write to the **same** two spreadsheets; the *Site* column (the posting page's origin) tells them apart.
The header row is written when a sheet is empty; rows go to the spreadsheet's first sheet.

1. Share each spreadsheet with both portals' service accounts as **Editor**:
   `vault-publisher@$PROJECT.iam.gserviceaccount.com` and `vault-publisher-staging@$PROJECT.iam.gserviceaccount.com`.
   (They call the Sheets API with their own Cloud Run identity; no key or extra IAM role is needed. The Sheets API must
   be enabled in the project: `gcloud services enable sheets.googleapis.com`.)
2. Set the variables in each GitHub environment. The spreadsheet ID is the part of its URL between `/d/` and `/edit`.
   `FORMS_ALLOWED_ORIGINS` is **space-separated** (the deploy action splits values on commas), and lists the site
   origins that may post; any other `Origin` gets 403.

```bash
setenv production FORMS_NEWSLETTER_SHEET=<id> FORMS_SUBMIT_GAME_SHEET=<id> \
  "FORMS_ALLOWED_ORIGINS=https://vaultlearninggames.org https://www.vaultlearninggames.org"
setenv staging FORMS_NEWSLETTER_SHEET=<id> FORMS_SUBMIT_GAME_SHEET=<id> \
  "FORMS_ALLOWED_ORIGINS=https://vaultlearninggames-staging.org"
```

A form whose spreadsheet variable is unset answers 503. Submissions are limited to 10 per form per client IP per
hour, and a filled `company_website` honeypot field is accepted but not written. Failures are logged without the
submitted values; each saved submission adds a `form.submit` audit entry (form and site only).

## 9. Pilot

Add the caller workflow from the README to a branch of `fielddaylab/wake`, push, and open
`https://builds.vaultlearninggames.org/fieldday/aqualab/<branch>/`. Check:

- the game loads (Aqualab is Unity 2019 / gzip) in Chrome, Safari and on an iPad;
- a newer Unity game with Brotli (`.br`) files also loads;
- Aqualab's save server accepts requests from the new origin (CORS);
- deleting the branch removes the preview.

## Operating notes

- **Restore test:** `litestream restore -o /tmp/check.db gcs://PROJECT-vault-publisher-db/publisher.db`, then
  `sqlite3 /tmp/check.db 'select * from audit_log order by id desc limit 5'`.
- **Refresh staging's data from production:** delete staging's replica
  (`gcloud storage rm -r gs://PROJECT-vault-publisher-staging-db/publisher.db`) and redeploy staging. Staging's copies of
  production previews and releases are records only; their files aren't in staging's buckets.
- **Deploys** briefly run the old and new instance together. Writes are rare (one per push), but avoid
  deploying while a large batch of game builds is publishing.
- **The portal's "Need support?" link** (the sidebar's foot and the sign-in page) invites people to the Slack workspace
  and tells them to join `#vault-game-publishing-support`. To point it elsewhere, set the environment's `SUPPORT_URL`
  variable to another link and redeploy (`gh variable set SUPPORT_URL --env production --body https://…`); `none`
  hides the link. Not set, it is the invitation in `src/config.ts`.
- **Adding a studio:** a Vault admin creates it in the portal under **Vault → Studios** (name, short name, website
  and, optionally, the GitHub organization whose repositories publish its test versions; the portal looks up the org's
  numeric id on GitHub). Leave the organization empty for a studio whose games Vault uploads (it gets the placeholder
  owner id `vault:SLUG`). Vault admins can change a portal studio's name, website and organization there later (the
  short name is fixed: it's in the studio's CDN addresses). Then add its first studio admin on its **Members** page or
  on **Vault → People**; studio admins add the rest of their people. People who haven't signed in yet show as
  *invited* and get access the first time they sign in with that GitHub account. Every change is in **Activity**.
  `studios.json` still works, for example for a studio whose GitHub org publishes builds and should be set in code
  (the numeric org id is `gh api orgs/NAME --jq .id`): it's synced at every startup and is authoritative for the
  studios it lists (their name and organization can't be edited in the portal), but it never changes or deletes
  studios it doesn't list; an entry whose slug is already another studio's is skipped with an error in the log.
  A studio's website can also come from `studio-websites.json` (`{ "slug": "https://…" }`, linked from the site
  wherever the studio is named as a game's maker, via `/v1/catalog`), applied at startup only to studios whose website
  has never been set. After that the website is changed in the portal (the studio's **Members** page, for studio
  admins and Vault admins, or **Vault → Studios**), and portal edits, including clearing it, always win over the file.
- **One organization hosting several studios** (VaultLearningGames holds `hosted-*` repositories that belong to other
  studios): a GitHub organization can be registered to one studio only (`studios.github_owner_id` is unique; never
  give a second studio the same id, the service won't start). Assign the single repository to its studio instead.
  A repository assigned to a studio publishes for that studio whatever organization it is in; every other repository
  still goes by its organization. Two ways, both keyed by GitHub's numeric repository id
  (`gh api repos/OWNER/NAME --jq .id`), which survives renames:
  - **In the portal:** **Vault → Studios → the studio → Repositories that publish for this studio** (Vault admins).
    Type `OWNER/NAME`; the portal looks the id up on GitHub. It can't see a private repository, so type its id as
    well. *Remove* stops the repository publishing for the studio (it falls back to its organization's studio, if
    any); games it already published stay with the studio. Changes are in **Activity**
    (`studio.repository.add` / `studio.repository.remove`).
  - **In `studios.json`:** `"repositories": [{ "name": "VaultLearningGames/hosted-shadowspect", "id": "412239602" }]`
    on the studio's entry, synced at every startup. The file is authoritative for the repositories it lists (they
    are read-only in the portal, and one it stops listing is unassigned at the next startup), it never deletes an
    assignment made in the portal, and it never moves a repository the portal assigned to another studio. Any entry
    it can't apply (a bad name or id, a repository listed twice, that conflict) is skipped with an error in the log:
    startup carries on.

  The repository's workflow is the usual one (README, *Set up a game*) with `VAULT_PUBLISHER_URL` set as a
  **repository** variable when it should differ from the organization's. A game Vault uploaded for the studio
  earlier (`vault:STUDIO/GAME`) is taken over by the assigned repository on its first publish, like any studio's.
- **Removing a studio:** a Vault admin opens **Vault → Studios → the studio** and confirms *Delete studio*, or runs
  `node scripts/remove-studio.ts STUDIO-ID-OR-SLUG` against a copy of the database (it is a dry run without `--yes`,
  and prints every row that would be removed). Only an empty studio can go: any CDN game or site listing, in any
  state, refuses the removal with the counts (its members and repository assignments are removed with it; the
  removal is written to the audit log). The delete is scoped to the studio's own primary key and changes nothing by the studio's GitHub owner id, so
  a studio that shares an owner id with the publisher's organization removes without touching that organization's
  publishing setup. A studio listed in `studios.json` comes back at the next startup unless its entry is removed from
  the file, which is why the empty *Vault Learning Games* studio (the publisher's own organization) goes by removing
  its `studios.json` entry and then deleting the row.
- **Admin tasks:** `admin-task.yml` (*Run workflow* → environment, task, args) runs a Vault-admin listing operation
  on that system's portal without a signed-in person: `list`, `import`, `migrate-images`, `move`, `update` (see
  [Admin tasks](../README.md#admin-tasks)). It needs only the environment's `PORTAL_URL` and the job's OIDC token,
  which the portal accepts because the job runs in that system's environment (`ADMIN_ENVIRONMENT`), as for
  `check-games`. It is a dry run unless `dry_run` is unticked. Requests are subject to the Cloud Run request timeout
  (300 s by default; the deploy sets none): `migrate-images` therefore stops starting downloads after 240 s and
  reports `remaining`, and the workflow calls it again until it is done. If the service's timeout is ever lowered
  below about 270 s, pass a smaller `budget_seconds` in the task's args.
- **Game availability:** `check-games.yml` runs daily at 11:23 UTC for both systems (or by hand for one, *Run
  workflow* → environment). It fetches every game in the portal's `/v1/catalog`, checks that its play address loads
  and, for games shown in the site's player, that it allows being framed by the site. It posts the run to that
  system's portal (the availability columns of **Vault → Game Catalog**, via `POST /v1/admin/game-checks`, OIDC like releases), writes a job
  summary, and keeps one open issue per system, *Game availability (staging)* / *(production)*, labelled
  `game-availability`, closed when everything passes. Games being down doesn't fail the run; a portal without
  `/v1/catalog` is skipped. It reads `PORTAL_URL` and the optional `SITE_URL` (the site origin framing is checked
  against; default: `PORTAL_URL` without `portal.`) from the environment. Run it locally with
  `node scripts/check-games.ts --portal https://portal.vaultlearninggames-staging.org` (add `--out run.json` for the
  JSON, `--only slug,slug` for a few games); it only reads, and never posts.
