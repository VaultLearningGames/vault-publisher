// Runs the site checks (games load, missing assets, broken links, spelling, large files and slow loading,
// responsive design) against a Vault site, here, in headless Chromium, and reports what they found.
//
//   node scripts/check-site.ts --site https://vaultlearninggames-staging.org [--checks games,links] [--limit N] [--paths /a/,/b/]
//     [--catalog PORTAL] [--words a,b] [--guard] [--source RUN_URL] [--portal-page URL] [--fail-on fail|warn|never]
//     [--out FILE] [--summary FILE] [--issue FILE]
//
// This is what the check-site workflow runs on its GitHub runner (the portal never opens a browser); run it by hand
// with `npm run site:audit -- --site http://localhost:1313` for a local Hugo server or any site. It needs the
// dev dependencies and a browser: `npm ci && npx playwright install chromium-headless-shell`.
//   --catalog PORTAL   the names the spelling check accepts (game titles, studios, makers), from PORTAL/v1/catalog. A
//                      portal that can't answer is a warning, and the check goes on without the names.
//   --words a,b        more names to accept
//   --guard            refuse private and loopback addresses (the workflow sets it; a local site needs it off)
//   --source           the GitHub Actions run, recorded in the result
//   --portal-page      the portal's page for the results, written into the summary and the issue ("Everything: URL")
//
// Prints a table and the findings, worst first. --out writes the run as JSON (what the workflow posts to the portal),
// --summary a Markdown report (the GitHub job summary) and --issue the Markdown for the tracking issue. Under GitHub
// Actions it also prints the ::error and ::warning annotations. Exits 0 when the run passes, 1 when it fails
// (--fail-on: `fail` by default; `warn` also fails on warnings; `never` only on a run that couldn't finish), 2 when the
// check couldn't run at all (bad usage, the engine threw).
//
// The engine (and its browser) is imported only when a run starts, so a usage error needs no install.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  CHECK_LABEL, annotations, issueMarkdown, parseStart, runFails, runMarkdown,
  type CheckName, type FailOn, type Progress, type RunOptions, type SiteCheckRun,
} from '../src/site-checks.ts';

const USAGE = `usage: node scripts/check-site.ts --site https://vaultlearninggames-staging.org [--checks games,links] [--limit N] [--paths /a/,/b/]
                                  [--catalog PORTAL] [--words a,b] [--guard] [--source RUN_URL] [--portal-page URL]
                                  [--fail-on fail|warn|never] [--out FILE] [--summary FILE] [--issue FILE]`;

const MAX_SHOWN = 10;                // findings per check in the console report; --out has them all

// ---------- arguments ----------
export interface Options {
  site: string;                      // an origin
  checks: string | undefined;        // as typed; parseStart makes the list
  limit: number | undefined;
  paths: string[] | undefined;
  source: string | null;
  portalPage: string | null;         // only a link for the summary and the issue
  failOn: FailOn;
  guard: boolean;
  words: string[];
  catalog: string | null;            // a portal whose public catalog names (games, studios, makers) the spelling check accepts
  out?: string; summary?: string; issue?: string;
}

// The options, or a message saying what is wrong with them.
export function parseCli(argv: string[]): Options | string {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        site: { type: 'string' }, checks: { type: 'string' }, limit: { type: 'string' }, paths: { type: 'string' },
        source: { type: 'string' }, 'portal-page': { type: 'string' }, 'fail-on': { type: 'string' },
        out: { type: 'string' }, summary: { type: 'string' }, issue: { type: 'string' },
        guard: { type: 'boolean' }, words: { type: 'string' }, catalog: { type: 'string' },
      },
    }));
  } catch (err) {
    return (err as Error).message;
  }
  if (!values.site) return '--site is required: the address of the website to check';
  const origin = (value: string) => {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http');
      return u.origin;
    } catch { return null; }
  };
  const site = origin(values.site);
  if (!site) return '--site must be an http(s) address, e.g. https://vaultlearninggames-staging.org';
  const catalog = values.catalog ? origin(values.catalog) : null;
  if (values.catalog && !catalog) return '--catalog must be an http(s) address, e.g. https://portal.vaultlearninggames-staging.org';
  if (values['portal-page'] && !/^https?:\/\/\S+$/.test(values['portal-page'])) return '--portal-page must be an http(s) address';
  const failOn = values['fail-on'] ?? 'fail';
  if (failOn !== 'fail' && failOn !== 'warn' && failOn !== 'never') return '--fail-on must be fail, warn or never';
  // The portal's own rules for a request decide what is acceptable, so these fail here as they would anywhere.
  const request = parseStart({ checks: values.checks, limit: values.limit, paths: values.paths, source: values.source });
  if (typeof request === 'string') return request;
  return {
    site, checks: values.checks, limit: request.limit, paths: request.paths, source: request.source, portalPage: values['portal-page'] ?? null,
    failOn, guard: !!values.guard, words: (values.words ?? '').split(',').map((w) => w.trim()).filter(Boolean),
    catalog, out: values.out, summary: values.summary, issue: values.issue,
  };
}

// ---------- exit code ----------
export function exitCodeFor(run: SiteCheckRun, failOn: FailOn): 0 | 1 {
  return runFails(run, failOn) ? 1 : 0;
}

// ---------- the console report ----------
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function consoleReport(run: SiteCheckRun, maxShown = MAX_SHOWN): string {
  const out: string[] = [];
  if (run.status !== 'done') out.push(`The run did not finish (${run.status})${run.error ? `: ${run.error}` : ''}`, '');
  const rows = run.summaries.map((s) => [
    s.status === 'done' ? (s.fail ? 'FAIL' : s.warn ? 'WARN' : 'OK') : s.status.toUpperCase(),
    CHECK_LABEL[s.check], String(s.checked), String(s.fail), String(s.warn), secs(s.ms), s.note,
  ]);
  const head = ['', 'CHECK', 'LOOKED AT', 'FAIL', 'WARN', 'TIME', 'NOTE'];
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(width[i]))).join('  ').trimEnd();
  out.push(line(head), ...rows.map(line));
  for (const check of run.checks) {
    const mine = run.findings.filter((f) => f.check === check);
    if (!mine.length) continue;
    out.push('', `${CHECK_LABEL[check]}`);
    for (const f of mine.slice(0, maxShown)) {
      const where = f.count > 1 ? `${f.page || '(site)'} and ${f.count - 1} more` : f.page || '(site)';
      out.push(`  ${f.level === 'fail' ? 'FAIL' : 'warn'}  ${f.message}  [${f.target.length > 100 ? `${f.target.slice(0, 99)}…` : f.target}]  ${where}`);
    }
    if (mine.length > maxShown) out.push(`  …and ${mine.length - maxShown} more`);
  }
  out.push('', `${run.counts.fail} failing, ${run.counts.warn} worth a look, across ${run.pages} pages and ${run.games} games`);
  return out.join('\n');
}

// ---------- outputs ----------
// Print, write the files, annotate; returns the exit code.
export interface Env { GITHUB_ACTIONS?: string }
export function finish(run: SiteCheckRun, opts: Options, print: (line: string) => void, env: Env = process.env): number {
  print(consoleReport(run));
  if (env.GITHUB_ACTIONS) for (const line of annotations(run)) print(line);
  if (opts.out) writeFileSync(opts.out, JSON.stringify(run, null, 2) + '\n');
  if (opts.summary) writeFileSync(opts.summary, runMarkdown(run, opts.portalPage ?? undefined));
  if (opts.issue) writeFileSync(opts.issue, issueMarkdown(run, opts.portalPage ?? undefined));
  return exitCodeFor(run, opts.failOn);
}

const progressText = (p: Progress) => (p.total > 0 ? `${p.phase} ${p.done}/${p.total}` : p.phase);

// The names the spelling check should accept, from a portal's public catalog: game titles, studios and makers.
export async function catalogNames(portal: string, fetchFn: typeof fetch): Promise<string[]> {
  const res = await fetchFn(`${portal}/v1/catalog`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${portal}/v1/catalog answered HTTP ${res.status}`);
  const catalog = (await res.json()) as { games?: { title?: string; makers?: string[]; studio?: { name?: string } }[]; studios?: { name?: string }[] };
  const names: string[] = [];
  for (const g of catalog.games ?? []) names.push(g.title ?? '', g.studio?.name ?? '', ...(g.makers ?? []));
  for (const st of catalog.studios ?? []) names.push(st.name ?? '');
  return names.filter((n) => typeof n === 'string' && n);
}

// ---------- main ----------
export interface MainDeps {
  engine?: (options: RunOptions) => Promise<SiteCheckRun>;   // default: the real one, imported on demand
  fetch?: typeof fetch;                                       // for --catalog
  env?: Env;
  print?: (line: string) => void;                             // the report (stdout)
  log?: (line: string) => void;                               // progress and warnings (stderr)
}

export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  const log = deps.log ?? ((line: string) => console.error(line));
  const env = deps.env ?? process.env;
  const opts = parseCli(argv);
  if (typeof opts === 'string') {
    log(`check-site: ${opts}`);
    log(USAGE);
    return 2;
  }
  try {
    const words = [...opts.words];
    if (opts.catalog) {
      try {
        words.push(...await catalogNames(opts.catalog, deps.fetch ?? fetch));
      } catch (err) {
        const why = `couldn't read the catalog's names from ${opts.catalog} (${(err as Error).message}); the spelling check will flag game and studio names it doesn't know`;
        log(env.GITHUB_ACTIONS ? `::warning title=Site checks::${why.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}` : `check-site: warning: ${why}`);
      }
    }
    const engine = deps.engine ?? (await import('../src/site-checks/run.ts')).runSiteChecks;
    const checks = parseStart({ checks: opts.checks }) as { checks: CheckName[] };
    let seen = '';
    const run = await engine({
      site: opts.site, checks: checks.checks, limit: opts.limit, paths: opts.paths, allowWords: words.filter(Boolean),
      guard: opts.guard, source: opts.source, startedBy: 'cli',
      onProgress: (p) => { const t = progressText(p); if (t !== seen) { seen = t; log(t); } },
    });
    return finish(run, opts, print, env);
  } catch (err) {
    log(`check-site: ${(err as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
