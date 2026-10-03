// The links check: asks every link, frame, form and video of every page whether it leads somewhere, and hands the
// answers to the contract's linkFinding().
import { hrefProblem, linkFinding } from '../site-checks.ts';
import type { LinkProbe, LinkSeen, Progress, RawFinding } from '../site-checks.ts';
import { makeGetter, makeProber } from './net.ts';
import type { Connection } from './net.ts';
import { normalisePath, oembedUrl, youtubeWatchUrl } from './util.ts';
import type { Visit } from './visit.ts';

export interface LinkEnv { origin: string; guard: boolean; signal?: AbortSignal; progress?: (p: Progress) => void; connection?: Connection }

// What the visit already learned about a page of the site, as a probe; null when it has to be asked for.
function fromVisit(link: LinkSeen, origin: string, visits: Map<string, Visit>): LinkProbe | null {
  let u: URL;
  try { u = new URL(link.url); } catch { return null; }
  if (u.origin !== origin || u.search) return null;
  const visit = visits.get(normalisePath(u.pathname));
  if (!visit || visit.load.status === null) return null;
  const anchorFound = link.fragment === '' ? null : link.fragment.toLowerCase() === 'top' ? true
    : visit.ids.has(link.fragment) || visit.ids.has(safeDecode(link.fragment));
  return { status: visit.load.status, error: null, finalUrl: link.url, attempts: 1, anchorFound };
}
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export async function checkLinks(env: LinkEnv, visits: Map<string, Visit>, sitemapUrls: string[]): Promise<{ findings: RawFinding[]; checked: number }> {
  const findings: RawFinding[] = [];
  const all: LinkSeen[] = [];
  const seenLink = new Set<string>();
  const push = (l: LinkSeen) => {
    const key = `${l.page}\n${l.kind}\n${l.raw}`;
    if (!seenLink.has(key)) { seenLink.add(key); all.push(l); }
  };
  for (const v of visits.values()) for (const l of v.links) push(l);
  for (const url of sitemapUrls) push({ page: '', url, fragment: '', raw: url, text: '', kind: 'sitemap' });

  // Which addresses need a request: one per address, however many links lead there. YouTube goes through oEmbed.
  const jobs: { link: LinkSeen; local: LinkProbe | null; target: string }[] = [];
  for (const link of all) {
    const problem = hrefProblem(link.raw);
    if (problem === 'skip') continue;
    if (problem) { findings.push({ check: 'links', level: problem.level, code: 'link.invalid', page: link.page, target: link.raw, message: problem.message, detail: { status: null, kind: link.kind, text: link.text.slice(0, 120), error: null, final: null } }); continue; }
    if (!/^https?:\/\//i.test(link.url)) continue;
    const video = youtubeWatchUrl(link.url);
    const local = video ? null : fromVisit(link, env.origin, visits);
    jobs.push({ link: video ? { ...link, kind: 'video' } : link, local, target: video ? oembedUrl(video) : link.url });
  }
  const targets = [...new Set(jobs.filter((j) => !j.local).map((j) => j.target))];
  const prober = makeProber(makeGetter(env.guard), 8, 2, env.signal, env.connection);
  const answers = new Map<string, LinkProbe>();
  let done = 0;
  env.progress?.({ phase: 'links', done, total: targets.length });
  await Promise.all(targets.map(async (t) => {
    answers.set(t, await prober(t));
    env.progress?.({ phase: 'links', done: ++done, total: targets.length });
  }));
  for (const j of jobs) {
    const probe = j.local ?? answers.get(j.target);
    if (!probe) continue;
    const f = linkFinding(j.link, probe, env.origin);
    if (f) findings.push(f);
  }
  return { findings, checked: jobs.length };
}
