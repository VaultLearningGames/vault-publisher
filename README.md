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

```yaml
# .github/workflows/webgl.yml
name: WebGL
on: { push: {}, delete: {}, workflow_dispatch: {} }
permissions: { contents: read, id-token: write }
jobs:
  webgl:
    uses: fielddaylab/vault-publisher/.github/workflows/unity-webgl.yml@main
    with: { game: aqualab }
    secrets: inherit
```

Non-Unity builds can call the action directly after their own build step:

```yaml
- uses: fielddaylab/vault-publisher/action@main
  with:
    game: my-game
    path: dist
    publisher-url: ${{ vars.VAULT_PUBLISHER_URL }}
```

## API

All `/v1/previews*` calls need `Authorization: Bearer <GitHub Actions OIDC token>` with audience `vault-publisher`.

| Method & path | Body | Does |
|---|---|---|
| `POST /v1/previews` | `{ game, files: [{ path, size }] }` | Starts an upload for the token's branch/tag; returns a presigned URL + headers per file |
| `POST /v1/previews/:id/finalize` | — | Verifies every file arrived, deletes files left from the previous build, records the preview |
| `POST /v1/previews/delete` | `{ game, ref }` | Deletes a preview |
| `POST /v1/tasks/cleanup` | — | Nightly expiry; Cloud Scheduler only (Google ID token) |
| `GET /health` | — | Health check |

## Development

Requires Node 24 (it runs the TypeScript directly; there's no build step).

```bash
npm install
npm test
npm run typecheck
```

Running the server locally needs R2 credentials; see [`src/config.ts`](src/config.ts) for the environment variables.
Deployment and one-time cloud setup: [`docs/setup.md`](docs/setup.md).
