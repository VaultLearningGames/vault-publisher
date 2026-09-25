// Local portal preview with example data, in-memory storage and a fake GitHub sign-in.
//   node scripts/dev-portal.ts        → http://localhost:4181  (sign in as any username; "boss" is a Vault admin)
import { serve } from '@hono/node-server';
import type { Readable } from 'node:stream';
import { createApp } from '../src/app.ts';
import { Db } from '../src/db.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { browseKeys, type Storage } from '../src/storage.ts';

class MemoryStorage implements Storage {
  objects = new Map<string, Uint8Array>();
  async presignPut(key: string) { return `memory://${key}`; }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.byteLength })); }
  async deleteKeys(keys: string[]) { for (const k of keys) this.objects.delete(k); }
  async browse(prefix: string) { return browseKeys([...this.objects].map(([k, v]) => [k, v.byteLength] as [string, number]), prefix); }
  async get(key: string) { return this.objects.get(key)!; }
  async put(key: string, body: Readable | Uint8Array, _size: number, _h: ObjectHeaders) {
    this.objects.set(key, body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await (body as Readable).toArray())));
  }
}

const PORT = Number(process.env.PORT ?? 4181);
const db = new Db(':memory:');
db.syncStudios([
  { slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
  { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' },
]);
const staging = new MemoryStorage(), production = new MemoryStorage();
const fd = db.studioBySlug('fieldday')!;

// Example games, staging builds and releases.
const seed: [string, string, [string, 'branch' | 'tag', string, number, number][]][] = [
  ['wake', 'fielddaylab/wake', [['production', 'branch', '4f7275b', 214, 145_000_000], ['develop', 'branch', '7d02b11', 214, 146_000_000], ['m3.2', 'tag', '5be8d3f', 212, 139_000_000]]],
  ['bloom', 'fielddaylab/bloom', [['production', 'branch', '44b91d0', 180, 92_000_000]]],
  ['spacefab', 'fielddaylab/spacefab', [['develop', 'branch', 'f008889', 402, 211_000_000]]],
  ['project-hercules', 'fielddaylab/project-hercules', []],
];
for (const [slug, repo, builds] of seed) {
  const g = db.createGame(fd.id, slug, repo, String(slug.length * 1000));
  for (const [ref, type, sha, files, bytes] of builds) {
    const id = `${slug}-${ref}`;
    db.createUpload({ id, game_id: g.id, ref_name: ref, ref_type: type, commit_sha: sha + '0'.repeat(33), actor: 'fielddaylab-ci', manifest: [], expires_at: '2999-01-01' });
    db.upsertBuild(db.upload(id)!, files, bytes);
    for (const f of ['index.html', 'Build/game.loader.js', 'Build/game.framework.js.br', 'Build/game.wasm.br', 'Build/game.data.br', 'TemplateData/style.css', 'TemplateData/favicon.ico'])
      staging.objects.set(`fieldday/${slug}/${ref}/${f}`, new TextEncoder().encode(f === 'index.html' ? `<h1>${slug} ${ref}</h1>` : 'x'.repeat(f.includes('data') ? 4096 : 512)));
  }
}
const wake = db.game(fd.id, 'wake')!;
db.createRelease({ game_id: wake.id, version: 'm3.1', source_ref: 'production', commit_sha: '9ac0e21' + '0'.repeat(33), file_count: 210, total_bytes: 141_000_000, approved_by: 'user:boss' });
db.setCurrentRelease(wake.id, db.release(wake.id, 'm3.1')!.id);
db.createReleaseRequest({ game_id: wake.id, ref: 'm3.2', version: 'm3.2', notes: 'New kelp job; fixes the iPad save bug.', requested_by: 'user:mia' });
db.setMembership(fd.id, 'mia', 'maintainer', 'user:boss');
db.setMembership(fd.id, 'vera', 'viewer', 'user:boss');
db.setMembership(fd.id, 'ada', 'admin', 'user:boss');

const app = createApp({
  db, staging, production,
  verifier: { async github() { throw new Error('no CI in dev'); }, async google() { throw new Error('no'); } },
  stagingPublicUrl: 'https://cdn.vaultlearninggames-staging.org', prodPublicUrl: 'https://cdn.vaultlearninggames.org',
  adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
  previewRetentionDays: 90, taskInvokerEmail: 'dev@example.org',
  portal: {
    baseUrl: `http://localhost:${PORT}`, sessionSecret: 'dev-only-secret', vaultAdmins: ['boss'],
    oauth: {
      // "Signing in" asks for a username instead of going to GitHub.
      authorizeUrl: (state) => `/dev-login?state=${state}`,
      exchange: async (code) => ({ github_id: `dev-${code}`, login: code, name: code[0].toUpperCase() + code.slice(1), avatar_url: null }),
    },
  },
});
app.get('/dev-login', (c) => c.html(`<form action="/auth/callback" style="font:16px system-ui;max-width:360px;margin:15vh auto;display:grid;gap:10px">
  <b>Dev sign-in</b><input type="hidden" name="state" value="${c.req.query('state')}">
  <input name="code" placeholder="GitHub username" autofocus required style="padding:8px">
  <small>boss = Vault admin · ada = studio admin · mia = maintainer · vera = viewer · anyone else = no access</small>
  <button style="padding:8px">Sign in</button></form>`));

serve({ fetch: app.fetch, port: PORT }, () => console.log(`portal preview on http://localhost:${PORT}`));
