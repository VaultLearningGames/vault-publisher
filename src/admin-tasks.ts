// Admin tasks: the Vault-admin operations on site listings, callable by a machine. Each is the same operation the
// portal offers a signed-in Vault admin (src/listing-ops.ts), authorized like releases: a GitHub OIDC token from the
// admin repository's workflow running in this system's GitHub environment (.github/workflows/admin-task.yml, which
// runs scripts/admin-task.ts). The audit log records the workflow's GitHub actor ("github:LOGIN").
//
//   GET  /v1/admin/listings[?slug=a&slug=b]     drafts, published listings and review state, to verify a task
//   POST /v1/admin/studios                      { studios: [{ slug, name?, website? }] }
//   POST /v1/admin/studios/remove               { slugs: [slug, …] }   delete empty studios
//   POST /v1/admin/featured                     { games: [{ slug, sequence?, blurb?, image? }] }
//   POST /v1/admin/listings/import              { source, slugs?, pages?, overrides? }
//   POST /v1/admin/listings/migrate-images      { base, budget_seconds? }
//   POST /v1/admin/listings/move                { slug, studio }
//   POST /v1/admin/listings/update              { updates: [{ slug, fields?, cdn_game? }], publish, publish_pending? }
//   GET  /v1/admin/image-variants               the listing images on the CDN, and which have their smaller copies
//   POST /v1/admin/image-variants               { url, width, height, variants: [{ width, webp (base64) }] }
//
// Every POST takes dry_run: true, which answers with what would change and writes nothing.
import type { Context, Hono } from 'hono';
import { fail, jsonBody, type AppDeps } from './app.ts';
import type { GitHubIdentity } from './auth.ts';
import { MAX_FEATURED, normalizeFeatured, readFeatured, saveFeatured, sortFeatured } from './featured.ts';
import { isSlug } from './paths.ts';
import { StudioNotEmptyError, studioWebsite } from './db.ts';
import { changedFields, EMPTY_LISTING, normalize, type ListingFields } from './listings.ts';
import { IMAGE_CACHE } from './assets.ts';
import { isOriginalKey, keyOfUrl, listingImageUrls, MAX_VARIANT_BYTES, readVariants, recordVariants, variantKey, variantWidths, webpWidth } from './image-variants.ts';
import { baseUrl, copySiteImages, draftProblems, importFromExport, moveListingToStudio, saveListing, type ListingRow } from './listing-ops.ts';

// Cloud Run ends a request after its timeout (300 s unless the service sets --timeout), so the image migration
// starts no new download after this long and reports what is `remaining`; running it again continues.
const DEFAULT_BUDGET_SECONDS = 240;
const MAX_BUDGET_SECONDS = 3300;
const EXPORT_TIMEOUT_MS = 30_000;
const MAX_UPDATES = 500;

type Field = keyof ListingFields;
const FIELDS = Object.keys(EMPTY_LISTING) as Field[];
const LIST_FIELDS: Field[] = ['makers', 'grades', 'subjects', 'topics', 'standards', 'screenshots'];

function dryRun(body: Record<string, unknown>): boolean {
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') fail(400, 'dry_run must be true or false');
  return body.dry_run === true;
}

function slugList(v: unknown, what: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.length || !v.every(isSlug)) fail(400, `${what} must be a non-empty list of page slugs like "wake"`);
  return [...new Set(v as string[])];
}

// What's wrong with the fields of one update, in the request's own terms; then the same checks as a save.
function fieldProblems(fields: Record<string, unknown>, draft: ListingFields): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const f = k as Field;
    if (!FIELDS.includes(f)) { out.push(`Unknown field “${k}” (fields: ${FIELDS.join(', ')}).`); continue; }
    if (f === 'embed') { if (typeof v !== 'boolean') out.push('embed must be true or false.'); continue; }
    if (f === 'play_source') { if (v !== 'url' && v !== 'cdn') out.push('play_source must be "url" or "cdn".'); continue; }
    if (f === 'min_width' || f === 'min_height') {
      if (v !== null && !(typeof v === 'number' && Number.isInteger(v))) out.push(`${k} must be a whole number of pixels, or null for the site’s default.`);
      continue;                                                  // its range is checked by the save's own rules
    }
    if (LIST_FIELDS.includes(f)) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) { out.push(`${k} must be a list of strings.`); continue; }
      if (JSON.stringify(draft[f]) !== JSON.stringify(v.map((x) => x.trim()))) out.push(`${k} has empty, repeated or over-long items, or too many of them.`);
      continue;
    }
    if (typeof v !== 'string') { out.push(`${k} must be a string.`); continue; }
    if (f === 'fit') continue;                                   // checked by the save's own rules
    if (f === 'cdn_path') { if (v.trim() && !draft.cdn_path) out.push('cdn_path must be plain folder names like "earthquake/".'); continue; }
    if (draft[f] !== v.trim()) out.push(`${k} is too long (${v.trim().length} characters; ${(draft[f] as string).length} would be kept).`);
  }
  return out;
}

export function registerAdminTasks(app: Hono, deps: AppDeps, admin: (c: Context) => Promise<GitHubIdentity>) {
  const { db } = deps;
  const actorOf = (id: GitHubIdentity) => `github:${id.actor}`;
  const view = (l: ListingRow) => ({
    slug: l.slug, studio: l.studio_slug, studio_name: l.studio_name,
    cdn_game: l.game_id ? db.gameById(l.game_id)?.slug ?? null : null,
    on_site: !!l.published, review: l.review, review_note: l.review_note,
    unpublished_changes: l.published ? changedFields(l.published, l.draft) : [],
    submitted_by: l.submitted_by, submitted_at: l.submitted_at, published_by: l.published_by, published_at: l.published_at,
    updated_by: l.updated_by, updated_at: l.updated_at,
    draft: l.draft, published: l.published,
  });

  // Query: ?slug=a&slug=b (or ?slug=a,b); none lists every listing.
  app.get('/v1/admin/listings', async (c) => {
    await admin(c);
    const wanted = [...new Set((c.req.queries('slug') ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean))];
    const all = db.listings();
    const listings = wanted.length ? all.filter((l) => wanted.includes(l.slug)) : all;
    return c.json({ count: listings.length, missing: wanted.filter((s) => !listings.some((l) => l.slug === s)), listings: listings.map(view) });
  });

  // "Import from the Hugo site prototype": vault-rebuild's migration/games-export.json and import-overrides.json,
  // read from SOURCE/migration/ unless the request carries them (`pages`, `overrides`). `slugs` limits it to those pages.
  app.post('/v1/admin/listings/import', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    const source = baseUrl(body.source, 'source must be the site’s address, starting with https://');
    const only = slugList(body.slugs, 'slugs');
    let pages = body.pages, overrides = body.overrides;
    if (pages === undefined) {
      const doFetch = deps.fetch ?? fetch;
      const read = async (name: string, optional: boolean): Promise<unknown> => {
        const url = `${source}/migration/${name}`;
        let res: Response;
        try { res = await doFetch(url, { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS), redirect: 'follow' }); }
        catch (err) { fail(400, `couldn’t read ${url}: ${(err as Error).message}`); }
        if (res.status === 404 && optional) return undefined;
        if (!res.ok) fail(400, `couldn’t read ${url}: HTTP ${res.status}. Send the export in the request instead (pages, overrides).`);
        return res.json().catch(() => fail(400, `${url} isn’t valid JSON.`));
      };
      pages = await read('games-export.json', false);
      overrides ??= await read('import-overrides.json', true);
    }
    const r = importFromExport(db, pages, overrides, actorOf(id), { only, dryRun: dry });
    const taken = (s: { why: string }) => s.why === 'already has a listing';
    const found = new Set([...r.created, ...r.drafts.map((d) => d.slug), ...r.skipped.map((s) => s.slug)]);
    return c.json({
      dry_run: dry, source,
      created: r.created,                       // created and published
      drafts: r.drafts,                         // created, but not publishable yet (why)
      skipped: r.skipped.filter(taken),
      failed: [...r.skipped.filter((s) => !taken(s)), ...(only ?? []).filter((s) => !found.has(s)).map((slug) => ({ slug, why: 'not in the export' }))],
      studios_created: r.studiosCreated,
    });
  });

  // "Copy site images to the Vault CDN". Safe to repeat: a run that hit its time budget (or was cut off) is
  // continued by running it again, until `remaining` is 0.
  app.post('/v1/admin/listings/migrate-images', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    const base = baseUrl(body.base, 'base must be the site’s address, starting with https://');
    const budget = body.budget_seconds ?? DEFAULT_BUDGET_SECONDS;
    if (typeof budget !== 'number' || !(budget >= 1 && budget <= MAX_BUDGET_SECONDS)) fail(400, `budget_seconds must be a number from 1 to ${MAX_BUDGET_SECONDS}`);
    const r = await copySiteImages(deps, base, actorOf(id), { dryRun: dry, budgetMs: budget * 1000 });
    return c.json({
      dry_run: dry,
      counts: { migrated: r.migrated.length, already: r.already, failed: r.failed.length, external: r.external.length, objects_written: r.objects_written, remaining: r.remaining },
      ...r,
    });
  });

  // "Move a game to another studio".
  app.post('/v1/admin/listings/move', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    if (!isSlug(body.slug)) fail(400, 'slug must be the listing’s page slug');
    if (!isSlug(body.studio)) fail(400, 'studio must be a studio slug');
    const l = db.listing(body.slug);
    if (!l) fail(404, `unknown listing ${body.slug}`);
    const to = db.studioBySlug(body.studio);
    if (!to) fail(404, `unknown studio ${body.studio}`);
    return c.json({ dry_run: dry, moved: moveListingToStudio(db, l, db.studioById(l.studio_id)!, to, actorOf(id), { dryRun: dry }) });
  });

  // Edit listings in bulk: each update's fields replace those fields of the draft, checked as a save is; with
  // publish: true each changed listing is then published. Nothing is written unless every update is acceptable.
  // Publishing puts the whole draft on the site, so a listing with other unpublished draft changes (e.g. a studio's
  // edits waiting for review) is refused unless publish_pending: true.
  app.post('/v1/admin/listings/update', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    if (typeof body.publish !== 'boolean') fail(400, 'publish must be true or false');
    const publish = body.publish;
    if (!Array.isArray(body.updates) || !body.updates.length) fail(400, 'updates must be a non-empty list of { slug, fields }');
    if (body.updates.length > MAX_UPDATES) fail(400, `at most ${MAX_UPDATES} updates at a time`);

    const plans: { l: ListingRow; draft: ListingFields; changed: Field[]; publishes: Field[]; link?: { id: number | null; slug: string | null } }[] = [];
    const bad: { slug: string; problems: string[] }[] = [];
    const seen = new Set<string>();
    body.updates.forEach((u: unknown, i: number) => {
      const { slug, fields = {}, cdn_game: cdnGame } = (u && typeof u === 'object' ? u : {}) as { slug?: unknown; fields?: unknown; cdn_game?: unknown };
      const name = typeof slug === 'string' && slug ? slug : `updates[${i}]`;
      const no = (...problems: string[]) => { bad.push({ slug: name, problems }); };
      if (!isSlug(slug)) return no('slug must be the listing’s page slug.');
      if (seen.has(slug)) return no('Listed more than once.');
      seen.add(slug);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return no('fields must be an object of listing fields.');
      if (!Object.keys(fields).length && cdnGame === undefined) return no('fields must be an object with at least one listing field (or give cdn_game).');
      const l = db.listing(slug);
      if (!l) return no('No such listing.');
      // cdn_game connects the listing to one of its studio's CDN games (as the portal's game page does), checked
      // and written together with the fields, so one update can connect a game and switch it to the CDN.
      let link: { id: number | null; slug: string | null } | undefined;
      if (cdnGame !== undefined) {
        if (cdnGame !== null && cdnGame !== '' && !isSlug(cdnGame)) return no('cdn_game must be a CDN game’s slug, or "" to disconnect.');
        const g = cdnGame ? db.game(l.studio_id, cdnGame as string) : undefined;
        if (cdnGame && !g) return no(`${l.studio_name} has no CDN game “${cdnGame}”.`);
        link = { id: g?.id ?? null, slug: g?.slug ?? null };
        if (link.id === l.game_id) link = undefined;
      }
      const draft = normalize(fields as Record<string, unknown>, l.draft);
      const problems = fieldProblems(fields as Record<string, unknown>, draft);
      if (link && !link.id && (publish ? draft : l.published)?.play_source === 'cdn')
        problems.push('It plays from the Vault CDN; switch it back to its web address (play_source "url") to disconnect it.');
      if (!problems.length) problems.push(...draftProblems(db, link ? { game_id: link.id } : l, draft, publish));
      const pending = changedFields(l.published, l.draft).filter((k) => !(k in (fields as object)));
      if (publish && body.publish_pending !== true && (!l.published || pending.length || l.review === 'submitted')) {
        problems.push(l.published
          ? `Publishing would also put its other unpublished draft changes on the site (${pending.join(', ') || 'submitted for review'}); pass publish_pending: true to publish them too.`
          : 'It isn’t on the site yet, so publishing would add it; pass publish_pending: true to do that.');
      }
      if (problems.length) return no(...problems);
      plans.push({ l, draft, changed: changedFields(l.draft, draft), publishes: publish ? changedFields(l.published, draft) : [], link });
    });
    if (bad.length) fail(400, `${bad.length} of ${body.updates.length} updates can’t be applied; nothing was changed`, bad);

    const todo = plans.filter((p) => p.changed.length || p.publishes.length || p.link);
    if (!dry && todo.length) {
      db.sqlite.exec('BEGIN');
      try {
        for (const p of todo) {
          if (p.link) {
            db.linkListing(p.l.id, p.link.id);
            db.audit(actorOf(id), 'listing.link', `${p.l.studio_slug}:${p.l.slug}`, { game: p.link.slug, via: 'admin task' });
          }
          if (p.changed.length || p.publishes.length) saveListing(db, p.l, p.draft, actorOf(id), publish ? 'publish' : 'save');
        }
        db.sqlite.exec('COMMIT');
      } catch (err) {
        db.sqlite.exec('ROLLBACK');
        throw err;
      }
    }
    const pick = (f: ListingFields, keys: Field[]) => Object.fromEntries(keys.map((k) => [k, f[k]]));
    return c.json({
      dry_run: dry, publish,
      updated: todo.map((p) => ({
        slug: p.l.slug, studio: p.l.studio_slug, changed: p.changed, published: p.publishes,
        ...(p.link ? { cdn_game: { before: p.l.game_id ? db.gameById(p.l.game_id)?.slug ?? null : null, after: p.link.slug } } : {}),
        before: pick(p.l.draft, p.changed), after: pick(p.draft, p.changed),
      })),
      unchanged: plans.filter((p) => !todo.includes(p)).map((p) => p.l.slug),
    });
  });

  // Create Vault-managed studios (no GitHub organization) or change existing studios' names and websites, as
  // Vault → Studios does. A studio is found by its short name (slug); one that doesn't exist is created and needs a
  // name. Listings' "Made by" names are not touched: follow a rename with an `update` of the listings' makers.
  app.post('/v1/admin/studios', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    if (!Array.isArray(body.studios) || !body.studios.length) fail(400, 'studios must be a list of { slug, name?, website? }');
    const all = db.studios();
    const plans = (body.studios as Record<string, unknown>[]).map((raw) => {
      const slug = typeof raw?.slug === 'string' ? raw.slug.trim() : '';
      if (!isSlug(slug)) fail(400, `"${slug}" isn’t a valid short name (lowercase letters, numbers and dashes).`);
      const existing = db.studioBySlug(slug);
      const name = raw.name === undefined ? undefined : String(raw.name).trim();
      if (name !== undefined && (!name || name.length > 100)) fail(400, `${slug}: the name must be 1 to 100 characters.`);
      if (!existing && !name) fail(400, `${slug}: a new studio needs a name.`);
      if (name && all.some((x) => x.slug !== slug && x.name.toLowerCase() === name.toLowerCase())) fail(409, `There’s already a studio named ${name}.`);
      if (existing && name && name !== existing.name && existing.source === 'file') fail(409, `${existing.name}’s name comes from studios.json; change it there.`);
      let website: string | null | undefined;
      if (raw.website !== undefined) { try { website = studioWebsite(raw.website); } catch (err) { fail(400, `${slug}: ${(err as Error).message}`); } }
      return { slug, existing, name, website };
    });
    if (new Set(plans.map((p) => p.slug)).size !== plans.length) fail(400, 'Each studio can be listed once.');
    const out = plans.map((p) => {
      if (!p.existing) {
        if (!dry) {
          db.createStudio({ slug: p.slug, name: p.name!, github_owner: '', github_owner_id: `vault:${p.slug}`, website: p.website ?? null });
          db.audit(actorOf(id), 'studio.create', p.slug, { name: p.name, github: null, website: p.website ?? null, via: 'admin task' });
        }
        return { slug: p.slug, created: true, name: p.name, website: p.website ?? null };
      }
      const changes: Record<string, unknown> = {};
      if (p.name && p.name !== p.existing.name) changes.name = { from: p.existing.name, to: p.name };
      if (p.website !== undefined && (p.website ?? '') !== (p.existing.website ?? '')) changes.website = { from: p.existing.website ?? null, to: p.website };
      if (!dry && Object.keys(changes).length) {
        if (changes.name) db.updateStudio(p.existing.id, { name: p.name!, github_owner: p.existing.github_owner, github_owner_id: p.existing.github_owner_id });
        if (changes.website) db.setStudioWebsite(p.existing.id, p.website ?? null);
        db.audit(actorOf(id), 'studio.update', p.slug, { ...changes, via: 'admin task' });
      }
      return { slug: p.slug, created: false, changes };
    });
    return c.json({ dry_run: dry, studios: out });
  });

  // Delete studios that are completely empty, as Vault → Studios → Delete does, but stricter: besides CDN games
  // (which carry the builds and releases) and site listings, a studio with members, invitations or repositories
  // assigned to it, or one that studios.json defines, is refused. Each studio is checked (a dry run of the removal)
  // before any is removed, so a refusal removes nothing.
  app.post('/v1/admin/studios/remove', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    const slugs = body.slugs;
    if (!Array.isArray(slugs) || !slugs.length || !slugs.every((s) => typeof s === 'string' && isSlug(s))) fail(400, 'slugs must be a non-empty list of studio short names');
    const unique = [...new Set(slugs as string[])];
    const checked = unique.map((slug) => {
      const s = db.studioBySlug(slug);
      if (!s) fail(404, `There’s no studio ${slug}.`);
      if (s.source === 'file') fail(409, `${s.name} is defined in studios.json; remove it there.`);
      try {
        const r = db.removeStudio(s.id, { dryRun: true, actor: actorOf(id) });
        if (r.memberships.length) fail(409, `${s.name} has ${r.memberships.length} member(s) or invitation(s): ${r.memberships.map((m) => m.github_login).join(', ')}.`);
        if (r.repositories.length) fail(409, `${s.name} has repositories assigned: ${r.repositories.map((x) => x.repository).join(', ')}.`);
        return { s, r };
      } catch (err) {
        if (err instanceof StudioNotEmptyError) fail(409, `${s.name} is not empty: ${err.message}`);
        throw err;
      }
    });
    const out = checked.map(({ s, r }) => {
      if (!dry) db.removeStudio(s.id, { actor: actorOf(id) });
      return { slug: s.slug, name: s.name, website: s.website || null, removed: !dry, games: 0, listings: 0, members: 0, repositories: 0, warnings: r.warnings };
    });
    return c.json({ dry_run: dry, studios: out });
  });

  // The home page's Featured Games, as Vault → Game Catalog sets them: the whole list is replaced (games unticked
  // by this are parked, so the portal can bring their blurb and image back). Every game must be a site listing.
  app.post('/v1/admin/featured', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    if (!Array.isArray(body.games)) fail(400, 'games must be a list of { slug, sequence?, blurb?, image? }');
    if (body.games.length > MAX_FEATURED) fail(400, `At most ${MAX_FEATURED} games can be featured.`);
    const games = normalizeFeatured(body.games);
    if (games.length !== body.games.length) fail(400, 'Each game needs a valid, distinct slug.');
    const missing = games.filter((g) => !db.listing(g.slug)).map((g) => g.slug);
    if (missing.length) fail(400, `Not site listings: ${missing.join(', ')}.`);
    const before = readFeatured(db);
    const keep = new Set(games.map((g) => g.slug));
    const unfeatured = [...before.games.filter((g) => !keep.has(g.slug)), ...before.unfeatured.filter((g) => !keep.has(g.slug))];
    if (!dry) {
      saveFeatured(db, { games, unfeatured }, actorOf(id));
      db.audit(actorOf(id), 'featured.set', games.map((g) => g.slug).join(',') || '(none)', { before: before.games.map((g) => g.slug) });
    }
    return c.json({ dry_run: dry, featured: sortFeatured(games), before: sortFeatured(before.games) });
  });

  // Smaller copies of the listing images (image-variants.ts), made by scripts/image-variants.ts. GET says which images
  // need them; POST stores one image's copies (all its widths at once) and records them, so the catalog lists them.
  app.get('/v1/admin/image-variants', async (c) => {
    await admin(c);
    const records = readVariants(db);
    const images = listingImageUrls(db, deps.prodPublicUrl).map((url) => {
      const rec = records[keyOfUrl(url, deps.prodPublicUrl)!];
      return { url, done: !!rec, ...(rec ? { width: rec.w, height: rec.h, widths: rec.widths } : {}) };
    });
    return c.json({ count: images.length, missing: images.filter((i) => !i.done).length, images });
  });

  app.post('/v1/admin/image-variants', async (c) => {
    const id = await admin(c);
    const body = await jsonBody(c);
    const dry = dryRun(body);
    const storage = deps.production;
    if (!storage) fail(503, 'The Vault CDN storage isn’t configured here.');
    const url = typeof body.url === 'string' ? body.url : '';
    const key = keyOfUrl(url, deps.prodPublicUrl);
    if (!key || !isOriginalKey(key)) fail(400, `url must be a listing image on this system’s CDN (${deps.prodPublicUrl}/STUDIO/GAME/_vault-assets/KIND-HASH.EXT)`);
    const { width, height } = body;
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1 || (width as number) > 30_000 || (height as number) > 30_000) fail(400, 'width and height must be the original’s size in pixels');
    const want = variantWidths(width as number);
    if (!Array.isArray(body.variants)) fail(400, 'variants must be a list of { width, webp }');
    const given = new Map<number, Uint8Array>();
    for (const v of body.variants as { width?: unknown; webp?: unknown }[]) {
      if (!v || !Number.isInteger(v.width) || typeof v.webp !== 'string') fail(400, 'each variant needs a width and its WebP bytes (webp, base64)');
      const bytes = new Uint8Array(Buffer.from(v.webp, 'base64'));
      if (bytes.length > MAX_VARIANT_BYTES) fail(413, `the ${v.width}px copy is over ${MAX_VARIANT_BYTES / 1024 / 1024} MB`);
      if (webpWidth(bytes) !== v.width) fail(400, `the ${v.width}px copy isn’t a WebP image ${v.width}px wide`);
      given.set(v.width as number, bytes);
    }
    if (given.size !== want.length || !want.every((w) => given.has(w))) fail(400, `a ${width}px-wide image needs copies ${want.join(', ')}px wide, no others`);
    if (!(await storage.list(key)).some((o) => o.key === key)) fail(404, `${url} isn’t on the CDN`);
    const keys = want.map((w) => variantKey(key, w));
    if (!dry) {
      for (const w of want) {
        const bytes = given.get(w)!;
        await storage.put(variantKey(key, w), bytes, bytes.length, { contentType: 'image/webp', cacheControl: IMAGE_CACHE });
      }
      recordVariants(db, key, { w: width as number, h: height as number, widths: want });
      db.audit(`github:${id.actor}`, 'listing.images.variants', key, { widths: want, bytes: [...given.values()].reduce((n, b) => n + b.length, 0) });
    }
    return c.json({ dry_run: dry, url, widths: want, keys });
  });
}
