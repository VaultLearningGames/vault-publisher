#!/usr/bin/env bash
# Which hostnames the website's static hosting answers at (docs/setup.md, "The website on Cloudflare static
# hosting"). The deploy workflow publishes the site to a Worker (vault-site-staging, vault-site) and never touches a
# hostname; an admin attaches each hostname once, here. Cloudflare then creates the hostname's DNS record and
# certificate itself, and removes them when the hostname is detached.
#
#   scripts/cloudflare-site-hosts.sh status HOST                    # DNS records, R2 domain, Worker, rules: only reads
#   scripts/cloudflare-site-hosts.sh attach HOST WORKER             # serve HOST from WORKER
#   scripts/cloudflare-site-hosts.sh attach HOST WORKER --replace-dns   # ... deleting HOST's A/AAAA/CNAME records first
#   scripts/cloudflare-site-hosts.sh detach HOST                    # stop serving HOST from its Worker
#   scripts/cloudflare-site-hosts.sh remove-r2 HOST                 # the R2-era setup of HOST: its custom domain on the
#                                                                   # site bucket, and its five "Site HOST: ..." rules
#   scripts/cloudflare-site-hosts.sh www-redirect www.DOMAIN        # one zone rule: https://www.DOMAIN/x → 301
#                                                                   # https://DOMAIN/x (www must also be attached, so
#                                                                   # that it has a DNS record and a certificate)
# attach, detach, remove-r2 and www-redirect print what they would do; add --apply to do it.
#
#   HOST    static.vaultlearninggames-staging.org | vaultlearninggames-staging.org | www.vaultlearninggames-staging.org
#           static.vaultlearninggames.org | vaultlearninggames.org | www.vaultlearninggames.org
#   WORKER  vault-site-staging (hosts of vaultlearninggames-staging.org) | vault-site (hosts of vaultlearninggames.org)
#
# IMPORTANT, in this order for a hostname that was on R2: remove-r2, then attach. Its "directory index" rule rewrites
# /wake/ to /wake/index.html before the Worker sees it, which the Worker answers with a redirect to /wake/: a loop.
#
# CLOUDFLARE_API_TOKEN needs: Account → Workers Scripts: Edit; on the host's zone → Workers Routes: Edit, DNS: Edit
# (only for --replace-dns), Single Redirect: Edit (www-redirect), and for remove-r2 also Account → Workers R2
# Storage: Edit and the three rule permissions of scripts/cloudflare-site-rules.sh. This is an admin's token, never
# the deploy's. Needs curl and jq.
set -euo pipefail

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
cmd="${1:-}"; host="${2:-}"; shift $(( $# < 2 ? $# : 2 ))
worker=""; apply=false; replace_dns=false
for a in "$@"; do
  case "$a" in --apply) apply=true ;; --replace-dns) replace_dns=true ;; --*) echo "unknown option $a" >&2; exit 2 ;; *) worker="$a" ;; esac
done
case "$cmd" in status|attach|detach|remove-r2|www-redirect) ;; *) usage ;; esac
case "$host" in *[!a-z0-9.-]*|'') echo "bad host '$host'" >&2; exit 2 ;; esac
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"

account="${CLOUDFLARE_ACCOUNT_ID:-53908534e6b25253c988befce2f9ad21}"
api=https://api.cloudflare.com/client/v4
cf() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }
# A call that changes something: printed, and made only with --apply. Fails on anything but success.
change() { # change DESCRIPTION curl-args...
  local desc="$1"; shift
  if ! $apply; then echo "would: $desc"; return 0; fi
  # Success is {"success": true}, or (detaching a hostname) a 2xx answer with no body.
  local out code; out=$(cf -w '\n%{http_code}' "$@"); code="${out##*$'\n'}"; out="${out%$'\n'*}"
  if [ -n "$out" ]; then echo "$out" | jq -e '.success == true' >/dev/null 2>&1; else [ "${code:0:1}" = 2 ]; fi \
    || { echo "FAILED ($code): $desc" >&2; echo "  request: $*" >&2; echo "  answer:  $(echo "$out" | jq -c '{errors, messages}' 2>/dev/null || echo "$out")" >&2; exit 1; }
  echo "done: $desc"
}

# The two systems never share a hostname: each zone has its Worker and its site bucket, and nothing else is touched.
zone_name=$(echo "$host" | awk -F. '{print $(NF-1)"."$NF}')
case "$zone_name" in
  vaultlearninggames-staging.org) zone_worker=vault-site-staging; bucket=site-vaultlearninggames-staging ;;
  vaultlearninggames.org) zone_worker=vault-site; bucket=site-vaultlearninggames ;;
  *) echo "$host is not a Vault hostname" >&2; exit 2 ;;
esac
case "${host%."$zone_name"}" in cdn|builds|portal|*.cdn|*.builds|*.portal) echo "$host is not a website hostname" >&2; exit 2 ;; esac
zone=$(cf "$api/zones?name=$zone_name" | jq -r '.result[0].id // empty')
[ -n "$zone" ] || { echo "no zone $zone_name for this token" >&2; exit 1; }

dns_records() { cf "$api/zones/$zone/dns_records?name=$host&per_page=100" | jq -c '[.result[]? | select(.type == "A" or .type == "AAAA" or .type == "CNAME")]'; }
worker_domain() { cf "$api/accounts/$account/workers/domains?hostname=$host" | jq -c '.result // [] | map(select(.hostname == "'"$host"'")) | .[0] // empty'; }
r2_domain() { cf "$api/accounts/$account/r2/buckets/$bucket/domains/custom" | jq -c '.result.domains // [] | map(select(.domain == "'"$host"'")) | .[0] // empty'; }
# The five rules scripts/cloudflare-site-rules.sh made for a hostname on R2. Other rules named after the hostname
# (www's redirect to the apex) are not R2's and stay.
site_rules() {
  for phase in http_request_dynamic_redirect http_request_transform http_response_headers_transform http_request_cache_settings; do
    cf "$api/zones/$zone/rulesets/phases/$phase/entrypoint" | jq -r --arg p "Site $host: " '.result.rules // [] | .[] | .description
      | select(. == $p + "keys-to-the-vault.pdf short address" or . == $p + "add the trailing slash" or . == $p + "directory index"
          or . == $p + "X-Robots-Tag" or . == $p + "cache as the objects say")'
  done
}

case "$cmd" in
status)
  echo "DNS records of $host:"; dns_records | jq -r '.[] | "  \(.type) \(.content) proxied=\(.proxied)\(if .meta.r2_bucket then " (R2 bucket \(.meta.r2_bucket))" elif .meta.origin_worker_id then " (Worker)" else "" end)"'
  d=$(worker_domain); echo "Worker: $([ -n "$d" ] && echo "$d" | jq -r '"\(.service) (domain id \(.id))"' || echo none)"
  r=$(r2_domain); echo "R2 custom domain on $bucket: $([ -n "$r" ] && echo "$r" | jq -r '"yes, enabled=\(.enabled)"' || echo no)"
  echo "R2-era rules:"; site_rules | sed 's/^/  /'
  [ "$host" != "www.$zone_name" ] || echo "Redirect to the apex: $(cf "$api/zones/$zone/rulesets/phases/http_request_dynamic_redirect/entrypoint" | jq -r --arg d "Site $host: redirect to ${host#www.}" '[.result.rules // [] | .[] | select(.description == $d)] | if length > 0 then "yes" else "no" end')"
  ;;

www-redirect)
  case "$host" in "www.$zone_name") ;; *) echo "www-redirect is for www.$zone_name" >&2; exit 2 ;; esac
  desc="Site $host: redirect to $zone_name"
  entry=$(cf "$api/zones/$zone/rulesets/phases/http_request_dynamic_redirect/entrypoint")
  ruleset=$(echo "$entry" | jq -r 'if .success then .result.id else empty end')
  [ -n "$ruleset" ] || { echo "can't read the zone's redirect rules: $(echo "$entry" | jq -c .errors)" >&2; exit 1; }
  if echo "$entry" | jq -e --arg d "$desc" '.result.rules // [] | any(.description == $d)' >/dev/null; then echo "already there: $desc"; exit 0; fi
  change "add the rule \"$desc\"" -X POST "$api/zones/$zone/rulesets/$ruleset/rules" --data "$(jq -nc --arg d "$desc" --arg h "$host" --arg to "https://$zone_name" '{
    description: $d, enabled: true, expression: "(http.host eq \"\($h)\")", action: "redirect",
    action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: "concat(\"\($to)\", http.request.uri.path)" } } } }')"
  ;;

attach)
  [ "$worker" = "$zone_worker" ] || { echo "hosts of $zone_name belong to the Worker $zone_worker (got '${worker:-nothing}')" >&2; exit 2; }
  cf "$api/accounts/$account/workers/scripts/$worker/settings" | jq -e '.success == true' >/dev/null || { echo "no Worker $worker yet (or no permission to read it): deploy the site once first" >&2; exit 1; }
  [ -z "$(r2_domain)" ] || { echo "$host is still an R2 custom domain of $bucket: run remove-r2 first" >&2; exit 1; }
  [ -z "$(site_rules)" ] || { echo "$host still has R2-era rules (they make the Worker loop): run remove-r2 first" >&2; site_rules | sed 's/^/  /' >&2; exit 1; }
  d=$(worker_domain)
  if [ -n "$d" ] && [ "$(echo "$d" | jq -r .service)" = "$worker" ]; then echo "$host is already attached to $worker"; exit 0; fi
  records=$(dns_records | jq -c '[.[] | select(.meta.origin_worker_id | not)]')
  if [ "$(echo "$records" | jq length)" -gt 0 ]; then
    echo "$host has DNS records (keep these lines: they are the rollback):"
    echo "$records" | jq -c '.[] | {type, name, content, proxied, ttl}' | sed 's/^/  /'
    $replace_dns || { echo "Cloudflare refuses to attach a hostname that has records: add --replace-dns to delete them first" >&2; exit 1; }
    for id in $(echo "$records" | jq -r '.[].id'); do
      change "delete DNS record $(echo "$records" | jq -r --arg id "$id" '.[] | select(.id == $id) | "\(.type) \(.name) \(.content)"')" -X DELETE "$api/zones/$zone/dns_records/$id"
    done
  fi
  change "attach $host to the Worker $worker" -X PUT "$api/accounts/$account/workers/domains" \
    --data "$(jq -nc --arg h "$host" --arg s "$worker" --arg z "$zone" '{hostname: $h, service: $s, zone_id: $z, environment: "production"}')"
  $apply && echo "The certificate takes up to a few minutes. Then: node scripts/site-check.ts https://$host --build site/public"
  ;;

detach)
  d=$(worker_domain)
  [ -n "$d" ] || { echo "$host is not attached to a Worker"; exit 0; }
  change "detach $host from the Worker $(echo "$d" | jq -r .service) (its DNS record goes with it)" -X DELETE "$api/accounts/$account/workers/domains/$(echo "$d" | jq -r .id)"
  ;;

remove-r2)
  # Rules first, the bucket's domain last: its DNS record goes with it, and the attach that follows should come
  # within seconds (resolvers remember a missing address).
  rules=$(site_rules)
  if [ -z "$rules" ]; then echo "not there: the five rules \"Site $host: ...\""
  elif $apply; then "$(dirname "$0")/cloudflare-site-rules.sh" "$host" - --delete
  else echo "$rules" | sed 's/^/would: delete the rule "/; s/$/"/'; fi
  if [ -n "$(r2_domain)" ]; then
    change "remove the custom domain $host from the bucket $bucket (its DNS record goes with it; the bucket and its files stay)" -X DELETE "$api/accounts/$account/r2/buckets/$bucket/domains/custom/$host"
  else echo "not there: custom domain $host on $bucket"; fi
  ;;
esac
$apply || [ "$cmd" = status ] || echo "(nothing changed: add --apply)"
