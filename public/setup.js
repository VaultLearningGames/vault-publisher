// The "Upload builds" page: the workflow snippets, and uploading a .zip of a web build as a test build.
//
// A zip is never sent to Vault as a zip. The browser reads its list of files, checks every path, unpacks one file at
// a time and sends each to storage with the upload address the portal hands out for exactly that path and size; the
// portal checks the paths and sizes again and, once everything has arrived, records the test build. Nothing is ever
// unpacked on a server, so a hostile zip has nothing to escape from.
//
// This file is an ES module so the zip reading can be tested with node:test (test/zip-upload.test.ts).

const MB = 1024 * 1024;
export const ZIP_LIMITS = { zipBytes: 1024 * MB, files: 5000, totalBytes: 2048 * MB };

export class ZipError extends Error {}

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const view = async (blob) => new DataView(await blob.arrayBuffer());

// The zip's list of files (its central directory), read from the end of the file.
export async function readZipDirectory(blob) {
  if (blob.size < 22) throw new ZipError('That isn’t a zip file.');
  const tailStart = Math.max(0, blob.size - 65557);
  const tail = await view(blob.slice(tailStart));
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50 && i + 22 + u16(tail, i + 20) === tail.byteLength) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('That isn’t a zip file (or it is damaged).');
  const count = u16(tail, eocd + 10), dirSize = u32(tail, eocd + 12), dirOffset = u32(tail, eocd + 16);
  if (u16(tail, eocd + 4) !== 0 || u16(tail, eocd + 6) !== 0 || u16(tail, eocd + 8) !== count) throw new ZipError('Zip files split into several parts can’t be uploaded.');
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new ZipError('That zip is too big (Zip64). Zip the web build on its own, without source files.');
  if (dirOffset + dirSize > tailStart + eocd) throw new ZipError('That zip file is damaged.');
  const dir = await view(blob.slice(dirOffset, dirOffset + dirSize));
  const utf8 = new TextDecoder('utf-8');
  const entries = [];
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (o + 46 > dir.byteLength || u32(dir, o) !== 0x02014b50) throw new ZipError('That zip file is damaged.');
    const nameLen = u16(dir, o + 28), extraLen = u16(dir, o + 30), commentLen = u16(dir, o + 32);
    if (o + 46 + nameLen > dir.byteLength) throw new ZipError('That zip file is damaged.');
    entries.push({
      name: utf8.decode(new Uint8Array(dir.buffer, dir.byteOffset + o + 46, nameLen)),
      madeBy: u16(dir, o + 4), flags: u16(dir, o + 8), method: u16(dir, o + 10), crc: u32(dir, o + 16),
      compressedSize: u32(dir, o + 20), size: u32(dir, o + 24), attrs: u32(dir, o + 38), offset: u32(dir, o + 42),
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/;
// Names at the top of a game's folder that belong to Vault (releases.ts).
const RESERVED = /^(_releases\/|_vault-assets\/|current\.json$)/;

function safePath(name) {
  if (name.length === 0 || name.length > 512) return false;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// Decides what a zip would upload: every file's path inside the test build and its unpacked size. Refuses the whole
// zip (with a message for the person uploading) rather than skipping anything suspicious: paths that leave the
// folder, absolute paths, links, password-protected files. Folders, and the clutter macOS and Windows add, are ignored.
// A zip whose files all sit in one top-level folder (how most tools zip a folder) is uploaded without that folder.
export function planZipUpload(entries, limits = ZIP_LIMITS) {
  const files = [];
  const seen = new Set();
  for (const e of entries) {
    const name = e.name.replace(/\\/g, '/');
    if ((e.madeBy >> 8) === 3 && ((e.attrs >>> 16) & 0o170000) === 0o120000) throw new ZipError(`The zip contains a link (${name}). Zip the real files instead.`);
    if (name.endsWith('/') || JUNK.test(name)) continue;
    if (!safePath(name)) throw new ZipError(`The zip contains a file path that isn’t allowed: “${name.slice(0, 80)}”.`);
    if (e.flags & 1) throw new ZipError('The zip is password-protected. Zip it again without a password.');
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`The zip uses a compression method that can’t be read here (${name}). Zip it again with your computer’s built-in zip tool.`);
    if (e.size === 0xffffffff || e.compressedSize === 0xffffffff) throw new ZipError('A file in the zip is too big (Zip64).');
    if (seen.has(name)) throw new ZipError(`The zip contains “${name}” twice.`);
    seen.add(name);
    files.push({ path: name, size: e.size, entry: e });
  }
  if (!files.length) throw new ZipError('The zip is empty.');
  let folder = '';
  if (!seen.has('index.html')) {
    const top = files[0].path.includes('/') ? files[0].path.slice(0, files[0].path.indexOf('/') + 1) : '';
    if (top && files.every((f) => f.path.startsWith(top)) && seen.has(`${top}index.html`)) folder = top;
    else throw new ZipError('There’s no index.html at the top of the zip. Zip the folder that has index.html in it.');
  }
  for (const f of files) {
    f.path = f.path.slice(folder.length);
    if (RESERVED.test(f.path)) throw new ZipError(`The zip contains “${f.path}”, a name Vault uses itself. Rename or remove it.`);
  }
  if (files.length > limits.files) throw new ZipError(`The zip has ${files.length} files; a build can have at most ${limits.files}.`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > limits.totalBytes) throw new ZipError(`The build is ${Math.round(total / MB)} MB unpacked; the most that can be uploaded here is ${limits.totalBytes / MB} MB.`);
  return { files, folder, total };
}

let crcTable;
function crc32(crc, bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

// Unpacks one file. It must come out exactly as big as the zip's list says (unpacking stops the moment it's bigger,
// so a "zip bomb" can't fill memory) and match the zip's checksum.
export async function extractZipEntry(blob, entry) {
  const head = await view(blob.slice(entry.offset, entry.offset + 30));
  if (head.byteLength < 30 || u32(head, 0) !== 0x04034b50) throw new ZipError('That zip file is damaged.');
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const packed = blob.slice(start, start + entry.compressedSize);
  if (packed.size !== entry.compressedSize) throw new ZipError('That zip file is damaged.');
  let crc = 0xffffffff, bytes = 0;
  const check = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > entry.size) throw new ZipError(`“${entry.name}” unpacks to more than the zip says it should.`);
      crc = crc32(crc, chunk);
      controller.enqueue(chunk);
    },
  });
  const source = entry.method === 8 ? packed.stream().pipeThrough(new DecompressionStream('deflate-raw')) : packed.stream();
  let out;
  try {
    out = await new Response(source.pipeThrough(check)).blob();
  } catch (err) {
    throw err instanceof ZipError ? err : new ZipError(`“${entry.name}” couldn’t be unpacked; the zip may be damaged.`);
  }
  if (bytes !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new ZipError(`“${entry.name}” is damaged in the zip.`);
  return out;
}

// ---------- workflow snippets ----------
// kind: 'build' (the repository's own build step), 'committed' (the web build is in the repository) or 'unity'
// (Vault's shared Unity build). production / release add the step that asks Vault to publish.
export function workflowSnippet({ kind, game, portal, production = false, branch = 'production', release = false }) {
  const on = release ? 'on:\n  push: {}\n  release: { types: [published] }\n  workflow_dispatch: {}' : 'on: { push: {}, workflow_dispatch: {} }';
  const path = kind === 'committed' ? 'WebGL' : kind === 'unity' ? 'build' : 'dist';
  const lines = ['# .github/workflows/vault.yml', 'name: Vault', on, 'permissions: { contents: read, id-token: write }'];
  // A published release and its tag both start a run; this makes them take turns instead of colliding.
  if (release) lines.push('concurrency: { group: "vault-${{ github.ref }}", cancel-in-progress: false }');
  lines.push('jobs:');
  if (kind === 'unity') {
    lines.push('  build:',
      '    uses: VaultLearningGames/vault-publisher/.github/workflows/unity-build.yml@v1',
      '    secrets:   # passed one by one: "inherit" does not cross organizations',
      '      UNITY_EMAIL: ${{ secrets.UNITY_EMAIL }}',
      '      UNITY_PASSWORD: ${{ secrets.UNITY_PASSWORD }}',
      '      UNITY_SERIAL: ${{ secrets.UNITY_SERIAL }}');
  }
  lines.push('  vault:');
  if (kind === 'unity') lines.push('    needs: build');
  lines.push('    runs-on: ubuntu-latest', '    steps:');
  if (kind === 'unity') {
    lines.push('      - uses: actions/download-artifact@v8', '        with: { name: "${{ needs.build.outputs.artifact }}", path: build }');
  } else {
    lines.push('      - uses: actions/checkout@v7');
    if (kind === 'build') lines.push('', '      # Your own build goes here. It must leave the web build',
      '      # in ./dist, with index.html at the top.', '      # - run: npm ci && npm run build');
  }
  lines.push('',
    '      # Uploads this push to Vault as a test build',
    '      - uses: VaultLearningGames/vault-publisher/action@v1',
    '        with:',
    `          game: ${game}`,
    `          path: ${path}${kind === 'committed' ? '              # the folder that has index.html' : ''}`,
    `          publisher-url: ${portal}`);
  if (production || release) {
    const when = [production ? `github.ref == 'refs/heads/${branch}'` : '', release ? "github.event_name == 'release'" : ''].filter(Boolean).join(' || ');
    lines.push('',
      '      # Asks Vault to publish the build that was just uploaded',
      '      - uses: VaultLearningGames/vault-publisher/action@v1',
      `        if: ${when}`,
      '        with:',
      '          mode: request-release',
      `          game: ${game}`,
      `          publisher-url: ${portal}`);
  }
  return lines.join('\n') + '\n';
}

// ---------- the page ----------
if (typeof document !== 'undefined' && document.getElementById('setup-data')) {
  const cfg = JSON.parse(document.getElementById('setup-data').textContent);
  const $ = (sel, root = document) => root.querySelector(sel);
  const gameInput = $('#setup-game');
  const slug = () => (gameInput.value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-game';

  function draw() {
    const game = slug();
    document.querySelectorAll('[data-game]').forEach((el) => { el.textContent = game; });
    document.querySelectorAll('input[data-game-field]').forEach((el) => { el.value = game; });
    const kind = ($('input[name=setup-kind]:checked') || {}).value || 'build';
    document.querySelectorAll('[data-kind]').forEach((el) => { el.hidden = el.dataset.kind !== kind; });
    const production = $('#auto-production').checked, release = $('#auto-release').checked;
    const branch = ($('#auto-branch').value || 'production').trim().replace(/[^A-Za-z0-9._/-]/g, '') || 'production';
    $('#snippet-1').textContent = workflowSnippet({ kind, game, portal: cfg.portal });
    $('#snippet-2').textContent = production || release
      ? workflowSnippet({ kind, game, portal: cfg.portal, production, branch, release })
      : '# Tick at least one box above.';
    document.querySelectorAll('[data-branch]').forEach((el) => { el.textContent = branch; });
    $('#auto-production-next').hidden = !production;
    $('#auto-release-next').hidden = !release;
  }
  document.addEventListener('input', (e) => { if (e.target.closest('[data-redraw]')) draw(); });
  document.addEventListener('change', (e) => { if (e.target.closest('[data-redraw]')) draw(); });
  draw();

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const src = $(btn.dataset.copy);
    const done = (label) => { btn.textContent = label; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); };
    navigator.clipboard.writeText(src.textContent).then(() => done('Copied'), () => {
      const r = document.createRange(); r.selectNodeContents(src);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      done('Press ⌘C');
    });
  });

  // The file list field only matters when a file list is chosen.
  const listField = $('#monitor-list');
  if (listField) {
    const sync = () => { const on = $('input[name=files_from]:checked').value === 'list'; listField.hidden = !on; $('input', listField).disabled = !on; };
    document.querySelectorAll('input[name=files_from]').forEach((r) => r.addEventListener('change', sync));
    sync();
  }

  // ----- zip upload -----
  const form = $('#zip-form');
  if (form) {
    const input = $('input[type=file]', form), status = $('.err', form), btn = $('button', form), bar = $('progress', form);
    let working = false;
    window.addEventListener('beforeunload', (e) => { if (working) e.preventDefault(); });
    const say = (msg, ok) => { status.classList.toggle('status', !!ok); status.textContent = msg; };
    const api = async (path, body) => {
      const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault-portal' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new ZipError(json.error || `Something went wrong (HTTP ${res.status}).`);
      return json;
    };
    async function put(target, body) {
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(target.url, { method: 'PUT', headers: target.headers, body }).catch((err) => err);
        if (res instanceof Response && res.ok) return;
        if (attempt === 3) {
          throw new ZipError(res instanceof Response
            ? `Vault’s storage refused ${target.path} (HTTP ${res.status}). Try again; if it keeps happening, tell Vault.`
            : `${target.path} couldn’t be sent to Vault’s storage. Check your connection and try again; if it keeps happening, tell Vault.`);
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const zip = input.files[0];
      if (!zip || working) return;
      const game = slug();
      working = true; btn.disabled = true; input.disabled = true; bar.hidden = false; bar.value = 0;
      try {
        if (zip.size > ZIP_LIMITS.zipBytes) throw new ZipError(`The zip is ${Math.round(zip.size / MB)} MB; the most that can be uploaded here is ${ZIP_LIMITS.zipBytes / MB} MB.`);
        say('Reading the zip…', true);
        const plan = planZipUpload(await readZipDirectory(zip));
        const upload = await api(form.dataset.start, { game, files: plan.files.map(({ path, size }) => ({ path, size })) });
        const targets = new Map(upload.files.map((t) => [t.path, t]));
        const queue = [...plan.files];
        let sent = 0, sentBytes = 0;
        const progress = () => {
          bar.value = plan.total ? sentBytes / plan.total : sent / plan.files.length;
          say(`Uploading: ${sent} of ${plan.files.length} files (${Math.round(sentBytes / MB)} of ${Math.round(plan.total / MB)} MB). Keep this page open.`, true);
        };
        progress();
        await Promise.all(Array.from({ length: 4 }, async () => {
          for (let f = queue.shift(); f; f = queue.shift()) {
            await put(targets.get(f.path), await extractZipEntry(zip, f.entry));
            sent++; sentBytes += f.size; progress();
          }
        }));
        say('Finishing…', true);
        const done = await api(`${form.dataset.start}/${upload.upload_id}/finalize`, {});
        working = false;
        say(`Uploaded as test build ${upload.ref}. Opening the game’s page…`, true);
        location.href = done.page;
      } catch (err) {
        working = false; btn.disabled = false; input.disabled = false; bar.hidden = true;
        say(err instanceof ZipError ? err.message : `Something went wrong: ${err.message}`);
      }
    });
  }
}
