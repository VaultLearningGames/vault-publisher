// A portal app with in-memory storage and signed-in test users, for portal API tests.
import type { Readable } from 'node:stream';
import { createApp, type AppDeps } from '../src/app.ts';
import type { Verifier } from '../src/auth.ts';
import { Db } from '../src/db.ts';
import type { ObjectHeaders } from '../src/paths.ts';
import { signSession } from '../src/portal/session.ts';
import { browseKeys, type Storage } from '../src/storage.ts';

export class FakeStorage implements Storage {
  objects = new Map<string, number>();
  data = new Map<string, Uint8Array>();
  headers = new Map<string, ObjectHeaders>();
  puts = 0;
  async presignPut(key: string) { return `https://r2.test/${key}`; }
  async list(prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size })); }
  async browse(prefix: string) { return browseKeys(this.objects, prefix); }
  async copy(src: string, dst: string, headers: ObjectHeaders) { await this.put(dst, this.data.get(src)!, this.objects.get(src)!, headers); }
  async deleteKeys(keys: string[]) { for (const k of keys) this.objects.delete(k); }
  async get(key: string) { return this.data.get(key)!; }
  async put(key: string, body: Readable | Uint8Array, size: number, h: ObjectHeaders) {
    this.puts++;
    this.objects.set(key, size);
    this.headers.set(key, h);
    this.data.set(key, body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await (body as Readable).toArray())));
  }
}

const SECRET = 'test-session-secret';
const verifier: Verifier = { async github() { throw new Error('no'); }, async google() { throw new Error('no'); } };

export function portalHarness(extra: Partial<AppDeps> = {}) {
  const db = new Db(':memory:');
  db.syncStudios([{ slug: 'fieldday', name: 'Field Day Lab', github_owner: 'fielddaylab', github_owner_id: '1881825' },
    { slug: 'ucalgary', name: 'University of Calgary', github_owner: '', github_owner_id: 'vault:ucalgary' }]);
  const production = new FakeStorage();
  const deps = (more: Partial<AppDeps> = {}): AppDeps => ({
    db, staging: new FakeStorage(), production, verifier,
    stagingPublicUrl: 'https://stg.test', prodPublicUrl: 'https://prod.test',
    adminRepository: 'VaultLearningGames/vault-publisher', adminEnvironment: 'production',
    previewRetentionDays: 90, taskInvokerEmail: 'x@y',
    portal: { baseUrl: 'https://portal.test', sessionSecret: SECRET, vaultAdmins: ['boss'],
      oauth: { authorizeUrl: () => 'https://github.test/', exchange: async (code: string) => ({ github_id: `id-${code}`, login: code, name: null, avatar_url: null }) } },
    ...extra, ...more,
  });
  const h = { db, production, app: createApp(deps()), rebuild(more: Partial<AppDeps> = {}) { h.app = createApp(deps(more)); } };
  const as = (login: string, vaultRole: 'none' | 'release_manager' | 'admin' = 'none', studioRole?: 'viewer' | 'maintainer' | 'admin') => {
    const u = db.upsertUser({ github_id: `id-${login}`, login, name: null, avatar_url: null });
    db.setVaultRole(u.id, vaultRole);
    if (studioRole) db.setMembership(db.studioBySlug('fieldday')!.id, login, studioRole, 'test');
    const headers = { Cookie: `vault_session=${signSession(u.id, SECRET)}`, 'X-Requested-With': 'vault-portal' };
    return {
      get: (path: string) => h.app.request(path, { headers }),
      post: (path: string, body: unknown = {}) => h.app.request(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    };
  };
  return Object.assign(h, { as });
}
