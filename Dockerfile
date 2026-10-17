# syntax=docker/dockerfile:1
# vault-publisher on Cloud Run: Node runs the TypeScript directly (type stripping), and
# Litestream keeps the SQLite database replicated to a GCS bucket. The image also carries the website's source
# (VaultLearningGames/vault-site at the commit pinned in vault-site.ref, without its .git or portal/ submodule) and
# Hugo: the portal renders listing and blog previews with them (src/portal/site-preview.ts, src/site-dir.ts).
# The old in-repo site/ is not used (deprecated; see site/README.md).
FROM litestream/litestream:0.3.13 AS litestream

# vault-site at the pinned ref (vault-site.ref): the deploy workflow checks it out into ./vault-site-src before the
# build (vault-site is private, so the runner's token reads it; nothing secret enters Cloud Build). For a local build:
# git clone https://github.com/VaultLearningGames/vault-site vault-site-src && git -C vault-site-src checkout "$(grep -v '^#' vault-site.ref)"
FROM alpine AS site
COPY vault-site-src /vault-site
RUN set -eu; rm -rf /vault-site/.git /vault-site/portal; \
    ls /vault-site/hugo.toml /vault-site/hugo.yaml /vault-site/hugo.json /vault-site/config.* 2>/dev/null | grep -q . \
      || { echo "vault-site-src has no Hugo configuration" >&2; exit 1; }

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
