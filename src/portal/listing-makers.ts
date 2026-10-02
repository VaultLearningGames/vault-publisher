// "Made by" in a listing's editor: a chooser over the portal's studios. The listing still stores its makers as a list
// of names (ListingFields.makers, published as `makers` in /v1/catalog), and the site links a name to its studio's
// website by matching names, so choosing studios keeps those names right.
//   - The chooser is a group of checkboxes named "makers:NAME", saved in the order they are on the page: the makers
//     chosen so far first, then every other studio. portal.js turns the others into an "Add a studio…" dropdown.
//   - A maker that matches no studio (typed before the chooser existed) keeps working, shown as "not a studio yet".
//   - "Add a new studio…" takes a name and a website. Vault staff create the studio at once, managed by Vault (no
//     GitHub organization), as on Vault → Studios. Studio members can't create studios: theirs is kept with the
//     listing as a proposal and becomes a studio when Vault publishes the listing.
import type { Hono } from 'hono';
import { fail, jsonBody } from '../app.ts';
import type { Db, Studio, User } from '../db.ts';
import { html, type Html } from './html.ts';
import { listingPieces, type ListingHelpers, type ListingRow } from './listings.ts';
import { createManagedStudio, nameOf, websiteOf } from './people.ts';

// A studio a studio member asked for from a listing's "Made by". Kept in settings by listing (no table of its own).
export interface MakerProposal { name: string; website: string | null; by: string; at: string }
const PROPOSALS_KEY = 'listing_maker_proposals';
// Names match as the site matches them: trimmed, any capitalization.
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function allProposals(db: Db): Record<string, MakerProposal[]> {
  try { return JSON.parse(db.setting(PROPOSALS_KEY) ?? '{}') ?? {}; } catch { return {}; }
}
export function makerProposals(db: Db, listing: string): MakerProposal[] {
  return allProposals(db)[listing] ?? [];
}
function setProposals(db: Db, listing: string, list: MakerProposal[]) {
  const all = allProposals(db);
  if (list.length) all[listing] = list; else delete all[listing];
  db.setSetting(PROPOSALS_KEY, JSON.stringify(all));
}
// The proposals a listing still needs: those it names as makers that aren't studios yet.
const wanted = (db: Db, listing: string, makers: string[]) => {
  const studios = db.studios();
  return makerProposals(db, listing).filter((p) => makers.some((m) => same(m, p.name)) && !studios.some((s) => same(s.name, p.name)));
};
// After a save: forget proposals for makers the draft no longer names.
export function pruneMakerProposals(db: Db, listing: string, makers: string[]) {
  if (makerProposals(db, listing).length) setProposals(db, listing, wanted(db, listing, makers));
}
// When Vault publishes a listing: the studios its members proposed for its makers are created.
export function createProposedStudios(db: Db, actor: string, listing: string, makers: string[]): Studio[] {
  const made = wanted(db, listing, makers).map((p) => createManagedStudio(db, actor, p, { listing, proposed_by: p.by }));
  if (makerProposals(db, listing).length) setProposals(db, listing, []);
  return made;
}

// What the chooser says after a maker that isn't one of the portal's studios.
const NOT_YET = 'not a studio yet';
const proposedNote = (staff: boolean) => (staff ? 'new studio, created when this is published' : 'new studio, created when Vault publishes');

// Adds a studio by name and website from a listing's "Made by": the studio of that name if there is one; otherwise a
// new studio (Vault staff) or a proposal kept with the listing (studio members). Returns what the chooser shows.
export function addMaker(h: ListingHelpers, u: User, s: Studio, l: { slug: string }, rawName: unknown, rawWebsite: unknown): { name: string; studio: boolean; note: string } {
  const { db } = h;
  const name = nameOf(rawName), website = websiteOf(rawWebsite);
  const existing = db.studios().find((x) => same(x.name, name));
  if (existing) return { name: existing.name, studio: true, note: '' };
  if (h.isStaff(u)) {
    const made = createManagedStudio(db, h.actor(u), { name, website }, { listing: l.slug });
    return { name: made.name, studio: true, note: '' };
  }
  setProposals(db, l.slug, [...makerProposals(db, l.slug).filter((p) => !same(p.name, name)), { name, website, by: h.actor(u), at: new Date().toISOString() }]);
  db.audit(h.actor(u), 'listing.maker.propose', `${s.slug}:${l.slug}`, { name, website });
  return { name, studio: false, note: proposedNote(false) };
}

// For Vault's review queue: the studios publishing this listing will create.
export function proposedLine(db: Db, l: ListingRow): Html | '' {
  const list = wanted(db, l.slug, l.draft.makers);
  if (!list.length) return '';
  return html`<p class="small">Publishing creates ${list.length > 1 ? 'the studios' : 'the studio'} ${list.map((p, i) => html`${i ? ', ' : ''}<b>${p.name}</b>${p.website ? html` (<a href="${p.website}" target="_blank" rel="noopener">${p.website}</a>)` : ''}`)}, asked for by ${[...new Set(list.map((p) => p.by.replace(/^user:/, '')))].join(', ')}.</p>`;
}

// The editor's "Made by" field.
export function makersField(db: Db, o: { api: string; edit: boolean; staff: boolean; studio: Studio; listing: ListingRow }): Html {
  const studios = db.studios().sort((a, b) => a.name.localeCompare(b.name));
  const proposals = makerProposals(db, o.listing.slug);
  const makers = o.listing.draft.makers;
  // The makers chosen so far, in their order; the listing's own studio when there are none (what the site shows).
  const chosen = (makers.length ? makers : [o.studio.name]).map((m) => {
    const studio = studios.find((x) => same(x.name, m));
    return { name: studio?.name ?? m, studio, proposal: studio ? undefined : proposals.find((p) => same(p.name, m)) };
  });
  const others = o.edit ? studios.filter((x) => !chosen.some((c) => c.studio?.id === x.id)) : [];
  const dis = o.edit ? '' : 'disabled';
  // data-studio: one of the portal's studios, so unticking it puts it back in the dropdown (portal.js).
  const chip = (name: string, checked: boolean, note: string, more: Html | '' = '') => html`<span class="maker"${note ? '' : html` data-studio`}><label><input type="checkbox" name="makers:${name}" ${checked ? 'checked' : ''} ${dis}> ${name}${note ? html` <span class="maker-note">${note}</span>` : ''}</label>${more}</span>`;
  const chips = [
    ...chosen.map((c) => chip(c.name, true, c.studio ? '' : c.proposal ? proposedNote(o.staff) : NOT_YET,
      // Vault staff make a studio of it in one step (the proposed website comes along).
      !c.studio && o.staff && o.edit ? html`<button type="button" class="btn sm" data-maker-create="${c.name}" data-website="${c.proposal?.website ?? ''}"${c.proposal?.website ? html` title="With the website ${c.proposal.website}"` : ''}>Create studio</button>` : '')),
    ...others.map((x) => chip(x.name, false, '')),
  ];
  const adding = o.edit ? html`
      <div class="maker-add"><select aria-label="Add a studio to Made by"><option value="">Add a studio…</option><option value="+">Add a new studio…</option></select></div>
      <details class="maker-new"><summary>Add a new studio…</summary>
        <div class="maker-new-fields">
          <label class="field"><span class="lab">Studio name</span><input type="text" name="maker_new_name" maxlength="100" autocomplete="off" placeholder="Learning Games Lab"></label>
          <label class="field"><span class="lab">Website</span><input type="url" name="maker_new_website" maxlength="300" autocomplete="off" placeholder="https://example.org"><span class="hint">Optional. The site links the studio’s name to it.</span></label>
          <div class="maker-new-foot"><button type="button" class="btn sm pri" data-maker-add>Add studio</button><button type="button" class="btn sm" data-maker-cancel>Cancel</button>
            <span class="hint">${o.staff ? 'Creates the studio now, managed by Vault (no GitHub organization). Change it later under Vault → Studios.' : 'Vault creates the studio when it publishes this listing.'}</span></div>
        </div></details>` : '';
  return html`<div class="field full makers" data-makers="${o.api}/makers">
      <span class="lab" id="makers-lab">Made by</span>
      <div class="chips maker-chips" role="group" aria-labelledby="makers-lab">${chips}</div>${adding}
      <span class="err" role="status" aria-live="polite"></span>
      ${o.edit ? html`<span class="hint">The studios that made the game, in the order the site shows them; ${o.studio.name} when none is ticked. Untick one to take it off.</span>` : ''}</div>`;
}

export function registerListingMakers(app: Hono, h: ListingHelpers) {
  const { db } = h;
  const P = listingPieces(h);

  // "Add a new studio…" and "Create studio" in the chooser. Body: { name, website }. The listing itself changes when
  // its editor is saved; this only makes sure the studio exists (or is proposed) and answers with its name.
  app.post('/portal/api/s/:studio/listings/:slug/makers', async (c) => {
    const u = h.apiUser(c);
    const s = db.studioBySlug(c.req.param('studio'));
    const l = db.listing(c.req.param('slug'));
    if (!s || !l || l.studio_id !== s.id || !(h.isStaff(u) || h.roleIn(u, s))) fail(404, 'unknown listing');
    if (!P.canEdit(u, s)) fail(403, 'Only studio maintainers, admins and Vault staff can change who made a game.');
    const b = await jsonBody(c);
    return c.json({ ok: true, ...addMaker(h, u, s, l, b.name, b.website) });
  });
}
