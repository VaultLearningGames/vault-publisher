// Copying listings' site-path images to the Vault CDN (Vault admins; see ../image-migration.ts). An API only: the
// portal has no page for it. The latest result is kept in settings (lastMigration).
import type { Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import type { MigrationResult } from '../image-migration.ts';
import { copySiteImages, LAST_MIGRATION_KEY as LAST_KEY } from '../listing-ops.ts';
import type { ListingHelpers } from './listings.ts';

export function registerImageMigration(app: Hono, h: ListingHelpers) {
  const { db } = h;
  app.post('/portal/api/vault/listings/migrate-images', async (c) => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can copy site images to the CDN.');
    if (!h.deps.production) fail(503, 'The Vault CDN storage isn’t configured here, so images can’t be copied.');
    const base = String((await jsonBody(c)).base ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(base)) fail(400, 'The site address should start with https://.');
    const r = await copySiteImages(h.deps, base, h.actor(u));
    return c.json({ ok: true, migrated: r.migrated.length, already: r.already, failed: r.failed.length, external: r.external.length, objects_written: r.objects_written });
  });
}

export function lastMigration(h: ListingHelpers): MigrationResult | null {
  try { return JSON.parse(h.db.setting(LAST_KEY) ?? 'null'); } catch { return null; }
}
