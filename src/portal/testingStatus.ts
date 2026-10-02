// The "Testing Status" of a site game (Vault → Game Catalog): the three states the column that used to be
// called "Loads" reports. It is derived from the latest check-games run's level for the game; nothing is
// persisted, so reverting this file restores the old column with no migration.
//
// Only a definite success is "Passing" and only a definite failure is "Failure". Everything else — never
// checked, warnings worth a human look, or an unrecognized value — is "Needs Review", so the row surfaces
// for a person instead of silently showing green.
import type { Level } from '../game-checks.ts';

export type TestingStatus = 'Failure' | 'Needs Review' | 'Passing';

// Severity order the Game Catalog table sorts by: failures first, then what needs a look, then the good.
export const TESTING_STATUS_RANK: Record<TestingStatus, number> = { Failure: 0, 'Needs Review': 1, Passing: 2 };

// A game's check level (or no result at all) as its testing status. 'warn' loads but with problems, so it
// needs review; anything else that is not a definite ok or fail (undefined, null, a legacy value) does too.
export function deriveTestingStatus(level: Level | null | undefined): TestingStatus {
  if (level === 'ok') return 'Passing';
  if (level === 'fail') return 'Failure';
  return 'Needs Review';
}

// The sort key for a level or missing result; compare statuses (or levels) with it before any tie-break.
export const testingStatusRank = (level: Level | null | undefined): number => TESTING_STATUS_RANK[deriveTestingStatus(level)];

// Status-severity comparator for two statuses: Failure before Needs Review before Passing.
export function compareByTestingStatus(a: TestingStatus, b: TestingStatus): number {
  return TESTING_STATUS_RANK[a] - TESTING_STATUS_RANK[b];
}
