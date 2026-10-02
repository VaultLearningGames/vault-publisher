// Write the static hosting's files (_headers, _redirects, robots.txt: src/site-hosting.ts) into a build of the
// website. The last step of `npm run site:build`.
//   node scripts/site-hosting.ts [site/public]
// Environment: SITE_INDEX_HOST, the one hostname search engines may index (production's deploy sets
// vaultlearninggames.org). Not set: every hostname says noindex.
import { writeHostingFiles } from '../src/site-hosting.ts';

const dir = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'site/public';
const indexHost = process.env.SITE_INDEX_HOST?.trim() || undefined;
try {
  const r = await writeHostingFiles(dir, { indexHost });
  console.log(`site-hosting: ${r.files} files; _headers ${r.headerRules} rules, ${indexHost ? `indexed at ${indexHost} only` : 'noindex everywhere'}; _redirects ${r.cards} card addresses, ${r.rewrites} filter addresses, ${r.slashes} trailing-slash redirects`);
  if (r.skippedSlashes) console.warn('site-hosting: too many pages for a 301 each: "/page/" is redirected to "/page" by the hosting itself, with a 307');
} catch (err) {
  console.error(`site-hosting: ${(err as Error).message}`);
  process.exit(1);
}
