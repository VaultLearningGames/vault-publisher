#!/usr/bin/env bash
# The Cloudflare zone rules that make an R2 bucket's custom domain behave like the website's old nginx
# (docs/setup.md, "The website on R2"). Five rules, each scoped to exactly one hostname:
#
#   1. redirect   /s/keys-to-the-vault.pdf            → 301 /files/keys-to-the-vault.pdf   (Squarespace's old address)
#   2. redirect   /lakeland, /game-cards?offset=20    → 301 the same address with "/"       (a path with no "." and no
#                                                       trailing "/"; the query string is kept)
#   3. rewrite    /lakeland/                          → /lakeland/index.html                (R2 has no directory index)
#   4. header     X-Robots-Tag: <robots>              on every response
#   5. cache      edge and browser lifetimes follow the object's Cache-Control (src/site-sync.ts); without this
#                 Cloudflare raises browser lifetimes below 4 hours to 4 hours and never caches pages at the edge
#
# Not covered, because no rule on the Free plan can do it: the site's own 404 page for a missing address (R2 answers
# 404 with Cloudflare's plain page). See docs/setup.md.
#
#   CLOUDFLARE_API_TOKEN=... scripts/cloudflare-site-rules.sh HOST ROBOTS            # prints what it would send
#   CLOUDFLARE_API_TOKEN=... scripts/cloudflare-site-rules.sh HOST ROBOTS --apply    # creates or updates the five rules
#   CLOUDFLARE_API_TOKEN=... scripts/cloudflare-site-rules.sh HOST - --delete        # removes them
#   HOST    r2-site.vaultlearninggames-staging.org | vaultlearninggames-staging.org | vaultlearninggames.org
#   ROBOTS  noindex (staging) | all (production)
#
# The token needs, on the host's zone: Zone → Single Redirect: Edit, Transform Rules: Edit, Cache Rules: Edit, and
# Zone: Read. Rules are found by their description ("Site HOST: ..."), added and changed one at a time through the
# single-rule endpoints, so no other rule in the zone is rewritten. Needs curl and jq.
set -euo pipefail

host="${1:?usage: cloudflare-site-rules.sh HOST ROBOTS [--apply|--delete]}"
robots="${2:?usage: cloudflare-site-rules.sh HOST ROBOTS [--apply|--delete]}"
mode="${3:---dry-run}"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
case "$mode" in --dry-run|--apply|--delete) ;; *) echo "unknown option $mode" >&2; exit 2 ;; esac
case "$host" in *[!a-z0-9.-]*|'') echo "bad host $host" >&2; exit 2 ;; esac
case "$robots" in noindex|all|-) ;; *) echo "ROBOTS is noindex or all" >&2; exit 2 ;; esac

api=https://api.cloudflare.com/client/v4
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }

# The zone is the host's last two labels (both Vault zones are second-level .org names).
zone_name=$(echo "$host" | awk -F. '{print $(NF-1)"."$NF}')
zone=$(cf "$api/zones?name=$zone_name" | jq -r '.result[0].id // empty')
[ -n "$zone" ] || { echo "no zone $zone_name for this token" >&2; exit 1; }

h="http.host eq \"$host\""
# phase | description | rule
rules=$(jq -n --arg h "$h" --arg host "$host" --arg robots "$robots" '[
  { phase: "http_request_dynamic_redirect", rule: {
      description: "Site \($host): keys-to-the-vault.pdf short address",
      expression: "(\($h) and http.request.uri.path eq \"/s/keys-to-the-vault.pdf\")",
      action: "redirect",
      action_parameters: { from_value: { status_code: 301, preserve_query_string: false,
        target_url: { expression: "concat(\"https://\", http.host, \"/files/keys-to-the-vault.pdf\")" } } } } },
  { phase: "http_request_dynamic_redirect", rule: {
      description: "Site \($host): add the trailing slash",
      expression: "(\($h) and not ends_with(http.request.uri.path, \"/\") and not http.request.uri.path contains \".\")",
      action: "redirect",
      action_parameters: { from_value: { status_code: 301, preserve_query_string: true,
        target_url: { expression: "concat(\"https://\", http.host, http.request.uri.path, \"/\")" } } } } },
  { phase: "http_request_transform", rule: {
      description: "Site \($host): directory index",
      expression: "(\($h) and ends_with(http.request.uri.path, \"/\"))",
      action: "rewrite",
      action_parameters: { uri: { path: { expression: "concat(http.request.uri.path, \"index.html\")" } } } } },
  { phase: "http_response_headers_transform", rule: {
      description: "Site \($host): X-Robots-Tag",
      expression: "(\($h))",
      action: "rewrite",
      action_parameters: { headers: { "X-Robots-Tag": { operation: "set", value: $robots } } } } },
  { phase: "http_request_cache_settings", rule: {
      description: "Site \($host): cache as the objects say",
      expression: "(\($h))",
      action: "set_cache_settings",
      action_parameters: { cache: true, edge_ttl: { mode: "respect_origin" }, browser_ttl: { mode: "respect_origin" } } } }
] | map(.rule.enabled = true)')

count=$(echo "$rules" | jq length)
for i in $(seq 0 $((count - 1))); do
  phase=$(echo "$rules" | jq -r ".[$i].phase")
  rule=$(echo "$rules" | jq -c ".[$i].rule")
  desc=$(echo "$rule" | jq -r .description)

  if [ "$mode" = --dry-run ]; then
    echo "# $phase"; echo "$rule" | jq .
    continue
  fi

  entry=$(cf "$api/zones/$zone/rulesets/phases/$phase/entrypoint")
  ruleset=$(echo "$entry" | jq -r 'if .success then .result.id else empty end')
  existing=$(echo "$entry" | jq -r --arg d "$desc" 'if .success then (.result.rules // [] | map(select(.description == $d)) | .[0].id // empty) else empty end')

  if [ "$mode" = --delete ]; then
    if [ -n "$existing" ]; then
      cf -X DELETE "$api/zones/$zone/rulesets/$ruleset/rules/$existing" | jq -e .success >/dev/null && echo "deleted: $desc"
    else echo "not there: $desc"; fi
    continue
  fi

  if [ -z "$ruleset" ]; then
    # The zone has no rules in this phase yet: create the phase's ruleset with this one rule. Any other failure
    # (a token without the permission) must not end here, or it would replace a ruleset we couldn't read.
    echo "$entry" | jq -e '.errors[0].code == 10003 or (.errors[0].message // "" | test("could not find|not found"; "i"))' >/dev/null \
      || { echo "can't read the $phase rules: $(echo "$entry" | jq -c .errors)" >&2; exit 1; }
    out=$(cf -X POST "$api/zones/$zone/rulesets" --data "$(jq -n --arg p "$phase" --argjson r "$rule" '{name: "default", kind: "zone", phase: $p, rules: [$r]}')")
  elif [ -n "$existing" ]; then
    out=$(cf -X PATCH "$api/zones/$zone/rulesets/$ruleset/rules/$existing" --data "$rule")
  else
    out=$(cf -X POST "$api/zones/$zone/rulesets/$ruleset/rules" --data "$rule")
  fi
  echo "$out" | jq -e .success >/dev/null || { echo "failed: $desc: $(echo "$out" | jq -c .errors)" >&2; exit 1; }
  echo "ok: $desc"
done
