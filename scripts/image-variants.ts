// Makes the smaller WebP copies of the listing images on a system's Vault CDN (src/image-variants.ts): asks the
// portal which images have none yet, downloads each from the CDN, resizes it (sharp) and sends the copies to the
// portal, which stores them next to the original and lists them in /v1/catalog for the site build.
//
//   node scripts/image-variants.ts --portal https://portal.vaultlearninggames-staging.org [--dry-run=false]
//     [--redo] [--budget-seconds N] [--summary FILE] [--token TOKEN] [--soft]
//
// Run by the admin task `image-variants` (.github/workflows/admin-task.yml) and before every site build
// (deploy.yml, with --soft), so a new upload gets its copies by the next build. A dry run (the default) makes the
// copies and reports their sizes, and the portal checks them, but nothing is stored. --redo makes copies for images
// that have them already (the objects are written again, with the same names). Needs the dev dependencies (sharp).
// The token is --token, else $ADMIN_TASK_TOKEN, else a GitHub Actions OIDC token (a job with id-token: write in the
// system's environment). --soft: a portal that can't answer (an older portal without the endpoint, or no token) is a
// warning, not a failure, so a site build carries on with the copies that exist.
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { variantWidths } from '../src/image-variants.ts';

const CONCURRENCY = 3;
const QUALITY = 80;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;

const { values: opt } = parseArgs({
  options: {
    portal: { type: 'string' }, 'dry-run': { type: 'string' }, redo: { type: 'boolean' }, 'budget-seconds': { type: 'string' },
    summary: { type: 'string' }, token: { type: 'string' }, audience: { type: 'string' }, soft: { type: 'boolean' },
  },
});
if (!opt.portal) {
  console.error('usage: node scripts/image-variants.ts --portal URL [--dry-run=false] [--redo] [--budget-seconds N] [--summary FILE] [--soft]');
  process.exit(2);
}
const portal = opt.portal.replace(/\/+$/, '');
const dry = opt['dry-run'] !== 'false';
const deadline = opt['budget-seconds'] ? Date.now() + Number(opt['budget-seconds']) * 1000 : Infinity;

function soft(message: string): never {
  if (!opt.soft) { console.error(message); process.exit(1); }
  console.log(`::warning::image variants: ${message}`);
  process.exit(0);
}

async function token(): Promise<string> {
  const given = opt.token ?? process.env.ADMIN_TASK_TOKEN;
  if (given) return given;
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('no token: pass --token, or run in a workflow job with "id-token: write"');
  const res = await fetch(`${url}&audience=${encodeURIComponent(opt.audience ?? 'vault-publisher')}`, { headers: { Authorization: `bearer ${bearer}` } });
  if (!res.ok) throw new Error(`GitHub refused an OIDC token (HTTP ${res.status})`);
  return ((await res.json()) as { value: string }).value;
}

async function call(method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${portal}/v1/admin/image-variants`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${await token()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: { error: text.slice(0, 500) } }; }
}

let list: { status: number; json: any };
try { list = await call('GET'); } catch (err) { soft(`couldn’t ask ${portal}: ${(err as Error).message}`); }
if (list.status !== 200) soft(`${portal} answered HTTP ${list.status}: ${list.json?.error ?? ''}`);
const images = (list.json.images as { url: string; done: boolean }[]).filter((i) => opt.redo || !i.done);
console.log(`image variants: ${list.json.count} listing images on the CDN, ${list.json.missing} without copies; making ${images.length}${dry ? ' (dry run)' : ''}`);

const { default: sharp } = await import('sharp');
type Done = { url: string; width: number; height: number; original: number; copies: { width: number; bytes: number }[] };
const done: Done[] = [], failed: { url: string; why: string }[] = [];
let left = 0;
const queue = [...images];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let img = queue.shift(); img; img = queue.shift()) {
    if (Date.now() > deadline) { left++; continue; }
    try {
      const res = await fetch(img.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from the CDN`);
      const original = Buffer.from(await res.arrayBuffer());
      if (original.length > MAX_DOWNLOAD_BYTES) throw new Error('over 30 MB');
      // The size as shown: EXIF orientation applied (a portrait photo stored sideways).
      const meta = await sharp(original).metadata();
      const turned = (meta.orientation ?? 1) >= 5;
      const width = turned ? meta.height! : meta.width!, height = turned ? meta.width! : meta.height!;
      const widths = variantWidths(width);
      const copies = await Promise.all(widths.map(async (w) => ({
        width: w,
        bytes: await sharp(original).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: QUALITY, effort: 5 }).toBuffer(),
      })));
      const r = await call('POST', { url: img.url, width, height, variants: copies.map((c) => ({ width: c.width, webp: c.bytes.toString('base64') })), dry_run: dry });
      if (r.status !== 200) throw new Error(`the portal refused them (HTTP ${r.status}): ${r.json?.error ?? ''}`);
      done.push({ url: img.url, width, height, original: original.length, copies: copies.map((c) => ({ width: c.width, bytes: c.bytes.length })) });
      console.log(`  ${dry ? 'would store' : 'stored'} ${img.url} (${width}x${height}, ${kb(original.length)}): ${copies.map((c) => `${c.width}w ${kb(c.bytes.length)}`).join(', ')}`);
    } catch (err) {
      failed.push({ url: img.url, why: (err as Error).message });
      console.log(`  FAILED ${img.url}: ${(err as Error).message}`);
    }
  }
}));

function kb(n: number) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`; }
const line = `image variants: ${done.length} images ${dry ? 'checked (dry run, nothing stored)' : 'given copies'}, ${failed.length} failed${left ? `, ${left} left for the next run (time budget)` : ''}`;
console.log(line);
if (opt.summary) {
  const rows = done.map((d) => `| ${d.url.split('/').slice(-3).join('/')} | ${d.width}×${d.height} | ${kb(d.original)} | ${d.copies.map((c) => `${c.width}w ${kb(c.bytes)}`).join(', ')} |`);
  appendFileSync(opt.summary, `## Image variants\n\n${line}\n\n${rows.length ? `| Image | Size | Original | Copies |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n` : ''}${failed.map((f) => `* FAILED ${f.url}: ${f.why}`).join('\n')}\n`);
}
if (failed.length && !opt.soft) process.exit(1);
if (failed.length) console.log(`::warning::image variants: ${failed.length} images failed; they are shown full size until a run succeeds`);
