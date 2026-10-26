import type { RuntimeIndicatorDef, SettingsFieldSchema } from "../../chart/indicatorTypes";

export const LARGE_TRADE_BUBBLES_LOOKBACK = 20;
export const LARGE_TRADE_BUBBLES_DEFAULT_MULTIPLIER = 3;
export const LARGE_TRADE_BUBBLES_MIN_MARKER_SIZE = 1;
export const LARGE_TRADE_BUBBLES_MAX_MARKER_SIZE = 4;
export const LARGE_TRADE_BUBBLES_MAX_MARKERS_PER_BAR = 50;
const BUY_COLOR = "#22c55e";
const SELL_COLOR = "#ef4444";

export interface LargeTradeBubblesSettings {
  multiplier: number;
}

export interface LargeTradeBubblesState {
  baselineSamples: number[];
  lastCommittedTsOpen: number | null;
  maxMagnitudeThisBar: number | null;
}

interface TradeLike {
  price: number;
  size: number;
  side: "buy" | "sell";
}

interface Candidate extends TradeLike {
  ts_exchange: number;
  trade_id: string;
  magnitude: number;
}

function tradeMagnitude(trade: TradeLike, futures: boolean): number {
  if (futures) return trade.size;
  return trade.price * trade.size;
}

function bubbleMarkerSize(magnitude: number, threshold: number): number {
  if (threshold <= 0) return LARGE_TRADE_BUBBLES_MIN_MARKER_SIZE;
  const doublingsPastThreshold = Math.log2(Math.max(magnitude / threshold, 1));
  const size = Math.round(LARGE_TRADE_BUBBLES_MIN_MARKER_SIZE + doublingsPastThreshold);
  return Math.min(Math.max(size, LARGE_TRADE_BUBBLES_MIN_MARKER_SIZE), LARGE_TRADE_BUBBLES_MAX_MARKER_SIZE);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function robustThreshold(samples: readonly number[], multiplier: number): number | null {
  if (samples.length < LARGE_TRADE_BUBBLES_LOOKBACK) return null;
  const center = median(samples);
  const mad = median(samples.map((value) => Math.abs(value - center)));
  return center + multiplier * 1.4826 * mad;
}

function retainLargest(candidates: Candidate[], candidate: Candidate): void {
  if (candidates.length < LARGE_TRADE_BUBBLES_MAX_MARKERS_PER_BAR) {
    candidates.push(candidate);
    return;
  }
  let weakestIndex = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index].magnitude < candidates[weakestIndex].magnitude) weakestIndex = index;
  }
  if (candidate.magnitude > candidates[weakestIndex].magnitude) candidates[weakestIndex] = candidate;
}

function formatMagnitude(magnitude: number, futures: boolean): string {
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(magnitude);
  return futures ? `${formatted} ct` : `$${formatted}`;
}

const LARGE_TRADE_BUBBLES_SETTINGS_SCHEMA: readonly SettingsFieldSchema<LargeTradeBubblesSettings>[] = [
  {
    kind: "numeric",
    key: "multiplier",
    label: "Robustness multiplier",
    min: 1,
    max: 10,
    step: 0.5,
    affects: "liveOnly",
  },
  {
    kind: "staticHint",
    text: "Live-only demo: it needs 20 complete observed chart bars after you add or reload it. Historical bubbles are intentionally unavailable, and a busy bar with incomplete trade capture is skipped rather than guessed.",
  },
];

export const largeTradeBubblesIndicator: RuntimeIndicatorDef<LargeTradeBubblesState, LargeTradeBubblesSettings> = {
  kind: "runtime",
  id: "largeTradeBubbles",
  label: "Large Trade Bubbles (Demo)",
  category: "community",
  defaultSettings: { multiplier: LARGE_TRADE_BUBBLES_DEFAULT_MULTIPLIER },
  lines: [],
  settingsSchema: LARGE_TRADE_BUBBLES_SETTINGS_SCHEMA,
  placement: { kind: "overlay" },
  createState: () => ({
    baselineSamples: [],
    lastCommittedTsOpen: null,
    maxMagnitudeThisBar: null,
  }),
  onBar: (ctx) => {
    const { state, settings } = ctx;
    if (ctx.tradeAvailability !== "LIVE_COMPLETE" || ctx.trades.length === 0) {
      state.maxMagnitudeThisBar = null;
    } else {
      const threshold = robustThreshold(state.baselineSamples, settings.multiplier);
      const futures = ctx.bar.provider === "DXFEED" && ctx.bar.assetClass === "FUTURE";
      let maxMagnitude = 0;
      const candidates: Candidate[] = [];
      for (const trade of ctx.trades) {
        const magnitude = tradeMagnitude(trade, futures);
        if (!Number.isFinite(magnitude) || magnitude <= 0) continue;
        if (magnitude > maxMagnitude) maxMagnitude = magnitude;
        if (threshold !== null && magnitude > threshold) {
          retainLargest(candidates, { ...trade, magnitude });
        }
      }
      candidates
        .sort((left, right) => left.ts_exchange - right.ts_exchange || left.trade_id.localeCompare(right.trade_id))
        .forEach((candidate) => {
          ctx.markers.plotshape({
            shape: "circle",
            position: "atPriceMiddle",
            price: candidate.price,
            color: candidate.side === "buy" ? BUY_COLOR : SELL_COLOR,
            size: bubbleMarkerSize(candidate.magnitude, threshold!),
            text: formatMagnitude(candidate.magnitude, futures),
          });
        });
      state.maxMagnitudeThisBar = maxMagnitude || null;
    }

    if (ctx.bar.closed && state.lastCommittedTsOpen !== ctx.bar.ts_open && state.maxMagnitudeThisBar !== null) {
      state.baselineSamples.push(state.maxMagnitudeThisBar);
      if (state.baselineSamples.length > LARGE_TRADE_BUBBLES_LOOKBACK) state.baselineSamples.shift();
      state.lastCommittedTsOpen = ctx.bar.ts_open;
    }
  },
  readOutput: () => ({}),
};
