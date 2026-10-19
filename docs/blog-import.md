# Blog: importing the Field Day Lab Medium posts

This moves every post at <https://medium.com/@fielddaylab> into the Vault blog. Each post becomes a Markdown file in
vault-site, `content/blog/<slug>/index.md`. The posts are published under their original Medium dates and their
author's Medium display name. All images are copied to the Vault CDN, so nothing is hotlinked from `miro.medium.com`
or `cdn-images-*.medium.com`. The import has three steps: fetch, apply, and (if needed) rollback. None of them runs in
CI.

The code is in `src/blog/import/`. `medium.ts` handles discovery and conversion, `medium-apply.ts` writes and rolls back
the posts, and the script is `scripts/import-medium-fielddaylab.ts` (`npm run import:medium -- …`). The body
converter is shared with the Squarespace import (docs/runbooks/squarespace-blog-import.md).

## 1. Fetch a snapshot (on a machine with internet access)

```sh
npm run import:medium -- fetch                                   # live discovery only
npm run import:medium -- fetch --export ~/medium-export          # plus Medium's own export (unzipped)
npm run import:medium -- fetch --urls post-urls.txt              # plus a list of post addresses, one per line
npm run import:medium -- fetch --limit 3                         # try a few first
```

Discovery is best effort. It takes the union of these sources, deduplicated by the Medium post id (the hex at the end
of a post's address):

| Source | What it reads |
|---|---|
| `rss` | `https://medium.com/feed/@fielddaylab` (only the latest ~10 posts, but with their full text) |
| `stream` | `https://medium.com/@fielddaylab/latest?format=json`, page by page |
| `sitemap` | `fielddaylab.medium.com/sitemap/sitemap.xml` and the sitemaps it lists |
| `profile` | the profile and archive pages |
| `export` | `--export DIR`: the `posts/*.html` files in Medium's export (Settings → Security and apps → Download your information). Drafts (`draft_*`) are skipped |
| `urls` | `--urls FILE` |

Medium often blocks automated requests. If the counts look low, use the export or a URL list: they are the reliable
sources. The log gives the count for each source and the total, for example:

```
discovery rss: 10 posts
discovery stream: 74 posts
discovery sitemap: failed (no sitemap could be read)
discovery profile: 12 posts
discovered 76 posts in all
fetched  making-games-at-field-day (Jane Doe, 2019-03-05)
...
76 posts, 312 images, 0 skipped -> data/blog-import/medium/medium-posts.json
```

The fetch step reads each post from the feed's or the export's copy, or else from its page. It downloads every image
to `data/blog-import/medium/images/<sha-256>.<ext>` and writes `data/blog-import/medium/medium-posts.json`. For each
post the JSON holds `mediumId`, `sourceUrl`, `slug`, `title`, `subtitle`, `author_name`, `publishedAt`, `excerpt`,
`tags`, `coverImageUrl`, `bodyHtml` (raw, kept for audit), `blocks` and `warnings`. The file also records the
discovery counts and the skipped posts with their reasons. Check the warnings and the skipped list, then commit the
JSON and the images.

What the conversion does:
- **Fields:**
  - Slug: the Medium address without its id (`making-games-at-field-day-1a2b3c4d5e6f` becomes
    `making-games-at-field-day`). If two Medium posts share a slug, the newer one gets its id as a suffix.
  - Author: the post's Medium byline. If a post has none, `Field Day Lab`. Posts are never attributed to a portal
    account.
  - Date: the original first-published date.
  - Excerpt: the subtitle, or else the first paragraph (up to 200 characters).
  - Tags: Medium's tags, in kebab-case.
  - Cover (`featured_image`): the hero image, or else the first image in the body.
- **Body:**
  - Kept: paragraphs, headings (h3 becomes level 2, h4 becomes level 3), bold, italic, links, lists, code (as code
    lines), figure captions and image alt text.
  - Quotes and pull quotes become italic paragraphs, because the site's Markdown has no quote.
  - YouTube and Vimeo embeds become a link to the video. Gists and other iframes become a link to what they show.
  - Links to another Field Day Medium post become `/blog/<slug>/`.
- **Removed:**
  - Medium's chrome: clap, follow, share and listen buttons, "Sign up" prompts, the "originally published in … on
    Medium" footer, and related-post lists.
  - The tracking pixel (`medium.com/_/stat`).
  - The title and subtitle that repeat at the top of the body.

## 2. Apply

```sh
# dry run against a vault-site checkout: lists what it would upload and create
npm run import:medium -- apply --out ../vault-site
# the real thing, straight to the repository: one commit per post
R2_ACCOUNT_ID=… R2_CDN_ACCESS_KEY_ID=… R2_CDN_SECRET_ACCESS_KEY=… CDN_BUCKET=… VAULT_SITE_GITHUB_TOKEN=… \
  npm run import:medium -- apply --github --yes
```

The apply step uploads the images to the CDN bucket first, as `site/<slug>/<sha-256>.<ext>`. An image that is already
there is skipped. If any upload fails, no post is written. Then it creates each post that isn't there yet, with
`draft: false` and its original date, so it appears in the blog index and the RSS feed in date order. Each file carries
`import_source: "medium:<id>"` and `import_source_url: "<Medium address>"` in its front matter.

Apply never changes or deletes any other post. If a slug is already used by a post that wasn't imported, the imported
post becomes `<slug>-fdl` (then `-fdl-2`, …), and links from other imported posts follow it. Running apply again finds
each post by its `import_source`, whatever its slug, and writes nothing. A post edited since the import is reported
as `kept` and left alone. Expected output:

```
image    site/making-games-at-field-day/3f…9a.png (to upload)
created   making-games-at-field-day <- https://medium.com/@fielddaylab/making-games-at-field-day-1a2b3c4d5e6f
created   old-post-fdl <- https://medium.com/@fielddaylab/old-post-0a0b0c0d0e0f

2 to create, 0 unchanged, 0 kept (the file differs; left alone), 0 to delete, 0 errors
Dry run: nothing was written. Re-run with --yes.
```

## 3. Rollback

```sh
npm run import:medium -- rollback --out ../vault-site        # dry run: lists the posts it would delete
npm run import:medium -- rollback --github --yes
```

Rollback deletes every post whose `import_source` starts with `medium:`, and nothing else. The images stay on the CDN.
They are content-addressed, so a later re-import reuses them.
