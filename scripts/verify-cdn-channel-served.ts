// Analytics.4b: grep the DEPLOYED staging CDN artifacts — index.html, iframe.html and any further hop — for the
// shared channel snippet, for three games chosen from the publisher's own CDN game list.
//
//   node scripts/verify-cdn-channel-served.ts \
//     [--base https://cdn.vaultlearninggames-staging.org] [--catalog https://portal.vaultlearninggames-staging.org] \
//     [--games a,b,c | --all] [--release <id>] [--probe 'vault_ch=pbswi&…' | --probe ''] \
//     [--out report.md | --out doc] [--json run.json] [--observe] [--allow-any-host]
//
// What it does, in the card's order:
//   1. takes the staging release id from Analytics.4a (--release, else the id recorded in
//      docs/verification/analytics-4a-staging-release.md) and asks whether the served bytes can be shown to be that
//      release's — a build stamp, a data-build or a cache-busting asset hash in the fetched index.html. With NO
//      release id it stops: the report is a blocker against Analytics.4a and not one byte is fetched;
//   2. reads the CDN game list from the publisher's catalog (GET /v1/catalog, the same list the site plays from) and
//      picks three games from it — the-legend-of-the-lost-emerald, the first of The Yard's games, and the first
//      further ordinary CDN game. Never a hand-written list; a list it cannot read is a blocker, not a guess;
//   3. fetches each game's outer index.html, the frame that page builds, and any further hop (to depth 4, with a
//      cycle guard), and counts VAULT_CHANNEL_LOGIC_START, vaultResolveChannel and the `pbswi` →
//      `pbswisconsineducation.org` alias entry in each served layer;
//   4. checks that every layer passes the source params (vault_ch, vault_src, utm_*) to the next one unchanged.
//
// Read-only and staging only: it refuses a non-staging address unless --allow-any-host is passed deliberately, it
// writes nothing but its own report, and a game whose deployed artifact lacks the snippet at any layer is reported
// BY NAME as a blocker against the snippet card rather than hand-patched. Exits 0 when all three games pass, 1 when
// a blocker (or the release gate) was found, 2 on bad usage.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  cdnGames, CATALOG_PATH, forwardingAcross, judgeRelease, pickGames, releaseIdIn, runBlockers, runFails,
  selectServedGames, servedMarkdown, STAGING_CDN_BASE, VERIFICATION_DOC, walkLayers,
  type CatalogGame, type CdnGame, type Fetched, type ServedGame, type ServedRun,
} from '../src/channel-served.ts';
import { VERIFICATION_DOC as RELEASE_DOC } from '../src/channel-release-gate.ts';
import { AC_QUERY } from '../src/channel-forwarding.ts';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' }, catalog: { type: 'string' }, games: { type: 'string' }, all: { type: 'boolean' },
    release: { type: 'string' }, probe: { type: 'string' }, out: { type: 'string' }, json: { type: 'string' },
    'allow-any-host': { type: 'boolean' }, observe: { type: 'boolean' },
  },
});

const base = (args.base ?? STAGING_CDN_BASE).replace(/\/+$/, '');
const catalog = (args.catalog ?? 'https://portal.vaultlearninggames-staging.org').replace(/\/+$/, '');

const isStaging = (u: string) => { try { return /staging/i.test(new URL(u).hostname); } catch { return false; } };
if (!args['allow-any-host'] && ![base, catalog].every(isStaging)) {
  console.error('This check only ever reads staging; pass --allow-any-host deliberately. Production is never touched.');
  process.exit(2);
}

const say = (s = '') => console.log(s);

/** Every address fetched, so the report's release check re-reads the outer page's body instead of fetching it twice. */
const fetched = new Map<string, Fetched>();

/** One fetch, following redirects, never throwing: a failure is an answer the report prints. */
async function get(url: string): Promise<Fetched> {
  const before = fetched.get(url);
  if (before) return before;
  let answer: Fetched;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25_000) });
    answer = { status: res.status, text: await res.text(), finalUrl: res.url || url, error: null };
  } catch (err) {
    answer = { status: null, text: null, finalUrl: url, error: (err as Error).message };
  }
  fetched.set(url, answer);
  return answer;
}

// ---------- step 1: the release id Analytics.4a produced ----------

function releaseFromDoc(): { id: string | null; how: string } {
  if (args.release) return { id: args.release, how: 'given with --release' };
  let doc: string | null = null;
  try { doc = readFileSync(RELEASE_DOC, 'utf8'); } catch { doc = null; }
  const id = releaseIdIn(doc);
  if (id) return { id, how: `the release id recorded in \`${RELEASE_DOC}\`` };
  return {
    id: null,
    how: doc === null
      ? `no \`${RELEASE_DOC}\` in this worktree and no --release given`
      : `\`${RELEASE_DOC}\` records a blocker, not a release id`,
  };
}

// ---------- step 2: the CDN game list, from the publisher ----------

async function listGames(): Promise<{ games: CdnGame[]; problem: string | null }> {
  const url = `${catalog}${CATALOG_PATH}`;
  const got = await get(url);
  if (got.status !== 200 || got.text === null) {
    return { games: [], problem: `the publisher's CDN game list could not be read: GET ${url} answered ${got.error ?? `HTTP ${got.status}`}` };
  }
  let games: CatalogGame[];
  try {
    const body = JSON.parse(got.text) as { games?: CatalogGame[] };
    if (!Array.isArray(body.games)) throw new Error('the catalog has no games list');
    games = body.games;
  } catch (err) {
    return { games: [], problem: `the publisher's catalog at ${url} could not be read as the game list: ${(err as Error).message}` };
  }
  const cdn = cdnGames(games, base);
  if (!cdn.length) return { games: [], problem: `${url} lists ${games.length} game(s) but none played from ${base}` };
  return { games: cdn, problem: null };
}

// ---------- the run ----------

const release = releaseFromDoc();
const wanted = args.all ? [] : (args.games?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
// The acceptance criteria's own probe by default (?vault_ch=pbswi&vault_src=…&utm_source=x): step 4 can only be
// answered when the outer page was given something to forward. `--probe ''` fetches the bare page instead.
const probe = (args.probe ?? AC_QUERY).replace(/^\?/, '');

const run: ServedRun = {
  cdn: base,
  catalog,
  at: new Date().toISOString(),
  release: judgeRelease(release.id, release.how, null),
  selection: { games: [], why: [], skipped: [], problem: null },
  listed: 0,
  games: [],
  query: probe,
  gate: null,
  observeOnly: false,
};

// The card's STOP: with no release id from Analytics.4a there is nothing to verify an artifact against, so the report
// is that blocker. --observe fetches the layers anyway, as an observation the blocker can be acted on — labelled as
// one in the report, and still exit 1.
if (release.id === null) run.gate = run.release.reason;
if (release.id !== null || args.observe) {
  run.observeOnly = release.id === null;
  const listed = await listGames();
  run.listed = listed.games.length;
  if (listed.problem) {
    run.gate ??= listed.problem;
  } else {
    run.selection = args.all
      ? { games: listed.games, why: listed.games.map((g) => `${g.slug}: --all (the whole CDN list)`), skipped: [], problem: null }
      : wanted.length
        ? pickGames(listed.games, wanted)
        // No --games: each role's first candidate in list order whose outer page is actually served, so a game whose
        // artifact is not deployed is named as a blocker AND the card still greps three games that exist.
        : await selectServedGames(listed.games, async (g) => {
          const got = await get(`${g.base}index.html`);
          return { status: got.status, error: got.error };
        });
    if (!run.selection.games.length && run.selection.problem) run.gate ??= run.selection.problem;
    else {
      const games: ServedGame[] = [];
      for (const game of run.selection.games) {
        say(`${game.slug}: ${game.base}`);
        const layers = await walkLayers(game.base, get, probe);
        for (const layer of layers) {
          say(`  ${layer.kind}: ${layer.url} → ${layer.error ? `error ${layer.error}` : `HTTP ${layer.status}`}`
            + ` (marker ${layer.hits.marker}, resolver ${layer.hits.resolver}, alias ${layer.hits.alias})`);
        }
        games.push({ slug: game.slug, title: game.title, base: game.base, yardgame: game.yardgame, layers, forwarding: forwardingAcross(layers) });
      }
      run.games = games;
      // The release check is re-judged now the outer page has actually been read, so its stamps are real.
      const outer = games[0]?.layers[0] ?? null;
      if (outer) {
        const body = await get(outer.url);
        run.release = judgeRelease(release.id, release.how, body.text);
      }
    }
  }
}

const report = servedMarkdown(run);
say();
say(report);

if (args.out) {
  const out = args.out === 'doc' ? VERIFICATION_DOC : args.out;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report);
  say(`written: ${out}`);
}
if (args.json) {
  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, `${JSON.stringify(run, null, 2)}\n`);
}

for (const blocker of runBlockers(run)) say(`BLOCKER ${blocker}`);
process.exit(runFails(run) ? 1 : 0);
