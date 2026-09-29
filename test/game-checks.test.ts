import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import type { GitHubIdentity, Verifier } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import { classify, countLevels, framingFor, parseRun, shouldRetry, sortForReport, type Probe } from '../src/game-checks.ts';
import { signSession } from '../src/portal/session.ts';
import type { Storage } from '../src/storage.ts';

const SITE = 'https://vaultlearninggames.org';
const probe = (p: Partial<Probe> = {}): Probe => ({ status: 200, final_url: null, redirects: [], ms: 300, attempts: 1, headers: {}, error: null, ...p });
const inPage = { url: 'https://games.example.org/play/', embed: true };
const newTab = { url: 'https://games.example.org/play/', embed: false };
const run = (g: Partial<Probe>, game = inPage) => classify(game, probe(g), { siteOrigin: SITE });

describe('framing', () => {
  const doc = 'https://games.example.org/play/';
  const allowed = (headers: Record<string, string>, site = SITE) => framingFor(headers, doc, site).allowed;

  test('no headers, or X-Frame-Options values browsers ignore, allow framing', () => {
    assert.equal(allowed({}), true);
    assert.equal(allowed({ 'x-frame-options': 'ALLOW-FROM https://vaultlearninggames.org' }), true);
    assert.equal(allowed({ 'x-frame-options': 'SAMEORIGIN, SAMEORIGIN' }), false); // one value after de-duplication
  });

  test('X-Frame-Options DENY, SAMEORIGIN (from another origin) and conflicting values block', () => {
    assert.equal(allowed({ 'x-frame-options': 'DENY' }), false);
    assert.equal(allowed({ 'x-frame-options': 'sameorigin' }), false);
    assert.equal(allowed({ 'x-frame-options': 'SAMEORIGIN' }, 'https://games.example.org'), true);
    assert.equal(allowed({ 'x-frame-options': 'DENY, SAMEORIGIN' }), false);
  });

  test('CSP frame-ancestors source lists', () => {
    const fa = (v: string, site = SITE) => allowed({ 'content-security-policy': `default-src 'self'; frame-ancestors ${v}` }, site);
    assert.equal(fa("'none'"), false);
    assert.equal(fa("'self'"), false);
    assert.equal(fa("'self'", 'https://games.example.org'), true);
    assert.equal(fa('*'), true);
    assert.equal(fa('https:'), true);
    assert.equal(fa('https://vaultlearninggames.org'), true);
    assert.equal(fa('vaultlearninggames.org'), true);
    assert.equal(fa('https://*.vaultlearninggames.org'), false); // subdomains only
    assert.equal(fa("'self' https://*.vaultlearninggames-staging.org"), false);
    assert.equal(fa('https://*.vaultlearninggames-staging.org', 'https://www.vaultlearninggames-staging.org'), true);
    assert.equal(fa('https://vaultlearninggames.org:8443'), false);
  });

  test('CSP frame-ancestors overrides X-Frame-Options, and every policy must allow', () => {
    assert.equal(allowed({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }), true);
    assert.equal(allowed({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'self'" }), false);
    assert.equal(allowed({ 'content-security-policy': "default-src 'self'" , 'x-frame-options': 'DENY' }), false);
  });
});

describe('classifying a game', () => {
  test('a quick 200 with no restrictions is ok', () => {
    const r = run({});
    assert.equal(r.level, 'ok');
    assert.deepEqual(r.problems, []);
    assert.equal(r.framing?.allowed, true);
  });

  test('unreachable games and error statuses fail', () => {
    assert.match(run({ status: null, error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } }).problems[0], /DNS/);
    assert.match(run({ status: null, error: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' } }).problems[0], /certificate/);
    assert.match(run({ status: null, error: { code: 'TimeoutError', message: 'timed out' } }).problems[0], /No response within 15 s/);
    assert.match(run({ status: null, error: { code: 'ECONNREFUSED', message: '' } }).problems[0], /Connection failed/);
    const notFound = run({ status: 404 });
    assert.equal(notFound.level, 'fail');
    assert.deepEqual(notFound.problems, ['HTTP 404 Not Found']);
    assert.equal(run({ status: 503 }).level, 'fail');
    assert.equal(classify({ url: '', embed: true }, null, { siteOrigin: SITE }).level, 'fail');
  });

  test('framing blocked fails an in-page game but not a new-tab one', () => {
    const blocked = run({ headers: { 'x-frame-options': 'SAMEORIGIN' } });
    assert.equal(blocked.level, 'fail');
    assert.match(blocked.problems[0], /Refuses to load in the site's player \(X-Frame-Options: SAMEORIGIN\)/);
    const tab = run({ headers: { 'x-frame-options': 'SAMEORIGIN' } }, newTab);
    assert.equal(tab.level, 'ok');
    assert.equal(tab.framing, null);
  });

  test('framing is judged on the page it ends up at', () => {
    const r = run({ final_url: 'https://vaultlearninggames.org/games/x/', redirects: ['https://vaultlearninggames.org/games/x/'], headers: { 'x-frame-options': 'SAMEORIGIN' } });
    assert.equal(r.framing?.allowed, true);
  });

  test('http:// play URLs fail in the https site player, and are a warning in a new tab', () => {
    assert.equal(run({}, { url: 'http://games.example.org/', embed: true }).level, 'fail');
    assert.equal(run({}, { url: 'http://games.example.org/', embed: false }).level, 'warn');
    assert.equal(run({ final_url: 'http://games.example.org/play/' }).level, 'fail');
  });

  test('slow answers, cross-site redirects, home-page redirects and retries are warnings', () => {
    assert.deepEqual(run({ ms: 7200 }).problems, ['Slow: 7.2 s to respond']);
    const moved = run({ final_url: 'https://newhost.example.com/play/', redirects: ['https://newhost.example.com/play/'] });
    assert.equal(moved.level, 'warn');
    assert.match(moved.problems[0], /another site: newhost\.example\.com/);
    assert.equal(run({ final_url: 'https://www.games.example.org/play/' }).level, 'ok'); // www. is the same site
    assert.equal(run({ final_url: 'https://games.example.org/play' }).level, 'ok');
    assert.match(run({ final_url: 'https://games.example.org/' }).problems[0], /home page/);
    assert.match(run({ attempts: 2 }).problems[0], /second try/);
  });

  test('bot protection and rate limits are a warning, not a failure', () => {
    assert.equal(run({ status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' } }).level, 'warn');
    assert.equal(run({ status: 403, headers: { server: 'cloudflare' } }).level, 'warn');
    assert.equal(run({ status: 429 }).level, 'warn');
    assert.equal(run({ status: 403, headers: { server: 'nginx' } }).level, 'fail');
  });

  test('retries transient failures only', () => {
    assert.equal(shouldRetry(probe({ status: 502 })), true);
    assert.equal(shouldRetry(probe({ status: null, error: { code: 'ECONNRESET', message: '' } })), true);
    assert.equal(shouldRetry(probe({ status: null, error: { code: 'ENOTFOUND', message: '' } })), false);
    assert.equal(shouldRetry(probe({ status: 404 })), false);
  });

  test('reports sort failing games first', () => {
    const games = [{ slug: 'a', title: 'A', level: 'ok' as const }, { slug: 'b', title: 'B', level: 'fail' as const }, { slug: 'c', title: 'C', level: 'warn' as const }];
    assert.deepEqual(sortForReport(games).map((g) => g.slug), ['b', 'c', 'a']);
    assert.deepEqual(countLevels(games), { ok: 1, warn: 1, fail: 1 });
  });
});

describe('parsing a posted run', () => {
  const body = { checked_at: '2026-09-29T11:00:00Z', site: SITE, source: 'https://github.com/x/y/actions/runs/1', games: [{ slug: 'a', level: 'fail', url: 'https://a.test/', problems: ['HTTP 404 Not Found'] }] };
  test('recomputes the counts and fills in defaults', () => {
    const r = parseRun({ ...body, counts: { ok: 99 } });
    assert.ok(typeof r !== 'string');
    assert.deepEqual(r.counts, { ok: 0, warn: 0, fail: 1 });
    assert.equal(r.games[0].embed, true);
    assert.equal(r.checked_at, '2026-09-29T11:00:00.000Z');
  });
  test('rejects unusable runs', () => {
    assert.equal(typeof parseRun({ ...body, games: 'x' }), 'string');
    assert.equal(typeof parseRun({ ...body, checked_at: 'yesterday' }), 'string');
    assert.equal(typeof parseRun({ ...body, site: 'vaultlearninggames.org' }), 'string');
    assert.equal(typeof parseRun({ ...body, games: [{ slug: 'a', level: 'broken' }] }), 'string');
  });
});

// ---------- the API and the portal page ----------
const checker: GitHubIdentity = { owner: 'VaultLearningGames', ownerId: '1', repository: 'VaultLearningGames/vault-publisher', repositoryId: '900', ref: 'refs/heads/main', sha: 'abc', actor: 'github-actions', eventName: 'schedule', environment: 'staging' };
const identities: Record<string, GitHubIdentity> = {
  checker,
  otherEnv: { ...checker, environment: 'production' },
  otherRepo: { ...checker, repository: 'fielddaylab/wake', repositoryId: '100' },
};
const verifier: Verifier = { async github(t) { if (!identities[t]) throw new Error('bad signature'); return identities[t]; }, async google() { throw new Error('no'); } };
const noStorage = {} as Storage;
const SECRET = 'test-session-secret';

let db: Db, app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = new Db(':memory:');
  db.syncStudios([{ slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' }]);
  app = createApp({
    db, staging: noStorage, production: null, verifier,
    stagingPublicUrl: 'https://stg.test', prodPublicUrl: 'https://prod.test',
    adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'staging',
    previewRetentionDays: 90, taskInvokerEmail: 'x@y',
    portal: { baseUrl: 'https://portal.test', sessionSecret: SECRET, vaultAdmins: [], oauth: { authorizeUrl: () => '', exchange: async () => { throw new Error('no'); } } },
  });
});

const post = (token: string | null, body: unknown) => app.request('/v1/admin/game-checks', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const posted = (games: unknown[], checked_at = '2026-09-29T11:00:00Z') => ({ checked_at, site: SITE, source: 'https://github.com/VaultLearningGames/vault-publisher/actions/runs/42', games });
const game = (slug: string, level: string, problems: string[] = []) => ({ slug, title: slug.toUpperCase(), studio: 'fieldday', url: `https://${slug}.test/`, source: 'url', embed: true, status: level === 'fail' ? 404 : 200, ms: 200, attempts: 1, level, problems, redirects: [] });
function as(login: string, role: 'none' | 'release_manager' | 'admin', studioRole?: 'viewer') {
  const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
  db.setVaultRole(u.id, role);
  if (studioRole) db.setMembership(db.studioBySlug('fieldday')!.id, login, studioRole, 'test');
  return (path: string) => app.request(path, { headers: { Cookie: `vault_session=${signSession(u.id, SECRET)}` } });
}

describe('POST /v1/admin/game-checks', () => {
  test('needs this repository’s workflow in this system’s environment', async () => {
    assert.equal((await post(null, posted([]))).status, 401);
    assert.equal((await post('forged', posted([]))).status, 401);
    assert.equal((await post('otherEnv', posted([]))).status, 403);
    assert.equal((await post('otherRepo', posted([]))).status, 403);
    assert.equal(db.gameChecks().length, 0);
  });

  test('rejects a malformed run', async () => {
    const r = await post('checker', { ...posted([]), games: [{ level: 'ok' }] });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).error, /slug/);
  });

  test('stores runs and lists them newest first', async () => {
    const r1 = await post('checker', posted([game('aqualab', 'ok'), game('bloom', 'fail', ['HTTP 404 Not Found'])], '2026-09-28T11:00:00Z'));
    assert.equal(r1.status, 200);
    const j1 = (await r1.json()) as any;
    assert.deepEqual(j1.counts, { ok: 1, warn: 0, fail: 1 });
    assert.equal(j1.url, 'https://portal.test/vault/listings');
    const r2 = await post('checker', posted([game('aqualab', 'ok'), game('bloom', 'warn', ['Slow: 6.0 s to respond'])]));
    const j2 = (await r2.json()) as any;
    const runs = db.gameChecks();
    assert.deepEqual(runs.map((r) => r.id), [j2.id, j1.id]);
    assert.equal(runs[1].fail_count, 1);
    assert.equal(runs[0].source, 'https://github.com/VaultLearningGames/vault-publisher/actions/runs/42');
    assert.equal(runs[0].posted_by, 'github:github-actions');
    assert.equal(db.gameCheck()!.games[1].level, 'warn');
    assert.equal(db.gameCheck(j1.id)!.games[1].problems[0], 'HTTP 404 Not Found');
    assert.equal(db.recentAudit(1)[0].action, 'game_checks.post');
  });
});

describe('game availability in the portal', () => {
  test('a published game’s page shows its latest result', async () => {
    const s = db.studioBySlug('fieldday')!;
    const l = db.createListing(s.id, 'bloom', { ...(await import('../src/listings.ts')).EMPTY_LISTING, title: 'Bloom', play_url: 'https://bloom.test/' }, 'test');
    db.publishListing(l.id, 'test');
    await post('checker', posted([game('bloom', 'fail', ['HTTP 404 Not Found'])]));
    const staff = await (await as('rm', 'release_manager')('/s/fieldday/g/bloom')).text();
    assert.match(staff, /HTTP 404 Not Found · checked/);
    assert.match(staff, /href="\/vault\/listings#game-bloom"/);
    const member = await (await as('vera', 'none', 'viewer')('/s/fieldday/g/bloom')).text();
    assert.match(member, /HTTP 404 Not Found · checked/);
    assert.doesNotMatch(member, /vault\/listings/);
  });
});
