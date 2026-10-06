// Analytics: plays of the games on the website, from Google Analytics (src/analytics/). Vault staff see the whole
// site (Vault → Analytics, /vault/analytics); each studio has an Analytics page for all its games (/s/STUDIO/analytics)
// and each game's page an Analytics tab, with the same view, which the studio's members (viewers too) see. Each view:
// a date range picked the way Google Analytics' picker does it (presets, a custom range, compare with the period
// before), a chart of sessions, plays and users, plays / players / average play time, a realtime map of where people
// are playing, top games (site and studio), and for the site its page views, sessions and visitors. A game's (a
// studio's) sessions and users are visits that showed its page or started one of its plays.
// The play events began on PLAYS_SINCE: before it there are no plays (the page says so), but sessions, users, page
// views and outbound clicks of the game pages go back through the Squarespace years (the same addresses): the top
// games fall back to page views when there are no plays.
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Analytics, AnalyticsError, type Overview, type Realtime, type Result } from '../analytics/ga.ts';
import { cityPoint } from '../analytics/cities.ts';
import { COUNTRY_POINTS } from '../analytics/countries.ts';
import { MAP_HEIGHT, MAP_WIDTH } from '../analytics/projection.ts';
import { loadLegacy, pagePaths } from '../analytics/pages.ts';
import { averageSeconds, longDate, PLAYS_SINCE, PRESETS, presetPeriods, spanLabel, type Pair, type Place, type Scope, type Selection, type Series } from '../analytics/reports.ts';
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
// The three lines, in the portal's series colours; the period before is the same colour, dashed.
export const LINES = [
  { key: 'sessions', label: 'Sessions', one: 'session', cls: 's1' },
  { key: 'plays', label: 'Plays', one: 'play', cls: 's2' },
  { key: 'users', label: 'Users', one: 'user', cls: 's3' },
] as const;
export function chart(s: Series, sel: Selection): Html {
  const n = s.labels.length;
  const lines = LINES.map((l) => ({ ...l, line: s[l.key] })).filter((l) => l.line);
  const all = lines.flatMap((l) => [...l.line!.current, ...(l.line!.previous ?? [])]).map((v) => v ?? 0);
  const top = niceMax(Math.max(1, ...all));
  const y = (v: number) => +(100 - (v / top) * 100).toFixed(2);
  const x = (i: number) => i + 0.5;
  const path = (vals: (number | null)[]) => {
    let d = '', pen = false;
    vals.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i)} ${y(v)}`; pen = true; });
    // A point on its own (one day of plays, say) is a dot rather than nothing.
    return d.replace(/M([\d.]+) ([\d.]+)(?=M|$)/g, 'M$1 $2l0 0');
  };
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
  return html`<div class="ga-chart" role="img" aria-label="Sessions, plays and users per ${s.unit}, ${spanLabel(sel.current)}. ${totalsLabel}.">
    <div class="ga-plot">
      ${ticks.filter((t) => Number.isInteger(t)).map((t) => html`<span class="ga-yl" style="bottom:${(t / top) * 100}%">${num(t)}</span>`)}
      <svg viewBox="0 0 ${n} 100" preserveAspectRatio="none" aria-hidden="true">
        ${ticks.map((t) => html`<line class="gridl" x1="0" x2="${n}" y1="${y(t)}" y2="${y(t)}" vector-effect="non-scaling-stroke"/>`)}
        ${lines.map((l) => (l.line!.previous ? html`<path class="ga-prev ${l.cls}" d="${path(l.line!.previous)}" vector-effect="non-scaling-stroke"/>` : ''))}
        ${lines.map((l) => html`<path class="ga-cur ${l.cls}" d="${path(l.line!.current)}" vector-effect="non-scaling-stroke"/>`)}
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
// titleOf: a game's title, the link to its Analytics tab (if the viewer may see it) and, on the site view, its
// studio's Analytics page.
export interface GameTitle { title: string; href: string | null; studio?: { name: string; href: string } }
interface ViewOpts { timeZone: string; scope: Scope; staff: boolean; base: string; realtimeUrl: string; assets: Assets; titleOf(slug: string): GameTitle }
interface Assets { css: string; js: string; land: string }

// The date range picker, laid out like Google Analytics': a button showing the range, which opens the presets (in GA's
// order), a custom start and end, and Compare. It is a plain GET form, so it works without the page's script, which
// fills in a preset's dates when one is picked and picks Custom when the dates are edited (analytics.js).
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
  const totals: Record<string, { cur: number; prev: number } | null> = {
    sessions: tr && { cur: tr.sessions.current, prev: tr.sessions.previous },
    plays: pl && { cur: pl.current.plays, prev: pl.previous.plays },
    users: tr && { cur: tr.totalUsers.current, prev: tr.totalUsers.previous },
  };
  const whose = kind === 'game' ? ' that showed the game’s page or played it' : kind === 'studio' ? ' that showed one of the studio’s game pages or played one of its games' : '';
  const about: Record<string, string> = {
    sessions: `Visits to the site${whose}`,
    plays: 'Games opened from their page on the site (in the player, or in a new tab)',
    users: `People (browsers)${whose ? ` in those visits` : ' who visited'}. Each point counts its own; the total counts each person once.`,
  };
  const legend = html`<div class="ga-legend">${LINES.map((l) => {
    const t = totals[l.key];
    return html`<div class="ga-lk" title="${about[l.key]}"><span class="k ${l.cls}"></span><span class="ga-ln">${l.label}</span> <b class="ga-tot">${t ? num(t.cur) : '—'}</b>${t ? delta(t.cur, t.prev, sel, l.key === 'plays') : ''}</div>`;
  })}${sel.compare ? html`<div class="ga-lk ga-lprev small"><span class="k prev"></span>${sel.vs[0].toUpperCase()}${sel.vs.slice(1)}</div>` : ''}</div>`;
  const s = ov.series;
  const chartCard = html`<div class="card ga-top">
    <div class="card-h ga-head"><h2>Sessions, plays and users</h2>${picker}</div>
    ${playsNote(sel)}
    ${legend}
    ${s.ok ? html`${chart(s.value, sel)}${s.value.plays ? '' : problem(new AnalyticsError('failed', 'the plays line'), o.staff, 'the chart’s plays')}` : problem(s.error, o.staff, 'the chart')}
    <p class="small muted ga-span">${spanNote(sel)}</p>
    ${!ov.traffic.ok ? problem(ov.traffic.error, o.staff, 'sessions and users') : ''}
  </div>`;

  const p = ov.plays.ok ? ov.plays.value : null;
  const avgCur = p && p.timed ? averageSeconds(p.current) : null, avgPrev = p && p.timed ? averageSeconds(p.previous) : null;
  const players = ov.players.ok ? ov.players.value : null;
  const avgNote = !p ? '' : !p.timed ? 'Needs the custom definitions in Google Analytics.'
    : avgCur === null ? 'No timed plays in this range yet. Only plays since the game pages began sending play events are timed.' : '';
  const kpis = html`<div class="kpis ga-k3" aria-label="Plays, ${spanLabel(sel.current)}">
      ${kpi('Plays', p ? num(p.current.plays) : '—', p ? delta(p.current.plays, p.previous.plays, sel, true) : html`<div class="d"></div>`, 'A play: the game opened from its page on the site (in the player, or in a new tab)')}
      ${kpi('Unique players', players ? num(players.current) : '—', players ? delta(players.current, players.previous, sel, true) : html`<div class="d"></div>`, 'People (browsers) who started at least one play')}
      ${kpi('Average play time', duration(avgCur), avgNote ? html`<div class="d">${avgNote}</div>` : delta(avgCur, avgPrev, sel, true), 'Time the game was open in the player with the page on screen, per play in the player. Games opened in a new tab can’t be timed.')}
    </div>
    ${!ov.plays.ok ? problem(ov.plays.error, o.staff, kind === 'game' ? 'this game’s plays can’t be counted' : kind === 'studio' ? 'this studio’s plays can’t be counted' : 'plays') : ''}
    ${!ov.players.ok && ov.plays.ok ? problem(ov.players.error, o.staff, 'players') : ''}`;

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

  let site: Html | string = '';
  if (kind === 'site') {
    const pair = (k: 'screenPageViews' | 'sessions' | 'totalUsers') => (tr ? tr[k] : null);
    const k = (label: string, v: Pair | null, title: string) => kpi(label, v ? num(v.current) : '—', v ? delta(v.current, v.previous, sel) : html`<div class="d"></div>`, title);
    site = html`<h3 class="sec">The website <small class="muted small">${spanLabel(sel.current)}</small></h3>
      <div class="kpis ga-k3">${k('Page views', pair('screenPageViews'), 'Every page shown on the site')}${k('Sessions', pair('sessions'), 'Visits to the site')}${k('Visitors', pair('totalUsers'), 'People (browsers) who visited')}</div>
      ${!ov.traffic.ok ? problem(ov.traffic.error, o.staff, 'the website’s visits') : ''}`;
  }

  const realtime = html`<div class="card ga-rt"><h2><span class="live-dot">${kind === 'site' ? 'On the site now' : 'Playing now'}</span><small>last 30 minutes · updates every minute</small></h2>
    <div data-realtime="${o.realtimeUrl}">${realtimeBody(rt, { staff: o.staff, land: o.assets.land, game: !!o.scope.game })}</div></div>`;

  let top: Html | string = '';
  const name = (slug: string) => {
    const t = o.titleOf(slug);
    return html`<td class="proj">${t.href ? html`<a href="${t.href}"><b>${t.title}</b></a>` : html`<b>${t.title}</b>`}<span>${t.studio ? html`<a href="${t.studio.href}" title="The studio’s analytics">${t.studio.name}</a> · ` : ''}${slug}</span></td>`;
  };
  const tp = ov.topPages;
  if (!o.scope.game && tp && (!p || !p.games.length)) {
    // No game has plays (yet): the games whose pages were viewed most.
    const rows = tp.ok ? tp.value.slice(0, 10).map((g) => html`<tr>${name(g.slug)}<td class="r num">${num(g.views)}</td><td class="r num">${num(g.clicks)}</td></tr>`) : [];
    top = html`<div class="card ga-games"><h2>Top games <small>by page views, ${spanLabel(sel.current)}</small></h2>
      ${!tp.ok ? problem(tp.error, o.staff, 'the game pages')
        : rows.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th class="r">Page views</th><th class="r" title="Outbound link clicks from the game’s page: the old site’s Play button linked out to the game">Play-button clicks</th></tr></thead><tbody>${rows}</tbody></table></div>
          <p class="small muted">No plays by game yet${p && !p.timed ? ' (Google Analytics doesn’t know the custom dimension game_slug yet)' : ''}, so these are views of each game’s page. Play-button clicks: outbound clicks from the game’s page.</p>`
        : html`<p class="small muted">No views of game pages in this range.</p>`}</div>`;
  } else if (!o.scope.game && p) {
    const rows = p.games.slice(0, 10).map((g) => html`<tr>${name(g.slug)}<td class="r num">${num(g.plays)}</td><td class="r num">${duration(averageSeconds(g))}</td></tr>`);
    top = html`<div class="card ga-games"><h2>Top games <small>by plays, ${spanLabel(sel.current)}</small></h2>
      ${!p.timed ? html`<p class="small muted">Games can be told apart once the custom dimension game_slug is registered in Google Analytics.</p>`
        : rows.length ? html`<div class="tbl-wrap"><table><thead><tr><th>Game</th><th class="r">Plays</th><th class="r">Avg time</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<p class="small muted">No plays in this range yet.</p>`}</div>`;
  }

  return html`${assets}<div class="ga">${chartCard}${kpis}${page}
    <div class="grid ${top ? 'ga-split' : ''}">${realtime}${top}</div>${site}
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
  const canSeeStudio = (u: User, s: Studio) => h.isStaff(u) || !!h.roleIn(u, s);
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

  async function render(u: User, scope: Scope, q: Query, base: string, cat = catalog()) {
    const rtq = scope.game ? `?game=${encodeURIComponent(scope.game)}` : scope.studio ? `?studio=${encodeURIComponent(scope.studio)}` : '';
    const full = scope.game ? { ...scope, pages: cat[scope.game] ?? pagePaths(scope.game, legacy) } : scope;
    const [ov, rt] = await Promise.all([analytics.overview(analytics.selection(q), full, cat), analytics.realtime(scope)]);
    return view(ov, rt, { timeZone: analytics.timeZone, scope, staff: h.isStaff(u), base, realtimeUrl: `/portal/analytics/realtime${rtq}`, assets, titleOf: titleOf(u, !scope.game && !scope.studio) });
  }

  // Which of the makers' own GA4 properties also get these page views and plays (the catalog's analytics.google: the
  // game's measurement id, then its studio's), and where GA shows who plays where. Studio pages and game tabs.
  function ownGa(s: Studio, l: ListingRow | null): Html {
    const game = l?.published?.ga_measurement_id || '';
    const pending = !!l && (l.draft.ga_measurement_id || '') !== game;
    const ids = [...(game ? [html`<span class="mono">${game}</span> (this game)`] : []),
      ...(s.ga_measurement_id && s.ga_measurement_id !== game ? [html`<span class="mono">${s.ga_measurement_id}</span> (${s.name})`] : [])];
    const where = 'In GA4, Reports → User attributes → Demographic details shows where people play by country and city; Realtime shows who is playing now.';
    const set = html`Set one on the <a href="/s/${s.slug}/members#studio">Members page</a> (every ${s.name} game)${l ? html` or this game’s Site listing` : ''}.`;
    return html`<div class="card small" style="margin-bottom:16px"><h2>Your own Google Analytics</h2>
      ${ids.length ? html`<p>Page views and plays ${l ? 'of this game' : `of ${s.name}’s games`} on vaultlearninggames.org also go to ${ids.map((x, i) => html`${i ? ' and ' : ''}${x}`)}. ${where}</p>`
        : html`<p class="muted">None yet: only Vault’s analytics (below) count these plays. Add a GA4 measurement ID to get them, with country and city, in your own property. ${set}</p>`}
      ${pending ? html`<p class="small muted">This game’s Google Analytics ID was changed in its listing; it applies once Vault publishes the listing and the site is rebuilt.</p>` : ''}</div>`;
  }

  app.get('/vault/analytics', async (c) => {
    const u = h.signedIn(c); if (u instanceof Response) return u;
    if (!h.isStaff(u)) return h.denied(c, 'Only Vault staff can see this page.');
    const body = await render(u, {}, queryOf(c), '/vault/analytics');
    return h.page(c, 'Analytics', html`${head('Analytics', 'Plays of the games on vaultlearninggames.org, and visits to the site. Each studio and each game in the portal has the same view for its games.')}${body}`, { active: 'analytics' });
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
    return h.page(c, 'Analytics', html`${head('Analytics', sub)}${ownGa(s, null)}${body}`, { studio: s, active: 'studio-analytics' });
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

  return {
    // A game's Analytics tab (routes.ts): its listing's plays. A game that isn't on the site has none.
    async gameTab(u: User, s: Studio, l: ListingRow | null, c: Parameters<typeof queryOf>[0]): Promise<Html> {
      if (!l) return html`<div class="card"><p class="muted">This game isn’t on the site, so there are no plays to show. Analytics count plays from a game’s page on vaultlearninggames.org.</p></div>`;
      const body = await render(u, { game: l.slug }, queryOf(c), `/s/${s.slug}/g/${l.slug}?tab=analytics`);
      return html`${l.published ? '' : html`<p class="small muted">This game isn’t published on the site yet.</p>`}${ownGa(s, l)}${body}`;
    },
  };
}

export { Analytics };
