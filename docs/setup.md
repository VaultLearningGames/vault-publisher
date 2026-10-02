# One-time setup

Vault runs two complete, separate systems. They share code and nothing else: each has its own site, portal and
deployer, database, R2 buckets, keys and GitHub OAuth app. Both the portal and the website are in this repository
and deploy together (`.github/workflows/deploy.yml`): the portal to Cloud Run, the website (`site/`, static files)
to Cloudflare's static hosting (a Worker with files and no script).

| | Production | Staging |
|---|---|---|
| Public site (`site/`) | `vaultlearninggames.org` → Worker `vault-site` (still Squarespace until launch) | `vaultlearninggames-staging.org` → Worker `vault-site-staging` (see [The website on Cloudflare static hosting](#the-website-on-cloudflare-static-hosting) for the state of the move from R2) |
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
| `site-vaultlearninggames-staging`, `site-vaultlearninggames` | `r2-site.` test addresses | no longer published to: the website moved to static hosting (2026-10-02). To delete: [Cleanup](#cleanup-after-the-cutovers) |

**Rules** (on each zone, per hostname):
- every `cdn.` and `builds.` host: *URL rewrite*: when the path ends with `/`, rewrite it to the path + `index.html`;
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
  PREVIEW_SITES=Site=https://portal.vaultlearninggames.org SITE_WORKER=vault-site \
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
  SITE_WORKER=vault-site-staging \
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
and images from. `SITE_WORKER` is the Cloudflare Worker the deploy publishes the site to (`vault-site-staging`,
`vault-site`; with the environment's `CLOUDFLARE_API_TOKEN` secret and the repository's `CLOUDFLARE_ACCOUNT_ID`:
[The deploy's Cloudflare token](#the-deploys-cloudflare-token)); an environment without it builds the site as a
check and publishes nothing. `PREVIEW_SITES` lists where the editor's Preview buttons open
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

The website's addresses are attached to its Cloudflare Worker, not mapped to Cloud Run:
[Hostnames](#hostnames).

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

## The website on Cloudflare static hosting

The website (`site/`) is a few hundred static files. The deploy workflow builds them and publishes the build to the
system's **Worker** (`vault-site-staging`, `vault-site`) as Workers Static Assets: Cloudflare stores the files and
serves them itself. No script runs, nothing is billed or counted per request, and nothing else is involved: no
bucket, no zone rule (one exception: `www` → apex), no Cloud Run service, no nginx. Listing previews are rendered by
the portal (`/_preview/TOKEN/`), which carries `site/` and Hugo in its image.

It replaced "R2 bucket + custom domain + five zone rules" on 2026-10-02, because an R2 custom domain can't answer a
missing address with the site's own 404 page.

| Piece | Where |
| --- | --- |
| The two Workers, how a folder and a missing address are answered | `cloudflare/site/wrangler.jsonc` |
| Cache lifetimes, `X-Robots-Tag`, CORS, redirects: the build's `_headers` and `_redirects` | written by `src/site-hosting.ts` at the end of `npm run site:build` |
| wrangler, pinned | `cloudflare/site/package.json` + `package-lock.json` (`npm ci --prefix cloudflare/site`) |
| Publishing | the deploy workflow's last step: `wrangler deploy --env staging\|production` |
| Which hostnames a Worker answers at | attached once by an admin: `scripts/cloudflare-site-hosts.sh` |
| Checking a served copy against its build | `scripts/site-check.ts`; on this machine with the real runtime: `cloudflare/site/check.sh` |

**State on 2026-10-02.** `vault-site-staging` exists (deployed by hand from this branch) and answers at the test
address `https://static.vaultlearninggames-staging.org`, where every check passes. `vaultlearninggames-staging.org`
is still the R2 bucket, `www.` there the old Cloud Run site, and production is untouched (`vault-site` does not exist
yet; `vaultlearninggames.org` is Squarespace). Left to do: [the deploy's token](#the-deploys-cloudflare-token), then
the [staging cutover](#cutover-vaultlearninggames-stagingorg-from-r2-to-the-worker), then
[production](#production-at-launch), then the [cleanup](#cleanup-after-the-cutovers).

### What each piece does

| The site needs | How |
| --- | --- |
| Every page at its Squarespace address, which has no trailing slash: `/lakeland` is `lakeland/index.html`, answered 200 at once. It is the address Google has indexed, the page's canonical link, its sitemap entry and what the site's own links say | `html_handling: drop-trailing-slash`; `partials/sq/canonical.html` and `layouts/sitemap.xml` in the theme |
| `/lakeland/` → 301 `/lakeland`, query string kept | A line per page in `_redirects` (`/lakeland/ /lakeland 301`). Without the line the hosting redirects too, with a 307 |
| `/game-cards/category/Dev%3A+Field+Day+Lab`, `/game-cards/tag/Subject%3A+Family%2FConsumer+Science` (68 filter pages, spelled as Squarespace spelled them; the folders are `Dev:+Field+Day+Lab` and `Subject:+Family/Consumer+Science`) | The hosting serves a file only at the spelling `encodeURIComponent` gives each folder (`Dev%3A%2BField%2BDay%2BLab`) and redirects any other spelling there. A `200` line in `_redirects` per filter page serves Squarespace's spelling at once: `/…/Dev%3A+Field+Day+Lab /…/Dev%3A%2BField%2BDay%2BLab 200` |
| `/game-cards/<card>` (99 on Squarespace: each game's Game Card, an indexed page of its own, some with ids like `blog-post-title-one-kma9a`) → 301 to the game's page | Hugo writes the list (`card-redirects.json`, from `data/squarespace/games.json`; not published), `src/site-hosting.ts` turns it into `_redirects` lines and refuses a target that isn't a page |
| `robots.txt` | Written by `src/site-hosting.ts`: nothing disallowed (Squarespace's file only kept crawlers out of its own machinery); production's names `https://vaultlearninggames.org/sitemap.xml`, other builds name none. Without a file of the site's, Cloudflare answers `/robots.txt` with its own comment-only "content signals" text; with one, the site's is served unchanged (checked on staging), as long as the zone's *managed robots.txt* (AI Crawl Control) stays off |
| Title, description, canonical, Open Graph and structured data (JSON-LD: WebSite and Organization; on a game's page also the WebPage) | `partials/sq/head.html`. Titles and descriptions are Squarespace's where it had them (`seo_title`, `seo_description`); a game without one gets its short description |
| `/s/keys-to-the-vault.pdf` → 301 `/files/keys-to-the-vault.pdf` | `_redirects` |
| The site's 404 page with status 404, at any depth | `not_found_handling: 404-page` serves the build's `/404.html` |
| Cache lifetimes: pages and `sitemap.xml` 60 s; snapshot images (`name-<6 hex>.ext`) and fonts 30 days; everything else 1 hour (the stylesheet and script are requested as `?v=<hash>`) | `_headers`: `/*` is the page lifetime, then a rule per folder or file that differs, worked out from the files of the build (9 rules today; Cloudflare allows 100, and the build fails beyond that) |
| `X-Robots-Tag: noindex` on staging and on every test address; `all` at `vaultlearninggames.org` only | `_headers`: `noindex` for `/*`, and in production's build (`SITE_INDEX_HOST`, set by the workflow) a rule for `https://vaultlearninggames.org/*` that replaces it with `all` |
| Fonts, stylesheet and script readable by preview pages on the portal (sandboxed: origin `null`) | `_headers`: `Access-Control-Allow-Origin: *` on everything |
| `www.` → the apex | The one zone rule left: `Site www.HOST: redirect to HOST` (`scripts/cloudflare-site-hosts.sh www-redirect`). It runs before the Worker; `www` is attached to the Worker only to have a DNS record and a certificate |
| Compression | Cloudflare (Brotli or gzip) |
| A deploy never shows half a site | A deploy is one new version of the Worker: all files change at once, and files that didn't change aren't uploaded again |

The Adobe Fonts kit (`zxo3yez`) must list the portal's domain as well as the site's, or previews fall back to the
stand-in heading font.

**What changed for a visitor, compared with the bucket** (measured on 2026-10-02 between
`static.vaultlearninggames-staging.org` and `vaultlearninggames-staging.org`, same build: `scripts/site-check.ts
--compare`; all 482 files have the same status, cache lifetime and `X-Robots-Tag`, and 479 the same bytes):

- A missing address is the site's 404 page (the reason for the move). `/nope` is a 404 at once; it was a 301 to
  `/nope/` and then a 404. A missing file under `/sq/img` or `/sq/fonts` is the 404 page with that folder's 30-day
  lifetime: lifetimes go by address, not by answer.
- Redirects have a relative `Location` (`/wake`, was `https://HOST/wake/`) and carry `Cache-Control: max-age=60`.
- Since the move to Squarespace's own addresses (no trailing slash; the bucket served `/wake/` and redirected
  `/wake` to it): `/wake` is the page and `/wake/` the 301.
- A page of the build that is not a page folder gets a 307 where it got a 200: `/wake/index.html` → `/wake`,
  `/404.html` → `/404`, and a filter address typed with a literal `:` (`/game-cards/category/Dev:+Field+Day+Lab`) →
  `/game-cards/category/Dev%3A%2BField%2BDay%2BLab`, which is then served. The addresses the site links to and
  lists in its sitemap are all served at once.
- `Range` requests get the whole file (200, not 206): only the PDF (6.6 MB) could notice; a browser's viewer loads
  it whole.
- `Content-Type` has no `; charset=utf-8` on pages, the stylesheets and the script (pages declare it in their
  `<meta charset>`), and icons are `image/vnd.microsoft.icon`.
- `Access-Control-Allow-Origin: *` is on every answer, not only when the request has an `Origin`. An `OPTIONS`
  request gets 405 (the bucket answered 204); browsers send none for fonts, stylesheets or scripts.
- Cloudflare's *Email Address Obfuscation* (a zone setting) no longer rewrites the pages: the three pages that show
  `fielddaylab@wisc.edu` as text (`/angle-jungle/`, `/pick-your-plate/`, `/privacy-policy/`) now send it as written,
  without Cloudflare's decoding script.
- A deploy is live at once, for every file together (the bucket was cached at the edge for a file's lifetime).

### The deploy's Cloudflare token

The workflow publishes with `CLOUDFLARE_API_TOKEN`, a **secret of the GitHub environment**, and the repository
variable `CLOUDFLARE_ACCOUNT_ID`. `wrangler deploy` of this configuration calls only
`/accounts/ACCOUNT/workers/scripts/NAME/…` (`assets-upload-session`, `versions`, `deployments`, `script-settings`,
`subdomain`) and `/workers/services|workers/NAME` (seen with `WRANGLER_LOG=debug`), so the token needs exactly one
permission: **Account → Workers Scripts → Edit**. No zone permission: it can't read or change DNS records, rules,
routes or R2. Cloudflare has no per-Worker scope, so either system's token could publish the other's Worker; there
are two so that each lives in one environment and can be revoked alone.

Create it (once per system; Cloudflare dashboard, as an account admin):

1. **Manage Account → Account API Tokens → Create Token → Create Custom Token** (an account-owned token doesn't
   depend on one person's login; *My Profile → API Tokens* works the same if the account has no such page).
2. Name: `vault-publisher deploy: site (staging)`.
3. Permissions: one row, **Account · Workers Scripts · Edit**. Add nothing else.
4. Account Resources: **Include · the Vault account** only. No zone resources (there is no zone permission).
5. No IP filter (GitHub's runners); no end date, or one with a reminder to replace it.
6. **Create Token**, copy it once, and store it without it passing through a command line or a chat:

```bash
R=VaultLearningGames/vault-publisher
gh secret set CLOUDFLARE_API_TOKEN --env staging -R $R          # prompts; paste the token
gh variable set CLOUDFLARE_ACCOUNT_ID --body 53908534e6b25253c988befce2f9ad21 -R $R   # repository level: one account
gh variable set SITE_WORKER --env staging --body vault-site-staging -R $R
gh variable delete SITE_BUCKET --env staging -R $R
```

Not checked yet (no token with only this permission existed on 2026-10-02): that it is refused when it tries to
attach a hostname. Once it exists, this must answer `"success": false`; if it answers `true`, detach the hostname
(`scripts/cloudflare-site-hosts.sh detach token-check.vaultlearninggames-staging.org --apply`, admin token) and note
here that the deploy's token can add hostnames:

```bash
printf 'deploy token: '; read -rs T; echo
curl -sS -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  https://api.cloudflare.com/client/v4/accounts/53908534e6b25253c988befce2f9ad21/workers/domains \
  -d '{"hostname":"token-check.vaultlearninggames-staging.org","service":"vault-site-staging","zone_id":"5c261ab6d128ad7cfc70e8a9b829d1b3","environment":"production"}' | jq -c '{success, errors}'
```

An environment without `SITE_WORKER` builds and checks the site and publishes nothing (production, until launch).

### Hostnames

A deploy never names a hostname (`wrangler.jsonc` has no route), and deploying again leaves attached hostnames as
they are (checked: three deploys, the test address stayed). Attaching one is an admin step, once per hostname,
because it creates the hostname's DNS record and certificate, which the deploy's token must not be able to do:

```bash
set -a; . ~/.config/vault-setup/cloudflare.env; set +a      # an admin token: see the head of the script
scripts/cloudflare-site-hosts.sh status HOST                # only reads: DNS records, bucket domain, Worker, rules
scripts/cloudflare-site-hosts.sh attach HOST WORKER [--replace-dns] --apply
scripts/cloudflare-site-hosts.sh detach HOST --apply
scripts/cloudflare-site-hosts.sh remove-r2 HOST --apply     # the bucket's custom domain and the five R2-era rules
scripts/cloudflare-site-hosts.sh www-redirect www.DOMAIN --apply
```

Without `--apply` each prints what it would do. The script refuses a hostname outside the two Vault zones, `cdn.`,
`builds.` and `portal.`, a staging hostname on the production Worker (and the reverse), and attaching a hostname
that is still on the bucket or still has its R2-era rules: the *directory index* rule rewrites `/wake/` to
`/wake/index.html` before the Worker sees it, which the Worker answers with a redirect to `/wake/`, for ever.

Detaching removes the hostname's DNS record. A resolver that asks during a gap between a detach (or a deleted
record) and the next attach remembers "no such address" for up to half an hour (the zone's negative lifetime), so
do the two steps of a move in one command line, not minutes apart.

To check a served copy, build what was published and compare (the forms' addresses are part of the pages, so the
build needs the same variables as the workflow's):

```bash
# Staging. For production: its portal and site addresses, and also SITE_INDEX_HOST=vaultlearninggames.org and
# HUGOxPARAMSxANALYTICSxGOOGLE=<the environment's GOOGLE_ANALYTICS_ID>.
P=https://portal.vaultlearninggames-staging.org S=https://vaultlearninggames-staging.org
VAULT_PORTAL=$P HUGO_BASEURL=$S/ HUGOxPARAMSxFORMSxNEWSLETTER=$P/v1/forms/newsletter \
  HUGOxPARAMSxFORMSxSUBMIT_GAME=$P/v1/forms/submit-game npm run site:build
node scripts/site-check.ts https://static.vaultlearninggames-staging.org     # at vaultlearninggames.org: --robots all
```

It fetches every file and sitemap address (200 at once, the build's bytes, type, lifetime, robots, CORS), every
page with a trailing slash (301 to the page), every line of `_redirects` (the `/game-cards/<card>` addresses and
their targets, the PDF's old address), missing addresses (404 with the site's page), and every address the pages
link to (200 at once); and it reads each page of the build: its canonical address is the one it is served at, it
has no `noindex` tag, it has a title, Open Graph tags and structured data, and the sitemap lists exactly the pages. `--compare OTHER` lists what differs from
another copy. A listing published between the deploy and the check shows as pages whose bytes differ.

### Cutover: `vaultlearninggames-staging.org` from R2 to the Worker

Before: the deploy's token, `SITE_WORKER` and `CLOUDFLARE_ACCOUNT_ID` are set for staging (above) **before this
branch reaches `main`**: from that commit on the workflow no longer writes to the bucket, so the bucket's copy (and
with it the live staging site, and the stylesheet previews load) stays as it was until the cutover. Then: the push to
`main` has published (the run's summary says *Site published to the Worker `vault-site-staging`*), and the check
above passes at `static.vaultlearninggames-staging.org`.

```bash
set -a; . ~/.config/vault-setup/cloudflare.env; set +a
H=vaultlearninggames-staging.org; S=scripts/cloudflare-site-hosts.sh
$S status $H; $S status www.$H                              # what is there now; keep the output
# The apex: off the bucket and its rules, onto the Worker. One line: the hostname has no address in between.
$S remove-r2 $H --apply && $S attach $H vault-site-staging --apply
# www (today a CNAME to the old Cloud Run site): onto the Worker, and redirected to the apex like production's.
$S attach www.$H vault-site-staging --replace-dns --apply && $S www-redirect www.$H --apply
node scripts/site-check.ts https://$H
curl -sI https://www.$H/wake | grep -iE '^(HTTP|location)'  # 301, https://vaultlearninggames-staging.org/wake
```

Then open a listing preview from the portal's editor (its stylesheet, script and fonts now come from the Worker).

**Rollback** (the bucket still holds the site as of the last R2 deploy, and nothing updates it any more):

```bash
A=53908534e6b25253c988befce2f9ad21 Z=5c261ab6d128ad7cfc70e8a9b829d1b3 API=https://api.cloudflare.com/client/v4
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
$S detach $H --apply && cf -X POST "$API/accounts/$A/r2/buckets/site-vaultlearninggames-staging/domains/custom" \
  -d "{\"domain\":\"$H\",\"zoneId\":\"$Z\",\"enabled\":true,\"minTLS\":\"1.2\"}" | jq -c '{success,errors}'
scripts/cloudflare-site-rules.sh $H noindex --apply         # the five rules the bucket needs
# www, as it was:
$S detach www.$H --apply && cf -X POST "$API/zones/$Z/dns_records" \
  -d "{\"type\":\"CNAME\",\"name\":\"www.$H\",\"content\":\"squarespace-design.$H\",\"proxied\":true,\"ttl\":1}" | jq .success
# and delete the rule "Site www.$H: redirect to $H" in the dashboard (Rules → Redirect Rules).
```

To publish to the bucket again, revert the commit that moved the workflow to the Worker.

### Production, at launch

Any time before, with no visible change:

1. The deploy's token for production, as [above](#the-deploys-cloudflare-token), named `… (production)`:
   `gh secret set CLOUDFLARE_API_TOKEN --env production`, `gh variable set SITE_WORKER --env production --body
   vault-site`. The next production deploy (or *Rebuild the site only*) creates `vault-site` and publishes to it.
2. A test address: `scripts/cloudflare-site-hosts.sh attach static.vaultlearninggames.org vault-site --apply`, then
   the check above with production's addresses (`https://static.vaultlearninggames.org`: `noindex` there, because
   only `vaultlearninggames.org` itself is indexed).
3. Remove the five R2-era rules that were prepared for the real hostname (they do nothing while it is Squarespace,
   and would loop on the Worker): `scripts/cloudflare-site-hosts.sh remove-r2 vaultlearninggames.org --apply`.
   The rule *Site www.vaultlearninggames.org: redirect to vaultlearninggames.org* stays.
4. Adobe Fonts kit `zxo3yez`: add `portal.vaultlearninggames.org` to its domains. `FORMS_ALLOWED_ORIGINS` already
   lists the site's addresses.

The launch, in the Cloudflare dashboard (zone `vaultlearninggames.org`). Today the apex has four `A` records to
Squarespace (`198.185.159.144`, `198.185.159.145`, `198.49.23.144`, `198.49.23.145`) and `www` is a `CNAME` to
`ext-sq.squarespace.com`, all *DNS only*:

1. **DNS → Records**: delete the four `A` records of `vaultlearninggames.org` and the `CNAME` of `www`. Touch
   nothing else: the five `MX` and two `TXT` records (mail forwarding, SPF, Google's verification) stay, and so do
   `cdn`, `builds`, `portal`, `r2-site` and `static`.
2. **Workers & Pages → `vault-site` → Settings → Domains & Routes → Add → Custom domain**:
   `vaultlearninggames.org`; then again for `www.vaultlearninggames.org`. Cloudflare creates each record (proxied)
   and its certificate.
3. Check: `node scripts/site-check.ts https://vaultlearninggames.org --robots all` (after a production build, as
   under [Hostnames](#hostnames)), and
   `curl -sI https://www.vaultlearninggames.org/wake | grep -iE '^(HTTP|location)'` (301 to the apex).

Do 1 and 2 without a pause (see the note on gaps under Hostnames). The script does both at once per hostname, if
that is preferred: `scripts/cloudflare-site-hosts.sh attach vaultlearninggames.org vault-site --replace-dns --apply`
and the same for `www.`; it prints the records it deletes.

**Rollback:** Domains & Routes → remove both custom domains (or `detach … --apply`), then re-create the four `A`
records and the `www` `CNAME` above, *DNS only*. Nothing on Squarespace's side changes at launch, so it answers
again as soon as the records are back; keep the Squarespace site until the move is settled.

### Search engines, around the launch

The aim is that nothing changes for a search engine except who answers. Compared on 2026-10-02, for the 266
addresses of Squarespace's sitemap: the 167 pages answer 200 at once at the same address, with the same `<title>`
and canonical link (one exception: `/docduck-rock-cycle`, a 404 on Squarespace, is a page here); the 14 pages that
had a description keep it and 85 game pages gain one; the 99 `/game-cards/<card>` addresses answer 301 to their
game's page. Not carried over: `/cart` and `/search` (Squarespace's own pages; 404 here), the RSS feed
(`/game-cards?format=rss` answers the page), and the images' addresses (they were on Squarespace's CDN, and go
when the Squarespace site does).

Before the DNS records move:

1. Production is deployed from a commit with these addresses, and `scripts/site-check.ts
   https://static.vaultlearninggames.org` passes. `https://static.vaultlearninggames.org/robots.txt` is the site's
   file (three lines and the `Sitemap:` line), with nothing of Cloudflare's before it. If there is: zone
   `vaultlearninggames.org` → AI Crawl Control (or Security → Settings → Bot traffic) → turn *Managed robots.txt*
   off.
2. Zone `vaultlearninggames.org` → SSL/TLS → Edge Certificates → **Always Use HTTPS: on** (it is off; Squarespace
   redirects `http://` to `https://` with a 301, and without this the Worker answers `http://` with the page). It
   applies to the zone's other hostnames too (`cdn.`, `builds.`, `portal.`), which are only ever linked as https.
3. In Search Console (the property is verified by the `google-site-verification` TXT record, which stays): export
   Performance (pages and queries) and the Pages report, to compare with later.

After the move:

1. Search Console → URL inspection → *Test live URL* for `/`, `/game-cards`, a game page and a filter page: 200,
   "Indexing allowed", user-declared canonical = the address. A page that says *Excluded by noindex* means the
   request did not reach the build made for `vaultlearninggames.org` (check `curl -sI https://vaultlearninggames.org/wake
   | grep -i x-robots-tag`: `all`).
2. Sitemaps → submit `https://vaultlearninggames.org/sitemap.xml` again (same address as before; it now lists the
   pages only: the card addresses are redirects). Settings → robots.txt → request a recrawl.
3. No *Change of address*: the domain is the same.
4. Over the next weeks, Pages report: about 99 more *Page with redirect* (the cards) and a few *Not found* (`/cart`,
   `/search`) are expected; real pages under *Excluded by noindex*, *Duplicate* or *Not found* are not.
5. Keep the Squarespace site (not its domain connection) until the report has settled: it is the rollback, and its
   CDN still serves the images Google Images has indexed.

### The 404 page

`/404.html` (the television with static, `site/themes/vault-squarespace/layouts/404.html`) is in every build: the
build refuses to finish without it (`scripts/site-hosting.ts`), and the deploy checks it has no relative address (it
is shown at any depth) and is `noindex`. The hosting answers any address that has no file with it and status 404
(`not_found_handling: 404-page`); `scripts/site-check.ts` asserts that for addresses at several depths, with and
without a slash, and for a missing image. Nothing has to be applied per hostname. What was considered before the
move (a Pro plan's custom error rule; a Worker in front of the bucket; rules alone, which can only answer 200) is in
this file's history at `e0d9dfb`.

### Cleanup, after the cutovers

Nothing below is needed by the Worker; all of it was left in place on 2026-10-02 so each cutover can be rolled back.

Staging, once `vaultlearninggames-staging.org` has run on the Worker for a while:

- `scripts/cloudflare-site-hosts.sh remove-r2 r2-site.vaultlearninggames-staging.org --apply` (the bucket's test
  address and its five rules);
- the bucket `site-vaultlearninggames-staging` (empty it, delete it; its CORS policy goes with it) and its R2 API
  token (R2 → Manage API tokens);
- Secret Manager: `vault-publisher-staging-r2-site-access-key-id`, `vault-publisher-staging-r2-site-secret-access-key`;
- `gh variable delete SITE_BUCKET --env staging` (if not done with the token);
- `static.vaultlearninggames-staging.org`: keep as a second address, or `detach` it;
- as before the move: Cloud Run `vault-site-original-staging` with its domain mappings (`squarespace-design.` and
  the apex), the DNS record `squarespace-design`, and the `staging-original` environment in `vault-hugo-rebuild`.
  `new-design.` stays as it is.

Production, after launch:

- `scripts/cloudflare-site-hosts.sh remove-r2 r2-site.vaultlearninggames.org --apply`;
- the bucket `site-vaultlearninggames`, its R2 API token, and `vault-publisher-r2-site-*` in Secret Manager if they
  were created;
- `static.vaultlearninggames.org`: keep or `detach`.

Then, in this repository: `scripts/cloudflare-site-rules.sh` (kept only to remove the R2-era rules, and to put them
back in a rollback).

### Rebuilding the site when listings change

Publishing a listing changes `/v1/catalog`, not the site: someone runs *Deploy (portal and site)* with *Rebuild the
site only* (README, [The website](../README.md#the-website)). Not built yet: the portal starting that run itself.
Two ways it could: (a) the portal calls GitHub's `workflow_dispatch` for `deploy.yml` (`site_only=true`) a couple of
minutes after the last publish, unpublish or featured change, which needs a GitHub credential with *Actions: write*
on this repository in Secret Manager; or (b) a scheduled workflow that compares the catalog with the one the
published site was built from (a hash published as a file of the site) and rebuilds only when they differ, which
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
