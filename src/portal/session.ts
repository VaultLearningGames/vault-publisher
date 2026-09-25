// Signed session cookie: base64url(JSON {uid, exp}) + "." + HMAC-SHA256. HttpOnly, Secure, SameSite=Lax.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'vault_session';
export const SESSION_DAYS = 14;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function signSession(uid: number, secret: string, days = SESSION_DAYS): string {
  const payload = b64(JSON.stringify({ uid, exp: Date.now() + days * 86400_000 }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(value: string | undefined, secret: string): number | null {
  if (!value) return null;
  const [payload, mac] = value.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof uid === 'number' && typeof exp === 'number' && exp > Date.now() ? uid : null;
  } catch {
    return null;
  }
}

export const randomToken = () => randomBytes(18).toString('base64url');
