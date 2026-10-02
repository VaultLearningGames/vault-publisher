import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { bearerToken, type GitHubIdentity, type Verifier } from './auth.ts';
import type { Db, Game, ManifestFile, Studio } from './db.ts';
import { copyRelease, makeLive, ReleaseLayoutError, releasePrefix } from './releases.ts';
import { catalogGame, catalogStudios } from './catalog.ts';
import type { PreviewSite } from './config.ts';
import { catalogFeatured, readFeatured } from './featured.ts';
import { parseRun } from './game-checks.ts';
import { registerPortal, type PortalConfig } from './portal/routes.ts';
import { registerForms, type FormsConfig } from './forms.ts';
import { registerAdminTasks } from './admin-tasks.ts';
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
import { guardedFetcher, type Fetcher } from './net-guard.ts';
import { checkMonitors, monitoredBuilds } from './url-monitor.ts';

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
  portal: PortalConfig;
  previewRetentionDays: number;
  taskInvokerEmail: string;
  // Public website forms; without it the form endpoints answer 503.
  forms?: FormsConfig;
  // The public website, where site-path listing images are fetched from to copy them to the CDN.
  siteUrl?: string;
  // Sites that show unsaved listing previews at SITE/_preview/TOKEN/; none hides the editor's Preview buttons.
  previewSites?: PreviewSite[];
  // Injected in tests (image migration downloads).
  fetch?: typeof fetch;
  // How URL monitors fetch a studio's hosted game (net-guard.ts: public addresses only). Injected in tests.
  fetcher?: Fetcher;
}

const PRESIGN_SECONDS = 15 * 60;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
// Events whose OIDC `ref` names the branch or tag being built (for a published GitHub release, its tag).
const PUBLISH_EVENTS = new Set(['push', 'workflow_dispatch', 'release']);
// Time the nightly cleanup may spend on URL monitors (Cloud Scheduler's default attempt deadline is 3 minutes), and
// what the monitors' own task route may spend (give its Scheduler job a 15-minute deadline).
const CLEANUP_MONITOR_BUDGET_MS = 100_000;
const MONITOR_TASK_BUDGET_MS = 12 * 60_000;

export function fail(status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 503, message: string, detail?: unknown): never {
  throw new HTTPException(status, { res: Response.json({ error: message, detail }, { status }) });
}

export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'expected a JSON object body');
  return body as Record<string, unknown>;
}

function previewPrefix(studio: Studio | string, game: Game | string, refName: string): string {
  const s = typeof studio === 'string' ? studio : studio.slug;
  const g = typeof game === 'string' ? game : game.slug;
  return `${s}/${g}/${refName}/`;
}

export function parseManifest(value: unknown): ManifestFile[] {
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

  // Which studio a repository publishes for. A repository assigned to a studio (studio_repositories) publishes for
  // that studio whatever organization owns it, so one organization can hold several studios' games; every other
  // repository publishes for the studio registered for its owner. Both are matched by GitHub's numeric ids, which
  // survive renames.
  function studioFor(id: GitHubIdentity): Studio {
    const binding = db.repositoryBinding(id.repositoryId);
    if (binding) {
      if (binding.repository !== id.repository) db.renameBoundRepository(binding.repository_id, id.repository);
      return db.studioById(binding.studio_id)!;
    }
    const studio = db.studioByOwnerId(id.ownerId);
    if (!studio) fail(403, `GitHub owner ${id.owner} is not a registered studio, and ${id.repository} is not assigned to one`);
    return studio;
  }

  // A game belongs to the repository that first published it. It is looked up only among the games of the studio
  // the repository publishes for, so a repository assigned to one studio can't reach a same-named game of its
  // organization's studio, or the other way round.
  function gameFor(studio: Studio, id: GitHubIdentity, slug: unknown, opts: { create: boolean }): Game {
    if (!isSlug(slug)) fail(400, 'game must be a lowercase slug like "aqualab"');
    let game = db.game(studio.id, slug);
    if (!game) {
      if (!opts.create) fail(404, `unknown game ${studio.slug}/${slug}`);
      game = db.createGame(studio.id, slug, id.repository, id.repositoryId);
      db.audit(`github:${id.actor}`, 'game.claim', `${studio.slug}/${slug}`, { repository: id.repository });
      linkSameNamedListing(studio, game);
    } else if (game.repository_id.startsWith('vault:')) {
      // Vault uploaded this game for the studio (e.g. copied from its old host); the studio's own CI now takes it over.
      db.claimGame(game.id, id.repository, id.repositoryId);
      db.audit(`github:${id.actor}`, 'game.claim', `${studio.slug}/${slug}`, { repository: id.repository, from: game.repository_id });
      game = db.gameById(game.id)!;
    }
    if (game.repository_id !== id.repositoryId) {
      fail(403, `${studio.slug}/${slug} is published from ${game.repository}, not ${id.repository}`);
    }
    return game;
  }

  // A new CDN game is linked to the studio's site listing of the same name, if that listing isn't linked yet.
  function linkSameNamedListing(studio: Studio, game: Game) {
    const l = db.listing(game.slug);
    if (l && l.studio_id === studio.id && !l.game_id) {
      db.linkListing(l.id, game.id);
      db.audit('vault', 'listing.link', `${studio.slug}:${l.slug}`, { game: game.slug });
    }
  }

  // Admin actions (releases, Vault uploads, game availability runs) come only from the admin repository's workflows,
  // running in this system's GitHub environment. (Required reviewers on that environment would also hold up the
  // daily check-games run.)
  async function admin(c: Context): Promise<GitHubIdentity> {
    const id = await github(c);
    if (id.repository !== deps.adminRepository || id.environment !== deps.adminEnvironment) {
      fail(403, `admin actions must come from ${deps.adminRepository} in the "${deps.adminEnvironment}" environment`);
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
  // Shared by the Release workflow (OIDC) and the web portal (signed-in release managers).
  async function approveRelease(studio: Studio, game: Game, version: string, rawRef: string | undefined, actor: string) {
    const production = productionStorage();
    const ref = sanitizeRefName(rawRef ? rawRef.replace(/^refs\/(heads|tags)\//, '') : version);
    if (!ref) fail(400, 'ref must be a branch or tag name');
    const build = db.build(game.id, ref);
    if (!build || build.status !== 'live') fail(404, `no live staging build ${studio.slug}/${game.slug}/${ref}`);
    if (db.release(game.id, version)) fail(409, `release ${version} already exists and can't be changed`);
    const dstPrefix = releasePrefix(`${studio.slug}/${game.slug}/`, version);
    if ((await production.list(dstPrefix)).length > 0) fail(409, `production already has files under ${dstPrefix}`);
    const copied = await copyRelease({ staging, production, srcPrefix: previewPrefix(studio, game, ref), dstPrefix })
      .catch((err) => { if (err instanceof ReleaseLayoutError) fail(400, `Can’t release ${ref}: ${err.message}.`); throw err; });
    const release = db.createRelease({
      game_id: game.id, version, source_ref: ref, commit_sha: build.commit_sha,
      file_count: copied.files, total_bytes: copied.bytes, approved_by: actor,
    });
    db.closeRequestsForVersion(game.id, version, actor);
    db.audit(actor, 'release.approve', dstPrefix, { from: ref, sha: build.commit_sha, ...copied });
    return { release, url: `${deps.prodPublicUrl}/${dstPrefix}` };
  }

  // Switch the release players get at STUDIO/GAME/ by copying it into place. One switch per game at a time;
  // if a copy fails part-way, the previous release is put back so players never keep a mixed folder.
  const switching = new Set<number>();
  async function promoteRelease(studio: Studio, game: Game, version: string, actor: string) {
    const production = productionStorage();
    const release = db.release(game.id, version);
    if (!release) fail(404, `${version} hasn't been approved for ${studio.slug}/${game.slug}`);
    if (release.withdrawn_at) fail(409, `${version} was withdrawn by Vault${release.withdrawn_note ? `: ${release.withdrawn_note}` : ''}. Restore it before making it current.`);
    if (switching.has(game.id)) fail(409, `${studio.slug}/${game.slug} is already switching versions; try again in a minute`);
    switching.add(game.id);
    try {
      const previous = db.currentRelease(game.id);
      const gamePrefix = `${studio.slug}/${game.slug}/`;
      try {
        await makeLive(production, gamePrefix, version);
      } catch (err) {
        if (previous) await makeLive(production, gamePrefix, previous.version).catch(() => {});
        throw err;
      }
      db.setCurrentRelease(game.id, release.id);
      const rollback = previous !== undefined && previous.id > release.id;
      db.audit(actor, rollback ? 'release.rollback' : 'release.promote', gamePrefix, { from: previous?.version ?? null, to: version });
      return { current: version, previous: previous?.version ?? null, rollback, url: `${deps.prodPublicUrl}/${gamePrefix}` };
    } finally {
      switching.delete(game.id);
    }
  }

  // Approve: copy a live staging build to production as an immutable release.
  // Body: { studio, game, version, ref } where ref is the staging branch/tag (defaults to version).
  app.post('/v1/admin/releases/approve', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const { studio, game, version } = releaseTarget(body);
    return c.json(await approveRelease(studio, game, version, typeof body.ref === 'string' ? body.ref : undefined, `github:${id.actor}`));
  });

  // Promote (or roll back): make an approved release the one players get at STUDIO/GAME/.
  // Body: { studio, game, version }
  app.post('/v1/admin/releases/promote', async (c) => {
    const id = await admin(c);
    const { studio, game, version } = releaseTarget(await jsonBody(c));
    return c.json(await promoteRelease(studio, game, version, `github:${id.actor}`));
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
      release_url: `${deps.prodPublicUrl}/${releasePrefix(`${studio.slug}/${game.slug}/`, version)}`,
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

  // Public: every published site listing, which the Vault website is built from, and the home page's featured
  // games. A listing hosted on the Vault CDN gets its game's current release URL here, so releasing or rolling
  // back a game changes what the site serves on the next site build without anyone editing the listing.
  // `studios` is every studio with a game on the site, or named as a maker of one, and its website, so the site can
  // link any maker name that matches a studio (a game can list several makers).
  app.get('/v1/catalog', (c) => {
    const published = db.listings({ published: true });
    const games = published.map((l) => catalogGame(db, deps.prodPublicUrl, l, l.published!));
    // The home page's Featured Games, in ascending sequence, ties by title (only games that are on the site).
    const titles = new Map(games.map((g) => [g.slug, g.title]));
    const featured = catalogFeatured(readFeatured(db), (slug) => titles.get(slug));
    const studios = catalogStudios(published, db.studios(), games);
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ version: 1, generated_at: new Date().toISOString(), featured, studios, games });
  });

  // Start a preview upload for the branch or tag in the caller's OIDC token.
  // Body: { game, files: [{ path, size }] }. Returns a presigned PUT URL and headers per file.
  // Presigned PUTs for a new build of `game` at `ref`; the caller uploads, then finalizes.
  async function startUpload(studio: Studio, game: Game, ref: { type: 'branch' | 'tag'; name: string }, sha: string, actor: string, filesBody: unknown, presignSeconds = PRESIGN_SECONDS) {
    const manifest = parseManifest(filesBody);
    const uploadId = randomUUID();
    const prefix = previewPrefix(studio, game, ref.name);
    const files = await Promise.all(
      manifest.map(async (f) => {
        const headers = headersFor(f.path);
        return {
          path: f.path,
          url: await staging.presignPut(prefix + f.path, headers, presignSeconds),
          headers: requestHeaders(headers),
        };
      }),
    );
    db.createUpload({
      id: uploadId,
      game_id: game.id,
      ref_name: ref.name,
      ref_type: ref.type,
      commit_sha: sha,
      actor,
      manifest,
      expires_at: new Date(Date.now() + UPLOAD_TTL_MS).toISOString(),
    });
    return { upload_id: uploadId, url: `${deps.stagingPublicUrl}/${prefix}`, files };
  }

  // Check every file arrived, remove files left over from the previous build, record the preview.
  async function finishUpload(uploadId: string, allowed: (game: Game) => boolean, auditActor: string, auditDetail: Record<string, unknown>) {
    const upload = db.upload(uploadId);
    if (!upload) fail(404, 'unknown upload');
    const game = db.gameById(upload.game_id)!;
    if (!allowed(game)) fail(403, 'upload belongs to another repository');
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
    db.audit(auditActor, 'preview.publish', prefix, { ...auditDetail, sha: upload.commit_sha, files: upload.manifest.length, bytes: totalBytes, removed: stale.length });
    return { url: `${deps.stagingPublicUrl}/${prefix}` };
  }

  app.post('/v1/previews', async (c) => {
    const id = await github(c);
    const body = await jsonBody(c);
    if (!PUBLISH_EVENTS.has(id.eventName)) fail(400, `previews publish on push or a published release, not ${id.eventName}`);
    const ref = parseGitRef(id.ref);
    if (!ref) fail(400, `cannot publish a preview for ref ${id.ref}`);
    const studio = studioFor(id);
    const game = gameFor(studio, id, body.game, { create: true });
    return c.json(await startUpload(studio, game, ref, id.sha, id.actor, body.files));
  });

  app.post('/v1/previews/:uploadId/finalize', async (c) => {
    const id = await github(c);
    // The repository that started the upload, still publishing for the game's studio (it may have been assigned to
    // another studio since).
    const studio = studioFor(id);
    return c.json(await finishUpload(c.req.param('uploadId'), (g) => g.repository_id === id.repositoryId && g.studio_id === studio.id, `github:${id.actor}`, { repository: id.repository }));
  });

  // Vault uploads a build for any studio's game: games that aren't built by the studio's own CI yet (e.g. copied from
  // DoIT, or the version that's live today), so they can be released to the CDN before the studio moves over.
  // Only the admin repository's workflow in its protected environment may call this. A game Vault creates here is
  // marked repository_id 'vault:STUDIO/GAME' and is taken over by the studio's repository on its first CI publish.
  // Body: { studio, game, ref ("v1.0"), ref_type ("tag" | "branch"), files: [{ path, size }], listing? (slug to link) }.
  app.post('/v1/admin/previews', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    if (!isSlug(body.studio)) fail(400, 'studio must be a studio slug');
    if (!isSlug(body.game)) fail(400, 'game must be a lowercase slug like "aqualab"');
    const studio = db.studioBySlug(body.studio);
    if (!studio) fail(404, `unknown studio ${body.studio}`);
    const name = typeof body.ref === 'string' ? sanitizeRefName(body.ref) : null;
    if (!name) fail(400, 'ref must be a branch or tag name like "v1.0"');
    let game = db.game(studio.id, body.game);
    if (!game) {
      game = db.createGame(studio.id, body.game, '', `vault:${studio.slug}/${body.game}`);
      db.audit(`github:${id.actor}`, 'game.create', `${studio.slug}/${body.game}`, { by: 'vault upload' });
      linkSameNamedListing(studio, game);
    }
    if (body.listing !== undefined) {
      const l = db.listing(String(body.listing));
      if (!l || l.studio_id !== studio.id) fail(404, `unknown listing ${studio.slug}:${body.listing}`);
      if (l.game_id !== game.id) { db.linkListing(l.id, game.id); db.audit(`github:${id.actor}`, 'listing.link', `${studio.slug}:${l.slug}`, { game: game.slug }); }
    }
    const refType = body.ref_type === 'branch' ? 'branch' : 'tag';
    return c.json(await startUpload(studio, game, { type: refType, name }, String(body.sha ?? 'vault-upload'), id.actor, body.files));
  });

  app.post('/v1/admin/previews/:uploadId/finalize', async (c) => {
    const id = await admin(c);
    return c.json(await finishUpload(c.req.param('uploadId'), () => true, `github:${id.actor}`, { repository: id.repository, vault_upload: true }));
  });

  // A game availability run from the check-games workflow (scripts/check-games.ts --out), shown on
  // Vault → Game Catalog (the latest run's result per game). Only this repository's workflow in this system's environment may post.
  app.post('/v1/admin/game-checks', async (c) => {
    const id = await admin(c);
    const run = parseRun(await jsonBody(c));
    if (typeof run === 'string') fail(400, run);
    const runId = db.addGameCheck(run, `github:${id.actor}`);
    db.audit(`github:${id.actor}`, 'game_checks.post', run.site, { run: runId, ...run.counts, source: run.source });
    return c.json({ id: runId, counts: run.counts, url: `${deps.portal.baseUrl.replace(/\/+$/, '')}/vault/listings` });
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

  // A publish request filed by the game's own workflow (the action's `mode: request-release`), so a push to a
  // "production" branch or a published GitHub release asks Vault to publish without anyone opening the portal.
  // It asks for the branch or tag in the caller's OIDC token, and only for the test build that same commit uploaded.
  // Body: { game, version?, notes? }. version defaults to the tag name, or BRANCH-SHORTSHA for a branch.
  // Running it again for the same version changes nothing. Vault still approves every release.
  app.post('/v1/release-requests', async (c) => {
    const id = await github(c);
    const body = await jsonBody(c);
    if (!PUBLISH_EVENTS.has(id.eventName)) fail(400, `publish requests come from a push or a published release, not ${id.eventName}`);
    const ref = parseGitRef(id.ref);
    if (!ref) fail(400, `cannot request a release for ref ${id.ref}`);
    const studio = studioFor(id);
    const game = gameFor(studio, id, body.game, { create: false });
    const build = db.build(game.id, ref.name);
    if (!build || build.status !== 'live') fail(409, `there is no test build "${ref.name}" for ${studio.slug}/${game.slug} yet; the upload step must run before the request step`);
    if (build.commit_sha !== id.sha) fail(409, `the test build "${ref.name}" is from commit ${build.commit_sha.slice(0, 7)}, not this run's ${id.sha.slice(0, 7)}; upload this commit first`);
    const version = body.version === undefined || body.version === '' ? (ref.type === 'tag' ? ref.name : `${ref.name}-${id.sha.slice(0, 7)}`) : body.version;
    if (!isVersionName(version)) fail(400, 'version must look like "v1.2" or "m3.2" (letters, numbers, dots, dashes; at most 64 characters)');
    const actor = `github:${id.actor}`;
    const url = `${deps.portal.baseUrl.replace(/\/+$/, '')}/s/${studio.slug}/g/${game.slug}?tab=cdn`;
    if (db.release(game.id, version)) return c.json({ ok: true, status: 'released', version, url });
    const open = db.releaseRequests({ gameId: game.id, status: 'requested' });
    const same = open.find((r) => r.version === version);
    if (same) return c.json({ ok: true, status: 'already-requested', id: same.id, version, url });
    // An earlier automatic request for this branch pointed at a build this push has just replaced.
    for (const r of open.filter((x) => x.ref === ref.name && x.requested_by.startsWith('github:'))) {
      db.decideReleaseRequest(r.id, 'withdrawn', actor, 'Replaced by a newer push.');
      db.audit(actor, 'release.withdraw', `${studio.slug}/${game.slug}/${r.version}`, { replaced_by: version });
    }
    const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 2000)
      : `Requested automatically by ${id.eventName === 'release' ? 'a GitHub release' : `a push to ${ref.name}`} (commit ${id.sha.slice(0, 7)}).`;
    const r = db.createReleaseRequest({ game_id: game.id, ref: ref.name, version, notes, requested_by: actor });
    db.audit(actor, 'release.request', `${studio.slug}/${game.slug}/${version}`, { ref: ref.name, sha: id.sha, repository: id.repository, automatic: true });
    return c.json({ ok: true, status: 'requested', id: r.id, version, url });
  });

  // Scheduled tasks come from Cloud Scheduler, signed as the task invoker service account.
  async function scheduler(c: Context) {
    const token = bearerToken(c.req.header('Authorization'));
    if (!token) fail(401, 'missing bearer token');
    let email: string;
    try {
      email = await verifier.google(token);
    } catch (err) {
      fail(401, `invalid Google ID token: ${(err as Error).message}`);
    }
    if (email !== deps.taskInvokerEmail) fail(403, `${email} may not run tasks`);
  }
  const monitorEnv = { db, staging, fetcher: deps.fetcher ?? guardedFetcher() };

  // From Cloud Scheduler: check every URL monitor and update the test builds of hosted games that changed.
  app.post('/v1/tasks/monitors', async (c) => {
    await scheduler(c);
    return c.json(await checkMonitors(monitorEnv, MONITOR_TASK_BUDGET_MS));
  });

  // Nightly, from Cloud Scheduler: remove branch previews with no push for previewRetentionDays, then check URL
  // monitors for as long as the time budget allows (their own task route, above, has a longer one).
  app.post('/v1/tasks/cleanup', async (c) => {
    await scheduler(c);

    const cutoff = new Date(Date.now() - deps.previewRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const removed: string[] = [];
    const monitored = monitoredBuilds(db); // a monitored game that hasn't changed in 90 days keeps its test build
    for (const b of db.staleBranchBuilds(cutoff)) {
      if (monitored.has(`${b.studio_slug}/${b.game_slug}/${b.ref_name}`)) continue;
      const prefix = previewPrefix(b.studio_slug, b.game_slug, b.ref_name);
      const keys = (await staging.list(prefix)).map((o) => o.key);
      if (keys.length > 0) await staging.deleteKeys(keys);
      db.markBuildDeleted(b.build_id);
      db.audit('system:cleanup', 'preview.expire', prefix, { files: keys.length });
      removed.push(prefix);
    }
    const expiredUploads = db.deleteExpiredUploads();
    const monitors = await checkMonitors(monitorEnv, CLEANUP_MONITOR_BUDGET_MS)
      .catch((err) => { console.error('url monitors:', err); return { checked: [], left: -1 }; });
    return c.json({ removed, expired_uploads: expiredUploads, monitors });
  });

  registerAdminTasks(app, deps, admin);
  registerForms(app, db, deps.forms);
  registerPortal(app, { ...deps, approveRelease, promoteRelease, startUpload, finishUpload, linkSameNamedListing, monitorEnv, previewUrl: (studio: Studio, game: Game, ref: string) => `${deps.stagingPublicUrl}/${previewPrefix(studio, game, ref)}` });
  return app;
}
