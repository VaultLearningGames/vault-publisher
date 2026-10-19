# Blog: importing the Squarespace posts

A one-time move of the posts at <https://vault-games-library.squarespace.com/blog> into the Vault blog (Markdown files in
vault-site, `content/blog/<slug>/index.md`). It also deletes the placeholder posts. There are two steps. The snapshot
step needs the network. The apply step writes to the site. Neither one runs in CI.

The code is in `src/blog/import/`. `squarespace.ts` converts a post's HTML into the editor's blocks. `apply.ts` writes
the posts and deletes the placeholders. The script is `scripts/import-squarespace-blog.ts`.

## 1. Snapshot (once, on a machine with internet access)

```sh
node scripts/import-squarespace-blog.ts fetch          # --cdn https://cdn.vaultlearninggames.org is the default
```

The fetch step reads `/blog?format=json`, follows `pagination.nextPageUrl` to the end, then reads each post's
`?format=json`. Drafts and scheduled posts are skipped. Each image, cover and inline, is downloaded to
`data/blog-import/images/<sha-256>.<ext>`.

The output is `data/blog-import/squarespace-posts.json`. For each post it holds `sourceUrl`, `slug`, `title`,
`author_name`, `publishedAt`, `excerpt`, `tags` (tags plus categories), `coverImageUrl`, `bodyHtml` (raw, kept for
audit), `blocks` and `warnings`. It also maps each original image address to its CDN copy,
`site/<slug>/<sha-256>.<ext>`. Stored posts never point at `squarespace-cdn.com`.

Read the warnings: they flag elements imported as plain text and images that were left out. Then commit the JSON and
the images.

Body conversion: `p` becomes a paragraph. `h1` and `h2` become level-2 headings; `h3` to `h6` become level 3. Lists
and quotes are kept as paragraph HTML. Images and figures become image blocks; the alt text falls back to the post
title. `hr` becomes a divider. The editor has no embed block, so a YouTube or Vimeo video becomes a paragraph that
links to it. Any other element keeps only its text. Paragraph HTML goes through the editor's own sanitizer. Links keep
only http(s) and mailto: addresses, and a link to another Squarespace post becomes `/blog/<slug>/`.

## 2. Apply

```sh
# dry run against a vault-site checkout: lists what it would create and delete
node scripts/import-squarespace-blog.ts apply --out ../vault-site
# the real thing, straight to the repository: one commit per post
R2_ACCOUNT_ID=… R2_CDN_ACCESS_KEY_ID=… R2_CDN_SECRET_ACCESS_KEY=… CDN_BUCKET=… VAULT_SITE_GITHUB_TOKEN=… \
  node scripts/import-squarespace-blog.ts apply --github --yes
```

Apply uploads the images to the CDN bucket first. An image that is already there is skipped. Then it creates each
post that doesn't exist yet; a post that exists is never overwritten. Then it deletes the placeholders.

A **placeholder** is a post already in vault-site that the import doesn't write and that is dated before the snapshot
(or has no date). This repository has no seed listing the placeholders, so they are identified this way. The dry run
lists them by slug. Spare a post with `--keep slug-a,slug-b`. If anything fails, no placeholder is deleted.

Running apply again writes nothing. A post written after the snapshot is never taken for a placeholder.

The author of each post is the plain-text name shown on the Squarespace post (front matter `author`). It isn't linked
to a portal user.
