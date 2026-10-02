#!/usr/bin/env node
// Save the published game listings from the Vault Studio Portal to data/catalog.json, which
// content/games/_content.gotmpl turns into the game pages.
//
//   npm run catalog                                      # from https://portal.vaultlearninggames.org
//   VAULT_PORTAL=http://localhost:4181 npm run catalog   # from a local portal (vault-publisher: node scripts/dev-portal.ts)
//
// If the portal can't be reached, the existing data/catalog.json is kept and the build carries on with it.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const portal = (process.env.VAULT_PORTAL || 'https://portal.vaultlearninggames.org').replace(/\/+$/, '');
const out = join(import.meta.dirname, '..', 'data', 'catalog.json');

try {
  const res = await fetch(`${portal}/v1/catalog`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const catalog = await res.json();
  if (!Array.isArray(catalog.games)) throw new Error('not a catalog');
  await writeFile(out, JSON.stringify(catalog, null, 1) + '\n');
  console.log(`catalog: ${catalog.games.length} games from ${portal}`);
} catch (err) {
  const kept = await readFile(out, 'utf8').then((t) => JSON.parse(t).games.length).catch(() => null);
  if (kept === null) { console.error(`catalog: couldn't reach ${portal} (${err.message}) and there's no data/catalog.json yet`); process.exit(1); }
  console.warn(`catalog: couldn't reach ${portal} (${err.message}); keeping data/catalog.json (${kept} games)`);
}
