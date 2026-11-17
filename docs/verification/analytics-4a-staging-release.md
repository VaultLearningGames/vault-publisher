# Blocked: no staging release cut from `origin/staging`

`origin/staging` = 3a4fbb7ea3eb5c02ae9ba7bdd44705132559e2d2

Missing from the gate ref:

* **the template inclusion (outer and inner CDN wrapper templates)** — no outer CDN wrapper template at origin/staging (looked in `src/cdn/templates/index.html`, `src/cdn/templates/wrapper/index.html`, `src/cdn/template/index.html`, `src/cdn/wrapper/index.html`, `src/cdn/index.html`); no inner CDN wrapper template at origin/staging (looked in `src/cdn/templates/iframe.html`, `src/cdn/templates/wrapper/iframe.html`, `src/cdn/template/iframe.html`, `src/cdn/wrapper/iframe.html`, `src/cdn/iframe.html`)
  * owner: **Analytics: shared vault_ch reader for all 23 CDN games**
  * looked in: `src/cdn/templates/index.html`, `src/cdn/templates/wrapper/index.html`, `src/cdn/template/index.html`, `src/cdn/wrapper/index.html`, `src/cdn/index.html`, `src/cdn/templates/iframe.html`, `src/cdn/templates/wrapper/iframe.html`, `src/cdn/template/iframe.html`, `src/cdn/wrapper/iframe.html`, `src/cdn/iframe.html`, `src/cdn/templates/vault-channel-include.html`
* **the Jo Wilder / Lost Emerald reconciliation** — jo-wilder's wrapper is not at origin/staging (looked in `fieldday/jowilder/iframe.html`, `src/cdn/games/fieldday/jowilder/iframe.html`, `src/cdn/overrides/fieldday/jowilder/iframe.html`, `src/cdn/fieldday/jowilder/iframe.html`, `cdn/fieldday/jowilder/iframe.html`, `src/cdn/games/fieldday/jowilder/index.html`, `src/cdn/overrides/fieldday/jowilder/index.html`, `src/cdn/fieldday/jowilder/index.html`, `cdn/fieldday/jowilder/index.html`); the-legend-of-the-lost-emerald's wrapper is not at origin/staging (looked in `fieldday/lostemerald/iframe.html`, `src/cdn/games/fieldday/lostemerald/iframe.html`, `src/cdn/overrides/fieldday/lostemerald/iframe.html`, `src/cdn/fieldday/lostemerald/iframe.html`, `cdn/fieldday/lostemerald/iframe.html`, `src/cdn/games/fieldday/lostemerald/index.html`, `src/cdn/overrides/fieldday/lostemerald/index.html`, `src/cdn/fieldday/lostemerald/index.html`, `cdn/fieldday/lostemerald/index.html`)
  * owner: **Analytics: reconcile Jo Wilder and Lost Emerald wrappers with the shared snippet**
  * looked in: `fieldday/jowilder/iframe.html`, `src/cdn/games/fieldday/jowilder/iframe.html`, `src/cdn/overrides/fieldday/jowilder/iframe.html`, `src/cdn/fieldday/jowilder/iframe.html`, `cdn/fieldday/jowilder/iframe.html`, `src/cdn/games/fieldday/jowilder/index.html`, `src/cdn/overrides/fieldday/jowilder/index.html`, `src/cdn/fieldday/jowilder/index.html`, `cdn/fieldday/jowilder/index.html`, `fieldday/lostemerald/iframe.html`, `src/cdn/games/fieldday/lostemerald/iframe.html`, `src/cdn/overrides/fieldday/lostemerald/iframe.html`, `src/cdn/fieldday/lostemerald/iframe.html`, `cdn/fieldday/lostemerald/iframe.html`, `src/cdn/games/fieldday/lostemerald/index.html`, `src/cdn/overrides/fieldday/lostemerald/index.html`, `src/cdn/fieldday/lostemerald/index.html`, `cdn/fieldday/lostemerald/index.html`

## Gate checks on `origin/staging` 3a4fbb7ea3eb5c02ae9ba7bdd44705132559e2d2

* ✅ **the shared snippet** — `src/cdn/vault-channel.js`: 1 VAULT_CHANNEL_LOGIC_START line(s), with a closing VAULT_CHANNEL_LOGIC_END
  * `src/cdn/vault-channel.js`: 1
* ❌ **the template inclusion (outer and inner CDN wrapper templates)** — no outer CDN wrapper template at origin/staging (looked in `src/cdn/templates/index.html`, `src/cdn/templates/wrapper/index.html`, `src/cdn/template/index.html`, `src/cdn/wrapper/index.html`, `src/cdn/index.html`); no inner CDN wrapper template at origin/staging (looked in `src/cdn/templates/iframe.html`, `src/cdn/templates/wrapper/iframe.html`, `src/cdn/template/iframe.html`, `src/cdn/wrapper/iframe.html`, `src/cdn/iframe.html`)
* ❌ **the Jo Wilder / Lost Emerald reconciliation** — jo-wilder's wrapper is not at origin/staging (looked in `fieldday/jowilder/iframe.html`, `src/cdn/games/fieldday/jowilder/iframe.html`, `src/cdn/overrides/fieldday/jowilder/iframe.html`, `src/cdn/fieldday/jowilder/iframe.html`, `cdn/fieldday/jowilder/iframe.html`, `src/cdn/games/fieldday/jowilder/index.html`, `src/cdn/overrides/fieldday/jowilder/index.html`, `src/cdn/fieldday/jowilder/index.html`, `cdn/fieldday/jowilder/index.html`); the-legend-of-the-lost-emerald's wrapper is not at origin/staging (looked in `fieldday/lostemerald/iframe.html`, `src/cdn/games/fieldday/lostemerald/iframe.html`, `src/cdn/overrides/fieldday/lostemerald/iframe.html`, `src/cdn/fieldday/lostemerald/iframe.html`, `cdn/fieldday/lostemerald/iframe.html`, `src/cdn/games/fieldday/lostemerald/index.html`, `src/cdn/overrides/fieldday/lostemerald/index.html`, `src/cdn/fieldday/lostemerald/index.html`, `cdn/fieldday/lostemerald/index.html`)

## Commands run

```sh
git fetch origin --prune
git rev-parse origin/staging
git ls-tree -r --name-only 3a4fbb7ea3eb5c02ae9ba7bdd44705132559e2d2
git grep -c VAULT_CHANNEL_LOGIC_START 3a4fbb7ea3eb5c02ae9ba7bdd44705132559e2d2
```

No release was cut, nothing was promoted, and no template, snippet or wrapper was patched: the missing artifacts belong to the sibling cards named above.

