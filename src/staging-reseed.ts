// Staging's re-seed marker (docker-entrypoint.sh, .github/workflows/reseed-staging.yml). A re-seed replaces staging's
// database with a copy of production's and records its id here, inside the copy, so the copy replicates to staging's
// bucket with it. A later start of the same revision (Cloud Run restarts instances) restores staging's replica, finds
// the id and keeps what testers have done since; a replica without it (an older generation, or no replica) is
// re-seeded again. Production's database never has this table.
//
//   node src/staging-reseed.ts done DB_PATH ID   exits 0 when DB_PATH was re-seeded as ID, 1 otherwise
//   node src/staging-reseed.ts mark DB_PATH ID   records that DB_PATH was re-seeded as ID
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const TABLE = 'staging_reseed';

export function reseededAs(dbPath: string, id: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(TABLE);
    if (!table) return false;
    return db.prepare(`SELECT 1 FROM ${TABLE} WHERE id = ?`).get(id) !== undefined;
  } finally {
    db.close();
  }
}

export function markReseeded(dbPath: string, id: string, at = new Date()): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, reseeded_at TEXT NOT NULL)`);
    db.prepare(`INSERT OR REPLACE INTO ${TABLE} (id, reseeded_at) VALUES (?, ?)`).run(id, at.toISOString());
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [command, dbPath, id] = process.argv.slice(2);
  if (!dbPath || !id || (command !== 'done' && command !== 'mark')) {
    console.error('usage: node src/staging-reseed.ts done|mark DB_PATH ID');
    process.exit(2);
  }
  if (command === 'mark') markReseeded(dbPath, id);
  else process.exit(reseededAs(dbPath, id) ? 0 : 1);
}
