// Runs one admin task against a portal (src/admin-tasks.ts): the Vault-admin operations on site listings, without a
// signed-in person. Used by .github/workflows/admin-task.yml, where the job's GitHub OIDC token authorizes it.
//
//   node scripts/admin-task.ts --portal https://portal.vaultlearninggames-staging.org --task move \
//     --args '{"slug":"shady-sam","studio":"ngpf"}' [--dry-run=false] [--summary FILE] [--token TOKEN]
//
// Tasks: list (args: { slugs? }), import ({ source, slugs?, pages?, overrides? }), migrate-images ({ base }),
// move ({ slug, studio }), update ({ updates: [{ slug, fields, cdn_game? }], publish }), featured, studios,
// release ({ studio, game, version, ref?, promote? }: approve a test build as a release and make it current).
// It is a dry run unless --dry-run=false: the portal answers with what would change and writes nothing.
// For import, --pages FILE and --overrides FILE send vault-rebuild's migration/games-export.json and
// import-overrides.json from disk instead of having the portal read them from the source site.
// The token is --token, else $ADMIN_TASK_TOKEN, else a GitHub Actions OIDC token for --audience (in a workflow with
// id-token: write). Against `node scripts/dev-portal.ts`: --portal http://localhost:4181 --token dev
// Prints the JSON result; --summary also appends it as Markdown (the job summary). Exits 1 if the task is refused.
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const TASKS: Record<string, { method: 'GET' | 'POST'; path: string }> = {
  list: { method: 'GET', path: '/v1/admin/listings' },
  import: { method: 'POST', path: '/v1/admin/listings/import' },
  'migrate-images': { method: 'POST', path: '/v1/admin/listings/migrate-images' },
  move: { method: 'POST', path: '/v1/admin/listings/move' },
  update: { method: 'POST', path: '/v1/admin/listings/update' },
  featured: { method: 'POST', path: '/v1/admin/featured' },
  studios: { method: 'POST', path: '/v1/admin/studios' },
  release: { method: 'POST', path: '/v1/admin/releases/publish' },
};
const MAX_ROUNDS = 20;             // migrate-images continues while images remain
const MAX_RELEASE_ROUNDS = 100;    // a release continues while files remain (about 75 s a round)
const MAX_SUMMARY_CHARS = 200_000; // a job summary holds 1 MiB

const { values: opt } = parseArgs({
  options: {
    portal: { type: 'string' }, task: { type: 'string' }, args: { type: 'string' }, 'dry-run': { type: 'string' },
    token: { type: 'string' }, audience: { type: 'string' }, summary: { type: 'string' }, pages: { type: 'string' }, overrides: { type: 'string' },
  },
});
const task = TASKS[opt.task ?? ''];
if (!opt.portal || !task) {
  console.error(`usage: node scripts/admin-task.ts --portal URL --task ${Object.keys(TASKS).join('|')} [--args JSON] [--dry-run=false]`);
  process.exit(2);
}
const portal = opt.portal.replace(/\/+$/, '');
const dry = opt['dry-run'] !== 'false';

async function token(): Promise<string> {
  const given = opt.token ?? process.env.ADMIN_TASK_TOKEN;
  if (given) return given;
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('no token: pass --token, or run in a workflow job with "id-token: write"');
  const res = await fetch(`${url}&audience=${encodeURIComponent(opt.audience ?? 'vault-publisher')}`, { headers: { Authorization: `bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub refused an OIDC token (HTTP ${res.status})`);
  return ((await res.json()) as { value: string }).value;
}

// One call; a fresh token each time (GitHub's last five minutes).
async function call(args: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await token()}` };
  let url = portal + task.path, body: string | undefined;
  if (task.method === 'GET') {
    const slugs = Array.isArray(args.slugs) ? args.slugs.map(String) : typeof args.slug === 'string' ? [args.slug] : [];
    if (slugs.length) url += `?slug=${slugs.map(encodeURIComponent).join(',')}`;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ ...args, dry_run: dry });
  }
  const res = await fetch(url, { method: task.method, headers, body });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 2000) }; }
  return { status: res.status, json };
}

function report(title: string, json: unknown) {
  const text = JSON.stringify(json, null, 2);
  console.log(text);
  if (!opt.summary) return;
  const shown = text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}\n… (cut; the whole result is in the job log)` : text;
  appendFileSync(opt.summary, `## ${title}\n\n\`\`\`json\n${shown}\n\`\`\`\n\n`);
}

async function main() {
  let args: unknown;
  try { args = JSON.parse(opt.args?.trim() || '{}'); } catch (err) { throw new Error(`--args isn't valid JSON: ${(err as Error).message}`); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('--args must be a JSON object');
  const a = args as Record<string, unknown>;
  if (opt.pages) a.pages = JSON.parse(readFileSync(opt.pages, 'utf8'));
  if (opt.overrides) a.overrides = JSON.parse(readFileSync(opt.overrides, 'utf8'));

  const mode = task.method === 'GET' ? '' : dry ? ' (dry run: nothing was changed)' : '';
  const title = `Admin task: ${opt.task} on ${portal}${mode}`;
  let lastProgress = '';
  for (let round = 1; ; round++) {
    const { status, json } = await call(a);
    if (status !== 200) {
      report(`${title} failed (HTTP ${status})`, json);
      process.exit(1);
    }
    // The image migration and a release stop starting copies before the request would time out; go on while they
    // make progress.
    const r = json as { remaining?: number; migrated?: unknown[]; done?: boolean; step?: string };
    const release = opt.task === 'release' && !dry && r.done === false;
    const more = release || (opt.task === 'migrate-images' && !dry && (r.remaining ?? 0) > 0);
    report(more || round > 1 ? `${title}, round ${round}` : title, json);
    if (!more) return;
    const progress = release ? `${r.step}:${r.remaining}` !== lastProgress : !!r.migrated?.length;
    lastProgress = `${r.step}:${r.remaining}`;
    if (!progress || round >= (release ? MAX_RELEASE_ROUNDS : MAX_ROUNDS)) {
      console.error(`admin-task: ${r.remaining} ${release ? 'file(s)' : 'image(s)'} still remain after ${round} round(s); run the task again`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`admin-task: ${(err as Error).message}`);
  process.exit(1);
});
