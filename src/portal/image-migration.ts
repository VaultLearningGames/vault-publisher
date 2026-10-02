// Vault → Game Catalog: "Copy site images to the Vault CDN" (Vault admins). See ../image-migration.ts. The latest
// result is kept in settings and shown on the page.
import type { Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import type { MigrationItem, MigrationResult } from '../image-migration.ts';
import { copySiteImages, LAST_MIGRATION_KEY as LAST_KEY } from '../listing-ops.ts';
import { html, type Html } from './html.ts';
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

// The card on Vault → Game Catalog (Vault admins only).
export function migrationCard(h: ListingHelpers): Html {
  const last = lastMigration(h);
  const where = (i: MigrationItem) => html`<span class="mono small">${i.listing}</span> <span class="small muted">${i.where} ${i.field}</span>`;
  const list = (items: MigrationItem[], line: (i: MigrationItem) => Html) =>
    html`<ul class="small mig-list">${items.slice(0, 200).map((i) => html`<li>${where(i)} ${line(i)}</li>`)}${items.length > 200 ? html`<li class="muted">…and ${items.length - 200} more</li>` : ''}</ul>`;
  const summary = last ? html`<div class="mig-result"><p class="small"><b>Last run</b> ${last.ran_at.slice(0, 16).replace('T', ' ')} UTC by ${last.by}, from <span class="mono">${last.base}</span>:
      <b>${last.migrated.length}</b> migrated (${last.objects_written} new files), <b>${last.already}</b> already on the CDN, <b>${last.failed.length}</b> failed, <b>${last.external.length}</b> external links left alone.</p>
      ${last.failed.length ? html`<details open><summary class="small">Failed (${last.failed.length})</summary>${list(last.failed, (i) => html`<span class="mono small">${i.from}</span>: <span class="err">${i.reason}</span>`)}</details>` : ''}
      ${last.external.length ? html`<details><summary class="small">External links left alone (${last.external.length})</summary>${list(last.external, (i) => html`<a class="mono small" href="${i.from}" target="_blank" rel="noopener">${i.from}</a>`)}</details>` : ''}
      ${last.migrated.length ? html`<details><summary class="small">Migrated (${last.migrated.length})</summary>${list(last.migrated, (i) => html`<span class="mono small">${i.from}</span> → <a class="mono small" href="${i.to}" target="_blank" rel="noopener">${i.to!.split('/').pop()}</a>`)}</details>` : ''}
    </div>` : '';
  return html`<div class="card" style="margin-top:22px"><h2>Copy site images to the Vault CDN</h2>
    <p class="small">Listings imported from the site point at images in the website repo (<span class="mono">games/x/img/hero.png</span>). This downloads every such hero image, thumbnail, screenshot and featured image, published and draft, from the site below, stores it on the Vault CDN like an upload (<span class="mono">STUDIO/GAME/_vault-assets/</span>) and points the listing at it. Published listings change only those links, so nothing needs review again. Links to other sites are left alone. Running it again only picks up what’s new or failed.</p>
    ${h.deps.production ? html`<form data-api="/portal/api/vault/listings/migrate-images" data-then="reload" data-confirm="Copy every site-path image to the Vault CDN and relink the listings?" data-busy="Downloading and copying images. This can take a minute; keep this page open." class="inline-form">
      <label class="field"><span class="lab">Download images from</span><input type="text" name="base" value="${h.deps.siteUrl ?? ''}" required placeholder="https://vaultlearninggames.org" style="min-width:320px"></label>
      <button class="btn brass">Copy images</button><span class="err" role="status" aria-live="polite"></span></form>`
      : html`<p class="small muted">Needs the Vault CDN storage, which isn’t configured here.</p>`}
    ${summary}</div>`;
}
