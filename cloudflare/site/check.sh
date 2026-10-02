#!/usr/bin/env bash
# Serve a build of the site (npm run site:build) with the real hosting runtime on this machine (`wrangler dev`:
# Workers Static Assets, the build's _headers and _redirects) and check what a visitor would get, for every file and
# address of the build: scripts/site-check.ts. Nothing is deployed and no Cloudflare account is used.
#   npm ci --prefix cloudflare/site      # once: wrangler, at the version in cloudflare/site/package-lock.json
#   cloudflare/site/check.sh [port]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../.." && pwd); public="$root/site/public"; port="${1:-8941}"
wrangler="$here/node_modules/.bin/wrangler"
[ -x "$wrangler" ] || { echo "no wrangler: run npm ci --prefix cloudflare/site first" >&2; exit 2; }
[ -f "$public/_headers" ] && [ -f "$public/_redirects" ] || { echo "no build: run npm run site:build first" >&2; exit 2; }
log=$(mktemp)
(cd "$here" && WRANGLER_SEND_METRICS=false exec "$wrangler" dev --port "$port" --ip 127.0.0.1 --show-interactive-dev-session=false) >"$log" 2>&1 &
pid=$!; trap 'kill $pid 2>/dev/null || true; rm -f "$log"; rm -rf "$here/.wrangler"' EXIT
t="http://127.0.0.1:$port"
for _ in $(seq 90); do curl -s -o /dev/null "$t/" && break; kill -0 $pid 2>/dev/null || { cat "$log" >&2; exit 1; }; sleep 1; done
curl -s -o /dev/null "$t/" || { echo "wrangler dev did not start:" >&2; cat "$log" >&2; exit 1; }

fail=0
(cd "$root" && node scripts/site-check.ts "$t" --build "$public") || fail=1

# X-Robots-Tag by hostname: noindex everywhere (checked above for this address), except the one hostname the build
# was made to be indexed at (SITE_INDEX_HOST, production only).
index_host=$(sed -n 's|^https://\([a-z0-9.-]*\)/\*$|\1|p' "$public/_headers" | head -1)
robots() { curl -s -o /dev/null -D - -H "Host: $1" "$t/" | tr -d '\r' | sed -n 's/^[Xx]-[Rr]obots-[Tt]ag: //p'; }
want() { if [ "$(robots "$1")" = "$2" ]; then echo "  ok          X-Robots-Tag: $2 at $1"; else echo "  FAIL X-Robots-Tag at $1: $(robots "$1"), expected $2"; fail=1; fi; }
if [ -n "$index_host" ]; then
  want "$index_host" all; want "www.$index_host" noindex; want "static.$index_host" noindex
else
  want vaultlearninggames.org noindex
fi
exit $fail
