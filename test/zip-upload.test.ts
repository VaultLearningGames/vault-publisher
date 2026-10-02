// The zip reading the Upload builds page does in the browser (public/setup.js): what it accepts, and what it refuses.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { extractZipEntry, planZipUpload, readZipDirectory, workflowSnippet, ZipError } from '../public/setup.js';

interface Entry { name: string; data?: Buffer | string; store?: boolean; symlink?: boolean; encrypted?: boolean; method?: number; claimSize?: number; claimCrc?: number }

// A minimal zip writer, so tests can make archives no ordinary tool would.
function zip(entries: Entry[]): Blob {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const method = e.method ?? (e.store ? 0 : 8);
    const packed = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(e.name);
    const size = e.claimSize ?? data.length, crc = e.claimCrc ?? crc32(data), flags = e.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE((3 << 8) | 20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(flags, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(size, 24); dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(dir, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([new Uint8Array(Buffer.concat([...parts, cd, end]))]);
}
const plan = async (entries: Entry[], limits?: { zipBytes: number; files: number; totalBytes: number }) => planZipUpload(await readZipDirectory(zip(entries)), limits);
const refuses = (entries: Entry[], message: RegExp, limits?: { zipBytes: number; files: number; totalBytes: number }) =>
  assert.rejects(plan(entries, limits), (err: Error) => err instanceof ZipError && message.test(err.message));

describe('reading a zip of a web build', () => {
  test('lists the files and unpacks them exactly', async () => {
    const blob = zip([{ name: 'index.html', data: '<h1>hi</h1>' }, { name: 'Build/game.wasm', data: Buffer.alloc(50_000, 7) }, { name: 'Build/', data: '' }, { name: 'a.txt', data: 'stored', store: true }]);
    const p = planZipUpload(await readZipDirectory(blob));
    assert.deepEqual(p.files.map((f) => [f.path, f.size]), [['index.html', 11], ['Build/game.wasm', 50_000], ['a.txt', 6]]);
    assert.equal(p.total, 50_017);
    assert.equal(await (await extractZipEntry(blob, p.files[0].entry)).text(), '<h1>hi</h1>');
    assert.deepEqual(Buffer.from(await (await extractZipEntry(blob, p.files[1].entry)).arrayBuffer()), Buffer.alloc(50_000, 7));
    assert.equal(await (await extractZipEntry(blob, p.files[2].entry)).text(), 'stored');
  });

  test('a single top-level folder is dropped; macOS and Windows clutter is ignored', async () => {
    const p = await plan([{ name: 'MyGame/', data: '' }, { name: 'MyGame/index.html', data: 'x' }, { name: 'MyGame/Build/a.js', data: 'y' },
      { name: '__MACOSX/MyGame/._index.html', data: 'junk' }, { name: 'MyGame/.DS_Store', data: 'junk' }, { name: 'MyGame/Thumbs.db', data: 'junk' }]);
    assert.equal(p.folder, 'MyGame/');
    assert.deepEqual(p.files.map((f) => f.path), ['index.html', 'Build/a.js']);
  });

  test('Windows-style backslashes are read as folders', async () => {
    assert.deepEqual((await plan([{ name: 'index.html', data: 'x' }, { name: 'Build\\a.js', data: 'y' }])).files.map((f) => f.path), ['index.html', 'Build/a.js']);
  });

  test('needs index.html at the top, or in one top-level folder', async () => {
    await refuses([{ name: 'a/index.html', data: 'x' }, { name: 'b/other.js', data: 'y' }], /no index\.html at the top/);
    await refuses([{ name: 'game.js', data: 'x' }], /no index\.html at the top/);
    await refuses([{ name: '__MACOSX/x', data: 'x' }], /empty/);
  });
});

describe('zips that are refused', () => {
  test('paths that leave the folder, absolute paths and drive letters', async () => {
    for (const name of ['../evil.js', 'Build/../../evil.js', '/etc/passwd', 'C:/Windows/evil.js', '..\\evil.js', 'a//b.js', './a.js', 'a/./b.js', 'bad\u0000name.js']) {
      await refuses([{ name: 'index.html', data: 'x' }, { name, data: 'x' }], /path that isn’t allowed/);
    }
  });

  test('links, passwords, unknown compression and duplicate names', async () => {
    await refuses([{ name: 'index.html', data: 'x' }, { name: 'link', data: '/etc/passwd', symlink: true }], /contains a link/);
    await refuses([{ name: 'index.html', data: 'x', encrypted: true }], /password-protected/);
    await refuses([{ name: 'index.html', data: 'x', method: 12 }], /compression method/);
    await refuses([{ name: 'index.html', data: 'x' }, { name: 'index.html', data: 'y' }], /twice/);
  });

  test('names Vault uses for releases', async () => {
    await refuses([{ name: 'index.html', data: 'x' }, { name: '_releases/v1/index.html', data: 'x' }], /a name Vault uses/);
    await refuses([{ name: 'g/index.html', data: 'x' }, { name: 'g/current.json', data: '{}' }], /a name Vault uses/);
  });

  test('too many files, or too big unpacked', async () => {
    const limits = { zipBytes: 1e9, files: 2, totalBytes: 100 };
    await refuses([{ name: 'index.html', data: 'x' }, { name: 'a', data: 'x' }, { name: 'b', data: 'x' }], /at most 2/, limits);
    await refuses([{ name: 'index.html', data: Buffer.alloc(101) }], /unpacked/, limits);
  });

  test('a file that unpacks bigger than the zip says (a zip bomb) stops unpacking', async () => {
    const blob = zip([{ name: 'index.html', data: Buffer.alloc(5_000_000), claimSize: 10 }]);
    const [entry] = await readZipDirectory(blob);
    await assert.rejects(extractZipEntry(blob, entry), /more than the zip says/);
  });

  test('a file whose contents don’t match the zip’s checksum', async () => {
    const blob = zip([{ name: 'index.html', data: 'hello', claimCrc: 123 }]);
    await assert.rejects(extractZipEntry(blob, (await readZipDirectory(blob))[0]), /damaged/);
  });

  test('things that aren’t zips', async () => {
    await assert.rejects(readZipDirectory(new Blob(['not a zip at all, just some text that is long enough'])), /isn’t a zip/);
    await assert.rejects(readZipDirectory(new Blob(['x'])), /isn’t a zip/);
  });
});

describe('the workflow the page offers', () => {
  const base = { game: 'tide-pool', portal: 'https://portal.test' };
  test('path 1 is one upload step, with no Unity or Field Day assumptions', () => {
    const y = workflowSnippet({ ...base, kind: 'build' });
    assert.match(y, /on: \{ push: \{\}, workflow_dispatch: \{\} \}/);
    assert.equal(y.match(/vault-publisher\/action@v1/g)!.length, 1);
    assert.match(y, /game: tide-pool\n\s+path: dist\n\s+publisher-url: https:\/\/portal\.test/);
    assert.doesNotMatch(y, /unity|UNITY|fieldday|request-release/);
    assert.match(workflowSnippet({ ...base, kind: 'unity' }), /unity-build\.yml@v1[\s\S]*UNITY_SERIAL[\s\S]*download-artifact/);
    assert.match(workflowSnippet({ ...base, kind: 'committed' }), /path: WebGL/);
  });
  test('path 2 adds the request step, for a branch, a GitHub release, or both', () => {
    const prod = workflowSnippet({ ...base, kind: 'build', production: true, branch: 'live' });
    assert.match(prod, /if: github\.ref == 'refs\/heads\/live'\n\s+with:\n\s+mode: request-release/);
    assert.doesNotMatch(prod, /release: \{ types/);
    const both = workflowSnippet({ ...base, kind: 'build', production: true, release: true });
    assert.match(both, /release: \{ types: \[published\] \}/);
    assert.match(both, /concurrency: \{ group: "vault-\$\{\{ github\.ref \}\}", cancel-in-progress: false \}/);
    assert.match(both, /if: github\.ref == 'refs\/heads\/production' \|\| github\.event_name == 'release'/);
  });
});
