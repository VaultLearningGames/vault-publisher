// URL monitors: a studio that already hosts a web build somewhere registers its public address, and Vault copies it
// into a test build (STUDIO/GAME/web-copy/ in the builds bucket) whenever it changes. See docs/url-monitor.md.
//
// Which files make up the game comes from one of:
//   'list'  a file list the studio publishes (text, one relative path per line; or JSON), or
//   'crawl' the files index.html links to, and the files those HTML and CSS files link to. Files a game only loads
//           from its code can't be found this way, which is why the file list exists.
// A check asks for every file with the ETag / Last-Modified it had last time, so unchanged files answer 304 and
// aren't downloaded; files that do download are compared by SHA-256. Changed files are first written next to the
// test build (STUDIO/GAME/~incoming-web-copy/) and only copied over it once every file has arrived, so a failed
// check never leaves a half-updated test build.
import { createHash } from 'node:crypto';
import { pipeline, Transform, type Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { Db, Game, Studio, Upload } from './db.ts';
import { BlockedUrlError, checkUrl, type Fetcher } from './net-guard.ts';
import { headersFor, isSafeFilePath } from './paths.ts';
import type { Storage } from './storage.ts';

const MB = 1024 * 1024;
export const MONITOR_REF = 'web-copy';
export const MONITOR_ACTOR = 'url-monitor';
export const MONITOR_LIMITS = {
  files: 2000,
  totalBytes: 1024 * MB,
  listBytes: 1 * MB,       // the file list itself
  pageBytes: 5 * MB,       // an HTML or CSS file read for links
  pages: 200,              // HTML and CSS files read for links in one check
  bufferedBytes: 32 * MB,  // a file whose size the server doesn't announce is held in memory, up to this
};
const USER_AGENT = 'VaultLearningGames-url-monitor/1 (+https://vaultlearninggames.org)';
const CONCURRENCY = 3;

export type FilesFrom = 'list' | 'crawl';
export interface FileState { size: number; sha256: string; etag?: string; modified?: string }
export interface UrlMonitor {
  id: number;
  game_id: number;
  url: string;                 // the game's folder, ending in "/"
  files_from: FilesFrom;
  list_url: string | null;
  ref_name: string;
  files: Record<string, FileState>;   // what the test build holds, as of the last successful check
  last_checked_at: string | null;
  last_changed_at: string | null;
  last_status: 'changed' | 'unchanged' | 'error' | null;
  last_message: string | null;
  created_by: string;
  created_at: string;
}
export type UrlMonitorRow = UrlMonitor & { game_slug: string; studio_slug: string };

// ---------- storage (table url_monitors, db.ts v15) ----------
const SELECT = `SELECT m.*, g.slug AS game_slug, s.slug AS studio_slug FROM url_monitors m
  JOIN games g ON g.id = m.game_id JOIN studios s ON s.id = g.studio_id`;
function row(r: unknown): UrlMonitorRow | undefined {
  if (!r) return undefined;
  const { state_json, ...rest } = r as Record<string, unknown> & { state_json: string };
  return { ...(rest as unknown as UrlMonitorRow), files: (JSON.parse(state_json) as { files?: Record<string, FileState> }).files ?? {} };
}
export const monitorById = (db: Db, id: number) => row(db.sqlite.prepare(`${SELECT} WHERE m.id = ?`).get(id));
export const monitorForGame = (db: Db, gameId: number) => row(db.sqlite.prepare(`${SELECT} WHERE m.game_id = ?`).get(gameId));
export const monitorsForStudio = (db: Db, studioId: number) =>
  db.sqlite.prepare(`${SELECT} WHERE g.studio_id = ? ORDER BY g.slug`).all(studioId).map((r) => row(r)!);
// Every monitor, the one checked longest ago first (never-checked ones before all).
export const allMonitors = (db: Db) =>
  db.sqlite.prepare(`${SELECT} ORDER BY m.last_checked_at IS NOT NULL, m.last_checked_at, m.id`).all().map((r) => row(r)!);
// "studio/game/ref" of every monitored test build; the nightly cleanup leaves these alone.
export const monitoredBuilds = (db: Db) => new Set(allMonitors(db).map((m) => `${m.studio_slug}/${m.game_slug}/${m.ref_name}`));

// One monitor per game. Changing what is monitored forgets what was copied, so the next check compares from scratch.
export function saveMonitor(db: Db, m: { game_id: number; url: string; files_from: FilesFrom; list_url: string | null; by: string }): UrlMonitorRow {
  const now = new Date().toISOString();
  const old = monitorForGame(db, m.game_id);
  if (old) {
    const same = old.url === m.url && old.files_from === m.files_from && old.list_url === m.list_url;
    db.sqlite.prepare(`UPDATE url_monitors SET url = ?, files_from = ?, list_url = ?${same ? '' : ", state_json = '{}'"} WHERE id = ?`)
      .run(m.url, m.files_from, m.list_url, old.id);
  } else {
    db.sqlite.prepare(`INSERT INTO url_monitors (game_id, url, files_from, list_url, ref_name, state_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`)
      .run(m.game_id, m.url, m.files_from, m.list_url, MONITOR_REF, m.by, now);
  }
  return monitorForGame(db, m.game_id)!;
}
export const deleteMonitor = (db: Db, id: number) => { db.sqlite.prepare('DELETE FROM url_monitors WHERE id = ?').run(id); };

// ---------- addresses ----------
// The folder a hosted game lives in, from what someone typed: "https://host/game/", "https://host/game" or
// "https://host/game/index.html". Throws a message for the person typing it.
export function gameFolderUrl(raw: unknown): URL {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new Error('Enter the web address where the game is hosted.');
  if (text.length > 500) throw new Error('That address is too long.');
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('That isn’t a full web address. It should start with https://'); }
  checkUrl(url);
  url.hash = ''; url.search = '';
  const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  if (/^index\.html?$/i.test(last)) url.pathname = url.pathname.slice(0, -last.length);
  else if (last.includes('.')) throw new Error('Enter the address of the game’s folder (the one that has index.html), not of a single file.');
  else if (last) url.pathname += '/';
  return url;
}

// The address of the file list, which must be on the same site as the game.
export function fileListUrl(raw: unknown, base: URL): URL {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new Error('Enter the address of the file list, or let Vault find the files from index.html.');
  let url: URL;
  try { url = new URL(text, base); } catch { throw new Error('The file list address isn’t a web address.'); }
  checkUrl(url);
  if (url.origin !== base.origin) throw new Error(`The file list must be on the same site as the game (${base.origin}).`);
  url.hash = '';
  return url;
}

// A link or list entry as a path inside the game's folder ("Build/game.wasm"), or null when it points anywhere else:
// another site, a folder above the game, or something that isn't a plain relative file path.
export function pathInside(base: URL, ref: string, from: URL = base): string | null {
  let u: URL;
  try { u = new URL(ref.trim(), from); } catch { return null; }
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return null;
  let rel: string;
  try { rel = decodeURIComponent(u.pathname.slice(base.pathname.length)); } catch { return null; }
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  return isSafeFilePath(rel) ? rel : null;
}
// Where a file is fetched from. The game's own index.html is fetched as the folder address the studio gave, which is
// what players load (some sites answer only there, not at …/index.html).
const fileUrl = (base: URL, path: string) => (path === 'index.html' ? new URL(base) : new URL(path.split('/').map(encodeURIComponent).join('/'), base));

// A problem with the studio's site or file list: reported to the studio as it is, not logged as a fault here.
export class CopyError extends Error {}

// ---------- finding the files ----------
// A file list: plain text with one path per line (blank lines and lines starting with # are skipped), or JSON: an
// array of paths, an array of { "path": … } objects, or { "files": [either] }.
export function parseFileList(text: string): string[] {
  const t = text.replace(/^﻿/, '').trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    let json: unknown;
    try { json = JSON.parse(t); } catch { throw new CopyError('The file list looks like JSON but can’t be read.'); }
    const items = Array.isArray(json) ? json : (json as { files?: unknown }).files;
    if (!Array.isArray(items)) throw new CopyError('The JSON file list must be an array of paths, or { "files": [paths] }.');
    return items.map((it) => {
      const v = typeof it === 'string' ? it : (it as { path?: unknown; url?: unknown; name?: unknown } | null)?.path ?? (it as { url?: unknown } | null)?.url ?? (it as { name?: unknown } | null)?.name;
      if (typeof v !== 'string' || !v.trim()) throw new CopyError('Every entry in the JSON file list must be a path (or an object with a "path").');
      return v.trim();
    });
  }
  if (/^<(!doctype|html|head|body)\b/i.test(t)) throw new CopyError('The file list address returned a web page, not a list of files.');
  return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

const ATTR = /\b(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SRCSET = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>|\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const unescapeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const pick = (m: RegExpMatchArray) => m.slice(1).find((g) => g !== undefined) ?? '';

export function cssRefs(css: string): string[] {
  return [...css.matchAll(CSS_URL)].map(pick).filter(Boolean);
}
// Everything an HTML page points at: scripts, styles, images, media, links to other pages, and url(...)s in its styles.
export function htmlRefs(page: string): string[] {
  const text = page.replace(/<!--[\s\S]*?-->/g, '');
  const out = [...text.matchAll(ATTR)].map(pick);
  for (const m of text.matchAll(SRCSET)) out.push(...pick(m).split(',').map((c) => c.trim().split(/\s+/)[0]));
  for (const m of text.matchAll(STYLE)) out.push(...cssRefs(pick(m)));
  return out.map(unescapeHtml).filter(Boolean);
}

async function readCapped(body: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += (chunk as Buffer).length;
    if (total > max) { body.destroy(); return null; }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
// Undoes a Content-Encoding the server applied although the request asked for none.
function decoded(bytes: Buffer, encoding: string | undefined): Buffer {
  const e = (encoding ?? '').trim().toLowerCase();
  if (e === 'gzip' || e === 'x-gzip') return gunzipSync(bytes);
  if (e === 'br') return brotliDecompressSync(bytes);
  if (e === 'deflate') return inflateSync(bytes);
  return bytes;
}

interface Ctx { fetcher: Fetcher; signal?: AbortSignal }
const request = (ctx: Ctx, url: URL, origin: string, headers: Record<string, string> = {}) =>
  ctx.fetcher(url.href, { origin, signal: ctx.signal, headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', ...headers } });

// The game's files as paths inside its folder (always including index.html), and notes for the studio.
export async function findFiles(ctx: Ctx, m: Pick<UrlMonitor, 'url' | 'files_from' | 'list_url'>): Promise<{ paths: string[]; notes: string[] }> {
  const base = new URL(m.url);
  const files = new Set<string>(['index.html']);
  const notes: string[] = [];
  const add = (rel: string) => {
    files.add(rel);
    if (files.size > MONITOR_LIMITS.files) throw new CopyError(`the game has more than ${MONITOR_LIMITS.files} files, which is more than a monitored game can have`);
  };
  if (m.files_from === 'list') {
    const res = await request(ctx, new URL(m.list_url!), base.origin);
    if (res.status !== 200) { res.body.destroy(); throw new CopyError(`the file list (${m.list_url}) answered ${res.status}`); }
    const bytes = await readCapped(res.body, MONITOR_LIMITS.listBytes);
    if (!bytes) throw new CopyError(`the file list is bigger than ${MONITOR_LIMITS.listBytes / MB} MB`);
    for (const entry of parseFileList(decoded(bytes, res.headers['content-encoding']).toString('utf8'))) {
      const rel = pathInside(base, entry);
      if (!rel) throw new CopyError(`the file list has “${entry.slice(0, 120)}”, which isn’t a file inside ${base.href}`);
      add(rel);
    }
    return { paths: [...files].sort(), notes };
  }
  // Crawl: read index.html, then every HTML and CSS file it leads to, collecting what they point at.
  const queue = ['index.html'];
  const queued = new Set(queue);
  let pages = 0;
  for (let path = queue.shift(); path; path = queue.shift()) {
    if (++pages > MONITOR_LIMITS.pages) { notes.push(`Only the first ${MONITOR_LIMITS.pages} pages and style sheets were read for links.`); break; }
    const res = await request(ctx, fileUrl(base, path), base.origin);
    if (res.status !== 200) {
      res.body.destroy();
      if (path === 'index.html') throw new CopyError(`${base.href} answered ${res.status}`);
      continue; // a broken link; the copy step reports it
    }
    const bytes = await readCapped(res.body, MONITOR_LIMITS.pageBytes);
    if (!bytes) { notes.push(`${path} is too big to read for links.`); continue; }
    const text = decoded(bytes, res.headers['content-encoding']).toString('utf8');
    for (const ref of /\.css$/i.test(path) ? cssRefs(text) : htmlRefs(text)) {
      const rel = pathInside(base, ref, fileUrl(base, path));
      if (!rel) continue;
      add(rel);
      if (/\.(html?|css)$/i.test(rel) && !queued.has(rel)) { queued.add(rel); queue.push(rel); }
    }
  }
  return { paths: [...files].sort(), notes };
}

// ---------- copying ----------
class Meter extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;
  override _transform(chunk: Buffer, _enc: string, done: (err: null, chunk: Buffer) => void) {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    done(null, chunk);
  }
}

export interface MonitorEnv {
  db: Db;
  staging: Storage;
  fetcher: Fetcher;
}
export interface CheckResult {
  status: 'changed' | 'unchanged' | 'error';
  message: string;
  files: number;
  bytes: number;
  changed: number;
  removed: number;
}

const size = (bytes: number) => (bytes >= 1e6 ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const NETWORK: Record<string, string> = {
  ENOTFOUND: 'the site’s name couldn’t be found', EAI_AGAIN: 'the site’s name couldn’t be looked up', ECONNREFUSED: 'the site refused the connection',
  ECONNRESET: 'the site closed the connection', ETIMEDOUT: 'the site didn’t answer', CERT_HAS_EXPIRED: 'the site’s security certificate has expired',
};
const running = new Set<number>();
export const isChecking = (id: number) => running.has(id);

// Checks one monitor now and, if the hosted game changed, updates its test build. Never throws: the outcome
// (including a failure) is returned and saved on the monitor.
export async function checkMonitor(env: MonitorEnv, monitor: UrlMonitor, opts: { timeoutMs?: number } = {}): Promise<CheckResult> {
  const { db, staging } = env;
  const game = db.gameById(monitor.game_id) as Game;
  const studio = db.studioById(game.studio_id) as Studio;
  const prefix = `${studio.slug}/${game.slug}/${monitor.ref_name}/`;
  // "~" can't appear in a branch or tag folder name (paths.ts sanitizeRefName), so this never collides with a build.
  const incoming = `${studio.slug}/${game.slug}/~incoming-${monitor.ref_name}/`;
  const finish = (r: CheckResult, files?: Record<string, FileState>): CheckResult => {
    const now = new Date().toISOString();
    db.sqlite.prepare(`UPDATE url_monitors SET last_checked_at = ?, last_status = ?, last_message = ?${r.status === 'changed' ? ', last_changed_at = ?' : ''}${files ? ', state_json = ?' : ''} WHERE id = ?`)
      .run(...[now, r.status, r.message.slice(0, 1000), ...(r.status === 'changed' ? [now] : []), ...(files ? [JSON.stringify({ files })] : []), monitor.id]);
    return r;
  };
  if (running.has(monitor.id)) return { status: 'error', message: 'A check of this game is already running.', files: 0, bytes: 0, changed: 0, removed: 0 };
  running.add(monitor.id);
  const timeoutMs = opts.timeoutMs ?? 4 * 60_000;
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  const ctx: Ctx = { fetcher: env.fetcher, signal: abort.signal };
  const clearIncoming = async () => {
    const keys = (await staging.list(incoming)).map((o) => o.key);
    if (keys.length) await staging.deleteKeys(keys);
  };
  try {
    const base = new URL(monitor.url);
    checkUrl(base);
    await clearIncoming(); // left over if an earlier check was cut off
    const { paths, notes } = await findFiles(ctx, monitor);
    const stored = new Map((await staging.list(prefix)).map((o) => [o.key.slice(prefix.length), o.size]));
    const before = monitor.files;
    const after: Record<string, FileState> = {};
    const changed: string[] = [], missing: string[] = [];
    let total = 0;
    const account = (bytes: number) => {
      total += bytes;
      if (total > MONITOR_LIMITS.totalBytes) throw new CopyError(`the game is bigger than ${size(MONITOR_LIMITS.totalBytes)}, which is more than a monitored game can be`);
    };

    const copyOne = async (path: string) => {
      const was = before[path];
      const have = was !== undefined && stored.get(path) === was.size; // its copy is still in the test build
      const conditional: Record<string, string> = {};
      if (have && was.etag) conditional['If-None-Match'] = was.etag;
      if (have && was.modified) conditional['If-Modified-Since'] = was.modified;
      const res = await request(ctx, fileUrl(base, path), base.origin, conditional);
      if (res.status === 304 && have) { res.body.destroy(); account(was.size); after[path] = was; return; }
      if (res.status !== 200) {
        res.body.destroy();
        // A page can link to something that isn't there; a file list is a promise that every file exists.
        if (monitor.files_from === 'crawl' && path !== 'index.html') { missing.push(path); return; }
        throw new CopyError(`${path === 'index.html' ? base.href : path} answered ${res.status}`);
      }
      const precompressed = /\.(br|gz)$/i.test(path);
      const encoding = precompressed ? undefined : res.headers['content-encoding'];
      const announced = /^\d+$/.test(res.headers['content-length'] ?? '') ? Number(res.headers['content-length']) : null;
      const meter = new Meter();
      let bytes: number;
      if (announced !== null && (!encoding || encoding === 'identity')) {
        // The usual case: stream it straight into storage without holding it in memory.
        account(announced);
        pipeline(res.body, meter, () => { /* a failed download fails the put below */ });
        await staging.put(incoming + path, meter, announced, headersFor(path));
        if (meter.bytes !== announced) throw new CopyError(`${path} ended early (${meter.bytes} of ${announced} bytes)`);
        bytes = announced;
      } else {
        const raw = await readCapped(res.body, MONITOR_LIMITS.bufferedBytes);
        if (!raw) throw new CopyError(`${path} is bigger than ${size(MONITOR_LIMITS.bufferedBytes)} and the server doesn’t say how big it is (no Content-Length), so it can’t be copied`);
        const body = decoded(raw, encoding);
        account(body.length);
        meter.hash.update(body);
        await staging.put(incoming + path, body, body.length, headersFor(path));
        bytes = body.length;
      }
      const now: FileState = { size: bytes, sha256: meter.hash.digest('hex') };
      if (res.headers.etag) now.etag = res.headers.etag;
      if (res.headers['last-modified']) now.modified = res.headers['last-modified'];
      after[path] = now;
      // Downloaded but identical to the copy the test build already has: nothing to replace.
      if (!(have && was.sha256 === now.sha256 && was.size === now.size)) changed.push(path);
    };
    const queue = [...paths];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await copyOne(p);
    }));

    const removed = [...stored.keys()].filter((p) => !(p in after));
    const build = db.build(game.id, monitor.ref_name);
    const count = Object.keys(after).length;
    const note = [
      ...(missing.length ? [`${plural(missing.length, 'linked file')} couldn’t be fetched and ${missing.length === 1 ? 'was' : 'were'} left out: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}.`] : []),
      ...notes,
    ].join(' ');
    if (!changed.length && !removed.length && build?.status === 'live') {
      await clearIncoming();
      return finish({ status: 'unchanged', message: `No changes (${plural(count, 'file')} checked).${note ? ` ${note}` : ''}`, files: count, bytes: total, changed: 0, removed: 0 }, after);
    }
    // Everything arrived: move the new files into the test build. Pages go last, index.html very last, so someone
    // playing during the switch gets the old page or a new page whose files are all in place.
    const isHtml = (p: string) => /\.html?$/i.test(p);
    for (const phase of [changed.filter((p) => !isHtml(p)), changed.filter((p) => isHtml(p) && p !== 'index.html'), changed.filter((p) => p === 'index.html')]) {
      const todo = [...phase];
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        for (let p = todo.shift(); p; p = todo.shift()) await staging.copy(incoming + p, prefix + p, headersFor(p));
      }));
    }
    await clearIncoming();
    if (removed.length) await staging.deleteKeys(removed.map((p) => prefix + p));
    const fingerprint = createHash('sha256').update(Object.keys(after).sort().map((p) => `${p}\n${after[p].sha256}\n`).join('')).digest('hex').slice(0, 16);
    db.upsertBuild({ game_id: game.id, ref_name: monitor.ref_name, ref_type: 'branch', commit_sha: `url:${fingerprint}`, actor: MONITOR_ACTOR } as Upload, count, total);
    db.audit(`system:${MONITOR_ACTOR}`, 'preview.publish', prefix, { source: monitor.url, files: count, bytes: total, changed: changed.length, removed: removed.length });
    const first = !Object.keys(before).length;
    const what = first ? `Copied ${plural(count, 'file')} (${size(total)}) into a test build.`
      : `Updated the test build: ${plural(changed.length, 'file')} changed${removed.length ? `, ${removed.length} removed` : ''} (${plural(count, 'file')}, ${size(total)}).`;
    return finish({ status: 'changed', message: `${what}${note ? ` ${note}` : ''}`, files: count, bytes: total, changed: changed.length, removed: removed.length }, after);
  } catch (err) {
    abort.abort(); // stop the other downloads
    await clearIncoming().catch(() => {});
    const why = timedOut ? `it took longer than ${Math.round(timeoutMs / 60_000) || 1} min`
      : err instanceof BlockedUrlError ? err.message.replace(/\.$/, '')
      : err instanceof CopyError ? err.message
      : NETWORK[(err as NodeJS.ErrnoException).code ?? ''] ?? ((err as Error).message || 'the site could not be reached');
    if (!timedOut && !(err instanceof BlockedUrlError) && !(err instanceof CopyError)) console.error(`url monitor ${studio.slug}/${game.slug}:`, err);
    return finish({ status: 'error', message: `Couldn’t copy the game: ${why}. The test build wasn’t changed.`, files: 0, bytes: 0, changed: 0, removed: 0 });
  } finally {
    clearTimeout(timer);
    running.delete(monitor.id);
  }
}

// Checks monitors one after another, the one checked longest ago first, until they're all done or the time budget is
// used up (the rest go first next time). Called by the scheduled task routes.
export async function checkMonitors(env: MonitorEnv, budgetMs: number): Promise<{ checked: { game: string; status: string; message: string }[]; left: number }> {
  const started = Date.now();
  const all = allMonitors(env.db);
  const checked: { game: string; status: string; message: string }[] = [];
  for (const m of all) {
    const left = budgetMs - (Date.now() - started);
    if (left < 15_000) break;
    const r = await checkMonitor(env, m, { timeoutMs: left });
    checked.push({ game: `${m.studio_slug}/${m.game_slug}`, status: r.status, message: r.message });
  }
  return { checked, left: all.length - checked.length };
}
