// Analytics.3b: does Lost Emerald keep its page_referrer and take the channel from the shared snippet?
//
//   node scripts/verify-lostemerald-channel.ts [--html PATH] [--snippet src/cdn/vault-channel.js] \
//     [--out docs/verification/analytics-3b-lost-emerald.md] [--write]
//
// What it does, all from this worktree (no network, no browser, no CDN):
//   1. finds the shared snippet and Lost Emerald's per-game override / built iframe.html, and checks the snippet's
//      precondition: the `pbswi` → `pbswisconsineducation.org` alias, the `vault` default, and a report of its own;
//   2. says what this card must do to Lost Emerald's layer — keep page_referrer and remove (or guard) its own
//      channel setting, or nothing at all when it has none;
//   3. runs the wrapper with recording gtag/ga stubs for `?vault_ch=pbswi`, for no parameters framed, and for
//      `?vault_src=<url>`, and reports the channel each load reported, HOW MANY TIMES, and the page_referrer it set.
//
// With --write the resolution is applied to Lost Emerald's own file; without it nothing is written. The shared
// snippet, the shared template and Jo Wilder's wrapper are never written to, with or without --write.
// Exits 0 when the check passed or is honestly gated on sibling work, 1 when it found a drift or a double report.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkFails, checkLostEmerald, LOSTEMERALD, referrerPreserved, resolveLostEmerald, resolutionHolds,
  VERIFICATION_DOC, type LostEmeraldCheck,
} from '../src/channel-lostemerald.ts';
import { TEMPLATE_CARD } from '../src/channel-jowilder.ts';
import {
  acceptancePasses, casesTable, reconstructedInnerFrame, runCases,
} from '../src/channel-lostemerald-run.ts';
import { SNIPPET_PATH } from '../src/channel-wrappers.ts';

const { values: args } = parseArgs({
  options: {
    html: { type: 'string' }, snippet: { type: 'string' }, out: { type: 'string' }, write: { type: 'boolean' },
  },
});

const read = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const snippetPath = args.snippet ?? SNIPPET_PATH;

/** The commit the check was run against, so the recorded outcome names the code it observed. Never fatal. */
function baseRef(): string {
  const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  try {
    const head = git('rev-parse', 'HEAD');
    try { return `origin/staging ${git('rev-parse', 'origin/staging')} (HEAD ${head})`; }
    catch { return `HEAD ${head}`; }
  } catch { return 'not a git worktree'; }
}

const check: LostEmeraldCheck = args.html
  ? (() => {
    const html = read(args.html);
    const snippet = read(snippetPath);
    const base = checkLostEmerald((p) => (p === snippetPath ? snippet : null));
    return {
      ...base,
      outer: { path: args.html!, text: html, tried: [args.html!] },
      plan: html !== null && snippet !== null ? resolveLostEmerald(html, snippet) : base.plan,
    };
  })()
  : checkLostEmerald(read);

const lines: string[] = [];
const say = (s = '') => lines.push(s);

say(`# Analytics.3b — ${LOSTEMERALD.slug}: page_referrer kept, channel from the shared snippet`);
say();
say(`Run: ${new Date().toISOString()}`);
say(`Base: ${baseRef()}`);
say(`Shared snippet: ${check.snippet.path ?? 'not found'}`);
say(`Lost Emerald's override: ${check.outer.path ?? 'none (it receives the shared template)'}`);
say(`Lost Emerald's built inner frame: ${check.inner.path ?? 'not built in this worktree'}`);
say();

say('## The shared snippet\'s precondition');
say();
say(`* \`pbswi\` → \`pbswisconsineducation.org\`: **${check.snippetReady.aliases ? 'yes' : 'NO'}**`);
say(`* a \`vault\` default inside the player: **${check.snippetReady.vaultDefault ? 'yes' : 'NO'}**`);
say(`* reports the channel itself (not resolution only): **${check.snippetReady.reports ? 'yes' : 'NO'}**`);
say();

say('## The shared marker block in the built wrapper');
say();
say(`Verdict: **${check.block.verdict}** — ${check.block.reason}`);
say();
if (check.block.diff) { say('```diff'); say(check.block.diff); say('```'); say(); }

say('## What this card does to Lost Emerald\'s layer');
say();
if (!check.plan) say('Nothing decided: there is no Lost Emerald wrapper in this worktree to decide about.');
else {
  say(`**${check.plan.resolution}** — ${check.plan.reason}`);
  say();
  say(`* page_referrer lines kept: ${check.plan.referrer.length ? check.plan.referrer.map((l) => `\`${l}\``).join(', ') : '(none found)'}`);
  say(`* game-specific channel lines ${check.plan.changed ? 'removed / guarded' : 'found'}: ${check.plan.channel.length ? check.plan.channel.map((l) => `\`${l}\``).join(', ') : '(none)'}`);
  say(`* page_referrer set before the shared block runs: ${check.referrerFirst === null ? 'not applicable here' : check.referrerFirst ? 'yes' : 'NO'}`);
  say(`* a stand-down guard, if one was needed, runs after the shared block: ${check.guardOrder === null ? 'no guard needed' : check.guardOrder ? 'yes' : 'NO — it would report the channel before the shared snippet could, and the play would be reported twice'}`);
  say(`* page_referrer behaviour preserved by the rewrite: ${referrerPreserved(check.outer.text ?? check.inner.text ?? '', check.plan.html) ? 'yes' : 'NO'}`);
}
say();

const page = check.outer.text ?? check.inner.text;
say('## What one load reports (stubbed gtag/ga)');
say();
if (page !== null) {
  const results = runCases(page);
  say(`Loaded: \`${check.outer.path ?? check.inner.path}\` (the wrapper in this worktree).`);
  say();
  say(casesTable(results));
  say();
  say(acceptancePasses(results)
    ? 'Every case reported the expected channel exactly once, with the page_referrer still set.'
    : 'Not every case passed; the table says which and how.');
} else if (check.snippet.text !== null) {
  // No wrapper to load yet, so the behaviour is observed on the inner frame this card's shape produces: this
  // worktree's own snippet, the caller the shared template provides, and Lost Emerald's page_referrer script before
  // it, with no game-specific channel setting. A reconstruction, named as one — not the built file.
  const results = runCases(reconstructedInnerFrame(check.snippet.text));
  say(`Loaded: a RECONSTRUCTION of the inner frame — \`${check.snippet.path}\`'s own text between the markers, the`);
  say('caller the shared template provides, and Lost Emerald\'s `page_referrer` script before it. The channel logic in');
  say('it is the snippet\'s own text, so what it reports is what the snippet reports; the surrounding template is');
  say(`**${TEMPLATE_CARD}**'s and only the built file can confirm it. Re-run with \`--html <built iframe.html>\` once it exists.`);
  say();
  say(casesTable(results));
  say();
  say(acceptancePasses(results)
    ? 'Every case reported the expected channel exactly once, with the page_referrer still set.'
    : 'Not every case passed; the table says which and how.');
} else {
  say('Not run: neither a wrapper nor the shared snippet is in this worktree. Nothing was stubbed in; nothing was guessed.');
}
say();

if (check.gate) {
  say('## Not fully checkable yet');
  say();
  say(check.gate);
  say();
  say('Neither the shared snippet, the shared template nor Jo Wilder\'s wrapper was touched to work around this.');
  say();
}

const report = `${lines.join('\n')}\n`;
console.log(report);

if (args.write && check.plan?.changed && check.outer.path) {
  writeFileSync(check.outer.path, check.plan.html);
  console.log(`Wrote ${check.outer.path}: ${check.plan.resolution}.`);
} else if (args.write) {
  console.log(`Nothing written: ${check.plan?.reason ?? 'there is no Lost Emerald page in this worktree to change.'}`);
}

if (args.out) {
  const out = args.out === 'doc' ? VERIFICATION_DOC : args.out;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);
}
process.exit(checkFails(check) && !resolutionHolds(check) && check.plan?.changed ? 1 : 0);
