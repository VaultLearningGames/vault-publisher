# Field Day games: moving off DoIT

Inventory as of 2026-09-24, from `fielddaylab/fielddaysite` (`play/` pages and their links), every repository in the
`fielddaylab` GitHub org (Unity version, branches, workflows), and probing the public DoIT URLs
(`https://fielddaylab.wisc.edu/play/NAME/...`).

**Goal of this stage:** every Field Day Unity web game builds with the new pipeline and has its current release branch
on the staging CDN (`https://cdn.vaultlearninggames-staging.org/fieldday/GAME/BRANCH/`); older JavaScript/HTML games
(and builds with no working pipeline) are copied from DoIT as-is.

## A. Unity WebGL games built in CI → move to the new pipeline

All of these currently build with game-ci and rsync to DoIT. Each gets the same change as the pilots: one shared
`unity-build.yml@v1` build, then independent `doit` (legacy, removed later) and `preview` (staging CDN) jobs.

| Game | Repo | Unity | Branch to put on staging | Latest commit on it | DoIT today | Site page | Status |
|---|---|---|---|---|---|---|---|
| Aqualab | `wake` | 2019.4.40f1 | `production` | 2026-02-13 | `/play/wake/ci/{production,develop,staging}` | `play/wake` | To do |
| Bloom | `bloom` | 2021.3.40f1 | `production` (live game) | 2025-01-15 | `/play/bloom/ci/{production,develop,staging}` | `play/bloom` | To do |
| Headlines | `headlines` | 2019.4.34f1 | `production` | 2025-01-15 | `/play/headlines/ci/{production,develop,main,staging}` | `play/headlines` | To do |
| Project Hercules (`project-hercules`) | `project-hercules` | 2022.3.47f1 | `production` | 2025-10-07 | `/play/astrogame/ci/{production,develop,staging}` | `play/projecthercules` | To do |
| The Legend of the Lost Emerald | `emerald` | 2019.4.26f1 | `production` | 2025-01-15 | `/play/emerald/ci/{production,master,staging}` | `play/emerald` | To do |
| Spacefab | `spacefab` | 2022.3.62f3 | `develop` (no release branch) | 2026-09-24 | `/play/spacefab/ci/develop` | — | Pilot ✅ ([#2](https://github.com/fielddaylab/spacefab/pull/2) open) |
| Airborne | `airborne-prototype` | 2022.3.62f3 | `develop` | 2026-09-22 | `/play/airborne-prototype/ci/develop` | — | Pilot ✅ ([#2](https://github.com/fielddaylab/airborne-prototype/pull/2) open) |
| AIS | `ais-prototype` | 2022.3.62f3 | `develop` | 2026-08-10 | `/play/ais-prototype/ci/develop` | — | Pilot ✅ ([#3](https://github.com/fielddaylab/ais-prototype/pull/3) open) |
| Spacefab prototype | `spacefab-prototype` | 2022.3.62f3 | `develop` | 2026-04-14 | `/play/spacefab-prototype/ci/develop` | — | To do |
| Astrolab prototype | `astrolab-prototype` | 2021.3.27f1 | `develop` | 2024-09-30 | `/play/astrolab-prototype/ci/develop` | — | To do |
| Art testbed | `art-testbed` | 2022.3.47f1 | `develop` | 2024-10-24 | `/play/art-testbed/ci/develop` | — | To do |

Notes:
- **Branch names:** Field Day's framework picks its build configuration from the branch name (`*preview*`/`milestone*`
  → PREVIEW, `*dev*`/`*proto*`/`feature/*` → DEVELOPMENT; `production` → PRODUCTION). Migration PR branches must be named
  so they build like `develop` (e.g. `dev-vault-staging`), and the PREVIEW config currently fails to compile in
  spacefab/ais-prototype (`RenderMgr.cs`), which may also affect `production` builds of newer games.
- **Headlines** only builds on pushes to `develop` today, although DoIT has a `production` build; its workflow needs a
  `production` trigger (or a manual run) to put `production` on staging.
- **Unity licence seats:** migrations must build one repo at a time (concurrent builds exhausted seats in the pilots).
- **CDN names follow DoIT** (`/play/NAME/ci/` → `STUDIO/NAME/BRANCH/`), not repo names; see the rename list below.

## A2. The Yard (package)

The Yard's ten games ship together: `fielddaylab/yardgames` is the site, and each game is a git submodule under `game/`
(`cycle` → carbon, nitrogen, water; `bacteria`, `waves`, `wind`, `magnetism`, `balloon`, `earthquake`, `model`,
`crystal`). Today it's served from theyardgames.org, not DoIT. It publishes from `yardgames` (committed files, checked out
with submodules) as one game, `yardgames`, with each game reachable at `…/fieldday/yardgames/<game>/`. Production has a
single, replaceable version (no version folders).

## B. Copy from DoIT as-is (no working build pipeline, or older JS/HTML)

| Game | DoIT source | Repo | Kind | Proposed staging name |
|---|---|---|---|---|
| Jo Wilder and the Capitol Case | `/play/jowilder/game/` | `jowilder` | JavaScript | `fieldday/jowilder/doit/` |
| Lakeland | `/play/lakeland/game/` | `lakeland` | JavaScript | `fieldday/lakeland/doit/` |
| Lost at the Forever Mine | `/play/forevermine/game/` | `forevermine` | JavaScript | `fieldday/forevermine/doit/` |
| Plants-o-Plenty v2 | `/play/plants-o-plenty-v2/ci/main/` | `plants-o-plenty-v2` | JavaScript (webpack, CI → DoIT) | `fieldday/plants-o-plenty-v2/main/` |
| ThermoVR (desktop) | `/play/thermovr/ci/desktop/` | `thermovr` | Unity 2021.3 WebGL, built by hand (no workflow) | `fieldday/thermovr/desktop/` |
| Shadowspect (MIT Education Arcade) | `/play/partner/shadowspect/ci/main/` | `shadowspect` (Unity 2018.4) | External studio | `mit-education-arcade/shadowspect/main/` |
| Transformation Quest (University of Calgary) | `/play/transformation-quest/ci/develop/` | `transformation-quest` | External studio, JavaScript | `ucalgary/transformation-quest/develop/` |

Copying needs the DoIT file tree (directory listings aren't public), so it runs as a one-time admin job with VPN access:
rsync each folder from DoIT, then upload it to staging under the game's name. These games have no repository claim
on the publisher yet, so the upload goes through an admin-only path.

## C. Out of scope for the web CDN

| Title | Why |
|---|---|
| Waddle (`Waddle`), On the Ice: Hatched (`pennycookvr`), On the Ice: Weather Station (`weather-station`) | VR; not hosted on the CDN. |
| Discover IceCube (`ICECUBEVR`, `DiscoverIceCube`) | VR; no web build or CI. |
| Zavala prototype (`zavala-prototype`), Mashopolis, Censio (`censio-stack`, `censio-match`, `censio-slide`) | Not moving. |
| Atom Touch (`atomtouch`) | Mobile app (App Store / Google Play). |
| Lost Emerald simulations (carbon-sim, currents, food-webs, force-fields, living-cell, plant-growth, plate-tectonics, rock-sim, water-sim) | Link to PBS Wisconsin. |
| The Station: Maine | Links to mmsa.org. |
| Alien Gardener, Journalism (old) | No play link on the site. |

## Repo names

Done 2026-09-25: `journalism-unity` → `headlines`, `lost_emerald` → `emerald`, `jo_wilder` → `jowilder`,
`the-yard` → `yardgames`. Every repo's name now matches its CDN name (`project-hercules` included; DoIT's old
`astrogame` path will redirect to it). Old names redirect on GitHub, and the publisher matches repos by numeric id.

## Decisions

- **Studio slug is `fieldday`** (the GitHub org stays `fielddaylab`): `…/fieldday/GAME/BRANCH/`.
- **The Yard has one production version, no version folders:** `…/fieldday/yardgames/wind/`, `…/magnetism/`, etc.
  (a "replace in place" release allowed only for `yardgames`).
