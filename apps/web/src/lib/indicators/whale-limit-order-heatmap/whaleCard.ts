import { fmtDuration, fmtPrice, fmtSize, fmtUsd, fmtUtc } from "./whaleFormat";
import type { StandingWall, WhaleWall } from "./wallStore";

export interface WhaleCard {
  readonly side: 0 | 1;
  readonly title: string;
  readonly usd: string;
  readonly sentence: string;
  readonly meterPct: number | null;
  readonly facts: string;
  readonly details: readonly (readonly [string, string])[];
}

const OUTCOME_LABELS = ["FILLED", "PARTIAL", "TOUCHED", "PULLED", "MOVED"] as const;

export interface CardContext {
  readonly coin: string;
  readonly rowWidth: number;
}

export interface StandingContext extends CardContext {
  readonly now: number;
  readonly lastClose: number | null;
}

function tradedShare(wall: WhaleWall): number {
  const traded = wall.wall.detail?.traded ?? 0;
  return wall.peak > 0 ? Math.min(100, Math.round((100 * traded) / wall.peak)) : 0;
}

function sentenceOf(wall: WhaleWall, share: number): string {
  const bid = wall.side === 0;
  const who = bid ? "Sellers" : "Buyers";
  const side = bid ? "bid" : "ask";
  const usd = fmtUsd(wall.usd);
  const life = fmtDuration(wall.end - wall.start);
  if (wall.outcome === 0) return `${who} ate ${share}% of this ${usd} ${side} in ${life}.`;
  if (wall.outcome === 1) return `${who} took a ${share}% bite out of this ${usd} ${side}; it ended after ${life}.`;
  if (wall.outcome === 2) return `Price reached this ${usd} ${side} but only ${share}% traded; it ended after ${life}.`;
  if (wall.outcome === 3) {
    const distance = wall.wall.detail?.endDistancePct ?? null;
    return `Pulled after ${life}${distance === null ? "" : `, ${distance.toFixed(1)}% away from price`}; ${share < 1 ? "nothing traded" : `${share}% traded`}.`;
  }
  return `Cancelled and re-placed nearby within seconds (it had lived ${life}).`;
}

function detailsOf(wall: WhaleWall, rowWidth: number): readonly (readonly [string, string])[] {
  const detail = wall.wall.detail;
  const firstBite = detail === null || detail.firstShrinkTs === null ? "none seen" : `${fmtUtc(detail.firstShrinkTs, true)} (${detail.firstShrinkExact ? "seen" : "estimated"})`;
  const repeats = detail === null ? null : detail.repeats || 1;
  const wide = wall.hi - wall.lo > rowWidth * 1.5;
  return [
    ["First bite", firstBite],
    ["Placed at this level", repeats === null ? "n/a" : `${repeats}x in the last hour`],
    ["Other-side orders nearby", detail === null ? "n/a" : `${Math.round(100 * detail.crossSideShare)}%`],
    ["Ended", detail === null || detail.endDistancePct === null ? "n/a" : `${detail.endDistancePct.toFixed(2)}% from price`],
    ["Importance", Number.isFinite(wall.wall.ratio) && wall.wall.ratio > 0 ? `${wall.wall.ratio.toFixed(1)}x usual wall` : "n/a"],
    ["Price", `${fmtPrice(wall.lo, rowWidth)}${wide ? ` to ${fmtPrice(wall.hi, rowWidth)}` : ""}`],
  ];
}

export function describeWall(wall: WhaleWall, context: CardContext): WhaleCard {
  const share = tradedShare(wall);
  return {
    side: wall.side,
    title: `${wall.side === 0 ? "BID" : "ASK"} · ${OUTCOME_LABELS[wall.outcome]}`,
    usd: fmtUsd(wall.usd),
    sentence: sentenceOf(wall, share),
    meterPct: share,
    facts: `${fmtSize(wall.peak)} ${context.coin} · ${fmtDuration(wall.end - wall.start)} · ${fmtUtc(wall.start)} to ${fmtUtc(wall.end)} UTC`,
    details: detailsOf(wall, context.rowWidth),
  };
}

export function describeStanding(wall: StandingWall, context: StandingContext): WhaleCard {
  const mid = (wall.lo + wall.hi) / 2;
  const resting = fmtDuration(context.now - wall.start);
  let sentence = `Resting for ${resting}.`;
  if (context.lastClose !== null && context.lastClose > 0) {
    const distance = (100 * (mid - context.lastClose)) / context.lastClose;
    sentence = `Resting for ${resting}, ${Math.abs(distance).toFixed(2)}% ${distance >= 0 ? "above" : "below"} price.`;
  }
  return {
    side: wall.side,
    title: `${wall.side === 0 ? "BID" : "ASK"} · STANDING NOW`,
    usd: fmtUsd(wall.usd),
    sentence,
    meterPct: null,
    facts: `${fmtSize(wall.peak)} ${context.coin} · at ${fmtPrice(mid, context.rowWidth)}`,
    details: [],
  };
}
