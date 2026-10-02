// studios.json at startup: the studios it lists, and the repositories it assigns to them.
import type { Db, Studio, StudioRepositoriesFile } from './db.ts';

export type StudiosFileEntry = Omit<Studio, 'id'> & StudioRepositoriesFile;

interface Log { log(message: string): void; error(message: string): void }

// studios.json is authoritative for the studios it lists and the repositories it assigns; studios and assignments
// made in the portal are left alone. A conflict (a slug or a repository that belongs to another studio) is logged and
// skipped: it must never stop the service starting.
export function syncStudiosFile(db: Db, studios: StudiosFileEntry[], log: Log = console) {
  const synced = db.syncStudios(studios);
  if (synced.skipped.length) log.error(`studios.json: skipped ${synced.skipped.join(', ')}: the slug belongs to another studio (different GitHub owner id)`);
  let repositories = { bound: [] as string[], removed: [] as string[], skipped: [] as string[] };
  try {
    repositories = db.syncStudioRepositories(studios);
  } catch (err) {
    log.error(`studios.json: repositories not synced: ${(err as Error).message}`);
  }
  if (repositories.bound.length) log.log(`studios.json: repositories assigned: ${repositories.bound.join('; ')}`);
  if (repositories.removed.length) log.log(`studios.json: repositories no longer listed, removed: ${repositories.removed.join('; ')}`);
  for (const s of repositories.skipped) log.error(`studios.json: skipped repository ${s}`);
  return { studios: synced, repositories };
}
