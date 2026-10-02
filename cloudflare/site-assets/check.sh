#!/usr/bin/env bash
# Serve a build of the site (npm run site:build) as Workers Static Assets on this machine and check what a visitor
# would get: the 404 page with status 404 at any depth, the directory index, the redirects. Nothing is deployed and
# no Cloudflare account is used. Needs curl, and npx (it fetches wrangler, about 200 MB; or WRANGLER=path/to/wrangler).
#   cloudflare/site-assets/check.sh [port]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); public="$here/../../site/public"; port="${1:-8941}"
[ -f "$public/404.html" ] || { echo "no build: run npm run site:build first" >&2; exit 2; }
sed 's/ROBOTS/noindex/' "$here/_headers" > "$public/_headers"; cp "$here/_redirects" "$public/_redirects"
WRANGLER_SEND_METRICS=false ${WRANGLER:-npx --yes wrangler@4} dev -c "$here/wrangler.jsonc" --port "$port" --ip 127.0.0.1 >/dev/null 2>&1 &
pid=$!; trap 'kill $pid 2>/dev/null; rm -f "$public/_headers" "$public/_redirects"; rm -rf "$here/.wrangler"' EXIT
for _ in $(seq 60); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 1; done
t="http://127.0.0.1:$port"; fail=0
want() { # want STATUS PATH [text in the body | Location]
  local got; got=$(curl -s -o /tmp/site-assets-check.$$ -w '%{http_code} %{redirect_url}' "$t$2")
  if [ "${got%% *}" != "$1" ] || { [ -n "${3:-}" ] && ! { grep -q "$3" /tmp/site-assets-check.$$ || [ "${got#* }" = "$t$3" ]; }; }; then echo "FAIL $2: $got"; fail=1; else echo "ok   $2: $got"; fi
  rm -f /tmp/site-assets-check.$$
}
want 200 /
want 404 /nope/ 'Nothing on this channel'
want 404 /a/b/c/ 'Nothing on this channel'
want 404 /a/b/c 'Nothing on this channel'
want 307 /lakeland /lakeland/
want 200 /lakeland/
want 307 '/game-cards?offset=20' '/game-cards/?offset=20'
want 301 /s/keys-to-the-vault.pdf /files/keys-to-the-vault.pdf
want 404 /_headers
# Known difference from R2: a "+" in a folder name is redirected to "%2B" (the page is then served).
want 307 '/game-cards/category/Grades+9-12/' '/game-cards/category/Grades%2B9-12/'
want 200 '/game-cards/category/Grades%2B9-12/'
curl -sI "$t/nope/" | grep -qi '^x-robots-tag: noindex' && echo "ok   X-Robots-Tag on the 404" || { echo "FAIL no X-Robots-Tag on the 404"; fail=1; }
exit $fail
