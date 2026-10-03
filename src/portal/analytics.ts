// Analytics: plays of the games on the website, from Google Analytics (src/analytics/). Vault staff see the whole
// site (Vault → Analytics, /vault/analytics); a game's page has an Analytics tab with the same view for that game,
// which its studio's members see too. Each view: plays over time with the previous period, plays / players / average
// play time, a realtime map of where people are playing, and for the site its page views, sessions and top games.
// The play events are new; the years before them are page views (and outbound clicks) of the game pages, which have
// had the same addresses since the Squarespace site: the chart and top games fall back to those when there are no plays.
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Analytics, AnalyticsError, type Overview, type Realtime, type Result } from '../analytics/ga.ts';
import { cityPoint } from '../analytics/cities.ts';
import { COUNTRY_POINTS } from '../analytics/countries.ts';
import { MAP_HEIGHT, MAP_WIDTH } from '../analytics/projection.ts';
import { loadLegacy, pagePaths } from '../analytics/pages.ts';
import { averageSeconds, RANGE_KEYS, RANGES, rangeOf, type Pair, type Place, type RangeKey, type Scope, type Series } from '../analytics/reports.ts';
import type { Studio, User } from '../db.ts';
import { html, raw, type Html } from './html.ts';
import type { ListingHelpers, ListingRow } from './listings.ts';
import { head } from './routes.ts';

// ---------- formatting ----------
const nf = new Intl.NumberFormat('en-US');
const num = (n: number) => nf.format(Math.round(n));
export function duration(s: number | null): string {
  if (s === null) return '—';
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60), sec = t % 60;
  if (m < 60) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
// The change from the previous period, as a KPI's second line.
export function delta(cur: number | null, prev: number | null, range: RangeKey): Html {
  const vs = `vs ${RANGES[range].previous}`;
  if (cur === null || prev === null) return html`<div class="d">${prev === null && cur !== null ? `no ${vs.slice(3)} data` : ''}</div>`;
  if (prev === 0) return html`<div class="d">${cur > 0 ? `new; none ${RANGES[range].previous}` : `none ${RANGES[range].previous} either`}</div>`;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) return html`<div class="d">no change ${vs}</div>`;
  const shown = Math.abs(pct) < 10 ? pct.toFixed(1) : String(Math.round(pct));
  return html`<div class="d ${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}">${pct > 0 ? '+' : ''}${shown}% ${vs}</div>`;
}

// ---------- the chart ----------
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  // Tops whose quarters are round numbers, close enough together that the line fills most of the height.
  for (const m of [1, 1.2, 1.4, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
export function chart(s: Series, what = 'plays'): Html {
  const n = s.labels.length;
  const top = niceMax(Math.max(1, ...s.previous, ...s.current.map((v) => v ?? 0)));
  const y = (v: number) => +(100 - (v / top) * 100).toFixed(2);
  const x = (i: number) => i + 0.5;
  const line = (vals: (number | null)[]) => {
    let d = '', pen = false;
    vals.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)} ${y(v)}`; pen = true; });
    return d;
  };
  const lastIdx = s.current.reduce<number>((k, v, i) => (v === null ? k : i), -1);
  const area = lastIdx >= 0 ? `${line(s.current.slice(0, lastIdx + 1))}L${x(lastIdx)} 100L${x(0)} 100Z` : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const every = Math.max(1, Math.ceil(n / 6));
  const xl = s.labels.map((l, i) => ({ l, i })).filter(({ i }) => i % every === 0);
  const def = RANGES[s.range];
  const unit = def.hourly ? 'hour' : def.bucketDays === 7 ? 'week' : 'day';
  return html`<div class="ga-chart" role="img" aria-label="${what[0].toUpperCase()}${what.slice(1)} per ${unit}: ${num(s.totals.current)} in ${def.long.toLowerCase()}, ${num(s.totals.previous)} in ${def.previous}.">
    <div class="ga-plot">
      ${ticks.filter((t) => Number.isInteger(t)).map((t) => html`<span class="ga-yl" style="bottom:${(t / top) * 100}%">${num(t)}</span>`)}
      <svg viewBox="0 0 ${n} 100" preserveAspectRatio="none" aria-hidden="true">
        ${ticks.map((t) => html`<line class="gridl" x1="0" x2="${n}" y1="${y(t)}" y2="${y(t)}" vector-effect="non-scaling-stroke"/>`)}
        <path class="ga-prev" d="${line(s.previous)}" vector-effect="non-scaling-stroke"/>
        ${area ? html`<path class="ga-area" d="${area}"/>` : ''}
        <path class="ga-cur" d="${line(s.current)}" vector-effect="non-scaling-stroke"/>
        ${s.labels.map((l, i) => html`<rect class="ga-hit" x="${i}" y="0" width="1" height="100"><title>${l}: ${s.current[i] === null ? 'later today' : `${num(s.current[i]!)} ${what}`} (${def.previous}: ${num(s.previous[i])})</title></rect>`)}
      </svg>
    </div>
    <div class="ga-x" aria-hidden="true">${xl.map(({ l, i }) => html`<span style="left:${(x(i) / n) * 100}%">${l.replace(/^Week of /, '')}</span>`)}</div>
  </div>`;
}

// ---------- the map ----------
export function placesMap(places: Place[], landUrl: string, what: 'Plays' | 'People on the site' = 'Plays'): Html {
  const verb = what === 'Plays' ? 'playing' : 'on the site';
  // A dot per city (at its country's point when the city isn't known); places on the same point share a dot.
  const dots = new Map<string, { x: number; y: number; users: number; names: string[] }>();
  const byCountry = new Map<string, { users: number; name: string }>();
  for (const p of places) {
    const c = byCountry.get(p.countryId) ?? { users: 0, name: p.country };
    c.users += p.users;
    byCountry.set(p.countryId, c);
    const pt = cityPoint(p.countryId, p.city) ?? COUNTRY_POINTS[p.countryId];
    if (!pt) continue;
    const key = `${pt[0]},${pt[1]}`;
    const d = dots.get(key) ?? { x: pt[0], y: pt[1], users: 0, names: [] };
    d.users += p.users;
    d.names.push(p.city && p.city !== '(not set)' ? `${p.city}, ${p.country}` : p.country);
    dots.set(key, d);
  }
  const max = Math.max(1, ...[...dots.values()].map((d) => d.users));
  const circles = [...dots.values()].sort((a, b) => b.users - a.users).map((d, i) => {
    const r = (3 + 9 * Math.sqrt(d.users / max)).toFixed(1);
    return html`<circle cx="${d.x}" cy="${d.y}" r="${r}" data-r="${r}" style="animation-delay:-${((i * 0.37) % 2.4).toFixed(2)}s"><title>${d.names.slice(0, 4).join('; ')}${d.names.length > 4 ? ` and ${d.names.length - 4} more` : ''}: ${num(d.users)} ${verb}</title></circle>`;
  });
  return html`<div class="ga-map" style="aspect-ratio:${MAP_WIDTH}/${MAP_HEIGHT}" data-map="${MAP_WIDTH} ${MAP_HEIGHT}">
    <svg viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-label="${places.length ? `${what} in the last 30 minutes, by country: ${[...byCountry.values()].map((c) => `${c.name} ${c.users}`).join(', ')}` : `No ${what.toLowerCase()} in the last 30 minutes`}">
      <mask id="ga-land-mask" style="mask-type:alpha"><image href="${landUrl}" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" preserveAspectRatio="none"/></mask>
      <rect class="ga-land" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" mask="url(#ga-land-mask)"/>
      <g class="ga-dots">${circles}</g>
    </svg>
    <div class="ga-zoom" hidden><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="reset" aria-label="Whole world">⟲</button></div>
  </div>`;
}

// ---------- errors ----------
const CONNECTION = new Set(['not_connected', 'denied', 'api_disabled']);
function problem(e: AnalyticsError, staff: boolean, what = ''): Html {
  const text: Record<AnalyticsError['kind'], string> = {
    not_connected: 'Analytics isn’t connected: this portal has no Google Analytics property to read (GA_PROPERTY_ID), or no Google credentials.',
    denied: 'Analytics isn’t connected: this portal’s service account doesn’t have access to the Google Analytics property yet.',
    api_disabled: 'Analytics isn’t connected: the Google Analytics Data API isn’t enabled in the service account’s Google Cloud project.',
    setup: `Google Analytics doesn’t know the play events’ custom definitions yet${what ? `, so ${what}` : ''}.`,
    failed: `Google Analytics couldn’t answer${what ? ` for ${what}` : ''}.`,
  };
  if (!staff && CONNECTION.has(e.kind)) return html`<p class="fix">Analytics isn’t connected yet: Vault hasn’t given the portal access to Google Analytics.</p>`;
  return html`<p class="fix">${text[e.kind]}${staff && e.kind !== 'failed' ? html` See <span class="mono">docs/analytics.md</span>.` : ''}${staff ? html`<br><span class="small muted">${e.message}</span>` : ''}</p>`;
}
const firstError = (...rs: (Result<unknown> | null)[]) => rs.find((r): r is { ok: false; error: AnalyticsError } => !!r && !r.ok)?.error ?? null;

// ---------- a view ----------
interface ViewOpts { timeZone: string; scope: Scope; range: RangeKey; staff: boolean; base: string; realtimeUrl: string; assets: Assets; titleOf(slug: string): { title: string; href: string | null } }
interface Assets { css: string; js: string; land: string }

function rangeBar(base: string, range: RangeKey): Html {
  const sep = base.includes('?') ? '&' : '?';
  return html`<div class="seg ga-range" role="group" aria-label="Time range">${RANGE_KEYS.map((k) => html`<a href="${base}${sep}range=${k}" class="${k === range ? 'on' : ''}" title="${RANGES[k].long}" ${k === range ? raw('aria-current="true"') : ''}>${RANGES[k].label}</a>`)}</div>`;
}

const kpi = (label: string, value: string, d: Html, title = '') => html`<div class="kpi" ${title ? raw(`title="${title.replace(/"/g, '&quot;')}"`) : ''}><div class="v">${value}</div><div class="l">${label}</div>${d}</div>`;

export function realtimeBody(rt: Realtime, o: { staff: boolean; land: string; game: boolean }): Html {
  if (!rt.places.ok) return problem(rt.places.error, o.staff, rt.places.error.kind === 'setup' ? 'it can’t tell which game people are playing (the user dimension vault_game)' : rt.who === 'visitors' ? 'realtime users' : 'realtime plays');
  const places = rt.places.value;
  const total = places.reduce((s, p) => s + p.users, 0);
  const visitors = rt.who === 'visitors';
  const rows = places.slice(0, 8).map((p) => html`<tr><td>${p.city && p.city !== '(not set)' ? html`${p.city}, ` : ''}${p.country || 'Unknown'}</td><td class="r num">${num(p.users)}</td></tr>`);
  const summary = visitors
    ? html`${rt.visitors?.ok && rt.visitors.value ? html`<b>${num(rt.visitors.value)}</b> ${rt.visitors.value === 1 ? 'person' : 'people'} on the site in the last 30 minutes.` : html`<span class="muted">No one has been on the site in the last 30 minutes.</span>`}
      ${rt.playing?.ok ? html` <span class="muted">${num(rt.playing.value)} playing a game.</span>` : ''}`
    : html`${total ? html`<b>${num(total)}</b> ${total === 1 ? 'person' : 'people'} playing${o.game ? ' this game' : ''} in the last 30 minutes.` : html`<span class="muted">No one has played${o.game ? ' this game' : ''} in the last 30 minutes.</span>`}
      ${rt.visitors?.ok ? html` <span class="muted">${num(rt.visitors.value)} on the site.</span>` : ''}`;
  return html`${placesMap(places, o.land, visitors ? 'People on the site' : 'Plays')}
    <p class="small">${summary}</p>
    ${rows.length ? html`<div class="tbl-wrap"><table class="ga-places"><thead><tr><th>Where</th><th class="r">${visitors ? 'On the site' : 'Playing'}</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
}

export function view(ov: Overview, rt: Realtime, o: ViewOpts): Html {
  const def = RANGES[ov.range];
  const assets = html`<link rel="stylesheet" href="${o.assets.css}"><script src="${o.assets.js}" defer></script>`;
  const bar = rangeBar(o.base, ov.range);
  // Not connected at all: say so once, rather than an empty chart and a row of dashes.
  const conn = [ov.series, ov.plays, ov.players].every((r) => !r.ok && CONNECTION.has(r.error.kind)) ? firstError(ov.series) : null;
  if (conn) return html`${assets}<div class="card ga-off">${problem(conn, o.staff)}${o.staff ? '' : html`<p class="small muted">Ask Vault about it.</p>`}</div>`;

  // No plays in either period (before the play events): the chart shows page views instead, if there are any.
  const noPlays = ov.series.ok && !ov.series.value.totals.current && !ov.series.value.totals.previous;
  const byViews = noPlays && ov.views.ok && (ov.views.value.totals.current > 0 || ov.views.value.totals.previous > 0);
  const s = byViews ? ov.views : ov.series;
  const chartCard = html`<div class="card ga-top">
    <h2><span>${byViews ? 'Page views' : 'Plays'} <small>${def.long} · ${s.ok ? html`<b class="ga-tot">${num(s.value.totals.current)}</b>, ${def.previous} ${num(s.value.totals.previous)}` : ''}</small></span>${bar}</h2>
    ${s.ok ? html`${chart(s.value, byViews ? 'page views' : 'plays')}<div class="ga-legend small"><span class="k cur"></span>${def.long}<span class="k prev"></span>${def.previous[0].toUpperCase()}${def.previous.slice(1)}</div>
      ${byViews ? html`<p class="small muted">No plays recorded in this range: the site has only just begun sending play events, so this is page views of ${o.scope.game ? 'the game’s page' : 'the site'}, which go back years (the Squarespace site had the same addresses).</p>` : ''}`
      : problem(s.error, o.staff, 'the chart')}
  </div>`;

  const p = ov.plays.ok ? ov.plays.value : null;
  const avgCur = p && p.timed ? averageSeconds(p.current) : null, avgPrev = p && p.timed ? averageSeconds(p.previous) : null;
  const players = ov.players.ok ? ov.players.value : null;
  const avgNote = !p ? '' : !p.timed ? 'Needs the custom definitions in Google Analytics.'
    : avgCur === null ? 'No timed plays in this range yet. Only plays since the game pages began sending play events are timed.' : '';
  const kpis = html`<div class="kpis ga-k3" aria-label="Plays, ${def.long.toLowerCase()}">
      ${kpi('Plays', p ? num(p.current.plays) : '—', p ? delta(p.current.plays, p.previous.plays, ov.range) : html`<div class="d"></div>`, 'A play: the game opened from its page on the site (in the player, or in a new tab)')}
      ${kpi('Unique players', players ? num(players.current) : '—', players ? delta(players.current, players.previous, ov.range) : html`<div class="d"></div>`, 'People (browsers) who started at least one play')}
      ${kpi('Average play time', duration(avgCur), avgNote ? html`<div class="d">${avgNote}</div>` : delta(avgCur, avgPrev, ov.range), 'Time the game was open in the player with the page on screen, per play in the player. Games opened in a new tab can’t be timed.')}
    </div>
    ${!ov.plays.ok ? problem(ov.plays.error, o.staff, o.scope.game ? 'this game’s plays can’t be counted' : 'plays') : ''}
    ${!ov.players.ok && ov.plays.ok ? problem(ov.players.error, o.staff, 'players') : ''}`;

  // A game's page: its views, visitors and outbound clicks, back through the Squarespace years.
  let page: Html | string = '';
  if (ov.pages) {
    const pv = ov.pages.ok ? ov.pages.value : null;
    const k = (label: string, v: Pair | null, title: string) => kpi(label, v ? num(v.current) : '—', v ? delta(v.current, v.previous, ov.range) : html`<div class="d"></div>`, title);
    page = html`<h3 class="sec">The game’s page <small class="muted small">${def.long} · counted since the Squarespace site, before the play events</small></h3>
      <div class="kpis ga-k3">${k('Page views', pv?.views ?? null, 'Views of the game’s page on vaultlearninggames.org (its address on the Squarespace site too)')}${k('Visitors', pv?.visitors ?? null, 'People (browsers) who viewed the game’s page')}${k('Play-button clicks', pv?.clicks ?? null, 'Outbound link clicks on the game’s page (Google Analytics enhanced measurement). The old site’s Play button linked out to the game, so before the play events these are mostly plays; they also count other links out, such as curriculum.')}</div>
      <p class="small muted">Play-button clicks: outbound clicks from the game’s page.</p>
      ${!ov.pages.ok ? problem(ov.pages.error, o.staff, 'the game’s page') : ''}`;
  }

  let site: Html | string = '';
  if (ov.site) {
    const sv = ov.site.ok ? ov.site.value : null;
    const pair = (k: 'screenPageViews' | 'sessions' | 'totalUsers') => (sv ? sv[k] : null);
    const k = (label: string, v: Pair | null, title: string) => kpi(label, v ? num(v.current) : '—', v ? delta(v.current, v.previous, ov.range) : html`<div class="d"></div>`, title);
    site = html`<h3 class="sec">The website <small class="muted small">${def.long}</small></h3>
      <div class="kpis ga-k3">${k('Page views', pair('screenPageViews'), 'Every page shown on the site')}${k('Sessions', pair('sessions'), 'Visits to the site')}${k('Visitors', pair('totalUsers'), 'People (browsers) who visited')}</div>
      ${!ov.site.ok ? problem(ov.site.error, o.staff, 'the website’s visits') : ''}`;
  }

  const realtime = html`<div class="card ga-rt"><h2><span class="live-dot">${o.scope.game ? 'Playing now' : 'On the site now'}</span><small>last 30 minutes · updates every minute</small></h2>
    <div data-realtime="${o.realtimeUrl}">${realtimeBody(rt, { staff: o.staff, land: o.assets.land, game: !!o.scope.game })}</div></div>`;

  let top: Html | string = '';
  const name = (slug: string) => { const t = o.titleOf(slug); return html`<td class="proj">${t.href ? html`<a href="${t.href}"><b>${t.title}</b></a>` : html`<b>${t.title}</b>`}<span>${slug}</span></td>`; };
  const tp = ov.topPages;
  if (!o.scope.game && tp && (!p || !p.games.length)) {
    // No game has plays (yet): the games whose pages were viewed most.
    const rows = tp.ok ? tp.value.slice(0, 10).map((g) => html`<tr>${name(g.slug)}<td class="r num">${num(g.views)}</td><td class="r num">${num(g.clicks)}</td></tr>`) : [];
    top = html`<div class="card ga-games"><h2>Top games <small>by page views, ${def.long.toLowerCase()}</small></h2>
      ${!tp.ok ? problem(tp.error, o.staff, 'the game pages')
        : rows.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th class="r">Page views</th><th class="r" title="Outbound link clicks from the game’s page: the old site’s Play button linked out to the game">Play-button clicks</th></tr></thead><tbody>${rows}</tbody></table></div>
          <p class="small muted">No plays by game yet${p && !p.timed ? ' (Google Analytics doesn’t know the custom dimension game_slug yet)' : ''}, so these are views of each game’s page. Play-button clicks: outbound clicks from the game’s page.</p>`
        : html`<p class="small muted">No views of game pages in this range.</p>`}</div>`;
  } else if (!o.scope.game && p) {
    const rows = p.games.slice(0, 10).map((g) => html`<tr>${name(g.slug)}<td class="r num">${num(g.plays)}</td><td class="r num">${duration(averageSeconds(g))}</td></tr>`);
    top = html`<div class="card ga-games"><h2>Top games <small>by plays, ${def.long.toLowerCase()}</small></h2>
      ${!p.timed ? html`<p class="small muted">Games can be told apart once the custom dimension game_slug is registered in Google Analytics.</p>`
        : rows.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th class="r">Plays</th><th class="r">Avg time</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<p class="small muted">No plays in this range yet.</p>`}</div>`;
  }

  return html`${assets}<div class="ga">${chartCard}${kpis}${page}
    <div class="grid ${top ? 'ga-split' : ''}">${realtime}${top}</div>${site}
    <p class="small muted ga-foot">From Google Analytics (the site’s ${p && !p.timed ? 'page views and play counts' : 'play events'}; days are ${o.timeZone.replace(/_/g, ' ')} days). Figures are cached for up to 10 minutes; the realtime map for a minute.</p></div>`;
}

// ---------- routes ----------
export function registerAnalytics(app: Hono, h: ListingHelpers, analytics: Analytics) {
  const { db } = h;
  const file = (name: string) => readFileSync(fileURLToPath(new URL(`../../public/${name}`, import.meta.url)));
  const css = file('analytics.css'), js = file('analytics.js'), land = file('world-map.svg');
  const v = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 10);
  const assets: Assets = { css: `/assets/analytics.css?v=${v(css)}`, js: `/assets/analytics.js?v=${v(js)}`, land: `/assets/world-map.svg?v=${v(land)}` };
  const immutable = 'public, max-age=31536000, immutable';
  app.get('/assets/analytics.css', (c) => c.body(css, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': immutable }));
  app.get('/assets/analytics.js', (c) => c.body(js, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': immutable }));
  app.get('/assets/world-map.svg', (c) => c.body(land, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': immutable }));

  // Which listings a person may see analytics for: Vault staff any; studio members their own studio's.
  const canSeeGame = (u: User, l: ListingRow) => h.isStaff(u) || !!h.roleIn(u, db.studioById(l.studio_id)!);
  // Each game's page paths on the site, for its page views (the Squarespace addresses come from the site's data).
  const legacy = loadLegacy();
  const catalog = () => Object.fromEntries((db.listings({ published: true }) as ListingRow[]).map((l) => [l.slug, pagePaths(l.slug, legacy)]));
  const titleOf = (u: User) => (slug: string) => {
    const l = db.listing(slug) as ListingRow | undefined;
    return l ? { title: l.published?.title || l.draft.title || slug, href: canSeeGame(u, l) ? `/s/${l.studio_slug}/g/${slug}?tab=analytics` : null } : { title: slug, href: null };
  };

  async function render(u: User, scope: Scope, range: RangeKey, base: string) {
    const realtimeUrl = `/portal/analytics/realtime${scope.game ? `?game=${encodeURIComponent(scope.game)}` : ''}`;
    const all = catalog();
    const [ov, rt] = await Promise.all([analytics.overview(range, scope.game ? { ...scope, pages: all[scope.game] ?? pagePaths(scope.game, legacy) } : scope, all), analytics.realtime(scope)]);
    return view(ov, rt, { timeZone: analytics.timeZone, scope, range, staff: h.isStaff(u), base, realtimeUrl, assets, titleOf: titleOf(u) });
  }

  app.get('/vault/analytics', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const range = rangeOf(c.req.query('range'));
    const body = await render(u, {}, range, '/vault/analytics');
    return h.page(c, 'Analytics', html`${head('Analytics', 'Plays of the games on vaultlearninggames.org, and visits to the site. Each game’s page in the portal has the same view for that game.')}${body}`, { active: 'analytics' });
  });

  // The realtime card's contents, for the page's script to refresh every minute.
  app.get('/portal/analytics/realtime', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    const slug = c.req.query('game');
    if (slug) {
      const l = db.listing(slug) as ListingRow | undefined;
      if (!l || !canSeeGame(u, l)) return c.text('Not found', 404);
    } else if (!h.isStaff(u)) return c.text('Only Vault staff can see this.', 403);
    const rt = await analytics.realtime(slug ? { game: slug } : {});
    return c.html(realtimeBody(rt, { staff: h.isStaff(u), land: assets.land, game: !!slug }).toString(), 200, { 'Cache-Control': 'no-store' });
  });

  return {
    // A game's Analytics tab (routes.ts): its listing's plays. A game that isn't on the site has none.
    async gameTab(u: User, s: Studio, l: ListingRow | null, query: { range?: string }): Promise<Html> {
      if (!l) return html`<div class="card"><p class="muted">This game isn’t on the site, so there are no plays to show. Analytics count plays from a game’s page on vaultlearninggames.org.</p></div>`;
      const range = rangeOf(query.range);
      const body = await render(u, { game: l.slug }, range, `/s/${s.slug}/g/${l.slug}?tab=analytics`);
      return html`${l.published ? '' : html`<p class="small muted">This game isn’t published on the site yet.</p>`}${body}`;
    },
  };
}

export { Analytics };
