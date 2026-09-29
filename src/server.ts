import { serve } from '@hono/node-server';
import { existsSync, readFileSync } from 'node:fs';
import { createApp } from './app.ts';
import { createVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { relayoutReleases } from './releases.ts';
import { createR2Storage } from './storage.ts';
import { googleSheets } from './forms.ts';

const config = loadConfig();
const db = new Db(config.dbPath);
db.syncStudios(JSON.parse(readFileSync(config.studiosFile, 'utf8')));
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
  },
  previewRetentionDays: config.previewRetentionDays,
  siteUrl: config.siteUrl,
  previewSites: config.previewSites,
  taskInvokerEmail: config.taskInvokerEmail,
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
