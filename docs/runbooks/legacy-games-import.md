# games.json import (card D of "Retire Squarespace data")

Moves the 99 games of vault-site's `data/squarespace/games.json` (the Squarespace snapshot) into the portal's
listings, once, idempotently: page layout (Hero/Standard) and theme (Light/Dark), hero background and logo art, card
title/excerpt/categories/tags (through the option lists), SEO title/description, the page address (the old path) and
the aliases (the old `/game-cards/CARD-ID` addresses, and any other old address), and **every game image** re-hosted
through card A's crop/compress config. The code is `src/migrations/legacy-games/`, the endpoints
`/v1/admin/legacy-games/…` (admin-task auth) and the driver `scripts/import-legacy-games.ts`.

## Rules it keeps

- It never creates a game: a snapshot entry without a portal listing is reported (and its URLs listed as lost).
- Matching: the snapshot key is the listing slug and `path` the old address; the 12 path≠slug games are cross-checked
  against `slug-map.ts`. A key that is not a listing but whose `path` is, is matched and reported as `inverted`.
- Never lose content: a field is written only while it is empty (the default, for the layout and theme) or still
  holds what the import wrote; otherwise it is kept and reported as a conflict. Aliases are a union.
- The listing date is never written (decision 7): the record's created date is kept; old dates that differ by more
  than a day are listed in the report.
- `title_scaled` (flap-to-the-future, jo-wilder-and-the-capitol-case) is not imported (decision 8) and is listed as
  an expected visual change.
- Images: each value is downloaded, cropped (centred, the field's ratio) and compressed exactly like the browser
  tool (`public/portal-image-tool.js`'s `computeCropRect` + `planCompression`, sharp instead of a canvas), then
  checked by the portal like an upload (`validateFieldImage`). The original is kept, byte for byte, at
  `_legacy/STUDIO/GAME/KIND-HASH.EXT` in the CDN bucket; the result is the game's own `_vault-assets/` object. An
  image narrower than the field's minimum is enlarged and reported.
- Draft and published listings are written the same way, without a new review (like cards A and C's backfills); the
  site needs a rebuild afterwards (the run marks a deploy pending).
- A second run changes nothing: `--apply` checks this itself and fails otherwise.

## Run it (staging first)

```sh
npm ci
# 1. dry run: plans, downloads and compresses every image, the portal checks each; nothing is stored or written
node scripts/import-legacy-games.ts --portal https://portal.vaultlearninggames-staging.org \
  --source ../vault-site/data/squarespace/games.json --out legacy-import
# 2. read legacy-import/report.md; then apply
node scripts/import-legacy-games.ts --portal https://portal.vaultlearninggames-staging.org \
  --source ../vault-site/data/squarespace/games.json --out legacy-import --apply
```

The token is `--token`, else `$ADMIN_TASK_TOKEN`, else the GitHub Actions OIDC token (a job with `id-token: write`
in the portal's environment, like `admin-task.yml`). Images that are site paths are downloaded from `--site`
(default `https://vaultlearninggames.org`). The script exits 1 when an image failed, a URL served today would be
lost, or a second run would still change something.

Output in `--out`: `report.md` (counts against the card's measured state, the **pages that visibly change** — the
list for djgagnon's review —, title styling dropped, date differences, conflicts, unmatched card strings, failed
images, lost URLs), `report.json` (everything, per game and image), `urls-before.tsv` and `urls-after.tsv`
(`URL<TAB>expected status<TAB>game<TAB>kind`). The last applied report is also at `GET /v1/admin/legacy-games`.

Staging's portal database is re-seeded from production every day, so an import applied on staging is gone the next
morning; production is applied only with David's explicit yes.

## Roll back

```sh
node scripts/import-legacy-games.ts --portal URL --rollback           # dry run: what would go back
node scripts/import-legacy-games.ts --portal URL --rollback --apply
```

Every field the import wrote goes back where it still holds the import's value (later edits are kept), and the
records are cleared. The CDN objects stay (immutable; a site build may use them).

## D-site (follow-up card, Repo: VaultLearningGames/vault-site, branch staging)

The redirect test and the visual gate run on the built Hugo site, so they belong in vault-site:

1. **Aliases.** Render each catalog game's `aliases`: a plain alias `X` 301s from `/X/` to the page; an alias
   `game-cards/ID` 301s from `/game-cards/ID` (replacing `layouts/index.cardredirects.json`'s read of games.json).
   The page lives at `/PAGE_ADDRESS/`.
2. **Redirect test.** Read `urls-before.tsv` (from this import's report, committed as a fixture) and check, against
   the built output and its `_redirects`, that every URL is served: `200` (a page) or `301` to the right game's page.
   Fail on any URL that 404s.
3. **Visual gate.** Build the site before (games.json) and after (catalog fields); Playwright renders all 99 pages at
   desktop (1440×900) and mobile (390×844) and fails on a missing image (`naturalWidth == 0` or a non-2xx image),
   a broken URL, a blank section, or a hero/standard layout that differs from games.json's `layout`. It writes a
   contact sheet (before|after per changed page) for human review; the pages expected to change are the import
   report's "Pages that visibly change".
4. Acceptance: all 99 pass; the contact sheet and the changed-page list are posted for djgagnon's review.
