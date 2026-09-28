#!/bin/sh
set -e

if [ -z "$LITESTREAM_BUCKET" ]; then
  echo "LITESTREAM_BUCKET is not set; running without replication (data is lost on restart)" >&2
  exec node src/server.ts
fi

mkdir -p "$(dirname "$DB_PATH")"
litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists "$DB_PATH"

# Staging only: the first start (no replica of its own yet) begins from a copy of production's database.
# Read-only; from then on staging replicates to its own bucket. To refresh, delete staging's replica and redeploy.
if [ ! -f "$DB_PATH" ] && [ -n "$LITESTREAM_SEED_BUCKET" ]; then
  echo "No database yet; seeding from gcs://$LITESTREAM_SEED_BUCKET/publisher.db" >&2
  litestream restore -if-replica-exists -o "$DB_PATH" "gcs://$LITESTREAM_SEED_BUCKET/publisher.db"
fi

# Litestream runs the server as a child and forwards SIGTERM, so the last writes are replicated on shutdown.
exec litestream replicate -config litestream.yml -exec "node src/server.ts"
