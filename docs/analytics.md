# Analytics

Plays of the games on the website, from Google Analytics 4 (GA4), shown in the portal:

* **Vault → Analytics** (`/vault/analytics`, Vault staff only): the whole site.
* **A studio's Analytics page** (`/s/STUDIO/analytics`, in the studio's nav): all the studio's games on the site
  (its published listings).
* **A game's Analytics tab** (`/s/STUDIO/g/GAME?tab=analytics`): the same view for that game.

Vault staff see every studio and game; a studio's members, **viewers included**, see their own studio's page and its
games' tabs. The realtime refresh (`/portal/analytics/realtime?game=…|studio=…`) follows the same rules; without
either it is the site's, Vault staff only.

**The date range** is picked the way Google Analytics' picker does it (PLANKA card "Analytics have same date
selection as GA"): a button showing the range opens GA's presets, in its order (Today, Yesterday, This week (Sun –
Today), Last 7 days, Last week (Sun – Sat), Last 28 days, Last 30 days, This month, Last month, Last 90 days, Quarter
to date, This year (Jan – Today), Last calendar year), a **Custom** start and end date (up to today, at most three
years), and **Compare** with the period before. The default is **Last 28 days**, compared. As in GA, "Last N days"
end **yesterday**. Weeks start on **Sunday** (a US school audience; days are the property's, America/Chicago). In the
address: `?range=PRESET`, or `?range=custom&start=YYYY-MM-DD&end=YYYY-MM-DD`, and `compare=0` to turn comparing off;
the first ranges' `?range=day|week|month|quarter|year` still work (Today, This week, This month, Quarter to date,
This year). It is a plain GET form, so it works without `public/analytics.js`, which fills in a preset's dates and
picks Custom when the dates are edited.

What a range is compared with: periods that run to today (this week, month, quarter, year) against **the same days of
the one before** (this month to the 3rd against last month to the 3rd, or to its last day if shorter); whole calendar
periods (last week, month, year) against the one before; everything else (today, yesterday, the last N days, a custom
range) against **as many days just before**. Today is compared with yesterday up to the current hour (a filter on
GA's `hour`). The page says which dates are compared, under the chart, and each change says against what.

**The chart** has three lines, on one axis: **sessions**, **plays** (`play_start`) and **users**, with each line's
total for the range and its change in the legend; the period compared with is drawn dashed in the same colours, point
for point (its first day under the range's first day). Points are hours (a single day), days (up to 92 days) or
months (longer; a month cut by the range says which days in its tooltip). Users are counted per point, so the points
don't add up to the total, which counts each person once. For a game (a studio), sessions and users are **visits that
showed its page (one of its pages) or started one of its plays**.

**Plays were not counted before Oct 4, 2026** (`PLAYS_SINCE` in `src/analytics/reports.ts`), when the site began
sending play events. Whenever the range, or the period it is compared with, reaches before that day, the chart says
so; the Plays line starts there (no points before it), and the plays, unique players and play-time changes say "not
counted for …" or "… only partly counted" instead of comparing with zero. Sessions and users go back years.

Below the chart: plays, unique players and average play time with their changes, and a map of where people are
playing now (the last 30 minutes, refreshed every minute). The site and studio views have the top games (on the site
view, each with a link to its studio's page); the site view has the site's page views, sessions and visitors; game
and studio views have their pages' views, visitors and Play-button clicks (see
[History](#history-before-the-play-events)).

Average play time shows "—" until there are timed plays in the range.

## History (before the play events)

The play events are new, but the property has years of page views from the Squarespace site, which had the same
domain and the same game page addresses. So, with standard fields only (no custom definitions):

* **A game's pages** (`src/analytics/pages.ts`): the site puts a listing's page at `/<path>/`, where `path` is its
  old Squarespace address from `site/data/squarespace/games.json` (keyed by catalog slug; e.g. `wake`, `jowilder`)
  or else the listing's slug (`site/content/games/_content.gotmpl`). The portal matches `pagePath` against `/<path>`,
  `/<path>/` and the game's old Game Card, `/game-cards/<card id>` (now a 301 to the page).
* **The chart's sessions and users** go back through those years. A game's chart, plays and unique players filter on
  its `pagePath` (the play events are sent from its page), so they work without `game_slug` too; only play time and
  telling games apart in the site view need the custom definitions.
* **The game's page** (game view): `screenPageViews`, `totalUsers` of its `page_view` events (visitors) and
  `eventCount` of `click` events on it, in both periods. `click` is GA's enhanced-measurement outbound link click;
  the old site's Play button linked out to the game, so these are shown as **Play-button clicks (outbound clicks
  from the game's page)**: mostly plays before the play events, but any link out counts (curriculum, studio sites).
  A property without click events shows 0.
* **Top games by page views** (site and studio views): when no game has plays in the range, the top-games card
  ranks the games by their pages' views this period, with their Play-button clicks. Pages that aren't a published
  listing's (of the studio, on its page) are left out.

A custom range is at most three years (and its comparison as long again); the Data API's reports aren't limited by the property's data-retention setting (only explorations are). Locally, `GA_FAKE=history node scripts/dev-portal.ts` shows a property with page
views and no play events.

## Studios' own Google Analytics

A studio, and each of its games, can have its own GA4 property get the game pages' page views and plays as well
(Vault's own property and the portal's pages above are unchanged):

* **A studio's**: studio admins set its **GA4 measurement ID** (`G-…`) on its Members page
  (`POST /portal/api/s/STUDIO/google-analytics`; `studios.ga_measurement_id`, migration v18). It applies to every
  game of the studio on the site.
* **A game's**: the listing field `ga_measurement_id` (the editor's *Analytics* section), reviewed and published
  like the rest of the listing.
* **The catalog** gives each game `analytics: { google: [game's, studio's] }` (valid ids only, each once).
* **The site** (`partials/sq/head.html`) configures them on the game's page after Vault's own
  `gtag('config', …)`. The page view and the play events (`sq/js/vault-play-analytics.js`) name no destination
  (`send_to`), so gtag sends each of them to every configured property: the studio's property gets `page_view`,
  `play_start`, `play_end`, … with the same parameters and the `vault_game` user property, and GA4 adds the
  visitor's country and city itself (GA4: **Reports → User attributes → Demographic details**, and **Realtime**).
  Only builds that send Vault's analytics (production) configure them, so staging and listing previews send nothing
  to studios either.
* **The portal**: a studio's Analytics page and each game's Analytics tab say which of their own properties get the
  plays, or how to add one. The figures there are still Vault's property's.

A measurement ID has to be GA4's (`G-` and 4–15 letters or digits); Universal Analytics ids (`UA-…`) stopped
collecting in 2023 and are refused. Studios own what their properties collect; Vault's privacy policy should say
that game pages may also send these events to the game's makers.

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
