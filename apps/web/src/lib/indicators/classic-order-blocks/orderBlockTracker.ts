import {
  MAX_PIVOT_AGE_BARS,
  MAX_STORED_PIVOTS,
  baseOf,
  breaks,
  mitigates,
  zoneFor,
  type OrderBlock,
  type OrderBlockSide,
  type OrderBlockTier,
} from "./orderBlockRules";

export interface TrackedBar {
  time: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PivotRef {
  price: number;
  time: number;
}

export interface PivotInputs {
  primaryHigh: number | null;
  primaryLow: number | null;
  secondaryHigh: number | null;
  secondaryLow: number | null;
}

export interface OrderBlockTrackerState {
  maxBars: number;
  keepStack: boolean;
  maxBlocks: number;
  bars: { time: number; high: number; low: number }[];
  trend: OrderBlockSide | null;
  primaryHighs: PivotRef[];
  primaryLows: PivotRef[];
  secondaryHighs: PivotRef[];
  secondaryLows: PivotRef[];
  activeBlocks: OrderBlock[];
  mitigatedBlocks: OrderBlock[];
}

export function createOrderBlockTrackerState({
  keepStack = true,
  maxBars = MAX_PIVOT_AGE_BARS,
  maxBlocks = 10,
}: {
  keepStack?: boolean;
  maxBars?: number;
  maxBlocks?: number;
} = {}): OrderBlockTrackerState {
  return {
    maxBars,
    keepStack,
    maxBlocks,
    bars: [],
    trend: null,
    primaryHighs: [],
    primaryLows: [],
    secondaryHighs: [],
    secondaryLows: [],
    activeBlocks: [],
    mitigatedBlocks: [],
  };
}

function confirmedPivot(
  state: OrderBlockTrackerState,
  price: number | null,
  rightBars: number,
): PivotRef | null {
  if (price === null) return null;
  const index = state.bars.length - 1 - rightBars;
  return index >= 0 ? { price, time: state.bars[index].time } : null;
}

function remember(
  state: OrderBlockTrackerState,
  list: PivotRef[],
  ref: PivotRef | null,
): void {
  if (ref === null) return;
  if (!state.keepStack) list.length = 0;
  list.push(ref);
  if (list.length > MAX_STORED_PIVOTS) list.shift();
}

function takeBroken(
  list: PivotRef[],
  side: OrderBlockSide,
  close: number,
): PivotRef | null {
  let oldest: PivotRef | null = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const ref = list[index];
    if (!breaks(side, ref.price, close)) continue;
    if (oldest === null || ref.time < oldest.time) oldest = ref;
    list.splice(index, 1);
  }
  return oldest;
}

function baseSince(
  state: OrderBlockTrackerState,
  pivotTime: number,
  side: OrderBlockSide,
): { base: number; time: number } | null {
  let index = state.bars.length - 1;
  while (index >= 0 && state.bars[index].time !== pivotTime) index -= 1;
  if (index < 0) return null;
  let base = side === "bullish" ? Infinity : -Infinity;
  let time = pivotTime;
  for (let i = index; i < state.bars.length; i += 1) {
    const bar = state.bars[i];
    if (side === "bullish") {
      if (bar.low < base) {
        base = bar.low;
        time = bar.time;
      }
    } else {
      if (bar.high > base) {
        base = bar.high;
        time = bar.time;
      }
    }
  }
  return { base, time };
}

function alreadyStanding(
  state: OrderBlockTrackerState,
  side: OrderBlockSide,
  tier: OrderBlockTier,
  base: number,
): boolean {
  return state.activeBlocks.some(
    (block) =>
      block.side === side &&
      block.tier === tier &&
      block.mitigatedTime === null &&
      baseOf(block) === base,
  );
}

function overlapsExisting(
  state: OrderBlockTrackerState,
  side: OrderBlockSide,
  top: number,
  bottom: number,
): boolean {
  return state.activeBlocks.some(
    (block) =>
      block.side === side &&
      block.mitigatedTime === null &&
      top > block.bottom &&
      bottom < block.top,
  );
}

function form(
  state: OrderBlockTrackerState,
  side: OrderBlockSide,
  tier: OrderBlockTier,
  pivot: PivotRef,
  breakTime: number,
  width: number | null,
  volume: number,
): void {
  if (width === null) return;
  const origin = baseSince(state, pivot.time, side);
  if (origin === null || alreadyStanding(state, side, tier, origin.base))
    return;
  const { top, bottom } = zoneFor(side, origin.base, width);
  if (overlapsExisting(state, side, top, bottom)) return;
  state.activeBlocks.push({
    side,
    tier,
    pivotTime: pivot.time,
    baseTime: origin.time,
    breakTime,
    top,
    bottom,
    mitigatedTime: null,
    volume,
  });
}

export function advanceOrderBlocks(
  state: OrderBlockTrackerState,
  bar: TrackedBar,
  pivots: PivotInputs,
  width: number | null,
  rightBars: number,
): void {
  const last = state.bars[state.bars.length - 1];
  if (last !== undefined && last.time === bar.time) return;
  state.bars.push({ time: bar.time, high: bar.high, low: bar.low });
  if (state.bars.length > state.maxBars) state.bars.shift();

  remember(
    state,
    state.primaryHighs,
    confirmedPivot(state, pivots.primaryHigh, rightBars),
  );
  remember(
    state,
    state.primaryLows,
    confirmedPivot(state, pivots.primaryLow, rightBars),
  );
  remember(
    state,
    state.secondaryHighs,
    confirmedPivot(state, pivots.secondaryHigh, rightBars),
  );
  remember(
    state,
    state.secondaryLows,
    confirmedPivot(state, pivots.secondaryLow, rightBars),
  );

  const brokenHigh = takeBroken(state.primaryHighs, "bullish", bar.close);
  if (brokenHigh !== null) {
    form(state, "bullish", "primary", brokenHigh, bar.time, width, bar.volume);
    state.trend = "bullish";
  }
  const brokenLow = takeBroken(state.primaryLows, "bearish", bar.close);
  if (brokenLow !== null) {
    form(state, "bearish", "primary", brokenLow, bar.time, width, bar.volume);
    state.trend = "bearish";
  }
  if (state.trend === "bullish") {
    const secondary = takeBroken(state.secondaryHighs, "bullish", bar.close);
    if (secondary !== null)
      form(
        state,
        "bullish",
        "secondary",
        secondary,
        bar.time,
        width,
        bar.volume,
      );
  }
  if (state.trend === "bearish") {
    const secondary = takeBroken(state.secondaryLows, "bearish", bar.close);
    if (secondary !== null)
      form(
        state,
        "bearish",
        "secondary",
        secondary,
        bar.time,
        width,
        bar.volume,
      );
  }

  const stillActive: OrderBlock[] = [];
  for (const block of state.activeBlocks) {
    if (
      block.mitigatedTime === null &&
      bar.time > block.breakTime &&
      mitigates(block, bar)
    ) {
      block.mitigatedTime = bar.time;
      state.mitigatedBlocks.push(block);
      if (state.mitigatedBlocks.length > 200) {
        state.mitigatedBlocks.shift();
      }
    } else {
      stillActive.push(block);
    }
  }
  state.activeBlocks = stillActive;
  if (state.activeBlocks.length > state.maxBlocks) {
    state.activeBlocks.splice(0, state.activeBlocks.length - state.maxBlocks);
  }
}
