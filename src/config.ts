export interface Config {
  port: number;
  dbPath: string;
  studiosFile: string;
  // Studios' websites to fill in when a studio has none yet (see Db.seedStudioWebsites).
  studioWebsitesFile: string;
  // Audience GitHub Actions must request for their OIDC token.
  oidcAudience: string;
  r2AccountId: string;
  // The builds bucket (BUILDS_*) holds studios' test builds; the CDN bucket (CDN_*) holds releases.
  // Internally these are still "staging" and "prod"; they are not the staging and production systems.
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  stagingBucket: string;
  stagingPublicUrl: string;
  // The CDN key is optional so the service still runs (builds only) until it exists.
  prodAccessKeyId?: string;
  prodSecretAccessKey?: string;
  prodBucket: string;
  prodPublicUrl: string;
  // Release actions are accepted only from this repository's workflow, in this GitHub environment.
  adminRepository: string;
  adminEnvironment: string;
  // Web portal: GitHub OAuth app, session signing key, public URL, bootstrap Vault admins.
  githubClientId?: string;
  githubClientSecret?: string;
  sessionSecret?: string;
  portalUrl: string;
  vaultAdmins: string[];
  previewRetentionDays: number;
  // Cloud Scheduler calls /v1/tasks/cleanup with a Google-signed ID token for this service account.
  taskInvokerEmail: string;
  taskAudience: string;
  // Public website forms (src/forms.ts): the site origins allowed to post, and each form's spreadsheet.
  formsAllowedOrigins: string[];
  formsNewsletterSheet?: string;
  formsSubmitGameSheet?: string;
}

function required(name: string): string {
  // Trimmed because secrets pasted into Secret Manager often carry a trailing newline.
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    dbPath: process.env.DB_PATH ?? 'data/publisher.db',
    studiosFile: process.env.STUDIOS_FILE ?? 'studios.json',
    studioWebsitesFile: process.env.STUDIO_WEBSITES_FILE ?? 'studio-websites.json',
    oidcAudience: process.env.OIDC_AUDIENCE ?? 'vault-publisher',
    r2AccountId: required('R2_ACCOUNT_ID'),
    // No defaults for buckets or URLs: the production and staging systems run the same image, and a
    // missing variable must stop the service rather than point it at the other system's buckets.
    r2AccessKeyId: required('R2_BUILDS_ACCESS_KEY_ID'),
    r2SecretAccessKey: required('R2_BUILDS_SECRET_ACCESS_KEY'),
    stagingBucket: required('BUILDS_BUCKET'),
    stagingPublicUrl: required('BUILDS_PUBLIC_URL').replace(/\/+$/, ''),
    prodAccessKeyId: process.env.R2_CDN_ACCESS_KEY_ID?.trim() || undefined,
    prodSecretAccessKey: process.env.R2_CDN_SECRET_ACCESS_KEY?.trim() || undefined,
    prodBucket: required('CDN_BUCKET'),
    prodPublicUrl: required('CDN_PUBLIC_URL').replace(/\/+$/, ''),
    adminRepository: process.env.ADMIN_REPOSITORY ?? 'VaultLearningGames/vault-publisher',
    adminEnvironment: process.env.ADMIN_ENVIRONMENT?.trim() || 'production',
    githubClientId: process.env.GITHUB_CLIENT_ID?.trim() || undefined,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() || undefined,
    sessionSecret: process.env.SESSION_SECRET?.trim() || undefined,
    portalUrl: required('PORTAL_URL').replace(/\/+$/, ''),
    vaultAdmins: (process.env.VAULT_ADMINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    previewRetentionDays: Number(process.env.PREVIEW_RETENTION_DAYS ?? 90),
    taskInvokerEmail: required('TASK_INVOKER_EMAIL'),
    taskAudience: process.env.TASK_AUDIENCE ?? 'vault-publisher-tasks',
    // Space-separated: the deploy action splits env_vars values on commas.
    formsAllowedOrigins: (process.env.FORMS_ALLOWED_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean),
    formsNewsletterSheet: process.env.FORMS_NEWSLETTER_SHEET?.trim() || undefined,
    formsSubmitGameSheet: process.env.FORMS_SUBMIT_GAME_SHEET?.trim() || undefined,
  };
}
