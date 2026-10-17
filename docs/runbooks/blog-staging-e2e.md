# Blog: end-to-end check on staging

Checks the whole blog path on **staging**: the portal's editor commits to vault-site, the site's workflow rebuilds
staging, and the built site shows the result. Run it after a change to the blog editor, the site's blog templates or
the site workflow, and before promoting the blog to production. Never run it against production: the script refuses
addresses without "staging" in them.

It writes real commits to vault-site's `main` (it deletes its posts again at the end, unless `--keep`).

## What you need

- A GitHub account that is a **Vault admin** on the staging portal (in its `VAULT_ADMINS`).
- Node 24 and this repository (`npm ci`).

## Run it

1. Sign in to the staging portal in a browser. Check that the sidebar shows **Blog** under Vault and that
   `/portal/blog` lists the posts (Title, Status, Date, Author, Edit, and a **New post** button).
2. Copy the value of the `vault_session` cookie for the portal's address (browser dev tools → Application → Cookies).
   It is a credential: don't paste it anywhere else, and sign out afterwards to end it.
3. Run:

   ```sh
   STAGING_PORTAL_URL=https://<staging portal> \
   STAGING_SITE_URL=https://vaultlearninggames-staging.org \
   STAGING_SESSION_COOKIE='<vault_session value>' \
   node scripts/staging-blog-e2e.ts            # --keep leaves the posts; --timeout-min N (default 20)
   ```

   Each step prints `ok` or `FAIL`; it exits 0 only when all pass. The waits cover the site workflow's rebuild
   (a few minutes per commit).

## What it checks

1. `/portal/blog` answers the admin with the list and the New post link.
2. A new post with an uploaded image, two tags and an author, published.
3. A second post, published as unlisted (private).
4. On the site: the post is on `/blog/`, has its page (with the image, author and tag links), is on its tag page
   `/blog/tag/<tag>/`, in `/blog/rss.xml` and in `/blog/tag/<tag>/rss.xml`. The unlisted post has its page but is on
   none of those.
5. After a slug rename, the old address `/blog/<old>/` redirects to `/blog/<new>/`.
6. Both posts are deleted again.

## By hand

The script doesn't open a browser; also check, on the post page while it exists (`--keep`, then delete the posts in
`/portal/blog`):

- the image shows, the post reads right on a phone width;
- as a non-admin (a studio member, or Vault staff that isn't admin): no Blog link in the sidebar, and `/portal/blog`
  answers the "No access" page (403);
- signed out, `/portal/blog` goes to sign-in.

## When it fails

- `posts list answers the admin: HTTP 302`: the cookie isn't valid there (expired, or from another portal).
- `HTTP 503 not_configured`: the staging portal has no `VAULT_SITE_GITHUB_TOKEN`.
- A `timed out waiting for` step: look at the vault-site workflow run for the post's commit (Actions tab of
  VaultLearningGames/vault-site); the commit is there but the site didn't rebuild or publish.
- Left-over posts after a failed run: delete them in `/portal/blog` (their titles start with "E2E").
