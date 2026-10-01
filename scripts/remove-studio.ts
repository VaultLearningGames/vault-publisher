// Removes a studio from the portal database by its own id (dry run by default), so an empty studio can go away
// without anything that shares its GitHub owner id (another studio, the organization the publisher's repositories
// belong to) being touched: the delete is scoped to the studio's primary key, and the studio's members go with it.
//
//   node scripts/remove-studio.ts 5             dry run: prints every row that would be removed
//   node scripts/remove-studio.ts 5 --yes       removes the studio
//   node scripts/remove-studio.ts vault --yes   by short name instead of id
//
// The studio must be empty: any CDN game (in any state) or site listing refuses the removal, with the counts.
// A studio listed in studios.json is removed from the database but created again at the next startup, so its entry
// has to go from the repository in the same change. The database comes from --db or $DB_PATH (default data/publisher.db).
import { parseArgs } from 'node:util';
import { Db, StudioNotFoundError, StudioNotEmptyError } from '../src/db.ts';

const { values, positionals } = parseArgs({
  options: { yes: { type: 'boolean' }, db: { type: 'string' } },
  allowPositionals: true,
});
const target = positionals[0];
if (!target || positionals.length > 1) {
  console.error('usage: node scripts/remove-studio.ts STUDIO-ID-OR-SLUG [--yes] [--db PATH]   (dry run without --yes)');
  process.exit(2);
}
const dbPath = values.db ?? process.env.DB_PATH ?? 'data/publisher.db';
const db = new Db(dbPath);
let id: number;
if (/^\d+$/.test(target)) {
  id = Number(target);
} else {
  const s = db.studioBySlug(target);
  if (!s) { console.error(`no studio called ${target}`); process.exit(2); }
  id = s.id;
}
try {
  const r = db.removeStudio(id, { dryRun: !values.yes, actor: 'script:remove-studio' });
  console.log(JSON.stringify(r, null, 2));
  for (const w of r.warnings) console.error(`warning: ${w}`);
  if (!values.yes) console.error(`\nDry run: nothing was removed. Re-run with --yes to remove ${r.studio.slug}.`);
} catch (err) {
  if (err instanceof StudioNotFoundError) { console.error(err.message); process.exit(2); }
  if (err instanceof StudioNotEmptyError) {
    console.error(`refused: ${err.message}`);
    console.error(JSON.stringify({ games: err.blockers.games, listings: err.blockers.listings }, null, 2));
    process.exit(1);
  }
  throw err;
}
db.sqlite.close();
