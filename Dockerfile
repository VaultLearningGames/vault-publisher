# syntax=docker/dockerfile:1
# vault-publisher on Cloud Run: Node runs the TypeScript directly (type stripping), and
# Litestream keeps the SQLite database replicated to a GCS bucket. The image also carries the website's source
# (VaultLearningGames/vault-site at the commit pinned in vault-site.ref, without its .git or portal/ submodule) and
# Hugo: the portal renders listing and blog previews with them (src/portal/site-preview.ts, src/site-dir.ts).
# The old in-repo site/ is not used (deprecated; see site/README.md).
FROM litestream/litestream:0.3.13 AS litestream

# vault-site at the pinned ref: VAULT_SITE_REF when given, else the first non-comment line of vault-site.ref (a commit
# SHA, preferably all 40 characters, or a tag). A private repository needs a token with read access to it, passed as
# the build secret gh_token (docker build --secret id=gh_token,env=GH_TOKEN): it is sent as an HTTP header for these
# commands only, never written to a layer, the remote URL or git's config, and this stage is not part of the image.
FROM alpine/git AS site
ARG VAULT_SITE_REPO=https://github.com/VaultLearningGames/vault-site.git
ARG VAULT_SITE_REF=
COPY vault-site.ref /tmp/vault-site.ref
RUN --mount=type=secret,id=gh_token,required=false \
    set -eu; \
    ref="${VAULT_SITE_REF:-$(grep -v '^[[:space:]]*#' /tmp/vault-site.ref | tr -d '[:space:]' | head -c 200)}"; \
    [ -n "$ref" ] || { echo "no vault-site ref: set VAULT_SITE_REF or vault-site.ref" >&2; exit 1; }; \
    auth=; \
    if [ -s /run/secrets/gh_token ]; then \
      auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$(cat /run/secrets/gh_token)" | base64 | tr -d '\n')"; \
    fi; \
    g() { if [ -n "$auth" ]; then git -c http.extraheader="$auth" -C /vault-site "$@"; else git -C /vault-site "$@"; fi; }; \
    git init -q /vault-site; \
    git -C /vault-site remote add origin "$VAULT_SITE_REPO"; \
    if g fetch -q --depth 1 origin "$ref"; then \
      git -C /vault-site checkout -q FETCH_HEAD; \
    else \
      echo "a shallow fetch of $ref failed (an abbreviated SHA?): fetching the history" >&2; \
      g fetch -q origin '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*'; \
      git -C /vault-site checkout -q "$ref^{commit}"; \
    fi; \
    echo "vault-site $(git -C /vault-site rev-parse HEAD) (ref $ref)"; \
    rm -rf /vault-site/.git /vault-site/portal; \
    ls /vault-site/hugo.toml /vault-site/hugo.yaml /vault-site/hugo.json /vault-site/config.* 2>/dev/null | grep -q . \
      || { echo "vault-site at $ref has no Hugo configuration" >&2; exit 1; }

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/publisher.db \
    SITE_DIR=/app/vault-site

# Hugo for the listing previews: the version the deploy workflow builds the site with (it reads this line), from
# the release's .deb, checked against the release's checksums.
ARG HUGO_VERSION=0.166.0
# ca-certificates: Litestream (Go) verifies GCS's TLS certificate against the system CA bundle, which -slim omits.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    arch="$(dpkg --print-architecture)"; \
    deb="hugo_extended_${HUGO_VERSION}_linux-${arch}.deb"; \
    cd /tmp; \
    curl -fsSLO "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/${deb}"; \
    curl -fsSL "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_checksums.txt" \
      | grep " ${deb}\$" | sha256sum -c -; \
    apt-get install -y --no-install-recommends "./${deb}"; \
    rm "${deb}"; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    hugo version
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# The website's source, for previews (src/site-dir.ts finds it through SITE_DIR).
COPY --from=site /vault-site /app/vault-site
COPY studios.json studio-websites.json litestream.yml docker-entrypoint.sh ./

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
