import { createRemoteJWKSet, jwtVerify } from 'jose';

// Claims from a GitHub Actions OIDC token that the publisher relies on.
// https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
export interface GitHubIdentity {
  owner: string;
  ownerId: string;
  repository: string;
  repositoryId: string;
  ref: string;
  sha: string;
  actor: string;
  eventName: string;
  // Set when the job runs in a GitHub deployment environment (e.g. "production" with required reviewers).
  environment?: string;
}

export interface Verifier {
  github(token: string): Promise<GitHubIdentity>;
  // Returns the verified email of a Google service account (Cloud Scheduler).
  google(token: string): Promise<string>;
}

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

function claim(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== 'string' || value === '') throw new Error(`token is missing claim ${name}`);
  return value;
}

export function createVerifier(opts: { githubAudience: string; googleAudience: string }): Verifier {
  const githubKeys = createRemoteJWKSet(new URL(`${GITHUB_ISSUER}/.well-known/jwks`));
  const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

  return {
    async github(token) {
      const { payload } = await jwtVerify(token, githubKeys, {
        issuer: GITHUB_ISSUER,
        audience: opts.githubAudience,
      });
      const p = payload as Record<string, unknown>;
      return {
        owner: claim(p, 'repository_owner'),
        ownerId: claim(p, 'repository_owner_id'),
        repository: claim(p, 'repository'),
        repositoryId: claim(p, 'repository_id'),
        ref: claim(p, 'ref'),
        sha: claim(p, 'sha'),
        actor: claim(p, 'actor'),
        eventName: claim(p, 'event_name'),
        environment: typeof p.environment === 'string' ? p.environment : undefined,
      };
    },

    async google(token) {
      const { payload } = await jwtVerify(token, googleKeys, {
        issuer: GOOGLE_ISSUERS,
        audience: opts.googleAudience,
      });
      if (payload.email_verified !== true) throw new Error('email not verified');
      return claim(payload as Record<string, unknown>, 'email');
    },
  };
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
