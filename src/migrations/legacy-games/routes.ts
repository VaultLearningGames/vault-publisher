// The admin endpoints of the games.json import (run.ts), authorized like the other admin tasks (a GitHub OIDC token
// of the admin repository's workflow, or ADMIN_TASK_TOKEN). scripts/import-legacy-games.ts drives them:
//
//   GET  /v1/admin/legacy-games                 the last applied run's report
//   POST /v1/admin/legacy-games/plan            { games, source?, dry_run }   the report; with dry_run false, writes
//   POST /v1/admin/legacy-games/image           { slug, field, index?, from, source, source_url, image (base64),
//                                                 in?, cropped?, upscaled?, quality?, dry_run }   one re-hosted image
//   POST /v1/admin/legacy-games/rollback        { dry_run }
//
// Every POST takes dry_run: true (the default of the script), which answers with what would change and writes nothing.
import type { Context, Hono } from 'hono';
import { fail, jsonBody, type AppDeps } from '../../app.ts';
import type { GitHubIdentity } from '../../auth.ts';
import { isSlug } from '../../paths.ts';
import { IMAGE_FIELD_KEYS } from './images.ts';
import { parseLegacy } from './legacy.ts';
import { acceptLegacyImage, lastReport, rollbackLegacyImport, runLegacyImport } from './run.ts';
import type { LegacyImageField } from './types.ts';

const running = new WeakSet<object>();

function dryRunOf(body: Record<string, unknown>): boolean {
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') fail(400, 'dry_run must be true or false');
  return body.dry_run !== false;
}

export function registerLegacyGamesApi(app: Hono, deps: AppDeps, admin: (c: Context) => Promise<GitHubIdentity>) {
  const { db } = deps;
  const actorOf = (id: GitHubIdentity) => `github:${id.actor}`;

  app.get('/v1/admin/legacy-games', async (c) => {
    await admin(c);
    return c.json({ report: lastReport(db) });
  });

  app.post('/v1/admin/legacy-games/plan', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRunOf(body);
    const data = parseLegacy(body.games);
    const source = typeof body.source === 'string' ? body.source.slice(0, 300) : undefined;
    // One applying run at a time (they read and write the same records).
    if (!dry && running.has(db)) fail(409, 'An import is already running; try again in a minute.');
    if (!dry) running.add(db);
    try {
      return c.json(runLegacyImport(deps, data, actorOf(id), { dryRun: dry, source }));
    } finally {
      if (!dry) running.delete(db);
    }
  });

  app.post('/v1/admin/legacy-games/image', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRunOf(body);
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const slug = str('slug');
    if (!isSlug(slug)) fail(400, 'slug must be a listing slug');
    const field = str('field') as LegacyImageField;
    if (!IMAGE_FIELD_KEYS.includes(field)) fail(400, `field must be one of ${IMAGE_FIELD_KEYS.join(', ')}`);
    if (typeof body.image !== 'string' || !body.image) fail(400, 'image must be the compressed image, base64');
    const index = body.index === undefined || body.index === null ? undefined : Number(body.index);
    if (index !== undefined && !(Number.isInteger(index) && index >= 0 && index < 40)) fail(400, 'index must be a whole number from 0 to 39');
    const size = body.in as { w?: unknown; h?: unknown } | undefined;
    const r = await acceptLegacyImage(deps, {
      slug, field, index, from: str('from'), source: str('source'), source_url: str('source_url'),
      image: new Uint8Array(Buffer.from(body.image as string, 'base64')),
      in: size && Number.isInteger(size.w) && Number.isInteger(size.h) ? { w: size.w as number, h: size.h as number } : null,
      cropped: Number(body.cropped) || 0, upscaled: body.upscaled === true,
      quality: typeof body.quality === 'number' ? body.quality : null,
    }, actorOf(id), dry);
    return c.json({ dry_run: dry, ...r });
  });

  app.post('/v1/admin/legacy-games/rollback', async (c) => {
    const id = await admin(c);
    const dry = dryRunOf(await jsonBody(c));
    return c.json(rollbackLegacyImport(db, actorOf(id), dry));
  });
}
