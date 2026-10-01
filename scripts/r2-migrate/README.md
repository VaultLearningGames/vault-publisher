# DoIT → R2 copy for no-pipeline games

One-time migration of the six static builds that have **no build pipeline** — The Yard, Jo Wilder,
Lakeland, Lost at the Forever Mine, ThermoVR (desktop) and Shadowspect — from their old hosts into
Cloudflare R2, so the portal can point at them. The key prefixes follow the existing CDN convention
(`STUDIO/GAME/…/`), exactly as proposed in [docs/fielddaylab-migration.md](../../docs/fielddaylab-migration.md)
(section B, and A2 for The Yard).

The tooling here is deliberately small:

| File | What it is |
|---|---|
| `manifest.json` | One entry per game: current URL, R2 key prefix, entry file, and `status` (`pending` → `verified`). Commit it as the copy is verified. |
| `upload.ts` | Copies a locally mirrored build into R2 (idempotent), then verifies every file over the public URL. |
| `lib/` | Pure functions: key mapping, content-type/encoding/cache resolution, the verification diff. |

## Prerequisites

* Node 24+ (no build step: `node scripts/r2-migrate/upload.ts …`).
* A folder with the complete build, mirrored from the old host (below).
* R2 credentials **from the environment only** — never in this repo:

  ```sh
  export R2_ACCOUNT_ID=…            # the Cloudflare account
  export R2_ACCESS_KEY_ID=…         # an R2 API token's key id (write access to the bucket)
  export R2_SECRET_ACCESS_KEY=…
  export R2_BUCKET=…                # staging builds bucket first, production CDN bucket later
  export R2_PUBLIC_BASE_URL=…       # e.g. https://builds.vaultlearninggames.org (staging)
  # optional, tests only: point the S3 API at a local S3-compatible store (localstack, minio)
  # export R2_ENDPOINT=http://127.0.0.1:4566
  ```

  Staging and production run the same command with different values. **Do staging first** (the
  staging builds bucket, whose public URL is `BUILDS_PUBLIC_URL`), verify, then repeat for production
  (`CDN_PUBLIC_URL`).

## 1. Mirror the build to a local folder

DoIT directory listings are not public, so the copy needs the operator's access. Either:

* **SFTP/rsync (preferred)** with DoIT VPN access, e.g.
  `rsync -avz doit:/var/www/html/play/jowilder/game/ ./mirror/jowilder/`
  (The Yard comes from the `yardgames` site — its committed files — not DoIT: mirror
  `https://theyardgames.org/` the same way, or check out `fielddaylab/yardgames` with submodules).
* **`wget --mirror`** when the tree is fully linkable from the page:
  `wget --mirror --no-parent https://fielddaylab.wisc.edu/play/jowilder/game/ -P mirror/jowilder/`.

The folder must contain the game's root `index.html` at its top. Dotfiles, `.DS_Store` and `Thumbs.db`
are skipped by the script; anything else that isn't a regular file is skipped with a warning.

## 2. Inspect, upload, verify

```sh
# What would happen (no network at all, no credentials read):
node scripts/r2-migrate/upload.ts --game jowilder --source mirror/jowilder --dry-run

# Copy + verify (uploads only what R2 doesn't already have with the same size):
node scripts/r2-migrate/upload.ts --game jowilder --source mirror/jowilder
```

Every file goes to `<r2Prefix>/<path>` with forward slashes, case preserved. Headers per file:

* **Content-Type** by extension (same table the CI publish uses: `html`, `js`, `css`, `json`,
  `wasm → application/wasm`, `data`/`unityweb` → `application/octet-stream`, images, audio, video,
  fonts, `xml`, `txt`; anything unknown is `application/octet-stream`).
* **Unity precompressed files**: `x.wasm.br` → `application/wasm` + `Content-Encoding: br`;
  `x.js.gz` → `application/javascript` + `Content-Encoding: gzip` (the type comes from the
  underlying extension).
* **Cache-Control**: `public, max-age=300` for `.html`, `public, max-age=86400` for everything else.

The upload is **idempotent**: an object with the same key and size already on R2 is skipped, so a
re-run after an interruption finishes the job. `--force` re-uploads everything. The script **never
deletes** — objects under the prefix that aren't in the local folder are listed and left in place.

After the upload, every file is checked with `HEAD <R2_PUBLIC_BASE_URL>/<key>` and must answer 200
with the local size, the expected Content-Type and (for `.br`/`.gz`) the expected Content-Encoding.
On success the manifest entry flips to `"verified"` and the script prints the play URL; commit the
manifest change. `--verify-only` re-checks a copy without writing (also how you verify the
production repeat, whose upload printed its own verification).

## 3. Point the portal at R2 (staging first)

Only for a game whose manifest status is `verified`:

1. Open the game's page in the **staging portal** (portal.vaultlearninggames-staging.org) and set its
   **Play URL** to the printed R2 URL (the one ending in `/index.html`), then publish.
2. Launch the game from vaultlearninggames-staging.org: it must reach its title screen. In the
   browser's Network tab, no request may 404 and **no request may go to a DoIT host**.
3. Repeat for the remaining five games: `yardgames`, `jowilder`, `lakeland`, `forevermine`,
   `thermovr`, `shadowspect`.

## 4. Repeat for production

Re-run step 2 with the production bucket's credentials (`CDN_BUCKET`, `CDN_PUBLIC_URL`), flip the
production portal entries the same way, and verify in production.

## Rollback and safety rules

* **Rollback:** set the game's portal Play URL back to its old host (the `doitUrl` in `manifest.json`);
  unpublish if needed. That is the only rollback — the R2 copy needs no cleanup.
* **DoIT copies must not be deleted until production has been verified** — and preferably kept until
  the games have run a full semester on R2.
* The staging and production systems run the same code; the environment values decide which bucket
  is touched, so double-check `R2_BUCKET` / `R2_PUBLIC_BASE_URL` before every run.
