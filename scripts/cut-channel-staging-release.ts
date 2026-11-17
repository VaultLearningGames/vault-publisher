// Analytics.4a: gate on the sibling channel work in origin/staging, then cut the STAGING release.
//
//   node scripts/cut-channel-staging-release.ts \
//     [--publisher https://portal.vaultlearninggames-staging.org] [--cdn https://cdn.vaultlearninggames-staging.org] \
//     [--studio fieldday] [--game jowilder] [--version channel-<sha12>] [--token BEARER] \
//     [--cut] [--out report.md | --out doc] [--json run.json]
//
// What it does, in the card's order:
//   1. `git fetch origin --prune`, then reads `origin/staging`'s SHA — every check below is made against that ref
//      (`git ls-tree`/`git show`), never the working tree, a local branch or a PR head;
//   2. the three gate checks (src/channel-release-gate.ts): the shared snippet, the outer/inner template inclusion,
//      and the Jo Wilder / Lost Emerald wrappers. If ANY fails it stops and prints the blocker comment — naming the
//      missing artifact and the sibling card that owns it — and cuts nothing;
//   3. only when all three pass, and only with --cut, it follows the documented release procedure for STAGING
//      (docs/setup.md "Release"; POST /v1/admin/releases/publish on the staging portal), recording the release id,
//      the SHA it was cut from, and the release that was live before it for rollback;
//   4. one smoke check: a CDN game's outer index.html from the staging CDN must be HTTP 200 and carry
//      VAULT_CHANNEL_LOGIC_START. (Full per-game verification is scripts/verify-channel-edge-cases.ts's card.)
//
// Staging only, by construction: a non-staging publisher or CDN address is refused before anything is read, so this
// command can never promote to production — production releases go through .github/workflows/release.yml and its
// required approval. Without --cut it is a dry run: the gate is evaluated and reported, and nothing is released.
// Exits 0 when the run came out right, 1 when the gate blocked it or the release/smoke check failed, 2 on bad usage.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  gateChecks, judgeSmoke, playUrl, publishUrl, releaseAllowed, releaseCheckUrl, releaseVersionFor, reportMarkdown,
  runFails, smokeUrl, stagingOnlyProblem, STAGING_CDN_BASE, STAGING_PORTAL, GATE_REF, VERIFICATION_DOC,
  type ReleaseRun, type SmokeResult, type StagingRelease, type Tree,
} from '../src/channel-release-gate.ts';

const { values: args } = parseArgs({
  options: {
    publisher: { type: 'string' }, cdn: { type: 'string' }, studio: { type: 'string' }, game: { type: 'string' },
    version: { type: 'string' }, token: { type: 'string' }, cut: { type: 'boolean' },
    out: { type: 'string' }, json: { type: 'string' },
  },
});

const publisher = (args.publisher ?? STAGING_PORTAL).replace(/\/+$/, '');
const cdn = (args.cdn ?? STAGING_CDN_BASE).replace(/\/+$/, '');
const studio = args.studio ?? 'fieldday';
const game = args.game ?? 'jowilder';

const staging = stagingOnlyProblem([publisher, cdn]);
if (staging) {
  console.error(`Refused: ${staging}`);
  process.exit(2);
}

const say = (s = '') => console.log(s);
/** Every command this run made, quoted in the completion or blocker comment. */
const commands: string[] = [];

const git = (...a: string[]): string => {
  commands.push(`git ${a.join(' ')}`);
  return execFileSync('git', a, { encoding: 'utf8' });
};

// ---------- step 1: the gate ref ----------

try { git('fetch', 'origin', '--prune'); } catch { say(`(could not fetch origin; reading ${GATE_REF} as it is here)`); }

let sha: string | null = null;
try { sha = git('rev-parse', GATE_REF).trim(); } catch { sha = null; }
if (sha === null) {
  console.error(`Refused: there is no ${GATE_REF} in this worktree, so the gate cannot be decided.`);
  process.exit(2);
}

/** The ref's paths and a reader for them: every check is made against this commit alone. */
function treeAt(ref: string): Tree {
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\n').filter(Boolean);
  commands.push(`git ls-tree -r --name-only ${ref}`);
  const cache = new Map<string, string | null>();
  return {
    paths,
    read: (path: string) => {
      if (!cache.has(path)) {
        // stdio 'pipe' for stderr: a path that isn't in the commit is an expected answer here (that is what the
        // gate is asking), not something to print a `fatal:` line about.
        try { cache.set(path, execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })); }
        catch { cache.set(path, null); }
      }
      return cache.get(path) ?? null;
    },
  };
}

const tree = treeAt(sha);
commands.push(`git grep -c VAULT_CHANNEL_LOGIC_START ${sha}`);
const checks = gateChecks(tree);

// ---------- step 3: the release ----------

/** The release that is live for this game on staging now, so the run records what to roll back to. */
async function currentRelease(): Promise<string | null> {
  const url = `${releaseCheckUrl(publisher, studio, game)}?action=promote`;
  commands.push(`curl -sS '${url}'`);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json() as { current?: { version?: string } };
    return body.current?.version ?? null;
  } catch { return null; }
}

/** The documented staging release: POST /v1/admin/releases/publish on the staging portal (docs/setup.md). */
async function cutRelease(version: string): Promise<{ release: StagingRelease | null; notCut: string | null }> {
  const token = args.token ?? process.env.VAULT_PUBLISHER_TOKEN?.trim();
  if (!token) {
    return {
      release: null,
      notCut: 'no credential for the staging portal in this environment (--token / VAULT_PUBLISHER_TOKEN): the '
        + `release is cut by running \`${publishUrl(publisher)}\` with a staff or workflow token.`,
    };
  }
  const url = publishUrl(publisher);
  const body = { studio, game, version, ref: sha, promote: true };
  commands.push(`curl -sS -X POST '${url}' -H 'Authorization: Bearer ***' -d '${JSON.stringify(body)}'`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { release: null, notCut: `the staging portal refused the release (HTTP ${res.status}): ${text.slice(0, 400)}` };
    const json = JSON.parse(text) as { approved?: boolean; promoted?: boolean; done?: boolean };
    return {
      release: {
        id: version, sha: sha as string, studio, game, publisher,
        approved: json.approved !== false, promoted: json.promoted === true,
        url: playUrl(cdn, studio, game),
      },
      notCut: json.done === false ? 'the publisher answered done: false — the copy needs another call to finish' : null,
    };
  } catch (err) {
    return { release: null, notCut: `the staging portal could not be reached: ${(err as Error).message}` };
  }
}

// ---------- step 4: the smoke check ----------

async function smoke(): Promise<SmokeResult> {
  const url = smokeUrl(cdn, studio, game);
  commands.push(`curl -sS -o - -w '%{http_code}' '${url}'`);
  try {
    const res = await fetch(url);
    return judgeSmoke(url, res.status, await res.text());
  } catch (err) {
    return judgeSmoke(url, null, null, (err as Error).message);
  }
}

// ---------- the run ----------

const version = args.version ?? releaseVersionFor(sha);
const run: ReleaseRun = { ref: GATE_REF, sha, cdn, checks, release: null, previous: null, smoke: null, notCut: null };

if (releaseAllowed(checks)) {
  run.previous = await currentRelease();
  if (args.cut) {
    const cut = await cutRelease(version);
    run.release = cut.release;
    run.notCut = cut.notCut;
  } else {
    run.notCut = `dry run: the gate passed, so re-run with --cut (and a staging token) to cut \`${version}\` from ${sha}.`;
  }
  run.smoke = await smoke();
}

const report = reportMarkdown(run, commands);
say(report);

if (args.out) {
  const out = args.out === 'doc' ? VERIFICATION_DOC : args.out;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${report}\n`);
}
if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, `${JSON.stringify({ ...run, commands }, null, 2)}\n`);
}

process.exit(runFails(run) ? 1 : 0);
