// Analytics.3a: does Jo Wilder's wrapper report the channel exactly once, from the shared snippet's logic?
//
//   node scripts/verify-jowilder-channel.ts [--html PATH] [--snippet src/cdn/vault-channel.js] \
//     [--out report.md] [--write]
//
// What it does, all from this worktree (no network, no browser, no CDN):
//   1. finds the shared snippet and Jo Wilder's per-game override / built iframe.html (src/channel-jowilder.ts);
//   2. diffs the VAULT_CHANNEL_LOGIC block in the built wrapper against the shared snippet (AC1);
//   3. classifies every difference between Jo Wilder's inline block and the snippet as LOGIC or NON-LOGIC, and says
//      what this card must therefore do to Jo Wilder's layer — delete the duplicate, make it defer, or nothing;
//   4. runs the wrapper with a recording gtag/ga stub for ?vault_ch=pbswi, the vault_src alias cases and no
//      parameters, and reports the channel each load reported and HOW MANY TIMES (AC2), with the utm/dimension
//      output of each load so it can be compared before and after (AC3).
//
// With --write the resolution is applied to Jo Wilder's own file; without it nothing is written and the report is
// the whole output. The shared snippet and the shared template are never written to, with or without --write.
// Exits 0 when the check passed or is honestly gated on sibling work, 1 when it found a drift or a double report.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  checkFails, checkJoWilder, joWilderReport, resolveJoWilder, type JoWilderCheck,
} from '../src/channel-jowilder.ts';
import { CASES, outputsOf, loadWrapper, runCases, reportsOnce } from '../src/channel-jowilder-run.ts';
import { SNIPPET_PATH } from '../src/channel-wrappers.ts';

const { values: args } = parseArgs({
  options: {
    html: { type: 'string' }, snippet: { type: 'string' }, out: { type: 'string' }, write: { type: 'boolean' },
  },
});

const read = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const say = (s = '') => console.log(s);

const check: JoWilderCheck = args.html
  ? (() => {
    const html = read(args.html!);
    const snippet = read(args.snippet ?? SNIPPET_PATH);
    const base = checkJoWilder((p) => (p === (args.snippet ?? SNIPPET_PATH) ? snippet : null));
    return {
      ...base,
      outer: { path: args.html!, text: html, tried: [args.html!] },
      plan: html !== null && snippet !== null ? resolveJoWilder(html, snippet) : base.plan,
    };
  })()
  : checkJoWilder(read);

const report = joWilderReport(check);
say(report);

// The runtime half: one load per case, with the recording stubs.
const page = check.outer.text ?? check.inner.text;
if (page === null) {
  say('## Reports per load');
  say();
  say('Not run: Jo Wilder has no wrapper HTML in this worktree to load (the built `iframe.html` comes from the shared');
  say('template card). Nothing was stubbed in; nothing was guessed.');
} else {
  const results = runCases(page);
  say('## Reports per load (stubbed gtag/ga)');
  say();
  say('| Case | Query | Channel reported | Times | utm / dimensions set | Verdict |');
  say('| --- | --- | --- | --- | --- | --- |');
  for (const [i, r] of results.entries()) {
    const outputs = outputsOf(loadWrapper(page, CASES[i].query));
    say(`| ${r.what} | \`?${r.query || '(none)'}\` | ${r.channels.join(', ') || 'none'} | ${r.count} | ${outputs.tags.join(', ') || '(none)'} | ${r.verdict} |`);
  }
  say();
  say(reportsOnce(results)
    ? 'Every case reported the expected channel exactly once.'
    : 'Not every case reported the expected channel exactly once; the table says which.');
}

if (args.write && check.plan?.changed && check.outer.path) {
  writeFileSync(check.outer.path, check.plan.html);
  say(`\nWrote ${check.outer.path}: ${check.plan.resolution}.`);
} else if (args.write) {
  say(`\nNothing written: ${check.plan?.reason ?? 'there is no Jo Wilder page in this worktree to change.'}`);
}

if (args.out) writeFileSync(args.out, report);
process.exit(checkFails(check) ? 1 : 0);
