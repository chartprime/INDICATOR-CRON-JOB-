/**
 * Time as the chart lays it out. A futures or equity chart has holes in its
 * bars: the nightly break, the weekend. lightweight-charts places bars by
 * index and gives a hole no room, so wall time and chart time part company
 * before every break. Everything the heatmap places by time goes through
 * these two maps: a wall time is moved past the holes that come after it,
 * and a time inside a hole collapses to the hole's end.
 */

/** A stretch of wall time, [start, end), the chart has no bar for. */
export interface TimeGap {
  start: number;
  end: number;
}

/**
 * The holes in a bar list (times in seconds, oldest first). The candle series
 * carries one break point at every hole (`toCandlestickSeries`), so the chart
 * gives a hole one bar of room: the hole starts a bar after the bar before it.
 */
export function barGaps(bars: readonly { time: unknown }[], intervalMs: number): TimeGap[] {
  const gaps: TimeGap[] = [];
  let previous: number | null = null;
  for (const bar of bars) {
    const ms = Number(bar.time) * 1000;
    if (!Number.isFinite(ms)) {
      previous = null;
      continue;
    }
    if (previous !== null && ms - previous > 2 * intervalMs) gaps.push({ start: previous + 2 * intervalMs, end: ms });
    previous = ms;
  }
  return gaps;
}

/** Wall time to chart time: the holes after `ms` are skipped; inside a hole, its end. */
export function chartMsOf(ms: number, gaps: readonly TimeGap[]): number {
  let at = ms;
  let skipped = 0;
  for (let i = gaps.length - 1; i >= 0; i -= 1) {
    const gap = gaps[i];
    if (gap.start >= at) skipped += gap.end - gap.start;
    else {
      if (gap.end > at) at = gap.end;
      break;
    }
  }
  return at + skipped;
}

/** Chart time back to wall time: the inverse of `chartMsOf` wherever the chart has a bar. */
export function wallMsOf(chartMs: number, gaps: readonly TimeGap[]): number {
  let skipped = 0;
  for (let i = gaps.length - 1; i >= 0; i -= 1) {
    const gap = gaps[i];
    if (chartMs >= gap.end + skipped) return chartMs - skipped;
    skipped += gap.end - gap.start;
  }
  return chartMs - skipped;
}
