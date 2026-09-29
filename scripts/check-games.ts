// Checks that every game on a Vault site still loads, from the portal's public catalog.
//
//   node scripts/check-games.ts --portal https://portal.vaultlearninggames-staging.org \
//     [--site https://vaultlearninggames-staging.org] [--out game-checks.json] [--summary summary.md] \
//     [--issue issue.md] [--source RUN_URL] [--only slug,slug]
//
// Prints a table and writes the run as JSON (--out, the body POST /v1/admin/game-checks takes). --summary writes a
// Markdown report (the GitHub job summary) and --issue the Markdown for the tracking issue. The site origin defaults
// to the portal's address without "portal." (framing is checked against it). Exits 0 whether or not games are down;
// 1 only when the check itself couldn't run. A portal that doesn't serve /v1/catalog yet gives a run with
// "skipped" set and no games.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { classify, countLevels, shouldRetry, sortForReport, type GameCheck, type GameCheckRun, type Probe } from '../src/game-checks.ts';

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const PER_HOST = 2;          // many games share a host (PhET, iCivics); don't hit one with eight at once
const MAX_REDIRECTS = 10;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 VaultGameCheck/1 (+https://vaultlearninggames.org)';

interface CatalogGame {
  slug: string;
  title: string;
  studio: { slug: string; name: string };
  play: { url: string; source: 'url' | 'cdn'; embed: boolean };
}
type Run = GameCheckRun & { portal: string; skipped?: string };

const { values: args } = parseArgs({
  options: {
    portal: { type: 'string' }, site: { type: 'string' }, out: { type: 'string' }, summary: { type: 'string' },
    issue: { type: 'string' }, source: { type: 'string' }, only: { type: 'string' },
  },
});
if (!args.portal) {
  console.error('usage: node scripts/check-games.ts --portal https://portal.vaultlearninggames-staging.org [--site ORIGIN] [--out FILE]');
  process.exit(2);
}
const portal = args.portal.replace(/\/+$/, '');
const site = new URL(args.site || portal.replace('://portal.', '://')).origin;

// ---------- fetching ----------
function errorOf(err: unknown): { code: string; message: string } {
  const e = err as Error & { code?: string; cause?: Error & { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { code: 'TimeoutError', message: 'timed out' };
  const cause = e?.cause;
  return { code: cause?.code ?? e?.code ?? e?.name ?? 'Error', message: cause?.message ?? e?.message ?? String(err) };
}

// One GET with redirects followed by hand, so every hop is recorded.
async function probeOnce(url: string): Promise<Probe> {
  const started = performance.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const redirects: string[] = [];
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(current, {
        redirect: 'manual', signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${site}/` },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) return { status: null, final_url: current, redirects, ms: null, attempts: 1, headers: {}, error: { code: 'TOO_MANY_REDIRECTS', message: 'too many redirects' } };
        current = new URL(location, current).href;
        redirects.push(current);
        continue;
      }
      const ms = Math.round(performance.now() - started);
      await res.body?.cancel();
      return { status: res.status, final_url: current, redirects, ms, attempts: 1, headers: Object.fromEntries(res.headers), error: null };
    }
  } catch (err) {
    return { status: null, final_url: current, redirects, ms: null, attempts: 1, headers: {}, error: errorOf(err) };
  }
}

async function probe(url: string): Promise<Probe> {
  const first = await probeOnce(url);
  if (!shouldRetry(first)) return first;
  await new Promise((r) => setTimeout(r, 2000));
  return { ...(await probeOnce(url)), attempts: 2 };
}

async function check(g: CatalogGame): Promise<GameCheck> {
  let p: Probe | null = null;
  try { if (/^https?:\/\//i.test(g.play.url)) p = await probe(g.play.url); } catch { /* classify reports it as unchecked */ }
  const verdict = classify({ url: g.play.url, embed: g.play.embed }, p, { siteOrigin: site, timeoutMs: TIMEOUT_MS });
  return {
    slug: g.slug, title: g.title, studio: g.studio.slug, url: g.play.url, source: g.play.source, embed: g.play.embed,
    status: p?.status ?? null, final_url: p?.final_url ?? null, redirects: p?.redirects ?? [], ms: p?.ms ?? null,
    attempts: p?.attempts ?? 0, error: p?.error ? `${p.error.code}: ${p.error.message}` : null,
    framing: verdict.framing, level: verdict.level, problems: verdict.problems,
  };
}

// Up to CONCURRENCY checks at once, and at most PER_HOST against any one host.
async function checkAll(games: CatalogGame[]): Promise<GameCheck[]> {
  const host = (g: CatalogGame) => { try { return new URL(g.play.url).host; } catch { return ''; } };
  const pending = [...games.keys()];
  const busy = new Map<string, number>();
  const results: GameCheck[] = new Array(games.length);
  let running = 0, done = 0;
  return new Promise((resolve) => {
    const pump = () => {
      if (done === games.length) return resolve(results);
      for (let i = 0; i < pending.length && running < CONCURRENCY; ) {
        const idx = pending[i], h = host(games[idx]);
        if ((busy.get(h) ?? 0) >= PER_HOST) { i++; continue; }
        pending.splice(i, 1);
        running++; busy.set(h, (busy.get(h) ?? 0) + 1);
        check(games[idx]).then((r) => {
          results[idx] = r;
          running--; done++; busy.set(h, busy.get(h)! - 1);
          if (process.stderr.isTTY) process.stderr.write(`\r${done}/${games.length} checked`);
          pump();
        });
      }
    };
    pump();
  });
}

// ---------- reports ----------
const ICON = { ok: '✅', warn: '⚠️', fail: '❌' } as const;
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const portalPage = `${portal}/vault/listings`;

function table(run: Run): string {
  const rows = sortForReport(run.games).map((g) => [g.level.toUpperCase(), g.slug, g.status === null ? '—' : String(g.status), secs(g.ms), g.embed ? 'in-page' : 'new tab', g.problems.join('; ') || '']);
  const head = ['LEVEL', 'GAME', 'HTTP', 'TIME', 'OPENS', 'PROBLEMS'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(Math.min(width[i], 40)))).join('  ');
  return [line(head), ...rows.map(line)].join('\n');
}

function countsLine(run: Run) {
  return `${run.games.length} games: ${run.counts.ok} ok, ${run.counts.warn} warnings, ${run.counts.fail} failing`;
}

function markdownSummary(run: Run): string {
  if (run.skipped) return `## Game availability: ${site}\n\nSkipped: ${run.skipped}\n`;
  const out = [`## Game availability: ${site}`, '', `${ICON.fail} **${run.counts.fail}** failing · ${ICON.warn} **${run.counts.warn}** warnings · ${ICON.ok} **${run.counts.ok}** ok, of ${run.games.length} games on the site. Details in the portal: ${portalPage}`, ''];
  const shown = sortForReport(run.games).filter((g) => g.level !== 'ok');
  if (shown.length) {
    out.push('| | Game | Plays from | HTTP | Time | Problem |', '|---|---|---|---|---|---|');
    for (const g of shown) out.push(`| ${ICON[g.level]} | ${cell(g.title || g.slug)} (\`${g.slug}\`) | ${cell(g.url)}${g.embed ? '' : ' (new tab)'} | ${g.status ?? '—'} | ${secs(g.ms)} | ${cell(g.problems.join('; '))} |`);
  } else out.push('Every game loads.');
  return out.join('\n') + '\n';
}

// The tracking issue: the current failures, with a marker the workflow compares to notice when they change.
function markdownIssue(run: Run): string {
  const failing = sortForReport(run.games).filter((g) => g.level === 'fail');
  const lines = [
    `These games on ${site} fail the daily availability check. This issue is updated by each run and closed when every game passes.`,
    '',
    `Last checked ${run.checked_at.slice(0, 16).replace('T', ' ')} UTC${run.source ? ` ([run](${run.source}))` : ''}: ${countsLine(run)}. All results: ${portalPage}`,
    '',
    '| Game | Studio | Plays from | Problem |', '|---|---|---|---|',
    ...failing.map((g) => `| ${cell(g.title || g.slug)} (\`${g.slug}\`) | ${g.studio} | ${cell(g.url)} | ${cell(g.problems.join('; '))} |`),
    '',
    `<!-- failing: ${failing.map((g) => g.slug).join(',')} -->`,
  ];
  return lines.join('\n') + '\n';
}

// ---------- main ----------
async function main() {
  const res = await fetch(`${portal}/v1/catalog`, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': UA } });
  let run: Run;
  const base = { checked_at: new Date().toISOString(), site, portal, source: args.source || null };
  if (res.status === 404) {
    run = { ...base, counts: countLevels([]), games: [], skipped: `${portal} doesn't serve /v1/catalog yet` };
    console.log(run.skipped);
  } else {
    if (!res.ok) throw new Error(`GET ${portal}/v1/catalog answered HTTP ${res.status}`);
    const catalog = (await res.json()) as { games?: CatalogGame[] };
    if (!Array.isArray(catalog.games)) throw new Error('the catalog has no games list');
    const only = args.only?.split(',').map((s) => s.trim()).filter(Boolean);
    const games = only ? catalog.games.filter((g) => only.includes(g.slug)) : catalog.games;
    console.error(`Checking ${games.length} games from ${portal} (framing from ${site})`);
    const checked = await checkAll(games);
    if (process.stderr.isTTY) process.stderr.write('\n');
    run = { ...base, checked_at: new Date().toISOString(), counts: countLevels(checked), games: checked };
    console.log(table(run));
    console.log(`\n${countsLine(run)}`);
  }
  if (args.out) writeFileSync(args.out, JSON.stringify(run, null, 2) + '\n');
  if (args.summary) writeFileSync(args.summary, markdownSummary(run));
  if (args.issue) writeFileSync(args.issue, markdownIssue(run));
}

main().catch((err) => {
  console.error(`check-games: ${(err as Error).message}`);
  process.exit(1);
});
