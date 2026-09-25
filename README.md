# vault-publisher

Publishes web game builds to Vault Learning Games:

- **Staging** (your studio controls it): every branch and tag →
  `https://cdn.vaultlearninggames-staging.org/STUDIO/GAME/BRANCH/`
- **Production** (Vault releases it): `https://cdn.vaultlearninggames.org/STUDIO/GAME/` → the current release

Studios manage games, members and release requests at **https://portal.vaultlearninggames.org**.

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

## Develop

Node 24, no build step: `npm install && npm test`. Preview the portal with example data: `node scripts/dev-portal.ts`.
Deployment and cloud setup: [docs/setup.md](docs/setup.md).
