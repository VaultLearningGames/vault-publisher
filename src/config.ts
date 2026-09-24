export interface Config {
  port: number;
  dbPath: string;
  studiosFile: string;
  // Audience GitHub Actions must request for their OIDC token.
  oidcAudience: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  stagingBucket: string;
  stagingPublicUrl: string;
  // Production is optional so the service still runs (staging only) until its key exists.
  prodAccessKeyId?: string;
  prodSecretAccessKey?: string;
  prodBucket: string;
  prodPublicUrl: string;
  // Release actions are accepted only from this repository's workflow, in this GitHub environment.
  adminRepository: string;
  adminEnvironment: string;
  previewRetentionDays: number;
  // Cloud Scheduler calls /v1/tasks/cleanup with a Google-signed ID token for this service account.
  taskInvokerEmail: string;
  taskAudience: string;
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
    oidcAudience: process.env.OIDC_AUDIENCE ?? 'vault-publisher',
    r2AccountId: required('R2_ACCOUNT_ID'),
    r2AccessKeyId: required('R2_ACCESS_KEY_ID'),
    r2SecretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    stagingBucket: process.env.STAGING_BUCKET ?? 'cdn-vaultlearninggames-staging',
    stagingPublicUrl: (process.env.STAGING_PUBLIC_URL ?? 'https://cdn.vaultlearninggames-staging.org').replace(/\/+$/, ''),
    prodAccessKeyId: process.env.R2_PROD_ACCESS_KEY_ID?.trim() || undefined,
    prodSecretAccessKey: process.env.R2_PROD_SECRET_ACCESS_KEY?.trim() || undefined,
    prodBucket: process.env.PROD_BUCKET ?? 'cdn-vaultlearninggames',
    prodPublicUrl: (process.env.PROD_PUBLIC_URL ?? 'https://cdn.vaultlearninggames.org').replace(/\/+$/, ''),
    adminRepository: process.env.ADMIN_REPOSITORY ?? 'fielddaylab/vault-publisher',
    adminEnvironment: process.env.ADMIN_ENVIRONMENT ?? 'production',
    previewRetentionDays: Number(process.env.PREVIEW_RETENTION_DAYS ?? 90),
    taskInvokerEmail: required('TASK_INVOKER_EMAIL'),
    taskAudience: process.env.TASK_AUDIENCE ?? 'vault-publisher-tasks',
  };
}
