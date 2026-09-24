import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { bearerToken, type GitHubIdentity, type Verifier } from './auth.ts';
import type { Db, Game, ManifestFile, Studio } from './db.ts';
import {
  headersFor,
  isSafeFilePath,
  isSlug,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  parseGitRef,
  sanitizeRefName,
} from './paths.ts';
import { requestHeaders, type Storage } from './storage.ts';

export interface AppDeps {
  db: Db;
  staging: Storage;
  verifier: Verifier;
  stagingPublicUrl: string;
  previewRetentionDays: number;
  taskInvokerEmail: string;
}

const PRESIGN_SECONDS = 15 * 60;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
// Events whose OIDC `ref` names the branch or tag being built.
const PUBLISH_EVENTS = new Set(['push', 'workflow_dispatch']);

function fail(status: 400 | 401 | 403 | 404 | 409 | 410, message: string, detail?: unknown): never {
  throw new HTTPException(status, { res: Response.json({ error: message, detail }, { status }) });
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'expected a JSON object body');
  return body as Record<string, unknown>;
}

function previewPrefix(studio: Studio | string, game: Game | string, refName: string): string {
  const s = typeof studio === 'string' ? studio : studio.slug;
  const g = typeof game === 'string' ? game : game.slug;
  return `${s}/${g}/${refName}/`;
}

function parseManifest(value: unknown): ManifestFile[] {
  if (!Array.isArray(value) || value.length === 0) fail(400, 'files must be a non-empty array');
  if (value.length > MAX_FILES) fail(400, `a build may contain at most ${MAX_FILES} files`);
  const seen = new Set<string>();
  let total = 0;
  const files = value.map((f: unknown, i) => {
    const { path, size } = (f ?? {}) as { path?: unknown; size?: unknown };
    if (!isSafeFilePath(path)) fail(400, `files[${i}].path is not a safe relative path`);
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MAX_FILE_BYTES) {
      fail(400, `files[${i}].size is invalid`);
    }
    if (seen.has(path)) fail(400, `duplicate path ${path}`);
    seen.add(path);
    total += size as number;
    return { path, size: size as number };
  });
  if (total > MAX_TOTAL_BYTES) fail(400, `a build may be at most ${MAX_TOTAL_BYTES} bytes`);
  return files;
}

export function createApp(deps: AppDeps) {
  const { db, staging, verifier } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

  app.use('/v1/*', bodyLimit({ maxSize: 4 * 1024 * 1024 }));

  async function github(c: Context): Promise<GitHubIdentity> {
    const token = bearerToken(c.req.header('Authorization'));
    if (!token) fail(401, 'missing bearer token (a GitHub Actions OIDC token)');
    try {
      return await verifier.github(token);
    } catch (err) {
      fail(401, `invalid GitHub OIDC token: ${(err as Error).message}`);
    }
  }

  function studioFor(id: GitHubIdentity): Studio {
    const studio = db.studioByOwnerId(id.ownerId);
    if (!studio) fail(403, `GitHub owner ${id.owner} is not a registered studio`);
    return studio;
  }

  // A game belongs to the repository that first published it.
  function gameFor(studio: Studio, id: GitHubIdentity, slug: unknown, opts: { create: boolean }): Game {
    if (!isSlug(slug)) fail(400, 'game must be a lowercase slug like "aqualab"');
    let game = db.game(studio.id, slug);
    if (!game) {
      if (!opts.create) fail(404, `unknown game ${studio.slug}/${slug}`);
      game = db.createGame(studio.id, slug, id.repository, id.repositoryId);
      db.audit(`github:${id.actor}`, 'game.claim', `${studio.slug}/${slug}`, { repository: id.repository });
    }
    if (game.repository_id !== id.repositoryId) {
      fail(403, `${studio.slug}/${slug} is published from ${game.repository}, not ${id.repository}`);
    }
    return game;
  }

  app.get('/health', (c) => c.json({ ok: true }));

  // Start a preview upload for the branch or tag in the caller's OIDC token.
  // Body: { game, files: [{ path, size }] }. Returns a presigned PUT URL and headers per file.
  app.post('/v1/previews', async (c) => {
    const id = await github(c);
    const body = await jsonBody(c);
    if (!PUBLISH_EVENTS.has(id.eventName)) fail(400, `previews publish on push, not ${id.eventName}`);
    const ref = parseGitRef(id.ref);
    if (!ref) fail(400, `cannot publish a preview for ref ${id.ref}`);
    const studio = studioFor(id);
    const game = gameFor(studio, id, body.game, { create: true });
    const manifest = parseManifest(body.files);

    const uploadId = randomUUID();
    const prefix = previewPrefix(studio, game, ref.name);
    const files = await Promise.all(
      manifest.map(async (f) => {
        const headers = headersFor(f.path);
        return {
          path: f.path,
          url: await staging.presignPut(prefix + f.path, headers, PRESIGN_SECONDS),
          headers: requestHeaders(headers),
        };
      }),
    );
    db.createUpload({
      id: uploadId,
      game_id: game.id,
      ref_name: ref.name,
      ref_type: ref.type,
      commit_sha: id.sha,
      actor: id.actor,
      manifest,
      expires_at: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
    });
    return c.json({ upload_id: uploadId, url: `${deps.stagingPublicUrl}/${prefix}`, files });
  });

  // Check every file arrived, remove files left over from the previous build, record the preview.
  app.post('/v1/previews/:uploadId/finalize', async (c) => {
    const id = await github(c);
    const upload = db.upload(c.req.param('uploadId'));
    if (!upload) fail(404, 'unknown upload');
    const game = db.gameById(upload.game_id)!;
    if (game.repository_id !== id.repositoryId) fail(403, 'upload belongs to another repository');
    if (upload.finalized_at) fail(409, 'upload already finalized');
    if (upload.expires_at < new Date().toISOString()) fail(410, 'upload expired; publish again');
    if (db.hasNewerUpload(upload)) fail(409, 'a newer upload to this preview has started; this one is superseded');

    const prefix = previewPrefix(db.studioById(game.studio_id)!, game, upload.ref_name);
    const stored = new Map((await staging.list(prefix)).map((o) => [o.key, o.size]));
    const missing = upload.manifest.filter((f) => stored.get(prefix + f.path) !== f.size).map((f) => f.path);
    if (missing.length > 0) fail(409, `${missing.length} file(s) missing or incomplete`, missing.slice(0, 20));

    const wanted = new Set(upload.manifest.map((f) => prefix + f.path));
    const stale = [...stored.keys()].filter((key) => !wanted.has(key));
    if (stale.length > 0) await staging.deleteKeys(stale);

    const totalBytes = upload.manifest.reduce((sum, f) => sum + f.size, 0);
    db.upsertBuild(upload, upload.manifest.length, totalBytes);
    db.markUploadFinalized(upload.id);
    db.audit(`github:${id.actor}`, 'preview.publish', prefix, {
      repository: id.repository,
      sha: upload.commit_sha,
      files: upload.manifest.length,
      bytes: totalBytes,
      removed: stale.length,
    });
    return c.json({ url: `${deps.stagingPublicUrl}/${prefix}` });
  });

  // Delete a preview, e.g. from a workflow triggered by branch deletion.
  // Body: { game, ref } where ref is the branch or tag name ("feature/x" or "feature_x").
  app.post('/v1/previews/delete', async (c) => {
    const id = await github(c);
    const body = await jsonBody(c);
    const studio = studioFor(id);
    const game = gameFor(studio, id, body.game, { create: false });
    const refName = typeof body.ref === 'string' ? sanitizeRefName(body.ref.replace(/^refs\/(heads|tags)\//, '')) : null;
    if (!refName) fail(400, 'ref must be a branch or tag name');

    const prefix = previewPrefix(studio, game, refName);
    const keys = (await staging.list(prefix)).map((o) => o.key);
    if (keys.length > 0) await staging.deleteKeys(keys);
    const build = db.build(game.id, refName);
    if (build) db.markBuildDeleted(build.id);
    db.audit(`github:${id.actor}`, 'preview.delete', prefix, { repository: id.repository, files: keys.length });
    return c.json({ deleted: keys.length });
  });

  // Nightly, from Cloud Scheduler: remove branch previews with no push for previewRetentionDays.
  app.post('/v1/tasks/cleanup', async (c) => {
    const token = bearerToken(c.req.header('Authorization'));
    if (!token) fail(401, 'missing bearer token');
    let email: string;
    try {
      email = await verifier.google(token);
    } catch (err) {
      fail(401, `invalid Google ID token: ${(err as Error).message}`);
    }
    if (email !== deps.taskInvokerEmail) fail(403, `${email} may not run tasks`);

    const cutoff = new Date(Date.now() - deps.previewRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const removed: string[] = [];
    for (const b of db.staleBranchBuilds(cutoff)) {
      const prefix = previewPrefix(b.studio_slug, b.game_slug, b.ref_name);
      const keys = (await staging.list(prefix)).map((o) => o.key);
      if (keys.length > 0) await staging.deleteKeys(keys);
      db.markBuildDeleted(b.build_id);
      db.audit('system:cleanup', 'preview.expire', prefix, { files: keys.length });
      removed.push(prefix);
    }
    const expiredUploads = db.deleteExpiredUploads();
    return c.json({ removed, expired_uploads: expiredUploads });
  });

  return app;
}
