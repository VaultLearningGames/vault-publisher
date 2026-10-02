# vault-squarespace: the original (Squarespace) design

A static replica of vaultlearninggames.org as it was on Squarespace (snapshot 2026-09-29), with the same URLs.
All CSS and JS here were written for this theme from measurements of the live site; no Squarespace code, Squarespace
fonts or third-party Squarespace plugins are used, and nothing is loaded from Squarespace hosts.

* Pages are sections on a 24-column grid (8 on phones), as in Squarespace's layout engine. The section and block
  layouts, text and images of the fixed pages are in `data/squarespace/pages.json` (edit it by hand now).
* Game pages (`layouts/games/single.html`) come from the portal catalog (`data/catalog.json`) at their Squarespace
  address (`/wake`, `/aquation`, ...). The temporary `data/squarespace/games.json` supplies what the catalog has no
  field for yet: the address, the layout (hero / standard), grid positions, background / logo art, Game Card
  thumbnail and date, SEO title, and fallbacks for empty catalog text. Catalog values win wherever they exist.
  Games not in that file get `data/squarespace/default-game.json`.
* The accordion on a game page (`partials/sq/game-accordion.html`): About this game, Trailer, Curriculum, Made By, in
  that order. About this game shows whenever there is text: the catalog's `about` (Markdown), or the Squarespace text
  in `games.json` while the catalog's is empty or only repeats the short description. `open_first` on the accordion
  block in `games.json` is Squarespace's "expand first item" (36 of the pages).
* The All Games filters on the home page (`partials/sq/game-grid.html`): up to 500px wide a panel that slides in from
  the left (Filter opens it, the X closes it); wider, dropdowns above the grid (one, two, then four to a row). The grid
  has as many 250px columns as fit, five at most. All as measured on the Squarespace site.
* `/game-cards` (20 per page, `?offset=` like Squarespace), its card URLs (redirects to the game pages) and its
  `/game-cards/category|tag/...` pages come from `content/game-cards/`. `npm run site:build` runs
  `site/scripts/squarespace-paths.mjs` after Hugo to put the filter pages at folder names Hugo can't write.
* Fonts: Montserrat and Archivo are self-hosted (OFL). Headings are Base 9 Sans (Adobe Fonts): set
  `params.fonts.adobe_kit` to an Adobe Fonts web project containing Base 9 Sans Regular and Bold (and italics);
  until then Share Tech Mono (self-hosted, OFL) stands in.
* Play opens the game in the in-page player (`partials/vault-player.html`, a copy of main's).
* The scripts that took the snapshot (`migration/squarespace/*.py`; they need the Squarespace site up) stayed in
  `VaultLearningGames/vault-hugo-rebuild`, branch `original-squarespace-design`.
* Addresses a script builds must be absolute (`absURL`, as the player's logo is): listing previews are served from
  the portal, where a root-relative address would point at the portal.
