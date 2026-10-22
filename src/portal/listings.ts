// Site listings: what vaultlearninggames.org shows for each game, edited on the game's page in the portal.
// A game in the portal is its site listing and/or its CDN game (builds and releases), linked together:
//   - Games already on the site that are hosted at a web address have only a listing until they move to the CDN.
//   - A listing is hosted on the Vault CDN once its linked CDN game has a current release.
// Studios edit a listing's draft; Vault publishes it. The site is built from GET /v1/catalog (published listings).
import type { Context, Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import type { Db, Game, Listing, Studio, User } from '../db.ts';
import type { StudioPermission, VaultPermission } from '../permissions.ts';
import { markDeployPending } from '../deploy-status.ts';
import { draftProblems, importFromExport, moveListingToStudio, publishListing, saveListing } from '../listing-ops.ts';
import { changedFields, FIELD_LABEL, GRADES, inheritedListing, isListingSlug, MIN_SIZE_RANGE, normalize, VAULT_ONLY, type ListingFields } from '../listings.ts';
import { GRADES as GRADE_OPTIONS, SUBJECTS, TOPICS, studioOptions, type CardTag, type CardTagKind, type EnumOption } from './listing-enums.ts';
import { getHosting, hostingCell } from './hosting.ts';
import { html, type Html } from './html.ts';
import { ago, head, pill, who } from './routes.ts';
import { availabilityCells, availabilityLine, AVAILABILITY_HEADS } from './availability.ts';
import { compareByTestingStatus, deriveTestingStatus } from './testingStatus.ts';
import { MAX_FEATURED, readFeatured, sortFeatured, type FeaturedEntry } from '../featured.ts';
import type { PortalDeps } from './routes.ts';
import { imageField, imageToolScript } from './listing-assets.ts';
import { iconPicker, layoutIcon, PAGE_LAYOUTS } from './listing-layout.ts';
import { previewButtons, saveControls } from './listing-preview.ts';
import { requestSiteRebuild } from './site-rebuild.ts';
import { cdnRedirectNote, unpublishedWarning } from './unpublished-warning.ts';
import { addMaker, createProposedStudios, makersField, proposedLine, pruneMakerProposals } from './listing-makers.ts';

// "Smallest screen" (min_width × min_height): editable by Vault, shown read-only to the studio. Empty: the site default.
function minSizeField(f: ListingFields, editable: boolean): Html {
  const dis = editable ? '' : 'disabled';
  const num = (name: 'min_width' | 'min_height', label: string) => html`<input type="number" name="${name}" inputmode="numeric" min="${MIN_SIZE_RANGE.min}" max="${MIN_SIZE_RANGE.max}" step="1" value="${f[name] ?? ''}" placeholder="default" aria-label="${label}" ${dis} style="width:7.5em">`;
  return html`<div class="field"><span class="lab">Smallest play area${editable ? ' (Vault)' : ''}</span>
    <span class="inline-form">${num('min_width', 'Minimum play width in pixels')} × ${num('min_height', 'Minimum play height in pixels')} px</span>
    <span class="hint">The smallest space (width × height, below Vault’s player bar) the game is playable in. On a smaller screen Play says what’s needed and offers to try anyway. Empty: the site’s default.${editable ? '' : ' Set by Vault; ask Vault to change it.'}</span></div>`;
}

// A hero image's address for the Game Catalog's thumbnail: an http(s) URL or a root-relative path, trimmed;
// anything else (empty, "//host", javascript:, data:, a bare site path) is null, and the row gets a grey box.
export function heroThumbSrc(value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\//.test(v) || (v.startsWith('/') && !v.startsWith('//')) ? v : null;
}

export function heroThumb(value: string | null | undefined): Html {
  const src = heroThumbSrc(value);
  return src
    ? html`<img src="${src}" alt="" width="64" height="36" loading="lazy" decoding="async" class="catalog-hero-thumb">`
    : html`<span class="catalog-hero-placeholder" aria-hidden="true"></span>`;
}

export interface ListingHelpers {
  db: Db;
  deps: PortalDeps;
  page(c: Context, title: string, body: Html, opts?: { studio?: Studio; active?: string; status?: number }): Response | Promise<Response>;
  denied(c: Context, message: string, status?: number): Response | Promise<Response>;
  signedIn(c: Context): User | Response;
  studioFor(c: Context, u: User): Studio | Response;
  apiUser(c: Context): User;
  actor(u: User): string;
  // Permissions (permissions.ts): anyone with a Vault permission; studio.view in the studio; one permission.
  isStaff(u: User): boolean;
  isMember(u: User, s: Studio): boolean;
  vaultCan(u: User, p: VaultPermission): boolean;
  studioCan(u: User, s: Studio, p: StudioPermission): boolean;
}
export type ListingRow = Listing & { studio_slug: string; studio_name: string };

const err = html`<span class="err" role="status" aria-live="polite"></span>`;

export function listingPieces(h: ListingHelpers) {
  const { db } = h;
  // studio.edit edits the studio's listings; vault.content.edit edits any, and is the only way onto the site.
  // studio.request_publish submits the studio's changes to Vault.
  const canEdit = (u: User, s: Studio) => h.vaultCan(u, 'vault.content.edit') || h.studioCan(u, s, 'studio.edit');
  const canPublish = (u: User) => h.vaultCan(u, 'vault.content.edit');
  const canSubmit = (u: User, s: Studio) => !canPublish(u) && h.studioCan(u, s, 'studio.request_publish');
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
      status = html`<p>${pill('brass', 'Vault CDN')} Classrooms play release <b class="mono">${cur!.version}</b> from <a class="mono" href="${cdnUrl(s, g!)}${pub!.cdn_path}" target="_blank" rel="noopener">${cdnUrl(s, g!)}${pub!.cdn_path}</a>.<br>${cdnRedirectNote()}</p>`;
      next = action('url', 'Switch back to the web address', `Play ${f!.title || l.slug} from ${pub!.play_url || 'its web address'} again?`);
    } else {
      status = html`<p>${pill('off', 'Web address')} Classrooms play ${pub?.play_url ? html`<a class="mono" href="${pub.play_url}" target="_blank" rel="noopener">${pub.play_url}</a>` : html`<span class="muted">nothing yet (not published)</span>`} in Vault’s player.</p>`;
      if (cur) next = html`<p class="small">Release <b class="mono">${cur.version}</b> is ready on the Vault CDN.</p>${action('cdn', vault ? `Switch to the Vault CDN (${cur.version})` : `Ask Vault to switch to the CDN (${cur.version})`, `Play ${f!.title || l.slug} from the Vault CDN (${cur.version})?${vault ? ' The site shows this after its next build.' : ''}`)}`;
      else if (g) next = html`<p class="small muted">On the Vault CDN, but nothing is released yet. Release a test version below; then it can switch.</p>`;
      else next = html`<p class="small muted">Not on the Vault CDN yet. It moves over when ${s.name}’s builds publish to Vault (<a href="/s/${s.slug}/register">set up</a>), or when Vault uploads its current version.</p>`;
    }
    const waiting = l && l.review === 'submitted' ? html`<p class="small">${pill('wait', 'Waiting for Vault')} ${changedFields(l.published, l.draft).map((k) => FIELD_LABEL[k]).join(', ')}</p>` : '';
    const checked = pub ? availabilityLine(db, l!.slug, h.isStaff(u)) : '';
    const unpub = !pub && g && cur ? html`<p>${unpublishedWarning(l, 'cdn')} The Vault CDN address ${cdnUrl(s, g)} is affected.</p>` : '';
    return html`<div class="card"><h2>Where it plays</h2>${status}${checked}${waiting}${unpub}${next}</div>`;
  }

  // The listing editor (draft) and its status card.
  // vault.content.edit: which studio a game belongs to (whose members edit it, and the studio shown on the site).
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
    // The game card (card C): its title and excerpt, and its categories and tags as chip pickers over the portal's
    // option lists (listing-enums.ts) — the site's filters read those. The title and excerpt are inherited (card G):
    // empty, in a closed disclosure, with the title / short description as the placeholder — a copy of the inherited
    // value shows as empty too, so a save never stores it (inheritedListing) and renaming the game renames its card.
    const own = (v: string, inherited: string) => (v && v !== inherited ? v : '');
    const custom = !!(own(f.card_title, f.title) || own(f.card_excerpt, f.short_description));
    const cardText = html`<details class="full disclose">
        <summary>Card text (optional)${custom ? ' — has its own text' : ''}</summary>
        <div class="fields">
          <label class="field"><span class="lab">Card title</span>
            <input type="text" name="card_title" value="${own(f.card_title, f.title)}" placeholder="${f.title}" ${dis}>
            <span class="hint">Shown on the game card. Empty: the title.</span></label>
          <label class="field full"><span class="lab">Card excerpt</span>
            <textarea name="card_excerpt" rows="2" placeholder="${f.short_description}" ${dis}>${own(f.card_excerpt, f.short_description)}</textarea>
            <span class="hint">One or two sentences under the card title. Empty: the short description.</span></label>
        </div></details>`;
    const tagChips = (field: 'card_categories' | 'card_tags', kind: CardTagKind, label: string, opts: EnumOption[]) => html`<div class="field full"><span class="lab">${label}</span>
      <div class="chips">${opts.map((o) => html`<label><input type="checkbox" name="${field}:${kind}:${o.value}" ${f[field].some((t) => t.kind === kind && t.value === o.value) ? 'checked' : ''} ${dis}> ${o.label}</label>`)}</div></div>`;
    const cardSection = html`<h2 style="margin-top:18px">Site card</h2>
      <p class="small muted">The game’s card on the Games page: the title and the excerpt under it, and the categories and tags the site’s filters read. The card’s image is the thumbnail. A field left empty falls back to the title or the short description.</p>
      <div class="fields">
        ${cardText}
        ${tagChips('card_categories', 'grade', 'Grades', GRADE_OPTIONS)}
        ${tagChips('card_categories', 'studio', 'Developer (studio)', studioOptions(db))}
        ${tagChips('card_tags', 'subject', 'Subjects', SUBJECTS)}
        ${tagChips('card_tags', 'topic', 'Topics', TOPICS)}
      </div>`;
    // Search (card C): the title and description search engines show, with a character counter; empty falls back.
    const counter = (id: string, max: number) => html`<span class="char-count" id="${id}-count" aria-hidden="true"></span>`;
    const seoSection = html`<h2 style="margin-top:18px">Search (SEO)</h2>
      <div class="fields">
        <label class="field"><span class="lab">SEO title</span>
          <input type="text" id="f-seo-title" name="seo_title" value="${f.seo_title}" data-count="${60}" ${dis} autocomplete="off">
          <span class="hint">What search engines show for the game. Empty: the title. ${counter('f-seo-title', 60)}</span></label>
        <label class="field"><span class="lab">SEO description</span>
          <input type="text" id="f-seo-description" name="seo_description" value="${f.seo_description}" data-count="${160}" ${dis} autocomplete="off">
          <span class="hint">The snippet under the title. Empty: the short description. ${counter('f-seo-description', 160)}</span></label>
      </div>`;
    // The game's page on the site (card C): the page address (default: the slug) and the old addresses that 301 to
    // it — Vault staff only, so a studio's save can never move or shadow another game's page. The listing's date is
    // the record's created date, the site's newest-first sort; studios see it read-only.
    const addressSection = html`<h2 style="margin-top:18px">Site address</h2>
      <p class="small">The page the site builds for this game: vaultlearninggames.org/games/<i>${f.page_address || l.slug}</i>/. Old addresses (aliases) send visitors there with a 301, so every old URL keeps working.</p>
      ${vault ? html`<div class="fields">
        <label class="field"><span class="lab">Page address</span>
          <input type="text" name="page_address" value="${f.page_address}" pattern="[a-z0-9][a-z0-9-]*" placeholder="${l.slug}" ${dis} autocomplete="off" spellcheck="false">
          <span class="hint">Empty: the slug (${l.slug}). The old address becomes an alias, if you want it to keep working.</span></label>
        <label class="field full"><span class="lab">Aliases</span>
          <textarea name="aliases" rows="3" ${dis} spellcheck="false">${f.aliases.join('\n')}</textarea>
          <span class="hint">One old address per line (lowercase letters, numbers and dashes, or an old game-cards/ address); each sends its visitors to the page address.</span></label>
      </div>` : html`<p class="small">Page address: <b class="mono">${f.page_address || l.slug}</b>${f.aliases.length ? html` — old addresses (301): ${f.aliases.map((a) => html`<span class="mono">${a}</span> `)}` : ''}. Only Vault staff can change the address.</p>`}
      <label class="field"><span class="lab">Listing date</span>
        <input type="date" name="created_at" value="${l.created_at.slice(0, 10)}" ${vault ? dis : 'disabled'} style="width:11em">
        <span class="hint">The date the site sorts the cards newest-first (the record’s created date).${vault ? '' : ' Only Vault staff can change it.'}</span></label>`;
    // The player's plumbing (card G), not design choices: the CDN folder (folded into the play address before the
    // site sees it), the player fit and the smallest play area, in a closed disclosure.
    const geometry = html`<details class="full disclose">
        <summary>Player geometry (Vault staff)</summary>
        <div class="fields">
          ${g ? txt('cdn_path', 'CDN folder', `Optional folder inside ${s.slug}/${g.slug}/, e.g. earthquake/ for one game of a collection.`) : ''}
          ${vault ? txt('fit', 'Player fit (Vault)', 'For fixed-size games: page width, page height, x, y, width, height of the game on that page.') : ''}
          ${minSizeField(f, vault && edit)}
        </div></details>`;
    const form = html`<form data-api="${api}" data-then="reload" class="card form-card">
      <h2>Site listing <small>vaultlearninggames.org/games/${l.slug}/</small></h2>
      ${l.published ? '' : html`<p>${unpublishedWarning(l, 'site')}</p>`}
      <div class="fields">
        ${txt('title', 'Title', '', 'required')}
        ${makersField(db, { api, edit, staff: h.isStaff(u), studio: s, listing: l })}
        ${area('short_description', 'Short description', 'One or two sentences, shown on the game card.', 2)}
        ${area('about', 'About this game', '', 6)}
        <div class="field full"><span class="lab">Grades</span><div class="chips">${GRADES.map((gr) => html`<label><input type="checkbox" name="grades:${gr}" ${f.grades.includes(gr) ? 'checked' : ''} ${dis}> ${gr.replace('Grades ', '')}</label>`)}</div></div>
        ${txt('subjects', 'Subjects', 'Comma-separated, e.g. Math, Science')}
        ${txt('topics', 'Topics', 'Comma-separated, e.g. Algebra, Physics')}
        ${area('standards', 'Standards', 'Codes, one per line or comma-separated (Common Core, NGSS), e.g. 4.OA.A.2', 2)}
        ${txt('related_curriculum', 'Related curriculum', 'A link to teacher materials. When it is empty the game’s page says there is no curriculum yet and invites teachers to share one with the Vault (no email address is shown).')}
        ${txt('gameplay_video', 'Gameplay video', 'A YouTube or other video link')}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'thumb_image', label: 'Thumbnail', value: f.thumb_image, hint: 'The game card’s image (16:9). A path on the site or an https link.' })}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'screenshots', label: 'Screenshots', value: f.screenshots, hint: 'One path or link per line, in the order the site shows them; delete a line to remove it.' })}
        ${edit && h.deps.production ? imageToolScript() : ''}
      </div>
      ${cardSection}
      ${seoSection}
      <h2 style="margin-top:18px">Page design</h2>
      <div class="fields">
        ${iconPicker({ name: 'page_layout', label: 'Page layout', value: f.page_layout, disabled: !edit,
          hint: 'Hero pages are dark; Standard pages are light.',
          options: PAGE_LAYOUTS.map((v) => ({ value: v, caption: v === 'hero' ? 'Hero' : 'Standard', icon: layoutIcon(v) })) })}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'hero_image', label: 'Hero image', value: f.hero_image, hint: 'A path on the site (games/x/img/hero.png) or an https link.' })}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'hero_background', label: 'Hero background', value: f.hero_background ?? '', hint: 'For the Hero layout: a full-width background (21:9). The Hero layout uses the hero background if set, otherwise the hero image.' })}
        ${imageField({ api, edit, canUpload: !!h.deps.production, name: 'logo_image', label: 'Logo art', value: f.logo_image ?? '', hint: 'For the Hero layout: the game’s logo, with transparency (any shape).' })}
      </div>
      <h2 style="margin-top:18px">Playing</h2>
      <div class="fields">
        <div class="field full"><span class="lab">Hosted by</span>
          <label class="check"><input type="radio" name="play_source" value="url" ${f.play_source === 'url' ? 'checked' : ''} ${dis}> Its web address, shown in Vault’s player</label>
          <label class="check"><input type="radio" name="play_source" value="cdn" ${f.play_source === 'cdn' ? 'checked' : ''} ${cur ? dis : 'disabled'}> The Vault CDN: ${g ? html`<span class="mono">${s.slug}/${g.slug}</span>, ${cur ? html`currently <b class="mono">${cur.version}</b>` : 'nothing released yet'}` : 'no CDN game yet'}</label></div>
        ${txt('play_url', 'Web address', 'The page that shows only the game (what Vault’s player wraps). Also the fallback if the CDN game has no release.')}
        <label class="field"><span class="lab">Opens in</span><select name="embed" ${dis}>
          <option value="true" ${f.embed ? 'selected' : ''}>Vault’s player (the game’s page allows framing)</option>
          <option value="false" ${f.embed ? '' : 'selected'}>A new tab (the game’s page refuses to be framed)</option></select></label>
        ${geometry}
      </div>
      ${addressSection}
      ${edit ? html`<div class="form-foot">${saveControls(vault, l, canSubmit(u, s))}${previewButtons(api, h.deps.previewSites)}${err}</div>` : ''}
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
      </div>${canPublish(u) ? studioCard(s, l) : ''}`;
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

  return { canEdit, canPublish, canSubmit, state, hosting, playCard, editor, createListingCard, linkCard };
}

export function registerListingPages(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const P = listingPieces(h);

  // Listings live on each game's page now.
  app.get('/s/:studio/listings', (c) => c.redirect(`/s/${c.req.param('studio')}`));
  app.get('/s/:studio/listings/:slug', (c) => c.redirect(`/s/${c.req.param('studio')}/g/${c.req.param('slug')}`));
  // Featured games and game availability are columns of Vault → Games now.
  app.get('/vault/featured', (c) => c.redirect('/vault/listings'));
  app.get('/vault/availability', (c) => c.redirect('/vault/listings'));

  // ---------- Vault → Games: review queue, every game on the site (featured, availability) ----------
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
    const featuring = h.vaultCan(u, 'vault.content.edit');
    const feat = readFeatured(db);
    const featBy = new Map(feat.games.map((e) => [e.slug, e]));
    const full = feat.games.length >= MAX_FEATURED;
    const FA = '/portal/api/vault/featured';
    const COLS = 7;
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
        return html`<tr id="game-${l.slug}" class="${e ? 'is-feat' : ''}"><td class="catalog-thumb">${heroThumb(l.draft.hero_image)}</td><td class="proj"><a href="${link(l)}"><b>${l.draft.title || l.slug}</b></a><span>${l.slug}</span></td>
          <td>${l.studio_name}</td><td>${featCell(l, e)}</td><td>${P.hosting(l, gameOf(l))}</td>
          ${availabilityCells(run, l.slug)}<td class="small nowrap">${ago(l.updated_at)}</td></tr>${e ? featRow(l, e) : ''}`;
      });
    const checked = run ? html` Availability from the latest daily check, ${ago(run.checked_at)}: ${run.fail_count} failing, ${run.warn_count} worth a look (hover a result for why).` : ' No availability checks yet.';
    const sub = html`${count((l) => !!l.published)} of ${all.length} games are on the site; ${count(onCdn)} play from the Vault CDN. ${feat.games.length} of at most ${MAX_FEATURED} are featured on the home page, in ascending sequence (ties by title). Rows are in Testing Status order — Failure first, then Needs Review, then Passing — and within each group, featured games keep that order, then the rest by page address.${checked} The site is built from /v1/catalog.`;
    const actions = html`<a class="btn" href="https://github.com/${h.deps.adminRepository}/actions/workflows/check-games.yml" target="_blank" rel="noopener">Run a check ↗</a><a class="btn" href="/v1/catalog" target="_blank">Catalog JSON ↗</a><button type="button" class="btn pri" data-open="add-game">Add Game</button>`;
    // Add Game: a new site listing (draft) in any studio, the same as a studio's "Put it on the site".
    const studios = db.studios().sort((a, b) => a.name.localeCompare(b.name));
    const addGame = html`<dialog id="add-game"><form data-api="/portal/api/vault/listings" class="dlg" data-then="reload">
        <h2>Add Game</h2>
        <p class="small">Adds a draft listing for the site. Its studio’s members can edit it; it shows on the site once Vault publishes it.</p>
        <label class="field"><span class="lab">Title</span><input name="title" required autocomplete="off"></label>
        <label class="field"><span class="lab">Page address</span><input name="slug" required pattern="[a-z0-9][a-z0-9-]*" autocomplete="off" spellcheck="false"><span class="hint">vaultlearninggames.org/games/<i>address</i>/: lowercase letters, numbers and dashes.</span></label>
        <label class="field"><span class="lab">Studio</span><select name="studio" required><option value="">Choose a studio…</option>${studios.map((s) => html`<option value="${s.slug}">${s.name}</option>`)}</select></label>
        <div class="dlg-foot"><span class="err" role="status" aria-live="polite"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn pri">Add Game</button></div>
      </form></dialog>`;
    const body = html`${head('Games', sub, actions)}
      ${queue.length ? html`<h2>Waiting for Vault (${queue.length})</h2><div class="grid">${queue}</div>` : html`<div class="card"><p class="muted">No site changes are waiting for review.</p></div>`}
      <div class="tbl-wrap" style="margin-top:22px"><table class="site-games"><thead><tr><th scope="col" class="catalog-thumb">Image</th><th>Game</th><th>Studio</th><th>Featured</th><th>Hosted by</th>${AVAILABILITY_HEADS}<th>Last edit</th></tr></thead>
        <tbody>${rows.length ? rows : html`<tr><td colspan="${COLS}" class="muted">No games yet.</td></tr>`}</tbody></table></div>
      ${featuring ? '' : html`<p class="small muted">Only Vault staff who can edit game/studio content can change the featured games.</p>`}${addGame}`;
    return h.page(c, 'Games', body, { active: 'vault-listings' });
  });

  // ---------- API ----------
  function apiListing(c: Context, u: User) {
    const s = db.studioBySlug(c.req.param('studio') ?? '');
    if (!s || !(h.isStaff(u) || h.isMember(u, s))) fail(404, 'unknown studio');
    const l = db.listing(c.req.param('slug') ?? '');
    if (!l || l.studio_id !== s.id) fail(404, 'unknown listing');
    return { s, l };
  }
  // A new listing (a draft, optionally linked to one of the studio's CDN games).
  function createListing(u: User, s: Studio, b: Record<string, unknown>) {
    const slug = String(b.slug ?? '').trim().toLowerCase();
    if (!isListingSlug(slug)) fail(400, 'The page address can use lowercase letters, numbers and dashes.');
    if (db.listing(slug)) fail(409, `vaultlearninggames.org/games/${slug}/ is already taken.`);
    // The new game's page must not land on another game's page address or one of its aliases (card C).
    const clash = db.listings().find((x) => (x.draft.page_address || '') === slug || (x.draft.aliases ?? []).includes(slug));
    if (clash) fail(409, `That address is already used by ${clash.slug} (its page address or an alias).`);
    const draft = inheritedListing(normalize({ title: b.title, makers: [s.name] }));
    if (!draft.title) fail(400, 'Add a title.');
    let game: Game | undefined;
    if (b.game) {
      game = db.game(s.id, String(b.game));
      if (!game) fail(404, 'unknown CDN game');
    }
    const l = db.createListing(s.id, slug, draft, h.actor(u));
    if (game) db.linkListing(l.id, game.id);
    db.audit(h.actor(u), 'listing.create', `${s.slug}:${slug}`, game ? { game: game.slug } : undefined);
    return { slug, url: `/s/${s.slug}/g/${slug}` };
  }
  app.post('/portal/api/s/:studio/listings', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    if (!s || !P.canEdit(u, s)) fail(403, 'Only studio members who can edit, and Vault staff who can edit game/studio content, can add games to the site.');
    return c.json({ ok: true, url: createListing(u, s, await jsonBody(c)).url });
  });
  // Vault → Games' "Add Game": the same, with the studio in the body. Vault staff only, like the page.
  app.post('/portal/api/vault/listings', async (c) => {
    const u = h.apiUser(c);
    if (!h.isStaff(u)) fail(403, 'Only Vault staff can add games here.');
    const b = await jsonBody(c);
    const s = db.studioBySlug(String(b.studio ?? ''));
    if (!s) fail(400, 'Choose a studio.');
    const made = createListing(u, s, b);
    return c.json({ ok: true, ...made }, 201);
  });

  app.post('/portal/api/s/:studio/listings/:slug', async (c) => {
    const u = h.apiUser(c);
    const { s, l } = apiListing(c, u);
    if (!P.canEdit(u, s)) fail(403, 'Only studio members who can edit, and Vault staff who can edit game/studio content, can edit site listings.');
    const b = await jsonBody(c);
    if (typeof b.embed === 'string') b.embed = b.embed === 'true';
    if (!P.canPublish(u)) for (const k of VAULT_ONLY) delete b[k];  // player fit, size and the page address/aliases are Vault's call
    // The listing's date (the record's created date; the site's newest-first sort) is Vault staff only: a studio's
    // save — even a crafted one — can never re-sort the site.
    let listingDate: string | null = null;
    if (h.isStaff(u) && b.created_at !== undefined && b.created_at !== null && String(b.created_at).trim() !== '') {
      const d = String(b.created_at).trim();
      if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(d) || Number.isNaN(Date.parse(d))) fail(400, 'The listing date must be a date like 2026-10-21.');
      listingDate = new Date(Date.parse(d)).toISOString();
    } else delete b.created_at;
    // The theme follows the layout and inherited card text is stored empty, whatever was sent (card G).
    const draft = inheritedListing(normalize(b, l.draft));
    const flag = (v: unknown) => v === true || v === '1' || v === 'on';
    const wantsPublish = flag(b.publish) && P.canPublish(u);
    // Studio saves go to Vault for review when the member can request publish (else they stay a draft); Vault staff
    // save and publish in one step.
    const wantsSubmit = !wantsPublish && P.canSubmit(u, s);
    const bad = draftProblems(db, l, draft, wantsPublish || wantsSubmit, h.deps.prodPublicUrl);
    if (bad.length) fail(400, bad.join(' '));
    // A name left in "Made by"’s "Add a new studio…" fields is added with the save (listing-makers.ts).
    if (typeof b.maker_new_name === 'string' && b.maker_new_name.trim()) {
      const added = addMaker(h, u, s, l, b.maker_new_name, b.maker_new_website).name;
      if (!draft.makers.includes(added)) draft.makers.push(added);
    }
    pruneMakerProposals(db, l.slug, draft.makers);
    if (wantsPublish) createProposedStudios(db, h.actor(u), l.slug, draft.makers);
    saveListing(db, l, draft, h.actor(u), wantsPublish ? 'publish' : wantsSubmit ? 'submit' : 'save');
    if (listingDate && l.created_at !== listingDate) {
      db.setListingDate(l.id, listingDate);
      db.audit(h.actor(u), 'listing.date', `${s.slug}:${l.slug}`, { from: l.created_at, to: listingDate });
    }
    return c.json({ ok: true });
  });

  // Connect (or disconnect, with game: "") the CDN game that hosts a listing on the Vault.
  app.post('/portal/api/s/:studio/listings/:slug/link', async (c) => {
    const u = h.apiUser(c);
    const { s, l } = apiListing(c, u);
    if (!P.canEdit(u, s)) fail(403, 'Only studio members who can edit, and Vault staff who can edit game/studio content, can connect games.');
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
    if (!P.canPublish(u)) fail(403, 'Only Vault staff who can edit game/studio content can publish to the site.');
    const { l } = apiListing(c, u);
    const bad = draftProblems(db, l, l.draft, true, h.deps.prodPublicUrl);
    if (bad.length) fail(400, bad.join(' '));
    createProposedStudios(db, h.actor(u), l.slug, l.draft.makers);
    publishListing(db, l, h.actor(u), h.deps.prodPublicUrl);
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/listings/:slug/return', async (c) => {
    const u = h.apiUser(c);
    if (!P.canPublish(u)) fail(403, 'Only Vault staff who can edit game/studio content can send changes back.');
    const { s, l } = apiListing(c, u);
    const note = String((await jsonBody(c)).note ?? '').trim().slice(0, 500);
    if (!note) fail(400, 'Say what should change.');
    db.setListingReview(l.id, 'returned', h.actor(u), note);
    db.audit(h.actor(u), 'listing.return', `${s.slug}:${l.slug}`, { note });
    return c.json({ ok: true });
  });

  app.post('/portal/api/s/:studio/listings/:slug/unpublish', async (c) => {
    const u = h.apiUser(c);
    if (!P.canPublish(u)) fail(403, 'Only Vault staff who can edit game/studio content can take games off the site.');
    const { s, l } = apiListing(c, u);
    const wasPublished = !!l.published;
    db.unpublishListing(l.id);
    db.audit(h.actor(u), 'listing.unpublish', `${s.slug}:${l.slug}`);
    markDeployPending(db, 'listing.unpublish');
    // Only a listing the site shows is gone from it: start the site's deploy run (site-rebuild.ts) so the change
    // reaches the built site; the bar above already says a deploy is scheduled.
    if (wasPublished) requestSiteRebuild(`unpublish:${l.slug}`);
    return c.json({ ok: true });
  });

  // vault.content.edit: move a listing to another studio.
  app.post('/portal/api/s/:studio/listings/:slug/studio', async (c) => {
    const u = h.apiUser(c);
    if (!P.canPublish(u)) fail(403, 'Only Vault staff who can edit game/studio content can move games between studios.');
    const { s, l } = apiListing(c, u);
    const to = db.studioBySlug(String((await jsonBody(c)).studio ?? ''));
    if (!to) fail(404, 'Choose a studio.');
    moveListingToStudio(db, l, s, to, h.actor(u));
    return c.json({ ok: true, url: `/s/${to.slug}/g/${l.slug}` });
  });

  // vault.content.edit: the one-time import of the Hugo prototype's game pages (../listings-import.ts). It has no form in
  // the portal; Body: { pages, overrides? }, each the JSON itself or its text.
  app.post('/portal/api/vault/listings/import', async (c) => {
    const u = h.apiUser(c);
    if (!P.canPublish(u)) fail(403, 'Only Vault staff who can edit game/studio content can import listings.');
    const b = await jsonBody(c);
    return c.json({ ok: true, ...importFromExport(db, b.pages, b.overrides, h.actor(u)) });
  });
}

