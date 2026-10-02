# The Vault website

The public site, vaultlearninggames.org (staging: vaultlearninggames-staging.org): Hugo, theme
[`vault-squarespace`](themes/vault-squarespace/README.md), a replica of the site as it was on Squarespace, with the
same addresses. This folder is where the site is edited; it moved here from `VaultLearningGames/vault-hugo-rebuild`
(branch `original-squarespace-design`) on 2026-10-02. How it is built, previewed and deployed:
[the repository README](../README.md#the-website) and [docs/setup.md](../docs/setup.md#the-website-on-cloudflare-static-hosting).

| | |
| --- | --- |
| `hugo.toml` | Configuration. `params.fonts.adobe_kit` is the Adobe Fonts kit; `params.forms.*` are set by the deploy |
| `content/` | The fixed pages' front matter, and the content adapters that make game pages and `/game-cards` from the catalog |
| `data/squarespace/` | The fixed pages' layout and text (`pages.json`), per-game layout and art (`games.json`), filters, and `asset-hashes.json` |
| `data/catalog.json` | The portal's published listings: pulled by `npm run site:catalog`, never committed |
| `themes/vault-squarespace/` | Templates, CSS, JS, fonts and the Squarespace snapshot images (`static/sq/img`, 16 MB) |
| `static/files/` | `keys-to-the-vault.pdf` |
| `layouts/home.previewmap.json`, `preview/hugo.preview.toml` | Only for the portal's listing previews: an extra output, `preview-map.json`, that tells the portal where each game's page is |
| `scripts/` | `pull-catalog.mjs`, and `squarespace-paths.mjs` (moves the `/game-cards/category|tag/…` pages to their Squarespace addresses after Hugo) |

Not here: game images (on the Vault CDN, uploaded in the portal), the new design (theme `vault-theme`, still in
`vault-hugo-rebuild` on `main`), and the one-time migration files (`migration/`, also there).

`data/squarespace/asset-hashes.json` lets the templates recognise a catalog image on the CDN as the image the
Squarespace snapshot already has. It was written by `scripts/asset-hashes.mjs` in `vault-hugo-rebuild`, from the
images that repository holds; it needs no update for new uploads (an unknown hash is a new image).
