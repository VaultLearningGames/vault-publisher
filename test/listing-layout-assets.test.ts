import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutAssetError } from '../src/portal/listing-layout.ts';

// The art fields hold absolute CDN URLs, so which CDN counts is environment-dependent: staging's database is a
// copy of production's (docs/staging-reseed.md), and the re-seed does not rewrite the stored URLs. Staging must
// therefore accept its seed's CDN for the listing's own asset prefix, or the first save of any re-seeded listing
// fails on art the editor never touched — which is how a standards repair on staging was refused over a logo.
const PROD = 'https://cdn.vaultlearninggames.org';
const STAGE = 'https://cdn.vaultlearninggames-staging.org';
const own = { studio: 'fieldday', game: 'lockesgambit' };
const logo = (base: string) => `${base}/fieldday/lockesgambit/_vault-assets/logo-760978ec8cf5ae5e.webp`;

describe('layoutAssetError across environments', () => {
  test('production keeps its own CDN and has no seed to trust', () => {
    assert.equal(layoutAssetError('logo_image', logo(PROD), { publicUrl: PROD, ...own }), null);
    assert.match(
      layoutAssetError('logo_image', logo(STAGE), { publicUrl: PROD, ...own }) ?? '',
      /must be an image uploaded for this game/,
    );
  });

  test("staging keeps both its own CDN and the seed's", () => {
    const o = { publicUrl: STAGE, seedPublicUrl: PROD, ...own };
    assert.equal(layoutAssetError('logo_image', logo(STAGE), o), null);
    assert.equal(layoutAssetError('logo_image', logo(PROD), o), null, 're-seeded art must not block a save');
  });

  test('the seed exemption is still scoped to this listing and this field', () => {
    const o = { publicUrl: STAGE, seedPublicUrl: PROD, ...own };
    // Another listing's asset on the seed CDN stays refused.
    assert.match(
      layoutAssetError('logo_image', `${PROD}/fieldday/beats-empire/_vault-assets/logo-760978ec8cf5ae5e.webp`, o) ?? '',
      /must be an image uploaded for this game/,
    );
    // A hero value pointing at a logo asset stays refused (wrong kind).
    assert.match(layoutAssetError('hero_background', logo(PROD), o) ?? '', /must be an image uploaded for this game/);
    // An external link stays refused on both bases.
    assert.match(layoutAssetError('logo_image', 'https://example.com/logo.webp', o) ?? '', /external links/);
  });
});
