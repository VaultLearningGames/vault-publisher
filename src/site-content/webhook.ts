// GitHub's push webhook for the vault-site repository. A push by a person (not by this portal's own App) means the
// blog's files may have changed under the portal, so the post-list cache is dropped and the next list reads them again.
// Signed with VAULT_SITE_WEBHOOK_SECRET (X-Hub-Signature-256); without the secret the endpoint answers 503.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signatureValid(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(header.slice('sha256='.length));
  return want.length === got.length && timingSafeEqual(want, got);
}

export type PushVerdict = { action: 'invalidate'; sender: string; ref: string } | { action: 'ignore'; reason: string };

export function judgePush(event: string | undefined, payload: unknown, ownLogins: string[]): PushVerdict {
  if (event === 'ping') return { action: 'ignore', reason: 'ping' };
  if (event !== 'push') return { action: 'ignore', reason: `event ${event ?? 'none'}` };
  const p = (payload ?? {}) as { ref?: unknown; sender?: { login?: unknown; type?: unknown } };
  const login = typeof p.sender?.login === 'string' ? p.sender.login : '';
  const ref = typeof p.ref === 'string' ? p.ref : '';
  if (ownLogins.map((l) => l.toLowerCase()).includes(login.toLowerCase())) return { action: 'ignore', reason: 'pushed by this portal' };
  return { action: 'invalidate', sender: login, ref };
}
