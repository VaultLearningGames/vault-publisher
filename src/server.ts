import { serve } from '@hono/node-server';
import { existsSync, readFileSync } from 'node:fs';
import { createApp } from './app.ts';
import { createVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { relayoutReleases } from './releases.ts';
import { createR2Storage } from './storage.ts';
import { googleSheets } from './forms.ts';
import { syncStudiosFile } from './studios-file.ts';
import { Analytics } from './analytics/ga.ts';
import { buildCatalog } from './catalog.ts';
import { clearPreviewTemp, hugoRunner, SitePreviewer } from './portal/site-preview.ts';
import { resolveSiteDir } from './site-dir.ts';

const config = loadConfig();
const db = new Db(config.dbPath);
// studios.json is authoritative for the studios it lists and the repositories it assigns to them; studios created
// and repositories assigned in the portal are left alone. Conflicts are logged and skipped.
syncStudiosFile(db, JSON.parse(readFileSync(config.studiosFile, 'utf8')));
// Websites for studios that have never had one; the portal is where they're changed after that.
if (existsSync(config.studioWebsitesFile)) {
  const seeded = db.seedStudioWebsites(JSON.parse(readFileSync(config.studioWebsitesFile, 'utf8')));
  if (seeded.set.length) console.log(`studio websites: set ${seeded.set.join(', ')}`);
  if (seeded.invalid.length) console.error(`studio websites: skipped invalid entries for ${seeded.invalid.join(', ')}`);
}

const production =
  config.prodAccessKeyId && config.prodSecretAccessKey
    ? createR2Storage({
        accountId: config.r2AccountId,
        accessKeyId: config.prodAccessKeyId,
        secretAccessKey: config.prodSecretAccessKey,
        bucket: config.prodBucket,
      })
    : null;

// Listing and blog previews are rendered here, with the website's templates: Hugo on the vault-site source (the pinned
// copy in the image, the enclosing vault-site checkout in development, or SITE_DIR: site-dir.ts).
let siteDir: string | null = null;
try { siteDir = resolveSiteDir(); } catch (err) { console.error(`previews: ${(err as Error).message}; /_preview/ answers 503`); }
const sitePreview = siteDir
  ? new SitePreviewer({
      siteDir,
      siteUrl: config.siteUrl,
      portalUrl: config.portalUrl,
      hugo: hugoRunner(config.hugoBin),
      catalog: () => buildCatalog(db, config.prodPublicUrl),
    })
  : null;
if (sitePreview) { console.log(`previews: site source at ${siteDir}`); void clearPreviewTemp(); }

const app = createApp({
  db,
  staging: createR2Storage({
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucket: config.stagingBucket,
  }),
  production,
  verifier: createVerifier({ githubAudience: config.oidcAudience, googleAudience: config.taskAudience }),
  stagingPublicUrl: config.stagingPublicUrl,
  prodPublicUrl: config.prodPublicUrl,
  adminRepository: config.adminRepository,
  adminEnvironment: config.adminEnvironment,
  portal: {
    githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret,
    sessionSecret: config.sessionSecret,
    baseUrl: config.portalUrl,
    vaultAdmins: config.vaultAdmins,
    supportUrl: config.supportUrl,
    deployStatus: {
      token: config.deployStatusGithubToken,
      environment: config.deployEnvironment,
      stagingBranch: config.deployStatusStagingBranch,
      productionBranch: config.deployStatusProductionBranch,
    },
  },
  previewRetentionDays: config.previewRetentionDays,
  siteUrl: config.siteUrl,
  previewSites: config.previewSites,
  sitePreview,
  taskInvokerEmail: config.taskInvokerEmail,
  analytics: new Analytics({ propertyId: config.gaPropertyId, timeZone: config.gaTimeZone }),
  forms: {
    allowedOrigins: config.formsAllowedOrigins,
    sheets: { newsletter: config.formsNewsletterSheet, 'submit-game': config.formsSubmitGameSheet },
    client: googleSheets(),
  },
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`vault-publisher listening on :${info.port}`);
});

// One-time: move releases from STUDIO/GAME/VERSION/ to STUDIO/GAME/_releases/VERSION/ and serve the current
// one in place. Runs in the background after startup; retried on the next start if it fails.
if (production && db.setting('release_layout') !== '2') {
  relayoutReleases(production, db.allReleases())
    .then(() => { db.setSetting('release_layout', '2'); console.log('relayout: done'); })
    .catch((err) => console.error('relayout failed; will retry on next start:', err));
}

// Cloud Run sends SIGTERM before stopping an instance; close SQLite cleanly so Litestream has everything.
process.on('SIGTERM', () => {
  server.close(() => {
    db.sqlite.close();
    process.exit(0);
  });
});
