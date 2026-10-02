import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowList, annotations, assetFindings, checkBadge, CHECKS, runBadge, whenBadge, finishRun, fingerprint, gameFindings, groupFindings, hrefProblem, issueMarkdown,
  LIMITS, linkFinding, MAX_FINDINGS, MAX_PAGES_LISTED, parseRun, parseStart, performanceFindings, responsiveFindings, runFails, runMarkdown, spellingFindings, wordsOf,
  type CheckSummary, type Dictionary, type GameLoad, type LinkProbe, type LinkSeen, type PageLoad, type RawFinding, type ResourceSeen, type SiteCheckRun, type ViewSeen,
} from '../src/site-checks.ts';

const SITE = 'https://vaultlearninggames.org';
const res = (r: Partial<ResourceSeen> = {}): ResourceSeen => ({ url: `${SITE}/sq/css/site.css`, type: 'stylesheet', status: 200, error: null, bytes: 12_000, mime: 'text/css', encoding: 'br', ms: 40, inFrame: false, ...r });
const page = (p: Partial<PageLoad> = {}): PageLoad => ({ path: '/wake/', status: 200, error: null, resources: [], images: [], scriptErrors: [], timing: { ttfb: 80, domContentLoaded: 400, load: 900, lcp: 700 }, ...p });
const codes = (f: RawFinding[]) => f.map((x) => `${x.level}:${x.code}`);

describe('assets', () => {
  test('a clean page has no findings', () => {
    assert.deepEqual(assetFindings(page({ resources: [res()], images: [{ src: `${SITE}/a.png`, loaded: true, natural: [800, 600], shown: [400, 300] }] }), SITE), []);
  });

  test('a file that answers 404, or never arrives, fails; each address once', () => {
    const f = assetFindings(page({ resources: [
      res({ url: `${SITE}/sq/img/gone.png`, type: 'image', status: 404 }),
      res({ url: `${SITE}/sq/img/gone.png`, type: 'image', status: 404 }),
      res({ url: 'https://use.typekit.net/kit.css', status: null, error: 'net::ERR_NAME_NOT_RESOLVED' }),
    ] }), SITE);
    assert.deepEqual(codes(f), ['fail:asset.missing', 'fail:asset.missing']);
    assert.equal(f[0].page, '/wake/');
    assert.equal(f[0].target, `${SITE}/sq/img/gone.png`);
    assert.match(f[1].message, /ERR_NAME_NOT_RESOLVED/);
  });

  test('a third party’s data request failing is a warning; the site’s own is a failure', () => {
    const f = assetFindings(page({ resources: [
      res({ url: 'https://www.google-analytics.com/g/collect', type: 'fetch', status: 503 }),
      res({ url: `${SITE}/game-cards?format=json`, type: 'fetch', status: 404 }),
    ] }), SITE);
    assert.deepEqual(codes(f), ['warn:asset.missing', 'fail:asset.missing']);
  });

  test('cancelled requests, requests inside embedded frames and data: addresses are not missing files', () => {
    assert.deepEqual(assetFindings(page({ resources: [
      res({ status: null, error: 'net::ERR_ABORTED' }),
      res({ url: 'https://www.youtube.com/api/stats', status: 403, inFrame: true }),
      res({ url: 'data:image/png;base64,AAAA', status: null, error: 'net::ERR_INVALID_URL' }),
    ] }), SITE), []);
  });

  test('a broken image, and a script error', () => {
    const f = assetFindings(page({ images: [{ src: 'https://cdn.example.org/hero.png', loaded: false, natural: [0, 0], shown: [300, 200] }], scriptErrors: ['TypeError: x is not a function'] }), SITE);
    assert.deepEqual(codes(f), ['fail:asset.broken-image', 'warn:asset.script-error']);
  });

  test('an image whose request already failed is reported once', () => {
    const src = `${SITE}/sq/img/gone.png`;
    const f = assetFindings(page({ resources: [res({ url: src, type: 'image', status: 404 })], images: [{ src, loaded: false, natural: [0, 0], shown: [10, 10] }] }), SITE);
    assert.deepEqual(codes(f), ['fail:asset.missing']);
  });

  test('a page that doesn’t load is one failure', () => {
    assert.deepEqual(codes(assetFindings(page({ status: 404, resources: [res({ status: 404 })] }), SITE)), ['fail:page.failed']);
    assert.match(assetFindings(page({ status: null, error: 'net::ERR_CONNECTION_REFUSED' }), SITE)[0].message, /ERR_CONNECTION_REFUSED/);
  });
});

describe('performance', () => {
  test('a quick, light page has no findings', () => {
    assert.deepEqual(performanceFindings(page({ resources: [res(), res({ url: `${SITE}/a.jpg`, type: 'image', bytes: 200_000, mime: 'image/jpeg', encoding: '' })] })), []);
  });

  test('large files: warn and fail sizes differ for images and other files', () => {
    const f = performanceFindings(page({ resources: [
      res({ url: `${SITE}/a.png`, type: 'image', bytes: LIMITS.imageWarnBytes + 1, mime: 'image/png', encoding: '' }),
      res({ url: `${SITE}/b.png`, type: 'image', bytes: LIMITS.imageFailBytes + 1, mime: 'image/png', encoding: '' }),
      res({ url: `${SITE}/c.js`, type: 'script', bytes: LIMITS.imageWarnBytes + 1, mime: 'text/javascript' }),
      res({ url: `${SITE}/d.js`, type: 'script', bytes: LIMITS.fileWarnBytes + 1, mime: 'text/javascript' }),
    ] }));
    assert.deepEqual(f.filter((x) => x.code === 'perf.large-file').map((x) => `${x.level} ${x.target.slice(-5)}`), ['warn a.png', 'fail b.png', 'warn /d.js']);
    assert.match(f[1].message, /2\.0 MB image/);
  });

  test('a heavy page counts everything the page itself loads, not what its frames load', () => {
    const big = (i: number, inFrame = false) => res({ url: `${SITE}/${i}.jpg`, type: 'image', bytes: 400_000, mime: 'image/jpeg', encoding: '', inFrame });
    assert.deepEqual(codes(performanceFindings(page({ resources: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => big(i)) }))), ['warn:perf.heavy-page']);
    assert.deepEqual(performanceFindings(page({ resources: [1, 2, 3, 4].map((i) => big(i)).concat([5, 6, 7, 8].map((i) => big(i, true))) })), []);
  });

  test('text sent without compression', () => {
    const f = performanceFindings(page({ resources: [
      res({ url: `${SITE}/big.js`, type: 'script', bytes: 90_000, mime: 'text/javascript; charset=utf-8', encoding: '' }),
      res({ url: `${SITE}/small.js`, type: 'script', bytes: 2000, mime: 'text/javascript', encoding: '' }),
      res({ url: `${SITE}/photo.jpg`, type: 'image', bytes: 90_000, mime: 'image/jpeg', encoding: '' }),
    ] }));
    assert.deepEqual(f.map((x) => `${x.code} ${x.target}`), [`perf.uncompressed ${SITE}/big.js`]);
  });

  test('an image with far more pixels than it is shown at', () => {
    const src = `${SITE}/hero.jpg`;
    const withImg = (natural: number, shown: number, bytes: number) => performanceFindings(page({
      resources: [res({ url: src, type: 'image', bytes, mime: 'image/jpeg', encoding: '' })], images: [{ src, loaded: true, natural: [natural, 100], shown: [shown, 50] }] }));
    assert.deepEqual(codes(withImg(3000, 300, 300_000)), ['warn:perf.oversized-image']);
    assert.deepEqual(withImg(600, 300, 300_000), []);      // twice the pixels is what a sharp screen wants
    assert.deepEqual(withImg(3000, 300, 30_000), []);      // a small file isn't worth it
    assert.deepEqual(withImg(3000, 0, 300_000), []);       // not shown at this width
  });

  test('slow pages: load time first, then main content, then the server; one finding', () => {
    const t = (timing: Partial<PageLoad['timing']>) => codes(performanceFindings(page({ timing: { ttfb: 80, domContentLoaded: 400, load: 900, lcp: 700, ...timing } })));
    assert.deepEqual(t({ load: 3500 }), ['warn:perf.slow-page']);
    assert.deepEqual(t({ load: 9000, lcp: 5000, ttfb: 2000 }), ['fail:perf.slow-page']);
    assert.deepEqual(t({ lcp: 3000 }), ['warn:perf.slow-paint']);
    assert.deepEqual(t({ lcp: 4500 }), ['fail:perf.slow-paint']);
    assert.deepEqual(t({ ttfb: 1200 }), ['warn:perf.slow-server']);
    assert.deepEqual(t({ load: null, lcp: null, ttfb: null }), []);
  });

  test('a page that failed is left to the assets check', () => {
    assert.deepEqual(performanceFindings(page({ status: 500, timing: { ttfb: 9000, domContentLoaded: null, load: 9000, lcp: null } })), []);
  });
});

describe('responsive', () => {
  const view = (v: Partial<ViewSeen> = {}): ViewSeen => ({ path: '/about/', viewport: 'phone', width: 360, hasViewportMeta: true, scrollWidth: 360, offenders: [], smallText: [], smallTargets: [], ...v });

  test('a page that fits has no findings', () => {
    assert.deepEqual(responsiveFindings(view()), []);
    assert.deepEqual(responsiveFindings(view({ scrollWidth: 361 })), []);
  });

  test('sideways scrolling fails on a phone or tablet, warns on wider screens, and names the element', () => {
    const f = responsiveFindings(view({ scrollWidth: 412, offenders: [{ selector: 'table.standards', right: 412 }, { selector: 'img.hero', right: 380 }] }));
    assert.deepEqual(codes(f), ['fail:responsive.overflow']);
    assert.equal(f[0].target, 'phone (360px): table.standards');
    assert.match(f[0].message, /412px wide in a 360px window/);
    assert.equal(responsiveFindings(view({ viewport: 'tablet', width: 768, scrollWidth: 800 }))[0].level, 'fail');
    assert.equal(responsiveFindings(view({ viewport: 'wide', width: 1920, scrollWidth: 2000 }))[0].level, 'warn');
  });

  test('no viewport meta tag is reported once, at the phone width', () => {
    assert.deepEqual(codes(responsiveFindings(view({ hasViewportMeta: false }))), ['fail:responsive.no-viewport']);
    assert.deepEqual(responsiveFindings(view({ viewport: 'laptop', width: 1280, scrollWidth: 1280, hasViewportMeta: false })), []);
  });

  test('tiny text and tiny tap targets warn on a phone only, once per kind of element', () => {
    const tiny = { smallText: [{ selector: 'p.caption', px: 9, sample: 'Grades 6-8' }, { selector: 'p.caption', px: 9, sample: 'Grades 3-5' }], smallTargets: [{ selector: 'a.social', width: 16, height: 16, label: 'Instagram' }] };
    const f = responsiveFindings(view(tiny));
    assert.deepEqual(codes(f), ['warn:responsive.small-text', 'warn:responsive.small-target']);
    assert.match(f[0].message, /9px/);
    assert.match(f[1].message, /16×16px “Instagram”/);
    assert.deepEqual(responsiveFindings(view({ viewport: 'laptop', width: 1280, scrollWidth: 1280, ...tiny })), []);
  });
});

describe('links', () => {
  const link = (l: Partial<LinkSeen> = {}): LinkSeen => ({ page: '/about/', url: 'https://example.org/thing', fragment: '', raw: 'https://example.org/thing', text: 'Read more', kind: 'link', ...l });
  const probe = (p: Partial<LinkProbe> = {}): LinkProbe => ({ status: 200, error: null, finalUrl: null, attempts: 1, anchorFound: null, ...p });
  const of = (l: Partial<LinkSeen>, p: Partial<LinkProbe>) => { const f = linkFinding(link(l), probe(p), SITE); return f ? `${f.level}:${f.code}` : null; };

  test('addresses that are never requested', () => {
    assert.equal(hrefProblem('https://example.org/'), null);
    assert.equal(hrefProblem('/about/'), null);
    assert.equal(hrefProblem('#top'), 'skip');
    assert.equal(hrefProblem('mailto:vault@fielddaylab.org?subject=Hi'), 'skip');
    assert.equal(hrefProblem('tel:+1-608-555-0100'), 'skip');
    assert.deepEqual(hrefProblem(''), { level: 'warn', message: 'A link with an empty address' });
    assert.equal((hrefProblem('mailto:vault@fielddaylab') as { level: string }).level, 'fail');
    assert.equal((hrefProblem('mailto:') as { level: string }).level, 'fail');
    assert.equal((hrefProblem('tel:123') as { level: string }).level, 'fail');
    assert.equal((hrefProblem('javascript:void(0)') as { level: string }).level, 'warn');
  });

  test('a link that answers is fine', () => {
    assert.equal(of({}, {}), null);
    assert.equal(of({}, { status: 204 }), null);
  });

  test('404 and 410 are broken, on the site or off it', () => {
    assert.equal(of({}, { status: 404 }), 'fail:link.broken');
    assert.equal(of({}, { status: 410 }), 'fail:link.broken');
    assert.equal(of({ url: `${SITE}/missing/` }, { status: 404 }), 'fail:link.broken');
  });

  test('another site refusing an automated request is unverified, not broken; the site’s own page refusing is broken', () => {
    for (const status of [401, 403, 405, 429, 999]) assert.equal(of({}, { status }), 'warn:link.unverified');
    assert.equal(of({ url: `${SITE}/private/` }, { status: 403 }), 'fail:link.broken');
    assert.equal(of({}, { status: 400 }), 'fail:link.broken');
    assert.equal(of({}, { status: 500 }), 'fail:link.broken');
  });

  test('errors: a name that doesn’t resolve or a bad certificate is broken; no answer from another site is unverified', () => {
    const err = (code: string) => ({ status: null, error: { code, message: code } });
    assert.equal(of({}, err('ENOTFOUND')), 'fail:link.broken');
    assert.equal(of({}, err('CERT_HAS_EXPIRED')), 'fail:link.broken');
    assert.equal(of({}, err('TOO_MANY_REDIRECTS')), 'fail:link.broken');
    assert.equal(of({}, err('TimeoutError')), 'warn:link.unverified');
    assert.equal(of({}, err('ECONNRESET')), 'warn:link.unverified');
    assert.equal(of({ url: `${SITE}/slow/` }, err('TimeoutError')), 'fail:link.broken');
    assert.equal(of({}, err('BLOCKED')), 'warn:link.private');
  });

  test('a #fragment that isn’t on the page it points to', () => {
    const f = linkFinding(link({ url: `${SITE}/about/`, fragment: 'team' }), probe({ anchorFound: false }), SITE)!;
    assert.equal(`${f.level}:${f.code}`, 'warn:link.missing-anchor');
    assert.equal(f.target, `${SITE}/about/#team`);
    assert.equal(of({ url: `${SITE}/about/`, fragment: 'team' }, { anchorFound: true }), null);
    assert.equal(of({ fragment: 'team' }, { anchorFound: null }), null);
  });

  test('the message says what kind of thing it is', () => {
    assert.match(linkFinding(link(), probe({ status: 404 }), SITE)!.message, /^The link “Read more” leads to a page that isn't there \(HTTP 404\)/);
    assert.match(linkFinding(link({ kind: 'video' }), probe({ status: 404 }), SITE)!.message, /^A video is no longer available/);
    assert.match(linkFinding(link({ kind: 'frame' }), probe({ status: 500 }), SITE)!.message, /^An embedded frame answers HTTP 500/);
  });
});

describe('games', () => {
  const game = (g: Partial<GameLoad> = {}): GameLoad => ({ page: '/wake/', title: 'Wake', url: 'https://fielddaylab.wisc.edu/play/wake/', embed: true, opened: true, status: 200, error: null, hasContent: true, blank: false, ms: 2400, resources: [], ...g });

  test('a game that opens and shows something passes', () => {
    assert.deepEqual(gameFindings(game()), []);
    assert.deepEqual(gameFindings(game({ embed: false, blank: null })), []);
  });

  test('a game that can’t be reached, refuses the frame, or opens empty fails, with one finding', () => {
    assert.deepEqual(codes(gameFindings(game({ opened: false, status: null, error: 'refused to be shown in a frame (X-Frame-Options: DENY)', hasContent: false }))), ['fail:game.failed']);
    assert.deepEqual(codes(gameFindings(game({ status: 404, hasContent: false, resources: [res({ status: 404 })] }))), ['fail:game.failed']);
    assert.deepEqual(codes(gameFindings(game({ opened: false }))), ['fail:game.no-player']);
    assert.deepEqual(codes(gameFindings(game({ hasContent: false }))), ['fail:game.empty']);
    assert.match(gameFindings(game({ opened: false }))[0].message, /Play didn't open Wake in the site’s player/);
    assert.equal(gameFindings(game({ url: '', opened: false, error: 'the page /wake/ didn\'t load' }))[0].target, '/wake/');
  });

  test('a game whose site refuses the checker is unverified, not broken', () => {
    assert.deepEqual(codes(gameFindings(game({ embed: false, status: 403, hasContent: false, blank: null }))), ['warn:game.unverified']);
    assert.deepEqual(codes(gameFindings(game({ status: 429 }))), ['warn:game.unverified']);
  });

  test('a blank screen and missing files are warnings; many missing files are summed up', () => {
    const gone = (i: number) => res({ url: `https://fielddaylab.wisc.edu/play/wake/Build/${i}.data`, type: 'fetch', status: 404 });
    const f = gameFindings(game({ blank: true, resources: [1, 2, 3, 4, 5, 6, 7].map(gone) }));
    assert.deepEqual(codes(f), ['warn:game.blank', ...Array(6).fill('warn:game.missing-file')]);
    assert.match(f.at(-1)!.message, /asks for 7 files that don't load/);
    assert.ok(f.every((x) => x.check === 'games'));
    // Another site's data call failing (statistics, tracking) isn't the game's missing file; its own script is.
    assert.deepEqual(gameFindings(game({ resources: [res({ url: 'https://stats.unity3d.com/HWStats.cgi', type: 'xhr', status: null, error: 'net::ERR_NAME_NOT_RESOLVED' })] })), []);
    assert.deepEqual(codes(gameFindings(game({ resources: [res({ url: 'https://cdn.example.org/engine.js', type: 'script', status: 404 })] }))), ['warn:game.missing-file']);
  });

  test('slow and heavy games are performance findings', () => {
    const f = gameFindings(game({ ms: 22_000, resources: [res({ url: 'https://x.example/Build/game.data', type: 'fetch', bytes: 80_000_000 })] }));
    assert.deepEqual(f.map((x) => `${x.check} ${x.level}:${x.code}`), ['performance warn:game.slow', 'performance warn:game.heavy']);
    assert.match(f[1].message, /80\.0 MB/);
    assert.deepEqual(codes(gameFindings(game({ ms: null }))), ['warn:game.slow']);
    assert.equal(gameFindings(game({ resources: [res({ bytes: 250_000_000 })] }))[0].level, 'fail');
  });
});

describe('spelling', () => {
  const known = new Set(['the', 'water', 'cycle', 'game', 'a', 'about', 'is', "don't", 'play', 'learn', 'teacher', 'madison', 'in', 'free', 'science']);
  const dictionary: Dictionary = { correct: (w) => known.has(w.toLowerCase()), suggest: (w) => (w === 'sceince' ? ['science'] : []) };

  test('the words worth checking', () => {
    assert.deepEqual(wordsOf('Play the Water Cycle game.'), ['Play', 'the', 'Water', 'Cycle', 'game']);
    assert.deepEqual(wordsOf('Grades 6-8, NGSS MS-LS2-3 and 3D models'), ['Grades', 'and', 'models']);
    assert.deepEqual(wordsOf('by iCivics and PhET on YouTube'), ['by', 'and', 'on']);
    assert.deepEqual(wordsOf('see https://phet.colorado.edu/sims/x.html or mail vault@fielddaylab.org or fielddaylab.org/play'), ['see', 'or', 'mail', 'or']);
    assert.deepEqual(wordsOf('Don’t miss the teacher’s guide — it’s ‘free’'), ["Don't", 'miss', 'the', 'teacher', 'guide', 'it', 'free']);
    assert.deepEqual(wordsOf('LEARNING GAMES LIBRARY'), ['LEARNING', 'LIBRARY']);   // long capitals are words; up to six letters could be an acronym
    assert.deepEqual(wordsOf('STEM A I'), []);
    assert.deepEqual(wordsOf('how they affect the traj... Play and the lawy… Done.'), ['how', 'they', 'affect', 'the', 'Play', 'and', 'the', 'Done']);
    assert.deepEqual(wordsOf('concentra\u00ADtion and zero\u200Bwidth'), ['concentration', 'and', 'zerowidth']);
    assert.deepEqual(wordsOf('well-known co-op'), ['well', 'known', 'co', 'op']);
  });

  test('unknown words become one finding per page they are on, with a suggestion and where they were found', () => {
    const { findings, words } = spellingFindings([
      { path: '/a/', text: 'Learn sceince in the water cycle game. Sceince is free.' },
      { path: '/b/', text: 'About the sceince game' },
    ], dictionary, new Set());
    assert.equal(words, 14);
    assert.deepEqual(findings.map((f) => `${f.page} ${f.target}`), ['/a/ sceince', '/b/ sceince']);
    assert.equal(findings[0].level, 'warn');
    assert.match(findings[0].message, /“sceince” isn't in the dictionary \(science\?\): “…Learn sceince in the water cycle game/);
    assert.equal(groupFindings(findings).length, 1);
    assert.equal(groupFindings(findings)[0].count, 2);
  });

  test('names on the allow list, and capitalised words the dictionary knows in lower case, pass', () => {
    const allow = allowList(['Agrinautica', "Tami’s Tower", 'Field Day Lab']);
    assert.ok(allow.has('agrinautica') && allow.has('tami') && allow.has("tami's") && allow.has('tower'));
    const { findings } = spellingFindings([{ path: '/', text: 'Play Agrinautica and Tami’s Tower in Madison. SCIENCE!' }], dictionary, allow);
    assert.deepEqual(findings.map((f) => f.target), ['and']);
  });
});

describe('a run', () => {
  const raw = (f: Partial<RawFinding> = {}): RawFinding => ({ check: 'links', level: 'fail', code: 'link.broken', page: '/a/', target: 'https://gone.example/', message: 'The link leads nowhere', ...f });
  const base = { site: SITE, checks: [...CHECKS], started_at: '2026-10-02T12:00:00.000Z', source: 'https://github.com/VaultLearningGames/vault-publisher/actions/runs/1', started_by: 'github:djgagnon', pages: 3, games: 1 };

  test('the same problem on many pages is one finding; worst first, then the most widespread', () => {
    const f = groupFindings([
      raw({ level: 'warn', code: 'link.unverified', target: 'https://shy.example/' }),
      raw({ page: '/a/' }), raw({ page: '/b/' }), raw({ page: '/a/' }), raw({ page: '/c/' }),
      raw({ target: 'https://other.example/' }),
      raw({ check: 'assets', code: 'asset.missing', target: 'https://gone.example/' }),
    ]);
    assert.deepEqual(f.map((x) => `${x.check} ${x.level} ${x.target} x${x.count}`), [
      'assets fail https://gone.example/ x1', 'links fail https://gone.example/ x3', 'links fail https://other.example/ x1', 'links warn https://shy.example/ x1']);
    assert.deepEqual(f[1].pages, ['/a/', '/b/', '/c/']);
  });

  test('a finding is as bad as its worst page, and lists at most twenty pages', () => {
    const many = Array.from({ length: 30 }, (_, i) => raw({ page: `/p${i}/`, level: i === 29 ? 'fail' : 'warn' }));
    const [f] = groupFindings(many);
    assert.equal(f.level, 'fail');
    assert.equal(f.count, 30);
    assert.equal(f.pages.length, 20);
  });

  test('finishRun counts findings under the check named on them, and marks checks that didn’t run', () => {
    const run = finishRun(base, [
      { check: 'games', status: 'done', checked: 1, ms: 9000, findings: [raw({ check: 'performance', level: 'warn', code: 'game.slow', target: 'g' })] },
      { check: 'links', status: 'done', checked: 40, ms: 3000, findings: [raw(), raw({ page: '/b/' })] },
      { check: 'spelling', status: 'error', note: 'no dictionary', checked: 0, ms: 1, findings: [] },
    ]);
    assert.equal(run.status, 'done');
    assert.deepEqual(run.counts, { warn: 1, fail: 1 });
    const by = Object.fromEntries(run.summaries.map((s) => [s.check, s]));
    assert.deepEqual([by.games.fail, by.games.warn, by.performance.warn, by.links.fail], [0, 0, 1, 1]);
    assert.equal(by.performance.status, 'skipped');
    assert.equal(by.spelling.note, 'no dictionary');
    assert.ok(run.finished_at);
  });

  test('findings of checks that weren’t asked for are dropped', () => {
    const run = finishRun({ ...base, checks: ['games'] }, [{ check: 'games', status: 'done', checked: 1, ms: 1, findings: [raw({ check: 'performance', level: 'warn', code: 'game.slow' })] }]);
    assert.deepEqual(run.findings, []);
    assert.deepEqual(run.summaries.map((s) => s.check), ['games']);
  });

  test('when a run fails the job', () => {
    const clean = finishRun(base, CHECKS.map((check) => ({ check, status: 'done' as const, checked: 1, ms: 1, findings: [] })));
    const warns = finishRun(base, [{ check: 'links', status: 'done', checked: 1, ms: 1, findings: [raw({ level: 'warn' })] }]);
    const fails = finishRun(base, [{ check: 'links', status: 'done', checked: 1, ms: 1, findings: [raw()] }]);
    const broke = finishRun(base, [{ check: 'links', status: 'error', note: 'boom', checked: 0, ms: 1, findings: [] }]);
    assert.deepEqual([runFails(clean, 'fail'), runFails(warns, 'fail'), runFails(warns, 'warn'), runFails(fails, 'fail'), runFails(fails, 'never')], [false, false, true, true, false]);
    assert.equal(runFails(broke, 'never'), true);
    assert.equal(runFails({ ...clean, status: 'error' }, 'never'), true);
    assert.equal(runFails(finishRun(base, [], 'the site did not answer'), 'never'), true);
  });

  test('the job summary, the issue and the annotations', () => {
    const run = finishRun(base, [
      { check: 'links', status: 'done', checked: 40, ms: 3000, findings: [raw(), raw({ page: '/b/' }), raw({ level: 'warn', code: 'link.unverified', target: 'https://shy.example/a|b', message: 'Refuses checks' })] },
      { check: 'games', status: 'done', checked: 1, ms: 9000, findings: [] },
    ]);
    const md = runMarkdown(run, 'https://portal.test/vault/site-checks/7');
    assert.match(md, /## Site checks: https:\/\/vaultlearninggames\.org/);
    assert.match(md, /\*\*1\*\* failing · ⚠️ \*\*1\*\* worth a look, across 3 pages and 1 games\. Everything: https:\/\/portal\.test/);
    assert.match(md, /\| ❌ \| Broken links \| 40 \| 1 \| 1 \| 3\.0 s \|/);
    assert.match(md, /\| ✅ \| Games load \| 1 \| 0 \| 0 \|/);
    assert.match(md, /\| ❌ \| The link leads nowhere \| https:\/\/gone\.example\/ \| \/a\/ and 1 more \|/);
    assert.match(md, /https:\/\/shy\.example\/a\\\|b/);

    const issue = issueMarkdown(run);
    assert.match(issue, /\| Broken links \| The link leads nowhere \|/);
    assert.doesNotMatch(issue, /Refuses checks/);
    assert.match(issue, /<!-- failing: 1-[0-9a-f]{8} -->/);

    assert.deepEqual(annotations(run), [
      '::error title=Broken links%3A /a/ and 1 more::The link leads nowhere — https://gone.example/',
      '::warning title=Broken links%3A /a/::Refuses checks — https://shy.example/a|b',
    ]);
  });

  test('annotations stop at ten of each, the last saying how many more', () => {
    const run = finishRun(base, [{ check: 'links', status: 'done', checked: 99, ms: 1, findings: Array.from({ length: 25 }, (_, i) => raw({ target: `https://gone.example/${i}` })) }]);
    const a = annotations(run);
    assert.equal(a.length, 10);
    assert.match(a[9], /^::error title=16 more failures::/);
    assert.match(annotations({ ...run, status: 'error', error: 'the site\ndid not answer' })[0], /^::error title=Site checks did not finish::the site%0Adid not answer/);
  });

  test('the fingerprint changes with the set of problems, not their order or wording', () => {
    const a = groupFindings([raw(), raw({ target: 'https://other.example/' })]);
    const b = groupFindings([raw({ target: 'https://other.example/', message: 'reworded' }), raw()]);
    assert.equal(fingerprint(a), fingerprint(b));
    assert.notEqual(fingerprint(a), fingerprint(a.slice(0, 1)));
  });
});

describe('the dashboard’s badges', () => {
  const summary = (s: Partial<CheckSummary> = {}): CheckSummary => ({ check: 'links', status: 'done', note: '', checked: 10, warn: 0, fail: 0, ms: 1, ...s });
  const base = { site: SITE, checks: [...CHECKS], started_at: '2026-10-02T12:00:00.000Z', source: null, started_by: 'cli', pages: 3, games: 1 };

  test('a check: passing, to look at, failing, and not run', () => {
    assert.deepEqual(checkBadge('links', summary()), { schemaVersion: 1, label: 'broken links', message: 'passing', color: 'brightgreen', cacheSeconds: 300 });
    assert.deepEqual([checkBadge('links', summary({ warn: 3 })).message, checkBadge('links', summary({ warn: 3 })).color], ['3 to look at', 'yellow']);
    assert.deepEqual([checkBadge('links', summary({ fail: 2, warn: 3 })).message, checkBadge('links', summary({ fail: 2 })).message], ['2 failing · 3 to look at', '2 failing']);
    assert.equal(checkBadge('links', summary({ fail: 2 })).color, 'red');
    assert.deepEqual([checkBadge('games', undefined).message, checkBadge('games', summary({ status: 'error' })).message, checkBadge('games', summary({ status: 'skipped' })).message], ['no runs yet', 'could not run', 'did not run']);
    assert.equal(checkBadge('performance', undefined).label, 'large files and slow loading');
  });

  test('the run as a whole, and when it ran', () => {
    const run = finishRun(base, [{ check: 'links', status: 'done', checked: 1, ms: 1, findings: [{ check: 'links', level: 'fail', code: 'link.broken', page: '/', target: 'x', message: 'm' }] }]);
    assert.deepEqual([runBadge(run).message, runBadge(run).color], ['1 failing', 'red']);
    assert.deepEqual([runBadge(undefined).message, runBadge({ ...run, status: 'error' }).message], ['no runs yet', 'did not finish']);
    const at = Date.parse('2026-10-02T12:30:00.000Z');
    const when = whenBadge({ ...run, finished_at: '2026-10-02T12:07:00.000Z' }, at);
    assert.deepEqual([when.label, when.message, when.color], ['last run', '2026-10-02 12:07 UTC', 'blue']);
    assert.equal(whenBadge({ ...run, finished_at: '2026-09-29T12:07:00.000Z' }, at).color, 'orange');   // nothing for two days
    assert.equal(whenBadge(undefined).message, 'never');
  });
});

describe('starting a run', () => {
  test('nothing asked for means every check', () => {
    assert.deepEqual(parseStart({}), { checks: [...CHECKS], source: null });
    assert.deepEqual(parseStart({ checks: 'all', limit: '', paths: null }), { checks: [...CHECKS], source: null });
  });

  test('checks as a list or a comma-separated string, kept in the battery’s order', () => {
    assert.deepEqual((parseStart({ checks: 'spelling, games' }) as { checks: string[] }).checks, ['games', 'spelling']);
    assert.deepEqual((parseStart({ checks: ['responsive'] }) as { checks: string[] }).checks, ['responsive']);
    assert.match(parseStart({ checks: ['typos'] }) as string, /unknown check typos/);
    assert.match(parseStart({ checks: [] }) as string, /checks must be/);
  });

  test('limit, paths and source are checked', () => {
    assert.deepEqual(parseStart({ limit: '25', paths: '/wake/, /about/', source: 'https://github.com/o/r/actions/runs/1' }),
      { checks: [...CHECKS], limit: 25, paths: ['/wake/', '/about/'], source: 'https://github.com/o/r/actions/runs/1' });
    assert.match(parseStart({ limit: 0 }) as string, /limit/);
    assert.match(parseStart({ paths: ['https://evil.example/'] }) as string, /site path/);
    assert.match(parseStart({ paths: ['//evil.example/'] }) as string, /site path/);
    assert.match(parseStart({ source: 'http://x' }) as string, /source/);
  });
});

describe('receiving a run', () => {
  const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    site: `${SITE}/`, status: 'done', checks: ['links', 'games'], started_at: '2026-10-02T11:47:00Z', finished_at: '2026-10-02T11:58:30.123Z',
    source: 'https://github.com/o/r/actions/runs/1', pages: 12, games: 3, error: null,
    summaries: [{ check: 'links', status: 'done', note: '', checked: 40, ms: 2000, warn: 99, fail: 99 }, { check: 'games', status: 'skipped', note: 'No games', checked: 0, ms: 0 }],
    findings: [{ check: 'links', level: 'fail', code: 'link.broken', page: '/wake/', target: 'https://gone.example.org/', message: 'Broken', pages: ['/wake/', '/about/'], count: 2, detail: { status: 404 } },
      { check: 'links', level: 'warn', code: 'link.unverified', page: '/', target: 'https://x.example.org/', message: 'Unverified', pages: ['/'], count: 1 }],
    counts: { warn: 50, fail: 50 }, started_by: 'user:mallory',
    ...over,
  });
  const run = (over: Record<string, unknown> = {}) => parseRun(good(over)) as SiteCheckRun;
  const bad = (over: Record<string, unknown>, match: RegExp) => assert.match(parseRun(good(over)) as string, match);

  test('a good run comes back normalised; counts and started_by are never taken from the body', () => {
    const r = run();
    assert.equal(r.site, SITE);
    assert.deepEqual(r.checks, ['games', 'links']);
    assert.equal(r.finished_at, '2026-10-02T11:58:30.123Z');
    assert.equal(r.started_at, '2026-10-02T11:47:00.000Z');
    assert.equal(r.started_by, '');
    assert.deepEqual(r.counts, { warn: 1, fail: 1 });
    assert.deepEqual(r.summaries.map((s) => [s.check, s.warn, s.fail]), [['games', 0, 0], ['links', 1, 1]]);
    assert.equal(r.findings[0].count, 2);
    assert.deepEqual(r.findings[0].detail, { status: 404 });
    assert.equal(r.findings[1].detail, undefined);
    assert.equal(r.source, 'https://github.com/o/r/actions/runs/1');
    assert.equal(run({ source: '' }).source, null);
    assert.equal(run({ source: undefined }).source, null);
  });

  test('the site is an http(s) origin; the status, checks and dates are known', () => {
    assert.equal(run({ site: 'http://localhost:1313/some/path' }).site, 'http://localhost:1313');
    for (const site of ['', 'ftp://x.org', 'not a url', 5, undefined]) bad({ site }, /site must be/);
    bad({ status: 'running' }, /status must be done or error/);
    bad({ checks: [] }, /checks must be/);
    bad({ checks: 'links' }, /checks must be/);
    bad({ checks: ['links', 'colours'] }, /unknown check colours/);
    bad({ started_at: 'yesterday' }, /started_at/);
    bad({ finished_at: undefined }, /finished_at/);
  });

  test('source, counts of pages and games, and the error are checked', () => {
    bad({ source: 'http://insecure.example/' }, /source/);
    bad({ source: `https://github.com/${'a'.repeat(500)}` }, /source/);
    bad({ pages: -1 }, /pages/);
    bad({ pages: 1.5 }, /pages/);
    bad({ games: '3' }, /games/);
    bad({ error: 'x'.repeat(1001) }, /error/);
    bad({ error: 5 }, /error/);
    assert.equal(run({ status: 'error', error: 'The site did not answer' }).error, 'The site did not answer');
  });

  test('summaries: one per listed check, valid status, numbers', () => {
    const one = { check: 'links', status: 'done', note: 'n', checked: 1, ms: 1 };
    bad({ summaries: [one, { ...one, check: 'games' }, { ...one, check: 'links' }] }, /at most one summary/);
    bad({ summaries: [one, { ...one }] }, /summarised twice/);
    bad({ summaries: [{ ...one, check: 'spelling' }] }, /one of the run's checks/);
    bad({ summaries: [{ ...one, check: 'nope' }] }, /one of the run's checks/);
    bad({ summaries: [{ ...one, status: 'running' }] }, /status must be done, skipped or error/);
    bad({ summaries: [{ ...one, ms: 'fast' }] }, /ms/);
    bad({ summaries: [{ ...one, checked: -1 }] }, /checked/);
    bad({ summaries: 'none' }, /summaries must be an array/);
    assert.equal(run({ summaries: [{ ...one, note: 'x'.repeat(900) }] }).summaries[0].note.length, 500);
    assert.deepEqual(run({ summaries: [] }).summaries, []);
  });

  test('findings: valid check and level, trimmed strings, at most MAX_FINDINGS', () => {
    const f = { check: 'links', level: 'warn', code: 'c', page: '/', target: 't', message: 'm', pages: ['/'], count: 1 };
    bad({ findings: [{ ...f, check: 'spelling' }] }, /findings\[0\]\.check/);
    bad({ findings: [f, { ...f, level: 'info' }] }, /findings\[1\]\.level/);
    bad({ findings: [{ ...f, code: '' }] }, /code is missing/);
    bad({ findings: [{ ...f, message: undefined }] }, /message is missing/);
    bad({ findings: [{ ...f, count: 0 }] }, /count/);
    bad({ findings: [{ ...f, count: 1.5 }] }, /count/);
    bad({ findings: [{ ...f, pages: [1] }] }, /pages/);
    bad({ findings: ['x'] }, /must be an object/);
    bad({ findings: 'many' }, /findings must be an array/);
    bad({ findings: Array.from({ length: MAX_FINDINGS + 1 }, () => f) }, /at most/);
    assert.equal(run({ findings: Array.from({ length: MAX_FINDINGS }, () => f) }).findings.length, MAX_FINDINGS);
    const long = run({ findings: [{ ...f, code: 'c'.repeat(300), page: `/${'p'.repeat(900)}`, target: 't'.repeat(5000), message: 'm'.repeat(3000),
      pages: Array.from({ length: 50 }, (_, i) => `/${i}${'x'.repeat(600)}`), count: 50 }] }).findings[0];
    assert.deepEqual([long.code.length, long.page.length, long.target.length, long.message.length], [100, 500, 2000, 1000]);
    assert.equal(long.pages.length, MAX_PAGES_LISTED);
    assert.ok(long.pages.every((p) => p.length <= 500));
    assert.equal(long.count, 50);
  });

  test('a finding’s count is at least the pages listed, and the run’s counts follow the findings', () => {
    const f = { check: 'links', level: 'fail', code: 'c', page: '/a/', target: 't', message: 'm', pages: ['/a/', '/b/', '/c/'], count: 1 };
    assert.equal(run({ findings: [f] }).findings[0].count, 3);
    assert.deepEqual(run({ findings: [] }).counts, { warn: 0, fail: 0 });
    assert.deepEqual(run({ findings: [f, { ...f, code: 'd' }, { ...f, code: 'e', level: 'warn' }] }).counts, { warn: 1, fail: 2 });
  });

  test('detail: at most 20 keys of strings, numbers, booleans and null', () => {
    const f = (detail: unknown) => ({ check: 'links', level: 'warn', code: 'c', page: '/', target: 't', message: 'm', pages: ['/'], count: 1, detail });
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    assert.equal(Object.keys(run({ findings: [f(keys(20))] }).findings[0].detail!).length, 20);
    bad({ findings: [f(keys(21))] }, /more than 20 keys/);
    bad({ findings: [f({ a: { b: 1 } })] }, /detail\.a/);
    bad({ findings: [f({ a: [1] })] }, /detail\.a/);
    bad({ findings: [f([1])] }, /detail must be an object/);
    const d = run({ findings: [f({ s: 'x'.repeat(900), n: 1.5, b: true, z: null })] }).findings[0].detail!;
    assert.deepEqual([(d.s as string).length, d.n, d.b, d.z], [500, 1.5, true, null]);
  });
});
