# vault-site and the portal: setup only people can do

The portal edits the website only by committing to [VaultLearningGames/vault-site](https://github.com/VaultLearningGames/vault-site)
as the `vault-portal-bot` GitHub user; vault-site's own workflow builds and publishes the site on each commit
([vault-site.md](vault-site.md)). A coding agent can't create GitHub users, tokens or secrets, so these steps are for
a person with admin rights on the organization and the Google Cloud project. Do them in order: the portal's code
already commits to `staging` / `production`, so blog saves fail (502) until steps 1–4 are done for that system, and
`SITE_PUBLISHING_ENABLED=false` keeps them refused (503) cleanly in the meantime.

## 1. The bot user

- [ ] Create the GitHub user **`vault-portal-bot`** (a machine user; its email a shared Vault mailbox, 2FA on, the
      recovery codes in the team password manager).
- [ ] Invite it to VaultLearningGames and give it **Write** on `vault-site` only (no other repository, no org role).
- [ ] Its commit email: either keep the default the portal uses (`vault-portal-bot@users.noreply.github.com`), or
      set `SITE_COMMIT_AUTHOR_EMAIL` to the bot's verified email so commits link to its profile.

## 2. vault-site branches and the deploy workflow

- [ ] Create the branches **`staging`** (from the current `main`) and **`production`** in vault-site.
- [ ] In vault-site's `.github/workflows/deploy.yml` (*Deploy (site)*), deploy on push to `staging` and `production`:
      `on.push.branches: [ staging, production ]`, and map `staging` → the `staging` environment wherever the workflow
      says `main` (the header comment too). Keep the workflow's name: the portal's deploy bar finds it by name.
- [ ] Set vault-site's default branch to `staging`.
- [ ] Protect `production`: changes only by pull request from `staging` with one human approval. The bot is
      allowed to push to `production` directly only because the production portal commits there (add
      `vault-portal-bot` to the rule's bypass list, nobody else).
- [ ] Protect `staging`: no force pushes, no deletion; `vault-portal-bot` may push.
- [ ] Add the README warning below to vault-site.

The vault-site README section on promotion:

```markdown
## Promoting staging to production

Only code reaches production: site templates, styles and other site code go by a pull request from `staging` to
`production`, reviewed by a person. Content never does. Production content is committed to `production` by the
production portal; anything the staging portal commits to `staging` is test content and is thrown away (vault-site's
*Reset staging content* workflow replaces it with production's daily and on demand; run it before opening the PR).
vault-site's *Promotion is code only* check fails a PR that changes `content/blog` or `content/tags`.
```

## 3. Tokens (one per system)

- [ ] As `vault-portal-bot`, create two **fine-grained personal access tokens**, resource owner VaultLearningGames,
      repository access **only `vault-site`**, permissions **Contents: Read and write** and **Metadata: Read**:
      `vault-portal-staging` and `vault-portal-production`. An expiry the team will track (e.g. 1 year).
- [ ] Store each as the system's `VAULT_SITE_GITHUB_TOKEN` secret (`deploy.yml` reads
      `<SERVICE>-vault-site-github-token`):

```bash
printf 'token: '; read -rs v; echo; printf '%s' "$v" | gcloud secrets versions add vault-publisher-staging-vault-site-github-token --data-file=-; unset v
# production: vault-publisher-vault-site-github-token
```

  (Use `gcloud secrets create … --data-file=-` and grant the service account `roles/secretmanager.secretAccessor`
  if the secret doesn't exist yet.) Revoke any older token that held this secret.

## 4. Portal settings (per system; defaults shown)

- [ ] `VAULT_SITE_BRANCH`: unset. The production portal (`SITE_REBUILD_ENVIRONMENT=production`) commits to
      `production`, the staging portal to `staging`.
- [ ] `SITE_COMMIT_AUTHOR_NAME` / `SITE_COMMIT_AUTHOR_EMAIL`: unset unless step 1 chose another email.
- [ ] `SITE_PUBLISHING_ENABLED`: unset (on). Set it to `false` to stop all portal writes to vault-site at once (an
      incident, a migration); reads and the editor keep working.

## 5. Check it

- [ ] On the staging portal, save a test blog post. In vault-site, a commit on `staging` by `vault-portal-bot` whose
      message ends `Portal-User: <your login>`; *Deploy (site)* runs on `staging` and the post is on
      vaultlearninggames-staging.org. The portal's deploy bar shows that run.
- [ ] Delete the test post from the portal (another bot commit on `staging`).
- [ ] Production: the same with a real post when ready.

## 6. Later: retire the portal's copy of the site

- [x] Once vault-site's *Deploy (site)* publishes both systems, remove the site build and publish jobs (`site`,
      `publish`) from this repository's `deploy.yml` and delete `site/` (done 2026-10-19); the portal keeps
      vault-site only at `vault-site.ref` for previews.
