// When a scheduled deploy should be done, for the deploy bar's "A deploy is scheduled" line: from when it started (or
// was scheduled) plus how long a deploy usually takes. public/portal.js formats it the same way as formatDeployEta.

export const DEFAULT_DEPLOY_ESTIMATE_MINUTES = 10;
// Durations whose median makes the estimate.
const RECENT = 5;

// DEPLOY_ESTIMATE_MINUTES (a positive integer), else DEFAULT_DEPLOY_ESTIMATE_MINUTES.
export function deployEstimateMinutes(raw: string | undefined = process.env.DEPLOY_ESTIMATE_MINUTES): number {
  const s = raw?.trim() ?? '';
  const n = Number(s);
  return /^\d+$/.test(s) && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DEPLOY_ESTIMATE_MINUTES;
}

const validDate = (d: Date | null | undefined): d is Date => d instanceof Date && Number.isFinite(d.getTime());

// The expected completion: (startedAt ?? scheduledAt) plus the median of the last RECENT positive durations, or
// defaultDurationMs when there are none. null without a start.
export function estimateDeployCompletion(opts: { now: Date; scheduledAt?: Date | null; startedAt?: Date | null; recentDurationsMs?: number[]; defaultDurationMs: number }): Date | null {
  const base = validDate(opts.startedAt) ? opts.startedAt : validDate(opts.scheduledAt) ? opts.scheduledAt : null;
  if (!base) return null;
  const durations = (opts.recentDurationsMs ?? []).filter((d) => Number.isFinite(d) && d > 0).slice(-RECENT).sort((a, b) => a - b);
  let duration = opts.defaultDurationMs;
  if (durations.length) {
    const mid = durations.length >> 1;
    duration = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  }
  return new Date(base.getTime() + duration);
}

// The sentence after "A deploy is scheduled — …": relative only (no clock time). null without an estimate.
export function formatDeployEta(now: Date, eta: Date | null): string | null {
  if (!validDate(eta)) return null;
  const minutes = Math.ceil((eta.getTime() - now.getTime()) / 60_000);
  if (!(minutes > 0)) return 'It should be live shortly.';
  if (minutes < 60) return `Estimated completion in about ${minutes} min.`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `Estimated completion in about ${h} h${m ? ` ${m} min` : ''}.`;
}
