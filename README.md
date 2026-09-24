# vault-publisher

Publishes game builds to the Vault Learning Games CDN. GitHub Actions call it with their built-in
OIDC token, so no game repo holds storage credentials, VPN passwords or SSH keys.

**Stage 1 (current): branch previews.** Every push to a Field Day game repo builds WebGL and publishes it to

```
https://cdn.vaultlearninggames-staging.org/STUDIO/GAME/BRANCH/
```

Branch names use the old DoIT convention (`feature/new-map` → `feature_new-map`). Tags publish the same
way and are the release candidates for Stage 2. Deleting a branch deletes its preview, and branch
previews with no push for 90 days are removed nightly.

## How it works

```
GitHub Actions ──OIDC token──► vault-publisher (Cloud Run, 1 instance, SQLite + Litestream → GCS)
      │                              │ checks org/repo, issues presigned R2 URLs (15 min)
      └──── PUT files directly ──────┴──► R2 bucket cdn-vaultlearninggames-staging
                                             └─ served at cdn.vaultlearninggames-staging.org
```

- **Who may publish:** the GitHub orgs in [`studios.json`](studios.json). A game belongs to the repository
  that first published it (matched by numeric repo id); other repos can't overwrite or delete it.
- **Headers:** the service decides `Content-Type`, `Content-Encoding` (for Unity `.br`/`.gz` files) and
  `Cache-Control` for each file and signs them into the upload URL, so they can't be changed by the uploader.
- **Game files never pass through Cloud Run**; they go straight from the runner to R2.

## Using it from a game repo

Building and publishing are separate reusable workflows, connected by a GitHub artifact:

| Workflow | Does |
|---|---|
| [`unity-build.yml`](.github/workflows/unity-build.yml) | Builds a Unity project with game-ci and uploads the build as an artifact. Knows nothing about CDNs. |
| [`publish-preview.yml`](.github/workflows/publish-preview.yml) | Publishes any build artifact to the staging CDN; on a branch `delete` event, removes that preview. |
| [`unity-webgl.yml`](.github/workflows/unity-webgl.yml) | Both of the above, for repos that don't need anything in between. |
| *(Stage 2)* | Production releases aren't uploaded; an approved staging build is copied to the production CDN. |

All-in-one:

```yaml
# .github/workflows/webgl.yml
name: WebGL
on: { push: {}, delete: {}, workflow_dispatch: {} }
permissions: { contents: read, id-token: write }
jobs:
  webgl:
    uses: fielddaylab/vault-publisher/.github/workflows/unity-webgl.yml@v1
    with: { game: aqualab }
    secrets: inherit
```

Split, so other jobs can use the same build (e.g. an existing deploy that should keep running):

```yaml
jobs:
  build:
    if: github.event_name != 'delete'
    uses: fielddaylab/vault-publisher/.github/workflows/unity-build.yml@v1
    secrets: inherit
  preview:
    needs: build
    uses: fielddaylab/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: aqualab, artifact: "${{ needs.build.outputs.artifact }}" }
  remove-preview:
    if: github.event_name == 'delete'
    uses: fielddaylab/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: aqualab }
  other-deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v8
        with: { name: "${{ needs.build.outputs.artifact }}", path: build }
      # ...
```

Games whose WebGL build is **committed to the repository** (no CI build) publish that folder directly;
one job handles both pushes and branch deletes:

```yaml
on: { push: {}, delete: {}, workflow_dispatch: {} }
permissions: { contents: read, id-token: write }
jobs:
  preview:
    uses: fielddaylab/vault-publisher/.github/workflows/publish-preview.yml@v1
    with: { game: bloom, path: WebGL }   # folder containing index.html
```

Other build systems (npm, etc.) can call the action directly after their own build step:

```yaml
- uses: fielddaylab/vault-publisher/action@v1
  with:
    game: my-game
    path: dist
    publisher-url: ${{ vars.VAULT_PUBLISHER_URL }}
```

Games that only exist as old builds on the DoIT server (no build in any repo) don't get a workflow; they're
imported once into the production CDN.

Game repos reference these files remotely (`uses: fielddaylab/vault-publisher/...@v1`); don't copy them or add
this repo as a submodule.

[fielddaylab/vault-publisher-test](https://github.com/fielddaylab/vault-publisher-test) is a working example that
uses a seconds-long simulated Unity build.

## Releasing to classrooms (production)

Production (`https://cdn.vaultlearninggames.org/STUDIO/GAME/`) is written only by the service, and only when Vault
staff run the **Release** workflow in this repo (Actions → Release → Run workflow). It runs in the `production`
GitHub environment, which requires a reviewer to approve each run.

1. A studio pushes a version tag (e.g. `m3.2`); its build appears on staging at `…-staging.org/STUDIO/GAME/m3.2/`.
2. Vault tests that staging build.
3. Run **Release** with action `approve-and-promote`, game `aqualab`, version `m3.2`:
   - **approve** copies the staging build to `cdn.vaultlearninggames.org/STUDIO/GAME/m3.2/`, labelled cacheable for a
     year. A version can be approved only once; releases are never overwritten.
   - **promote** points `cdn.vaultlearninggames.org/STUDIO/GAME/` at it (a tiny redirect page plus `current.json`,
     both uncached, keeping query strings).
4. **Roll back** by running Release with action `promote` and an earlier version.

`GET /v1/releases/STUDIO/GAME` lists a game's releases and which one is current.

## API

All `/v1/previews*` calls need `Authorization: Bearer <GitHub Actions OIDC token>` with audience `vault-publisher`.

| Method & path | Body | Does |
|---|---|---|
| `POST /v1/previews` | `{ game, files: [{ path, size }] }` | Starts an upload for the token's branch/tag; returns a presigned URL + headers per file |
| `POST /v1/previews/:id/finalize` | — | Verifies every file arrived, deletes files left from the previous build, records the preview |
| `POST /v1/previews/delete` | `{ game, ref }` | Deletes a preview |
| `POST /v1/admin/releases/approve` | `{ studio, game, version, ref? }` | Release workflow only: copy a staging build to production |
| `POST /v1/admin/releases/promote` | `{ studio, game, version }` | Release workflow only: make a release current (or roll back) |
| `GET /v1/releases/:studio/:game` | — | Public: releases and the current one |
| `POST /v1/tasks/cleanup` | — | Nightly expiry; Cloud Scheduler only (Google ID token) |
| `GET /health` | — | Health check |

## Releasing

Game repos use `@v1`, a tag that always points at the latest compatible release, so fixes reach every game
without editing ~30 repositories. Workflows in this repo also reference each other and `action/` at `@v1`.

- **Compatible change** (fix, new optional input): merge to `main`, then tag and move `v1`:
  ```bash
  git tag v1.2.0 && git tag -f v1 && git push origin v1.2.0 && git push -f origin v1
  ```
- **Breaking change** (renamed/removed input, different URLs): release as `v2.0.0` + `v2`, update the internal
  `@v1` references to `@v2` in that release, and move games over one at a time.
- Test changes first from a branch, e.g. by pointing `vault-publisher-test` at `@your-branch`.

Pushes to `main` redeploy the service; the tags only affect the workflows and action game repos run.

## Development

Requires Node 24 (it runs the TypeScript directly; there's no build step).

```bash
npm install
npm test
npm run typecheck
```

Running the server locally needs R2 credentials; see [`src/config.ts`](src/config.ts) for the environment variables.
Deployment and one-time cloud setup: [`docs/setup.md`](docs/setup.md).
