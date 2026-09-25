# One-time setup

Everything here is done once. Replace `PROJECT`, `REGION` and `PROJECT_NUMBER` with the values the
fielddaysite Cloud Run deploy uses (GitHub variables `GCP_PROJECT_ID`, `GCP_REGION`).

## 1. Cloudflare (Vault account)

1. **Bucket:** R2 → Create bucket → `cdn-vaultlearninggames-staging`.
2. **Public domain:** bucket → Settings → Custom Domains → `cdn.vaultlearninggames-staging.org`.
3. **Rules** on the `vaultlearninggames-staging.org` zone, hostname `cdn.vaultlearninggames-staging.org`:
   - *URL rewrite:* when the path ends with `/`, rewrite the path to the path + `index.html`.
     (If the free plan's rule editor can't express this, use a tiny Worker instead.)
   - *Response header:* set `X-Robots-Tag: noindex, nofollow`.
   - *Cache rule:* edge TTL 60 seconds.
4. **API token:** R2 → Manage API tokens → Create → *Object Read & Write*, limited to
   `cdn-vaultlearninggames-staging`. Keep the Access Key ID and Secret Access Key for step 2.3 only;
   don't paste them anywhere else.
5. Note the **Account ID** (R2 overview page).

Check: upload any `index.html` to `test/hello/` in the bucket and open
`https://cdn.vaultlearninggames-staging.org/test/hello/`.

## 2. Google Cloud (same project as fielddaysite)

```bash
gcloud config set project PROJECT

# 2.1 Runtime service account for the service
gcloud iam service-accounts create vault-publisher --display-name "vault-publisher (Cloud Run)"

# 2.2 Litestream backup bucket (versioned, so a bad write can be rolled back)
gcloud storage buckets create gs://PROJECT-vault-publisher-db --location=REGION --uniform-bucket-level-access
gcloud storage buckets update gs://PROJECT-vault-publisher-db --versioning
gcloud storage buckets add-iam-policy-binding gs://PROJECT-vault-publisher-db \
  --member=serviceAccount:vault-publisher@PROJECT.iam.gserviceaccount.com --role=roles/storage.objectAdmin

# 2.3 R2 credentials (each command prompts; paste the value, then Ctrl-D)
gcloud secrets create vault-publisher-r2-access-key-id --data-file=-
gcloud secrets create vault-publisher-r2-secret-access-key --data-file=-
for s in vault-publisher-r2-access-key-id vault-publisher-r2-secret-access-key; do
  gcloud secrets add-iam-policy-binding $s \
    --member=serviceAccount:vault-publisher@PROJECT.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
done

# 2.4 Let the existing GitHub deploy service account deploy as vault-publisher
gcloud iam service-accounts add-iam-policy-binding vault-publisher@PROJECT.iam.gserviceaccount.com \
  --member=serviceAccount:GCP_DEPLOY_SERVICE_ACCOUNT --role=roles/iam.serviceAccountUser
```

**Workload Identity Federation:** the fielddaysite provider may only trust `fielddaylab/fielddaysite`.
Check its attribute condition (`gcloud iam workload-identity-pools providers describe ...`) and, if needed,
allow `fielddaylab/vault-publisher` too, e.g. `assertion.repository in ['fielddaylab/fielddaysite', 'fielddaylab/vault-publisher']`,
and grant `roles/iam.workloadIdentityUser` on the deploy service account for the new repo's principal.

## 3. GitHub

**Repository variables** on `fielddaylab/vault-publisher` (Settings → Secrets and variables → Actions → Variables),
unless they're already organization variables:

| Variable | Value |
|---|---|
| `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`, `GCP_REGION` | same as fielddaysite |
| `PUBLISHER_SERVICE_ACCOUNT` | `vault-publisher@PROJECT.iam.gserviceaccount.com` |
| `R2_ACCOUNT_ID` | from 1.5 |
| `LITESTREAM_BUCKET` | `PROJECT-vault-publisher-db` |
| `TASK_INVOKER_EMAIL` | `vault-publisher-scheduler@PROJECT.iam.gserviceaccount.com` |

**Let game repos use this repo's workflow and action** (it's private): Settings → Actions → General →
Access → *Accessible from repositories in the fielddaylab organization*.

Push to `main` (or run the Deploy workflow) and note the service URL it prints.

**Organization variable** `VAULT_PUBLISHER_URL` = that service URL, visible to all fielddaylab repos.

## 4. Nightly cleanup

```bash
gcloud iam service-accounts create vault-publisher-scheduler --display-name "vault-publisher cleanup"
gcloud scheduler jobs create http vault-publisher-cleanup --location=REGION \
  --schedule="0 8 * * *" --http-method=POST \
  --uri=SERVICE_URL/v1/tasks/cleanup \
  --oidc-service-account-email=vault-publisher-scheduler@PROJECT.iam.gserviceaccount.com \
  --oidc-token-audience=vault-publisher-tasks
```

## 5. Pilot

Add the caller workflow from the README to a branch of `fielddaylab/wake`, push, and open
`https://cdn.vaultlearninggames-staging.org/fieldday/aqualab/<branch>/`. Check:

- the game loads (Aqualab is Unity 2019 / gzip) in Chrome, Safari and on an iPad;
- a newer Unity game with Brotli (`.br`) files also loads;
- Aqualab's save server accepts requests from the new origin (CORS);
- deleting the branch removes the preview.

## Operating notes

- **Restore test:** `litestream restore -o /tmp/check.db gcs://PROJECT-vault-publisher-db/publisher.db`, then
  `sqlite3 /tmp/check.db 'select * from audit_log order by id desc limit 5'`.
- **Deploys** briefly run the old and new instance together. Writes are rare (one per push), but avoid
  deploying while a large batch of game builds is publishing.
- **Adding a studio:** add it to `studios.json` (the numeric org id is `gh api orgs/NAME --jq .id`) and deploy.
