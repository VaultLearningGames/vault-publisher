# vault-publisher on Cloud Run: Node runs the TypeScript directly (type stripping), and
# Litestream keeps the SQLite database replicated to a GCS bucket.
FROM litestream/litestream:0.3.13 AS litestream

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/publisher.db

# Litestream (Go) verifies GCS's TLS certificate against the system CA bundle, which -slim omits.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY studios.json litestream.yml docker-entrypoint.sh ./

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
