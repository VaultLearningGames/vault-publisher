# Analytics.4b — the snippet in the DEPLOYED staging CDN artifacts

CDN: https://cdn.vaultlearninggames-staging.org
Game list: https://portal.vaultlearninggames-staging.org/v1/catalog (23 CDN game(s))
Run: 2026-11-17T06:13:13.866Z
Probe: `?vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x`

## Step 1 — the staging release

* release id: none (`docs/verification/analytics-4a-staging-release.md` records a blocker, not a release id)
* served artifact: **no-release** — no staging release id exists to verify against: **Analytics.4a: gate on sibling work in origin/staging and cut the staging release** has not produced one, and this card does not cut, deploy or guess one

## STOP — this card's step 1 is not satisfied

no staging release id exists to verify against: **Analytics.4a: gate on sibling work in origin/staging and cut the staging release** has not produced one, and this card does not cut, deploy or guess one

Blocker against "Analytics.4a: gate on sibling work in origin/staging and cut the staging release". The layers below were fetched with `--observe` and are an OBSERVATION of what the staging CDN serves today — they are NOT evidence about a release, because there is no release id to be evidence about. Nothing was cut, deployed, patched or promoted.

## Step 2 — the three games, chosen from the publisher's CDN game list

* the-legend-of-the-lost-emerald: the game the card names (`the-legend-of-the-lost-emerald`), first of 1 in list order whose outer page is served (`fieldday/emerald`)
* antibiotic-resistance: one of The Yard's games (a `yardgames` path segment in the publisher's list), first of 10 in list order whose outer page is served (`fieldday/yardgames/bacteria`)
* bloom-the-saga-of-the-poop-economy: one further ordinary CDN game (neither of the above), first of 12 in list order whose outer page is served (`fieldday/bloom`)

Stepped past (no deployed artifact to grep; each is a blocker below all the same):

* `atom-touch` (https://cdn.vaultlearninggames-staging.org/fieldday/atom-touch/) — its outer page answers HTTP 404: no deployed artifact to grep
* `beats-empire` (https://cdn.vaultlearninggames-staging.org/tc-columbia/beats-empire/) — its outer page answers HTTP 404: no deployed artifact to grep

## Steps 3 and 4 — every served layer, grepped

| Game | Layer | Full URL | HTTP | VAULT_CHANNEL_LOGIC_START | vaultResolveChannel | alias `pbswi`→`pbswisconsineducation.org` | Params forwarded identically |
| --- | --- | --- | --- | --- | --- | --- | --- |
| the-legend-of-the-lost-emerald | index.html | https://cdn.vaultlearninggames-staging.org/fieldday/emerald/index.html?vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x | 200 | 0 | 0 | 0 | single-layer: only one layer was served, so nothing was forwarded anywhere |
| antibiotic-resistance | index.html | https://cdn.vaultlearninggames-staging.org/fieldday/yardgames/bacteria/index.html?vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x | 200 | 0 | 0 | 0 | dropped: index.html → iframe.html drops `vault_ch`, `vault_src`, `utm_source` (it forwards (none)) |
|  | iframe.html | https://cdn.vaultlearninggames-staging.org/fieldday/yardgames/bacteria/iframe.html | 200 | 0 | 0 | 0 |  |
| bloom-the-saga-of-the-poop-economy | index.html | https://cdn.vaultlearninggames-staging.org/fieldday/bloom/index.html?vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x | 200 | 0 | 0 | 0 | single-layer: only one layer was served, so nothing was forwarded anywhere |

## Blockers against "Analytics: shared vault_ch reader for all 23 CDN games"

* **the-legend-of-the-lost-emerald** (https://cdn.vaultlearninggames-staging.org/fieldday/emerald/): index.html (https://cdn.vaultlearninggames-staging.org/fieldday/emerald/index.html?vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x) is served but carries none of `VAULT_CHANNEL_LOGIC_START`, `vaultResolveChannel`, the alias table (`pbswi` → `pbswisconsineducation.org`)
* **antibiotic-resistance** (https://cdn.vaultlearninggames-staging.org/fieldday/yardgames/bacteria/): index.html (https://cdn.vaultlearninggames-staging.org/fieldday/yardgames/bacteria/index.html?vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x) is served but carries none of `VAULT_CHANNEL_LOGIC_START`, `vaultResolveChannel`, the alias table (`pbswi` → `pbswisconsineducation.org`); iframe.html (https://cdn.vaultlearninggames-staging.org/fieldday/yardgames/bacteria/iframe.html) is served but carries none of `VAULT_CHANNEL_LOGIC_START`, `vaultResolveChannel`, the alias table (`pbswi` → `pbswisconsineducation.org`); index.html → iframe.html drops `vault_ch`, `vault_src`, `utm_source` (it forwards (none))
* **bloom-the-saga-of-the-poop-economy** (https://cdn.vaultlearninggames-staging.org/fieldday/bloom/): index.html (https://cdn.vaultlearninggames-staging.org/fieldday/bloom/index.html?vault_ch=pbswi&vault_src=https%3A%2F%2Fexample.org&utm_source=x) is served but carries none of `VAULT_CHANNEL_LOGIC_START`, `vaultResolveChannel`, the alias table (`pbswi` → `pbswisconsineducation.org`)
* **atom-touch** (https://cdn.vaultlearninggames-staging.org/fieldday/atom-touch/): its outer page answers HTTP 404: no deployed artifact to grep
* **beats-empire** (https://cdn.vaultlearninggames-staging.org/tc-columbia/beats-empire/): its outer page answers HTTP 404: no deployed artifact to grep

Not hand-patched: the deployed wrapper layers are that card's to ship. No template, snippet, Unity source or build output was touched here, and nothing was promoted to production.

