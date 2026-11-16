# Analytics.3b — the-legend-of-the-lost-emerald: page_referrer kept, channel from the shared snippet

Run: 2026-11-16T20:23:38.866Z
Base: origin/staging 1cdfdb51af2db4faa9056a9c3568408fa7cfdc7a (HEAD 1cdfdb51af2db4faa9056a9c3568408fa7cfdc7a)
Shared snippet: src/cdn/vault-channel.js
Lost Emerald's override: none (it receives the shared template)
Lost Emerald's built inner frame: not built in this worktree

## The shared snippet's precondition

* `pbswi` → `pbswisconsineducation.org`: **yes**
* a `vault` default inside the player: **yes**
* reports the channel itself (not resolution only): **yes**

## The shared marker block in the built wrapper

Verdict: **missing** — the override (looked in src/cdn/games/fieldday/lostemerald/iframe.html, src/cdn/overrides/fieldday/lostemerald/iframe.html, src/cdn/fieldday/lostemerald/iframe.html, cdn/fieldday/lostemerald/iframe.html) could not be read

## What this card does to Lost Emerald's layer

Nothing decided: there is no Lost Emerald wrapper in this worktree to decide about.

## What one load reports (stubbed gtag/ga)

Loaded: a RECONSTRUCTION of the inner frame — `src/cdn/vault-channel.js`'s own text between the markers, the
caller the shared template provides, and Lost Emerald's `page_referrer` script before it. The channel logic in
it is the snippet's own text, so what it reports is what the snippet reports; the surrounding template is
**Analytics.2: include vault-channel.js in both CDN wrapper layers**'s and only the built file can confirm it. Re-run with `--html <built iframe.html>` once it exists.

| Case | Query | Channel | Expected | Times | page_referrer | Page views | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a partner short key | `?vault_ch=pbswi` | pbswisconsineducation.org | pbswisconsineducation.org | 1 | (none) | 0 | pass |
| framed with no parameters | `?(none)` | vault | vault | 1 | (none) | 0 | pass |
| a source origin, page_referrer kept | `?vault_src=https%3A%2F%2Fwww.pbswisconsineducation.org%2Flost-emerald%2F` | pbswisconsineducation.org | pbswisconsineducation.org | 1 | https://www.pbswisconsineducation.org/lost-emerald/ | 0 | pass |

Every case reported the expected channel exactly once, with the page_referrer still set.

## Not fully checkable yet

Lost Emerald has no wrapper in this worktree (looked in `src/cdn/games/fieldday/lostemerald/index.html`, `src/cdn/overrides/fieldday/lostemerald/index.html`, `src/cdn/fieldday/lostemerald/index.html`, `cdn/fieldday/lostemerald/index.html`, `src/cdn/games/fieldday/lostemerald/iframe.html`, `src/cdn/overrides/fieldday/lostemerald/iframe.html`, `src/cdn/fieldday/lostemerald/iframe.html`, `cdn/fieldday/lostemerald/iframe.html`). The template that emits the `VAULT_CHANNEL_LOGIC_START` block is written by **Analytics.2: include vault-channel.js in both CDN wrapper layers**, which has not landed on this branch, and this game has no per-game override of its own here: there is nothing to edit, and the acceptance behaviour is verified against the built output and recorded in `docs/verification/analytics-3b-lost-emerald.md`.

Neither the shared snippet, the shared template nor Jo Wilder's wrapper was touched to work around this.

