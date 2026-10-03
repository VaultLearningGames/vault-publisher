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
* Heading sizes are fluid, as Squarespace's are (`--hu` in `vault-sq.css`). A game's title is also never set larger
  than the size at which its widest word fits its column or card, so a long word ("Transformations") shrinks the
  title instead of overflowing, running into the next card or breaking in the middle: `partials/sq/title-fit.html`
  works out the word's width from Base 9 Sans's advance widths and the CSS ("Titles that fit") does the rest.
* Blocks never run into each other. Squarespace's grid rows have a fixed minimum height while the type is fluid, and
  its editor lets one block's box run on under the next (a heading given three rows with its paragraph starting on
  the third; a game's description whose box also holds the Play button). `partials/sq/areas.html` ends such a block
  where the next one starts, so its rows grow with its text and push the next block down instead of the two being
  drawn through each other; blocks that fit are where they were. Images are left alone: text over pictures is the
  design.
* The forms (`partials/sq/newsletter.html`, `partials/sq/submit-form.html`, the script in `vault-sq.js`) post to the
  portal. Submit a Game marks each field that needs attention under its label; one message at the top of the form
  is only for a failure that belongs to no field (the portal is down or refuses the form). Once sent, the form gives
  way to a confirmation (the `done` texts in `content/submit-a-game.md`) and the grid rows the form needed are
  closed up. After signing up, Join Vault is only its `success` line (`pages.json`, the footer's newsletter block),
  centred in a block no taller than it needs. With JavaScript off the portal sends the browser back to
  `#form-submitted`, the id of the page's form block, and the CSS shows the same thanks (`:target`).
* Fonts: Montserrat and Archivo are self-hosted (OFL). Headings are Base 9 Sans (Adobe Fonts): set
  `params.fonts.adobe_kit` to an Adobe Fonts web project containing Base 9 Sans Regular and Bold (and italics);
  until then Share Tech Mono (self-hosted, OFL) stands in.
* The "page not found" page (`layouts/404.html`): the television from Get Involved with static drawn on its screen
  by a small canvas script (a still frame with "reduce motion" or without JavaScript; a pause button). Its styles
  and script are in that file. It is shown at any address, so it may only use root-relative or absolute addresses
  (the deploy checks). What serves it for a missing address: docs/setup.md, "The 404 page".
* Images are sent at about the size they are shown (`partials/sq/img.html`): every listing, Game Card, cover,
  screenshot, featured and background image has a `srcset` of smaller WebP copies and a `sizes` (blocks: from their
  grid areas, `partials/sq/sizes.html`), with its width and height. Copies of catalog images on the CDN are made by
  the portal's image-variants task and listed in the catalog's `images`; copies of the snapshot images under
  `static/sq/img` are made by Hugo at build time (this theme's `hugo.toml` mounts them as assets as well):
  `partials/sq/srcset.html`. An image with no copies is used as it is. Everything below the top section is
  `loading="lazy"`; the first section's background (hero layout) or cover image (standard layout) is
  `fetchpriority="high"`.
* Play opens the game in the in-page player (`partials/vault-player.html`, a copy of main's).
* The scripts that took the snapshot (`migration/squarespace/*.py`; they need the Squarespace site up) stayed in
  `VaultLearningGames/vault-hugo-rebuild`, branch `original-squarespace-design`.
* Addresses a script builds must be absolute (`absURL`, as the player's logo is): listing previews are served from
  the portal, where a root-relative address would point at the portal.
