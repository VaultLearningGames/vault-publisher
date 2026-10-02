import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogNames, consoleReport, exitCodeFor, main, parseCli, type MainDeps, type Options } from '../scripts/check-site.ts';
import { finishRun, type Finding, type RunOptions, type SiteCheckRun } from '../src/site-checks.ts';

const PORTAL = 'https://portal.example.org';
const SITE = 'https://example.org';
const finding = (level: 'warn' | 'fail', code = 'link.broken', check: Finding['check'] = 'links'): Finding =>
  ({ check, level, code, page: '/wake/', target: `https://x.example/${code}`, message: 'It is broken', pages: ['/wake/'], count: 1 });
const run = (findings: Finding[] = [], over: Partial<SiteCheckRun> = {}): SiteCheckRun => ({
  ...finishRun({ site: 'https://example.org', checks: ['links', 'spelling'], started_at: '2026-10-02T11:47:00Z', source: null, started_by: 'cli', pages: 12, games: 3 },
    [{ check: 'links', status: 'done', checked: 40, ms: 2000, findings: findings.filter((f) => f.check === 'links') },
     { check: 'spelling', status: 'done', checked: 900, ms: 500, findings: findings.filter((f) => f.check === 'spelling') }]),
  ...over,
});

describe('arguments', () => {
  test('every option', () => {
    const o = parseCli(['--site', `${SITE}/`, '--checks', 'links,games', '--limit', '20', '--paths', '/a/,/b/', '--catalog', `${PORTAL}/`, '--words', 'zorp, blat', '--guard',
      '--source', 'https://github.com/o/r/actions/runs/1', '--portal-page', `${PORTAL}/vault/site-checks`, '--fail-on', 'warn', '--out', 'r.json', '--summary', 's.md', '--issue', 'i.md']) as Options;
    assert.deepEqual([o.site, o.checks, o.limit, o.paths, o.catalog, o.words, o.guard], [SITE, 'links,games', 20, ['/a/', '/b/'], PORTAL, ['zorp', 'blat'], true]);
    assert.deepEqual([o.source, o.portalPage, o.failOn, o.out, o.summary, o.issue], ['https://github.com/o/r/actions/runs/1', `${PORTAL}/vault/site-checks`, 'warn', 'r.json', 's.md', 'i.md']);
  });

  test('defaults: guard off, fail on failures, no catalog', () => {
    const o = parseCli(['--site', 'http://localhost:1313']) as Options;
    assert.deepEqual([o.site, o.guard, o.words, o.failOn, o.catalog, o.portalPage, o.source, o.limit], ['http://localhost:1313', false, [], 'fail', null, null, null, undefined]);
  });

  test('bad usage is a message', () => {
    for (const argv of [
      [], ['--portal', PORTAL], ['--site', 'not a url'], ['--site', 'ftp://x.org'], ['--site', SITE, '--catalog', 'nope'],
      ['--site', SITE, '--checks', 'colours'], ['--site', SITE, '--limit', '0'], ['--site', SITE, '--paths', 'wake'],
      ['--site', SITE, '--fail-on', 'sometimes'], ['--site', SITE, '--timeout', '5'], ['--site', SITE, '--bogus'],
      ['--site', SITE, '--source', 'http://insecure.example'], ['--site', SITE, '--portal-page', 'nope'],
    ]) assert.equal(typeof parseCli(argv), 'string', argv.join(' '));
  });
});

describe('exit codes', () => {
  test('pass, failures, warnings with each --fail-on', () => {
    assert.equal(exitCodeFor(run(), 'fail'), 0);
    assert.equal(exitCodeFor(run([finding('fail')]), 'fail'), 1);
    assert.equal(exitCodeFor(run([finding('fail')]), 'never'), 0);
    assert.equal(exitCodeFor(run([finding('warn')]), 'fail'), 0);
    assert.equal(exitCodeFor(run([finding('warn')]), 'warn'), 1);
    assert.equal(exitCodeFor(run([finding('warn')]), 'never'), 0);
  });

  test('a run that ended in error fails whatever --fail-on says', () => {
    assert.equal(exitCodeFor(run([], { status: 'error', error: 'the browser crashed' }), 'never'), 1);
  });
});

describe('console report', () => {
  test('a table, then findings by check, then the totals', () => {
    const text = consoleReport(run([finding('fail'), finding('warn', 'link.unverified')]));
    assert.match(text, /CHECK\s+LOOKED AT\s+FAIL\s+WARN/);
    assert.match(text, /FAIL\s+Broken links\s+40\s+1\s+1/);
    assert.match(text, /OK\s+Spelling/);
    assert.ok(text.indexOf('FAIL  It is broken') < text.indexOf('warn  It is broken'));
    assert.match(text, /1 failing, 1 worth a look, across 12 pages and 3 games/);
  });
});


// ---------- main ----------
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the catalog’s names', () => {
  test('titles, studios and makers', async () => {
    const fetchFn = (async (url: string) => { assert.equal(url, `${PORTAL}/v1/catalog`); return json({ games: [{ title: 'Wake', studio: { name: 'Field Day Lab' }, makers: ['Ann Lee'] }, { title: 'Bloom' }], studios: [{ name: 'MIT Education Arcade' }, {}] }); }) as typeof fetch;
    assert.deepEqual(await catalogNames(PORTAL, fetchFn), ['Wake', 'Field Day Lab', 'Ann Lee', 'Bloom', 'MIT Education Arcade']);
    await assert.rejects(catalogNames(PORTAL, (async () => json({}, 500)) as typeof fetch), /HTTP 500/);
  });
});

describe('main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-site-'));
  const paths = (n: string) => ({ out: join(dir, `${n}.json`), summary: join(dir, `${n}.md`), issue: join(dir, `${n}-issue.md`) });
  const argvFor = (n: string, extra: string[] = []) => ['--site', SITE, '--out', paths(n).out, '--summary', paths(n).summary, '--issue', paths(n).issue, ...extra];
  const engineOf = (r: SiteCheckRun | Error, seen: RunOptions[] = []): MainDeps['engine'] => async (o) => {
    seen.push(o);
    o.onProgress?.({ phase: 'pages', done: 1, total: 3 });
    if (r instanceof Error) throw r;
    return r;
  };
  const quiet = { print: () => {}, log: () => {}, env: {} };

  test('a passing run: exit 0, outputs written, annotations only under GitHub Actions', async () => {
    const lines: string[] = [];
    const code = await main(argvFor('pass', ['--portal-page', `${PORTAL}/vault/site-checks`]), { engine: engineOf(run([finding('warn', 'link.unverified')])), print: (l) => lines.push(l), log: () => {}, env: { GITHUB_ACTIONS: 'true' } });
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.startsWith('::warning ')));
    const saved = JSON.parse(readFileSync(paths('pass').out, 'utf8'));
    assert.equal(saved.counts.warn, 1);
    assert.equal(saved.site, SITE);
    assert.equal('portal_url' in saved, false);
    assert.match(readFileSync(paths('pass').summary, 'utf8'), /## Site checks: https:\/\/example.org/);
    assert.match(readFileSync(paths('pass').summary, 'utf8'), new RegExp(`Everything: ${PORTAL}/vault/site-checks`));
    assert.match(readFileSync(paths('pass').issue, 'utf8'), new RegExp(`Everything: ${PORTAL}/vault/site-checks`));
    assert.match(readFileSync(paths('pass').issue, 'utf8'), /<!-- failing: 0-/);
  });

  test('the output posted to the portal is a run the portal accepts', async () => {
    await main(argvFor('postable'), { engine: engineOf(run([finding('fail')])), ...quiet });
    const { parseRun } = await import('../src/site-checks.ts');
    const parsed = parseRun(JSON.parse(readFileSync(paths('postable').out, 'utf8')));
    assert.equal(typeof parsed, 'object');
    assert.deepEqual((parsed as SiteCheckRun).counts, { warn: 0, fail: 1 });
  });

  test('failures: exit 1 (and 0 with --fail-on never); no annotations outside Actions', async () => {
    const lines: string[] = [];
    const failing = run([finding('fail')]);
    assert.equal(await main(argvFor('fail'), { engine: engineOf(failing), print: (l) => lines.push(l), log: () => {}, env: {} }), 1);
    assert.ok(!lines.some((l) => l.startsWith('::')));
    assert.equal(await main(argvFor('never', ['--fail-on', 'never']), { engine: engineOf(failing), ...quiet }), 0);
    assert.equal(await main(argvFor('warn', ['--fail-on', 'warn']), { engine: engineOf(run([finding('warn')])), ...quiet }), 1);
    assert.match(readFileSync(paths('fail').issue, 'utf8'), /1-[0-9a-f]{8}/);
  });

  test('a run that ended in error: exit 1, outputs still written', async () => {
    const broken = run([], { status: 'error', error: 'the browser crashed' });
    assert.equal(await main(argvFor('err', ['--fail-on', 'never']), { engine: engineOf(broken), ...quiet }), 1);
    assert.equal(JSON.parse(readFileSync(paths('err').out, 'utf8')).status, 'error');
  });

  test('couldn’t run at all (bad usage, the engine throws): exit 2, no outputs', async () => {
    const logs: string[] = [];
    assert.equal(await main(['--nonsense'], { print: () => {}, log: (l) => logs.push(l) }), 2);
    assert.match(logs.join('\n'), /usage: node scripts\/check-site\.ts --site/);
    assert.equal(await main(argvFor('threw'), { engine: engineOf(new Error('Chromium could not start')), print: () => {}, log: (l) => logs.push(l), env: {} }), 2);
    assert.match(logs.join('\n'), /Chromium could not start/);
    assert.equal(existsSync(paths('threw').out), false);
    assert.equal(existsSync(paths('threw').issue), false);
  });

  test('the engine gets the options the command line was given, with the catalog’s names', async () => {
    const seen: RunOptions[] = [];
    const logs: string[] = [];
    const fetchFn = (async () => json({ games: [{ title: 'Wake', studio: { name: 'Field Day Lab' } }] })) as typeof fetch;
    const code = await main(['--site', 'http://localhost:1313', '--checks', 'links', '--limit', '3', '--paths', '/a/', '--words', 'zorp', '--catalog', PORTAL, '--guard', '--source', 'https://github.com/o/r/actions/runs/1'],
      { engine: engineOf(run(), seen), fetch: fetchFn, print: () => {}, log: (l) => logs.push(l), env: {} });
    assert.equal(code, 0);
    const o = seen[0];
    assert.deepEqual([o.site, o.checks, o.limit, o.paths, o.allowWords, o.guard, o.startedBy, o.source],
      ['http://localhost:1313', ['links'], 3, ['/a/'], ['zorp', 'Wake', 'Field Day Lab'], true, 'cli', 'https://github.com/o/r/actions/runs/1']);
    assert.deepEqual(logs, ['pages 1/3']);
  });

  test('a catalog that can’t be read is a warning, and the run goes on without the names', async () => {
    for (const fetchFn of [(async () => json({ error: 'nope' }, 404)) as typeof fetch, (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch]) {
      const seen: RunOptions[] = [], logs: string[] = [];
      const code = await main(argvFor('nocatalog', ['--catalog', PORTAL, '--words', 'zorp']), { engine: engineOf(run(), seen), fetch: fetchFn, print: () => {}, log: (l) => logs.push(l), env: {} });
      assert.equal(code, 0);
      assert.deepEqual(seen[0].allowWords, ['zorp']);
      assert.ok(logs.some((l) => /^check-site: warning: couldn't read the catalog's names from https:\/\/portal\.example\.org/.test(l)), logs.join('|'));
      assert.ok(!logs.some((l) => l.startsWith('::')));
      const actions: string[] = [];
      await main(argvFor('nocatalog', ['--catalog', PORTAL]), { engine: engineOf(run()), fetch: fetchFn, print: () => {}, log: (l) => actions.push(l), env: { GITHUB_ACTIONS: 'true' } });
      assert.ok(actions.some((l) => l.startsWith('::warning title=Site checks::')), actions.join('|'));
    }
  });
});
