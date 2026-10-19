// The blog's end-to-end check on staging, with a real Vault admin session: the portal's editor commits to vault-site,
// the site's workflow rebuilds staging, and the built site shows what the editor did. Opt-in; never run against
// production (it refuses a site or portal address without "staging" in it, unless --allow-any-host).
//
//   STAGING_PORTAL_URL=https://portal-staging.example STAGING_SITE_URL=https://vaultlearninggames-staging.org \
//   STAGING_SESSION_COOKIE=<the vault_session cookie of a signed-in Vault admin> node scripts/staging-blog-e2e.ts
//     [--keep] [--timeout-min 20] [--allow-any-host]
//
// What it does (docs/runbooks/blog-staging-e2e.md says how to run it and what to check by hand):
//   1. GET /portal/blog: the posts list answers 200 for the admin, with the New post link.
//   2. A new post (GET /portal/blog/new), an image uploaded to it, then Publish with the image, two tags and an author.
//   3. A second post published as unlisted (private).
//   4. Waits for the site: the post on /blog/, its page, its tag page, /blog/rss.xml and the tag's rss.xml; the unlisted
//      post has its page but is on none of those.
//   5. Renames the first post's slug and waits until the old address redirects to the new one.
//   6. Deletes both posts (unless --keep), so staging is left as it was.
// Exits 0 when every step passed, 1 when one failed, 2 on bad usage (the environment variables missing).
import { parseArgs } from 'node:util';
import { SESSION_COOKIE } from '../src/portal/session.ts';

export interface E2eConfig { portal: string; site: string; cookie: string; keep: boolean; timeoutMs: number; pollMs: number }

// The configuration from the environment, or null when it isn't all there (the check is then skipped).
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<E2eConfig, 'keep' | 'timeoutMs' | 'pollMs'> | null {
  const portal = env.STAGING_PORTAL_URL?.trim(), site = env.STAGING_SITE_URL?.trim(), cookie = env.STAGING_SESSION_COOKIE?.trim();
  if (!portal || !site || !cookie) return null;
  return { portal: portal.replace(/\/+$/, ''), site: site.replace(/\/+$/, ''), cookie };
}

// Whether an address looks like staging (the check writes real commits to vault-site's main; staging only).
export const isStagingUrl = (u: string) => { try { return /staging/i.test(new URL(u).hostname); } catch { return false; } };

// A 1x1 PNG, the uploaded image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

type Step = { name: string; ok: boolean; detail?: string };

export async function run(cfg: E2eConfig, log: (s: string) => void = console.log): Promise<Step[]> {
  const steps: Step[] = [];
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ...(detail ? { detail } : {}) });
      log(`ok   ${name}${detail ? `: ${detail}` : ''}`);
      return true;
    } catch (err) {
      steps.push({ name, ok: false, detail: (err as Error).message });
      log(`FAIL ${name}: ${(err as Error).message}`);
      return false;
    }
  };
  const cookie = `${SESSION_COOKIE}=${cfg.cookie}`;
  const portal = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    headers.set('X-Requested-With', 'vault-portal');
    let body = init.body;
    if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(init.json); }
    return fetch(`${cfg.portal}${path}`, { ...init, headers, body, redirect: 'manual' });
  };
  const json = async (r: Response, what: string) => {
    if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<Record<string, any>>;
  };
  const siteText = async (path: string) => {
    const r = await fetch(`${cfg.site}${path}${path.includes('?') ? '&' : '?'}e2e=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    return { status: r.status, text: r.status === 200 ? await r.text() : '' };
  };
  // Polls until check() passes (the site's workflow takes minutes to rebuild and publish).
  const waitFor = async (what: string, check: () => Promise<boolean>) => {
    const end = Date.now() + cfg.timeoutMs;
    for (;;) {
      if (await check().catch(() => false)) return;
      if (Date.now() > end) throw new Error(`timed out after ${Math.round(cfg.timeoutMs / 60000)} min waiting for ${what}`);
      await new Promise((r) => setTimeout(r, cfg.pollMs));
    }
  };

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const tag = `e2e-${stamp}`;
  const title = `E2E check ${stamp}`, unlistedTitle = `E2E unlisted ${stamp}`;
  const created: { slug: string; sha: string }[] = [];
  let slug = '', sha = '', unlisted = '', imageFile = '';

  await step('posts list answers the admin', async () => {
    const r = await portal('/portal/blog');
    if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.status === 302 ? ' (sign-in: the session cookie is not valid here)' : ''}`);
    const page = await r.text();
    if (!page.includes('href="/portal/blog/new"')) throw new Error('no New post link');
    if (!page.includes('href="/portal/blog"')) throw new Error('no Blog link in the nav');
  });

  const ok = await step('create and publish a post with an image, tags and an author', async () => {
    const r = await portal('/portal/blog/new');
    const m = /\/portal\/blog\/edit\/([a-z0-9-]+)/.exec(r.headers.get('location') ?? '');
    if (r.status !== 302 || !m) throw new Error(`new post: HTTP ${r.status}`);
    slug = m[1];
    const form = new FormData();
    form.set('file', new Blob([PNG], { type: 'image/png' }), 'e2e.png');
    const img = await json(await portal(`/portal/api/blog/${slug}/images`, { method: 'POST', body: form }), 'image upload');
    const pub = await json(await portal(`/portal/blog/${slug}/publish`, {
      method: 'POST',
      json: {
        sha: null, title, author: 'Vault E2E', tags: [tag, 'E2E'], featured_image: img.url, excerpt: 'An end-to-end check of the blog.',
        blocks: [{ type: 'paragraph', children: [{ text: `Written by scripts/staging-blog-e2e.ts at ${stamp}.` }] }, { type: 'image', src: img.url, alt: 'A test pixel' }],
      },
    }), 'publish');
    sha = pub.post.sha;
    imageFile = String(img.key).split('/').pop() ?? '';
    created.push({ slug, sha });
    return `/blog/${slug}/`;
  });

  await step('publish an unlisted post', async () => {
    const pub = await json(await portal('/portal/api/blog/posts', {
      method: 'POST', json: { title: unlistedTitle, author: 'Vault E2E', tags: [tag], status: 'private', blocks: [{ type: 'paragraph', children: [{ text: 'Unlisted.' }] }] },
    }), 'create unlisted');
    unlisted = pub.post.slug;
    created.push({ slug: unlisted, sha: pub.post.sha });
    return `/blog/${unlisted}/`;
  });

  if (ok) {
    await step('the post page is built', () => waitFor(`/blog/${slug}/`, async () => (await siteText(`/blog/${slug}/`)).text.includes(title)));
    for (const [name, path] of [['on /blog/', '/blog/'], ['on its tag page', `/blog/tag/${tag}/`], ['in /blog/rss.xml', '/blog/rss.xml'], ['in the tag feed', `/blog/tag/${tag}/rss.xml`]]) {
      await step(`the post is ${name}`, () => waitFor(path, async () => (await siteText(path)).text.includes(title)));
    }
    await step('the post page shows its image, author and tags', async () => {
      const { text } = await siteText(`/blog/${slug}/`);
      for (const want of ['Vault E2E', `/blog/tag/${tag}/`]) if (!text.includes(want)) throw new Error(`no "${want}" on the page`);
      if (!imageFile || !text.includes(imageFile)) throw new Error('the uploaded image is not on the page');
    });
  }
  if (unlisted) {
    await step('the unlisted post has its page', () => waitFor(`/blog/${unlisted}/`, async () => (await siteText(`/blog/${unlisted}/`)).text.includes(unlistedTitle)));
    await step('the unlisted post is on no list, tag page or feed', async () => {
      for (const path of ['/blog/', `/blog/tag/${tag}/`, '/blog/rss.xml', `/blog/tag/${tag}/rss.xml`]) {
        if ((await siteText(path)).text.includes(unlistedTitle)) throw new Error(`it is on ${path}`);
      }
    });
  }

  if (ok) {
    const renamed = `${slug}-renamed`;
    const moved = await step('rename the post’s slug', async () => {
      const r = await json(await portal(`/portal/blog/${slug}`, { method: 'PUT', json: { sha, slug: renamed } }), 'rename');
      created[0] = { slug: renamed, sha: r.post.sha };
    });
    if (moved) {
      await step('the old address redirects to the new one', () => waitFor(`/blog/${slug}/ -> /blog/${renamed}/`, async () => {
        const r = await fetch(`${cfg.site}/blog/${slug}/`, { redirect: 'manual' });
        if (r.status >= 300 && r.status < 400) return (r.headers.get('location') ?? '').includes(`/blog/${renamed}/`);
        // Hugo's alias page: a meta refresh to the new address.
        return r.status === 200 && new RegExp(`http-equiv="refresh"[^>]+/blog/${renamed}/`).test(await r.text());
      }));
    }
  }

  if (!cfg.keep) {
    for (const p of created) {
      await step(`delete /blog/${p.slug}/`, async () => {
        const cur = await json(await portal(`/portal/api/blog/posts/${p.slug}`), 'load');
        await json(await portal(`/portal/api/blog/posts/${p.slug}?sha=${cur.post.sha}`, { method: 'DELETE' }), 'delete');
      });
    }
  }
  return steps;
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { keep: { type: 'boolean' }, 'timeout-min': { type: 'string' }, 'allow-any-host': { type: 'boolean' } } });
  const env = configFromEnv();
  if (!env) {
    console.error('Set STAGING_PORTAL_URL, STAGING_SITE_URL and STAGING_SESSION_COOKIE (see docs/runbooks/blog-staging-e2e.md).');
    return 2;
  }
  if (!values['allow-any-host'] && !(isStagingUrl(env.portal) && isStagingUrl(env.site))) {
    console.error('Refusing: the portal and site addresses must be staging ones (--allow-any-host to override).');
    return 2;
  }
  const minutes = Number(values['timeout-min'] ?? 20);
  const steps = await run({ ...env, keep: !!values.keep, timeoutMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 20) * 60_000, pollMs: 15_000 });
  const failed = steps.filter((s) => !s.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} steps passed.`);
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
