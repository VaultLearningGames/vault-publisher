// Access tokens for Google APIs as the portal's identity (Application Default Credentials, without Google's client
// library): on Cloud Run, the service's runtime service account from the metadata server; elsewhere, the file
// GOOGLE_APPLICATION_CREDENTIALS names or gcloud's application-default file (a person's `gcloud auth
// application-default login`, or a service account key).
import { importPKCS8, SignJWT } from 'jose';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TokenSource = () => Promise<{ token: string; quotaProject?: string }>;

export class NoCredentialsError extends Error {}

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

export function adcFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (named) return named;
  const base = env.CLOUDSDK_CONFIG?.trim() || (process.platform === 'win32' ? join(env.APPDATA ?? '', 'gcloud') : join(homedir(), '.config', 'gcloud'));
  const f = join(base, 'application_default_credentials.json');
  return existsSync(f) ? f : null;
}

// One token source for `scope`, reusing each token until a minute before it expires.
export function googleTokenSource(scope: string, opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): TokenSource {
  const f = opts.fetch ?? fetch;
  const env = opts.env ?? process.env;
  let cached: { token: string; quotaProject?: string; expires: number } | null = null;
  let pending: Promise<{ token: string; quotaProject?: string }> | null = null;

  async function fetchToken(): Promise<{ token: string; quotaProject?: string; expiresIn: number }> {
    // Cloud Run sets K_SERVICE; its metadata server issues tokens with the scopes asked for.
    if (env.K_SERVICE) {
      const res = await f(`${METADATA}?scopes=${encodeURIComponent(scope)}`, { headers: { 'Metadata-Flavor': 'Google' } });
      if (!res.ok) throw new NoCredentialsError(`metadata server token: HTTP ${res.status}`);
      const b = (await res.json()) as { access_token: string; expires_in: number };
      return { token: b.access_token, expiresIn: b.expires_in };
    }
    const file = adcFile(env);
    if (!file) throw new NoCredentialsError('no Google credentials (not on Cloud Run, and no application default credentials)');
    const cred = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    let body: URLSearchParams;
    if (cred.type === 'authorized_user') {
      body = new URLSearchParams({ grant_type: 'refresh_token', client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token });
    } else if (cred.type === 'service_account') {
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({ scope })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(cred.private_key_id ? { kid: cred.private_key_id } : {}) })
        .setIssuer(cred.client_email).setSubject(cred.client_email).setAudience(cred.token_uri || TOKEN_URI)
        .setIssuedAt(now).setExpirationTime(now + 3600)
        .sign(await importPKCS8(cred.private_key, 'RS256'));
      body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    } else {
      throw new NoCredentialsError(`unsupported credentials type "${cred.type}" in ${file}`);
    }
    const res = await f(cred.token_uri || TOKEN_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const b = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!res.ok || !b.access_token) throw new NoCredentialsError(`Google token: ${b.error_description || b.error || `HTTP ${res.status}`}`);
    return { token: b.access_token, quotaProject: cred.quota_project_id || undefined, expiresIn: b.expires_in ?? 3600 };
  }

  return async () => {
    if (cached && cached.expires > Date.now() + 60_000) return cached;
    pending ??= fetchToken().then((t) => {
      cached = { token: t.token, quotaProject: t.quotaProject, expires: Date.now() + t.expiresIn * 1000 };
      return cached;
    }).finally(() => { pending = null; });
    return pending;
  };
}
