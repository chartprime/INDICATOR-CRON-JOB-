import type {
  IndicatorBarCtx,
  RuntimeIndicatorDef,
} from "../../chart/indicatorTypes";
import { ta } from "../../chart/ta";
import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import type { LineHandle } from "../../chart/draw/line";
import {
  DEFAULT_L1_ORDER_BLOCK_SETTINGS,
  L1_ORDER_BLOCK_SETTINGS_SCHEMA,
  ZONE_WIDTH_LENGTH,
  type L1OrderBlockSettings,
  type L1OrderBlock,
} from "./l1OrderBlockRules";
import { formatLiquiditySize } from "../passive-liquidity/liquiditySettings";
import {
  computeOrderBlockL1Stats,
  type BarStats,
} from "./l1OrderBlockEvidence";
import { withOpacity } from "../volume-profile/profilePeriodGeometry";
import { barSides } from "../barSides";

const MAX_BARS_HISTORY = 2000;
const POOL_SIZE = 100;

export function activityEndTime(
  times: readonly number[],
  startTime: number,
  endTime: number,
  ratio: number,
): number {
  if (ratio <= 0) return startTime;
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < startTime) lo = mid + 1;
    else hi = mid;
  }
  if (times[lo] !== startTime) return startTime;
  const start = lo;
  lo = start;
  hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < endTime) lo = mid + 1;
    else hi = mid;
  }
  const count = lo - start;
  if (count <= 0) return startTime;
  const bars = Math.max(1, Math.min(count, Math.round(count * ratio)));
  return bars === count ? endTime : times[start + bars];
}

export interface PivotRef {
  price: number;
  time: number;
}

export interface L1OrderBlocksState {
  pivotHigh: ReturnType<typeof ta.pivotHigh>;
  pivotLow: ReturnType<typeof ta.pivotLow>;
  range: ReturnType<typeof ta.sma>;
  bars: BarStats[];
  primaryHighs: PivotRef[];
  primaryLows: PivotRef[];
  activeBlocks: L1OrderBlock[];
  mitigatedBlocks: L1OrderBlock[];
  boxes: BoxHandle[];
  buyBoxes: BoxHandle[];
  sellBoxes: BoxHandle[];
  meanLinePool: LineHandle[];
  lastActiveCount: number;
}

export const l1OrderBlocksIndicator: RuntimeIndicatorDef<
  L1OrderBlocksState,
  L1OrderBlockSettings
> = {
  kind: "runtime",
  id: "l1OrderBlocks",
  label: "L1 Order Blocks",
  category: "l1",
  defaultSettings: DEFAULT_L1_ORDER_BLOCK_SETTINGS,
  settingsSchema: L1_ORDER_BLOCK_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState(settings: L1OrderBlockSettings): L1OrderBlocksState {
    const L = settings.pivotLength;
    return {
      pivotHigh: ta.pivotHigh(L, L),
      pivotLow: ta.pivotLow(L, L),
      range: ta.sma(ZONE_WIDTH_LENGTH),
      bars: [],
      primaryHighs: [],
      primaryLows: [],
      activeBlocks: [],
      mitigatedBlocks: [],
      lastActiveCount: 0,
      boxes: Array.from({ length: POOL_SIZE }, () =>
        draw.box({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          borderColor: "transparent",
          backgroundColor: "transparent",
          text: "",
          fontSize: 11,
          textAlign: "left",
          cornerRadius: 4,
          textPadding: 6,
          keepTextClear: true,
          textAfterBox: true,
        }),
      ),
      buyBoxes: Array.from({ length: POOL_SIZE }, () =>
        draw.box({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          borderColor: "transparent",
          backgroundColor: "transparent",
          text: "",
          textColor: "#ffffff",
          textAlign: "right",
          fontSize: 9,
          borderWidth: 0,
        }),
      ),
      sellBoxes: Array.from({ length: POOL_SIZE }, () =>
        draw.box({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          borderColor: "transparent",
          backgroundColor: "transparent",
          text: "",
          textColor: "#ffffff",
          textAlign: "right",
          fontSize: 9,
          borderWidth: 0,
        }),
      ),
      meanLinePool: Array.from({ length: POOL_SIZE }, () =>
        draw.line({
          time1: 0,
          price1: 0,
          price2: 0,
          time2: 0,
          color: "transparent",
          width: 1,
          style: "dashed",
        }),
      ),
    };
  },
  onBar(ctx: IndicatorBarCtx<L1OrderBlocksState, L1OrderBlockSettings>): void {
    const { bar, state, settings, replace } = ctx;
    const sides = barSides(bar);
    const highVal = state.pivotHigh.push(bar.high, replace);
    const lowVal = state.pivotLow.push(bar.low, replace);
    const rangeVal = state.range.push(bar.high - bar.low, replace);

    const barObj: BarStats = {
      time: bar.ts_open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      buy_volume: bar.provider !== "BINANCE"
        ? bar.buy_volume ?? null
        : sides.known ? sides.buy : null,
      sell_volume: bar.provider !== "BINANCE"
        ? bar.sell_volume ?? null
        : sides.known ? sides.sell : null,
    };

    if (replace && state.bars.length > 0) {
      state.bars[state.bars.length - 1] = barObj;
    } else {
      state.bars.push(barObj);
      if (state.bars.length > MAX_BARS_HISTORY + 200) {
        state.bars.splice(0, state.bars.length - MAX_BARS_HISTORY);
      }
    }

    if (!bar.closed) return;

    const L = settings.pivotLength;
    if (highVal !== null) {
      const confirmedBar = state.bars[state.bars.length - 1 - L];
      if (confirmedBar) {
        state.primaryHighs.push({ price: highVal, time: confirmedBar.time });
        if (state.primaryHighs.length > 32) state.primaryHighs.shift();
      }
    }

    if (lowVal !== null) {
      const confirmedBar = state.bars[state.bars.length - 1 - L];
      if (confirmedBar) {
        state.primaryLows.push({ price: lowVal, time: confirmedBar.time });
        if (state.primaryLows.length > 32) state.primaryLows.shift();
      }
    }

    for (const block of state.activeBlocks) {
      if (block.side === "bullish") {
        if (bar.close < block.bottom) {
          block.mitigatedTime = bar.ts_open;
        }
      } else {
        if (bar.close > block.top) {
          block.mitigatedTime = bar.ts_open;
        }
      }
    }

    const newlyMitigated = state.activeBlocks.filter(
      (b) => b.mitigatedTime !== null,
    );
    state.activeBlocks = state.activeBlocks.filter(
      (b) => b.mitigatedTime === null,
    );
    state.mitigatedBlocks.push(...newlyMitigated);
    if (state.mitigatedBlocks.length > 150) {
      state.mitigatedBlocks.splice(0, state.mitigatedBlocks.length - 150);
    }

    const width =
      rangeVal === null
        ? bar.high - bar.low
        : rangeVal * settings.widthMultiplier;

    for (let index = state.primaryHighs.length - 1; index >= 0; index -= 1) {
      const ref = state.primaryHighs[index];
      if (bar.close > ref.price) {
        let lowest = Infinity;
        let lowestTime = ref.time;
        const pivotIdx = state.bars.findIndex((b) => b.time === ref.time);
        if (pivotIdx < 0) {
          state.primaryHighs.splice(index, 1);
          continue;
        }
        const searchBars = state.bars.slice(pivotIdx);
        for (const b of searchBars) {
          if (b.time <= bar.ts_open) {
            if (b.low < lowest) {
              lowest = b.low;
              lowestTime = b.time;
            }
          }
        }
        if (lowest === Infinity) {
          lowest = ref.price;
          lowestTime = ref.time;
        }

        const top = lowest + width;
        const bottom = lowest;

        const overlaps = state.activeBlocks.some(
          (b) => b.side === "bullish" && top > b.bottom && bottom < b.top,
        );

        if (!overlaps) {
          const stats = computeOrderBlockL1Stats(
            state.bars,
            "bullish",
            lowestTime,
            bar.ts_open,
          );
          const newBlock: L1OrderBlock = {
            id: `bull-${ref.time}-${bar.ts_open}`,
            side: "bullish",
            pivotPrice: ref.price,
            pivotTime: lowestTime,
            breakTime: bar.ts_open,
            top,
            bottom,
            mitigatedTime: null,
            buyVolume: stats.buyVolume,
            sellVolume: stats.sellVolume,
            delta: stats.delta,
            totalVolume: stats.totalVolume,
            unknownVolume: stats.unknownVolume,
          };
          state.activeBlocks.push(newBlock);
        }

        state.primaryHighs.splice(index, 1);
      }
    }

    for (let index = state.primaryLows.length - 1; index >= 0; index -= 1) {
      const ref = state.primaryLows[index];
      if (bar.close < ref.price) {
        let highest = -Infinity;
        let highestTime = ref.time;
        const pivotIdx = state.bars.findIndex((b) => b.time === ref.time);
        if (pivotIdx < 0) {
          state.primaryLows.splice(index, 1);
          continue;
        }
        const searchBars = state.bars.slice(pivotIdx);
        for (const b of searchBars) {
          if (b.time <= bar.ts_open) {
            if (b.high > highest) {
              highest = b.high;
              highestTime = b.time;
            }
          }
        }
        if (highest === -Infinity) {
          highest = ref.price;
          highestTime = ref.time;
        }

        const top = highest;
        const bottom = highest - width;

        const overlaps = state.activeBlocks.some(
          (b) => b.side === "bearish" && top > b.bottom && bottom < b.top,
        );

        if (!overlaps) {
          const stats = computeOrderBlockL1Stats(
            state.bars,
            "bearish",
            highestTime,
            bar.ts_open,
          );
          const newBlock: L1OrderBlock = {
            id: `bear-${ref.time}-${bar.ts_open}`,
            side: "bearish",
            pivotPrice: ref.price,
            pivotTime: highestTime,
            breakTime: bar.ts_open,
            top,
            bottom,
            mitigatedTime: null,
            buyVolume: stats.buyVolume,
            sellVolume: stats.sellVolume,
            delta: stats.delta,
            totalVolume: stats.totalVolume,
            unknownVolume: stats.unknownVolume,
          };
          state.activeBlocks.push(newBlock);
        }

        state.primaryLows.splice(index, 1);
      }
    }

    if (state.activeBlocks.length > settings.maxBlocks) {
      state.activeBlocks.splice(0, state.activeBlocks.length - settings.maxBlocks);
    }

    if (ctx.drawNow === false) return;

    const visibleActive = state.activeBlocks.slice(-settings.maxBlocks);
    const mitigatedSlots = Math.min(settings.maxBlocks, POOL_SIZE - visibleActive.length);
    const visibleMitigated = settings.showMitigated && mitigatedSlots > 0
      ? state.mitigatedBlocks.slice(-mitigatedSlots)
      : [];
    const allVisible = [...visibleActive, ...visibleMitigated];
    const currentVisibleCount = allVisible.length;
    const barTimes = state.bars.map((item) => item.time);

    const renderLimit = Math.max(state.lastActiveCount, currentVisibleCount);
    state.lastActiveCount = currentVisibleCount;

    for (let i = 0; i < renderLimit; i++) {
      const box = state.boxes[i];
      const buyBox = state.buyBoxes[i];
      const sellBox = state.sellBoxes[i];
      const meanLine = state.meanLinePool[i];
      if (!box || !buyBox || !sellBox || !meanLine) continue;

      const block = allVisible[i];
      if (block === undefined) {
        box.setLeftTop(0, 0);
        box.setRightBottom(0, 0);
        box.setBorderColor("transparent");
        box.setBackgroundColor("transparent");
        box.setText("");
        buyBox.setLeftTop(0, 0);
        buyBox.setRightBottom(0, 0);
        buyBox.setBackgroundColor("transparent");
        buyBox.setText("");
        sellBox.setLeftTop(0, 0);
        sellBox.setRightBottom(0, 0);
        sellBox.setBackgroundColor("transparent");
        sellBox.setText("");
        meanLine.setColor("transparent");
        continue;
      }

      const isBull = block.side === "bullish";
      const baseColor = isBull ? settings.bullishColor : settings.bearishColor;
      const isMitigated = block.mitigatedTime !== null;
      const bgColor = isMitigated ? baseColor + "15" : baseColor + "25";

      const endTime = block.mitigatedTime ?? bar.ts_open;
      const totalVol = block.totalVolume || 0;
      const buyVol = block.buyVolume || 0;
      const sellVol = block.sellVolume || 0;
      const buyRatio = totalVol > 0 ? Math.min(1, buyVol / totalVol) : 0;
      const sellRatio = totalVol > 0 ? Math.min(1, sellVol / totalVol) : 0;

      const buyEndTime = activityEndTime(barTimes, block.pivotTime, endTime, buyVol > 0 ? buyRatio : 0);
      const sellEndTime = activityEndTime(barTimes, block.pivotTime, endTime, sellVol > 0 ? sellRatio : 0);
      const midPrice = (block.top + block.bottom) / 2;

      box.setLeftTop(block.pivotTime, block.top);
      box.setRightBottom(endTime, block.bottom);
      box.setBorderColor(baseColor);
      box.setBorderWidth(1);
      box.setBackgroundColor(bgColor);
      box.setTailFade(!isMitigated);

      if (settings.showTradingActivity && totalVol > 0) {
        buyBox.setLeftTop(block.pivotTime, block.top);
        buyBox.setRightBottom(buyEndTime, midPrice);
        buyBox.setBackgroundColor(withOpacity(settings.bullishColor, 0.55));
        buyBox.setBorderColor("transparent");
        buyBox.setBorderWidth(0);
        buyBox.setText(
          `${Math.round(buyRatio * 100)}% (${formatLiquiditySize(buyVol)})`,
        );

        sellBox.setLeftTop(block.pivotTime, midPrice);
        sellBox.setRightBottom(sellEndTime, block.bottom);
        sellBox.setBackgroundColor(withOpacity(settings.bearishColor, 0.55));
        sellBox.setBorderColor("transparent");
        sellBox.setBorderWidth(0);
        sellBox.setText(
          `${Math.round(sellRatio * 100)}% (${formatLiquiditySize(sellVol)})`,
        );
      } else {
        buyBox.setBackgroundColor("transparent");
        buyBox.setText("");
        sellBox.setBackgroundColor("transparent");
        sellBox.setText("");
      }

      if (settings.showMeanLine && !isMitigated) {
        meanLine.setXY1(block.pivotTime, midPrice);
        meanLine.setXY2(endTime, midPrice);
        meanLine.setColor(baseColor);
      } else {
        meanLine.setColor("transparent");
      }

      if (isMitigated) {
        box.setText("");
      } else {
        const volStr = formatLiquiditySize(totalVol);
        const deltaVal = block.delta ?? null;
        let deltaStr = deltaVal === null ? "n/a" : "0";
        if (deltaVal !== null && deltaVal > 0) {
          deltaStr = `+${formatLiquiditySize(deltaVal)}`;
        } else if (deltaVal !== null && deltaVal < 0) {
          deltaStr = `-${formatLiquiditySize(Math.abs(deltaVal))}`;
        }
        const unsided = block.unknownVolume ?? 0;
        box.setText(`Total Volume: ${volStr} | ${unsided > 0 ? "Sided Δ" : "Δ"}: ${deltaStr}${unsided > 0 ? ` | Unsided: ${formatLiquiditySize(unsided)}` : ""}`);
      }
    }
  },
};
