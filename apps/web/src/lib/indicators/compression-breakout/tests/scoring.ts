import type { BarFrame } from "../../../../types/frames";
import type { CompressionBreakoutLabels, Outputs } from "../../../chart/validation";

/**
 * The scoring of the brief and amendment 8, identical for every def:
 * matched = a break event inside `[breakoutIndex, breakoutIndex + 2]`; hit =
 * the first matched event carries the labelled direction; wrong-direction = a
 * break event opposing the label inside that window; early = before the
 * window (split at `compressionStart`); unmatched = after it; missed = no
 * matched event; level valid = on a hit, the frozen edges lie inside the
 * labelled compression range and the close is beyond the tested edge.
 * Filtering keeps only events whose bar passes the identical activity test
 * (true range or volume at or above 1.5 times the mean of the preceding 20
 * bars), computed here from the bars alone, independently of any def.
 */

export interface BreakEvent {
  index: number;
  dir: number;
  grade: number | null;
}

export function breakEventsOf(outputs: Outputs): BreakEvent[] {
  const events: BreakEvent[] = [];
  const dirs = outputs.breakDir ?? [];
  const grades = outputs.breakGrade;
  dirs.forEach((dir, index) => {
    if (dir !== null && dir !== 0) events.push({ index, dir, grade: grades === undefined ? null : (grades[index] ?? null) });
  });
  return events;
}

/** The identical activity filter: true range or volume at least 1.5× the mean of the preceding 20 bars. */
export function activityFlags(bars: readonly BarFrame[], multiple = 1.5): boolean[] {
  const flags: boolean[] = [];
  const trs: number[] = [];
  const vols: number[] = [];
  let prevClose: number | null = null;
  for (const bar of bars) {
    const tr = prevClose === null ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    const mean = (values: number[]): number | null => (values.length < 20 ? null : values.slice(-20).reduce((a, b) => a + b, 0) / 20);
    const avgTr = mean(trs);
    const avgVol = mean(vols);
    const rangePass = avgTr !== null && avgTr > 0 && tr >= multiple * avgTr;
    const volumePass = avgVol !== null && avgVol > 0 && bar.volume >= multiple * avgVol;
    flags.push(rangePass || volumePass);
    trs.push(tr);
    vols.push(bar.volume);
    prevClose = bar.close;
  }
  return flags;
}

export interface Score {
  hit: 0 | 1;
  wrongDirection: number;
  matched: number;
  early: number;
  earlyLead: number;
  earlyCompression: number;
  unmatched: number;
  missed: 0 | 1;
  /** 1 when the hit's edges and close satisfy the level rule; 0 when a hit fails it; null without a hit or without edges. */
  levelValid: 0 | 1 | null;
}

export function scoreBreakout(
  bars: readonly BarFrame[],
  outputs: Outputs,
  labels: CompressionBreakoutLabels,
  filter: readonly boolean[] | null = null,
  tolerance = 2,
): Score {
  const events = breakEventsOf(outputs).filter((event) => filter === null || filter[event.index]);
  const b = labels.breakoutIndex;
  const score: Score = { hit: 0, wrongDirection: 0, matched: 0, early: 0, earlyLead: 0, earlyCompression: 0, unmatched: 0, missed: 0, levelValid: null };
  let first: BreakEvent | null = null;
  for (const event of events) {
    if (event.index >= b && event.index <= b + tolerance) {
      score.matched += 1;
      if (event.dir !== labels.direction) score.wrongDirection += 1;
      if (first === null) first = event;
    } else if (event.index < b) {
      score.early += 1;
      if (event.index < labels.compressionStart) score.earlyLead += 1;
      else score.earlyCompression += 1;
    } else {
      score.unmatched += 1;
    }
  }
  if (first === null) {
    score.missed = 1;
    return score;
  }
  if (first.dir === labels.direction) {
    score.hit = 1;
    const hi = outputs.activeHigh?.[first.index];
    const lo = outputs.activeLow?.[first.index];
    if (hi !== undefined && lo !== undefined && hi !== null && lo !== null) {
      const close = bars[first.index].close;
      const beyond = labels.direction > 0 ? close > hi : close < lo;
      score.levelValid = hi <= labels.compressionHigh + 1e-9 && lo >= labels.compressionLow - 1e-9 && beyond ? 1 : 0;
    }
  }
  return score;
}

export function addScores(total: Record<string, number>, score: Score): void {
  for (const [key, value] of Object.entries(score)) {
    if (value === null) continue;
    total[key] = (total[key] ?? 0) + value;
  }
  if (score.levelValid !== null) total.levelChecked = (total.levelChecked ?? 0) + 1;
}

/** The labelled outcome: a break at `breakoutIndex` and the pulse at `outcomeIndex`. */
export function outcomeHit(outputs: Outputs, breakoutIndex: number, outcomeIndex: number, key: "failed" | "heldOutside"): boolean {
  const broke = (outputs.breakDir?.[breakoutIndex] ?? 0) !== 0;
  const outcome = (outputs[key]?.[outcomeIndex] ?? 0) === 1;
  return broke && outcome;
}
