// The website's Play gate (site/themes/vault-squarespace/assets/js/play-gate.js): the decision whether a game can start
// in the space the browser has. The file is a browser script; it is run here as the page runs it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

type Size = { w: number; h: number };
type Opts = { bar?: number; turnable?: boolean; screen?: Size; fullscreen?: boolean; largest?: Size };
const sandbox: { VaultPlayGate?: { decide(need: Size | null, have: Size, o?: Opts): { verdict: string; to?: string; turned?: Size }; parseSize(s: unknown): Size | null } } = {};
vm.runInNewContext(readFileSync(new URL('../site/themes/vault-squarespace/assets/js/play-gate.js', import.meta.url), 'utf8'), sandbox);
// (Objects made in the script's own context have its prototypes; copy them out to compare.)
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const gate = sandbox.VaultPlayGate!;
const decide: typeof gate.decide = (...a) => plain(gate.decide(...a));
const parseSize: typeof gate.parseSize = (s) => plain(gate.parseSize(s));
const need = { w: 960, h: 540 };
const verdict = (have: Size, o?: Opts, n: Size | null = need) => decide(n, have, o).verdict;

describe('the Play gate', () => {
  test('plays whenever the area is at least the minimum, or there is none', () => {
    assert.equal(verdict({ w: 960, h: 540 }), 'play');
    assert.equal(verdict({ w: 1920, h: 1024 }), 'play');
    assert.equal(verdict({ w: 300, h: 200 }, {}, null), 'play');
    assert.equal(verdict({ w: 300, h: 200 }, {}, { w: 0, h: 0 }), 'play');
  });

  test('both sides must fit', () => {
    assert.equal(verdict({ w: 959, h: 900 }), 'small');
    assert.equal(verdict({ w: 1600, h: 539 }), 'small');
  });

  test('a phone or tablet held the wrong way is told to turn', () => {
    // An 820 × 1180 tablet held upright: 820 × 1124 below the bar; turned, 1180 × 764.
    const r = decide(need, { w: 820, h: 1124 }, { bar: 56, turnable: true, screen: { w: 820, h: 1180 } });
    assert.deepEqual([r.verdict, r.to, r.turned], ['rotate', 'landscape', { w: 1180, h: 764 }]);
    // A game made for upright screens, on a phone held sideways.
    assert.deepEqual(decide({ w: 360, h: 640 }, { w: 844, h: 334 }, { bar: 56, turnable: true }).to, 'portrait');
    // A computer isn't turned.
    assert.notEqual(verdict({ w: 820, h: 1124 }, { bar: 56, turnable: false, screen: { w: 820, h: 1180 } }), 'rotate');
  });

  test('a phone too small either way is told so', () => {
    assert.equal(verdict({ w: 390, h: 796 }, { bar: 48, turnable: true, screen: { w: 390, h: 844 } }), 'small');
    assert.equal(verdict({ w: 844, h: 334 }, { bar: 56, turnable: true, screen: { w: 844, h: 390 }, fullscreen: false }), 'small');
  });

  test('full screen, when the whole screen is big enough and the browser can do it', () => {
    // A 1366 × 768 laptop: the browser leaves about 1366 × 600 for the player below its bar.
    const laptop = { bar: 56, screen: { w: 1366, h: 768 }, largest: { w: 1366, h: 657 } };
    assert.equal(verdict({ w: 1366, h: 600 }, { ...laptop, fullscreen: true }, { w: 1024, h: 700 }), 'fullscreen');
    // Without full screen, a bigger window can't do it either: the browser's bars take the rest.
    assert.equal(verdict({ w: 1366, h: 600 }, { ...laptop, fullscreen: false }, { w: 1024, h: 700 }), 'small');
  });

  test('a small window on a big screen is told to grow', () => {
    assert.equal(verdict({ w: 700, h: 500 }, { bar: 56, screen: { w: 1920, h: 1080 }, largest: { w: 1920, h: 970 } }), 'resize');
    assert.equal(verdict({ w: 700, h: 500 }, { bar: 56, screen: { w: 1920, h: 1080 } }), 'resize', 'the screen when the largest window is unknown');
  });

  test('the page’s minimum size', () => {
    assert.deepEqual(parseSize('1024,768'), { w: 1024, h: 768 });
    assert.deepEqual(parseSize(' 960 × 540 '), { w: 960, h: 540 });
    for (const bad of ['', '1024', 'a,b', '0,768', null, undefined, '10,20,30']) assert.equal(parseSize(bad), null, String(bad));
  });
});
