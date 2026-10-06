import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GitHubIdentity } from '../src/auth.ts';
import type { Db } from '../src/db.ts';
import { EMPTY_LISTING } from '../src/listings.ts';
import { portalHarness } from './portal-harness.ts';

const deployer: GitHubIdentity = { owner: 'VaultLearningGames', ownerId: '1', repository: 'VaultLearningGames/vault-publisher', repositoryId: '900', ref: 'refs/heads/production', sha: 'abc', actor: 'ann', eventName: 'workflow_dispatch', environment: 'production' };
const tokens: Record<string, GitHubIdentity> = { deployer, otherEnv: { ...deployer, environment: 'staging' }, otherRepo: { ...deployer, repository: 'fielddaylab/wake', repositoryId: '100' } };

let h: ReturnType<typeof portalHarness>, db: Db;
beforeEach(() => {
  h = portalHarness({ verifier: { async github(t) { if (!tokens[t]) throw new Error('bad signature'); return tokens[t]; }, async google() { throw new Error('no'); } } });
  db = h.db;
});

const report = (body: unknown, token: string | null = 'deployer') => h.app.request('/v1/admin/site-builds', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const build = async (msAgo: number, slugs: string[]) => assert.equal((await report({ catalog_at: iso(msAgo), slugs, source: 'https://github.com/o/r/actions/runs/1' })).status, 200);
const page = async (path: string, who = h.as('boss', 'admin')) => { const r = await who.get(path); assert.equal(r.status, 200, path); return r.text(); };

function bloom() {
  const s = db.studioBySlug('fieldday')!;
  const l = db.createListing(s.id, 'bloom', { ...EMPTY_LISTING, title: 'Bloom', play_url: 'https://bloom.test/' }, 'test');
  return l.id;
}

describe('POST /v1/admin/site-builds', () => {
  test('needs this repository’s workflow in this system’s environment', async () => {
    const body = { catalog_at: iso(0), slugs: [] };
    assert.equal((await report(body, null)).status, 401);
    assert.equal((await report(body, 'forged')).status, 401);
    assert.equal((await report(body, 'otherEnv')).status, 403);
    assert.equal((await report(body, 'otherRepo')).status, 403);
    assert.equal(db.lastSiteBuild(), undefined);
  });

  test('checks the catalog time and the slugs', async () => {
    assert.equal((await report({ catalog_at: 'yesterday', slugs: [] })).status, 400);
    assert.equal((await report({ catalog_at: iso(-60 * 60_000), slugs: [] })).status, 400);   // an hour ahead
    assert.equal((await report({ catalog_at: iso(0), slugs: 'bloom' })).status, 400);
    assert.equal((await report({ catalog_at: iso(0), slugs: [3] })).status, 400);
    assert.equal(db.lastSiteBuild(), undefined);
  });

  test('stores the build; the newest catalog is the one the site shows, whatever order the reports come in', async () => {
    const at = iso(1000);
    const r = await report({ catalog_at: at, slugs: ['bloom', 'wake'], source: 'https://github.com/o/r/actions/runs/7' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { id: 1, catalog_at: at, games: 2 });
    await build(60_000, ['wake']);   // an older catalog reported later
    const b = db.lastSiteBuild()!;
    assert.equal(b.catalog_at, at);
    assert.deepEqual(b.slugs, ['bloom', 'wake']);
    assert.equal(b.source, 'https://github.com/o/r/actions/runs/7');
    assert.equal(b.built_by, 'github:ann');
  });
});

describe('Publishing to the site, across the portal', () => {
  test('nothing is shown before any build has reported', async () => {
    db.publishListing(bloom(), 'test');
    assert.doesNotMatch(await page('/s/fieldday'), /Publishing/);
    assert.doesNotMatch(await page('/s/fieldday/g/bloom'), /Publishing/);
  });

  test('a first publish after the last build: the studio list, the game page and Vault’s catalog say so, until a build has it', async () => {
    await build(60_000, ['wake']);
    db.publishListing(bloom(), 'test');
    for (const path of ['/s/fieldday', '/s/fieldday/g/bloom', '/vault/listings']) assert.match(await page(path), /Publishing to the site/, path);
    const game = await page('/s/fieldday/g/bloom');
    assert.match(game, /doesn’t show this yet/);
    assert.match(game, /actions\/workflows\/deploy\.yml/);                    // Vault staff get the rebuild link
    assert.doesNotMatch(game, /On the site since/);
    const member = await page('/s/fieldday/g/bloom', h.as('mia', 'none', 'maintainer'));
    assert.match(member, /Publishing to the site/);
    assert.match(member, /Vault rebuilds the site/);
    assert.doesNotMatch(member, /deploy\.yml/);

    await build(0, ['wake', 'bloom']);
    for (const path of ['/s/fieldday', '/s/fieldday/g/bloom', '/vault/listings']) assert.doesNotMatch(await page(path), /Publishing/, path);
    assert.match(await page('/s/fieldday/g/bloom'), /On the site since/);
  });

  test('a new version of a game already on the site: “Publishing changes” next to “On the site”', async () => {
    const id = bloom();
    db.publishListing(id, 'test');
    await new Promise((r) => setTimeout(r, 5));
    await build(0, ['bloom']);
    await new Promise((r) => setTimeout(r, 5));
    db.publishListing(id, 'test');
    const html = await page('/vault/listings');
    assert.match(html, /On the site/);
    assert.match(html, /Publishing changes/);
  });

  test('taken off the site: “Coming off the site” until a build without it', async () => {
    const id = bloom();
    db.publishListing(id, 'test');
    await new Promise((r) => setTimeout(r, 5));
    await build(0, ['bloom']);
    await new Promise((r) => setTimeout(r, 5));
    db.unpublishListing(id);
    assert.match(await page('/s/fieldday/g/bloom'), /Coming off the site/);
    await build(-1, []);
    assert.doesNotMatch(await page('/s/fieldday/g/bloom'), /Coming off the site/);
  });
});
