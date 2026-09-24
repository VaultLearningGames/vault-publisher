import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headersFor, isSafeFilePath, parseGitRef } from '../src/paths.ts';

test('git refs map to the old DoIT branch naming', () => {
  assert.deepEqual(parseGitRef('refs/heads/staging'), { type: 'branch', name: 'staging' });
  assert.deepEqual(parseGitRef('refs/heads/feature/new-map'), { type: 'branch', name: 'feature_new-map' });
  assert.deepEqual(parseGitRef('refs/tags/m3.1'), { type: 'tag', name: 'm3.1' });
  assert.equal(parseGitRef('refs/pull/1/merge'), null);
  assert.equal(parseGitRef('refs/heads/..'), null);
});

test('safe file paths', () => {
  assert.equal(isSafeFilePath('Build/WebGL.data.gz'), true);
  for (const bad of ['', '/x', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb']) assert.equal(isSafeFilePath(bad), false, bad);
});

test('Unity WebGL headers', () => {
  assert.deepEqual(headersFor('index.html'), { contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' });
  assert.equal(headersFor('Build/x.wasm').contentType, 'application/wasm');
  assert.deepEqual(headersFor('Build/x.framework.js.gz'), {
    contentType: 'text/javascript; charset=utf-8',
    contentEncoding: 'gzip',
    cacheControl: 'public, max-age=60',
  });
  assert.equal(headersFor('Build/x.data.br').contentEncoding, 'br');
  // Unity 2019 decompresses .unityweb itself; no Content-Encoding.
  assert.deepEqual(headersFor('Build/WebGL.data.unityweb'), {
    contentType: 'application/octet-stream',
    cacheControl: 'public, max-age=60',
  });
});
