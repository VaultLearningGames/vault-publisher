import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GitHubIdentity } from '../src/auth.ts';
import type { Db } from '../src/db.ts';
import { countFindings, finishRun, type Finding } from '../src/site-checks.ts';
import { portalHarness } from './portal-harness.ts';

const SITE = 'https://vaultlearninggames.org';
const checker: GitHubIdentity = { owner: 'VaultLearningGames', ownerId: '1', repository: 'VaultLearningGames/vault-publisher', repositoryId: '900', ref: 'refs/heads/main', sha: 'abc', actor: 'github-actions', eventName: 'schedule', environment: 'production' };
const tokens: Record<string, GitHubIdentity> = { checker, otherEnv: { ...checker, environment: 'staging' }, otherRepo: { ...checker, repository: 'fielddaylab/wake', repositoryId: '100' }, ann: { ...checker, actor: 'ann' } };

const finding = (f: Partial<Finding> = {}): Finding => ({ check: 'links', level: 'fail', code: 'link.broken', page: '/wake/', target: 'https://gone.example.org/x', message: 'The link leads to a page that isn’t there (HTTP 404)', pages: ['/wake/', '/about/'], count: 2, ...f });
// What scripts/check-site.ts --out writes.
const posted = (findings: Finding[] = [], more: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...finishRun({ site: SITE, checks: ['links', 'spelling'], started_at: '2026-10-02T11:47:00.000Z', source: 'https://github.com/o/r/actions/runs/1', started_by: 'cli', pages: 12, games: 3 },
    [{ check: 'links', status: 'done', checked: 40, ms: 2000, findings: [] }, { check: 'spelling', status: 'done', checked: 900, ms: 500, findings: [] }]),
  findings, counts: countFindings(findings), ...more,
});

let h: ReturnType<typeof portalHarness>, db: Db;
beforeEach(() => {
  h = portalHarness({
    siteUrl: SITE,
    verifier: { async github(t) { if (!tokens[t]) throw new Error('bad signature'); return tokens[t]; }, async google() { throw new Error('no'); } },
  });
  db = h.db;
});

const api = (method: string, path: string, token: string | null, body?: unknown) => h.app.request(path, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});
const post = (token: string | null = 'checker', body: unknown = posted()) => api('POST', '/v1/admin/site-checks', token, body);
const postRun = async (findings: Finding[] = [], more: Record<string, unknown> = {}) => (((await (await post('checker', posted(findings, more))).json()) as any).id as number);
const rm = () => h.as('rm', 'release_manager');

describe('POST /v1/admin/site-checks', () => {
  test('needs this repository’s workflow in this system’s environment', async () => {
    assert.equal((await post(null)).status, 401);
    assert.equal((await post('forged')).status, 401);
    assert.equal((await post('otherEnv')).status, 403);
    assert.equal((await post('otherRepo')).status, 403);
    assert.equal(db.siteChecks().length, 0);
  });

  test('stores the run, answers with its id, counts and page, and writes an audit row', async () => {
    const r = await post('checker', posted([finding(), finding({ level: 'warn', code: 'link.unverified', target: 'https://x.example.org/' })]));
    assert.equal(r.status, 200);
    const j = (await r.json()) as any;
    assert.deepEqual(j, { id: j.id, counts: { warn: 1, fail: 1 }, url: `https://portal.test/vault/site-checks/${j.id}` });
    const row = db.siteCheck(j.id)!;
    assert.deepEqual([row.status, row.site, row.pages, row.games, row.fail_count, row.warn_count], ['done', SITE, 12, 3, 1, 1]);
    assert.deepEqual(row.checks, ['links', 'spelling']);
    assert.equal(row.source, 'https://github.com/o/r/actions/runs/1');
    assert.equal(row.run.findings.length, 2);
    assert.equal(db.siteCheck()!.id, j.id);
    const audit = db.auditFor(['site_checks.post'])[0];
    assert.equal(audit.actor, 'github:github-actions');
    assert.equal(audit.target, SITE);
    assert.deepEqual(JSON.parse(audit.detail_json!), { run: j.id, warn: 1, fail: 1, source: 'https://github.com/o/r/actions/runs/1' });
  });

  test('started_by comes from the token, whatever the body says', async () => {
    const id = (((await (await post('ann', posted([], { started_by: 'user:mallory' }))).json()) as any).id as number);
    assert.equal(db.siteCheck(id)!.started_by, 'github:ann');
    assert.equal(db.siteCheck(id)!.run.started_by, 'github:ann');
  });

  test('counts are worked out from the findings, and strings are trimmed', async () => {
    const id = await postRun([finding({ message: 'm'.repeat(5000), target: 't'.repeat(5000) })], {
      counts: { warn: 99, fail: 0 }, summaries: [{ check: 'links', status: 'done', note: 'n'.repeat(900), checked: 40, ms: 1, warn: 50, fail: 50 }],
    });
    const run = db.siteCheck(id)!.run;
    assert.deepEqual(run.counts, { warn: 0, fail: 1 });
    assert.equal(db.siteCheck(id)!.fail_count, 1);
    assert.deepEqual([run.summaries[0].warn, run.summaries[0].fail, run.summaries[0].note.length], [0, 1, 500]);
    assert.deepEqual([run.findings[0].message.length, run.findings[0].target.length], [1000, 2000]);
  });

  test('rejects bad bodies with parseRun’s message and stores nothing', async () => {
    const cases: [unknown, RegExp][] = [
      [{}, /site must be/],
      [posted([], { site: 'ftp://x' }), /site must be/],
      [posted([], { status: 'running' }), /status/],
      [posted([], { checks: ['nope'] }), /unknown check nope/],
      [posted([], { finished_at: 'never' }), /finished_at/],
      [posted([], { source: 'http://x' }), /source/],
      [posted([], { pages: -1 }), /pages/],
      [posted([finding({ level: 'info' as 'warn' })]), /level/],
      [posted([finding({ check: 'games' })]), /one of the run's checks/],
    ];
    for (const [body, match] of cases) {
      const r = await post('checker', body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(((await r.json()) as any).error, match);
    }
    assert.equal((await post('checker', [1])).status, 400);
    assert.equal(db.siteChecks().length, 0);
  });

  test('keeps the most recent 60 runs', async () => {
    for (let i = 0; i < 62; i++) await postRun();
    const runs = db.siteChecks(100);
    assert.equal(runs.length, 60);
    assert.equal(runs.at(-1)!.id, 3);
    assert.equal(db.siteCheck()!.id, 62);
    assert.equal(db.siteCheck(1), undefined);
  });

  test('no start or poll routes remain', async () => {
    const id = await postRun();
    assert.equal((await api('GET', `/v1/admin/site-checks/${id}`, 'checker')).status, 404);
    assert.equal((await api('GET', '/v1/admin/site-checks/latest', 'checker')).status, 404);
    assert.equal((await rm().post('/portal/api/vault/site-checks', {})).status, 404);
    assert.equal((await rm().get(`/portal/api/vault/site-checks/${id}`)).status, 404);
    assert.equal(db.siteChecks().length, 1);
  });
});

describe('GET /v1/site-checks/badge/:name (the README dashboard)', () => {
  const badge = async (name: string) => { const r = await h.app.request(`/v1/site-checks/badge/${name}`); return { status: r.status, cache: r.headers.get('cache-control'), json: (await r.json()) as any }; };

  test('public, cacheable, and grey before any run', async () => {
    const b = await badge('links');
    assert.equal(b.status, 200);
    assert.equal(b.cache, 'public, max-age=300');
    assert.deepEqual(b.json, { schemaVersion: 1, label: 'broken links', message: 'no runs yet', color: 'lightgrey', cacheSeconds: 300 });
    assert.equal((await badge('all')).json.message, 'no runs yet');
    assert.equal((await badge('when')).json.message, 'never');
    assert.equal((await badge('typos')).status, 404);
  });

  test('each check, the run as a whole and when it ran, from the latest run', async () => {
    await postRun([finding(), finding({ level: 'warn', code: 'link.unverified', target: 'https://x.example.org/' }), finding({ check: 'spelling', level: 'warn', code: 'spelling.unknown', target: 'widsom' })]);
    assert.deepEqual([(await badge('links')).json.message, (await badge('links')).json.color], ['1 failing · 1 to look at', 'red']);
    assert.deepEqual([(await badge('spelling')).json.message, (await badge('spelling')).json.color], ['1 to look at', 'yellow']);
    assert.equal((await badge('all')).json.message, '1 failing · 2 to look at');
    assert.match((await badge('when')).json.message, /^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    assert.equal((await badge('games')).json.message, 'no runs yet');   // no run has included it
    // The badges say how many, never what.
    assert.doesNotMatch(JSON.stringify((await badge('links')).json), /gone\.example/);
  });

  test('a later run of one check updates that check and leaves the others as they were', async () => {
    await postRun([finding(), finding({ check: 'spelling', level: 'warn', code: 'spelling.unknown', target: 'widsom' })]);
    const linksOnly = { ...posted([]), checks: ['links'], summaries: [{ check: 'links', status: 'done', note: '', checked: 40, warn: 0, fail: 0, ms: 1 }] };
    assert.equal((await post('checker', linksOnly)).status, 200);
    assert.deepEqual([(await badge('links')).json.message, (await badge('links')).json.color], ['passing', 'brightgreen']);
    assert.equal((await badge('spelling')).json.message, '1 to look at');
    assert.equal((await badge('all')).json.message, 'passing');
  });
});

describe('the portal pages', () => {
  test('staff only', async () => {
    const id = await postRun();
    for (const path of ['/vault/site-checks', `/vault/site-checks/${id}`]) {
      assert.equal((await h.as('vera', 'none', 'viewer').get(path)).status, 403);
      assert.equal((await rm().get(path)).status, 200);
    }
    assert.equal((await h.app.request('/vault/site-checks')).status, 302);
  });

  test('the list page with no runs: a button to GitHub, no form, and the nav link', async () => {
    const text = await (await rm().get('/vault/site-checks')).text();
    assert.match(text, /No site checks have run yet/);
    assert.match(text, /href="https:\/\/github\.com\/VaultLearningGames\/vault-publisher\/actions\/workflows\/check-site\.yml"[^>]*>Run the checks ↗/);
    assert.match(text, /run in GitHub each day/);
    assert.doesNotMatch(text, /name="check:|data-api|data-poll|Running/);
    assert.match(text, /href="\/vault\/site-checks" class="on">Site checks/);
    assert.equal((await rm().get('/vault/site-checks/999')).status, 404);
    assert.equal((await rm().get('/vault/site-checks/abc')).status, 404);
  });

  test('a posted run: summary, findings, escaped text, pages folded away', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const long = `https://cdn.example.org/${'a'.repeat(200)}.png`;
    const id = await postRun([
      finding({ message: `Broken: ${hostile}`, target: 'javascript:alert("x")" onmouseover="y', pages: ['/wake/', '/about/', '/contact/'], count: 25 }),
      finding({ level: 'warn', code: 'asset.missing', target: long, message: 'An image didn’t load', pages: ['/'], count: 1, page: '/' }),
      finding({ check: 'spelling', level: 'warn', code: 'spelling.unknown', target: 'teh', message: '“teh” isn’t in the dictionary', page: '', pages: [''], count: 1 }),
    ]);
    const text = await (await rm().get(`/vault/site-checks/${id}`)).text();
    assert.match(text, /1 failing, 2 worth a look, across 12 pages and 3 games/);
    assert.match(text, /Broken links/);
    assert.match(text, /Spelling/);
    assert.doesNotMatch(text, /<img src=x/);
    assert.match(text, /Broken: &lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(text, /href="javascript:/);
    assert.doesNotMatch(text, /" onmouseover="/);
    assert.match(text, /<a href="https:\/\/vaultlearninggames\.org\/wake\/"/);
    assert.match(text, /and 24 more/);
    assert.match(text, /and 22 more not listed/);
    assert.match(text, new RegExp(`title="${long}"`));
    assert.doesNotMatch(text, new RegExp(`>${long}<`));
    assert.match(text, /The site as a whole/);
    assert.match(text, /class="pill p-bad"[^>]*>Failing/);
    assert.match(text, /class="pill p-wait"[^>]*>Worth a look/);
    assert.match(text, /github-actions/);
    assert.match(text, /href="https:\/\/github\.com\/o\/r\/actions\/runs\/1"/);
    assert.match(text, /took \d+ (min|s)/);
    assert.doesNotMatch(text, /data-poll/);
    const list = await (await rm().get('/vault/site-checks')).text();
    assert.match(list, new RegExp(`href="/vault/site-checks/${id}"`));
    assert.match(list, /Latest run/);
    assert.match(list, /Broken links, Spelling/);
    assert.match(list, /GitHub run ↗/);
  });

  test('hostile text in other fields is escaped too: the run’s error and a summary note', async () => {
    const hostile = '<script>alert(1)</script>';
    const id = await postRun([], {
      status: 'error', error: `The site said ${hostile}`,
      summaries: [{ check: 'links', status: 'error', note: `Crashed ${hostile}`, checked: 0, ms: 5 }],
    });
    const text = await (await rm().get(`/vault/site-checks/${id}`)).text();
    assert.doesNotMatch(text, /<script>alert/);
    assert.match(text, /The site said &lt;script&gt;/);
    assert.match(text, /Crashed &lt;script&gt;/);
    assert.match(text, /Didn’t finish/);
    const list = await (await rm().get('/vault/site-checks')).text();
    assert.doesNotMatch(list, /<script>alert/);
    assert.match(list, /Didn’t finish/);
  });

  test('a run with nothing found, and a skipped check', async () => {
    const id = await postRun([], { summaries: [{ check: 'links', status: 'skipped', note: 'No links were found', checked: 0, ms: 0 }] });
    const text = await (await rm().get(`/vault/site-checks/${id}`)).text();
    assert.match(text, /No links were found/);
    assert.match(text, /found nothing to fix/);
    assert.match(text, /Skipped/);
  });

  test('the latest run is first, and an older one is still reachable', async () => {
    const first = await postRun([finding()]);
    const second = await postRun([]);
    const list = await (await rm().get('/vault/site-checks')).text();
    assert.ok(list.indexOf(`/vault/site-checks/${second}"`) < list.indexOf(`/vault/site-checks/${first}"`));
    assert.match(await (await rm().get(`/vault/site-checks/${first}`)).text(), /Broken links/);
  });
});

describe('a check’s details', () => {
  const missing = (n: number, f: Partial<Finding> = {}): Finding => finding({ check: 'assets', code: 'asset.missing', target: `https://vaultlearninggames.org/img/${n}.png`, message: 'A image answers HTTP 404',
    page: '/wake/', pages: ['/wake/', '/about/'], count: 2, detail: { status: 404, error: null, type: 'image', element: 'img' }, ...f });
  const withAssets = (findings: Finding[], more: Record<string, unknown> = {}) => postRun(findings, {
    checks: ['assets', 'links'], detail_version: 2,
    summaries: [{ check: 'assets', status: 'done', note: '', checked: 12, ms: 1 }, { check: 'links', status: 'done', note: '', checked: 40, ms: 1 }], ...more,
  });

  test('each check that found something has a Details button opening a table of its findings, on both pages', async () => {
    const id = await withAssets([missing(1), missing(2, { level: 'warn', target: '=HYPERLINK("x")', detail: { status: null, error: 'net::ERR_FAILED', type: 'font', element: 'a stylesheet (@font-face)' } }),
      finding({ detail: { status: 404, kind: 'link', text: 'Our <b>partners</b>', error: null, final: null } })]);
    for (const path of [`/vault/site-checks/${id}`, '/vault/site-checks']) {
      const text = await (await rm().get(path)).text();
      // The row and its button: keyboard-operable, says whether it's open and what it opens.
      assert.match(text, new RegExp(`<tr id="check-assets" class="has-details" data-details="details-${id}-assets">`));
      assert.match(text, new RegExp(`<button type="button" class="feat-open" aria-expanded="false" aria-controls="details-${id}-assets"[^>]*>Details`));
      assert.match(text, new RegExp(`<tr class="feat-edit check-details" id="details-${id}-assets" hidden>`));
      // The assets table: the file, its answer, the element and the pages, with links that open in a new tab.
      assert.match(text, /<button type="button" class="th-sort" data-sort="1">File<\/button>[\s\S]*>Answer<[\s\S]*>Asked for by<[\s\S]*>Used on</);
      assert.match(text, /<a class="mono cut" href="https:\/\/vaultlearninggames\.org\/img\/1\.png" target="_blank" rel="noopener"/);
      assert.match(text, /data-v="HTTP 404" data-s="404"><span class="mono nowrap">HTTP 404/);
      assert.match(text, /net::ERR_FAILED/);
      assert.match(text, /a stylesheet \(@font-face\)/);
      assert.match(text, /<a href="https:\/\/vaultlearninggames\.org\/about\/" target="_blank" rel="noopener"/);
      // The links table: the link's text, escaped.
      assert.match(text, />Link text</);
      assert.match(text, /Our &lt;b&gt;partners&lt;\/b&gt;/);
      assert.match(text, /data-filter/);
      assert.match(text, /data-copy-csv/);
      assert.match(text, new RegExp(`href="/vault/site-checks/${id}/findings\\.csv\\?check=assets" download`));
      assert.doesNotMatch(text, /recorded before the checks kept every detail/);
    }
  });

  test('a check with nothing found has no Details; the CSV has every column; staff only', async () => {
    const id = await withAssets([missing(1), missing(2, { target: '=HYPERLINK("x")', message: 'Say "hi", then go' })]);
    const text = await (await rm().get(`/vault/site-checks/${id}`)).text();
    assert.doesNotMatch(text, /aria-controls="details-\d+-links"/);
    const res = await rm().get(`/vault/site-checks/${id}/findings.csv?check=assets`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/csv/);
    assert.match(res.headers.get('content-disposition')!, new RegExp(`site-check-${id}-assets\\.csv`));
    const csv = (await res.text()).split('\r\n');
    assert.equal(csv[0], 'Level,File,Answer,Asked for by,Problem,Used on,Code');
    assert.equal(csv[1], 'Failing,https://vaultlearninggames.org/img/1.png,HTTP 404,img,A image answers HTTP 404,/wake/ /about/,asset.missing');
    assert.equal(csv[2], `Failing,"'=HYPERLINK(""x"")",HTTP 404,img,"Say ""hi"", then go",/wake/ /about/,asset.missing`);   // a formula is text
    assert.equal(await (await rm().get(`/vault/site-checks/${id}/findings.csv?check=links`)).text(), 'Level,Link to,Answer,Link text,Kind,Problem,On,Code\r\n');
    assert.equal((await rm().get(`/vault/site-checks/${id}/findings.csv?check=games`)).status, 404);
    assert.equal((await rm().get(`/vault/site-checks/${id}/findings.csv`)).status, 404);
    assert.equal((await rm().get('/vault/site-checks/999/findings.csv?check=assets')).status, 404);
    assert.equal((await h.as('vera', 'none', 'viewer').get(`/vault/site-checks/${id}/findings.csv?check=assets`)).status, 403);
    assert.equal((await h.app.request(`/vault/site-checks/${id}/findings.csv?check=assets`)).status, 302);
  });

  test('findings left out by the cap are counted under the table', async () => {
    const id = await withAssets([missing(1)], { summaries: [{ check: 'assets', status: 'done', note: '', checked: 12, ms: 1, unlisted: { warn: 40, fail: 2 } }] });
    const text = await (await rm().get(`/vault/site-checks/${id}`)).text();
    assert.match(text, /And 42 more not listed: a run keeps the 500 worst of each check/);
    assert.match(text, /3 failing, 40 worth a look/);
  });

  test('a stored run from before the details: its findings in the table with empty columns, or a note when none were listed', async () => {
    // As the first version stored it: no detail_version, findings without these details, and (past its cap of 2000)
    // a check counted but not listed.
    const old = { ...finishRun({ site: SITE, checks: ['assets', 'links'], started_at: '2026-10-02T11:47:00.000Z', source: null, started_by: 'cli', pages: 12, games: 0 },
      [{ check: 'assets', status: 'done', checked: 12, ms: 1, findings: [] }, { check: 'links', status: 'done', checked: 40, ms: 1, findings: [] }]) };
    delete old.detail_version;
    old.findings = [finding({ check: 'assets', code: 'asset.missing', target: 'https://vaultlearninggames.org/a.css', detail: { status: 404, type: 'stylesheet' } })];
    old.summaries = old.summaries.map((s) => (s.check === 'links' ? { ...s, fail: 7 } : { ...s, fail: 1 }));
    const id = db.addSiteCheck(old, 'github:old');
    const text = await (await rm().get(`/vault/site-checks/${id}`)).text();
    assert.match(text, /recorded before the checks kept every detail, so some columns are empty/);
    assert.match(text, /data-v="stylesheet"/);                            // Asked for by: the file's type, the best there is
    assert.match(text, new RegExp(`aria-controls="details-${id}-links"`));
    assert.match(text, /Details weren’t recorded for this run: it found 7 things, but didn’t list them/);
    assert.equal((await rm().get(`/vault/site-checks/${id}/findings.csv?check=links`)).status, 200);
  });
});
