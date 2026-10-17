// Vault as the traffic source in a game's own analytics (partials/vault-player.html inlines this file; src/vault-attribution.ts
// is the same rule for server code: keep the two in step). A studio's GA4, Plausible, Unity/Godot web analytics etc. decide a session's
// source from document.referrer and the UTM parameters on the game's address; with neither they report "Direct".
// The player sends the referrer (its iframe's referrerpolicy) and, with this, tags the game's address:
//
//   utm_source=vault  utm_medium=referral  utm_campaign=<game slug>  utm_content=<surface: game_page, embed, ...>
//
// Left as given: an address that already has any utm_* parameter (the studio's own tagging wins), a signed address
// (adding parameters would break its signature), anything not http(s) or not an address, and every address when
// opts.enabled is false (VAULT_ATTRIBUTION_UTM=off). The existing query is kept byte for byte, the UTM parameters go
// at its end, before any #fragment, and a relative address stays relative. Never throws.
(function (root) {
  // Query parameter names (case-insensitive) that mean the address is signed: S3/R2 presigned, CloudFront, generic
  // sig/token. Azure SAS is se + sp together; Expires counts only with a signature beside it.
  var SIGNED = ['x-amz-signature', 'signature', 'sig', 'token', 'policy', 'key-pair-id'];
  var DUMMY = 'https://vault-attribution.invalid/';

  function isSigned(names) {
    var has = function (n) { return names.indexOf(n) >= 0; };
    if (SIGNED.some(has)) return true;
    if (has('se') && has('sp')) return true;
    return has('expires') && names.some(function (n) { return /sig/.test(n); });
  }

  function buildAttributedLaunchUrl(rawUrl, ctx, opts) {
    try {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) return rawUrl;
      if (opts && opts.enabled === false) return rawUrl;
      ctx = ctx || {};
      var base = (opts && opts.base) || DUMMY;
      var u = new URL(rawUrl, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return rawUrl;
      var names = [];
      u.searchParams.forEach(function (_, k) { names.push(k.toLowerCase()); });
      if (names.some(function (n) { return n.indexOf('utm_') === 0; })) return rawUrl;
      if (isSigned(names)) return rawUrl;

      var tags = new URLSearchParams();
      tags.set('utm_source', 'vault');
      tags.set('utm_medium', 'referral');
      var slug = String(ctx.gameSlug || '').trim();
      if (slug) tags.set('utm_campaign', slug);
      tags.set('utm_content', String(ctx.surface || '').trim() || 'game_page');

      // Edit the address as written, so a relative one stays relative and the existing query keeps its exact encoding.
      var hashAt = rawUrl.indexOf('#');
      var hash = hashAt >= 0 ? rawUrl.slice(hashAt) : '';
      var rest = hashAt >= 0 ? rawUrl.slice(0, hashAt) : rawUrl;
      var queryAt = rest.indexOf('?');
      var path = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
      var query = queryAt >= 0 ? rest.slice(queryAt + 1) : '';
      if (query && !/&$/.test(query)) query += '&';
      return path + '?' + query + tags.toString() + hash;
    } catch (e) {
      return rawUrl;
    }
  }

  root.VaultAttribution = { buildAttributedLaunchUrl: buildAttributedLaunchUrl };
})(typeof window !== 'undefined' ? window : globalThis);
