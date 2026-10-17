import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { judgePush, signatureValid } from '../src/site-content/webhook.ts';

const sig = (s: string, b: string) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;

test('signature must match the body and secret', () => {
  assert.ok(signatureValid('s', '{"a":1}', sig('s', '{"a":1}')));
  assert.ok(!signatureValid('s', '{"a":2}', sig('s', '{"a":1}')));
  assert.ok(!signatureValid('x', '{"a":1}', sig('s', '{"a":1}')));
  assert.ok(!signatureValid('', 'b', 'sha256=')); assert.ok(!signatureValid('s', 'b', undefined)); assert.ok(!signatureValid('s', 'b', 'sha256=ab'));
});

test('human pushes invalidate; the portal App and non-push events do not', () => {
  const own = ['vault-portal-staging[bot]'];
  assert.deepEqual(judgePush('push', { ref: 'refs/heads/main', sender: { login: 'mrdavidgagnon' } }, own), { action: 'invalidate', sender: 'mrdavidgagnon', ref: 'refs/heads/main' });
  assert.equal(judgePush('push', { sender: { login: 'Vault-Portal-Staging[bot]' } }, own).action, 'ignore');
  assert.equal(judgePush('ping', {}, own).action, 'ignore');
  assert.equal(judgePush('issues', {}, own).action, 'ignore');
});
