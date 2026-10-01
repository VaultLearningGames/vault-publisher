// Vault → Site games: API that copies listing images which are still site paths to the Vault CDN (Vault admins
// only). The portal card that called it was removed; the endpoint is retained pending cleanup. See
// ../image-migration.ts. The latest result is kept in settings.
import type { Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import { migrateListingImages } from '../image-migration.ts';
import type { ListingHelpers } from './listings.ts';

const LAST_KEY = 'listing_image_migration';

export function registerImageMigration(app: Hono, h: ListingHelpers) {
  const { db } = h;
  let running = false;
  // UI removed; endpoint retained pending cleanup.
  app.post('/portal/api/vault/listings/migrate-images', async (c) => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can copy site images to the CDN.');
    if (!h.deps.production) fail(503, 'The Vault CDN storage isn’t configured here, so images can’t be copied.');
    const base = String((await jsonBody(c)).base ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(base)) fail(400, 'The site address should start with https://.');
    if (running) fail(409, 'A copy is already running; try again in a minute.');
    running = true;
    try {
      const r = await migrateListingImages({ db, production: h.deps.production, prodPublicUrl: h.deps.prodPublicUrl, base, actor: h.actor(u), fetch: h.deps.fetch });
      db.setSetting(LAST_KEY, JSON.stringify(r));
      return c.json({ ok: true, migrated: r.migrated.length, already: r.already, failed: r.failed.length, external: r.external.length, objects_written: r.objects_written });
    } finally {
      running = false;
    }
  });
}
