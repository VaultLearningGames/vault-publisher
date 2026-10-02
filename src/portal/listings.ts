// Site listings: what vaultlearninggames.org shows for each game, edited on the game's page in the portal.
// A game in the portal is its site listing and/or its CDN game (builds and releases), linked together:
//   - Games already on the site that are hosted at a web address have only a listing until they move to the CDN.
//   - A listing is hosted on the Vault CDN once its linked CDN game has a current release.
// Studios edit a listing's draft; Vault publishes it. The site is built from GET /v1/catalog (published listings).
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import type { Db, Game, Listing, Studio, StudioRole, User } from '../db.ts';
import { draftProblems, importFromExport, moveListingToStudio, publishListing, saveListing } from '../listing-ops.ts';
import { changedFields, FIELD_LABEL, GRADES, isListingSlug, normalize, type ListingFields } from '../listings.ts';
import { getHosting, hostingCell } from './hosting.ts';
import { html, type Html } from './html.ts';
import { ago, head, pill, who } from './routes.ts';
import { availabilityCells, availabilityLine, AVAILABILITY_HEADS } from './availability.ts';
import { compareByTestingStatus, deriveTestingStatus } from './testingStatus.ts';
import { MAX_FEATURED, readFeatured, sortFeatured, type FeaturedEntry } from '../featured.ts';
import type { PortalDeps } from './routes.ts';
import { imageField } from './listing-assets.ts';
import { previewButtons, saveControls } from './listing-preview.ts';
import { addMaker, createProposedStudios, makersField, proposedLine, pruneMakerProposals } from './listing-makers.ts';

export interface ListingHelpers {
  db: Db;
  deps: PortalDeps;
  page(c: Context, title: string, body: Html, opts?: { studio?: Studio; active?: string; status?: number }): Response | Promise<Response>;
  denied(c: Context, message: string, status?: number): Response | Promise<Response>;
  signedIn(c: Context): User | Response;
  studioFor(c: Context, u: User): Studio | Response;
  apiUser(c: Context): User;
  actor(u: User): string;
  isStaff(u: User): boolean;
  canRelease(u: User): boolean;
  isVaultAdmin(u: User): boolean;
  roleIn(u: User, s: Studio): StudioRole | undefined;
}
export type ListingRow = Listing & { studio_slug: string; studio_name: string };

const err = html`<span class="err" role="status" aria-live="polite"></span>`;

export function listingPieces(h: ListingHelpers) {
  const { db } = h;
  // Studio maintainers and admins edit their studio's listings; Vault staff edit any. Only Vault publishes.
  const canEdit = (u: User, s: Studio) => h.isStaff(u) || ['maintainer', 'admin'].includes(h.roleIn(u, s) ?? '');
  const canPublish = (u: User) => h.canRelease(u);
  const currentOf = (g: Game | null) => (g ? db.currentRelease(g.id) ?? null : null);
  const cdnUrl = (s: Studio, g: Game) => `${h.deps.prodPublicUrl}/${s.slug}/${g.slug}/`;

  function state(l: ListingRow | null): Html {
    if (!l) return pill('off', 'Not on the site');
    if (l.review === 'submitted') return pill('wait', 'Waiting for Vault');
    if (l.review === 'returned') return pill('bad', 'Sent back');
    if (!l.published) return pill('off', 'Not on the site');
    return changedFields(l.published, l.draft).length ? pill('run', 'Unpublished changes') : pill('ok', 'On the site');
  }

  // The "Hosted by" column: how the site hosts the game today (its published listing, else the draft).
  function hosting(l: ListingRow | null, g: Game | null): Html {
    if (!l) return hostingCell(getHosting({}, h.deps.prodPublicUrl));
    const f = l.published ?? l.draft;
    return hostingCell(getHosting({ play_source: f.play_source, play_url: f.play_url, version: currentOf(g)?.version ?? null }, h.deps.prodPublicUrl));
  }

  // The "where it plays" card at the top of a game page, with the one-step move to (or back from) the Vault CDN.
  function playCard(u: User, s: Studio, l: ListingRow | null, g: Game | null): Html {
    const cur = currentOf(g);
    const f = l?.draft;
    const pub = l?.published;
    const onCdn = pub?.play_source === 'cdn' && !!cur;
    const api = l ? `/portal/api/s/${s.slug}/listings/${l.slug}` : '';
    const vault = canPublish(u), edit = canEdit(u, s);
    const how = vault ? 'publish' : 'submit';
    const action = (to: 'cdn' | 'url', label: string, confirm: string) => (edit && l ? html`<form data-api="${api}" data-then="reload" data-confirm="${confirm}" class="inline-form">
        <input type="hidden" name="play_source" value="${to}"><input type="hidden" name="${how}" value="1">
        <button class="btn ${to === 'cdn' ? 'brass' : 'sm'}">${label}</button>${err}</form>` : '');
    let status: Html, next: Html | string = '';
    if (!l) status = html`<p>${pill('off', 'Not on the site')} This CDN game isn’t shown on vaultlearninggames.org yet.</p>`;
    else if (onCdn) {
      status = html`<p>${pill('brass', 'Vault CDN')} Classrooms play release <b class="mono">${cur!.version}</b> from <a class="mono" href="${cdnUrl(s, g!)}${pub!.cdn_path}" target="_blank" rel="noopener">${cdnUrl(s, g!)}${pub!.cdn_path}</a>.</p>`;
      next = action('url', 'Switch back to the web address', `Play ${f!.title || l.slug} from ${pub!.play_url || 'its web address'} again?`);
    } else {
      status = html`<p>${pill('off', 'Web address')} Classrooms play ${pub?.play_url ? html`<a class="mono" href="${pub.play_url}" target="_blank" rel="noopener">${pub.play_url}</a>` : html`<span class="muted">nothing yet (not published)</span>`} in Vault’s player.</p>`;
      if (cur) next = html`<p class="small">Release <b class="mono">${cur.version}</b> is ready on the Vault CDN.</p>${action('cdn', vault ? `Switch to the Vault CDN (${cur.version})` : `Ask Vault to switch to the CDN (${cur.version})`, `Play ${f!.title || l.slug} from the Vault CDN (${cur.version})?${vault ? ' The site shows this after its next build.' : ''}`)}`;
      else if (g) next = html`<p class="small muted">On the Vault CDN, but nothing is released yet. Release a test version below; then it can switch.</p>`;
      else next = html`<p class="small muted">Not on the Vault CDN yet. It moves over when ${s.name}’s builds publish to Vault (<a href="/s/${s.slug}/register">set up</a>), or when Vault uploads its current version.</p>`;
    }
    const waiting = l && l.review === 'submitted' ? html`<p class="small">${pill('wait', 'Waiting for Vault')} ${changedFields(l.published, l.draft).map((k) => FIELD_LABEL[k]).join(', ')}</p>` : '';
    const checked = pub ? availabilityLine(db, l!.slug, h.isStaff(u)) : '';
    return html`<div class="card"><h2>Where it plays</h2>${status}${checked}${waiting}${next}</div>`;
  }

  // The listing editor (draft) and its status card.
  // Vault admins: which studio a game belongs to (whose members edit it, and the studio shown on the site).
  function studioCard(s: Studio, l: ListingRow): Html {
    const others = db.studios().filter((x) => x.id !== s.id).sort((a, b) => a.name.localeCompare(b.name));
    const cdn = l.game_id ? db.gameById(l.game_id) : null;
    return html`<div class="card"><h2>Studio</h2>
      <p class="small">${l.draft.title || l.slug} belongs to <b>${s.name}</b>. Its members edit it, and the site shows it as ${s.name}’s.${cdn ? html` Moving it disconnects it from ${s.name}’s Vault CDN game <span class="mono">${cdn.slug}</span>.` : ''}</p>
      <form data-api="/portal/api/s/${s.slug}/listings/${l.slug}/studio" data-then="go" data-confirm="Move ${l.draft.title || l.slug} to the chosen studio?" class="stack">
        <select name="studio" required aria-label="New studio"><option value="">Move to…</option>${others.map((x) => html`<option value="${x.slug}">${x.name}</option>`)}</select>
        <button class="btn sm">Move to this studio</button>${err}</form></div>`;
  }

  function editor(u: User, s: Studio, l: ListingRow, g: Game | null): { form: Html; side: Html } {
    const edit = canEdit(u, s), vault = canPublish(u);
    const f = l.draft;
    const api = `/portal/api/s/${s.slug}/listings/${l.slug}`;
    const changed = changedFields(l.published, f);
    const cur = currentOf(g);
    const dis = edit ? '' : 'disabled';
    const txt = (name: keyof ListingFields, label: string, hint = '', attrs = '') => html`<label class="field"><span class="lab">${label}</span>
      <input type="text" name="${name}" value="${Array.isArray(f[name]) ? (f[name] as string[]).join(', ') : String(f[name] ?? '')}" ${dis} ${attrs}>${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
    const area = (name: keyof ListingFields, label: string, hint = '', rows = 3) => html`<label class="field full"><span class="lab">${label}</span>
      <textarea name="${name}" rows="${rows}" ${dis}>${Array.isArray(f[name]) ? (f[name] as string[]).join('\n') : String(f[name] ?? '')}</textarea>${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
    const form = html`<form data-api="${api}" data-then="reload" class="card form-card">
      <h2>Site listing <small>vaultlearninggames.org/games/${l.slug}/</small></h2>
      <div class="fields">
        ${txt('title', 'Title', '', 'required')}
        ${makersField(db, { api, edit, staff: h.isStaff(u), studio: s, listing: l })}
        ${area('short_description', 'Short description', 'One or two sentences, shown on the game card.', 2)}
        ${area('about', 'About this game', '', 6)}
        <div class="field full"><span class="lab">Grades</span><div class="chips">${GRADES.map((gr) => html`<label><input type="checkbox" name="grades:${gr}" ${f.grades.includes(gr) ? 'checked' : ''} ${dis}> ${gr.replace('Grades ', '')}</label>`)}</div></div>
        ${txt('subjects', 'Subjects', 'Comma-separated, e.g. Math, Science')}
        ${txt('topics', 'Topics', 'Comma-separated, e.g. Algebra, Physics')}
        ${area('standards', 'Standards', 'Codes, one per line or comma-separated (Common Core, NGSS), e.g. 4.OA.A.2', 2)}
        ${txt('related_curriculum', 'Related curriculum', 'A link to teacher materials')}
        ${txt('gameplay_video', 'Gameplay video', 'A YouTube or other video link')}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'hero_image', label: 'Hero image', value: f.hero_image, hint: 'A path on the site (games/x/img/hero.png) or an https link.' })}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'thumb_image', label: 'Thumbnail', value: f.thumb_image, hint: 'A path on the site or an https link.' })}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'screenshots', label: 'Screenshots', value: f.screenshots, hint: 'One path or link per line, in the order the site shows them; delete a line to remove it.' })}
      </div>
      <h2 style="margin-top:18px">Playing</h2>
      <div class="fields">
        <div class="field full"><span class="lab">Hosted by</span>
          <label class="check"><input type="radio" name="play_source" value="url" ${f.play_source === 'url' ? 'checked' : ''} ${dis}> Its web address, shown in Vault’s player</label>
          <label class="check"><input type="radio" name="play_source" value="cdn" ${f.play_source === 'cdn' ? 'checked' : ''} ${cur ? dis : 'disabled'}> The Vault CDN: ${g ? html`<span class="mono">${s.slug}/${g.slug}</span>, ${cur ? html`currently <b class="mono">${cur.version}</b>` : 'nothing released yet'}` : 'no CDN game yet'}</label></div>
        ${txt('play_url', 'Web address', 'The page that shows only the game (what Vault’s player wraps). Also the fallback if the CDN game has no release.')}
        ${g ? txt('cdn_path', 'CDN folder', `Optional folder inside ${s.slug}/${g.slug}/, e.g. earthquake/ for one game of a collection.`) : ''}
        <label class="field"><span class="lab">Opens in</span><select name="embed" ${dis}>
          <option value="true" ${f.embed ? 'selected' : ''}>Vault’s player (the game’s page allows framing)</option>
          <option value="false" ${f.embed ? '' : 'selected'}>A new tab (the game’s page refuses to be framed)</option></select></label>
        ${vault ? txt('fit', 'Player fit (Vault)', 'For fixed-size games: page width, page height, x, y, width, height of the game on that page.') : ''}
      </div>
      ${edit ? html`<div class="form-foot">${saveControls(vault, l)}${previewButtons(api, h.deps.previewSites)}${err}</div>` : ''}
    </form>`;
    const side = html`<div class="card"><h2>Site listing</h2><p>${state(l)}</p>
        ${l.published ? html`<p class="small">On the site since ${l.published_at?.slice(0, 10)} (${who(l.published_by ?? '')}).</p>` : html`<p class="small muted">Not on the site yet.</p>`}
        ${l.review === 'submitted' ? html`<p class="small">Submitted ${ago(l.submitted_at)} by ${who(l.submitted_by ?? '')}.</p>` : ''}
        ${l.review_note ? html`<p class="small"><b>Vault:</b> ${l.review_note}</p>` : ''}
        ${changed.length ? html`<p class="small"><b>Not on the site yet:</b> ${changed.map((k) => FIELD_LABEL[k]).join(', ')}</p>` : ''}
        ${vault ? html`
          <form data-api="${api}/publish" data-then="reload" data-confirm="Publish ${f.title || l.slug} to the site?"><button class="btn brass" ${changed.length || !l.published ? '' : 'disabled'}>Publish the draft</button>${err}</form>
          ${l.review === 'submitted' ? html`<form data-api="${api}/return" data-then="reload" class="stack" style="margin-top:10px"><input name="note" placeholder="What to change" aria-label="Why it’s being sent back"><button class="btn sm">Send back</button>${err}</form>` : ''}
          ${l.published ? html`<form data-api="${api}/unpublish" data-then="reload" data-confirm="Take ${f.title || l.slug} off the site?" style="margin-top:10px"><button class="btn sm">Take off the site</button>${err}</form>` : ''}` : ''}
      </div>${h.isVaultAdmin(u) ? studioCard(s, l) : ''}`;
    return { form, side };
  }

  // A CDN game without a listing: offer to create one (linked).
  function createListingCard(u: User, s: Studio, g: Game): Html {
    if (!canEdit(u, s)) return html`<div class="card"><h2>Site listing</h2><p class="muted">Not on vaultlearninggames.org yet.</p></div>`;
    return html`<div class="card"><h2>Put it on the site</h2><form data-api="/portal/api/s/${s.slug}/listings" data-then="reload" class="inline-form">
      <input type="hidden" name="game" value="${g.slug}">
      <label class="field"><span class="lab">Title</span><input name="title" required autocomplete="off"></label>
      <label class="field"><span class="lab">Page address</span><input name="slug" required value="${g.slug}" pattern="[a-z0-9][a-z0-9-]*"></label>
      <button class="btn pri">Create listing</button>${err}</form></div>`;
  }

  // A listing without a CDN game: link one of the studio's unlinked CDN games (e.g. when names differ).
  function linkCard(u: User, s: Studio, l: ListingRow): Html {
    // Any of the studio's CDN games; a collection (e.g. The Yard) serves several site games from folders.
    const free = db.gamesForStudio(s.id);
    return html`<div class="card"><h2>Vault CDN</h2>
      <p class="muted">Not on the Vault CDN yet. It moves over when ${s.name}’s builds publish to Vault (<a href="/s/${s.slug}/register">set up</a>): a game published under the same name (<span class="mono">${l.slug}</span>) is connected automatically. Vault can also upload the version that’s live today.</p>
      ${free.length && canEdit(u, s) ? html`<form data-api="/portal/api/s/${s.slug}/listings/${l.slug}/link" data-then="reload" class="inline-form">
        <label class="field"><span class="lab">Or connect a CDN game (set its folder after, if it’s a collection)</span><select name="game">${free.map((g) => html`<option value="${g.slug}">${g.slug}</option>`)}</select></label>
        <button class="btn">Connect</button>${err}</form>` : ''}</div>`;
  }

  return { canEdit, canPublish, state, hosting, playCard, editor, createListingCard, linkCard };
}

export function registerListingPages(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const P = listingPieces(h);

  // Listings live on each game's page now.
  app.get('/s/:studio/listings', (c) => c.redirect(`/s/${c.req.param('studio')}`));
  app.get('/s/:studio/listings/:slug', (c) => c.redirect(`/s/${c.req.param('studio')}/g/${c.req.param('slug')}`));
  // Featured games and game availability are columns of the Game Catalog now.
  app.get('/vault/featured', (c) => c.redirect('/vault/listings'));
  app.get('/vault/availability', (c) => c.redirect('/vault/listings'));

  // ---------- Vault → Game Catalog: review queue, every game on the site (featured, availability) ----------
  app.get('/vault/listings', (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const all = db.listings();
    const gameOf = (l: ListingRow) => (l.game_id ? db.gameById(l.game_id) ?? null : null);
    const waiting = all.filter((l) => l.review === 'submitted');
    const onCdn = (l: ListingRow) => l.published?.play_source === 'cdn';
    const link = (l: ListingRow) => `/s/${l.studio_slug}/g/${l.slug}`;
    const queue = waiting.map((l) => html`<div class="card"><div class="card-h"><a href="${link(l)}"><b>${l.draft.title || l.slug}</b></a> <small>${l.studio_name} · submitted ${ago(l.submitted_at)} by ${who(l.submitted_by ?? '')}</small></div>
      <p class="small">Changes: ${changedFields(l.published, l.draft).map((k) => FIELD_LABEL[k]).join(', ') || 'none'}</p>
      ${proposedLine(db, l)}
      <div class="req-actions">
        <form data-api="/portal/api/s/${l.studio_slug}/listings/${l.slug}/publish" data-then="reload" data-confirm="Publish ${l.draft.title || l.slug} to the site?"><button class="btn brass">Publish</button>${err}</form>
        <form data-api="/portal/api/s/${l.studio_slug}/listings/${l.slug}/return" data-then="reload" class="inline-form"><input name="note" placeholder="Why it’s being sent back" aria-label="Why it’s being sent back"><button class="btn sm">Send back</button>${err}</form>
      </div></div>`);
    const count = (f: (l: ListingRow) => boolean) => all.filter(f).length;

    // Featured: a checkbox per game; a featured game gets a row below it with its sequence, blurb and image.
    const featuring = h.canRelease(u);
    const feat = readFeatured(db);
    const featBy = new Map(feat.games.map((e) => [e.slug, e]));
    const full = feat.games.length >= MAX_FEATURED;
    const FA = '/portal/api/vault/featured';
    const COLS = 9;
    const featCell = (l: ListingRow, e: FeaturedEntry | undefined) => {
      const title = l.draft.title || l.slug;
      const off = !l.published;
      const why = e ? '' : off ? 'Only games on the site can be featured' : full ? `${MAX_FEATURED} games are featured already` : '';
      const box = html`<input type="checkbox" name="featured" ${e ? 'checked' : ''} ${!featuring || why ? 'disabled' : ''} aria-label="Feature ${title} on the home page" title="${why}">`;
      const note = e && off ? html`<span class="err small">Off the site, so the home page skips it</span>` : '';
      // A featured game's editor row opens and closes like an accordion (portal.js); ticking the box opens it.
      const open = e ? html`<button type="button" class="feat-open" aria-expanded="false" aria-controls="feat-edit-${l.slug}" aria-label="${featuring ? 'Edit' : 'Show'} ${title}’s featured settings">${featuring ? 'Edit' : 'Details'}<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : '';
      return featuring
        ? html`<form data-api="${FA}" data-autosubmit data-then="reload" data-open-after="feat-edit-${l.slug}" class="feat-toggle"><input type="hidden" name="op" value="feature"><input type="hidden" name="slug" value="${l.slug}">
            <span class="feat-line"><label class="check">${box}${e ? html` <span class="mono small">#${e.sequence}</span>` : ''}</label>${open}</span>${note}${err}</form>`
        : html`<span class="feat-line"><label class="check">${box}${e ? html` <span class="mono small">#${e.sequence}</span>` : ''}</label>${open}</span>${note}`;
    };
    const imageOf = (e: FeaturedEntry) => (!e.image ? html`<span class="muted small">The listing’s hero image</span>`
      : /^https:\/\//.test(e.image) ? html`<a href="${e.image}" target="_blank" rel="noopener"><img class="feat-thumb" src="${e.image}" alt="Featured image"></a>`
      : html`<span class="mono small" title="A path on the site">${e.image}</span>`);
    const featRow = (l: ListingRow, e: FeaturedEntry) => {
      const shown = l.published ?? l.draft;
      if (!featuring) return html`<tr class="feat-edit" id="feat-edit-${l.slug}" hidden><td colspan="${COLS}"><div class="feat"><span class="small">Sequence <b class="mono">${e.sequence}</b></span>
        <span class="small">${e.blurb || html`<span class="muted">${shown.short_description || 'The listing’s short description'}</span>`}</span>${imageOf(e)}</div></td></tr>`;
      return html`<tr class="feat-edit" id="feat-edit-${l.slug}" hidden><td colspan="${COLS}"><div class="feat">
        <form data-api="${FA}" data-then="reload" class="feat-form"><input type="hidden" name="op" value="set"><input type="hidden" name="slug" value="${l.slug}">
          <label class="field seq"><span class="lab">Sequence</span><input type="number" name="sequence" value="${e.sequence}" min="0" max="9999" step="1" required></label>
          <label class="field blurb"><span class="lab">Home-page description (optional; *italics* work)</span><textarea name="blurb" rows="2" placeholder="${shown.short_description}">${e.blurb}</textarea></label>
          <button class="btn sm pri">Save</button>${err}</form>
        <div class="feat-img"><span class="lab">Home-page image</span>${imageOf(e)}
          ${h.deps.production ? html`<form data-upload="${FA}/${l.slug}/image" data-then="reload" class="inline-form"><input type="file" name="image" accept="image/png,image/jpeg,image/webp" required aria-label="Image for ${shown.title || l.slug}"><button class="btn sm">Upload</button>${err}</form>`
            : html`<span class="small muted">Uploads need the Vault CDN storage, which isn’t configured here.</span>`}
          ${e.image ? html`<form data-api="${FA}" data-then="reload" data-confirm="Use the listing’s hero image instead?"><input type="hidden" name="op" value="set"><input type="hidden" name="slug" value="${l.slug}"><input type="hidden" name="image" value=""><button class="btn sm">Remove image</button>${err}</form>` : ''}
        </div></div></td></tr>`;
    };

    // Availability: the latest check-games run's result for each game (its Testing Status).
    const run = db.gameCheck();
    // The previous default order: featured games first, in home-page order; then the rest by page address.
    // On top of it, the table leads with failures: Failure rows first, then Needs Review, then Passing; within
    // each status group the previous order is kept (each row's place in it is the tie-break, so it's stable).
    const bySlug = new Map(all.map((l) => [l.slug, l]));
    const titleOf = (slug: string) => { const l = bySlug.get(slug); return l ? (l.published ?? l.draft).title : undefined; };
    const first = sortFeatured(feat.games, titleOf).map((e) => bySlug.get(e.slug)).filter((l) => l !== undefined);
    const levelOf = (l: ListingRow) => run?.games.find((g) => g.slug === l.slug)?.level;
    const rows = [...first, ...all.filter((l) => !featBy.has(l.slug))]
      .map((l, i) => ({ l, i, status: deriveTestingStatus(levelOf(l)) }))
      .sort((a, b) => compareByTestingStatus(a.status, b.status) || a.i - b.i)
      .map(({ l }) => {
        const e = featBy.get(l.slug);
        return html`<tr id="game-${l.slug}" class="${e ? 'is-feat' : ''}"><td class="proj"><a href="${link(l)}"><b>${l.draft.title || l.slug}</b></a><span>${l.slug}</span></td>
          <td>${l.studio_name}</td><td>${P.state(l)}</td><td>${featCell(l, e)}</td><td>${P.hosting(l, gameOf(l))}</td>
          ${availabilityCells(run, l.slug)}<td class="small nowrap">${ago(l.updated_at)}</td></tr>${e ? featRow(l, e) : ''}`;
      });
    const checked = run ? html` Availability from the latest daily check, ${ago(run.checked_at)}: ${run.fail_count} failing, ${run.warn_count} worth a look (hover a result for why).` : ' No availability checks yet.';
    const sub = html`${count((l) => !!l.published)} of ${all.length} games are on the site; ${count(onCdn)} play from the Vault CDN. ${feat.games.length} of at most ${MAX_FEATURED} are featured on the home page, in ascending sequence (ties by title). Rows are in Testing Status order — Failure first, then Needs Review, then Passing — and within each group, featured games keep that order, then the rest by page address.${checked} The site is built from /v1/catalog.`;
    const actions = html`<a class="btn" href="https://github.com/${h.deps.adminRepository}/actions/workflows/check-games.yml" target="_blank" rel="noopener">Run a check ↗</a><a class="btn" href="/v1/catalog" target="_blank">Catalog JSON ↗</a>`;
    const body = html`${head('Game Catalog', sub, actions)}
      ${queue.length ? html`<h2>Waiting for Vault (${queue.length})</h2><div class="grid">${queue}</div>` : html`<div class="card"><p class="muted">No site changes are waiting for review.</p></div>`}
      <div class="tbl-wrap" style="margin-top:22px"><table class="site-games"><thead><tr><th>Game</th><th>Studio</th><th>Site</th><th>Featured</th><th>Hosted by</th>${AVAILABILITY_HEADS}<th>Last edit</th></tr></thead>
        <tbody>${rows.length ? rows : html`<tr><td colspan="${COLS}" class="muted">No games yet.</td></tr>`}</tbody></table></div>
      ${featuring ? '' : html`<p class="small muted">Only Vault release managers can change the featured games.</p>`}`;
    return h.page(c, 'Game Catalog', body, { active: 'vault-listings' });
  });

  // ---------- API ----------
  function apiListing(c: Context, u: User) {
    const s = db.studioBySlug(c.req.param('studio') ?? '');
    if (!s || !(h.isStaff(u) || h.roleIn(u, s))) fail(404, 'unknown studio');
    const l = db.listing(c.req.param('slug') ?? '');
    if (!l || l.studio_id !== s.id) fail(404, 'unknown listing');
    return { s, l };
  }
  app.post('/portal/api/s/:studio/listings', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !P.canEdit(u, s)) fail(403, 'Only studio maintainers, admins and Vault staff can add games to the site.');
    const b = await jsonBody(c);
    const slug = String(b.slug ?? '').trim().toLowerCase();
    if (!isListingSlug(slug)) fail(400, 'The page address can use lowercase letters, numbers and dashes.');
    if (db.listing(slug)) fail(409, `vaultlearninggames.org/games/${slug}/ is already taken.`);
    const draft = normalize({ title: b.title, makers: [s.name] });
    if (!draft.title) fail(400, 'Add a title.');
    let game: Game | undefined;
    if (b.game) {
      game = db.game(s.id, String(b.game));
      if (!game) fail(404, 'unknown CDN game');
    }
    const l = db.createListing(s.id, slug, draft, h.actor(u));
    if (game) db.linkListing(l.id, game.id);
    db.audit(h.actor(u), 'listing.create', `${s.slug}:${slug}`, game ? { game: game.slug } : undefined);
    return c.json({ ok: true, url: `/s/${s.slug}/g/${slug}` });
  });

  app.post('/portal/api/s/:studio/listings/:slug', async (c) => {
    const u = h.apiUser(c);
    const { s, l } = apiListing(c, u);
    if (!P.canEdit(u, s)) fail(403, 'Only studio maintainers, admins and Vault staff can edit site listings.');
    const b = await jsonBody(c);
    if (typeof b.embed === 'string') b.embed = b.embed === 'true';
    if (!P.canPublish(u)) delete b.fit;                         // player fit is Vault's call
    const draft = normalize(b, l.draft);
    const flag = (v: unknown) => v === true || v === '1' || v === 'on';
    const wantsPublish = flag(b.publish) && P.canPublish(u);
    // Studio saves always go to Vault for review; Vault staff save and publish in one step.
    const wantsSubmit = !wantsPublish && !P.canPublish(u);
    const bad = draftProblems(db, l, draft, wantsPublish || wantsSubmit);
    if (bad.length) fail(400, bad.join(' '));
    // A name left in "Made by"’s "Add a new studio…" fields is added with the save (listing-makers.ts).
    if (typeof b.maker_new_name === 'string' && b.maker_new_name.trim()) {
      const added = addMaker(h, u, s, l, b.maker_new_name, b.maker_new_website).name;
      if (!draft.makers.includes(added)) draft.makers.push(added);
    }
    pruneMakerProposals(db, l.slug, draft.makers);
    if (wantsPublish) createProposedStudios(db, h.actor(u), l.slug, draft.makers);
    saveListing(db, l, draft, h.actor(u), wantsPublish ? 'publish' : wantsSubmit ? 'submit' : 'save');
    return c.json({ ok: true });
  });

  // Connect (or disconnect, with game: "") the CDN game that hosts a listing on the Vault.
  app.post('/portal/api/s/:studio/listings/:slug/link', async (c) => {
    const u = h.apiUser(c);
    const { s, l } = apiListing(c, u);
    if (!P.canEdit(u, s)) fail(403, 'Only studio maintainers, admins and Vault staff can connect games.');
    const slug = String((await jsonBody(c)).game ?? '');
    if (!slug) {
      if (l.published?.play_source === 'cdn' || l.draft.play_source === 'cdn') fail(400, 'Switch it back to its web address first.');
      db.linkListing(l.id, null);
    } else {
      const g = db.game(s.id, slug);
      if (!g) fail(404, 'unknown CDN game');
      db.linkListing(l.id, g.id);
    }
    db.audit(h.actor(u), 'listing.link', `${s.slug}:${l.slug}`, { game: slug || null });
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/listings/:slug/publish', async (c) => {
    const u = h.apiUser(c);
    if (!P.canPublish(u)) fail(403, 'Only Vault release managers can publish to the site.');
    const { l } = apiListing(c, u);
    const bad = draftProblems(db, l, l.draft, true);
    if (bad.length) fail(400, bad.join(' '));
    createProposedStudios(db, h.actor(u), l.slug, l.draft.makers);
    publishListing(db, l, h.actor(u));
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/listings/:slug/return', async (c) => {
    const u = h.apiUser(c);
    if (!P.canPublish(u)) fail(403, 'Only Vault release managers can send changes back.');
    const { s, l } = apiListing(c, u);
    const note = String((await jsonBody(c)).note ?? '').trim().slice(0, 500);
    if (!note) fail(400, 'Say what should change.');
    db.setListingReview(l.id, 'returned', h.actor(u), note);
    db.audit(h.actor(u), 'listing.return', `${s.slug}:${l.slug}`, { note });
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/listings/:slug/unpublish', async (c) => {
    const u = h.apiUser(c);
    if (!P.canPublish(u)) fail(403, 'Only Vault release managers can take games off the site.');
    const { s, l } = apiListing(c, u);
    db.unpublishListing(l.id);
    db.audit(h.actor(u), 'listing.unpublish', `${s.slug}:${l.slug}`);
    return c.json({ ok: true });
  });

  // Vault admins: move a listing to another studio.
  app.post('/portal/api/s/:studio/listings/:slug/studio', async (c) => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can move games between studios.');
    const { s, l } = apiListing(c, u);
    const to = db.studioBySlug(String((await jsonBody(c)).studio ?? ''));
    if (!to) fail(404, 'Choose a studio.');
    moveListingToStudio(db, l, s, to, h.actor(u));
    return c.json({ ok: true, url: `/s/${to.slug}/g/${l.slug}` });
  });

  // Vault admins: the one-time import of the Hugo prototype's game pages (../listings-import.ts). It has no form in
  // the portal; Body: { pages, overrides? }, each the JSON itself or its text.
  app.post('/portal/api/vault/listings/import', async (c) => {
    const u = h.apiUser(c);
    if (!h.isVaultAdmin(u)) fail(403, 'Only Vault admins can import listings.');
    const b = await jsonBody(c);
    return c.json({ ok: true, ...importFromExport(db, b.pages, b.overrides, h.actor(u)) });
  });
}

