#!/bin/sh
set -e

if [ -z "$LITESTREAM_BUCKET" ]; then
  echo "LITESTREAM_BUCKET is not set; running without replication (data is lost on restart)" >&2
  exec node src/server.ts
fi

mkdir -p "$(dirname "$DB_PATH")"
litestream restore -config litestream.yml -if-db-not-exists -if-replica-exists "$DB_PATH"

# Staging only: a re-seed (LITESTREAM_RESEED, set by .github/workflows/reseed-staging.yml, daily and on demand)
# replaces staging's database with a copy of production's: what staging has is discarded. The id is recorded in the
# copy (src/staging-reseed.ts), so later restarts of the same revision keep it. Production's bucket is only read.
if [ -n "$LITESTREAM_RESEED" ]; then
  case "$LITESTREAM_BUCKET" in *staging*) ;; *) echo "LITESTREAM_RESEED is set, but $LITESTREAM_BUCKET isn't staging's bucket" >&2; exit 1 ;; esac
  case "$LITESTREAM_SEED_BUCKET" in ""|*staging*) echo "LITESTREAM_RESEED needs LITESTREAM_SEED_BUCKET, production's bucket" >&2; exit 1 ;; esac
  if node src/staging-reseed.ts done "$DB_PATH" "$LITESTREAM_RESEED"; then
    echo "Already re-seeded from production as $LITESTREAM_RESEED; keeping staging's database" >&2
  else
    echo "Re-seeding ($LITESTREAM_RESEED): replacing staging's database with gcs://$LITESTREAM_SEED_BUCKET/publisher.db" >&2
    rm -rf "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm" "$(dirname "$DB_PATH")/.$(basename "$DB_PATH")-litestream"
    # No -if-replica-exists: without production's copy the start fails, and Cloud Run keeps the running revision.
    litestream restore -o "$DB_PATH" "gcs://$LITESTREAM_SEED_BUCKET/publisher.db"
    node src/staging-reseed.ts mark "$DB_PATH" "$LITESTREAM_RESEED"
  fi
fi

# Staging only: the first start (no replica of its own yet) begins from a copy of production's database.
# Read-only; from then on staging replicates to its own bucket.
if [ ! -f "$DB_PATH" ] && [ -n "$LITESTREAM_SEED_BUCKET" ]; then
  echo "No database yet; seeding from gcs://$LITESTREAM_SEED_BUCKET/publisher.db" >&2
  litestream restore -if-replica-exists -o "$DB_PATH" "gcs://$LITESTREAM_SEED_BUCKET/publisher.db"
fi

# Litestream runs the server as a child and forwards SIGTERM, so the last writes are replicated on shutdown.
exec litestream replicate -config litestream.yml -exec "node src/server.ts"
