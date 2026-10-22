// Every change to what the site shows starts the site's deploy run itself, rather than waiting for vault-site's
// catalog-check schedule to notice (David, 2026-10-22: "Any changes made to game or blog data on the Staging portal
// should directly trigger a site rebuild and deploy to the staging site. The same goes for production. I don't like
// the 15 minute timer for anything other than copying in the staging content from production").
//
// These tests assert the dispatch itself — the POST to GitHub's workflow_dispatch — not just the deploy bar, because
// the bug this covers was a bar that said "deploy scheduled" with nothing started: an edit to a game already on the
// site marked the bar and dispatched nothing.
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { flushPendingRebuild, siteDeployWorkflow, DEFAULT_SITE_DEPLOY_WORKFLOW } from '../src/portal/site-rebuild.ts';
import { portalHarness } from './portal-harness.ts';

describe('a change to what the site shows starts the deploy run', () => {
  let t: ReturnType<typeof portalHarness>;
  // Record of dispatches the portal made, so a test can assert one happened (and on which branch).
  let dispatched: { url: string; body: unknown }[];

  const env = {
    SITE_PUBLISHING_ENABLED: '1',
    VAULT_SITE_REPO: 'VaultLearningGames/vault-site',
    VAULT_SITE_BRANCH: 'staging',
    VAULT_SITE_GITHUB_TOKEN: 'test-token',
  };

  // The portal dispatches fire and forget on a 30 s debounce; tests flush the window and read what went out.
  const flush = async () => {
    const outcome = await flushPendingRebuild();
    return outcome;
  };

  beforeEach(async () => {
    // Leave no pending rebuild from a previous test in this process.
    await flushPendingRebuild().catch(() => null);
    dispatched = [];
    t = portalHarness();
  });

  test('the deploy workflow is deploy.yml unless SITE_DEPLOY_WORKFLOW says otherwise', () => {
    assert.equal(siteDeployWorkflow({}), DEFAULT_SITE_DEPLOY_WORKFLOW);
    assert.equal(siteDeployWorkflow({}), 'deploy.yml');
    assert.equal(siteDeployWorkflow({ SITE_DEPLOY_WORKFLOW: 'site.yml' }), 'site.yml');
  });

  test('a rebuild dispatches deploy.yml on the portal’s own branch, with that system as the environment', async () => {
    const fetch = (async (url: string, init: RequestInit) => {
      dispatched.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    requestSiteRebuild('edit:wake:tagline', { fetch, env, debounceMs: 0 });
    const outcome = await flush();

    // debounceMs 0 fires at once, so the flush may find nothing pending; either way exactly one dispatch went out.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(dispatched.length, 1, 'exactly one deploy run is dispatched');
    assert.match(dispatched[0].url, /\/repos\/VaultLearningGames\/vault-site\/actions\/workflows\/deploy\.yml\/dispatches$/);
    // The portal commits to, and builds, its own branch: the staging portal must never build production.
    assert.deepEqual(dispatched[0].body, { ref: 'staging', inputs: { environment: 'staging' } });
    if (outcome) assert.equal(outcome.ok, true);
  });

  test('several changes inside the window start ONE run, not one per change', async () => {
    const fetch = (async (url: string, init: RequestInit) => {
      dispatched.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    // A studio saving three fields in a row is three changes; the site only needs building once.
    requestSiteRebuild('edit:wake:tagline', { fetch, env, debounceMs: 50 });
    requestSiteRebuild('edit:wake:description', { fetch, env, debounceMs: 50 });
    requestSiteRebuild('featured', { fetch, env, debounceMs: 50 });
    const outcome = await flush();

    assert.equal(dispatched.length, 1, 'three changes coalesce into one run');
    assert.ok(outcome?.ok);
    // The run says what it was for, so the Actions log explains why the site rebuilt.
    assert.match(outcome.reason, /edit:wake:tagline/);
    assert.match(outcome.reason, /featured/);
    assert.match(outcome.reason, /coalesced 3 changes/);
  });

  test('a failed dispatch never breaks the change that caused it', async () => {
    const fetch = (async () => new Response('no', { status: 403 })) as unknown as typeof globalThis.fetch;
    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    requestSiteRebuild('edit:wake:tagline', { fetch, env, debounceMs: 50 });
    const outcome = await flush();
    assert.equal(outcome?.ok, false);
    // The token never reaches the message.
    assert.ok(!JSON.stringify(outcome).includes('test-token'));
  });

  test('the token is never written into an error message', async () => {
    const fetch = (async () => { throw new Error('connect ECONNREFUSED using test-token'); }) as unknown as typeof globalThis.fetch;
    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    requestSiteRebuild('edit:wake:tagline', { fetch, env, debounceMs: 50 });
    const outcome = await flush();
    assert.equal(outcome?.ok, false);
    assert.ok(!JSON.stringify(outcome).includes('test-token'), 'the token is redacted');
    if (!outcome.ok) assert.match(outcome.error, /\[redacted\]/);
  });

  test('with publishing off, nothing is dispatched and the change still stands', async () => {
    let calls = 0;
    const fetch = (async () => { calls++; return new Response(null, { status: 204 }); }) as unknown as typeof globalThis.fetch;
    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    requestSiteRebuild('edit:wake:tagline', { fetch, env: { ...env, SITE_PUBLISHING_ENABLED: '0' }, debounceMs: 50 });
    const outcome = await flush();
    assert.equal(calls, 0, 'no run is dispatched');
    assert.equal(outcome?.ok, false);
  });

  test('siteContentChanged marks the deploy bar and starts the run together', async () => {
    const fetch = (async (url: string, init: RequestInit) => {
      dispatched.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const { siteContentChanged } = await import('../src/portal/site-rebuild.ts');
    const { getScheduledDeploy } = await import('../src/deploy-status.ts');

    siteContentChanged(t.db, 'edit:wake:tagline', { fetch, env, debounceMs: 50 });
    const outcome = await flush();

    // The bar must never promise a deploy that nothing started: both, or neither.
    const scheduled = getScheduledDeploy(t.db);
    assert.ok(scheduled, 'the deploy bar says a deploy is scheduled');
    assert.equal(scheduled.reason, 'edit:wake:tagline');
    assert.equal(dispatched.length, 1, 'and a run was actually dispatched');
    assert.ok(outcome?.ok);
  });


  // The GitHub Apps installed on vault-site have Contents: write and Metadata: read, with NO Actions: write, so
  // workflow_dispatch is refused there. deploy.yml also runs `on: push` to the branch, so the rebuild falls back to
  // an empty commit, which starts the same run. Verified against the live installations on 2026-10-22.
  test('a dispatch the credential may not make still starts the run, by committing to the branch', async () => {
    const seen: string[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      seen.push(`${method} ${u.replace('https://api.github.com/repos/VaultLearningGames/vault-site', '')}`);
      if (u.includes('/actions/workflows/')) return new Response('no Actions: write', { status: 403 });
      if (u.includes('/git/ref/heads/')) return Response.json({ object: { sha: 'a'.repeat(40) } });
      if (u.includes('/git/commits/' + 'a'.repeat(40))) return Response.json({ tree: { sha: 'b'.repeat(40) } });
      if (method === 'POST' && u.endsWith('/git/commits')) return Response.json({ sha: 'c'.repeat(40) }, { status: 201 });
      if (method === 'PATCH' && u.includes('/git/refs/heads/')) return Response.json({ object: { sha: 'c'.repeat(40) } });
      throw new Error(`unexpected ${method} ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    requestSiteRebuild('listing.publish:wake', { fetch, debounceMs: 0, env: env });
    const out = await flushPendingRebuild();

    assert.ok(out?.ok, `the rebuild should fall back to a commit: ${out && !out.ok ? out.error : ''}`);
    assert.match(out.workflow, /^push to staging \(ccccccc\)$/);
    // It tried the cheap way first, then committed the same tree as the parent.
    assert.equal(seen[0], 'POST /actions/workflows/deploy.yml/dispatches');
    assert.ok(seen.includes('POST /git/commits'), seen.join(' | '));
    assert.ok(seen.some((s) => s.startsWith('PATCH /git/refs/heads/staging')), seen.join(' | '));
  });

  // A credential that DOES have Actions: write keeps the cheap path: no commit is written to the site repository.
  test('a dispatch the credential may make writes no commit', async () => {
    const seen: string[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    requestSiteRebuild('listing.publish:wake', { fetch, debounceMs: 0, env: env });
    const out = await flushPendingRebuild();

    assert.ok(out?.ok);
    assert.equal(out.workflow, 'deploy.yml');
    assert.equal(seen.length, 1, `only the dispatch, got: ${seen.join(' | ')}`);
    assert.ok(!seen.some((s) => s.includes('/git/')), seen.join(' | '));
  });

  test('an empty reason starts nothing', async () => {
    let calls = 0;
    const fetch = (async () => { calls++; return new Response(null, { status: 204 }); }) as unknown as typeof globalThis.fetch;
    const { requestSiteRebuild } = await import('../src/portal/site-rebuild.ts');
    requestSiteRebuild('   ', { fetch, env, debounceMs: 0 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 0);
    assert.equal(await flushPendingRebuild(), null);
  });
});

// The regression itself, through the portal's real save/publish routes rather than the dispatcher: editing a game
// that is ALREADY on the site used to mark the deploy bar and start nothing, so the edit sat unbuilt until
// vault-site's catalog-check schedule happened to notice. These tests fail on that old behaviour.
describe('editing a game already on the site builds the site', () => {
  let t: ReturnType<typeof portalHarness>;

  // Env for the real dispatch path, set on the process because the portal's routes call requestSiteRebuild() with
  // no deps (production behaviour); the dispatch is intercepted via globalThis.fetch.
  const ENV = {
    SITE_PUBLISHING_ENABLED: '1',
    VAULT_SITE_REPO: 'VaultLearningGames/vault-site',
    VAULT_SITE_BRANCH: 'staging',
    VAULT_SITE_GITHUB_TOKEN: 'test-token',
  };
  let saved: Record<string, string | undefined>;
  let dispatches: { ref: string; environment: string }[];
  let realFetch: typeof globalThis.fetch;

  const full = {
    title: 'Wake', short_description: 'A game about water.',
    about: 'Wake is a game about water quality in the Great Lakes, for middle school science classes.',
    play_url: 'https://play.test/wake', hero_image: 'https://img.test/hero.png',
    makers: ['Field Day Lab'],
  };

  beforeEach(async () => {
    await flushPendingRebuild().catch(() => null);
    saved = {};
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    dispatches = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/actions/workflows/') && u.endsWith('/dispatches')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        dispatches.push({ ref: body.ref, environment: body.inputs?.environment });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    t = portalHarness();
  });

  // Restore the process env and fetch whatever the test did.
  const cleanup = async () => {
    await flushPendingRebuild().catch(() => null);
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };

  test('a Vault edit to a published game dispatches a deploy (not just the bar)', async () => {
    try {
      const boss = t.as('boss', 'admin');
      // A game on the site.
      await boss.post('/portal/api/s/fieldday/listings', { slug: 'wake', title: 'Wake', page_address: 'wake' });
      await boss.post('/portal/api/s/fieldday/listings/wake', { ...full, publish: '1' });
      await flushPendingRebuild();
      assert.equal(dispatches.length, 1, 'publishing a new game builds the site');
      dispatches.length = 0;

      // Now edit it: a short-description change, nothing to do with the published flag.
      const res = await boss.post('/portal/api/s/fieldday/listings/wake', { ...full, short_description: 'A game about water quality.', publish: '1' });
      assert.equal(res.status, 200);
      await flushPendingRebuild();

      // This is the ask: the edit itself starts the deploy, with no timer involved.
      assert.equal(dispatches.length, 1, 'editing a published game dispatches a deploy run');
      assert.deepEqual(dispatches[0], { ref: 'staging', environment: 'staging' });
    } finally { await cleanup(); }
  });

  test('a save that changes nothing the site shows does not build', async () => {
    try {
      const boss = t.as('boss', 'admin');
      await boss.post('/portal/api/s/fieldday/listings', { slug: 'wake', title: 'Wake', page_address: 'wake' });
      await boss.post('/portal/api/s/fieldday/listings/wake', { ...full, publish: '1' });
      await flushPendingRebuild();
      dispatches.length = 0;

      // The same values again: the catalog is byte-identical, so a build would be noise.
      await boss.post('/portal/api/s/fieldday/listings/wake', { ...full, publish: '1' });
      await flushPendingRebuild();
      assert.equal(dispatches.length, 0, 'an identical re-publish builds nothing');
    } finally { await cleanup(); }
  });

  test('taking a game off the site builds the site', async () => {
    try {
      const boss = t.as('boss', 'admin');
      await boss.post('/portal/api/s/fieldday/listings', { slug: 'wake', title: 'Wake', page_address: 'wake' });
      await boss.post('/portal/api/s/fieldday/listings/wake', { ...full, publish: '1' });
      await flushPendingRebuild();
      dispatches.length = 0;

      await boss.post('/portal/api/s/fieldday/listings/wake/unpublish');
      await flushPendingRebuild();
      assert.equal(dispatches.length, 1, 'unpublishing dispatches a deploy run');
    } finally { await cleanup(); }
  });

  test('changing the home page’s featured games builds the site', async () => {
    try {
      const boss = t.as('boss', 'admin');
      await boss.post('/portal/api/s/fieldday/listings', { slug: 'wake', title: 'Wake', page_address: 'wake' });
      await boss.post('/portal/api/s/fieldday/listings/wake', { ...full, publish: '1' });
      await flushPendingRebuild();
      dispatches.length = 0;

      const res = await boss.post('/portal/api/vault/featured', { op: 'feature', slug: 'wake', featured: true });
      assert.equal(res.status, 200, await res.text());
      await flushPendingRebuild();
      assert.equal(dispatches.length, 1, 'a featured change dispatches a deploy run');
    } finally { await cleanup(); }
  });
});
