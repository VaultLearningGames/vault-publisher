// The live panel, under the analytics map: the games being played and the blog posts being read in the last 30
// minutes, from the same Google Analytics realtime reports as the map (src/analytics/ga.ts, Analytics.live). The site
// view (Vault staff) has both lists; a studio's view its games only (the blog's figures are Vault staff's). The page
// renders it (liveCard) and its script (public/analytics.js) refreshes it every minute from
// GET /api/analytics/realtime (registered in analytics.ts), which answers getRealtimeActivity's JSON.
import type { Analytics, AnalyticsError } from '../analytics/ga.ts';
import { REALTIME_MAX_MINUTES } from '../analytics/reports.ts';
import { html, type Html } from './html.ts';

// Each list shows this many rows, then "and N more".
export const LIVE_ROWS = 10;
export interface LiveRow { slug: string; title: string; href: string | null; active: number; events: number }
export interface RealtimeActivity {
  generatedAt: string;          // ISO, UTC
  windowMinutes: number;
  games: LiveRow[];             // active: people playing it; events: plays started. Most active first, at most LIVE_ROWS
  blogs: LiveRow[];             // active: readers; events: opens. [] when the viewer can't see the blog's figures
  gamesTotal: number;           // all the games being played (games has the first LIVE_ROWS)
  blogsTotal: number;
  errors: { games?: string; plays?: string; blogs?: string };   // what Google Analytics couldn't answer (its error kind)
}

// ?minutes= of the API: absent, the 30 minutes; a whole number from 1 to 120, that many minutes, at most the 30
// realtime reports reach back; anything else, null (the API answers 400).
export function windowParam(v: string | undefined): number | null {
  if (v === undefined) return REALTIME_MAX_MINUTES;
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 120 ? Math.min(n, REALTIME_MAX_MINUTES) : null;
}

// games: a studio's games, or null for every game. titles: the blog posts' titles by slug, or null when the viewer
// may not see the blog (then blogs is []). gameTitle: a game's title and its Analytics tab (null when the viewer
// can't open it); a game no longer in the portal is its slug.
export async function getRealtimeActivity(analytics: Analytics, o: {
  now: Date; windowMinutes?: number; games: string[] | null; titles: Promise<Map<string, string>> | null
  gameTitle(slug: string): { title: string; href: string | null };
}): Promise<RealtimeActivity> {
  const windowMinutes = Math.min(o.windowMinutes ?? REALTIME_MAX_MINUTES, REALTIME_MAX_MINUTES);
  const live = await analytics.live(o.games, windowMinutes, o.titles);
  const titles = o.titles ? await o.titles.catch(() => new Map<string, string>()) : new Map<string, string>();
  const games = live.games.ok ? live.games.value : [], blogs = live.blogs?.ok ? live.blogs.value : [];
  const errors: RealtimeActivity['errors'] = {};
  const kind = (r: { ok: boolean; error?: AnalyticsError } | null) => (r && !r.ok ? r.error!.kind : undefined);
  if (kind(live.games)) errors.games = kind(live.games);
  else if (kind(live.plays)) errors.plays = kind(live.plays);
  if (kind(live.blogs)) errors.blogs = kind(live.blogs);
  return {
    generatedAt: o.now.toISOString(), windowMinutes,
    games: games.slice(0, LIVE_ROWS).map((g) => ({ ...g, ...o.gameTitle(g.slug) })),
    blogs: blogs.slice(0, LIVE_ROWS).map((b) => ({ ...b, title: titles.get(b.slug) || b.slug, href: null })),
    gamesTotal: games.length, blogsTotal: blogs.length, errors,
  };
}

// ---------- the panel ----------
const nf = new Intl.NumberFormat('en-US');
const clock = (iso: string, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

function list(heading: string, cols: [string, string, string], rows: LiveRow[], total: number, failed: string | undefined, noEvents = false): Html {
  const more = total - rows.length;
  return html`<div class="ga-live-list"><h3>${heading}</h3>${failed
    ? html`<p class="small muted">Google Analytics couldn’t answer.</p>`
    : rows.length ? html`<div class="tbl-wrap"><table><thead><tr><th>${cols[0]}</th><th class="r">${cols[1]}</th><th class="r">${cols[2]}</th></tr></thead><tbody>${rows.map((r) => html`<tr data-slug="${r.slug}"><td class="proj">${r.href ? html`<a href="${r.href}"><b>${r.title}</b></a>` : html`<b>${r.title}</b>`}</td><td class="r num">${nf.format(r.active)}</td><td class="r num">${noEvents ? '—' : nf.format(r.events)}</td></tr>`)}</tbody></table></div>${more > 0 ? html`<p class="small muted ga-live-more">and ${nf.format(more)} more</p>` : ''}`
      : html`<p class="small muted">None right now.</p>`}</div>`;
}

// The panel's body (public/analytics.js builds the same from the API's JSON). blog: whether the blog's list is shown.
export function liveBody(a: RealtimeActivity, blog: boolean): Html {
  if (!a.gamesTotal && !a.blogsTotal && !a.errors.games && !a.errors.blogs) return html`<p class="small muted ga-live-empty">No activity in the last ${a.windowMinutes} minutes</p>`;
  return html`<div class="ga-live-lists${blog ? '' : ' one'}">
    ${list('Games being played', ['Game', 'Playing', 'Plays'], a.games, a.gamesTotal, a.errors.games, !!a.errors.plays)}
    ${blog ? list('Blog posts being read', ['Post', 'Readers', 'Reads'], a.blogs, a.blogsTotal, a.errors.blogs) : ''}
  </div>`;
}

// The card, right under the map's. url: the API's address for this view (the script refreshes from it).
export function liveCard(a: RealtimeActivity, o: { url: string; blog: boolean; timeZone: string }): Html {
  return html`<section id="analytics-realtime" class="card ga-live" data-live="${o.url}" data-blog="${o.blog ? '1' : ''}" aria-labelledby="ga-live-h">
    <h2 id="ga-live-h"><span class="live-dot">Live: ${o.blog ? 'games and blog posts' : 'games'} in use</span><small>last ${a.windowMinutes} minutes · <span data-live-updated>Updated <time datetime="${a.generatedAt}">${clock(a.generatedAt, o.timeZone)}</time></span><span class="ga-live-err" data-live-error hidden> · Couldn’t refresh</span></small></h2>
    <div data-live-body>${liveBody(a, o.blog)}</div>
  </section>`;
}
