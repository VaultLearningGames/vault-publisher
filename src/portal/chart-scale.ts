// A chart axis's scale: from 0 to the smallest "nice" top (1, 2, 2.5 or 5 times a power of ten) at or above the
// largest value, with evenly spaced ticks — whole numbers whenever the top is at least the tick count. Missing values
// (null, a day not counted) don't count towards it; nothing (or only zeros) gives 0 to 1. The analytics chart's blog
// reads use it for their own (right-hand) axis, so their line keeps its shape beside far larger (or smaller) plays.
export interface AxisScale { min: 0; max: number; ticks: number[] }

const NICE = [1, 2, 2.5, 5, 10];
// m × 10^e without the float noise of 2.5 * 0.1 and the like.
const times = (m: number, e: number) => +(e >= 0 ? m * 10 ** e : m / 10 ** -e).toPrecision(12);

export function computeAxisScale(values: readonly (number | null | undefined)[], tickCount = 4): AxisScale {
  const top = Math.max(0, ...values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  if (top <= 0) return { min: 0, max: 1, ticks: [0, 1] };
  const e = Math.floor(Math.log10(top));
  let max = times(10, e);
  for (const m of NICE) { const c = times(m, e); if (c >= top) { max = c; break; } }
  const want = Math.max(1, Math.floor(tickCount));
  // The number of steps: tickCount if its steps are whole numbers, else the nearest count that gives whole steps
  // (25 in 5 steps of 5, not 4 of 6.25); a top below the tick count goes up in ones (or halves, for 2.5).
  let steps = want;
  if (max >= want) {
    for (let d = 0; d <= want; d++) {
      const up = want + d, down = want - d;
      if (Number.isInteger(max / up)) { steps = up; break; }
      if (down >= 1 && Number.isInteger(max / down)) { steps = down; break; }
    }
  } else if (max >= 1) steps = Number.isInteger(max) ? max : Math.round(max * 2);
  const ticks = Array.from({ length: steps + 1 }, (_, i) => +((max * i) / steps).toPrecision(12));
  return { min: 0, max, ticks };
}
