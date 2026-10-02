# Site checks

A battery of tests run against the live Vault website: every page is opened in a headless Chromium, every link is
followed, every game is opened the way a visitor opens it. Six checks, each of which can run by itself. A run produces
**findings**, each a **failure** (visitors hit it) or a **warning** (worth a look, or couldn't be verified).

The GitHub Actions runner does the looking. The `check-site` workflow starts a browser on the runner, runs the checks,
and posts the finished run to each system's portal, which stores it and shows it under **Vault → Site checks**. This is
how [game availability](../README.md#api) works too. The portal never opens a browser.

The code: `src/site-checks.ts` (what the measurements mean: the limits, the findings, the reports; no browser, so it
is unit-tested), `src/site-checks/` (the engine that does the looking), `scripts/check-site.ts` (the command line),
`.github/workflows/check-site.yml` (the schedule).

## The checks

The same problem on many pages (a broken footer link) is one finding listing its pages. Thresholds are `LIMITS` in
`src/site-checks.ts`.

**Games load** (`games`). Opens every game the site lists, the way its page does: in the site's in-page player, or in a
new tab for games that don't allow framing. Each game is opened once, from its own page; a network error gets a
second try.
* Failure: the game's address doesn't answer or answers 4xx/5xx, the browser refuses to frame it, the Play button
  doesn't open the player, or the game opens and shows nothing.
* Warning: the game is still one flat colour after loading (`blank`); it asks for files of its own that don't arrive
  (the first `gameMissingListed` = 5 are listed, the rest counted; its calls to someone else's statistics service
  aren't); or its site refuses the checker (HTTP 401, 403, 429…), which says nothing about a visitor.

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

**Large files and slow loading** (`performance`). From the same page loads, plus the games' own loads. The pages share
one browser cache, so each file is downloaded once per run; a page's weight still counts every file it uses at the
size it had when first fetched. Timings come in two steps: the visit gives a first look, then every page that looked
slow or is over `pageWarnBytes` (the 30 heaviest) is loaded again alone with an empty cache, as a first-time visitor
gets it, and that time is the one reported.

| | Warning | Failure |
| --- | --- | --- |
| An image | over `imageWarnBytes` 500 KB | over `imageFailBytes` 2 MB |
| A script, stylesheet, font or other file | over `fileWarnBytes` 1 MB | over `fileFailBytes` 5 MB |
| A video or audio file | over `mediaWarnBytes` 10 MB | |
| Everything one page loads | over `pageWarnBytes` 3 MB | over `pageFailBytes` 10 MB |
| Page load | over `loadWarnMs` 3 s | over `loadFailMs` 8 s |
| Largest contentful paint | over `lcpWarnMs` 2.5 s | over `lcpFailMs` 4 s |
| Time to first byte | over `ttfbWarnMs` 0.8 s | |
| A game's load time | over `gameLoadWarnMs` 15 s (or not finished when the check stopped waiting) | |
| What a game downloads before it can be played | over `gameWarnBytes` 50 MB | over `gameFailBytes` 200 MB |

Also warnings: a text file over `uncompressedBytes` 20 KB sent without compression, and an image with more than
`oversizedFactor` 3 times the pixels across that it is shown at (when the file is over `oversizedBytes` 100 KB). Only
one timing finding per page is reported (load, then paint, then first byte).

**Responsive design** (`responsive`). Every page at phone (360 px), tablet (768), laptop (1280) and wide (1920) widths.
* Failure: the page scrolls sideways on a phone or tablet (wider than the window by more than `overflowPx` 2 px; the
  element that sticks out furthest is named); no viewport meta tag, so phones show the page zoomed out.
* Warning: sideways scrolling on a laptop or wide screen; on a phone, text under `smallTextPx` 12 px, and buttons and
  icon links smaller than `tapTargetPx` 24 px either way (a text link is as tall as its line, so it only counts when
  it is also under 24 px wide; a link inside a sentence never does). One finding per kind of element.

## Starting a run

* **On a schedule.** `check-site.yml` runs daily at 11:47 UTC for staging and production.
* **By hand in GitHub:** Actions → Check site → Run workflow, or

  ```sh
  gh workflow run check-site.yml -f environment=staging -f checks=links,spelling
  gh workflow run check-site.yml -f environment=staging -f limit=20 -f fail_on=never   # a quick look
  gh run watch
  ```

  `checks` is `all` or a list of `games`, `assets`, `links`, `spelling`, `performance`, `responsive`. `limit` visits
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
  the six names (kept in their usual order); `started_at` and `finished_at` are dates (stored as ISO times); `source`
  is empty or an https link of at most 500 characters; `pages` and `games` are whole numbers, 0 or more; `error` is
  text of at most 1000 characters, or null.
* `summaries` has at most one entry for each listed check: a valid `check`, `status` (`done`, `skipped` or `error`),
  `note` (at most 500 characters), and numbers for `checked` and `ms`.
* `findings` has at most 2000 entries, each with a valid `check` (one of the run's), `level` (`warn` or `fail`), `code`
  (100 characters), `page` (500), `target` (2000), `message` (1000), `pages` (at most 20 paths of 500), a `count` of 1
  or more, and optionally a `detail` of at most 20 keys with text (500 characters), number, true/false or null values.
* The counts are never taken from the body: the totals and each check's failing and warning numbers are worked out from
  the findings. Who started the run is not taken from the body either: it is `github:` and the actor in the token.

The portal keeps the latest 60 runs and writes an audit entry (`site_checks.post`) with the counts and the workflow
run's address. A full run is about 300 KB, well inside the 4 MB limit on requests.

## Where results appear

* **The job summary** of the workflow run: a table of the six checks and each check's findings, worst first.
* **Annotations** on the run: an error for each failure and a warning for each warning, up to GitHub's ten of each,
  then one line for the rest.
* **A tracking issue** per system, *Site checks (staging)* / *(production)*, label `site-checks`: it lists the failing
  findings, is opened or updated whenever something fails, gets a comment when the set of failures changes, and is
  closed when nothing fails (a run that couldn't finish never closes it). Warnings alone don't open one.
* **The portal:** **Vault → Site checks** shows the latest run and the recent ones, with every finding and the pages it
  is on, for Vault staff. Its **Run the checks** button opens the workflow in GitHub.
* **The artifact** `site-checks-ENVIRONMENT`: the whole run as `site-checks.json` (`SiteCheckRun` in
  `src/site-checks.ts`).

The job fails when `check-site.ts` exits non-zero (see `fail_on`), after the summary, the post to the portal and the
issue are done, so GitHub notifies the people watching the repository. A post the portal refuses fails the job too.

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

* **Timings are from GitHub's hosted runner**, a data-centre machine on a fast connection, not from a classroom.
  A classroom's connection is slower: treat a warning as "this is heavy", and the byte counts, which don't depend on
  where you are, as the firmer number.
* **The checker's own connection.** A network error is only believed while the checker can still reach the site's
  front page; if it can't, it waits (up to three minutes) and tries again, and a connection that stays away ends the
  run as "did not finish" rather than reporting hundreds of false failures.
* **A run takes roughly seven to fifteen minutes** for the whole site (275 pages at four widths and 101 games took 7
  minutes from a laptop on 2026-10-02; a hosted runner is slower), and the job is stopped at 45. A `limit` or `paths` run takes less.
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
