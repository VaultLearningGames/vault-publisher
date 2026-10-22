// Analytics: plays of the games on the website, from Google Analytics (src/analytics/). Vault staff see the whole
// site (Vault → Analytics, /vault/analytics); each studio has an Analytics page for all its games (/s/STUDIO/analytics)
// and each game's page an Analytics tab, with the same view, which the studio's members (viewers too) see. Each view:
// a date range picked the way Google Analytics' picker does it (presets, a custom range, compare with the period
// before), a top row of figures — the site's: unique users, plays, pages per user, blog reads and average play time;
// a studio's or a game's: plays and average play time — above a chart of plays and users (and for the site, blog
// reads), a realtime map of where people are playing, top games (site and studio), and for the site the blog's top
// posts. A game's (a studio's) sessions and users are visits that showed its page or started one of its plays.
// The site view's top posts are the blog's (Vault staff only): each post's opens, readers, average time on screen
// and its share clicks (by network).
// The play events began on PLAYS_SINCE: before it there are no plays (the page says so), but sessions, users, page
// views and outbound clicks of the game pages go back through the Squarespace years (the same addresses): the top
// games fall back to page views when there are no plays.
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Analytics, AnalyticsError, type BlogStats, type Overview, type Realtime, type Result, type ShareStats } from '../analytics/ga.ts';
import { cityPoint } from '../analytics/cities.ts';
import { COUNTRY_POINTS } from '../analytics/countries.ts';
import { MAP_HEIGHT, MAP_WIDTH } from '../analytics/projection.ts';
import { loadLegacy, pagePaths } from '../analytics/pages.ts';
import { averageSeconds, longDate, minSec, perReader, PLAYS_SINCE, PRESETS, presetPeriods, SHARE_NETWORKS, spanLabel, topPagesTotals, type GamePages, type GamePlays, type NetworkCounts, type Pair, type Place, type Scope, type Selection, type Series } from '../analytics/reports.ts';
import { SiteBlogRepo } from '../blog/siteRepo.ts';
import type { Studio, User } from '../db.ts';
import { html, raw, type Html } from './html.ts';
import type { ListingHelpers, ListingRow } from './listings.ts';
import { head } from './routes.ts';
import { computeAxisScale } from './chart-scale.ts';

// ---------- formatting ----------
const nf = new Intl.NumberFormat('en-US');
const num = (n: number) => nf.format(Math.round(n));
const ppu1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// Pages per user: one decimal place; null (no visitors, or no data), a dash like the other figures.
const ppuStr = (n: number | null) => (n === null || !Number.isFinite(n) ? '—' : ppu1.format(n));
export function duration(s: number | null): string {
  if (s === null) return '—';
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60), sec = t % 60;
  if (m < 60) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
// The change from the period before, as a KPI's second line; nothing when not comparing. plays: a figure counted
// only since the play events began, so a period before them has none to compare with.
export function delta(cur: number | null, prev: number | null, sel: Selection, plays = false): Html {
  if (!sel.compare) return html`<div class="d"></div>`;
  if (plays && sel.previous.start < PLAYS_SINCE) return html`<div class="d">${sel.previous.end < PLAYS_SINCE ? `not counted for ${sel.vs}` : `${sel.vs} only partly counted`}</div>`;
  const same = sel.vs, vs = `vs ${same}`;
  if (cur === null || prev === null) return html`<div class="d">${prev === null && cur !== null ? `no data for ${same}` : ''}</div>`;
  if (prev === 0) return html`<div class="d">${cur > 0 ? `new: none ${same}` : `none ${same} either`}</div>`;
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
// The lines, in the portal's series colours; the period before is the same colour, dashed. Blog reads are site-wide:
// only the site view for Vault staff has them (Series.reads), so a studio's or a game's chart never draws them.
export const LINES = [
  { key: 'plays', label: 'Plays', one: 'play', cls: 's2' },
  { key: 'users', label: 'Users', one: 'user', cls: 's3' },
  { key: 'reads', label: 'Blog reads', one: 'blog read', cls: 's4' },
] as const;
// The chart's title, by its lines.
export const chartTitle = (s: { reads?: unknown }) => (s.reads ? 'Plays, users and blog reads' : 'Plays and users');
export function chart(s: Series, sel: Selection): Html {
  const n = s.labels.length;
  const lines = LINES.map((l) => ({ ...l, line: s[l.key] })).filter((l) => l.line);
  // Blog reads have their own scale, on a right-hand axis: they can be far fewer (or more) than the plays and users,
  // which share the left one, scaled without them.
  const left = lines.filter((l) => l.key !== 'reads'), readsLine = lines.find((l) => l.key === 'reads');
  const values = (ls: typeof lines) => ls.flatMap((l) => [...l.line!.current, ...(l.line!.previous ?? [])]);
  const top = niceMax(Math.max(1, ...values(left).map((v) => v ?? 0)));
  const right = readsLine ? computeAxisScale(values([readsLine])) : null;
  const at = (v: number, max: number) => +(100 - (v / max) * 100).toFixed(2);
  const y = (v: number) => at(v, top);
  const x = (i: number) => i + 0.5;
  const path = (vals: (number | null)[], max = top) => {
    let d = '', pen = false;
    vals.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)} ${at(v, max)}`; pen = true; });
    // A point on its own (one day of plays, say) is a dot rather than nothing.
    return d.replace(/M([\d.]+) ([\d.]+)(?=M|$)/g, 'M$1 $2l0 0');
  };
  const scaleOf = (l: (typeof lines)[number]) => (l.key === 'reads' && right ? right.max : top);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  // About six labels; on a phone every other one (.alt) is hidden.
  const every = Math.max(1, Math.ceil(n / 6));
  const xl = s.labels.map((l, i) => ({ l, i })).filter(({ i }) => i % every === 0);
  // Each point's tooltip: its figures, and the period before's at the same place.
  const figures = (i: number, period: 'current' | 'previous') => lines.map((l) => {
    const v = l.line![period]?.[i] ?? null;
    if (v !== null) return `${num(v)} ${v === 1 ? l.one : l.label.toLowerCase()}`;
    return l.key === 'plays' ? 'plays not counted yet' : '—';
  }).join(' · ');
  const tip = (i: number) => {
    if (s.sessions.current[i] === null) return `${s.tips[i]}: later today`;
    return `${s.tips[i]}: ${figures(i, 'current')}${sel.compare && s.prevTips[i] ? `\n${s.prevTips[i]}: ${figures(i, 'previous')}` : ''}`;
  };
  const totalsLabel = lines.map((l) => `${l.label}: ${l.line!.current.reduce<number>((t, v) => t + (v ?? 0), 0)}`).join(', ');
  return html`<div class="ga-chart${right ? ' ga-dual' : ''}" role="img" aria-label="${chartTitle(s)} per ${s.unit}, ${spanLabel(sel.current)}. ${totalsLabel}.">
    ${right ? html`<div class="ga-yt ${readsLine!.cls}" aria-hidden="true">Blog reads</div>` : ''}
    <div class="ga-plot">
      ${ticks.filter((t) => Number.isInteger(t)).map((t) => html`<span class="ga-yl" style="bottom:${(t / top) * 100}%">${num(t)}</span>`)}
      ${right ? right.ticks.filter((t) => Number.isInteger(t)).map((t) => html`<span class="ga-yl ga-yr ${readsLine!.cls}" style="bottom:${(t / right.max) * 100}%">${num(t)}</span>`) : ''}
      <svg viewBox="0 0 ${n} 100" preserveAspectRatio="none" aria-hidden="true">
        ${ticks.map((t) => html`<line class="gridl" x1="0" x2="${n}" y1="${y(t)}" y2="${y(t)}" vector-effect="non-scaling-stroke"/>`)}
        ${lines.map((l) => (l.line!.previous ? html`<path class="ga-prev ${l.cls}" d="${path(l.line!.previous, scaleOf(l))}" vector-effect="non-scaling-stroke"/>` : ''))}
        ${lines.map((l) => html`<path class="ga-cur ${l.cls}" d="${path(l.line!.current, scaleOf(l))}" vector-effect="non-scaling-stroke"/>`)}
        ${s.labels.map((_, i) => html`<rect class="ga-hit" x="${i}" y="0" width="1" height="100"><title>${tip(i)}</title></rect>`)}
      </svg>
    </div>
    <div class="ga-x" aria-hidden="true">${xl.map(({ l, i }, k) => html`<span ${k % 2 ? raw('class="alt" ') : ''}style="left:${(x(i) / n) * 100}%">${l}</span>`)}</div>
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
// defs: the custom definitions a 'setup' error is about.
function problem(e: AnalyticsError, staff: boolean, what = '', defs = 'the play events’ custom definitions'): Html {
  const text: Record<AnalyticsError['kind'], string> = {
    not_connected: 'Analytics isn’t connected: this portal has no Google Analytics property to read (GA_PROPERTY_ID), or no Google credentials.',
    denied: 'Analytics isn’t connected: this portal’s service account doesn’t have access to the Google Analytics property yet.',
    api_disabled: 'Analytics isn’t connected: the Google Analytics Data API isn’t enabled in the service account’s Google Cloud project.',
    setup: `Google Analytics doesn’t know ${defs} yet${what ? `, so ${what}` : ''}.`,
    failed: `Google Analytics couldn’t answer${what ? ` for ${what}` : ''}.`,
  };
  if (!staff && CONNECTION.has(e.kind)) return html`<p class="fix">Analytics isn’t connected yet: Vault hasn’t given the portal access to Google Analytics.</p>`;
  return html`<p class="fix">${text[e.kind]}${staff && e.kind !== 'failed' ? html` See <span class="mono">docs/analytics.md</span>.` : ''}${staff ? html`<br><span class="small muted">${e.message}</span>` : ''}</p>`;
}
const firstError = (...rs: (Result<unknown> | null)[]) => rs.find((r): r is { ok: false; error: AnalyticsError } => !!r && !r.ok)?.error ?? null;

// ---------- a view ----------
// titleOf: a game's title, the link to its Analytics tab (if the viewer may see it) and, on the site view, its
// studio's Analytics page.
export interface GameTitle { title: string; href: string | null; studio?: { name: string; href: string } }
// topUrl: where Load more asks for the next top games (the view's scope and range); none, no link.
// blog: the site view's blog (Vault staff only): its stats (the top posts' table comes from them), each post's
// title by slug and its share clicks; moreUrl: where Load more asks for the next top posts (none, no link).
interface ViewOpts { timeZone: string; scope: Scope; staff: boolean; base: string; realtimeUrl: string; topUrl?: string; assets: Assets; titleOf(slug: string): GameTitle
  readsError?: AnalyticsError | null;   // the site view's blog reads couldn't be read (the chart draws without them)
  blog?: { stats: Result<BlogStats>; titles: Map<string, string>; shares?: Result<ShareStats> | null; moreUrl?: string } | null }
interface Assets { css: string; js: string; land: string }

// The date range picker, laid out like Google Analytics': a button showing the range, which opens the presets (in GA's
// order), a custom start and end, and Compare. It sits at the top of the view, right above the metrics row. It is a
// plain GET form, so it works without the page's script, which fills in a preset's dates when one is picked and picks
// Custom when the dates are edited (analytics.js).
export function datePicker(base: string, sel: Selection): Html {
  const [path, query = ''] = base.split('?');
  const keep = [...new URLSearchParams(query)].filter(([k]) => !['range', 'start', 'end', 'compare'].includes(k));
  const radio = (key: string, label: string, start: string, end: string) => html`<label class="ga-preset"><input type="radio" name="range" value="${key}" data-start="${start}" data-end="${end}" ${key === sel.preset ? raw('checked') : ''}><span>${label}</span></label>`;
  return html`<details class="ga-dates">
    <summary><span class="ga-dl">${sel.label}</span> <b>${spanLabel(sel.current)}</b>${sel.compare ? html` <span class="ga-vs">vs ${spanLabel(sel.previous)}</span>` : ''}</summary>
    <form class="ga-dp" method="get" action="${path}">
      ${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <fieldset class="ga-presets"><legend>Date range</legend>
        ${radio('custom', 'Custom', sel.current.start, sel.current.end)}
        ${PRESETS.map((p) => { const d = presetPeriods(p.key, sel.today).current; return radio(p.key, p.label, d.start, d.end); })}
      </fieldset>
      <div class="ga-custom">
        <div class="ga-days">
          <label>Start date<input type="date" name="start" value="${sel.current.start}" max="${sel.today}" required></label>
          <span aria-hidden="true">–</span>
          <label>End date<input type="date" name="end" value="${sel.current.end}" max="${sel.today}" required></label>
        </div>
        <p class="small muted">Days are whole days in the property’s time zone. “Last N days” end yesterday, as in Google Analytics.</p>
        <label class="ga-cmpl"><input type="hidden" name="compare" value="0"><input type="checkbox" name="compare" value="1" ${sel.compare ? raw('checked') : ''}> Compare with the period before</label>
        <div class="ga-btns"><button type="button" class="btn sm" data-cancel>Cancel</button><button type="submit" class="btn sm pri">Apply</button></div>
      </div>
    </form>
  </details>`;
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

// What the period is compared with, in dates.
export function spanNote(sel: Selection): string {
  const what = `${spanLabel(sel.current)}${sel.toHour < 23 ? ` (to ${String(sel.toHour).padStart(2, '0')}:59)` : ''}`;
  if (!sel.compare) return `${what}.`;
  return `${what}, compared with ${sel.vs} (${spanLabel(sel.previous)}${sel.toHour < 23 ? ' up to the same hour' : ''}).`;
}

// Said above the chart when the range (or the one it is compared with) reaches back before the play events.
export function playsNote(sel: Selection): Html | '' {
  const before = sel.current.start < PLAYS_SINCE || (sel.compare && sel.previous.start < PLAYS_SINCE);
  if (!before) return '';
  const which = sel.current.start < PLAYS_SINCE ? 'so the Plays line starts there and play figures in this range cover only the days since'
    : `so ${sel.vs} has none to compare with`;
  return html`<p class="ga-warn" role="note"><b>Plays weren’t counted before ${longDate(PLAYS_SINCE)}</b>, when the site began sending play events, ${which}. Sessions and users go back further.</p>`;
}

// ---------- top games ----------
// The first page of top games, and each Load more's page.
export const TOP_PAGE = 10;
export type TopGame = ({ by: 'plays' } & GamePlays) | ({ by: 'views' } & GamePages);
// The view's whole ranked list of top games: by plays, or by page views when no game has plays (yet). Both lists are
// ranked by their figure, most first, then by slug, so pages of them never skip or repeat a game. null: none shown
// (a game's view, or nothing to rank).
export function topGames(ov: Overview, scope: Scope): { by: 'plays' | 'views'; items: TopGame[] } | null {
  if (scope.game) return null;
  const p = ov.plays.ok ? ov.plays.value : null, tp = ov.topPages;
  if (tp && (!p || !p.games.length)) return { by: 'views', items: tp.ok ? tp.value.map((g) => ({ by: 'views' as const, ...g })) : [] };
  if (p) return { by: 'plays', items: p.timed ? p.games.map((g) => ({ by: 'plays' as const, ...g })) : [] };
  return null;
}
export function topRow(g: TopGame, titleOf: (slug: string) => GameTitle): Html {
  const t = titleOf(g.slug);
  const name = html`<td class="proj">${t.href ? html`<a href="${t.href}"><b>${t.title}</b></a>` : html`<b>${t.title}</b>`}<span>${t.studio ? html`<a href="${t.studio.href}" title="The studio’s analytics">${t.studio.name}</a> · ` : ''}${g.slug}</span></td>`;
  return g.by === 'views'
    ? html`<tr data-slug="${g.slug}">${name}<td class="r num">${num(g.views)}</td><td class="r num">${num(g.clicks)}</td></tr>`
    : html`<tr data-slug="${g.slug}">${name}<td class="r num">${num(g.plays)}</td><td class="r num">${duration(averageSeconds(g))}</td></tr>`;
}
// The top games' Total row's figures: summed over the whole ranked list (a Load more page, never). The plays' average
// time is weighted by each game's timed plays (null when none are timed, shown as a dash); the views' columns are
// plain sums. The scope's rows are the whole list's, so the total covers exactly what the table may show.
export function topGamesTotals(tg: { by: 'plays' | 'views'; items: TopGame[] }):
  { by: 'plays'; plays: number; avg: number | null } | { by: 'views'; views: number; clicks: number } {
  if (tg.by === 'plays') {
    const t = tg.items.reduce((s, g) => g.by === 'plays'
      ? { plays: s.plays + g.plays, timedPlays: s.timedPlays + g.timedPlays, seconds: s.seconds + g.seconds }
      : s, { plays: 0, timedPlays: 0, seconds: 0 });
    return { by: 'plays', plays: t.plays, avg: averageSeconds(t) };
  }
  return { by: 'views', ...topPagesTotals(tg.items.filter((g): g is Extract<TopGame, { by: 'views' }> => g.by === 'views')) };
}
// The top games' Total row: pinned above the rows (Load more appends below it), the whole list's figures in the
// columns' formats; no link, no rank, no thumbnail.
export function topTotalRow(tot: { by: 'plays' | 'views'; plays?: number; avg?: number | null; views?: number; clicks?: number }): Html {
  return tot.by === 'views'
    ? html`<tr class="analytics-total-row"><td class="proj"><b>Total</b></td><td class="r num">${num(tot.views ?? 0)}</td><td class="r num">${num(tot.clicks ?? 0)}</td></tr>`
    : html`<tr class="analytics-total-row"><td class="proj"><b>Total</b></td><td class="r num">${num(tot.plays ?? 0)}</td><td class="r num">${duration(tot.avg ?? null)}</td></tr>`;
}
// A top list's Load more, under its table when it has more rows than the first page: a text link (a real button, for
// the keyboard and screen readers, styled as a link: .link-button), which asks url for the next ones (analytics.js);
// noun: what the status line counts ("12 of 30 games").
export function loadMore(url: string | undefined, total: number, noun: string): Html | '' {
  return url && total > TOP_PAGE
    ? html`<div class="ga-more"><button type="button" class="link-button load-more" data-more="${url}" data-limit="${TOP_PAGE}" data-noun="${noun}">Load more</button><span class="small muted" role="status" aria-live="polite"></span></div>` : '';
}
// ?offset=&limit= of a Load more: whole numbers (limit kept to 1 to 100); anything else, the defaults (0 and a page).
export function pageParams(offset: string | undefined, limit: string | undefined): { offset: number; limit: number } {
  const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
  const o = int(offset), l = int(limit);
  return { offset: o ?? 0, limit: l === null ? TOP_PAGE : Math.max(1, Math.min(100, l)) };
}

// ---------- the blog ----------
// A post's name in the table: the blog's home, its title (from the posts in vault-site), else its path.
export const blogTitle = (slug: string, path: string, titles: Map<string, string>) => (slug === '' ? 'Blog home' : titles.get(slug) || path);
// A post's (or the blog's) share clicks by network, e.g. "LinkedIn 3 · WhatsApp 1": the networks with clicks only.
export const networkBreakdown = (n: NetworkCounts): string => SHARE_NETWORKS.filter(([k]) => n[k] > 0).map(([k, name]) => `${name} ${num(n[k])}`).join(' · ');
// A top post's row: its name, opens, readers, time on screen per reader and, when shares were asked for (not null),
// its share clicks (failed, a dash).
export function blogRow(p: BlogStats['posts'][number], titles: Map<string, string>, shares: Result<ShareStats> | null): Html {
  const sh = shares?.ok ? shares.value : null;
  const shareCell = (slug: string) => {
    if (!sh) return html`<td class="r num">—</td>`;
    const s = slug ? sh.posts.get(slug) : undefined;
    const by = s ? networkBreakdown(s.networks) : '';
    return html`<td class="r num ga-shares">${num(s?.total ?? 0)}${by ? html`<span class="small muted">${by}</span>` : ''}</td>`;
  };
  return html`<tr data-slug="${p.slug}"><td class="proj"><b>${blogTitle(p.slug, p.path, titles)}</b><span>${p.path}</span></td><td class="r num">${num(p.opens)}</td><td class="r num">${num(p.readers)}</td><td class="r num">${minSec(perReader(p.seconds, p.readers))}</td>${shares ? shareCell(p.slug) : ''}</tr>`;
}
// The blog's top posts (the site view, Vault staff only), by opens, with each's share clicks: the card the view sets
// next to the top games, under the full-width map. stats: the same range's blog figures (the table's posts come from
// them); failed, no table. shares: null, not asked for (no Shares column); failed, dashes in it. The first page of
// posts (as many as the top games'), then a Load more link, which asks moreUrl for the next ones.
export function blogCard(stats: Result<BlogStats>, titles: Map<string, string>, shares: Result<ShareStats> | null = null, moreUrl?: string): Html | string {
  if (!stats.ok) return '';
  const { posts } = stats.value;
  const sh = shares?.ok ? shares.value : null;
  // The pinned Total row: the whole range's figures (every post, not just the page shown) — opens and time on screen
  // summed over the posts; readers a deduplicated total (the totals' query: readers can't be added up across posts);
  // the average on screen, the whole's seconds per reader; the shares' total (dashes when the query failed).
  const totalRow = html`<tr class="analytics-total-row"><td class="proj"><b>Total</b></td><td class="r num">${num(posts.reduce((s, p) => s + p.opens, 0))}</td><td class="r num">${num(stats.value.totals.readers.current)}</td><td class="r num">${minSec(perReader(posts.reduce((s, p) => s + p.seconds, 0), stats.value.totals.readers.current))}</td>${shares ? (sh ? html`<td class="r num">${num(sh.total.current)}</td>` : html`<td class="r num">—</td>`) : ''}</tr>`;
  const rows = posts.slice(0, TOP_PAGE).map((p) => blogRow(p, titles, shares));
  return html`<div class="card ga-blog"><h2>Top Blog Articles</h2>${rows.length
    ? html`<div class="tbl-wrap"><table><thead><tr><th>Post</th><th class="r">Opens</th><th class="r">Readers</th><th class="r" title="Time on screen per reader">Avg time on screen</th>${shares ? html`<th class="r" title="Clicks on the post’s share buttons, by network">Shares</th>` : ''}</tr></thead><tbody>${totalRow}${rows}</tbody></table></div>${loadMore(moreUrl, posts.length, 'posts')}`
    : html`<p class="small muted">No blog pages opened in this range.</p>`}</div>`;
}

export function view(ov: Overview, rt: Realtime, o: ViewOpts): Html {
  const sel = ov.sel;
  const kind = o.scope.game ? 'game' : o.scope.studio ? 'studio' : 'site';
  const assets = html`<link rel="stylesheet" href="${o.assets.css}"><script src="${o.assets.js}" defer></script>`;
  const picker = datePicker(o.base, sel);
  // Not connected at all: say so once, rather than an empty chart and a row of dashes.
  const conn = [ov.series, ov.plays, ov.players].every((r) => !r.ok && CONNECTION.has(r.error.kind)) ? firstError(ov.series) : null;
  if (conn) return html`${assets}<div class="card ga-off">${problem(conn, o.staff)}${o.staff ? '' : html`<p class="small muted">Ask Vault about it.</p>`}</div>`;

  // The legend: each line's total for the range and its change.
  const tr = ov.traffic.ok ? ov.traffic.value : null, pl = ov.plays.ok ? ov.plays.value : null;
  const sum = (vals: (number | null)[] | null | undefined) => (vals ?? []).reduce<number>((t, v) => t + (v ?? 0), 0);
  const reads = ov.series.ok ? ov.series.value.reads : undefined;
  const totals: Record<string, { cur: number; prev: number } | null> = {
    reads: reads ? { cur: sum(reads.current), prev: sum(reads.previous) } : null,
    plays: pl && { cur: pl.current.plays, prev: pl.previous.plays },
    users: tr && { cur: tr.totalUsers.current, prev: tr.totalUsers.previous },
  };
  const whose = kind === 'game' ? ' that showed the game’s page or played it' : kind === 'studio' ? ' that showed one of the studio’s game pages or played one of its games' : '';
  const about: Record<string, string> = {
    reads: 'Blog posts opened on the site (each opening of a post counts once)',
    plays: 'Games opened from their page on the site (in the player, or in a new tab)',
    users: `People (browsers)${whose ? ` in visits to the site${whose}` : ' who visited'}. Each point counts its own; the total counts each person once.`,
  };
  const legend = html`<div class="ga-legend">${LINES.filter((l) => l.key !== 'reads' || reads).map((l) => {
    const t = totals[l.key];
    return html`<div class="ga-lk" title="${about[l.key]}"><span class="k ${l.cls}"></span><span class="ga-ln">${l.key === 'reads' ? `${l.label} (right axis)` : l.label}</span> <b class="ga-tot">${t ? num(t.cur) : '—'}</b>${t ? delta(t.cur, t.prev, sel, l.key === 'plays') : ''}</div>`;
  })}${sel.compare ? html`<div class="ga-lk ga-lprev small"><span class="k prev"></span>${sel.vs[0].toUpperCase()}${sel.vs.slice(1)}</div>` : ''}</div>`;
  const s = ov.series;
  const chartCard = html`<div class="card ga-top">
    <div class="card-h ga-head"><h2>${chartTitle({ reads })}</h2></div>
    ${playsNote(sel)}
    ${legend}
    ${s.ok ? html`${chart(s.value, sel)}${s.value.plays ? '' : problem(new AnalyticsError('failed', 'the plays line'), o.staff, 'the chart’s plays')}` : problem(s.error, o.staff, 'the chart')}
    ${o.readsError ? problem(o.readsError, o.staff, 'the chart’s blog reads') : ''}
    <p class="small muted ga-span">${spanNote(sel)}</p>
    ${!ov.traffic.ok ? problem(ov.traffic.error, o.staff, 'the users') : ''}
  </div>`;

  // The headline row: the website's and the plays' figures combined, at the very top of the view under the date
  // picker (above the plot).
  // The site's view has the five; a studio's or a game's — which never had the website's or the blog's figures — has
  // its plays' two.
  const p = ov.plays.ok ? ov.plays.value : null;
  const h = ov.headline;
  const avgCur = h.avgPlaytimeSeconds, avgPrev = p && p.timed ? averageSeconds(p.previous) : null;
  const avgNote = !p ? '' : !p.timed ? 'Needs the custom definitions in Google Analytics.'
    : avgCur === null ? 'No timed plays in this range yet. Only plays since the game pages began sending play events are timed.' : '';
  const d = (cur: number | null, prev: number | null, plays = false) => (cur === null ? html`<div class="d"></div>` : delta(cur, prev, sel, plays));
  const ppuPrev = tr && tr.totalUsers.previous > 0 ? tr.screenPageViews.previous / tr.totalUsers.previous : null;
  const readsPrev = reads ? sum(reads.previous) : null;   // the chart's blog reads (the site view only), if read
  const headline = html`<div class="kpis ga-headline${kind === 'site' ? '' : ' ga-k2'}" aria-label="${kind === 'site' ? 'The website and the plays' : 'The plays'}, ${spanLabel(sel.current)}">
      ${kind === 'site' ? kpi('Unique Users', h.uniqueUsers === null ? '—' : num(h.uniqueUsers), d(h.uniqueUsers, tr ? tr.totalUsers.previous : null), 'People (browsers) who visited the site. Each point counts its own; the total counts each person once.') : ''}
      ${kpi('Plays', h.plays === null ? '—' : num(h.plays), d(h.plays, p ? p.previous.plays : null, true), 'A play: the game opened from its page on the site (in the player, or in a new tab)')}
      ${kind === 'site' ? kpi('Pages per User', ppuStr(h.pagesPerUser), d(h.pagesPerUser, ppuPrev), 'Page views on the site, per person who visited (page views ÷ unique users)') : ''}
      ${kind === 'site' ? kpi('Blog Reads', h.blogReads === null ? '—' : num(h.blogReads), d(h.blogReads, readsPrev), 'Blog posts opened on the site (each opening of a post counts once)') : ''}
      ${kpi('Average Playtime', duration(avgCur), avgNote ? html`<div class="d">${avgNote}</div>` : d(avgCur, avgPrev, true), 'Time the game was open in the player with the page on screen, per play in the player. Games opened in a new tab can’t be timed.')}
    </div>
    ${!ov.plays.ok ? problem(ov.plays.error, o.staff, kind === 'game' ? 'this game’s plays can’t be counted' : kind === 'studio' ? 'this studio’s plays can’t be counted' : 'plays') : ''}`;

  // A game's page (a studio's games' pages): views, visitors and outbound clicks, back through the Squarespace years.
  let page: Html | string = '';
  if (ov.pages) {
    const pv = ov.pages.ok ? ov.pages.value : null;
    const k = (label: string, v: Pair | null, title: string) => kpi(label, v ? num(v.current) : '—', v ? delta(v.current, v.previous, sel) : html`<div class="d"></div>`, title);
    const its = kind === 'studio' ? 'the studio’s game pages' : 'the game’s page';
    page = html`<h3 class="sec">${kind === 'studio' ? 'Its games’ pages' : 'The game’s page'} <small class="muted small">${spanLabel(sel.current)} · counted since the Squarespace site, before the play events</small></h3>
      <div class="kpis ga-k3">${k('Page views', pv?.views ?? null, `Views of ${its} on vaultlearninggames.org (their addresses on the Squarespace site too)`)}${k('Visitors', pv?.visitors ?? null, `People (browsers) who viewed ${its}`)}${k('Play-button clicks', pv?.clicks ?? null, `Outbound link clicks on ${its} (Google Analytics enhanced measurement). The old site’s Play button linked out to the game, so before the play events these are mostly plays; they also count other links out, such as curriculum.`)}</div>
      <p class="small muted">Play-button clicks: outbound clicks from ${its}.</p>
      ${!ov.pages.ok ? problem(ov.pages.error, o.staff, its) : ''}`;
  }

  // The blog's top posts (the site view, Vault staff only), in the top lists below.
  const blog = kind === 'site' && o.blog && o.staff ? blogCard(o.blog.stats, o.blog.titles, o.blog.shares ?? null, o.blog.moreUrl) : '';

  const realtime = html`<div class="card ga-rt"><h2><span class="live-dot">${kind === 'site' ? 'On the site now' : 'Playing now'}</span><small>last 30 minutes · updates every minute</small></h2>
    <div data-realtime="${o.realtimeUrl}">${realtimeBody(rt, { staff: o.staff, land: o.assets.land, game: !!o.scope.game })}</div></div>`;

  let top: Html | string = '';
  const tg = topGames(ov, o.scope);
  // The pinned Total row: the whole ranked list's figures (a Load more page, never), above the rows.
  const totalRow = tg ? topTotalRow(topGamesTotals(tg)) : '';
  const rows = tg ? tg.items.slice(0, TOP_PAGE).map((g) => topRow(g, o.titleOf)) : [];
  // More games than the first page: a Load more link, which asks topUrl for the next ones (analytics.js).
  const more = tg ? loadMore(o.topUrl, tg.items.length, 'games') : '';
  const tp = ov.topPages;
  if (tg?.by === 'views' && tp) {
    // No game has plays (yet): the games whose pages were viewed most.
    top = html`<div class="card ga-games"><h2>Top games <small>by page views, ${spanLabel(sel.current)}</small></h2>
      ${!tp.ok ? problem(tp.error, o.staff, 'the game pages')
        : rows.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th class="r">Page views</th><th class="r" title="Outbound link clicks from the game’s page: the old site’s Play button linked out to the game">Play-button clicks</th></tr></thead><tbody>${totalRow}${rows}</tbody></table></div>${more}
          <p class="small muted">No plays by game yet${p && !p.timed ? ' (Google Analytics doesn’t know the custom dimension game_slug yet)' : ''}, so these are views of each game’s page. Play-button clicks: outbound clicks from the game’s page.</p>`
        : html`<p class="small muted">No views of game pages in this range.</p>`}</div>`;
  } else if (tg?.by === 'plays' && p) {
    top = html`<div class="card ga-games"><h2>Top games <small>by plays, ${spanLabel(sel.current)}</small></h2>
      ${!p.timed ? html`<p class="small muted">Games can be told apart once the custom dimension game_slug is registered in Google Analytics.</p>`
        : rows.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th class="r">Plays</th><th class="r">Avg time</th></tr></thead><tbody>${totalRow}${rows}</tbody></table></div>${more}`
        : html`<p class="small muted">No plays in this range yet.</p>`}</div>`;
  }

  // The map's card takes the full width on its own row; then the top lists: the top games and the blog's top posts,
  // side by side (one of them only, the other spans the row).
  const lists = top || blog ? html`<div class="grid analytics-top-lists">${top}${blog}</div>` : '';

  return html`${assets}<div class="ga">${picker}${headline}${chartCard}${page}
    ${realtime}${lists}
    <p class="small muted ga-foot">From Google Analytics (the site’s visits and ${p && !p.timed ? 'play counts' : 'play events'}, which began on ${longDate(PLAYS_SINCE)}; days are ${o.timeZone.replace(/_/g, ' ')} days, weeks start on Sunday). Figures are cached for up to 10 minutes; the realtime map for a minute.</p></div>`;
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

  // Who may see analytics: the whole site, Vault staff; a studio and its games, Vault staff and every member of the
  // studio (viewers too).
  const canSeeStudio = (u: User, s: Studio) => h.isStaff(u) || h.isMember(u, s);
  const canSeeGame = (u: User, l: ListingRow) => canSeeStudio(u, db.studioById(l.studio_id)!);
  // Each game's page paths on the site, for its page views (the Squarespace addresses come from the site's data).
  const legacy = loadLegacy();
  const catalog = (studioId?: number) => Object.fromEntries((db.listings({ published: true, studioId }) as ListingRow[]).map((l) => [l.slug, pagePaths(l.slug, legacy)]));
  // A studio's view: its games on the site and all their pages.
  const studioScope = (s: Studio): { scope: Scope; catalog: Record<string, string[]> } => {
    const cat = catalog(s.id);
    return { scope: { studio: s.slug, games: Object.keys(cat), pages: Object.values(cat).flat() }, catalog: cat };
  };
  const titleOf = (u: User, withStudio: boolean) => (slug: string): GameTitle => {
    const l = db.listing(slug) as ListingRow | undefined;
    if (!l) return { title: slug, href: null };
    const mine = canSeeGame(u, l);
    return { title: l.published?.title || l.draft.title || slug, href: mine ? `/s/${l.studio_slug}/g/${slug}?tab=analytics` : null,
      ...(withStudio && mine ? { studio: { name: l.studio_name, href: `/s/${l.studio_slug}/analytics` } } : {}) };
  };

  // The range picked on the page: ?range=PRESET or ?range=custom&start=&end=, and compare (the form sends compare=0
  // and, when ticked, compare=1 after it: the last one counts).
  type Query = { range?: string; start?: string; end?: string; compare?: string };
  const queryOf = (c: { req: { query(k: string): string | undefined; queries(k: string): string[] | undefined } }): Query =>
    ({ range: c.req.query('range'), start: c.req.query('start'), end: c.req.query('end'), compare: c.req.queries('compare')?.at(-1) });

  // The blog posts' titles by slug (vault-site's posts, as the blog editor lists them), for the Blog section. The post
  // list is cached; unconfigured, failing or slow (2 s): no titles, and the table shows paths.
  let blogRepo: SiteBlogRepo | null = null;
  async function blogTitles(): Promise<Map<string, string>> {
    try {
      blogRepo ??= new SiteBlogRepo({ client: h.deps.siteContent ?? undefined });
      const posts = blogRepo.listPosts();
      posts.catch(() => {});
      const list = await Promise.race([posts, new Promise<null>((r) => setTimeout(() => r(null), 2000).unref())]);
      return new Map((list ?? []).filter((p) => p.title).map((p) => [p.slug, p.title]));
    } catch { return new Map(); }
  }

  async function render(u: User, scope: Scope, q: Query, base: string, cat = catalog()) {
    const rtq = scope.game ? `?game=${encodeURIComponent(scope.game)}` : scope.studio ? `?studio=${encodeURIComponent(scope.studio)}` : '';
    const full = scope.game ? { ...scope, pages: cat[scope.game] ?? pagePaths(scope.game, legacy) } : scope;
    const sel = analytics.selection(q);
    // The site view (Vault staff): the blog too.
    const site = !scope.game && !scope.studio && h.isStaff(u);
    const [ov, rt, blog] = await Promise.all([analytics.overview(sel, full, cat), analytics.realtime(scope),
      site ? Promise.all([analytics.blog(sel), blogTitles(), analytics.blogShares(sel)]).then(([stats, titles, shares]) => ({ stats, titles, shares })) : null]);
    // The chart's blog reads: the site view's summary carries them (site-wide, so a studio's or a game's never does,
    // nor anyone but Vault staff).
    const charted = ov.reads?.ok && ov.series.ok ? { ...ov, series: { ok: true as const, value: { ...ov.series.value, reads: ov.reads.value } } } : ov;
    // Load more: the same scope and range as the page.
    const tq = new URLSearchParams(Object.entries({ studio: scope.studio, ...q }).filter((e): e is [string, string] => e[1] !== undefined));
    const bq = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => e[1] !== undefined));
    return view(charted, rt, { timeZone: analytics.timeZone, scope, staff: h.isStaff(u), base, realtimeUrl: `/portal/analytics/realtime${rtq}`,
      topUrl: scope.game ? undefined : `/portal/analytics/top-games${tq.size ? `?${tq}` : ''}`, assets, titleOf: titleOf(u, !scope.game && !scope.studio),
      blog: blog && { ...blog, moreUrl: `/portal/analytics/top-posts${bq.size ? `?${bq}` : ''}` },
      readsError: ov.reads && !ov.reads.ok ? ov.reads.error : null });
  }

  app.get('/vault/analytics', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const body = await render(u, {}, queryOf(c), '/vault/analytics');
    return h.page(c, 'Analytics', html`${head('Analytics')}${body}`, { active: 'analytics' });
  });

  // A studio's Analytics page: all its games on the site.
  app.get('/s/:studio/analytics', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    const s = h.studioFor(c, u); if (s instanceof Response) return s;
    const { scope, catalog: cat } = studioScope(s);
    const sub = `Plays of ${s.name}’s games on vaultlearninggames.org. Each game’s page has the same view for that game (its Analytics tab).`;
    const body = scope.games!.length
      ? await render(u, scope, queryOf(c), `/s/${s.slug}/analytics`, cat)
      : html`<div class="card"><p class="muted">None of this studio’s games are on the site yet, so there are no plays to show. Analytics count plays from a game’s page on vaultlearninggames.org.</p></div>`;
    return h.page(c, 'Analytics', html`${head('Analytics', sub)}${body}`, { studio: s, active: 'studio-analytics' });
  });

  // The realtime card's contents, for the page's script to refresh every minute.
  app.get('/portal/analytics/realtime', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    const slug = c.req.query('game'), studio = c.req.query('studio');
    let scope: Scope = {};
    if (slug) {
      const l = db.listing(slug) as ListingRow | undefined;
      if (!l || !canSeeGame(u, l)) return c.text('Not found', 404);
      scope = { game: slug };
    } else if (studio) {
      const s = db.studioBySlug(studio);
      if (!s || !canSeeStudio(u, s)) return c.text('Not found', 404);
      scope = studioScope(s).scope;
    } else if (!h.isStaff(u)) return c.text('Only Vault staff can see this.', 403);
    const rt = await analytics.realtime(scope);
    return c.html(realtimeBody(rt, { staff: h.isStaff(u), land: assets.land, game: !!slug }).toString(), 200, { 'Cache-Control': 'no-store' });
  });

  // The top games' next page, for Load more (analytics.js): ?studio= (else the site), the page's range, and
  // ?offset=&limit=. rows: the table's rows, ranked as on the page; total: all the ranked games; hasMore: more after these.
  app.get('/portal/analytics/top-games', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    const studio = c.req.query('studio');
    let scope: Scope = {}, cat: Record<string, string[]>;
    if (studio) {
      const s = db.studioBySlug(studio);
      if (!s || !canSeeStudio(u, s)) return c.text('Not found', 404);
      ({ scope, catalog: cat } = studioScope(s));
    } else if (!h.isStaff(u)) return c.text('Only Vault staff can see this.', 403);
    else cat = catalog();
    const { offset, limit } = pageParams(c.req.query('offset'), c.req.query('limit'));
    const tg = scope.studio && !scope.games!.length ? null : topGames(await analytics.overview(analytics.selection(queryOf(c)), scope, cat), scope);
    const items = tg?.items ?? [];
    const page = items.slice(offset, offset + limit), ttl = titleOf(u, !scope.studio);
    // totals: the whole ranked list's figures (the page, never), for the table's Total row; additive, old clients
    // ignore it.
    return c.json({ items: page.map((g) => ({ slug: g.slug, html: topRow(g, ttl).toString() })), offset, total: items.length, hasMore: offset + page.length < items.length,
      totals: tg ? topGamesTotals(tg) : null }, 200, { 'Cache-Control': 'no-store' });
  });

  // The blog's top posts' next page, for Load more (analytics.js), Vault staff only: the page's range and
  // ?offset=&limit=. The same shape as the top games': rows, ranked as on the page; total: all the posts; hasMore.
  app.get('/portal/analytics/top-posts', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return c.text('Only Vault staff can see this.', 403);
    const { offset, limit } = pageParams(c.req.query('offset'), c.req.query('limit'));
    const sel = analytics.selection(queryOf(c));
    const [stats, titles, shares] = await Promise.all([analytics.blog(sel), blogTitles(), analytics.blogShares(sel)]);
    const posts = stats.ok ? stats.value.posts : [];
    const page = posts.slice(offset, offset + limit);
    return c.json({ items: page.map((p) => ({ slug: p.slug, html: blogRow(p, titles, shares).toString() })), offset, total: posts.length,
      hasMore: offset + page.length < posts.length }, 200, { 'Cache-Control': 'no-store' });
  });

  return {
    // A game's Analytics tab (routes.ts): its listing's plays. A game that isn't on the site has none.
    async gameTab(u: User, s: Studio, l: ListingRow | null, c: Parameters<typeof queryOf>[0]): Promise<Html> {
      if (!l) return html`<div class="card"><p class="muted">This game isn’t on the site, so there are no plays to show. Analytics count plays from a game’s page on vaultlearninggames.org.</p></div>`;
      const body = await render(u, { game: l.slug }, queryOf(c), `/s/${s.slug}/g/${l.slug}?tab=analytics`);
      return html`${l.published ? '' : html`<p class="small muted">This game isn’t published on the site yet.</p>`}${body}`;
    },
  };
}

export { Analytics };
