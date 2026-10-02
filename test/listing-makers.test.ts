import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/listings.ts';
import { portalHarness } from './portal-harness.ts';

const L = '/portal/api/s/fieldday/listings';
const M = `${L}/wake/makers`;
const PAGE = '/s/fieldday/g/wake';

let t: ReturnType<typeof portalHarness>;
const catalog = async () => (await (await t.app.request('/v1/catalog')).json()) as { studios: { slug: string; name: string; url: string | null }[]; games: { slug: string; makers: string[] }[] };
const makersOf = async (slug = 'wake') => (await catalog()).games.find((g) => g.slug === slug)?.makers;
// The chooser's checkboxes in page order: "[x] Name" or "[ ] Name".
const boxes = (page: string) => [...page.matchAll(/<input type="checkbox" name="makers:([^"]*)" (checked)?/g)].map((m) => `${m[2] ? '[x]' : '[ ]'} ${m[1]}`);
const field = (page: string) => page.slice(page.indexOf('class="field full makers"'), page.indexOf('Short description'));

beforeEach(async () => {
  t = portalHarness({ previewSites: [{ label: 'Site', url: 'https://site.test' }] });
  t.db.syncStudios([{ slug: 'wilson', name: 'Wilson Center', github_owner: '', github_owner_id: 'vault:wilson' }]);
  t.db.setStudioWebsite(t.db.studioBySlug('wilson')!.id, 'https://wilsoncenter.org/');
  const boss = t.as('boss', 'admin');
  await boss.post(L, { slug: 'wake', title: 'Wake' });
  assert.equal((await boss.post(`${L}/wake`, { play_url: 'https://example.org/wake/', publish: true })).status, 200);
});

describe('“Made by” is a chooser over the studios', () => {
  test('the form’s checkboxes are the makers, in page order; the comma-separated text still works', () => {
    const base = normalize({ makers: 'Field Day Lab, Wilson Center' });
    assert.deepEqual(base.makers, ['Field Day Lab', 'Wilson Center']);
    assert.deepEqual(normalize({ 'makers:Wilson Center': true, 'makers:University of Calgary': false, 'makers:Field Day Lab': 'on' }, base).makers, ['Wilson Center', 'Field Day Lab']);
    assert.deepEqual(normalize({ 'makers:Sea Grant, UW': true }, base).makers, ['Sea Grant, UW'], 'a name can contain a comma');
    assert.deepEqual(normalize({ 'makers:Field Day Lab': false }, base).makers, [], 'all unticked: none (the site shows the studio)');
    assert.deepEqual(normalize({ title: 'x' }, base).makers, base.makers, 'not sent: unchanged');
  });

  test('the editor lists the chosen makers first, in order, then every other studio; the listing’s studio is the default', async () => {
    const boss = t.as('boss', 'admin');
    let page = await (await boss.get(PAGE)).text();
    assert.deepEqual(boxes(page), ['[x] Field Day Lab', '[ ] University of Calgary', '[ ] Wilson Center']);
    assert.match(field(page), /<select aria-label="Add a studio to Made by"><option value="">Add a studio…<\/option><option value="\+">Add a new studio…<\/option><\/select>/);
    assert.match(field(page), /<details class="maker-new"><summary>Add a new studio…<\/summary>[^]*name="maker_new_name"[^]*type="url" name="maker_new_website"/);
    assert.doesNotMatch(page, /Comma-separated if several/);
    // Saved as the form sends it: ticked boxes in page order.
    assert.equal((await boss.post(`${L}/wake`, { 'makers:Field Day Lab': true, 'makers:University of Calgary': false, 'makers:Wilson Center': true, publish: true })).status, 200);
    assert.deepEqual(await makersOf(), ['Field Day Lab', 'Wilson Center']);
    assert.equal((await boss.post(`${L}/wake`, { 'makers:Wilson Center': true, 'makers:Field Day Lab': true, publish: true })).status, 200);
    assert.deepEqual(t.db.listing('wake')!.draft.makers, ['Wilson Center', 'Field Day Lab'], 'order kept');
    page = await (await boss.get(PAGE)).text();
    assert.deepEqual(boxes(page), ['[x] Wilson Center', '[x] Field Day Lab', '[ ] University of Calgary']);
    // None ticked: the catalog still says the listing's studio, and the editor offers it ticked again.
    assert.equal((await boss.post(`${L}/wake`, { 'makers:Wilson Center': false, 'makers:Field Day Lab': false, publish: true })).status, 200);
    assert.deepEqual(t.db.listing('wake')!.draft.makers, []);
    assert.deepEqual(await makersOf(), ['Field Day Lab']);
    assert.deepEqual(boxes(await (await boss.get(PAGE)).text())[0], '[x] Field Day Lab');
    // Someone who can't edit sees the makers only.
    const viewer = field(await (await t.as('vera', 'none', 'viewer').get(PAGE)).text());
    assert.deepEqual(boxes(viewer), ['[x] Field Day Lab']);
    assert.match(viewer, /name="makers:Field Day Lab" checked disabled/);
    assert.doesNotMatch(viewer, /maker-add|maker_new_name|data-maker-create/);
  });

  test('a maker typed before the chooser that matches no studio keeps working; Vault staff make a studio of it in one step', async () => {
    const boss = t.as('boss', 'admin');
    assert.equal((await boss.post(`${L}/wake`, { makers: 'Field Day Lab, wilson center, Nicky Case', publish: true })).status, 200);
    assert.deepEqual(await makersOf(), ['Field Day Lab', 'wilson center', 'Nicky Case'], 'published as typed');
    const page = field(await (await boss.get(PAGE)).text());
    assert.deepEqual(boxes(page), ['[x] Field Day Lab', '[x] Wilson Center', '[x] Nicky Case', '[ ] University of Calgary'], 'a studio’s name in other capitals is that studio');
    assert.match(page, /name="makers:Nicky Case" checked > Nicky Case <span class="maker-note">not a studio yet<\/span><\/label><button type="button" class="btn sm" data-maker-create="Nicky Case" data-website="">Create studio<\/button>/);
    assert.equal((page.match(/data-maker-create/g) ?? []).length, 1);
    // A studio member sees the same, without the button.
    const member = field(await (await t.as('mia', 'none', 'maintainer').get(PAGE)).text());
    assert.match(member, /not a studio yet/);
    assert.doesNotMatch(member, /data-maker-create/);
    // Saving the form as it is keeps it, still not a studio.
    assert.equal((await boss.post(`${L}/wake`, { 'makers:Field Day Lab': true, 'makers:Wilson Center': true, 'makers:Nicky Case': true, publish: true })).status, 200);
    assert.deepEqual(await makersOf(), ['Field Day Lab', 'Wilson Center', 'Nicky Case']);
    assert.ok(!(await catalog()).studios.some((s) => s.name === 'Nicky Case'));
    // "Create studio".
    assert.deepEqual(await (await boss.post(M, { name: 'Nicky Case', website: '' })).json(), { ok: true, name: 'Nicky Case', studio: true, note: '' });
    assert.equal(t.db.studioBySlug('nicky-case')!.source, 'portal');
    assert.doesNotMatch(field(await (await boss.get(PAGE)).text()), /not a studio yet|data-maker-create/);
  });

  test('“Add a new studio…”: Vault staff create a Vault-managed studio at once, by the rules of Vault → Studios', async () => {
    const rm = t.as('rita', 'release_manager');
    const res = await rm.post(M, { name: '  Sea Grant,  UW ', website: 'https://seagrant.wisc.edu/' });
    assert.deepEqual(await res.json(), { ok: true, name: 'Sea Grant, UW', studio: true, note: '' });
    const s = t.db.studioBySlug('sea-grant-uw')!;
    assert.deepEqual([s.name, s.github_owner, s.github_owner_id, s.website, s.source], ['Sea Grant, UW', '', 'vault:sea-grant-uw', 'https://seagrant.wisc.edu/', 'portal']);
    const audit = t.db.auditFor(['studio.create'], 1)[0];
    assert.deepEqual([audit.actor, audit.target, JSON.parse(audit.detail_json!).via, JSON.parse(audit.detail_json!).listing], ['user:rita', 'sea-grant-uw', 'made by', 'wake']);
    // The listing changes only when its editor is saved; the new studio is then one of the choices.
    assert.deepEqual(t.db.listing('wake')!.draft.makers, ['Field Day Lab']);
    assert.ok(boxes(await (await rm.get(PAGE)).text()).includes('[ ] Sea Grant, UW'));
    // A studio that exists already is just chosen (whatever the capitals), not created again or changed.
    const count = t.db.studios().length;
    assert.deepEqual(await (await rm.post(M, { name: 'wilson center', website: 'https://other.example/' })).json(), { ok: true, name: 'Wilson Center', studio: true, note: '' });
    assert.equal(t.db.studios().length, count);
    assert.equal(t.db.studioBySlug('wilson')!.website, 'https://wilsoncenter.org/');
    // The same checks as the Studios page; a short name that is taken gets a suffix.
    assert.equal((await rm.post(M, { name: ' ', website: '' })).status, 400);
    assert.equal((await rm.post(M, { name: 'x'.repeat(101), website: '' })).status, 400);
    const bad = await rm.post(M, { name: 'New Studio', website: 'seagrant.wisc.edu' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /full address starting with https/);
    assert.equal(t.db.studios().length, count, 'nothing created');
    assert.equal((await rm.post(M, { name: 'Wilson', website: '' })).status, 200);
    assert.equal(t.db.studios().find((x) => x.name === 'Wilson')!.slug, 'wilson-2');
    assert.equal((await rm.post(M, { name: '北京', website: '' })).status, 200);
    assert.equal(t.db.studios().find((x) => x.name === '北京')!.slug, 'studio');
    // Only people who can edit the listing.
    assert.equal((await t.as('vera', 'none', 'viewer').post(M, { name: 'X' })).status, 403);
    assert.equal((await t.as('stranger').post(M, { name: 'X' })).status, 404);
    assert.equal((await rm.post('/portal/api/s/ucalgary/listings/wake/makers', { name: 'X' })).status, 404, 'the listing isn’t that studio’s');
  });

  test('studio members can’t create studios: theirs is a proposal, created when Vault publishes the listing', async () => {
    const mia = t.as('mia', 'none', 'maintainer'), boss = t.as('boss', 'admin');
    const count = t.db.studios().length;
    assert.deepEqual(await (await mia.post(M, { name: 'Tiny Indie Co', website: 'https://tiny.example/' })).json(),
      { ok: true, name: 'Tiny Indie Co', studio: false, note: 'new studio, created when Vault publishes' });
    assert.equal(t.db.studios().length, count, 'no studio yet');
    assert.equal((await mia.post(M, { name: 'Bad Site', website: 'nope' })).status, 400, 'checked when it’s proposed');
    // The form's save sends the new maker's checkbox; the draft goes to Vault for review.
    assert.equal((await mia.post(`${L}/wake`, { 'makers:Field Day Lab': true, 'makers:Tiny Indie Co': true })).status, 200);
    assert.equal(t.db.listing('wake')!.review, 'submitted');
    assert.match(field(await (await mia.get(PAGE)).text()), /name="makers:Tiny Indie Co" checked > Tiny Indie Co <span class="maker-note">new studio, created when Vault publishes<\/span><\/label><\/span>/);
    assert.deepEqual(await makersOf(), ['Field Day Lab'], 'nothing on the site changes before Vault publishes');
    // Vault sees what publishing will do, in the review queue and in the editor (where it can also be created now).
    const queue = await (await boss.get('/vault/listings')).text();
    assert.match(queue, /Publishing creates the studio <b>Tiny Indie Co<\/b> \(<a href="https:\/\/tiny\.example\/"[^>]*>https:\/\/tiny\.example\/<\/a>\), asked for by mia\./);
    assert.match(field(await (await boss.get(PAGE)).text()), /new studio, created when this is published<\/span><\/label><button type="button" class="btn sm" data-maker-create="Tiny Indie Co" data-website="https:\/\/tiny\.example\/"/);
    assert.equal((await boss.post(`${L}/wake/publish`)).status, 200);
    const made = t.db.studioBySlug('tiny-indie-co')!;
    assert.deepEqual([made.name, made.website, made.github_owner_id, made.source], ['Tiny Indie Co', 'https://tiny.example/', 'vault:tiny-indie-co', 'portal']);
    const detail = JSON.parse(t.db.auditFor(['studio.create'], 1)[0].detail_json!);
    assert.deepEqual([detail.via, detail.listing, detail.proposed_by], ['made by', 'wake', 'user:mia']);
    const cat = await catalog();
    assert.deepEqual(cat.games[0].makers, ['Field Day Lab', 'Tiny Indie Co']);
    assert.deepEqual(cat.studios.find((s) => s.name === 'Tiny Indie Co'), { slug: 'tiny-indie-co', name: 'Tiny Indie Co', url: 'https://tiny.example/' });
    assert.doesNotMatch(await (await boss.get('/vault/listings')).text(), /Publishing creates/);
    assert.doesNotMatch(field(await (await mia.get(PAGE)).text()), /maker-note/);
  });

  test('a proposal that is dropped before publishing creates nothing; Vault’s save-and-publish creates one that is kept', async () => {
    const mia = t.as('mia', 'none', 'maintainer'), boss = t.as('boss', 'admin');
    const count = t.db.studios().length;
    await mia.post(M, { name: 'Dropped Co', website: '' });
    await mia.post(M, { name: 'Kept Co', website: 'https://kept.example/' });
    assert.equal((await mia.post(`${L}/wake`, { 'makers:Field Day Lab': true, 'makers:Dropped Co': false, 'makers:Kept Co': true })).status, 200);
    assert.equal((await boss.post(`${L}/wake`, { 'makers:Field Day Lab': true, 'makers:Kept Co': true, publish: true })).status, 200);
    assert.deepEqual(t.db.studios().length, count + 1);
    assert.equal(t.db.studios().find((s) => s.name === 'Kept Co')!.website, 'https://kept.example/');
    // The name alone, typed again later, is just a maker that isn't a studio: the old proposal is gone.
    assert.equal((await boss.post(`${L}/wake`, { makers: ['Field Day Lab', 'Dropped Co'], publish: true })).status, 200);
    assert.equal(t.db.studios().length, count + 1);
    assert.deepEqual(await makersOf(), ['Field Day Lab', 'Dropped Co']);
  });

  test('a name left in the new studio’s fields is added by the save itself', async () => {
    const boss = t.as('boss', 'admin'), mia = t.as('mia', 'none', 'maintainer');
    assert.equal((await boss.post(`${L}/wake`, { 'makers:Field Day Lab': true, maker_new_name: 'Left Behind', maker_new_website: 'https://left.example/', publish: true })).status, 200);
    assert.deepEqual(await makersOf(), ['Field Day Lab', 'Left Behind']);
    assert.equal(t.db.studioBySlug('left-behind')!.website, 'https://left.example/');
    // A save that fails creates nothing.
    const count = t.db.studios().length;
    assert.equal((await boss.post(`${L}/wake`, { play_url: 'not a link', maker_new_name: 'Never Made', publish: true })).status, 400);
    assert.equal((await boss.post(`${L}/wake`, { maker_new_name: 'Never Made', maker_new_website: 'nope', publish: true })).status, 400);
    assert.equal(t.db.studios().length, count);
    assert.deepEqual(t.db.listing('wake')!.draft.makers, ['Field Day Lab', 'Left Behind']);
    // From a studio member it is a proposal, sent to Vault with the save.
    assert.equal((await mia.post(`${L}/wake`, { 'makers:Field Day Lab': true, 'makers:Left Behind': true, maker_new_name: 'Member Idea', maker_new_website: '' })).status, 200);
    assert.deepEqual(t.db.listing('wake')!.draft.makers, ['Field Day Lab', 'Left Behind', 'Member Idea']);
    assert.equal(t.db.studios().length, count);
    assert.match(await (await boss.get('/vault/listings')).text(), /Publishing creates the studio <b>Member Idea<\/b>, asked for by mia\./);
  });
});

describe('the catalog’s studios include the makers’ studios', () => {
  test('a studio named as a maker is listed with its website even with no game of its own; previews too', async () => {
    const boss = t.as('boss', 'admin');
    assert.deepEqual((await catalog()).studios, [{ slug: 'fieldday', name: 'Field Day Lab', url: null }]);
    assert.equal((await boss.post(`${L}/wake`, { 'makers:Field Day Lab': true, 'makers:Wilson Center': true, publish: true })).status, 200);
    assert.deepEqual((await catalog()).studios, [{ slug: 'fieldday', name: 'Field Day Lab', url: null }, { slug: 'wilson', name: 'Wilson Center', url: 'https://wilsoncenter.org/' }]);
    assert.ok(!(await catalog()).studios.some((s) => s.slug === 'ucalgary'), 'studios nobody names stay out');
    // A preview of unsaved makers carries their studios, so the site links them as it will once published.
    const res = await boss.post(`${L}/wake/preview`, { 'makers:University of Calgary': true });
    assert.equal(res.status, 200);
    const { token } = (await res.json()) as { token: string };
    const preview = (await (await t.app.request(`/v1/listing-previews/${token}`, { headers: { Accept: 'application/json' } })).json()) as { game: { makers: string[] }; studios: { slug: string }[] };
    assert.deepEqual(preview.game.makers, ['University of Calgary']);
    assert.deepEqual(preview.studios.map((s) => s.slug), ['fieldday', 'ucalgary', 'wilson']);
  });
});
