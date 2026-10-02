// "Upload builds": the four ways a studio gets a web build onto Vault's test server, and the portal side of the two
// that don't need GitHub.
//   1. One GitHub Action step uploads every push (the action; POST /v1/previews).
//   2. A second step files the publish request for a production branch or a GitHub release (POST /v1/release-requests).
//   3. A .zip uploaded here: the browser unpacks it (public/setup.js) and sends each file straight to storage with the
//      same presigned uploads CI uses; it becomes a test build named upload-YYYYMMDD-HHMM.
//   4. A URL monitor (../url-monitor.ts): Vault copies a game the studio hosts into the test build "web-copy" when it changes.
// Whatever the path, the result is a test build on the game's page, released the usual way (request → Vault approves).
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail, jsonBody, parseManifest } from '../app.ts';
import type { Game, Studio, User } from '../db.ts';
import { isSlug } from '../paths.ts';
import {
  checkMonitor, deleteMonitor, fileListUrl, gameFolderUrl, isChecking, monitorById, monitorForGame, MONITOR_ACTOR,
  MONITOR_LIMITS, MONITOR_REF, monitorsForStudio, saveMonitor, type UrlMonitorRow,
} from '../url-monitor.ts';
import { html, raw, type Html } from './html.ts';
import type { ListingHelpers } from './listings.ts';
import { ago, head, pill } from './routes.ts';

const MB = 1024 * 1024;
// A zip uploaded in the portal, unpacked. public/setup.js applies the same limits before it sends anything.
export const PORTAL_UPLOAD_LIMITS = { zipBytes: 1024 * MB, files: 5000, totalBytes: 2048 * MB };
const PRESIGN_SECONDS = 2 * 60 * 60;        // a big upload over a slow connection
const CHECK_TIMEOUT_MS = 4 * 60_000;        // under Cloud Run's 5-minute request limit
const RESERVED = /^(_releases\/|_vault-assets\/|current\.json$)/;

// "upload-20261001-1432" (UTC).
export const uploadRefName = (at: Date) => `upload-${at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;

// How a test build got here, when it wasn't a push: its commit is "zip:…" (uploaded here) or "url:…" (a URL monitor).
export function buildOrigin(commitSha: string | null | undefined): 'upload' | 'web copy' | null {
  return commitSha?.startsWith('zip:') ? 'upload' : commitSha?.startsWith('url:') ? 'web copy' : null;
}

export function registerUploads(app: Hono, h: ListingHelpers) {
  const { db, deps } = h;
  const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)));
  const js = asset('setup.js'), css = asset('setup.css');
  const version = createHash('sha256').update(js).update(css).digest('hex').slice(0, 10);
  const immutable = 'public, max-age=31536000, immutable';
  app.get('/assets/setup.js', (c) => c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': immutable }));
  app.get('/assets/setup.css', (c) => c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': immutable }));

  // Uploading a build or monitoring an address: studio maintainers and admins for their own studio, and Vault staff.
  const canUpload = (u: User, s: Studio) => h.canRelease(u) || ['maintainer', 'admin'].includes(h.roleIn(u, s) ?? '');
  function apiStudio(studioSlug: string, u: User): Studio {
    const s = db.studioBySlug(studioSlug);
    if (!s || !(h.isStaff(u) || h.roleIn(u, s))) fail(404, 'unknown studio');
    if (!canUpload(u, s)) fail(403, 'Only studio maintainers, studio admins and Vault staff can upload builds.');
    return s;
  }
  // The studio's game with this name, created if it's new. A game made here has no repository yet (like one Vault
  // uploads); a repository of the studio's that later publishes the same name takes it over, with its builds.
  function gameFor(s: Studio, slug: unknown, u: User): Game {
    if (!isSlug(slug)) fail(400, 'The game name must be lowercase letters, numbers and dashes, like “my-game”.');
    let game = db.game(s.id, slug);
    if (!game) {
      game = db.createGame(s.id, slug, '', `vault:${s.slug}/${slug}`);
      db.audit(h.actor(u), 'game.create', `${s.slug}/${slug}`, { by: 'portal' });
      deps.linkSameNamedListing(s, game);
    }
    return game;
  }

  // ---------- 3. zip upload ----------
  // Body: { game, files: [{ path, size }] } (the zip's contents, as the browser will send them). Answers with an
  // upload address per file; the browser PUTs each file there, then calls finalize.
  app.post('/portal/api/s/:studio/uploads', async (c) => {
    const u = h.apiUser(c);
    const s = apiStudio(c.req.param('studio'), u);
    const b = await jsonBody(c);
    const files = (Array.isArray(b.files) ? b.files : []) as { path?: unknown; size?: unknown }[];
    const L = PORTAL_UPLOAD_LIMITS;
    if (files.length > L.files) fail(400, `A build uploaded here can have at most ${L.files} files.`);
    if (files.reduce((n, f) => n + (typeof f?.size === 'number' ? f.size : 0), 0) > L.totalBytes) fail(400, `A build uploaded here can be at most ${L.totalBytes / MB} MB unpacked.`);
    if (!files.some((f) => f?.path === 'index.html')) fail(400, 'There’s no index.html at the top of the build.');
    const reserved = files.find((f) => typeof f?.path === 'string' && RESERVED.test(f.path));
    if (reserved) fail(400, `The build contains “${reserved.path}”, a name Vault uses itself. Rename or remove it.`);
    parseManifest(files); // every path relative and inside the build (no "..", no absolute paths), every size sane
    const game = gameFor(s, b.game, u);
    let name = uploadRefName(new Date());
    for (let n = 2; db.build(game.id, name); n++) name = `${uploadRefName(new Date())}-${n}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
    const out = await deps.startUpload(s, game, { type: 'branch', name }, `zip:${fingerprint}`, u.login, files, PRESIGN_SECONDS);
    return c.json({ ...out, ref: name });
  });

  app.post('/portal/api/s/:studio/uploads/:id/finalize', async (c) => {
    const u = h.apiUser(c);
    const s = apiStudio(c.req.param('studio'), u);
    const up = db.upload(c.req.param('id'));
    const game = up && db.gameById(up.game_id);
    // Only uploads started here: a CI upload is finalized by its own repository.
    if (!up || !game || game.studio_id !== s.id || buildOrigin(up.commit_sha) !== 'upload') fail(404, 'unknown upload');
    const out = await deps.finishUpload(up.id, (g) => g.studio_id === s.id, h.actor(u), { portal_upload: true });
    return c.json({ ok: true, url: out.url, ref: up.ref_name, page: `/s/${s.slug}/g/${game.slug}?tab=cdn` });
  });

  // ---------- 4. URL monitors ----------
  function monitorIn(s: Studio, id: string): UrlMonitorRow {
    const m = monitorById(db, Number(id));
    if (!m || m.studio_slug !== s.slug) fail(404, 'unknown monitor');
    return m;
  }

  // Start (or change) monitoring a game's hosted address, and copy it now.
  // Body: { game, url, files_from: 'list' | 'crawl', list_url? }
  app.post('/portal/api/s/:studio/monitors', async (c) => {
    const u = h.apiUser(c);
    const s = apiStudio(c.req.param('studio'), u);
    const b = await jsonBody(c);
    const filesFrom = b.files_from === 'list' ? 'list' : 'crawl';
    let url: URL, list: URL | null;
    try {
      url = gameFolderUrl(b.url);
      list = filesFrom === 'list' ? fileListUrl(b.list_url, url) : null;
    } catch (err) { fail(400, (err as Error).message); }
    const game = gameFor(s, b.game, u);
    const taken = db.build(game.id, MONITOR_REF);
    if (taken && taken.status === 'live' && taken.actor !== MONITOR_ACTOR) fail(409, `${game.slug} already has a test build called “${MONITOR_REF}” that didn’t come from a monitor. Remove or rename that branch first.`);
    const m = saveMonitor(db, { game_id: game.id, url: url.href, files_from: filesFrom, list_url: list?.href ?? null, by: h.actor(u) });
    db.audit(h.actor(u), 'monitor.save', `${s.slug}/${game.slug}`, { url: m.url, files_from: m.files_from, list_url: m.list_url });
    const r = await checkMonitor(deps.monitorEnv, m, { timeoutMs: CHECK_TIMEOUT_MS });
    return c.json({ ok: true, status: r.status, message: r.message });
  });

  app.post('/portal/api/s/:studio/monitors/:id/check', async (c) => {
    const u = h.apiUser(c);
    const s = apiStudio(c.req.param('studio'), u);
    const m = monitorIn(s, c.req.param('id'));
    if (isChecking(m.id)) fail(409, 'A check of this game is already running. Give it a minute.');
    const r = await checkMonitor(deps.monitorEnv, m, { timeoutMs: CHECK_TIMEOUT_MS });
    return c.json({ ok: true, status: r.status, message: r.message });
  });

  // Stop monitoring. The test build it made stays (and now expires like any other branch's).
  app.post('/portal/api/s/:studio/monitors/:id/delete', async (c) => {
    const u = h.apiUser(c);
    const s = apiStudio(c.req.param('studio'), u);
    const m = monitorIn(s, c.req.param('id'));
    deleteMonitor(db, m.id);
    db.audit(h.actor(u), 'monitor.delete', `${s.slug}/${m.game_slug}`, { url: m.url });
    return c.json({ ok: true });
  });

  // ---------- the page ----------
  const err = html`<span class="err" role="status" aria-live="polite"></span>`;
  const statusPill = (m: UrlMonitorRow) => (m.last_status === 'error' ? pill('bad', 'Couldn’t copy') : m.last_status === 'changed' ? pill('ok', 'Copied') : m.last_status === 'unchanged' ? pill('ok', 'Up to date') : pill('off', 'Not checked yet'));

  app.get('/s/:studio/register', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    const s = h.studioFor(c, u); if (s instanceof Response) return s;
    const builds = deps.stagingPublicUrl, cdn = deps.prodPublicUrl;
    const portal = deps.portal.baseUrl.replace(/\/+$/, '');
    const host = (url: string) => url.replace(/^https?:\/\//, '');
    const may = canUpload(u, s);
    const games = db.gamesForStudio(s.id);
    const monitors = monitorsForStudio(db, s.id);
    const api = `/portal/api/s/${s.slug}`;
    const title = (n: number, text: string, tag: string) => html`<h2><span><b class="n">${n}</b>${text}</span><span class="tag">${tag}</span></h2>`;
    const next = (items: (Html | string)[]) => html`<div class="next"><h3>What happens next</h3><ul class="tight">${items.map((i) => html`<li>${i}</li>`)}</ul></div>`;
    const where = html`<span class="mono wrap">${host(builds)}/${s.slug}/<span data-game>my-game</span>/</span>`;
    const membersOnly = html`<p class="fix">Only studio maintainers and studio admins can do this. Ask a studio admin on the <a href="/s/${s.slug}/members">Members</a> page.</p>`;
    // Who may upload for this studio from GitHub: its organization's repositories, and single repositories Vault has
    // assigned to it (a game kept in someone else's organization).
    const assigned = db.studioRepositories(s.id).map((r) => r.repository);
    const repos = assigned.map((r, i) => html`${i ? ', ' : ''}<b>github.com/${r}</b>`);
    const github = s.github_owner
      ? html`Vault accepts uploads from repositories in <b>github.com/${s.github_owner}</b>${assigned.length ? html`, and from ${repos}` : ''}. The first repository to upload a game name owns that name.`
      : assigned.length ? html`Vault accepts uploads for this studio from ${repos}. To add another repository, ask Vault.`
      : html`<b>This studio has no GitHub organization or repository registered with Vault yet.</b> Ask Vault to add one before using GitHub, or use path 3 or 4, which don’t need it.`;

    const path1 = html`<section class="card path" id="path-1">
      ${title(1, 'Upload every push from GitHub', 'GitHub Actions')}
      <p class="lede">Add one step to a GitHub Actions workflow. Every push, to any branch or tag, becomes a test build you can play and share. You publish from this portal when a build is ready.</p>
      <div class="field" data-redraw><span class="lab">How is the web build made?</span>
        <label class="check"><input type="radio" name="setup-kind" value="build" checked> Our workflow builds it (npm, Godot, Construct, anything that makes a folder with index.html)</label>
        <label class="check"><input type="radio" name="setup-kind" value="committed"> The web build is committed to the repository</label>
        <label class="check"><input type="radio" name="setup-kind" value="unity"> It’s a Unity project, and Vault’s shared workflow should build it</label></div>
      <ol class="steps-list">
        <li>Add this file to the repository as <code>.github/workflows/vault.yml</code>.
          <div class="code-head"><span class="small muted">.github/workflows/vault.yml</span><button class="btn sm" type="button" data-copy="#snippet-1">Copy</button></div>
          <pre class="code" id="snippet-1"></pre>
          <p class="small" data-kind="build">Put your own build where the comment is. <code>path</code> is the folder that ends up holding <code>index.html</code>. Already have a workflow that builds the game? Add just the last step to it, and give its job <code>permissions: { contents: read, id-token: write }</code>.</p>
          <p class="small" data-kind="committed" hidden>Change <code>path</code> to the folder in the repository that holds <code>index.html</code>.</p>
          <p class="small" data-kind="unity" hidden>Add your Unity licence to the repository (or organization) as the secrets <code>UNITY_EMAIL</code>, <code>UNITY_PASSWORD</code> and <code>UNITY_SERIAL</code>. The build uses the Unity version the project was saved with.</p></li>
        <li>Commit and push. That’s the whole setup: there are no keys or passwords to add, because GitHub vouches for the repository.</li>
      </ol>
      <p class="small">${github}</p>
      ${next([
        html`A few minutes after each push, the build is playable at ${where}<span class="mono">BRANCH/</span> and listed on the game’s page here. The game appears under <a href="/s/${s.slug}">Games</a> after its first upload.`,
        html`<b>To publish,</b> open the game’s page, choose <b>Request release</b> on the test build you want, and Vault reviews it. Classrooms get it once Vault approves.`,
        'Test builds of branches are removed 90 days after their last push. Tags are kept.',
      ])}
    </section>`;

    const path2 = html`<section class="card path" id="path-2">
      ${title(2, 'Also ask Vault to publish, automatically', 'GitHub Actions · optional')}
      <p class="lede">Add a second step to the same workflow and the publish request files itself: when you push to your production branch, when you publish a GitHub release, or both. Vault still reviews every request before classrooms get the build.</p>
      <div class="field" data-redraw><span class="lab">File a publish request when…</span>
        <label class="check"><input type="checkbox" id="auto-production" checked> a push lands on the branch <input id="auto-branch" value="production" aria-label="Branch name" class="inline-input" autocomplete="off" spellcheck="false"></label>
        <label class="check"><input type="checkbox" id="auto-release"> a release is published on GitHub</label></div>
      <ol class="steps-list">
        <li>Replace the file from path 1 with this one. It’s the same file with one more step at the end.
          <div class="code-head"><span class="small muted">.github/workflows/vault.yml</span><button class="btn sm" type="button" data-copy="#snippet-2">Copy</button></div>
          <pre class="code" id="snippet-2"></pre></li>
        <li>Commit and push.</li>
      </ol>
      ${next([
        html`<span id="auto-production-next">Each push to <span class="mono" data-branch>production</span> uploads the build and files a request named after the branch and commit, like <span class="mono"><span data-branch>production</span>-4f7275b</span>. A newer push replaces a request Vault hasn’t decided yet.</span>`,
        html`<span id="auto-release-next" hidden>Publishing a release on GitHub uploads the build of its tag and files a request named after the tag, like <span class="mono">v1.2</span>.</span>`,
        html`The request shows on the game’s page as <b>Waiting for Vault</b>. Vault plays that exact build, then approves it (classrooms get it) or sends it back with a note. Nothing reaches classrooms without that approval.`,
        html`To name versions yourself, add <code>version: 1.4.0</code> under the second step’s <code>with:</code>. A version name can be used once.`,
      ])}
    </section>`;

    const L = PORTAL_UPLOAD_LIMITS;
    const path3 = html`<section class="card path" id="path-3">
      ${title(3, 'Upload a .zip', 'No GitHub needed')}
      <p class="lede">Not on GitHub, or just want to try a build? Zip your web build and upload it here.</p>
      <ol class="steps-list">
        <li>Zip the folder of your web build: the folder that has <code>index.html</code> in it, with everything the game loads. (Zipping the folder itself is fine.)</li>
        <li>Choose the zip and upload it to <b class="mono">${s.slug}/<span data-game>my-game</span></b>.
          ${may ? html`<form id="zip-form" class="zip-form" data-start="${api}/uploads">
            <input type="file" accept=".zip,application/zip" required aria-label="Zip file of the web build">
            <button class="btn pri">Upload</button>
            <progress max="1" value="0" hidden aria-label="Upload progress"></progress>${err}</form>` : membersOnly}</li>
      </ol>
      <p class="small muted">Up to ${L.zipBytes / MB / 1024} GB zipped, ${L.totalBytes / MB / 1024} GB unpacked and ${L.files.toLocaleString('en-US')} files. Password-protected zips and zips that contain links (shortcuts) are refused.</p>
      ${next([
        'Your browser unpacks the zip and sends the files one by one, so keep the page open until it finishes.',
        html`It becomes a test build named like <span class="mono">${uploadRefName(new Date())}</span> on the game’s page. Play it there and, when it’s the one, choose <b>Request release</b>: Vault reviews it, and classrooms get it once Vault approves.`,
        'Each upload is a new test build; earlier ones stay until they’re 90 days old. Released builds are kept for good.',
      ])}
    </section>`;

    const M = MONITOR_LIMITS;
    const monitorRows = monitors.map((m) => html`<tr>
      <td class="proj"><a href="/s/${s.slug}/g/${m.game_slug}?tab=cdn"><b>${m.game_slug}</b></a><span>test build <span class="mono">${m.ref_name}</span></span></td>
      <td class="small"><a class="wrap" href="${m.url}" target="_blank" rel="noopener">${host(m.url)}</a><br><span class="muted">${m.files_from === 'list' ? html`files from <a href="${m.list_url}" target="_blank" rel="noopener">its file list</a>` : 'files found from index.html'}</span></td>
      <td class="small">${statusPill(m)} <span class="muted">${m.last_checked_at ? ago(m.last_checked_at) : ''}</span>${m.last_message ? html`<br>${m.last_message}` : ''}${m.last_changed_at ? html`<br><span class="muted">last copied ${ago(m.last_changed_at)}</span>` : ''}</td>
      <td class="r">${may ? html`<div class="row-actions">
        <form data-api="${api}/monitors/${m.id}/check" data-then="reload" data-busy="Checking ${m.game_slug}. This can take a few minutes; keep this page open."><button class="btn sm">Check now</button>${err}</form>
        <form data-api="${api}/monitors/${m.id}/delete" data-then="reload" data-confirm="Stop copying ${m.game_slug} from its web address? Its test build stays."><button class="btn sm">Stop</button>${err}</form></div>` : ''}</td></tr>`);
    const path4 = html`<section class="card path" id="path-4">
      ${title(4, 'Monitor a web address', 'No GitHub needed')}
      <p class="lede">Already hosting the game on your own site? Give Vault its address. Vault copies it into a test build now, looks again once a day, and copies it again whenever it has changed.</p>
      ${may ? html`<form data-api="${api}/monitors" data-then="reload" data-busy="Copying the game. This can take a few minutes; keep this page open." class="monitor-form">
        <input type="hidden" name="game" data-game-field value="my-game">
        <label class="field"><span class="lab">Where the game is hosted</span><input type="url" name="url" required placeholder="https://games.example.org/my-game/" autocomplete="off" spellcheck="false">
          <span class="hint">The public address of the folder that has <code>index.html</code>. It’s copied to <b class="mono">${s.slug}/<span data-game>my-game</span></b>.</span></label>
        <div class="field"><span class="lab">How should Vault find the game’s files?</span>
          <label class="check"><input type="radio" name="files_from" value="list" checked> From a file list I publish next to the game</label>
          <label class="check"><input type="radio" name="files_from" value="crawl"> By following the links in <code>index.html</code></label></div>
        <label class="field" id="monitor-list"><span class="lab">Address of the file list</span><input type="url" name="list_url" placeholder="https://games.example.org/my-game/files.txt" autocomplete="off" spellcheck="false">
          <span class="hint">A text file with one path per line, relative to the game’s folder (or a JSON array of paths). On the same site as the game.</span></label>
        <div><button class="btn pri">Copy it and keep watching</button> ${err}</div>
      </form>` : membersOnly}
      <details class="small"><summary>Which should I choose, and how do I make a file list?</summary>
        <p><b>A file list always works,</b> because it names every file. In the game’s folder, run <code>find . -type f | sed 's|^\\./||' > files.txt</code> (macOS, Linux) and upload <code>files.txt</code> with the game. Make it again when files are added or removed.</p>
        <p><b>Following links works for plain web pages.</b> Vault reads <code>index.html</code>, and the pages and style sheets it links to, and copies every file they mention. It can’t see files that the game’s own code loads while it runs, which is how Unity, Godot and most engine builds load their data, so those games need a file list.</p></details>
      <p class="small muted">Up to ${M.files.toLocaleString('en-US')} files and ${M.totalBytes / MB / 1024} GB. The address must be public and start with http:// or https://; every file must be on the same site, inside the game’s folder.</p>
      ${next([
        html`The copy is the test build <span class="mono">${MONITOR_REF}</span> on the game’s page, playable at ${where}<span class="mono">${MONITOR_REF}/</span>.`,
        html`Vault looks at your address once a day and updates the test build when a file has changed, been added or removed. <b>Check now</b> does it straight away.`,
        html`Publishing stays your decision: when the test build is the version you want in classrooms, choose <b>Request release</b> on the game’s page and Vault reviews it.`,
      ])}
      ${monitors.length ? html`<h3 class="sub">Addresses Vault is watching</h3>
        <div class="tbl-wrap"><table><thead><tr><th>Game</th><th>Address</th><th>Last check</th><th></th></tr></thead><tbody>${monitorRows}</tbody></table></div>` : ''}
    </section>`;

    const body = html`<link rel="stylesheet" href="/assets/setup.css?v=${version}">
      ${head('Upload builds', html`Four ways to get a web build of your game onto Vault’s test server. Use whichever fits how your studio works; a game can use more than one. Publishing to classrooms is always the same last step: you ask, Vault approves.`, '', html`<a href="/s/${s.slug}">${s.name}</a> / Upload builds`)}
      <div class="grid g-main"><div class="grid">
        <div class="card" data-redraw>
          <label class="field"><span class="lab">Which game?</span><input id="setup-game" value="my-game" autocomplete="off" spellcheck="false" pattern="[a-z0-9][a-z0-9-]*" list="setup-games">
            <span class="hint">A short name in lowercase letters, numbers and dashes. It becomes part of the game’s address: ${where} A new name makes a new game.</span></label>
          <datalist id="setup-games">${games.map((g) => html`<option value="${g.slug}"></option>`)}</datalist>
          <nav class="paths-nav" aria-label="Ways to upload">
            <a href="#path-1"><b>1</b> Every push from GitHub</a><a href="#path-2"><b>2</b> Automatic publish requests</a>
            <a href="#path-3"><b>3</b> Upload a .zip</a><a href="#path-4"><b>4</b> Monitor a web address</a></nav>
        </div>
        ${path1}${path2}${path3}${path4}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card small"><h2>From test build to classrooms</h2><ol class="tight">
          <li>A build arrives by any of the four paths and shows on the game’s page as a <b>test build</b>.</li>
          <li>You and your testers play it at its test address.</li>
          <li>A maintainer chooses <b>Request release</b> on it (path 2 does this for you).</li>
          <li>Vault plays that exact build and approves it, or sends it back with a note.</li>
          <li>Approved builds are kept for good; maintainers can switch back to an earlier one at any time.</li></ol></div>
        <div class="card small"><h2>What’s where</h2><ul class="tight">
          <li><b>Test server</b>: <span class="mono wrap">${host(builds)}/${s.slug}/GAME/BUILD/</span>. For your team and playtesters; search engines don’t index it.</li>
          <li><b>Classrooms</b>: <span class="mono wrap">${host(cdn)}/${s.slug}/GAME/</span>. Only builds Vault has approved.</li></ul></div>
        <div class="card small"><h2>More detail</h2><p>The step-by-step details, and the options each path has, are in the <a href="https://github.com/VaultLearningGames/vault-publisher#upload-builds" target="_blank" rel="noopener">publisher’s README</a>.</p></div>
      </div></div>
      <script type="application/json" id="setup-data">${raw(JSON.stringify({ studio: s.slug, portal }).replace(/</g, '\\u003c'))}</script>
      <script type="module" src="/assets/setup.js?v=${version}"></script>`;
    return h.page(c, 'Upload builds', body, { studio: s, active: 'register' });
  });

  // A line for the game page's test builds card when the game is copied from a web address.
  return {
    monitorNote(s: Studio, g: Game): Html | string {
      const m = monitorForGame(db, g.id);
      if (!m) return '';
      return html`<p class="small" style="margin-top:12px">${statusPill(m)} <span class="mono">${m.ref_name}</span> is copied from <a class="wrap" href="${m.url}" target="_blank" rel="noopener">${m.url}</a> when it changes${m.last_checked_at ? html`; last checked ${ago(m.last_checked_at)}` : ''}. <a href="/s/${s.slug}/register#path-4">Check now or stop</a></p>`;
    },
  };
}
