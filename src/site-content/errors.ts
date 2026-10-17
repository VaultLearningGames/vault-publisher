// Errors of the website-content library (the blog as Markdown files in the vault-site repository).

// The portal's save-conflict answer: the same 409 and message the blog editor's save gets when the post changed since it
// was loaded (portal/blog-admin.ts, `conflict`). Here it means the file's SHA on GitHub is not the one the caller loaded.
export const SAVE_CONFLICT_STATUS = 409;
export const SAVE_CONFLICT_MESSAGE = 'This post was changed elsewhere since you loaded it. Reload to get the latest version.';

export class SaveConflictError extends Error {
  readonly status = SAVE_CONFLICT_STATUS;
  readonly code = 'save_conflict';
  // The path that conflicted, and the SHA it has now when known.
  readonly path: string;
  readonly currentSha?: string;
  constructor(path: string, currentSha?: string) {
    super(SAVE_CONFLICT_MESSAGE);
    this.name = 'SaveConflictError';
    this.path = path;
    this.currentSha = currentSha;
  }
}

// The client is not configured (no token, or a malformed setting). Thrown on first use, never at import.
export class SiteContentConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'SiteContentConfigError'; }
}

// Any other failure talking to GitHub: `status` is GitHub's HTTP status (0 when the request itself failed).
export class SiteContentError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SiteContentError';
    this.status = status;
    this.code = code;
  }
}

// Front matter that can't be read (not YAML between --- lines, or a known key with a value of the wrong kind).
export class FrontMatterError extends Error {
  constructor(message: string) { super(message); this.name = 'FrontMatterError'; }
}
