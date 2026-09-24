#!/bin/sh
set -e

if [ -z "$LITESTREAM_BUCKET" ]; then
  echo "LITESTREAM_BUCKET is not set; running without replication (data is lost on restart)" >&2
  exec node src/server.ts
fi

mkdir -p "$(dirname "$DB_PATH")"
litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists "$DB_PATH"
# Litestream runs the server as a child and forwards SIGTERM, so the last writes are replicated on shutdown.
exec litestream replicate -config litestream.yml -exec "node src/server.ts"
