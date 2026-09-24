import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createApp } from './app.ts';
import { createVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { createR2Storage } from './storage.ts';

const config = loadConfig();
const db = new Db(config.dbPath);
db.syncStudios(JSON.parse(readFileSync(config.studiosFile, 'utf8')));

const app = createApp({
  db,
  staging: createR2Storage({
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucket: config.stagingBucket,
  }),
  verifier: createVerifier({ githubAudience: config.oidcAudience, googleAudience: config.taskAudience }),
  stagingPublicUrl: config.stagingPublicUrl,
  previewRetentionDays: config.previewRetentionDays,
  taskInvokerEmail: config.taskInvokerEmail,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`vault-publisher listening on :${info.port}`);
});

// Cloud Run sends SIGTERM before stopping an instance; close SQLite cleanly so Litestream has everything.
process.on('SIGTERM', () => {
  server.close(() => {
    db.sqlite.close();
    process.exit(0);
  });
});
