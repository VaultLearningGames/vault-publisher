# One-time setup

Vault runs two complete, separate systems. They share code and nothing else: each has its own site, portal and
deployer, database, R2 buckets, keys and GitHub OAuth app. Both the portal and the website are in this repository
and deploy together (`.github/workflows/deploy.yml`): the portal to Cloud Run, the website (`site/`, static files)
to an R2 bucket that Cloudflare serves.

| | Production | Staging |
|---|---|---|
| Public site (`site/`) | `vaultlearninggames.org` → R2 `site-vaultlearninggames` (still Squarespace until launch) | `vaultlearninggames-staging.org` → R2 `site-vaultlearninggames-staging` (see [The website on R2](#the-website-on-r2) for the state of the move from Cloud Run) |
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
| `site-vaultlearninggames-staging` | `r2-site.vaultlearninggames-staging.org` (test), then `vaultlearninggames-staging.org` | exists (2026-10-02); see [The website on R2](#the-website-on-r2) |
| `site-vaultlearninggames` | `vaultlearninggames.org` | to create at launch |

**Rules** (on each zone, per hostname):
- every host: *URL rewrite*: when the path ends with `/`, rewrite it to the path + `index.html`;
- `builds.*` hosts: *Response header* `X-Robots-Tag: noindex, nofollow`, and a *Cache rule* with edge TTL 60 seconds;
- `cdn.vaultlearninggames-staging.org`: `X-Robots-Tag: noindex, nofollow` (keep what's there).

**CORS on the two builds buckets** (bucket → Settings → CORS policy). Studios upload a .zip from the portal's
*Upload builds* page; the browser sends each file straight to the builds bucket with a presigned PUT, which the bucket
must allow from its own system's portal. Without this rule zip uploads fail in the browser (CI uploads don't need it).
For `builds-vaultlearninggames`:

```json
[{
  "AllowedOrigins": ["https://portal.vaultlearninggames.org"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["content-type", "cache-control", "content-encoding"],
  "MaxAgeSeconds": 3600
}]
```

and the same for `builds-vaultlearninggames-staging` with `https://portal.vaultlearninggames-staging.org`.

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

### 2.3 Site service accounts (the old Cloud Run sites)

The website is static files on R2 now and needs no service account. `vault-site-staging` still runs the two old
Cloud Run sites (`vault-site-original-staging`, `vault-site-staging`) until they are retired; `vault-site` was never
used.

### 2.4 Let the GitHub deploy account deploy as the new service accounts

```bash
DEPLOY_SA=...   # the GCP_DEPLOY_SERVICE_ACCOUNT variable
for a in vault-publisher-staging; do
  gcloud iam service-accounts add-iam-policy-binding $a@$PROJECT.iam.gserviceaccount.com \
    --member=serviceAccount:$DEPLOY_SA --role=roles/iam.serviceAccountUser
done
```

**Workload Identity Federation:** the provider's attribute condition must allow `VaultLearningGames/vault-publisher`
(and the old site repository for as long as it still deploys the new design to Cloud Run). Check it with
`gcloud iam workload-identity-pools providers describe ...`.

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
  PREVIEW_SITES=Site=https://portal.vaultlearninggames.org SITE_BUCKET=site-vaultlearninggames \
  LITESTREAM_BUCKET=$PROJECT-vault-publisher-db \
  TASK_INVOKER_EMAIL=vault-publisher-scheduler@$PROJECT.iam.gserviceaccount.com \
  PORTAL_GITHUB_CLIENT_ID=$(gh variable get PORTAL_GITHUB_CLIENT_ID -R $R) \
  VAULT_ADMINS=$(gh variable get VAULT_ADMINS -R $R)

setenv staging SERVICE=vault-publisher-staging \
  PUBLISHER_SERVICE_ACCOUNT=vault-publisher-staging@$PROJECT.iam.gserviceaccount.com \
  BUILDS_BUCKET=builds-vaultlearninggames-staging BUILDS_PUBLIC_URL=https://builds.vaultlearninggames-staging.org \
  CDN_BUCKET=cdn-vaultlearninggames-staging CDN_PUBLIC_URL=https://cdn.vaultlearninggames-staging.org \
  PORTAL_URL=https://portal.vaultlearninggames-staging.org SITE_URL=https://vaultlearninggames-staging.org ADMIN_ENVIRONMENT=staging \
  "PREVIEW_SITES=Site=https://portal.vaultlearninggames-staging.org New=https://new-design.vaultlearninggames-staging.org" \
  SITE_BUCKET=site-vaultlearninggames-staging \
  LITESTREAM_BUCKET=$PROJECT-vault-publisher-staging-db LITESTREAM_SEED_BUCKET=$PROJECT-vault-publisher-db \
  TASK_INVOKER_EMAIL=vault-publisher-scheduler@$PROJECT.iam.gserviceaccount.com \
  PORTAL_GITHUB_CLIENT_ID=<staging OAuth app client ID> \
  VAULT_ADMINS=$(gh variable get VAULT_ADMINS -R $R)

# Then remove the repository-level copies so nothing can fall back to them.
for v in PUBLISHER_SERVICE_ACCOUNT LITESTREAM_BUCKET TASK_INVOKER_EMAIL PORTAL_GITHUB_CLIENT_ID VAULT_ADMINS; do
  gh variable delete $v -R $R
done
```

`SITE_URL` is the website's address: Hugo's `baseURL` in the site build, and where listing previews load their CSS
and images from. `SITE_BUCKET` is the R2 bucket the deploy publishes the site to; an environment without it builds
the site as a check and publishes nothing. `PREVIEW_SITES` lists where the editor's Preview buttons open
(`ADDRESS/_preview/TOKEN/`): the portal itself, which renders previews with `site/`, and on staging also the new
design's own site.

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

After the portal's first deploy, map its domain. The domain must be verified for the project first
(`gcloud domains verify vaultlearninggames-staging.org`). Keep the Cloudflare DNS record **DNS only** (grey cloud)
until Google has issued the certificate.

```bash
gcloud beta run domain-mappings create --region=$REGION --service=vault-publisher-staging --domain=portal.vaultlearninggames-staging.org
```

The website's address is an R2 custom domain, not a Cloud Run mapping: [The website on R2](#the-website-on-r2).

## 7. Scheduled tasks

**Nightly cleanup (production only).** Already set up for production (skip if
`gcloud scheduler jobs list --location=$REGION` shows it). Staging has too few builds to need it.

```bash
gcloud iam service-accounts create vault-publisher-scheduler --display-name "vault-publisher cleanup"
gcloud scheduler jobs create http vault-publisher-cleanup --location=$REGION \
  --schedule="0 8 * * *" --http-method=POST \
  --uri=https://portal.vaultlearninggames.org/v1/tasks/cleanup \
  --oidc-service-account-email=vault-publisher-scheduler@$PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience=vault-publisher-tasks
```

**URL monitors.** The cleanup job also checks URL monitors (games copied from a studio's own site, *Upload builds*
path 4) after its cleanup, for at most 100 seconds, the one checked longest ago first. That covers production while
there are a few small games. For more of them, bigger ones, or more than one check a day, add a job for the
monitors' own route, which may run for 12 minutes:

```bash
gcloud scheduler jobs create http vault-publisher-monitors --location=$REGION \
  --schedule="30 */6 * * *" --http-method=POST --attempt-deadline=15m \
  --uri=https://portal.vaultlearninggames.org/v1/tasks/monitors \
  --oidc-service-account-email=vault-publisher-scheduler@$PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience=vault-publisher-tasks
```

and raise the service's request timeout to match (`--timeout=900` in the deploy workflow's `flags`; Cloud Run's
default is 300 seconds, which also bounds one **Check now** in the portal at 4 minutes).

**Staging has no Scheduler job**, so its monitors are only checked with **Check now**. To check them on a schedule,
create the same job with `--uri=https://portal.vaultlearninggames-staging.org/v1/tasks/monitors` (staging's
`TASK_INVOKER_EMAIL` is already the scheduler service account, and the audience is the same).

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

## The website on R2

The website (`site/`) is a few hundred static files. The deploy workflow builds them and `scripts/site-sync.ts`
uploads them to the system's site bucket; Cloudflare serves the bucket at the site's address. Nothing runs for the
site: no Cloud Run service, no nginx. Listing previews are rendered by the portal (`/_preview/TOKEN/`), which
carries `site/` and Hugo in its image.

**State on 2026-10-02 (staging).** `site-vaultlearninggames-staging` exists, holds a build of the site and answers
at the test address `https://r2-site.vaultlearninggames-staging.org` (its files only: `/wake/index.html` works,
`/wake/` not yet, because the zone rules below are not created). `vaultlearninggames-staging.org` is still the old
Cloud Run site. Left to do, in order: A (key), B (rules on the test address, check), then the cutover.

### What each piece does

| nginx did | Now |
| --- | --- |
| Served files with a type by extension | `site-sync.ts` sets each object's `Content-Type` (same types; `.js` is `text/javascript`, `sitemap.xml` `application/xml`) |
| `Cache-Control: public, max-age=3600` on assets, none on pages | Set per object at upload: pages, `sitemap.xml` 60 s; snapshot images (`name-<6 hex>.ext`) and fonts 30 days; everything else 1 hour. The stylesheet and script are requested as `?v=<hash>`. A cache rule makes Cloudflare follow these (without it, it raises browser lifetimes under 4 hours to 4 hours, as it does in front of nginx today) |
| `/lakeland/` → `lakeland/index.html` | Rewrite rule: a path ending in `/` gets `index.html` appended |
| `/lakeland` → 301 `/lakeland/` (also with a query: `/game-cards?offset=20`) | Redirect rule: a path with no `.` and no trailing `/` → 301 to the path + `/`, query kept. Differences: the `Location` is absolute; an address that doesn't exist is redirected once before its 404; a folder whose name contains a `.` isn't redirected (the site has none; a filter name with a `.` in it would be the first) |
| `/s/keys-to-the-vault.pdf` → 301 `/files/keys-to-the-vault.pdf` | Redirect rule |
| `/game-cards/category/Dev%3A+Field+Day+Lab` | The object is `game-cards/category/Dev:+Field+Day+Lab/index.html`; R2 decodes `%3A`, `%26`, `%2B` and keeps `+`, like nginx |
| `X-Robots-Tag: noindex` (staging) / `all` (production) on every response | Response header rule |
| gzip | Cloudflare compresses (Brotli or gzip) |
| `/_preview/TOKEN/` proxied to the site's preview service | The portal: `PORTAL/_preview/TOKEN/` |
| The site's 404 page (`404.html`), status 404 | **Status 404, but Cloudflare's plain "Not Found" page, not ours.** Showing `404.html` for a missing object needs a Custom Error Rule (Cloudflare Pro plan and up; the zones are Free) or a Worker. Not done: decide between the Pro plan for the zone, a Worker (or Workers static assets) in front of the bucket, and living with the plain page |

Fonts and scripts are fetched by preview pages on the portal's address, so the bucket has a CORS policy that allows
`GET` and `HEAD` from any origin. The Adobe Fonts kit (`zxo3yez`) must list the portal's domain as well as the
site's, or previews fall back to the stand-in heading font.

### A. The bucket's key (once per system)

Cloudflare dashboard → R2 → Manage API tokens → Create Account API token: *Object Read & Write*, *Apply to specific
buckets only* → `site-vaultlearninggames-staging`, no expiry. Then store the two values and let the deploy account
(not the portal) read them:

```bash
newsecret vault-publisher-staging-r2-site-access-key-id
newsecret vault-publisher-staging-r2-site-secret-access-key
for s in r2-site-access-key-id r2-site-secret-access-key; do
  gcloud secrets add-iam-policy-binding vault-publisher-staging-$s \
    --member=serviceAccount:fieldday-github-deployer@$PROJECT.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
done
gh variable set SITE_BUCKET --env staging --body site-vaultlearninggames-staging -R VaultLearningGames/vault-publisher
gh variable set PREVIEW_SITES --env staging -R VaultLearningGames/vault-publisher \
  --body "Site=https://portal.vaultlearninggames-staging.org New=https://new-design.vaultlearninggames-staging.org"
```

The deploy also gives the portal 1 GiB of memory (`--memory=1Gi` in the workflow; it was 512 MiB) for the Hugo runs.

### B. The zone rules (once per hostname)

`scripts/cloudflare-site-rules.sh HOST ROBOTS` prints the five rules; `--apply` creates or updates them, `--delete`
removes them. Each rule matches one hostname only, and the script adds and changes single rules, never a whole
ruleset. It needs a token with *Zone → Single Redirect: Edit, Transform Rules: Edit, Cache Rules: Edit* on the zone
(the R2/DNS token used for the bucket can't read or write rules).

```bash
export CLOUDFLARE_API_TOKEN   # a token with the three rule permissions on vaultlearninggames-staging.org
scripts/cloudflare-site-rules.sh r2-site.vaultlearninggames-staging.org noindex            # look at them
scripts/cloudflare-site-rules.sh r2-site.vaultlearninggames-staging.org noindex --apply
T=https://r2-site.vaultlearninggames-staging.org
curl -sI $T/ | head -1                                   # 200
curl -sI $T/lakeland | grep -iE '^(HTTP|location)'       # 301, location: …/lakeland/
curl -sI $T/lakeland/ | grep -iE '^(HTTP|x-robots|cache-control)'   # 200, noindex, max-age=60
curl -sI "$T/game-cards?offset=20" | grep -i location    # …/game-cards/?offset=20
curl -sI "$T/game-cards/category/Dev%3A+Field+Day+Lab" | grep -iE '^(HTTP|location)'
curl -sI $T/s/keys-to-the-vault.pdf | grep -i location   # …/files/keys-to-the-vault.pdf
curl -sI $T/nope/ | head -1                              # 404
```

These rules have not been run against Cloudflare yet (no token with the permissions existed when they were
written). If Cloudflare refuses an expression, fix it in the script; the first check above is where it shows.

### Cutover: `vaultlearninggames-staging.org` from Cloud Run to R2

Before: the branch is on `main` and deployed (the portal renders previews; the deploy has published the site to the
bucket at least once: check the run's summary), A and B are done and the checks on the test address pass.

The rules are safe to put on the live hostname while it is still nginx (they do what nginx does), so the only
moment of change is the DNS switch. The apex is a proxied CNAME to `squarespace-design.vaultlearninggames-staging.org`
today; R2 creates its own record and refuses while another record has the name, so the old record is deleted first.
Expect up to a minute of errors between steps 2 and 3.

```bash
set -a; . ~/.config/vault-setup/cloudflare.env; set +a      # R2 + DNS token; RULES_TOKEN: the rules token from B
A=53908534e6b25253c988befce2f9ad21 Z=5c261ab6d128ad7cfc70e8a9b829d1b3 H=vaultlearninggames-staging.org
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
API=https://api.cloudflare.com/client/v4

# 1. Rules for the live hostname (no visible change while it is still nginx).
CLOUDFLARE_API_TOKEN=$RULES_TOKEN scripts/cloudflare-site-rules.sh $H noindex --apply

# 2. Delete the apex CNAME (note its id and content for the rollback).
cf "$API/zones/$Z/dns_records?type=CNAME&name=$H" | jq -c '.result[]|{id,name,content,proxied}'
REC=$(cf "$API/zones/$Z/dns_records?type=CNAME&name=$H" | jq -r '.result[0].id')
cf -X DELETE "$API/zones/$Z/dns_records/$REC" | jq .success

# 3. Attach the hostname to the bucket.
cf -X POST "$API/accounts/$A/r2/buckets/site-vaultlearninggames-staging/domains/custom" \
  -d "{\"domain\":\"$H\",\"zoneId\":\"$Z\",\"enabled\":true,\"minTLS\":\"1.2\"}" | jq -c '{success,errors}'
cf "$API/accounts/$A/r2/buckets/site-vaultlearninggames-staging/domains/custom" | jq -c '.result.domains[]|{domain,status}'

# 4. Check (the same checks as B, with T=https://$H), then a listing preview from the portal's editor.
curl -sI https://$H/wake/ | grep -iE '^(HTTP|server|x-robots|cache-control|cf-cache-status)'
```

**Rollback** (back to the Cloud Run site, which is left running and mapped until the move is settled):

```bash
cf -X DELETE "$API/accounts/$A/r2/buckets/site-vaultlearninggames-staging/domains/custom/$H" | jq .success
cf -X POST "$API/zones/$Z/dns_records" \
  -d "{\"type\":\"CNAME\",\"name\":\"$H\",\"content\":\"squarespace-design.vaultlearninggames-staging.org\",\"proxied\":true,\"ttl\":1}" | jq .success
# The rules can stay (nginx behaves the same with them) or go:
CLOUDFLARE_API_TOKEN=$RULES_TOKEN scripts/cloudflare-site-rules.sh $H - --delete
```

Afterwards, when staging has run on R2 for a while: delete the test hostname (`r2-site.`: remove the bucket's custom
domain, then its rules with `--delete`), and retire Cloud Run `vault-site-original-staging` with its domain mappings
(`squarespace-design.` and the apex) and the `staging-original` environment in `vault-hugo-rebuild`. `www.` still
points at the old Cloud Run site; redirect it to the apex or remove it. `new-design.` stays as it is.

### Production, at launch

1. R2: create `site-vaultlearninggames`; CORS policy: `GET`, `HEAD` from `*`; its key as in A, with
   `vault-publisher-r2-site-access-key-id` / `-secret-access-key` and `SITE_BUCKET=site-vaultlearninggames`,
   `PREVIEW_SITES=Site=https://portal.vaultlearninggames.org` in the `production` environment. Until `SITE_BUCKET`
   is set, production deploys build the site and publish nothing.
2. Deploy `production`; the run's summary shows the site published. Check a file through the bucket's test hostname
   if one is attached.
3. Rules: `scripts/cloudflare-site-rules.sh vaultlearninggames.org all --apply` (and the same for `www.` or a
   redirect from it). `all`, not `noindex`.
4. Adobe Fonts kit `zxo3yez`: add `portal.vaultlearninggames.org` to its domains.
5. DNS: the apex and `www` point at Squarespace. Replace them by attaching `vaultlearninggames.org` to the bucket
   (as cutover steps 2 and 3), keeping the old records' values for the rollback.
6. `FORMS_ALLOWED_ORIGINS` already lists the site's addresses; the forms post to the production portal through the
   `HUGOxPARAMSxFORMSx…` overrides the deploy sets from `PORTAL_URL`.

### Rebuilding the site when listings change

Publishing a listing changes `/v1/catalog`, not the site: someone runs *Deploy (portal and site)* with *Rebuild the
site only* (README, [The website](../README.md#the-website)). Not built yet: the portal starting that run itself.
Two ways it could: (a) the portal calls GitHub's `workflow_dispatch` for `deploy.yml` (`site_only=true`) a couple of
minutes after the last publish, unpublish or featured change, which needs a GitHub credential with *Actions: write*
on this repository in Secret Manager; or (b) a scheduled workflow that compares the catalog with the one the
published site was built from (a hash stored as an object in the bucket) and rebuilds only when they differ, which
needs no new credential and is at most one schedule interval late.

## 9. Pilot

Add the caller workflow from the README to a branch of `fielddaylab/wake`, push, and open
`https://builds.vaultlearninggames.org/fieldday/aqualab/<branch>/`. Check:

- the game loads (Aqualab is Unity 2019 / gzip) in Chrome, Safari and on an iPad;
- a newer Unity game with Brotli (`.br`) files also loads;
- Aqualab's save server accepts requests from the new origin (CORS);
- deleting the branch removes the preview.

## Operating notes

- **Getting builds in:** the four paths studios have (a GitHub Action step, an automatic publish request, a .zip in
  the portal, a monitored web address) are described in the [README](../README.md#upload-builds). Studios pin the
  action at `@v1`, so a change to `action/` reaches them only when the `v1` tag is moved to a commit that has it:
  `mode: request-release` (path 2) needs that once.
- **URL monitors** fetch only public `http(s)` addresses (never private, loopback or link-local ones, also after
  redirects; `src/net-guard.ts`) and identify themselves as `VaultLearningGames-url-monitor/1`. Each monitor's last
  result is on the studio's *Upload builds* page; a failed check never changes the test build. A monitored test build
  (`web-copy`) is exempt from the 90-day cleanup while its monitor exists. Design and limits:
  [url-monitor.md](url-monitor.md).

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
