// SiteRepo over a local folder (a vault-site checkout), for tests and local development. A commit writes and removes
// the files and returns a made-up SHA; it runs no git (commit in the checkout yourself to publish anything). The same
// path rules and publishing switch apply as for GitHub, so what works here works there.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { sitePublishingEnabled, STAGING_SITE_BRANCH, withPortalUserTrailer } from './config.ts';
import { checkSitePath, SITE_CONTENT_ROOTS } from './paths.ts';
import { SitePathError, SitePublishingDisabledError, type CommitRequest, type SiteEntry, type SiteFile, type SiteRepo } from './types.ts';

export interface FsCommit { sha: string; message: string; paths: string[] }

// The SHA git gives a blob with this content.
export function gitBlobSha(content: string | Buffer): string {
  const b = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}

export class FsSiteRepo implements SiteRepo {
  readonly branch: string;
  readonly dir: string;
  // Every commit made, oldest first (tests read them).
  readonly commits: FsCommit[] = [];
  private head = '0'.repeat(40);
  private readonly roots: readonly string[];
  private readonly env?: Record<string, string | undefined>;

  constructor(dir: string, o: { branch?: string; roots?: readonly string[]; env?: Record<string, string | undefined> } = {}) {
    this.dir = resolve(dir);
    this.branch = o.branch ?? STAGING_SITE_BRANCH;
    this.roots = o.roots ?? SITE_CONTENT_ROOTS;
    this.env = o.env;
  }

  private abs(path: string): string {
    const p = join(this.dir, ...path.split('/'));
    if (!p.startsWith(this.dir + sep)) throw new SitePathError(`${path} is outside the website folder.`);
    return p;
  }

  async headSha(): Promise<string> { return this.head; }

  async readFile(path: string): Promise<SiteFile | null> {
    const p = checkSitePath(path, this.roots);
    try {
      const b = await readFile(this.abs(p));
      return { content: b.toString('utf8'), sha: gitBlobSha(b) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw err;
    }
  }

  async listDir(prefix: string): Promise<SiteEntry[]> {
    const dir = checkSitePath(prefix, this.roots, { dir: true });
    const out: SiteEntry[] = [];
    const walk = async (rel: string) => {
      let ents;
      try { ents = await readdir(this.abs(rel), { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(r);
        else if (e.isFile()) out.push({ path: r, sha: gitBlobSha(await readFile(this.abs(r))) });
      }
    };
    await walk(dir);
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async commitChanges(req: CommitRequest): Promise<{ commitSha: string }> {
    if (!sitePublishingEnabled(this.env)) throw new SitePublishingDisabledError();
    if (!req.changes?.length) throw new SitePathError('A commit needs at least one change.');
    const message = withPortalUserTrailer(req.message, req.portalUser);
    const changes = req.changes.map((c) => ({ path: checkSitePath(c.path, this.roots), content: c.content }));
    for (const c of changes) {
      const p = this.abs(c.path);
      if (c.content === null) await rm(p, { force: true });
      else {
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, c.content);
      }
    }
    this.head = randomBytes(20).toString('hex');
    this.commits.push({ sha: this.head, message, paths: changes.map((c) => c.path) });
    return { commitSha: this.head };
  }
}
