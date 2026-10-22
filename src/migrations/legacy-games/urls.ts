// The URLs the site must keep serving (decision 1: every old URL is kept). Today (the Squarespace replica on
// vault-site) each game page is at the site root at its old path, /PATH/, and its Squarespace Game Card at
// /game-cards/CARD-ID 301s to it (layouts/index.cardredirects.json). After the import the portal carries both:
// the page address (the old path) and the aliases (the card address, and any other old address).
// "before" is what the snapshot says is served; "after" is what the imported listings express. D-site's redirect
// test fetches every "before" URL from the built site and expects 200 (a page) or 301 (a redirect).
import { CARD_ALIAS_PREFIX } from '../../listings.ts';
import type { LegacyReport } from './types.ts';

type Before = LegacyReport['urls']['before'][number];
type After = LegacyReport['urls']['after'][number];

export const pageUrl = (address: string) => `/${address}/`;
export const cardUrl = (cardId: string) => `/${CARD_ALIAS_PREFIX}${cardId}`;
// An alias as a URL: a game-cards/ address as is, an old page path with its trailing slash (as Hugo serves pages).
export const aliasUrl = (alias: string) => (alias.startsWith(CARD_ALIAS_PREFIX) ? `/${alias}` : pageUrl(alias));
export const cardAlias = (cardId: string) => `${CARD_ALIAS_PREFIX}${cardId}`;

export function beforeUrls(game: string, path: string, cardId: string): Before[] {
  const out: Before[] = [{ url: pageUrl(path), game, kind: 'page', expect: '200' }];
  if (cardId) out.push({ url: cardUrl(cardId), game, kind: 'card', expect: '301' });
  return out;
}

export function afterUrls(game: string, pageAddress: string, aliases: string[]): After[] {
  return [
    { url: pageUrl(pageAddress), game, kind: 'page', expect: '200' },
    ...aliases.map((a): After => ({ url: aliasUrl(a), game, kind: a.startsWith(CARD_ALIAS_PREFIX) ? 'card' : 'alias', expect: '301' })),
  ];
}

// Every "before" URL that no "after" URL keeps: a URL the import would lose (empty when the import is complete).
export function lostUrls(urls: LegacyReport['urls']): Before[] {
  const kept = new Set(urls.after.map((u) => u.url));
  return urls.before.filter((u) => !kept.has(u.url));
}

// The lists as plain text, one "URL<TAB>expect<TAB>game<TAB>kind" per line, sorted (diffable, greppable).
export function urlListText(list: (Before | After)[]): string {
  return [...list].sort((a, b) => a.url.localeCompare(b.url)).map((u) => `${u.url}\t${u.expect}\t${u.game}\t${u.kind}`).join('\n') + '\n';
}
