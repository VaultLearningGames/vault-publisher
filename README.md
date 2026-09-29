# vault-publisher

Publishes web game builds to Vault Learning Games:

- **Test builds** (your studio controls them): every branch and tag →
  `https://builds.vaultlearninggames.org/STUDIO/GAME/BRANCH/`
- **Releases** (Vault releases them): `https://cdn.vaultlearninggames.org/STUDIO/GAME/` → the current release

Studios manage games, members and release requests at **https://portal.vaultlearninggames.org**.

Vault also runs a separate staging copy of all of this (site, portal, test builds, releases) on
`vaultlearninggames-staging.org` for trying new versions. Studios never need it. See [docs/setup.md](docs/setup.md).

## Set up a game

1. Ask Vault to register your GitHub organization as a studio.
2. Make `VAULT_PUBLISHER_URL` = `https://portal.vaultlearninggames.org` available to the repo (organization or
   repository variable).
3. Add one workflow. Unity:

```yaml
# .github/workflows/vault.yml
name: Vault
on: { push: {}, delete: {}, workflow_dispatch: {} }
permissions: { contents: read, id-token: write }
jobs:
  build:
    if: github.event_name != 'delete'
    uses: VaultLearningGames/vault-publisher/.github/workflows/unity-build.yml@v1
    secrets:                 # pass explicitly; `secrets: inherit` doesn't cross organizations
      UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}
      UNITY_PASSWORD: ${{ secrets.UNITY_PASSWORD }}
      UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}
  preview:
    needs: build
    uses: VaultLearningGames/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: my-game, artifact: "${{ needs.build.outputs.artifact }}" }
  remove-preview:
    if: github.event_name == 'delete'
    uses: VaultLearningGames/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: my-game }
```

Build committed to the repo: one job, `publish-preview.yml@v1` with `{ game: my-game, path: WebGL }`.
Any other build: after it, `uses: VaultLearningGames/vault-publisher/action@v1` with `game`, `path` and
`publisher-url: ${{ vars.VAULT_PUBLISHER_URL }}`.

The first repository to publish a game name owns it. Branch names with `/` become `_`. Deleting a branch removes its
preview; previews idle for 90 days are removed.

## Release

Push a version tag, test it on staging, then **Request release** in the portal. Vault copies that exact build to
production (kept at `STUDIO/GAME/_releases/VERSION/`) and makes it current: copied into `STUDIO/GAME/` itself, so
bookmarks always get the current release. Studio maintainers can then switch between approved releases or roll back
themselves, unless Vault has frozen the game (e.g. during a study) or withdrawn that release.

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
* Vault publishes them from **Vault → Site games**, sends them back with a note, or takes the game off the site.
* The public **`GET /v1/catalog`** lists published games with their play URL resolved. That's either the web address or
  `cdn.vaultlearninggames.org/STUDIO/GAME/` plus an optional folder, so one CDN game can hold a collection (The Yard).
  The site ([vault-rebuild](https://github.com/fielddaylab/vault-rebuild)) is built from it. Each game's `studio`
  carries the studio's website as `url`, and `studios` lists every studio with a game on the site (`slug`, `name`,
  `url`) so the site can link maker names. Studio admins set the website on their **Members** page.
* **Vault → Site games** is one table of every site listing: its site status, where it plays from, whether it's
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
    release bucket at `_site/featured/SLUG-HASH.EXT` (immutable, cached for a year; replaced images aren't deleted),
    and `image` is then that absolute `cdn.vaultlearninggames.org` URL. Older entries keep a path on the site
    (`images/featured/*.webp`, in the website repo), so the site must handle both.

**Connecting games:**
* A studio's first CI publish of a game connects its listing of the same name. Other names can be connected on the page.
* **Vault can upload a game for a studio** before the studio's CI does, e.g. the version that's live today. Use the
  action's `mode: vault-upload` with `studio`, `game`, `ref` (default `v1.0`) and `listing`. It must run from this
  repository's workflow in the `production` environment, like releases.
* A game Vault uploaded is taken over by the studio's repository on its first CI publish, with its releases.

Vault admins can import the Hugo prototype's game pages once, from that repo's `migration/` folder. The import creates
missing studios as Vault-managed studios. `node scripts/dev-portal.ts` does it automatically when `vault-rebuild` is
checked out next to this repo; sign in as `lee` to edit NMSU's games.

## Develop

Node 24, no build step: `npm install && npm test`. Preview the portal with example data: `node scripts/dev-portal.ts`.
Deployment and cloud setup: [docs/setup.md](docs/setup.md).
