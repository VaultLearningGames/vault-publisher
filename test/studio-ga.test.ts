import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Analytics } from '../src/analytics/ga.ts';
import { buildCatalog } from '../src/catalog.ts';
import type { Db } from '../src/db.ts';
import { EMPTY_LISTING, normalize, problems } from '../src/listings.ts';
import { fakeGa } from '../scripts/fake-ga.ts';
import { portalHarness } from './portal-harness.ts';

let h: ReturnType<typeof portalHarness>, db: Db;
beforeEach(() => {
  h = portalHarness({ analytics: new Analytics({ transport: fakeGa(['wake']) }) });
  db = h.db;
});

const fieldday = () => db.studioBySlug('fieldday')!;
function wake(ga = '') {
  const l = db.createListing(fieldday().id, 'wake', { ...EMPTY_LISTING, title: 'Wake', play_url: 'https://wake.test/', ga_measurement_id: ga }, 'test');
  db.publishListing(l.id, 'test');
  return l.id;
}
const catalogGame = (slug: string) => (buildCatalog(db, 'https://prod.test').games as any[]).find((g) => g.slug === slug);
const setGa = (who: ReturnType<typeof h.as>, value: string) => who.post('/portal/api/s/fieldday/google-analytics', { ga_measurement_id: value });

describe('a studio’s own Google Analytics', () => {
  test('studio admins and Vault admins set it; it is checked and tidied; "" clears it; each change is audited', async () => {
    const ada = h.as('ada', 'none', 'admin');
    assert.equal((await setGa(h.as('mia', 'none', 'maintainer'), 'G-ABC123')).status, 403);
    assert.equal((await setGa(h.as('vera', 'none', 'viewer'), 'G-ABC123')).status, 403);
    assert.equal((await setGa(ada, 'UA-167151707-1')).status, 400);   // Universal Analytics is not GA4
    assert.equal(fieldday().ga_measurement_id ?? null, null);
    const r = await setGa(ada, ' g-abc123 ');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, ga_measurement_id: 'G-ABC123' });
    assert.equal(fieldday().ga_measurement_id, 'G-ABC123');
    assert.equal((await setGa(h.as('boss', 'admin'), '')).status, 200);
    assert.equal(fieldday().ga_measurement_id, null);
    const audit = db.sqlite.prepare("SELECT detail_json FROM audit_log WHERE action = 'studio.google_analytics' ORDER BY id").all() as { detail_json: string }[];
    assert.deepEqual(audit.map((a) => JSON.parse(a.detail_json)), [{ from: null, to: 'G-ABC123' }, { from: 'G-ABC123', to: null }]);
  });

  test('the Members page shows it, with the form for studio admins only', async () => {
    db.setStudioGa(fieldday().id, 'G-ABC123');
    const admin = await (await h.as('ada', 'none', 'admin').get('/s/fieldday/members')).text();
    assert.match(admin, /G-ABC123/);
    assert.match(admin, /data-api="\/portal\/api\/s\/fieldday\/google-analytics"/);
    const viewer = await (await h.as('vera', 'none', 'viewer').get('/s/fieldday/members')).text();
    assert.match(viewer, /G-ABC123/);
    assert.doesNotMatch(viewer, /google-analytics"/);
  });
});

describe('a game’s own Google Analytics (its listing)', () => {
  test('a listing field: tidied, checked like the studio’s, labelled', () => {
    assert.equal(normalize({ ga_measurement_id: ' g-xyz789 ' }).ga_measurement_id, 'G-XYZ789');
    assert.equal(normalize({}).ga_measurement_id, '');
    assert.deepEqual(problems(normalize({ ga_measurement_id: 'G-XYZ789' }), { forPublish: false, cdnReady: false }), []);
    assert.match(problems(normalize({ ga_measurement_id: 'UA-1-1' }), { forPublish: false, cdnReady: false }).join(' '), /G-XXXXXXXXXX/);
  });

  test('the listing editor has the field, and says where the studio’s goes', async () => {
    wake();
    db.setStudioGa(fieldday().id, 'G-ABC123');
    const page = await (await h.as('mia', 'none', 'maintainer').get('/s/fieldday/g/wake')).text();
    assert.match(page, /name="ga_measurement_id"/);
    assert.match(page, /Field Day Lab’s G-ABC123/);
  });
});

describe('the catalog and the site', () => {
  test('catalog games list the GA4 properties to send to: the game’s, then its studio’s, once each', () => {
    wake();
    assert.deepEqual(catalogGame('wake').analytics, { google: [] });
    db.setStudioGa(fieldday().id, 'G-ABC123');
    assert.deepEqual(catalogGame('wake').analytics, { google: ['G-ABC123'] });
    db.sqlite.exec('DELETE FROM listings'); wake('G-XYZ789');
    assert.deepEqual(catalogGame('wake').analytics, { google: ['G-XYZ789', 'G-ABC123'] });
    db.setStudioGa(fieldday().id, 'G-XYZ789');
    assert.deepEqual(catalogGame('wake').analytics, { google: ['G-XYZ789'] });
  });

  test('the site’s head configures them after Vault’s own property, only in builds that send analytics', async () => {
    const { readFileSync } = await import('node:fs');
    const head = readFileSync(new URL('../site/themes/vault-squarespace/layouts/partials/sq/head.html', import.meta.url), 'utf8');
    assert.match(head, /\{\{- with site\.Params\.analytics\.google \}\}[\s\S]*gtag\('config', \{\{ \. \}\}\);\{\{ with \$\.Params\.analytics \}\}\{\{ range \.google \}\}gtag\('config', \{\{ \. \}\}\);/);
    const content = readFileSync(new URL('../site/content/games/_content.gotmpl', import.meta.url), 'utf8');
    assert.match(content, /"analytics" \.analytics/);
  });
});

describe('Analytics pages', () => {
  test('a studio’s page and a game’s tab say which of their own properties also get the plays, and how to add one', async () => {
    wake();
    const mia = h.as('mia', 'none', 'maintainer');
    const none = await (await mia.get('/s/fieldday/analytics')).text();
    assert.match(none, /Your own Google Analytics/);
    assert.match(none, /None yet/);
    assert.match(none, /href="\/s\/fieldday\/members#studio"/);
    db.setStudioGa(fieldday().id, 'G-ABC123');
    const studio = await (await mia.get('/s/fieldday/analytics')).text();
    assert.match(studio, /also go to <span class="mono">G-ABC123<\/span> \(Field Day Lab\)/);
    assert.match(studio, /Demographic details/);
    const tab = await (await mia.get('/s/fieldday/g/wake?tab=analytics')).text();
    assert.match(tab, /of this game on vaultlearninggames\.org also go to <span class="mono">G-ABC123<\/span>/);
  });

  test('a game ID changed in the draft says it applies once published and rebuilt', async () => {
    const id = wake('G-XYZ789');
    const l = db.listing('wake')!;
    db.saveListingDraft(id, { ...l.draft, ga_measurement_id: 'G-NEW1234' }, 'test');
    const tab = await (await h.as('mia', 'none', 'maintainer').get('/s/fieldday/g/wake?tab=analytics')).text();
    assert.match(tab, /<span class="mono">G-XYZ789<\/span> \(this game\)/);
    assert.match(tab, /applies once Vault publishes the listing/);
  });
});
