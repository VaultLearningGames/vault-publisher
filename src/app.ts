import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { bearerToken, type GitHubIdentity, type Verifier } from './auth.ts';
import type { Db, Game, ManifestFile, Studio } from './db.ts';
import { copyRelease, writePointer } from './releases.ts';
import {
  headersFor,
  isSafeFilePath,
  isSlug,
  isVersionName,
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
  // null until the production R2 key is configured; release endpoints then answer 503.
  production: Storage | null;
  verifier: Verifier;
  stagingPublicUrl: string;
  prodPublicUrl: string;
  adminRepository: string;
  adminEnvironment: string;
  previewRetentionDays: number;
  taskInvokerEmail: string;
}

const PRESIGN_SECONDS = 15 * 60;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
// Events whose OIDC `ref` names the branch or tag being built.
const PUBLISH_EVENTS = new Set(['push', 'workflow_dispatch']);

function fail(status: 400 | 401 | 403 | 404 | 409 | 410 | 503, message: string, detail?: unknown): never {
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

  // Release actions come only from the admin repository's Release workflow, running in the protected
  // GitHub environment (which requires a Vault reviewer to approve each run).
  async function admin(c: Context): Promise<GitHubIdentity> {
    const id = await github(c);
    if (id.repository !== deps.adminRepository || id.environment !== deps.adminEnvironment) {
      fail(403, `release actions must come from ${deps.adminRepository} in the "${deps.adminEnvironment}" environment`);
    }
    return id;
  }

  function productionStorage(): Storage {
    if (!deps.production) fail(503, 'production storage is not configured yet');
    return deps.production;
  }

  function releaseTarget(body: Record<string, unknown>) {
    if (!isSlug(body.studio)) fail(400, 'studio must be a studio slug');
    if (!isSlug(body.game)) fail(400, 'game must be a game slug');
    if (!isVersionName(body.version)) fail(400, 'version must look like "m3.2" or "legacy-2026-09"');
    const studio = db.studioBySlug(body.studio);
    if (!studio) fail(404, `unknown studio ${body.studio}`);
    const game = db.game(studio.id, body.game);
    if (!game) fail(404, `unknown game ${studio.slug}/${body.game}`);
    return { studio, game, version: body.version };
  }

  app.get('/health', (c) => c.json({ ok: true }));

  // Approve: copy a live staging build to production as an immutable release.
  // Body: { studio, game, version, ref } where ref is the staging branch/tag (defaults to version).
  app.post('/v1/admin/releases/approve', async (c) => {
    const id = await admin(c);
    const production = productionStorage();
    const body = await jsonBody(c);
    const { studio, game, version } = releaseTarget(body);
    const ref = sanitizeRefName(typeof body.ref === 'string' && body.ref ? body.ref.replace(/^refs\/(heads|tags)\//, '') : version);
    if (!ref) fail(400, 'ref must be a branch or tag name');
    const build = db.build(game.id, ref);
    if (!build || build.status !== 'live') fail(404, `no live staging build ${studio.slug}/${game.slug}/${ref}`);
    if (db.release(game.id, version)) fail(409, `release ${version} already exists and can't be changed`);
    const dstPrefix = `${studio.slug}/${game.slug}/${version}/`;
    if ((await production.list(dstPrefix)).length > 0) fail(409, `production already has files under ${dstPrefix}`);

    const copied = await copyRelease({ staging, production, srcPrefix: previewPrefix(studio, game, ref), dstPrefix });
    const release = db.createRelease({
      game_id: game.id, version, source_ref: ref, commit_sha: build.commit_sha,
      file_count: copied.files, total_bytes: copied.bytes, approved_by: `github:${id.actor}`,
    });
    db.audit(`github:${id.actor}`, 'release.approve', dstPrefix, { from: ref, sha: build.commit_sha, ...copied });
    return c.json({ release, url: `${deps.prodPublicUrl}/${dstPrefix}` });
  });

  // Promote (or roll back): make an approved release the one players get at STUDIO/GAME/.
  // Body: { studio, game, version }
  app.post('/v1/admin/releases/promote', async (c) => {
    const id = await admin(c);
    const production = productionStorage();
    const { studio, game, version } = releaseTarget(await jsonBody(c));
    const release = db.release(game.id, version);
    if (!release) fail(404, `${version} hasn't been approved for ${studio.slug}/${game.slug}`);
    const previous = db.currentRelease(game.id);
    const gamePrefix = `${studio.slug}/${game.slug}/`;
    await writePointer(production, gamePrefix, version, game.slug);
    db.setCurrentRelease(game.id, release.id);
    const rollback = previous !== undefined && previous.id > release.id;
    db.audit(`github:${id.actor}`, rollback ? 'release.rollback' : 'release.promote', gamePrefix, { from: previous?.version ?? null, to: version });
    return c.json({ current: version, previous: previous?.version ?? null, rollback, url: `${deps.prodPublicUrl}/${gamePrefix}` });
  });

  // Public, read-only: what a Release run is about to do, and whether it can. The Release workflow's
  // check job shows this to the reviewer before the approval gate, and stops the run on a problem.
  // Query: ?action=approve|promote|approve-and-promote&version=m3.2&ref=m3.2
  app.get('/v1/releases/:studio/:game/check', (c) => {
    const action = c.req.query('action') ?? 'approve-and-promote';
    const version = c.req.query('version') ?? '';
    const studio = db.studioBySlug(c.req.param('studio'));
    const game = studio && db.game(studio.id, c.req.param('game'));
    if (!studio || !game) fail(404, `unknown game ${c.req.param('studio')}/${c.req.param('game')}`);
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!isVersionName(version)) problems.push('version must look like "m3.2" or "legacy-2026-09"');
    const approving = action !== 'promote';
    const ref = sanitizeRefName((c.req.query('ref') || version).replace(/^refs\/(heads|tags)\//, '')) ?? '';
    const build = approving ? db.build(game.id, ref) : undefined;
    const existing = isVersionName(version) ? db.release(game.id, version) : undefined;
    const current = db.currentRelease(game.id);
    if (approving) {
      if (!build || build.status !== 'live') problems.push(`there is no live staging build "${ref}" for ${game.slug}`);
      if (existing) problems.push(`${version} was already approved on ${existing.approved_at.slice(0, 10)}; releases can't be replaced`);
      if (build && build.ref_type === 'branch') warnings.push(`"${ref}" is a branch, so it may have changed since it was tested; a version tag is safer`);
    } else if (!existing) {
      problems.push(`${version} hasn't been approved yet, so it can't be promoted`);
    }
    if (current && current.version === version && action !== 'approve') warnings.push(`${version} is already the current release`);
    const rollback = !approving && existing && current ? existing.id < current.id : false;
    if (!deps.production) problems.push('production storage is not configured yet');
    return c.json({
      ok: problems.length === 0, problems, warnings, action, rollback,
      game: `${studio.slug}/${game.slug}`, repository: game.repository, version,
      current: current ? { version: current.version, approved_at: current.approved_at } : null,
      staging: build ? {
        ref: build.ref_name, ref_type: build.ref_type, status: build.status, commit_sha: build.commit_sha,
        files: build.file_count, bytes: build.total_bytes, published_by: build.actor, updated_at: build.updated_at,
        url: `${deps.stagingPublicUrl}/${previewPrefix(studio, game, build.ref_name)}`,
      } : null,
      release_url: `${deps.prodPublicUrl}/${studio.slug}/${game.slug}/${version}/`,
      play_url: `${deps.prodPublicUrl}/${studio.slug}/${game.slug}/`,
    });
  });

  // Public: a game's releases and which one is current.
  app.get('/v1/releases/:studio/:game', (c) => {
    const studio = db.studioBySlug(c.req.param('studio'));
    const game = studio && db.game(studio.id, c.req.param('game'));
    if (!studio || !game) fail(404, 'unknown game');
    const current = db.currentRelease(game.id);
    return c.json({
      current: current?.version ?? null,
      url: `${deps.prodPublicUrl}/${studio.slug}/${game.slug}/`,
      releases: db.releases(game.id).map((r) => ({ version: r.version, source_ref: r.source_ref, commit_sha: r.commit_sha, files: r.file_count, bytes: r.total_bytes, approved_by: r.approved_by, approved_at: r.approved_at })),
    });
  });

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
