// GitHub App authentication: sign a short JWT with the App's private key, trade it for an installation token (valid
// about an hour), and cache that token until shortly before it expires. Used by github-client.ts.
import { createSign } from 'node:crypto';
import type { AppCredentials } from './config.ts';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function appJwt(app: AppCredentials, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: nowSec - 30, exp: nowSec + 300, iss: app.appId }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(app.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

export interface InstallationToken { token: string; expiresAt: number }

export function createInstallationTokenSource(app: AppCredentials, apiBase: string, doFetch: typeof fetch, now: () => number = Date.now) {
  let cached: InstallationToken | undefined;
  return async function getToken(): Promise<string> {
    if (cached && cached.expiresAt - now() > 5 * 60_000) return cached.token;
    const res = await doFetch(`${apiBase}/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appJwt(app, Math.floor(now() / 1000))}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vault-portal' },
    });
    const j = await res.json().catch(() => ({})) as { token?: string; expires_at?: string; message?: string };
    if (res.status !== 201 || !j.token) throw new Error(`GitHub App token request failed: ${res.status} ${j.message ?? ''}`.trim());
    cached = { token: j.token, expiresAt: j.expires_at ? Date.parse(j.expires_at) : now() + 50 * 60_000 };
    return cached.token;
  };
}
