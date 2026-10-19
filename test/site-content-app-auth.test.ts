import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, createInstallationTokenSource } from '../src/site-content/app-auth.ts';
import { createSiteContentClient } from '../src/site-content/github-client.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const app = { appId: '123', installationId: '456', privateKey: pem };

test('appJwt is an RS256 JWT for the App, valid 5 minutes', () => {
  const [h, b, s] = appJwt(app, 1000).split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'RS256');
  const body = JSON.parse(Buffer.from(b, 'base64url').toString());
  assert.deepEqual([body.iss, body.iat, body.exp], ['123', 970, 1300]);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')));
});

test('installation token is minted once and reused until near expiry', async () => {
  let calls = 0; let now = 0;
  const f = (async (url: string) => { calls++; assert.match(url, /\/app\/installations\/456\/access_tokens$/);
    return new Response(JSON.stringify({ token: `t${calls}`, expires_at: new Date(now + 3600_000).toISOString() }), { status: 201 }); }) as unknown as typeof fetch;
  const get = createInstallationTokenSource(app, 'https://api.github.com', f, () => now);
  assert.equal(await get(), 't1'); assert.equal(await get(), 't1'); assert.equal(calls, 1);
  now = 3600_000 - 60_000; assert.equal(await get(), 't2');
});

test('the client sends the installation token and never the App key', async () => {
  const seen: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'inst-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
    seen.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response(JSON.stringify({ tree: [], truncated: false, sha: 'a'.repeat(40) }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = createSiteContentClient({ fetch: f, config: { app } });
  await c.listPosts().catch(() => {});
  assert.ok(seen.length > 0 && seen.every((a) => a.endsWith('inst-token')));
});

test('config needs a token or a complete App', async () => {
  await assert.rejects(() => createSiteContentClient({ config: {} }).listPosts(), /Neither VAULT_SITE_APP_ID/);
  await assert.rejects(() => createSiteContentClient({ config: { app: { ...app, installationId: '' } } }).listPosts(), /needs VAULT_SITE_APP_INSTALLATION_ID/);
});
