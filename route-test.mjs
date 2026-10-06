// Temporary: open each old route in Chromium and record where it ends up and whether the game plays in the Vault player.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const routes = readFileSync(process.argv[2], 'utf8').trim().split('\n');
const browser = await chromium.launch();
const out = [];
const one = async (url) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  let err = '';
  try { await page.goto(url, { waitUntil: 'load', timeout: 45000 }); } catch (e) { err = String(e).split('\n')[0]; }
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const f = document.querySelector('.vault-player iframe');
    return { at: location.href, player: !!document.querySelector('.vault-player.is-open'), frame: f ? f.src : null,
             gate: document.querySelector('.vault-gate:not([hidden])') ? (document.querySelector('.vault-gate').className || '') : null };
  }).catch(() => ({ at: page.url(), player: false, frame: null }));
  // The game frame itself loaded (not redirected away)?
  const gf = info.frame ? page.frames().find((fr) => fr.url().startsWith('https://cdn.vaultlearninggames.org/') || fr.url().startsWith('https://fielddaylab')) : null;
  const frameUrl = gf ? gf.url() : null;
  await ctx.close();
  return { url, ...info, frameUrl, err };
};
for (let i = 0; i < routes.length; i += 6) {
  const batch = await Promise.all(routes.slice(i, i + 6).map(one));
  out.push(...batch);
}
await browser.close();
console.log(JSON.stringify(out));
