// The vault-site repository as the portal sees it: files on one branch, read and changed by commits. The portal never
// builds or deploys the site; a commit on vault-site's staging or production branch is what makes vault-site's own
// workflow build and publish it. Implementations: github.ts (the GitHub REST API, as the bot user) and fs.ts (a local
// folder, for tests and development).

export interface SiteFile {
  content: string;
  // The file's git blob SHA (fs.ts: the same hash git would give it).
  sha: string;
}

export interface SiteEntry {
  path: string;
  sha: string;
}

// One file written (content) or removed (content null). Paths are repository paths, checked by paths.ts.
export interface SiteChange {
  path: string;
  content: string | null;
}

export interface CommitRequest {
  changes: SiteChange[];
  message: string;
  // Who in the portal made the change (a GitHub login or an email): the commit's Portal-User trailer.
  portalUser: string;
}

export interface SiteRepo {
  // The branch read from and committed to.
  readonly branch: string;
  readFile(path: string): Promise<SiteFile | null>;
  // Every file under a folder (recursively), sorted by path. An empty list when there is no such folder.
  listDir(prefix: string): Promise<SiteEntry[]>;
  commitChanges(req: CommitRequest): Promise<{ commitSha: string }>;
  headSha(): Promise<string>;
}

export class SiteRepoError extends Error {
  // GitHub's HTTP status (0: the request itself failed).
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SiteRepoError';
    this.status = status;
    this.code = code;
  }
}

// The branch kept moving: the commit was rebuilt on the new head and retried, and still lost the race.
export class SiteRepoConflictError extends SiteRepoError {
  constructor(branch: string) {
    super(409, 'conflict', `The ${branch} branch of the website repository kept changing; nothing was committed. Try again.`);
    this.name = 'SiteRepoConflictError';
  }
}

// SITE_PUBLISHING_ENABLED is false: the portal writes nothing to vault-site.
export class SitePublishingDisabledError extends SiteRepoError {
  constructor() {
    super(503, 'publishing_disabled', 'Publishing to the website repository is turned off here (SITE_PUBLISHING_ENABLED=false). Nothing was saved.');
    this.name = 'SitePublishingDisabledError';
  }
}

// A path the portal may not read or write (outside the repository, or outside the folders it edits).
export class SitePathError extends SiteRepoError {
  constructor(message: string) {
    super(400, 'bad_path', message);
    this.name = 'SitePathError';
  }
}

// The repository isn't configured (no token, or a malformed setting). Thrown on first use, never at import.
export class SiteRepoConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'SiteRepoConfigError'; }
}
