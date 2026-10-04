# vault-publisher

The Vault Studio Portal and the Vault website, in one repository with one deploy:

- the **portal** (`src/`): studios' builds, releases and site listings, on Cloud Run;
- the **website** (`site/`, Hugo): built from the portal's published listings and served as static files by
  Cloudflare (static hosting). See [The website](#the-website).

The portal publishes web game builds to Vault Learning Games:

- **Test builds** (your studio controls them): every branch and tag →
  `https://builds.vaultlearninggames.org/STUDIO/GAME/BRANCH/`
- **Releases** (Vault releases them): `https://cdn.vaultlearninggames.org/STUDIO/GAME/` → the current release

Studios manage games, members and release requests at **https://portal.vaultlearninggames.org**. The staging portal
(`portal.vaultlearninggames-staging.org`) is for previewing features: a banner on every page says that what is saved
there is overwritten whenever the code changes ([docs/setup.md](docs/setup.md)).

## Site checks dashboard

[![Check site](https://github.com/VaultLearningGames/vault-publisher/actions/workflows/check-site.yml/badge.svg)](https://github.com/VaultLearningGames/vault-publisher/actions/workflows/check-site.yml)

How the two websites did in their latest daily [site checks](#site-checks). Red is failing (visitors hit it), yellow
is worth a look, grey means no run has reported yet. Each badge opens that system's **Vault → Site checks** page,
which lists every finding; the badge above opens the workflow's runs, where a run can be started by hand.

| | Staging | Production |
| --- | --- | --- |
| Site | [vaultlearninggames-staging.org](https://vaultlearninggames-staging.org) | [vaultlearninggames.org](https://vaultlearninggames.org) |
| Latest run | [![Latest run, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fall)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Latest run, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fall)](https://portal.vaultlearninggames.org/vault/site-checks) |
| When | [![When, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fwhen)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![When, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fwhen)](https://portal.vaultlearninggames.org/vault/site-checks) |
| Games load | [![Games load, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fgames)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Games load, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fgames)](https://portal.vaultlearninggames.org/vault/site-checks) |
| Missing assets | [![Missing assets, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fassets)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Missing assets, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fassets)](https://portal.vaultlearninggames.org/vault/site-checks) |
| Broken links | [![Broken links, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Flinks)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Broken links, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Flinks)](https://portal.vaultlearninggames.org/vault/site-checks) |
| Spelling | [![Spelling, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fspelling)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Spelling, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fspelling)](https://portal.vaultlearninggames.org/vault/site-checks) |
| Website size and speed | [![Website size and speed, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fperformance)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Website size and speed, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fperformance)](https://portal.vaultlearninggames.org/vault/site-checks) |
| Responsive design | [![Responsive design, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fresponsive)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Responsive design, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fresponsive)](https://portal.vaultlearninggames.org/vault/site-checks) |
| Game services | [![Game services, staging](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames-staging.org%2Fv1%2Fsite-checks%2Fbadge%2Fservices)](https://portal.vaultlearninggames-staging.org/vault/site-checks) | [![Game services, production](https://img.shields.io/endpoint?url=https%3A%2F%2Fportal.vaultlearninggames.org%2Fv1%2Fsite-checks%2Fbadge%2Fservices)](https://portal.vaultlearninggames.org/vault/site-checks) |

Badges refresh within about ten minutes of a run. A portal that doesn't have the site checks yet (production, until
this version reaches the `production` branch) shows its badges as not found.

## Architecture

| | |
| --- | --- |
| Runtime | Node 24 (native TypeScript, ESM) |
| Framework | [Hono](https://hono.dev) (`@hono/node-server`) — one app serves the machine API, portal UI, site forms and listing previews |
| Website | [Hugo](https://gohugo.io) 0.166 extended (`site/`); the version is the Dockerfile's `HUGO_VERSION`, used by the deploy's site build and by the image, which renders listing previews |
| Database | `node:sqlite`, plain SQL + numbered migrations (`src/db.ts`); no ORM (Postgres-portable) |
| Storage | Cloudflare R2 via AWS SDK v3 (`src/storage.ts`); build uploads are presigned PUTs (from CI and from the browser) — the API never proxies them. URL monitors stream each file from the studio's site into R2 |
| Auth | `jose`: GitHub Actions OIDC tokens (CI), Google ID tokens (scheduled tasks); portal login is interactive GitHub OAuth → HMAC-signed `vault_session` cookie (`src/portal/session.ts`) |
| Deps | `hono`, `@hono/node-server`, `@aws-sdk/client-s3` + `s3-request-presigner`, `jose`; nothing else at run time. `playwright`, `nspell` and `dictionary-en` are dev dependencies, used only by the [site checks](#site-checks) on a GitHub runner or a developer's machine; the image has no browser |

### Code layout

| File | Role |
| --- | --- |
| `src/server.ts` | Entrypoint: config, DB + R2 init, one-time release relayout, clean SIGTERM close |
| `src/app.ts` | `createApp()` — all `/v1/*` routes and shared auth/ownership checks |
| `src/admin-tasks.ts`, `src/listing-ops.ts` | `/v1/admin/listings*` (admin tasks), and the listing operations they share with the portal |
| `src/auth.ts` | OIDC/Google token verification (`jose`) |
| `src/db.ts` | Schema, migrations, all SQL access |
| `src/portal/routes.ts` | Portal HTML pages + `/portal/api/*` routes |
| `src/portal/{listings,listing-makers,people,featured,listing-preview,image-migration,availability,uploads}.ts` | Portal features by domain (`uploads.ts`: the Upload builds page, zip uploads, URL monitors) |
| `src/url-monitor.ts`, `src/net-guard.ts` | URL monitors: find a hosted game's files, copy what changed; fetch only public addresses |
| `public/setup.js` | Upload builds page: workflow snippets, and reading and uploading a zip in the browser |
| `src/{releases,storage,paths,config,forms,catalog,game-checks}.ts` | Domain logic |
| `src/studios-file.ts` | `studios.json` at startup: studios and the repositories assigned to them |
| `src/portal/site-preview.ts` | Listing previews: runs Hugo on `site/` with the previewed game in the catalog, and returns its page |
| `src/site-hosting.ts`, `scripts/site-hosting.ts` | The static hosting's `_headers`, `_redirects` and `robots.txt`, written into the built site (`site/public`) |
| `cloudflare/site/` | The site's hosting: `wrangler.jsonc` (one Worker per system, files only), the pinned wrangler, `check.sh` |
| `scripts/site-check.ts` | Checks a served copy of the site against its build: every address, redirects, 404 page, headers, and each page's canonical address, title and structured data |
| `site/` | The website: `hugo.toml`, `content/`, `data/`, `themes/vault-squarespace/`, `static/` ([site/README.md](site/README.md)) |
| `scripts/cloudflare-site-hosts.sh` | Admin, once per hostname: attach it to the site's Worker, detach it, remove its R2-era setup |
| `scripts/cloudflare-site-rules.sh` | R2-era: the five zone rules a bucket's hostname needed. Kept to remove them (and for a rollback) |
| `src/site-checks.ts`, `src/site-checks/` | [Site checks](#site-checks): what the measurements mean and the reports (`site-checks.ts`), and the engine that drives Chromium and probes links (`run.ts`; `words.txt`: spellings to accept), which only the command line and the workflow load |
| `src/analytics/`, `src/portal/analytics.ts` | [Analytics](docs/analytics.md): Google Analytics Data API client (cached), the reports, and Vault → Analytics / each game's Analytics tab; `public/analytics.{css,js}`, `public/world-map.svg` (Natural Earth, `scripts/world-map.ts`) |
| `site/themes/vault-squarespace/static/sq/js/vault-play-analytics.js` | The website's play events (`play_start`, `play_heartbeat`, `play_end`) on game pages |
| `scripts/check-site.ts`, `.github/workflows/check-site.yml` | Site checks from the command line, and daily on a GitHub runner, which posts each run to the portal |

### API

Common: JSON `{ error, detail }` errors; 4 MB body limit on `/v1/*`; every mutation writes an audit row.

| Auth | Method & path | Purpose |
| --- | --- | --- |
| GitHub OIDC (studio's CI) | `POST /v1/previews` | Start a build upload → presigned PUTs per file |
| | `POST /v1/previews/:uploadId/finalize` | Verify files landed, prune stale, record build |
| | `POST /v1/previews/delete` | Remove a branch preview |
| | `POST /v1/release-requests` | From the game's own workflow: ask Vault to publish the build this commit uploaded |
| | `POST /v1/admin/previews` + `/finalize` | Same, for Vault uploads into any studio's game |
| | `POST /v1/admin/releases/approve` · `promote` | Approve staging build as release; make current / roll back |
| | `POST /v1/admin/game-checks` | Post availability-check results |
| | `POST /v1/admin/site-checks` | A finished [site checks](#site-checks) run from the check-site workflow (`scripts/check-site.ts --out`): validated, counts recomputed, kept (latest 60) → `{ id, counts, url }` |
| | `GET /v1/admin/listings` · `POST /v1/admin/listings/{import,migrate-images,move,update}` · `GET`/`POST /v1/admin/image-variants` | [Admin tasks](#admin-tasks): the Vault-admin listing operations, for workflows |
| | `GET /v1/releases/:studio/:game[/check]` | Read-only: a game's releases, or pre-flight check of a release run |
| | `GET /v1/catalog` | Public: site listings, studios, featured games |
| | `GET /v1/site-checks/badge/:name` | Public: the [dashboard](#site-checks-dashboard)'s badges (`all`, `when`, or a check's name) from the latest site checks run, as shields.io endpoint JSON; counts only |
| Google ID token | `POST /v1/tasks/cleanup` | Nightly: expire stale previews, then check URL monitors for up to 100 s (Cloud Scheduler) |
| | `POST /v1/tasks/monitors` | Check every URL monitor (up to 12 min) |
| Public (site) | `POST /v1/forms/:name` | Website forms → Google Sheets |
| Session cookie | `GET /`, `/s/:studio`, `/s/:studio/g/:game`, `/vault/…` | Studio and Vault admin UI (HTML) |
| | `POST /portal/api/s/:studio/listings[/:slug][…]` | Listing CRUD, link, publish, unpublish, move studio, preview, makers |
| | `POST /portal/api/s/:studio/g/:game/…` | `release`, `promote`, `withdraw`, `delete`, `freeze`, `request` |
| | `POST /portal/api/requests/:id/…` | Release requests: `approve`, `reject`, `withdraw` |
| | `POST /portal/api/s/:studio/uploads` + `/:id/finalize` | A zip uploaded in the portal: presigned PUTs per file, then record the test build |
| | `POST /portal/api/s/:studio/monitors[/:id/check\|delete]` | URL monitors: register (and copy now), check now, stop |
| | `POST /portal/api/s/:studio/members[?]` | Studio members add/remove, website URL |
| | `POST /portal/api/vault/…` | Vault-admin: studios CRUD, a studio's `repositories` (add/remove), users/roles, listings import, featured |
| Public (token) | `GET /_preview/:token/` · `GET /v1/listing-previews/:token` | An unsaved listing preview, rendered as the website's page (the second answers the preview's JSON to `Accept: application/json`) |

**Admin-lane** routes (`/v1/admin/*`) additionally require the token's repository to be the admin repo running in the protected environment; **portal mutations** require a signed-in Vault-admin session.

Vault also runs a separate staging copy of all of this (site, portal, test builds, releases) on
`vaultlearninggames-staging.org` for trying new versions. Studios never need it. See [docs/setup.md](docs/setup.md).

## Upload builds

Ask Vault to register your studio (your GitHub organization or, for a game whose repository lives in someone
else's organization, that one repository), then get a web build (a folder with `index.html` at the top) onto Vault's test
server by any of four paths. The portal's **Upload builds** page has the same steps with your studio's names filled
in. Whatever the path, the build shows on the game's page as a **test build**, and reaches classrooms only when a
maintainer asks for a release and Vault approves it.

### 1. One GitHub Action step: every push becomes a test build

```yaml
# .github/workflows/vault.yml
name: Vault
on: { push: {}, workflow_dispatch: {} }
permissions: { contents: read, id-token: write }
jobs:
  vault:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # Your own build goes here. It must leave the web build in ./dist, with index.html at the top.
      # - run: npm ci && npm run build

      - uses: VaultLearningGames/vault-publisher/action@v1    # uploads this push as a test build
        with:
          game: my-game
          path: dist
          publisher-url: https://portal.vaultlearninggames.org
```

Every branch and tag goes to `https://builds.vaultlearninggames.org/STUDIO/my-game/BRANCH/` (`/` in a branch name
becomes `_`). There are no secrets to add: the step proves which repository it runs in with GitHub's OIDC token, and
the repository (or its organization) must be registered with Vault for the studio. The first repository to upload a game
name owns it. Branch builds idle for 90 days are removed; tags are kept. **Publish** from the portal: on the game's
page choose **Request release** on a test build; Vault reviews and approves it.

**Which studio a build goes to.** The publisher reads the GitHub Actions OIDC token: a repository that Vault has
assigned to a studio (matched by GitHub's numeric repository id) publishes for that studio; any other repository
publishes for the studio registered for its owner (the organization's numeric id). So one organization can hold
several studios' games: VaultLearningGames' own repositories publish as `vault`, while
`VaultLearningGames/hosted-shadowspect` publishes as `mit-education-arcade`. Games are looked up only inside that
studio, so an assigned repository and its organization's studio can't touch each other's games, even with the same
game name.

Options:

* **The web build is committed to the repository:** drop the build comment and set `path` to its folder.
* **Unity:** let Vault's shared workflow build it. Add a `build` job that
  `uses: VaultLearningGames/vault-publisher/.github/workflows/unity-build.yml@v1` (pass the `UNITY_EMAIL`,
  `UNITY_PASSWORD`, `UNITY_SERIAL` secrets explicitly; `secrets: inherit` doesn't cross organizations), then in the
  `vault` job (`needs: build`) replace checkout with `actions/download-artifact@v8`
  (`name: ${{ needs.build.outputs.artifact }}`, `path: build`) and upload `path: build`. The portal page writes this
  file for you. `publish-preview.yml@v1` and `unity-webgl.yml@v1` wrap the same steps as reusable workflows.
* **Remove a branch's test build when the branch is deleted:** add `delete: {}` to `on:`, put
  `if: github.event_name != 'delete'` on the job above, and add a second job with
  `if: github.event_name == 'delete'`, `permissions: { id-token: write }` and the action with `mode: delete`,
  `ref: ${{ github.event.ref }}`.

### 2. A second step: file the publish request automatically

Add this after the upload step, and a push to your `production` branch, a published GitHub release, or both, asks
Vault to publish the build that step just uploaded. Vault still reviews every request.

```yaml
      - uses: VaultLearningGames/vault-publisher/action@v1
        if: github.ref == 'refs/heads/production' || github.event_name == 'release'
        with:
          mode: request-release
          game: my-game
          publisher-url: https://portal.vaultlearninggames.org
```

For GitHub releases also change the top of the file, so the release run and its tag's push run take turns:

```yaml
on:
  push: {}
  release: { types: [published] }
  workflow_dispatch: {}
concurrency: { group: "vault-${{ github.ref }}", cancel-in-progress: false }
```

The request is named after the tag (`v1.2`), or `BRANCH-SHORTSHA` (`production-4f7275b`) for a branch; pass
`version:` to name it yourself (a version name can be used once per game) and `notes:` for the reviewer. It is filed
only for the test build of the same commit, running it again changes nothing, and a newer push to the branch
replaces a request Vault hasn't decided yet. It appears on the game's page and in Vault's queue as *Waiting for
Vault*.

### 3. No GitHub: upload a .zip

On **Upload builds**, studio maintainers and admins (and Vault staff, for any studio) choose a zip of the web build:
`index.html` at the top, or everything inside one top-level folder. It becomes a test build named
`upload-YYYYMMDD-HHMM` (UTC), released like any other. Limits: 1 GB zipped, 2 GB unpacked, 5,000 files.

The zip is never sent to Vault as a zip. The browser reads its file list, refuses the whole zip if any path leaves
the folder (`..`, absolute paths, drive letters), if it holds a link (symlink), is password-protected, is Zip64 or
names a file Vault reserves (`_releases/`, `_vault-assets/`, `current.json`); it then unpacks one file at a time
(stopping if a file is bigger than the zip declared, and checking its CRC) and PUTs each to the builds bucket with a
presigned URL: the same start → upload → finalize calls CI uses, so nothing is unpacked on the server and nothing
passes through Cloud Run. The portal checks every path and size again before issuing the URLs, and finalize records
the build only when every file has arrived at its declared size. The builds bucket needs a CORS rule for the portal
([docs/setup.md](docs/setup.md#1-cloudflare-r2-vault-account)). A game first created by an upload has no repository;
a repository of the studio's that later publishes the same name takes it over.

### 4. No GitHub: monitor a web address

A studio that already hosts the game registers its public address on **Upload builds**. Vault copies it into the
test build `web-copy` at once, checks it daily, and copies it again when it changes; **Check now** does it on
demand. The studio says how to find the files:

* **a file list** it publishes on the same site: text with one relative path per line (`#` comments allowed), or
  JSON (`["index.html", …]`, `[{ "path": … }]` or `{ "files": [...] }`). Make one with
  `find . -type f | sed 's|^\./||' > files.txt`;
* or **following links** from `index.html`: Vault reads it and the HTML and CSS files it leads to, and copies every
  file they mention. Files a game loads from its code (Unity, Godot and most engine builds) can't be found this way,
  so those games need a file list.

Limits: 2,000 files, 1 GB, public `http(s)` addresses only, every file on the same site inside the game's folder.
How it detects changes, what it refuses and what is left for later: [docs/url-monitor.md](docs/url-monitor.md).

## Release

From the portal: test a build on staging, then **Request release** on it. Vault copies that exact build to
production (kept at `STUDIO/GAME/_releases/VERSION/`) and makes it current: copied into `STUDIO/GAME/` itself, so
bookmarks always get the current release. Studio maintainers can then switch between approved releases or roll back
themselves, unless Vault has frozen the game (e.g. during a study) or withdrawn that release. From GitHub, a version
tag is the best thing to release, because a branch can change after it was tested.

## Games on the site and on the CDN

Each studio's **Games** page in the portal lists every game it has on Vault. A game is its **site listing** (what
vaultlearninggames.org shows), its **CDN game** (builds and releases), or both, connected:

* **Games already on the site play from their web address.** The page Vault's in-page player wraps, as the site does
  for most games today.
* **On the Vault CDN,** a game has test versions on staging and releases in production, as described above.
* **Moving a game over is one step on its page:** once its CDN game has a current release, **Where it plays** offers
  *Switch to the Vault CDN*, and *Switch back* returns it to its web address. Studio maintainers ask for it; Vault
  publishes it.

**Site listing edits** (title, descriptions, grades, subjects, topics, standards, images, play settings) are drafts:
* Studio maintainers submit them for review.
* **Made by** is a chooser over the portal's studios: tick one or more (the listing's own studio by default), in the
  order the site shows them. The listing still stores names (`makers` in the catalog), so a maker typed earlier that
  matches no studio keeps working and shows as "not a studio yet"; Vault staff make a studio of it with **Create
  studio**. **Add a new studio…** takes a name and a website: from Vault staff it creates a Vault-managed studio at
  once (no GitHub organization, short name made from the name; the rules of **Vault → Studios**). Studio members
  can't create studios, so theirs is kept with the listing as a proposal: Vault sees it in the review queue, and
  publishing the listing creates the studio.
* **Images** (hero image, thumbnail, screenshots) are a path on the site or an https link, or uploaded from the editor
  (PNG, JPEG or WebP, type checked by content; 5 MB for the hero image, 2 MB for the others). An upload is stored at
  once in the release bucket at `STUDIO/GAME/_vault-assets/KIND-HASH.EXT` (GAME is the listing's page slug; immutable,
  cached for a year; replaced images are never deleted) and its absolute `cdn.vaultlearninggames.org` URL goes into the
  draft, so it reaches the site through the same review. The site must handle both site paths and absolute https URLs
  for `hero_image`, `thumb_image` and `screenshots`. `_vault-assets/` belongs to Vault: switching releases and rollback
  leave it alone, and a build containing a top-level `_vault-assets/` folder can't be released.
* Vault publishes them from **Vault → Game Catalog**, sends them back with a note, or takes the game off the site.
* Vault staff's editor has one **Save and Publish Changes** button (saves the draft and publishes it); studio members
  have **Save and Submit for Review**: every studio save goes to Vault for review.
* **Preview** shows the editor's unsaved edits as the website would: the form is cleaned up as a save would (nothing
  is saved), turned into the game object `/v1/catalog` would publish and kept for 30 minutes (in memory) under a
  random token. The portal renders the page itself at `PORTAL/_preview/TOKEN/`: it runs Hugo on `site/` (the same
  templates as the live site, carried in the image) with the published catalog and that game put in its place, makes
  the page's addresses absolute to the site (`SITE_URL`), so its CSS, scripts and images load from the live site, and
  adds a "Preview — not published" badge.
  * At most two Hugo builds run at once (others wait), each stopped after 25 s; a rendered page is kept per token for
    3 minutes. A build takes about a third of a second.
  * Every answer is `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`. An expired or unknown token gets
    a short "This preview has expired" page (404); a failed build a short 500 page (the reason is in the log).
  * The page is sent with `Content-Security-Policy: sandbox …` (without `allow-same-origin`): listing text is the
    studio's Markdown, raw HTML included, and the portal's address holds people's sessions, so a preview gets an
    origin of its own and can't act as the person viewing it. A game opened in the preview's player is sandboxed too
    (no saved progress there).
  * `GET /v1/listing-previews/TOKEN` is the same page; a caller that sends `Accept: application/json` gets the data
    instead: `{ "version": 1, "game": <a catalog game>, "studios": <as in the catalog> }`. A site that renders its own
    previews (the new design, still on Cloud Run from `vault-hugo-rebuild`) reads it that way.
  * `PREVIEW_SITES` lists where the Preview buttons open, space-separated `label=url` pairs (`URL/_preview/TOKEN/`):
    this portal, and any site that renders its own. The first is the main Preview button, the others "Preview
    (Label)". Empty hides the buttons.
* **Copying site images to the Vault CDN** (Vault admins; `POST /portal/api/vault/listings/migrate-images` with
  `base`, the site to download from; the portal has no page for it) downloads every listing image and featured image
  that is still a site path (published and draft), stores it like an upload in `STUDIO/GAME/_vault-assets/` and
  relinks it. Published listings change only those links, so nothing needs review again; external links are left
  alone and listed; re-running changes nothing. The last run's result is kept in the `listing_image_migration` setting.
* The public **`GET /v1/catalog`** lists published games with their play URL resolved. That's either the web address or
  `cdn.vaultlearninggames.org/STUDIO/GAME/` plus an optional folder, so one CDN game can hold a collection (The Yard).
  The site (`site/` in this repository) is built from it. Each game's `studio`
  carries the studio's website as `url`, and `studios` lists every studio with a game on the site or named as a
  maker of one (`slug`, `name`, `url`) so the site can link maker names. Studio admins set the website on their
  **Members** page.
* **Vault → Game Catalog** is one table of every site listing: its site status, where it plays from, whether it's
  featured, and whether it still loads.
  * **Availability** columns show the latest daily check by `check-games.yml` (see
    [docs/setup.md](docs/setup.md#operating-notes)): result (hover for why), response time, and when (linking the
    GitHub run). Each game's page shows its latest result too.
  * **Featured** is a checkbox for the home page's Featured Games section (at most 9). Release managers tick it; a
    featured game then gets a sequence number (the home page shows them in ascending sequence, ties by title), an
    optional home-page description (short Markdown) and an optional image. Unticking keeps the description and image
    for next time. It's stored in `settings` (`site_featured`) and published as `featured` in `/v1/catalog`:
    `[{ slug, blurb, image, sequence }]` in display order, leaving out games that are off the site.
  * **Featured images** are uploaded from the row (PNG, JPEG or WebP, up to 2 MB, type checked by content) to the
    release bucket at `STUDIO/GAME/_vault-assets/featured-HASH.EXT` (immutable, cached for a year; replaced images
    aren't deleted; images uploaded before this are at `_site/featured/` and keep working), and `image` is then that
    absolute `cdn.vaultlearninggames.org` URL. Older entries keep a path on the site
    (`images/featured/*.webp`, in the website repo), so the site must handle both.

**Connecting games:**
* A studio's first CI publish of a game connects its listing of the same name. Other names can be connected on the page.
* **Vault can upload a game for a studio** before the studio's CI does, e.g. the version that's live today. Use the
  action's `mode: vault-upload` with `studio`, `game`, `ref` (default `v1.0`), `listing` and optionally `sha` (the
  build's commit). It must run from this repository's workflow in the system's environment (`staging` or
  `production`), like releases; `copy-build.yml` does it for a build copied from another system.
* A game Vault uploaded is taken over by the studio's repository on its first CI publish, with its releases.

Vault admins can import the Hugo prototype's game pages once, from that repo's `migration/` folder
(`POST /portal/api/vault/listings/import` with `pages` and optional `overrides`; the portal has no form for it). The
import creates missing studios as Vault-managed studios. `node scripts/dev-portal.ts` does it automatically when
`vault-hugo-rebuild` (formerly `vault-rebuild`, which still holds `migration/`) is checked out next to this repo as
`vault-rebuild`, or at `$VAULT_REBUILD`; sign in as `lee` to edit NMSU's games.

## Admin tasks

The Vault-admin operations on site listings can also be run by a workflow, so they don't need someone signed in to
the portal: **Actions → Admin task** (`.github/workflows/admin-task.yml`), or `gh workflow run`. Each task is the
same code the portal's button runs (`src/listing-ops.ts`), behind `/v1/admin/listings…` (`src/admin-tasks.ts`).

* **Who can run one:** only this repository's workflow, running in the system's GitHub environment (`staging` or
  `production`); the job's OIDC token is the credential, as for releases and `check-games`, and there are no secrets.
  So anyone who can run workflows in this repository can run them. The audit log records the person who started the
  run as `github:LOGIN`.
* **Inputs:** `environment` (which system), `task`, `args` (a JSON object) and `dry_run`. **`dry_run` defaults to
  true**: the portal answers with what would change and writes nothing. Pass `-f dry_run=false` to do it.
* **Result:** the portal's JSON answer is the job summary (`gh run view --log` has it too). A refused task fails the run.

| Task | `args` | What it does |
| --- | --- | --- |
| `list` | `{ "slugs"?: [...] }` | Each listing's draft, published version, studio, review state and unpublished fields. Reads only; use it to check a task's result. |
| `import` | `{ "source", "slugs"?, "pages"?, "overrides"? }` | The *Import from the Hugo site prototype* import: reads `SOURCE/migration/games-export.json` and `import-overrides.json`, creates a listing for each page that has none (and its studio if new) and publishes those that can be. `slugs` limits it to those pages. Answers `created`, `drafts`, `skipped` (already has a listing), `failed`, `studios_created`. |
| `migrate-images` | `{ "base", "budget_seconds"? }` | *Copy site images to the Vault CDN* from the site at `base`. Answers the full run (`counts`, and every image `migrated`, `failed` and `external`). |
| `move` | `{ "slug", "studio" }` | Moves a game to another studio (not while it is hosted on its studio's CDN game). |
| `update` | `{ "updates": [{ "slug", "fields": {…}, "cdn_game"? }], "publish": true \| false, "publish_pending"? }` | Sets the given listing fields on each draft and, with `publish`, publishes each as Vault. `cdn_game` connects the listing to that CDN game of its studio (`""` disconnects), checked with the fields, so `"cdn_game": "lakeland", "fields": { "play_source": "cdn" }` moves a game to the CDN in one step. |
| `release` | `{ "studio", "game", "version", "ref"?, "promote"? }` | Approves the test build `ref` (default: the version) as release `version` and, unless `promote: false`, makes it current: the Release workflow's approve-and-promote, run in the chosen system's environment (on staging, the way to release without a signed-in person). Each call copies for at most `budget_seconds` (default 75, inside Cloudflare's 100-second request limit) and answers `done: false` with what remains; the workflow calls again until it is done, so a game of thousands of files (Jo Wilder: 8,400) takes several rounds. Repeating it changes nothing. |
| `image-variants` | `{}` or `{ "redo": true }` | Makes the smaller WebP copies (320–1920px wide) of every listing and featured image on the CDN that has none yet, next to the original (`…/_vault-assets/KIND-HASH-<W>w.webp`), and records them; `/v1/catalog` lists them as `images` and the site's templates use them as `srcset` (`src/image-variants.ts`). Resizing happens in the job (`scripts/image-variants.ts`, sharp); the portal checks and stores. Every site build also runs it for new uploads. A dry run makes the copies and reports their sizes without storing them. Rebuild the site afterwards. |

```sh
# Add Transformations Quest from the site's export (see the note on `import` below)
gh workflow run admin-task.yml -f environment=staging -f task=import -f dry_run=false \
  -f args='{"source":"https://new-design.vaultlearninggames-staging.org","slugs":["transformations-quest"]}'

# Move Shady Sam to Next Gen Personal Finance
gh workflow run admin-task.yml -f environment=staging -f task=move -f dry_run=false \
  -f args='{"slug":"shady-sam","studio":"ngpf"}'

# Copy every listing image that is still a site path to the Vault CDN
gh workflow run admin-task.yml -f environment=staging -f task=migrate-images -f dry_run=false \
  -f args='{"base":"https://new-design.vaultlearninggames-staging.org"}'

# Fill in "About this game" for several games and publish
gh workflow run admin-task.yml -f environment=staging -f task=update -f dry_run=false \
  -f args='{"publish":true,"updates":[{"slug":"shady-sam","fields":{"about":"Play a loan shark and learn how predatory lending works."}},{"slug":"transformations-quest","fields":{"about":"Arrange blocks to translate, rotate and reflect shapes."}}]}'

# Check the result
gh workflow run admin-task.yml -f environment=staging -f task=list -f args='{"slugs":["shady-sam","transformations-quest"]}'
gh run watch && gh run view --log        # or open the run: the result is its summary
```

Notes on each task:

* **`import`** reads the export from the address in `source`. A site that doesn't serve
  `migration/games-export.json` is refused with that address in the error; send the pages in the request instead
  (`pages`, and `overrides` in the shape of `import-overrides.json`), e.g. from a `vault-rebuild` checkout:

  ```sh
  gh workflow run admin-task.yml -f environment=staging -f task=import -f dry_run=false -f args="$(jq -c \
    --arg s transformations-quest --slurpfile ov migration/import-overrides.json \
    '{source: "https://new-design.vaultlearninggames-staging.org", slugs: [$s], pages: map(select(.slug == $s)),
      overrides: {overrides: {($s): $ov[0].overrides[$s]}, studios: $ov[0].studios}}' migration/games-export.json)"
  ```

  (A workflow input holds about 65,000 characters: a few pages, not the whole export.) A page whose slug already has
  a listing is `skipped`, so running it again changes nothing.
* **`migrate-images`** can take minutes (one download per image). Cloud Run ends a request at its timeout, 300 s
  unless the service is deployed with `--timeout`, so the task starts no new download after `budget_seconds`
  (default 240), stores and relinks what it downloaded, and answers with `remaining`: the number of image values it
  didn't get to. The workflow calls again until nothing remains. Every run is a resume: images already on the CDN are
  counted as `already` and not downloaded again, and images that failed are tried again. Only one copy runs at a time
  (a second gets HTTP 409). A dry run downloads nothing: it lists the images a run would try.
* **`update`** takes any listing fields (`title`, `short_description`, `about`, `makers`, `grades`, `subjects`,
  `topics`, `standards`, `related_curriculum`, `gameplay_video`, `hero_image`, `thumb_image`, `screenshots`,
  `play_source`, `play_url`, `cdn_path`, `embed`, `fit`, `min_width`, `min_height`); lists are JSON arrays,
  `min_width`/`min_height` whole pixels or `null` (the site's default), and fields left out keep their value. It is **all or nothing**: every update is checked first, with the rules of a save in the portal (plus
  unknown fields, wrong types and over-long text), and if any is refused nothing is written and the answer (HTTP
  400) lists every problem per listing. Publishing puts the whole draft on the site, so with `publish: true` a
  listing that has other unpublished draft changes (e.g. a studio's edits waiting for review), or isn't on the site
  yet, is refused unless `publish_pending: true`. With `publish: false` only drafts change. Listings the update
  wouldn't change are answered as `unchanged` and not written.

Locally: `node scripts/admin-task.ts --portal URL --task TASK --args 'JSON' [--dry-run=false]` (a dry run unless
`--dry-run=false`; `--pages FILE --overrides FILE` send an export from disk for `import`). Against
`node scripts/dev-portal.ts` use `--portal http://localhost:4181 --token dev`.

**Copying a production test build to staging** (`.github/workflows/copy-build.yml`): studios' CI publishes only to
production, so to try a game on staging, copy its test build, release it, and switch its listing to the CDN:

```sh
gh workflow run copy-build.yml -f environment=staging -f studio=fieldday -f game=lakeland -f ref=master -f listing=lakeland
gh workflow run admin-task.yml -f environment=staging -f task=release -f dry_run=false \
  -f args='{"studio":"fieldday","game":"lakeland","version":"master-c6489ab","ref":"master"}'
gh workflow run admin-task.yml -f environment=staging -f task=update -f dry_run=false \
  -f args='{"publish":true,"updates":[{"slug":"lakeland","cdn_game":"lakeland","fields":{"play_source":"cdn"}}]}'
```

The bucket can't be listed, so the copy takes the files from where the source build was made (its CI artifact, or
`make build` at its commit) and uploads them only if the file count and size match the source build exactly.

`featured` sets the home page's Featured Games (the whole list): `-f task=featured -f args='{"games":[{"slug":"project-hercules","sequence":1,"image":"images/featured/project-hercules.webp"}]}'`. A site-path image is copied to the CDN by the next `migrate-images`.

## The website

`site/` is the public site (vaultlearninggames.org): Hugo, theme `vault-squarespace` (the replica of the Squarespace
design). It came from `VaultLearningGames/vault-hugo-rebuild` (branch `original-squarespace-design`), which is no
longer where the site is edited or deployed from. Details of the theme: [site/README.md](site/README.md).

* **Game pages come from the portal**, not from files: `npm run site:catalog` saves this system's `GET /v1/catalog`
  to `site/data/catalog.json` (not in git), and `site/content/games/_content.gotmpl` turns each listing into a page.
* **Build:** `VAULT_PORTAL=https://portal.vaultlearninggames-staging.org npm run site:build` → `site/public`
  (catalog, `hugo`, `site/scripts/squarespace-paths.mjs` for the `/game-cards/category|tag/…` addresses, then
  `scripts/site-hosting.ts` for the hosting's `_headers` and `_redirects`).
  `npm run site:dev` serves it on http://localhost:1313. Game images are on the Vault CDN; `site/` holds only the
  theme's own files (17 MB, mostly the Squarespace snapshot images) and `static/files/keys-to-the-vault.pdf`.
* **Deploy:** the [deploy workflow](.github/workflows/deploy.yml) does it with the portal, from the same commit: build
  the site from that system's catalog (the forms post to that system's portal, through the
  `HUGOxPARAMSxFORMSx…` overrides), check the build under the hosting's own runtime (`cloudflare/site/check.sh`),
  deploy the portal image (which carries `site/` and Hugo for previews), then `wrangler deploy` publishes the build
  to the system's Worker as static files: `main` → `vault-site-staging`, `production` → `vault-site`
  (`cloudflare/site/wrangler.jsonc`). Cloudflare serves the files itself, with the build's `404.html` for a missing
  address; the build's `_headers` and `_redirects` (`src/site-hosting.ts`) carry the cache lifetimes, `noindex`,
  CORS and redirects. Hostnames are attached to a Worker once, by an admin
  ([docs/setup.md](docs/setup.md#the-website-on-cloudflare-static-hosting)).
* **Check a build locally:** `npm run site:build`, `npm ci --prefix cloudflare/site` (once), `npm run site:check`.
* **When listings change** (published, edited, taken off the site, featured) the site must be rebuilt, though no
  code changed: **Actions → Deploy (portal and site) → Run workflow**, choose the system and tick *Rebuild the site
  only*, or `gh workflow run deploy.yml -f environment=staging -f site_only=true`. It builds and publishes the site
  and doesn't touch the portal.
* **Addresses built in scripts** must be absolute (`absURL`): a preview is served from the portal, and only addresses
  in HTML attributes and CSS `url()` are rewritten to the site.

The new design (theme `vault-theme`) is not here: it stays in `vault-hugo-rebuild` (`main`), deployed by that
repository's workflow to Cloud Run `vault-site-staging` (`new-design.vaultlearninggames-staging.org`), and renders its
own previews from this portal's JSON.

## Site checks

The live website is tested in a headless Chromium: every game opens, no missing images or scripts, no broken links,
spelling, large files and slow pages, the layout at phone, tablet, laptop and wide widths, and whether the services
the games depend on (player codes, the Open Game Data logger) answer.
`.github/workflows/check-site.yml` does the looking on a GitHub runner, daily for both systems, and posts each finished
run to that system's portal; **Vault → Site checks** shows them. A failure fails the job, annotates the run and opens or
updates the issue *Site checks (staging)* / *(production)*. By hand: `gh workflow run check-site.yml -f environment=staging -f checks=links,spelling`,
or against a local site `npm run site:audit -- --site http://localhost:1313`. The checks, their thresholds, accepting a
spelling, the limits of the measurements and what it costs (nothing on the portal): [docs/site-checks.md](docs/site-checks.md).

## Develop

Node 24, no build step: `npm install && npm test` (with Hugo installed, the tests also render a real preview from
`site/`). Preview the portal with example data: `node scripts/dev-portal.ts` (its Preview button renders `site/`
locally, with CSS and images from the staging site).
The portal's "Need support?" link (sidebar foot and sign-in page) is `SUPPORT_URL`: by default the invitation to the
Slack workspace, where people join `#vault-game-publishing-support`; `none` hides it.
Deployment and cloud setup: [docs/setup.md](docs/setup.md).
