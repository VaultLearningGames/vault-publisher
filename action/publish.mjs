// Runs inside a GitHub Actions job. No dependencies: uses the runner's Node, fetch and fs.
import { appendFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const env = process.env;
const game = env.INPUT_GAME;
const mode = env.INPUT_MODE || 'publish';
const publisher = (env.INPUT_PUBLISHER_URL || '').replace(/\/+$/, '');
const UPLOAD_CONCURRENCY = 8;

function die(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

async function oidcToken() {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL) die('No OIDC token available. Add `permissions: id-token: write` to the job.');
  const url = `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(env.INPUT_AUDIENCE || 'vault-publisher')}`;
  const res = await fetch(url, { headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!res.ok) die(`Could not get OIDC token: HTTP ${res.status}`);
  return (await res.json()).value;
}

async function api(token, path, body) {
  const res = await fetch(`${publisher}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(`${path} failed (HTTP ${res.status}): ${json.error ?? 'unknown error'} ${json.detail ? JSON.stringify(json.detail) : ''}`);
  return json;
}

async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath ?? e.path, e.name);
    files.push({ path: relative(root, full).split(sep).join('/'), size: (await stat(full)).size, full });
  }
  return files;
}

async function put(file, target) {
  const body = await readFile(file.full);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body }).catch((err) => err);
    if (res instanceof Response && res.ok) return;
    if (attempt === 3) die(`Upload of ${file.path} failed: ${res instanceof Response ? `HTTP ${res.status} ${await res.text()}` : res}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

function output(name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(markdown) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// Makes the result impossible to miss: a boxed line in the log, a notice annotation at the top of the
// run page, and a job summary section.
function announce(title, url, rows) {
  const line = '═'.repeat(Math.max(title.length, url.length) + 4);
  console.log(`\n╔${line}╗\n║  ${title.padEnd(line.length - 4)}  ║\n║  ${url.padEnd(line.length - 4)}  ║\n╚${line}╝\n`);
  console.log(`::notice title=${title}::${url}`);
  const table = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  summary(`## ${title}\n\n### ${url.startsWith('http') ? `[${url}](${url})` : url}\n\n| | |\n|---|---|\n${table}\n`);
}

const commit = (env.GITHUB_SHA || '').slice(0, 7);
const repoLink = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}` : '';

if (!game) die('input "game" is required');
if (!publisher) die('input "publisher-url" is required');
const token = await oidcToken();

if (mode === 'delete') {
  if (!env.INPUT_REF) die('input "ref" is required for mode "delete"');
  const { deleted } = await api(token, '/v1/previews/delete', { game, ref: env.INPUT_REF });
  announce('🗑️ Preview removed', `${game} / ${env.INPUT_REF}`, [
    ['Game', `\`${game}\``],
    ['Branch/tag', `\`${env.INPUT_REF}\``],
    ['Files removed', String(deleted)],
  ]);
} else if (mode === 'publish') {
  const root = env.INPUT_PATH || 'build/WebGL/WebGL';
  const files = await listFiles(root).catch((err) => die(`Cannot read build folder ${root}: ${err.message}`));
  if (!files.some((f) => f.path === 'index.html')) console.log(`::warning::No index.html at the top of ${root}`);
  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(`Publishing ${files.length} files (${(total / 1e6).toFixed(1)} MB) from ${root}`);

  const upload = await api(token, '/v1/previews', { game, files: files.map(({ path, size }) => ({ path, size })) });
  const targets = new Map(upload.files.map((t) => [t.path, t]));
  const queue = [...files];
  await Promise.all(
    Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await put(f, targets.get(f.path));
    }),
  );

  // The finalize call needs a fresh token only if the upload took longer than the token's lifetime (~5 min).
  const { url } = await api(await oidcToken(), `/v1/previews/${upload.upload_id}/finalize`);
  output('url', url);
  announce('🎮 Preview published', url, [
    ['Game', `\`${game}\``],
    ['Branch/tag', `\`${env.GITHUB_REF_NAME || '?'}\``],
    ['Commit', repoLink && commit ? `[\`${commit}\`](${repoLink}/commit/${env.GITHUB_SHA})` : commit || '?'],
    ['Files', `${files.length} (${(total / 1e6).toFixed(1)} MB)`],
  ]);
} else {
  die(`unknown mode "${mode}"`);
}
