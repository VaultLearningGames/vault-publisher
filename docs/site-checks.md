# Site checks

A battery of tests run against the live Vault website: every page is opened in a headless Chromium, every link is
followed, every game is opened the way a visitor opens it, and the services the games depend on are asked for. Seven checks, each of which can run by itself. A run produces
**findings**, each a **failure** (visitors hit it) or a **warning** (worth a look, or couldn't be verified).

The GitHub Actions runner does the looking. The `check-site` workflow starts a browser on the runner, runs the checks,
and posts the finished run to each system's portal, which stores it and shows it under **Vault → Site checks**. This is
how [game availability](../README.md#api) works too. The portal never opens a browser.

The code: `src/site-checks.ts` (what the measurements mean: the limits, the findings, the reports; no browser, so it
is unit-tested), `src/site-checks/` (the engine that does the looking), `scripts/check-site.ts` (the command line),
`.github/workflows/check-site.yml` (the schedule).

## The checks

The same problem on many pages (a broken footer link) is one finding listing its pages. Thresholds are `LIMITS` in
`src/site-checks.ts`. Each finding keeps what makes it actionable in its `detail`: a missing file's HTTP status (or
the browser's error), its type and the element that asks for it (`img`, `script`, `link rel=stylesheet`, `img srcset`,
`div style`, or the likeliest asker when no element names it, e.g. a stylesheet's `@font-face`); a link's status or
network error, its text, its kind and where it redirected; a game's name, how it opens, its status, error and load
time; a word's suggestion and context; a layout problem's width, element and sizes; a large file's bytes, element and
whether it is a third party's; a heavy page's biggest files.
Each check lists at most 500 findings (its failures first, then the most widespread); the rest are counted in its
summary's `unlisted` and in the totals.

**Games load** (`games`). Opens every game the site lists, the way its page does: in the site's in-page player, or in a
new tab for games that don't allow framing. Each game is opened once, from its own page; a network error gets a
second try.
* Failure: the game's address doesn't answer or answers 4xx/5xx, the browser refuses to frame it, the Play button
  doesn't open the player, or the game opens and shows nothing.
* Warning: the game is still one flat colour after loading (`blank`); it asks for files of its own that don't arrive
  (the first `gameMissingListed` = 5 are listed, the rest counted; its calls to someone else's statistics service
  aren't); or its site refuses the checker (HTTP 401, 403, 429…), which says nothing about a visitor.
* **Without the Vault player's bar** (all warnings: the game may still play fine, but the visitor loses Vault's bar,
  its fullscreen and close buttons and its way back):
  * `game.own-tab`: Play opens the game in its own tab (its listing has embed off, or its site refuses to be framed).
  * `game.leaves-player`: in the player, the game takes the whole tab to its own site (frame-busting), or opens a
    window of its own (`window.open`, recorded even when the checker's popup blocker stops it).
  * `game.launcher`: what the player shows is a launcher, a visible link or button worded like Play, Start or Launch
    that opens the game in a new tab or over the whole page (`target=_blank` / `_top`).
* **Each page plays its own game** (with `--catalog PORTAL`, as the workflow runs it). Game pages name their listing in
  `<meta name="vault:game">`; the check compares every page's Play address with what that listing plays in the
  portal's public catalog (`/v1/catalog`), ignoring a trailing slash or `index.html`.
  * Failure (`game.shared-play`): two or more listings play the same address, so at most one of them is right
    (Headlines and High Water once played Jo Wilder's build). The Yard games share one CDN game but each plays its own
    folder, so they don't count.
  * Failure (`game.wrong-play`): a page's Play opens something other than its listing's address: the page is stale
    (rebuild the site) or wired to the wrong game.
  * Warning (`game.unlisted-page`): a game page for a listing the catalog doesn't have.

**Missing assets** (`assets`). Every request a page makes while it loads and is scrolled to the bottom (so lazy images
load), at the laptop width.
* Failure: the page itself doesn't load or answers 4xx/5xx; an image, stylesheet, script, font or video the page needs
  doesn't arrive or answers 4xx/5xx; anything from the site's own address does the same; a broken image on the page
  (one that finished loading with nothing to show; an image still arriving isn't broken).
* Warning: a third party's data request (analytics) fails; a script on the page stops with an error. Requests the
  browser cancels itself, and requests made inside embedded frames (a video player), aren't counted.

**Broken links** (`links`). Every link, embedded frame, video and sitemap entry on every page, requested with plain
HTTP (GET, redirects followed, one retry). YouTube videos are asked about through YouTube's oEmbed address, because a
removed video's own page still answers 200. Forms that post (Join Vault, Submit a Game) aren't requested: their
address answers a GET with "not found" by design.
* Failure: HTTP 404 or 410; any other 4xx/5xx from the site itself; a host that no longer exists (DNS), a broken HTTPS
  certificate or a redirect loop; a site's own link that doesn't answer; a `mailto:` or `tel:` that isn't valid.
* Warning: an external site that doesn't answer or refuses automated requests (401, 403, 405, 406, 429, 999: see
  [reading the "couldn't be verified" warnings](#reading-couldnt-be-verified)); a link to `#something` that isn't on
  the page it leads to; an empty or `javascript:` address; a link to a private address.

**Spelling** (`spelling`). The visible text of every page against an English dictionary (`dictionary-en`, through
`nspell`). Only ever a warning: a dictionary can't tell a typo from a name it hasn't met. Left out: addresses and
emails, anything with a digit, single letters, short ALL-CAPS words (NGSS, STEM) and words with a capital inside
(iCivics, PhET). One finding per word, with its context and the dictionary's best suggestion.
See [accepting a word](#accepting-a-word).

**Website size and speed** (`performance`). The website's own files only, from the same page loads; games are judged
separately under Games load (below the table). The limits are for a US school's shared classroom wifi: a building's
connection split among everyone on it leaves about **1 Mbps per student**, and a class of 30 opens the same page at
the same moment. 1 Mbps is 125 KB a second, so a 500 KB first view takes a student about 4 seconds and a 1 MB one
about 8; 30 students pulling 1 MB each is 30 MB through a classroom access point at once. Hence a first view (what a
student sees before scrolling) of at most 500 KB, and a whole page of at most 1 MB.

| | Warning | Failure |
| --- | --- | --- |
| First view: what loads before any scrolling, at the laptop width (1280 × 800), empty cache | over `firstViewWarnBytes` 500 KB | over `firstViewFailBytes` 1 MB |
| The whole page, after scrolling to the bottom | over `pageWarnBytes` 1 MB | over `pageFailBytes` 2 MB |
| One image | over `imageWarnBytes` 150 KB | over `imageFailBytes` 500 KB |
| One script, stylesheet, font or other file | over `fileWarnBytes` 100 KB | over `fileFailBytes` 300 KB |
| All the page's JavaScript and CSS together | over `codeWarnBytes` 170 KB | over `codeFailBytes` 350 KB |
| A video or audio file | over `mediaWarnBytes` 5 MB | never |
| Largest contentful paint, on Slow 4G | over `lcpWarnMs` 2.5 s | over `lcpFailMs` 4 s |
| The load event, on Slow 4G | over `loadWarnMs` 5 s | over `loadFailMs` 10 s |
| Time to first byte, on Slow 4G | over `ttfbWarnMs` 1.8 s | |

How it is measured:

* **Bytes are as sent over the network** (compressed, with the response headers), as Chromium reports them. Each
  address counts once on a page. The pages share one browser cache, so each file is downloaded once per run; a page's
  weight still counts every file it uses at the size it had when first fetched.
* **A check is never a visit.** The checker's browsers answer analytics hits themselves (Google Analytics `collect`
  requests and Cloudflare Web Analytics' `/cdn-cgi/rum` beacon, `ANALYTICS_HIT` in `src/site-checks/browser.ts`) with
  an empty 204, so the hundreds of pages a run loads aren't recorded as visitors; the analytics scripts still download
  and count toward a page's weight.
* **Third-party files count.** Google's tag script costs a classroom the same bandwidth as the site's own. A finding
  about someone else's file says so ("from another site (www.googletagmanager.com)", `detail.thirdParty`), and the
  page-level findings mark them "(third-party)", so it is clear the fix is to drop or defer that service rather than
  to shrink a file. Another host of the site's own domain (its CDN, `cdn.vaultlearninggames.org`) is the site's own.
  Files loaded inside embedded frames aren't counted: the site has none until Play is pressed, and a game is judged by
  itself.
* **Files asked for only after the page's load event** (the site's Google Analytics tag, which it loads once the page
  is ready and the browser is idle) are nothing a visitor waits for: they count toward the whole page, and a large one
  is still its own finding, but not toward the first view or the JavaScript and CSS budget, which are about what a
  page needs before it can be used.
* **The first view** is what the page has asked for once it has loaded and the network has gone quiet (up to 4 s),
  before the check scrolls, less the lazy images (`loading="lazy"`) that are below the fold. Chrome fetches lazy
  images that are near the window early, so a visitor who never scrolls may still download some of them; they aren't
  counted, because the page doesn't need them to show its first screen. **The whole page** is everything after
  scrolling to the bottom and waiting for the images that scrolling started.
* **One finding per page for each page-level budget** (`perf.first-view`, `perf.heavy-page`, `perf.heavy-code`). Its
  message names the three biggest files, and its `detail` has the total (`bytes`), how many files (`files`), how much
  of it is third-party (`thirdPartyBytes`) and the five biggest files (`biggest`, one per line), which the portal shows
  in its **What to fix first** column.
* **Timings are judged only on a throttled load.** The visit pass loads pages several at a time on the runner's fast
  connection, which says nothing about a classroom. So pages are loaded again one at a time, in a fresh browser
  context with an empty cache, on Chrome's **Slow 4G** (`THROTTLE`: DevTools' and Lighthouse's preset for 150 ms
  round trips, 1.6 Mbps down and 750 Kbps up, which Chrome applies per request as 562.5 ms of latency and 90% of the
  bandwidth). Which pages: first the heaviest page of each kind, so every template is covered (the home page, a
  game's page, `/game-cards/`, its tag and category pages, `/about/`, `/get-involved/`, `/submit-a-game/`, …:
  `templateOf` in `src/site-checks/util.ts`), then pages that looked slow in the visit pass or are over a weight
  limit, heaviest first, 24 in all (each takes a few seconds). Pages that weren't re-timed get no timing findings.
* **Why these timing limits.** Largest contentful paint is the limit approved on 2026-10-04 (web.dev's "good" and "poor"
  thresholds, which are what Lighthouse judges on this same connection). The load event and the first byte are kept
  as backstops but moved to the throttled load too, rather than judged on the runner's connection, so that every
  timing means the same thing: the load event at twice and two and a half times the paint limits (5 s and 10 s: a
  page can paint its main content and still be downloading below-the-fold images), and the first byte at web.dev's
  "poor" 1.8 s (the emulated latency is part of it, so the old 0.8 s would warn on every page). One timing finding per
  page: the worst of paint, load and first byte (paint first when they tie). A page that hasn't finished loading
  after 60 s is reported as taking 60 s.

Games are counted apart from the website, under **Games load**, and their size and speed only ever warn: a game's
load time over `gameLoadWarnMs` 15 s (or not finished when the check stopped waiting), and what a game downloads
before it can be played over `gameWarnBytes` 50 MB. A game's files never count toward a page's weight.

Also warnings: a text file over `uncompressedBytes` 20 KB sent without compression, and an image with more than
`oversizedFactor` 3 times the pixels across that it is shown at (when the file is over `oversizedBytes` 100 KB).

**Responsive design** (`responsive`). Every page at phone (360 px), tablet (768), laptop (1280) and wide (1920) widths.
* Failure: the page scrolls sideways on a phone or tablet (wider than the window by more than `overflowPx` 2 px; the
  element that sticks out furthest is named); no viewport meta tag, so phones show the page zoomed out.
* Warning: sideways scrolling on a laptop or wide screen; on a phone, text under `smallTextPx` 12 px, and buttons and
  icon links smaller than `tapTargetPx` 24 px either way (a text link is as tall as its line, so it only counts when
  it is also under 24 px wide; a link inside a sentence never does). One finding per kind of element.

**Game services** (`services`). The services Field Day's games call while they are played, which live outside Vault:
the player codes service (`fieldday-web.wcer.wisc.edu/wsgi-bin/opengamedata.wsgi/player/`) and the Open Game Data
logger (`ogdlogger.fielddaylab.wisc.edu/logger/log.php`). A game whose service is down still opens, so the games check
can't see it. Each is asked for with one plain GET per run, no browser; only a request that gets no answer is tried
again (2 s later), because the player codes service makes up a new code for every request. The logger is asked with no
game data, which it answers with "No session_id": nothing is logged. The list is `SERVICES` in `src/site-checks.ts`
(an address, and what a healthy answer has in it); another host of a service is one more entry. It runs before
anything else and doesn't need the site, so a run of only this check (`--checks services`) starts no browser.
* Failure: the service doesn't answer (DNS, HTTPS certificate, timeout, refused connection), answers 4xx/5xx, or
  answers with something else (the player codes service without `"status": "SUCCESS"`, the logger without
  "No session_id").
* Warning: it takes more than `serviceWarnMs` 3 s to answer.

## Starting a run

* **On a schedule.** `check-site.yml` runs daily at 11:47 UTC for staging and production.
* **By hand in GitHub:** Actions → Check site → Run workflow, or

  ```sh
  gh workflow run check-site.yml -f environment=staging -f checks=links,spelling
  gh workflow run check-site.yml -f environment=staging -f limit=20 -f fail_on=never   # a quick look
  gh run watch
  ```

  `checks` is `all` or a list of `games`, `assets`, `links`, `spelling`, `performance`, `responsive`, `services`. `limit` visits
  that many pages. `fail_on` is `fail` (the default: a failing finding fails the job), `warn` (warnings do too) or
  `never` (only a run that couldn't finish does). Another workflow can call it (`uses: ./.github/workflows/check-site.yml`
  with the same inputs), for example after a deploy.
* **From a terminal.** `npm run site:audit -- --site http://localhost:1313` against `npm run site:dev`, or any site.
  It needs the dev dependencies and a browser: `npm ci && npx playwright install chromium-headless-shell`. Options:
  `--checks`, `--limit` and `--paths /a/,/b/` narrow the run; `--guard` refuses private addresses (off by default, so
  localhost works; the workflow turns it on); `--words zorp,blat` accepts words; `--catalog https://portal.vaultlearninggames-staging.org`
  accepts the game, studio and maker names in that portal's catalog (if the catalog can't be read it warns and goes on);
  `--source` and `--portal-page` are links recorded in the result and the reports; `--fail-on fail|warn|never`;
  `--out run.json`, `--summary summary.md` and `--issue issue.md` keep the result and the two reports. Exit code: 0
  passed, 1 failed, 2 couldn't run. To see a local run in a development portal, start it with
  `SITE_CHECKS_JSON=run.json node scripts/dev-portal.ts`.

## What the portal receives

One request, from the workflow's last step but one, in the admin lane like [check-games](../README.md#api): the token is the
workflow's GitHub OIDC token (audience `vault-publisher`), and only this repository's workflow in the system's
environment is accepted. Inside such a job, with the `site-checks.json` the script wrote:

```sh
token=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=vault-publisher" | jq -r .value)
curl -sS -X POST "$PORTAL/v1/admin/site-checks" -H "Authorization: Bearer $token" \
  -H 'Content-Type: application/json' --data-binary @site-checks.json
# → 200 {"id":7,"counts":{"warn":12,"fail":1},"url":"…/vault/site-checks/7"}
```

The portal checks the body and keeps what it can trust; anything unusable is a 400 with the reason, and a portal
without the feature answers 404 (the workflow says so in a notice and carries on). What is validated:

* `site` is an http(s) address (reduced to its origin); `status` is `done` or `error`; `checks` is a non-empty list of
  the seven names (kept in their usual order); `started_at` and `finished_at` are dates (stored as ISO times); `source`
  is empty or an https link of at most 500 characters; `pages` and `games` are whole numbers, 0 or more; `error` is
  text of at most 1000 characters, or null.
* `summaries` has at most one entry for each listed check: a valid `check`, `status` (`done`, `skipped` or `error`),
  `note` (at most 500 characters), numbers for `checked` and `ms`, and optionally `unlisted: { warn, fail }`, the
  findings the check found but didn't list.
* `findings` has at most 500 entries for each check (3000 in all), each with a valid `check` (one of the run's), `level` (`warn` or `fail`), `code`
  (100 characters), `page` (500), `target` (2000), `message` (1000), `pages` (at most 20 paths of 500), a `count` of 1
  or more, and optionally a `detail` of at most 20 keys with text (500 characters), number, true/false or null values.
* The counts are never taken from the body: the totals and each check's failing and warning numbers are worked out from
  the findings, plus each check's `unlisted`. `detail_version` (2) marks a run whose findings carry the details above;
  runs stored before it show what they have. Who started the run is not taken from the body either: it is `github:` and the actor in the token.

The portal keeps the latest 60 runs and writes an audit entry (`site_checks.post`) with the counts and the workflow
run's address. A full run is about 300 KB; `check-site.ts --out` writes it on one line, and if it would still be over
3.8 MB (the portal takes at most 4 MB) the check listing the most findings lists fewer, counting the rest as `unlisted`.

## Where results appear

* **The job summary** of the workflow run: a table of the seven checks and each check's findings, worst first.
* **Annotations** on the run: an error for each failure and a warning for each warning, up to GitHub's ten of each,
  then one line for the rest.
* **A tracking issue** per system, *Site checks (staging)* / *(production)*, label `site-checks`: it lists the failing
  findings, is opened or updated whenever something fails, gets a comment when the set of failures changes, and is
  closed when nothing fails (a run that couldn't finish never closes it). Warnings alone don't open one.
* **The portal:** **Vault → Site checks** shows the latest run and the recent ones, for Vault staff. Each check that
  found something opens (its **Details** button, or a click on its row) a table of its findings with the columns that
  check needs (for missing assets: the file, its answer, the element that asks for it, the problem and the pages that
  use it), filterable, sortable by column, with links that open the page or the file in a new tab, **Copy as CSV**
  (the rows shown) and **Download CSV** (`/vault/site-checks/ID/findings.csv?check=NAME`, every row). A run's own
  page opens a check from its address, e.g. `/vault/site-checks/12#check-links`. Its **Run the checks** button opens the workflow in GitHub.
* **The artifact** `site-checks-ENVIRONMENT`: the whole run as `site-checks.json` (`SiteCheckRun` in
  `src/site-checks.ts`).

The job fails when `check-site.ts` exits non-zero (see `fail_on`), after the summary, the post to the portal and the
issue are done, so GitHub notifies the people watching the repository. A post the portal refuses fails the job too.

## The dashboard

The README opens with a table of badges, one column per system: the latest run, when it ran, and each of the seven
checks. They are [shields.io endpoint badges](https://shields.io/badges/endpoint-badge) reading
`GET PORTAL/v1/site-checks/badge/NAME` (`all`, `when`, or a check's name), which the portal answers from the latest
run it was sent. The endpoint is public and gives counts only ("3 failing · 12 to look at", "passing", "no runs
yet"); a check's badge comes from the most recent run that included it, so a run of one check by hand doesn't blank
the others. "Last run" turns orange when nothing has reported for two days.

## Accepting a word

Spelling warns about words the dictionary doesn't know. Game titles, studio names and the makers named in the catalog
are accepted automatically (the workflow passes `--catalog` the portal's address), wherever they appear. For anything else
(a place, a term, a name) add it to `src/site-checks/words.txt`, one word per line, lower case (case is ignored), in a
pull request: the workflow reads it from the repository. Fix a real typo on the site instead.

## Reading "couldn't be verified"

A link warning that says the site *refuses automated checks* (HTTP 403, 429, 999…) or *didn't answer the check*
means the other site would not talk to a request from a data centre. It may be fine for a visitor. Open the link; if it
works, ignore the warning. A link that answers 404 or 410, or points to a host that no longer exists, is a failure
whoever owns it. The site's own links are held to the strict standard: if the site itself doesn't answer, that is a
failure. A repeating warning you have checked can't be silenced yet; it stays a warning and never fails the job unless
`fail_on` is `warn`.

## What it can't tell you

* **Timings are an emulation.** They come from GitHub's hosted runner with Chrome throttled to Slow 4G, which is close
  to one student's share of a classroom's wifi but not the same: a real shared network also loses packets and
  queues. Chrome's per-request latency makes even a small page take about 2.5 s to paint when it chains requests to
  other sites (a font service's stylesheet, then its fonts). The byte counts, which don't depend on where you are,
  are the firmer number.
* **The checker's own connection.** A network error is only believed while the checker can still reach the site's
  front page; if it can't, it waits (up to three minutes) and tries again, and a connection that stays away ends the
  run as "did not finish" rather than reporting hundreds of false failures.
* **A run takes roughly seven to fifteen minutes** for the whole site (275 pages at four widths and 101 games took 7
  minutes from a laptop on 2026-10-02; a hosted runner is slower; the Slow 4G re-timing adds two or three minutes), and the job is stopped at 45. A `limit` or `paths` run takes less.
* **Games are opened, not played.** The check sees the game's document load, show something and stop asking for
  missing files; it can't tell that level 3 is broken.
* Pages that need a sign-in aren't covered; neither is anything the site's links don't reach (the portal's own pages).

## What it costs

* **On the portal, nothing.** The portal image has no browser and the Cloud Run service is unchanged: it receives one
  request of about 300 KB and keeps a row per run. Playwright, `nspell` and `dictionary-en` are dev dependencies, used
  only by the workflow and by people running the check from a terminal.
* **On GitHub:** about seven to fifteen minutes of a runner per system per day (two systems on the schedule), plus the
  couple of minutes it takes to install the browser.
* **A run's load on the website:** a few concurrent page loads plus a link request per distinct link, once a day per
  system. External hosts are asked once per address with a retry, so other sites see one request per link.
