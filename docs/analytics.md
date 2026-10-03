# Analytics

Plays of the games on the website, from Google Analytics 4 (GA4), shown in the portal:

* **Vault → Analytics** (`/vault/analytics`, Vault staff only): the whole site.
* **A studio's Analytics page** (`/s/STUDIO/analytics`, in the studio's nav): all the studio's games on the site
  (its published listings).
* **A game's Analytics tab** (`/s/STUDIO/g/GAME?tab=analytics`): the same view for that game.

Vault staff see every studio and game; a studio's members, **viewers included**, see their own studio's page and its
games' tabs. The realtime refresh (`/portal/analytics/realtime?game=…|studio=…`) follows the same rules; without
either it is the site's, Vault staff only.

**Periods are calendar periods**: Day (today), Week, Month, Quarter, Year (this week, month, quarter, year). Weeks
start on **Sunday** (a US school audience; days are the property's, America/Chicago). The current period is never
over, so its figures are **this period so far against the same days of the previous one** (this week Sunday to today
against last week Sunday to the same weekday; this month to the 3rd against last month to the 3rd, or to its last day
if shorter; this year to Oct 3 against last year to Oct 3; today against yesterday up to the current hour, by a
filter on GA's `hour`). The page says which dates are compared, under the chart. The chart draws the whole period:
points still to come are empty, the previous period is dashed over its whole length (a shorter month or quarter
before has no points at the end). Points are hours (Day), days (Week, Month, Quarter) or months (Year); in Year the
month still being counted is drawn dotted, so a few days don't read as a fall.

Each view has that chart of plays, the plays, unique players and average play time with the change from the same days
before, and a map of where people are playing now (the last 30 minutes, refreshed every minute). The site and studio
views have the top games (on the site view, each with a link to its studio's page); the site view has the site's page
views, sessions and visitors; game and studio views have their pages' views, visitors and Play-button clicks (see
[History](#history-before-the-play-events)). A **play is the unit** for studios and games: they have no sessions figure
(GA's sessions are the site's visits, not a game's).

## The play events

The site has sent page views to the GA4 property with measurement id `G-1KJ4W2B81F` (the one the Squarespace site
used) since launch. Games are played inside Vault's in-page player, and most come from other sites, so GA can't see
into them: the site counts plays itself. On every game page,
`site/themes/vault-squarespace/static/sq/js/vault-play-analytics.js` (loaded by
`layouts/partials/vault-play-analytics.html`, only in a build that has a measurement id) sends:

| Event | When | Parameters |
| --- | --- | --- |
| `play_start` | The player opens (`play_mode` `player`), or a Play button the player leaves alone opens the game in a new tab (`new_tab`: games whose sites refuse frames, and listings with *embed* off) | `game_slug`, `studio`, `play_mode`, `play_id` |
| `play_heartbeat` | Every 30 s while the player is open **and** the page is visible (Page Visibility API) | the above, and `play_seconds`: seconds on screen since the play's last event |
| `play_end` | The player closes (`end_reason` `close`), the page is hidden (`hidden`: another tab, the screen locks, the phone switches apps) or left (`unload`, on `pagehide`), or another play starts (`restart`). Sent with `transport_type: 'beacon'` | the above, `play_seconds` (the rest), `end_reason` |

* `game_slug` is the listing's slug in the portal (the catalog's `slug`, not the page's Squarespace address), `studio`
  the studio's slug. `play_id` is random per play, for debugging; it isn't registered.
* **`play_seconds` adds up.** Each heartbeat reports only the seconds since the previous event, and `play_end` the
  rest, so the sum of `play_seconds` over all play events is the time games were open and on screen, and a lost
  `play_end` (a closed laptop, a killed mobile tab) loses at most 30 s. Fractions carry over to the next event. A gap
  of more than two heartbeats while visible (the computer slept) counts as two heartbeats.
* Hiding the page ends the counting with a `play_end`; coming back with the player still open counts again under
  the same `play_id`, without a new `play_start`. So **count plays with `play_start`**, never `play_end`.
* New-tab plays can't be timed (the game runs in another tab, on another site): they have no heartbeats.
  **Average play time = sum of `play_seconds` ÷ `play_start` events with `play_mode` = `player`.**
* On `play_start` the page also sets the user property `vault_game` = `game_slug`: realtime reports can't read event
  parameters, so that's how the realtime map tells games apart.
* The heartbeats keep the GA session engaged while someone plays: before, a long play inside the (cross-origin)
  player looked like an idle page and GA's own engagement time missed it. GA's engagement time is not used as play
  time anywhere.

The player (`layouts/partials/vault-player.html`) only announces `vault-player:open` and `vault-player:close` on
`document`; all of the above is in the analytics script. Tests: `test/play-analytics.test.ts`.

Builds without a measurement id (local, listing previews, staging today) send nothing: the deploy sets
`params.analytics.google` from the environment's `GOOGLE_ANALYTICS_ID` variable (production only, today). To try the
events on staging, give staging **its own** GA4 property and set its id there:
`gh variable set GOOGLE_ANALYTICS_ID --env staging --body G-XXXXXXXXXX` (never production's id: staging visits would
count as real ones).

## Setup (once, by a GA property admin)

1. **The property id.** GA → Admin → *Property settings*: the numeric **Property ID** of the property whose web stream
   is `G-1KJ4W2B81F` (not the `G-` id). Set it for both systems:
   `gh variable set GA_PROPERTY_ID --env staging --body NNNNNNNNN` and the same with `--env production`, then
   redeploy (a push to `main` for staging). Both portals read the production site's property.
2. **Access.** GA → Admin → *Property access management* → **+** → add both runtime service accounts with the
   **Viewer** role (no notification email):
   `vault-publisher@wcer-field-day-ogd-1798.iam.gserviceaccount.com` (production) and
   `vault-publisher-staging@wcer-field-day-ogd-1798.iam.gserviceaccount.com` (staging).
3. **The API.** Enable the *Google Analytics Data API* (`analyticsdata.googleapis.com`) in the service accounts'
   project, `wcer-field-day-ogd-1798`: `gcloud services enable analyticsdata.googleapis.com --project wcer-field-day-ogd-1798`.
   No other Google Cloud change is needed: the portal asks the Cloud Run metadata server for a token with the
   `analytics.readonly` scope.
4. **Custom definitions.** GA → Admin → *Custom definitions*. GA only fills them in from the day they exist, so make
   them before the events reach production:

   | Kind | Name (shown in GA) | Scope | Event parameter / user property | Unit |
   | --- | --- | --- | --- | --- |
   | Custom dimension | Game | Event | `game_slug` | |
   | Custom dimension | Studio | Event | `studio` | |
   | Custom dimension | Play mode | Event | `play_mode` | |
   | Custom dimension | Game (user) | User | `vault_game` | |
   | Custom metric | Play seconds | Event | `play_seconds` | Time: Seconds |

   (`end_reason` and `play_id` can be registered too, for exploring in GA; the portal doesn't use them.)

Until then the pages say what's missing: *not connected* (no `GA_PROPERTY_ID`, or no credentials), *no access* (step
2, or the id is wrong), *the API isn't enabled* (step 3), or *custom definitions not registered* (step 4: the site
view then still shows play counts, without play time or games; game views and the per-game realtime map need them).
Average play time shows "—" until there are timed plays in the range.

## History (before the play events)

The play events are new, but the property has years of page views from the Squarespace site, which had the same
domain and the same game page addresses. So, with standard fields only (no custom definitions):

* **A game's pages** (`src/analytics/pages.ts`): the site puts a listing's page at `/<path>/`, where `path` is its
  old Squarespace address from `site/data/squarespace/games.json` (keyed by catalog slug; e.g. `wake`, `jowilder`)
  or else the listing's slug (`site/content/games/_content.gotmpl`). The portal matches `pagePath` against `/<path>`,
  `/<path>/` and the game's old Game Card, `/game-cards/<card id>` (now a 301 to the page).
* **The chart** asks for `play_start` and `page_view` together; with no plays in either period it shows page views
  (of the game's page, or the whole site) and says so. A game's chart, plays and unique players filter on its
  `pagePath` (the play events are sent from its page), so they work without `game_slug` too; only play time and
  telling games apart in the site view need the custom definitions.
* **The game's page** (game view): `screenPageViews`, `totalUsers` of its `page_view` events (visitors) and
  `eventCount` of `click` events on it, in both periods. `click` is GA's enhanced-measurement outbound link click;
  the old site's Play button linked out to the game, so these are shown as **Play-button clicks (outbound clicks
  from the game's page)**: mostly plays before the play events, but any link out counts (curriculum, studio sites).
  A property without click events shows 0.
* **Top games by page views** (site and studio views): when no game has plays in the range, the top-games card
  ranks the games by their pages' views this period, with their Play-button clicks. Pages that aren't a published
  listing's (of the studio, on its page) are left out.

The Year range (this year against last year, the chart from January 1 of last year) is the longest; the Data API's
reports aren't limited by the property's data-retention setting (only explorations are). Locally, `GA_FAKE=history node scripts/dev-portal.ts` shows a property with page
views and no play events.

## How the portal reads it

`src/analytics/`: `reports.ts` builds the Data API v1beta request bodies and reads the answers (pure; dates are the
property's days, `GA_TIMEZONE`, default `America/Chicago`); `ga.ts` sends them (`runReport`, `runRealtimeReport` on
`properties/GA_PROPERTY_ID`), caches answers (reports 10 minutes, realtime 60 s, failures 1 minute; one call for
identical requests in flight) and turns errors into what the page explains; `google-auth.ts` gets the token (Cloud
Run: the metadata server; elsewhere application default credentials). One page view is at most five reports and three
realtime reports (the site; a studio: five and one; a game: four and one), well inside GA's free quota.

| Report | Request |
| --- | --- |
| Chart | `eventCount` of `play_start` and `page_view` by `date` (`dateHour` for Day) and `eventName`, from the start of the previous period to today |
| Plays, play time, top games | `eventCount` and `customEvent:play_seconds` by `eventName`, `customEvent:play_mode`, `customEvent:game_slug`; periods `current` (so far) and `previous` (the same days) |
| Unique players | `totalUsers` of `play_start`, both periods |
| The game's page, the studio's game pages | `screenPageViews`, `totalUsers`, `eventCount` by `eventName` (`page_view`, `click`), their `pagePath`s, both periods |
| Top games by page views (site and studio views, when no game has plays) | `screenPageViews`, `eventCount` by `pagePath` and `eventName`, the games' paths, this period so far |
| The website (site view) | `screenPageViews`, `sessions`, `totalUsers`, both periods |
| On the site now (site view) | realtime `activeUsers` by `countryId`, `country`, `city` (everyone, playing or browsing), the total, and how many have `customUser:vault_game` set (playing a game) |
| Playing now (a game) | realtime `activeUsers` by place with `customUser:vault_game` = the game's slug |
| Playing now (a studio) | the same, with `customUser:vault_game` in the list of its games' slugs (no request when it has none on the site) |

Day adds `hour` in `00`…the current hour to every two-period report, so today and yesterday cover the same hours.
A game is filtered on its page paths (`pagePath`), and on `customEvent:game_slug` = its listing slug for play time; a
studio on all its published listings' page paths, and on `game_slug` in the list of their slugs. The map places one circle per country at Natural
Earth's label point for it (`src/analytics/countries.ts`, from `scripts/world-map.ts`; public domain), sized by the
number playing; cities are listed under the map (GA gives no coordinates).

Locally, `node scripts/dev-portal.ts` shows the pages with a made-up property (`scripts/fake-ga.ts`);
`GA_FAKE=off` shows the not-connected state; `GA_PROPERTY_ID=NNN` reads the real property with your gcloud
application default credentials, which need the Analytics scope:
`gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/analytics.readonly`.

## The realtime map

A dot per city, sized by people, pulsing; zoom with the buttons, a double-click (shift: out), pinch or ctrl/⌘-scroll, and drag to pan. City points come from GeoNames cities15000 (CC BY 4.0, geonames.org), made into `src/analytics/cities.json` by `scripts/world-cities.ts`; a city not in it is drawn at its country's point (`src/analytics/countries.ts`, Natural Earth, public domain).
