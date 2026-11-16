// vault-channel.js — the shared Vault channel-resolution core (Analytics.1a).
//
// Purpose: resolves a play's acquisition source to the channel the play is reported under. It works from the
// parameters on the search of the document it runs in — ?vault_ch (a partner's short key or hostname), ?vault_src
// (the source origin; ?vault_referrer is the older name) — and returns { channel, medium }: the partner's own
// hostname (the short keys are normalised through VAULT_CHANNEL_ALIASES), "vault" when the document runs inside
// the Vault player (an iframe, or a wrapper with ?vault_src) with no outside source, "other" for an https source
// that is no known partner origin, or no channel at all (a direct play) when there are no params and the document
// is not embedded.
//
// Provenance: the block between the two marker comments below is copied VERBATIM from Jo Wilder's deployed CDN
// wrapper:
//   https://cdn.vaultlearninggames.org/fieldday/jowilder/iframe.html
//   fetched 2026-11-16 (UTC); sha256 of that file: f289aed3eda792067f57f9563c57afc897490e2e5df19f3390242ff487c7907b
// The marker comments are kept so this file can be diffed against that deployed copy. Nothing between the markers
// is reformatted, renamed, reordered or simplified (VAULT_CHANNEL_ALIASES is byte-for-byte the reference's table),
// and nothing else from the reference is copied here — in particular not its gtag/ga reporting calls or its
// top-level auto-invocation.
//
// Deliberately NOT in this file (sibling cards own them; append them OUTSIDE the markers, never inside):
//   TODO(Analytics.1b): vaultReportChannel — report the resolved channel (gtag/ga).
//   TODO(Analytics.1c): vaultForwardParams — forward vault_ch / vault_src to the next frame.
// The resolution core alone must load and resolve with neither gtag nor ga defined.
//
// A plain browser script: no imports, no requires, no dependencies, no top-level auto-invocation. Its top-level
// declarations are globals (VAULT_CHANNELS, VAULT_CHANNEL_ALIASES, VAULT_PARTNER_CHANNELS, vaultResolveChannel).

  /* VAULT_CHANNEL_LOGIC_START */
  var VAULT_CHANNELS = {
    'https://pbskids.org': 'pbskids.org',
    'https://www.pbskids.org': 'pbskids.org',
    'https://pbswisconsineducation.org': 'pbswisconsineducation.org',
    'https://www.pbswisconsineducation.org': 'pbswisconsineducation.org',
    'https://pbslearningmedia.org': 'pbslearningmedia.org',
    'https://www.pbslearningmedia.org': 'pbslearningmedia.org',
    'https://sciencegamecenter.org': 'sciencegamecenter.org',
    'https://www.sciencegamecenter.org': 'sciencegamecenter.org'
  };
  // Short keys partner links already carry, mapped to the hostname we report them as.
  var VAULT_CHANNEL_ALIASES = {
    pbswi: 'pbswisconsineducation.org',
    pbskids: 'pbskids.org',
    pbslm: 'pbslearningmedia.org',
    sciencegamecenter: 'sciencegamecenter.org'
  };
  // The partner hostnames are real referrals, so they are reported with the referral medium analytics groups
  // them under. "vault", "other" and direct plays are not referrals and keep the honest "vault-player".
  var VAULT_PARTNER_CHANNELS = Object.keys(VAULT_CHANNEL_ALIASES).map(function (k) { return VAULT_CHANNEL_ALIASES[k]; });
  function vaultResolveChannel(rawCh, source, embedded) {
    var channel = rawCh || '';
    // An explicit vault_ch is reported exactly as given, so the short keys are normalised here — right where
    // the value is read, before anything is reported, and not only on the VAULT_CHANNELS fallback below.
    if (Object.prototype.hasOwnProperty.call(VAULT_CHANNEL_ALIASES, channel)) channel = VAULT_CHANNEL_ALIASES[channel];
    // No channel, but a source we recognise: name it anyway.
    if (!channel && /^https:\/\//.test(source)) channel = VAULT_CHANNELS[new URL(source).origin] || 'other';
    // Inside the Vault player with no outside source: the play came through Vault itself.
    if (!channel && embedded) channel = 'vault';
    return {
      channel: channel,
      medium: VAULT_PARTNER_CHANNELS.indexOf(channel) !== -1 ? 'referral' : 'vault-player'
    };
  }
  /* VAULT_CHANNEL_LOGIC_END */
