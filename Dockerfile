# vault-publisher on Cloud Run: Node runs the TypeScript directly (type stripping), and
# Litestream keeps the SQLite database replicated to a GCS bucket. The image also carries the website's source
# (site/, without its images) and Hugo: the portal renders listing previews with them (src/portal/site-preview.ts).
FROM litestream/litestream:0.3.13 AS litestream

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/publisher.db

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
# The site's templates, content and data (.dockerignore leaves out its images, downloads and build output).
COPY site ./site
COPY studios.json studio-websites.json litestream.yml docker-entrypoint.sh ./

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
