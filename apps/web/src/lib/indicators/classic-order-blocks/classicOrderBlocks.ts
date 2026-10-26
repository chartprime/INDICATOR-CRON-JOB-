import type {
  IndicatorBarCtx,
  RuntimeIndicatorDef,
} from "../../chart/indicatorTypes";
import { ta } from "../../chart/ta";
import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import type { LineHandle } from "../../chart/draw/line";
import {
  DEFAULT_ORDER_BLOCK_SETTINGS,
  ORDER_BLOCK_SETTINGS_SCHEMA,
  SECONDARY_LEFT_BARS,
  ZONE_WIDTH_LENGTH,
  type OrderBlockSettings,
} from "./orderBlockRules";
import {
  advanceOrderBlocks,
  createOrderBlockTrackerState,
  type OrderBlockTrackerState,
} from "./orderBlockTracker";
import { renderOrderBlocks } from "./orderBlockRender";

export interface OrderBlocksState {
  primaryHigh: ReturnType<typeof ta.pivotHigh>;
  primaryLow: ReturnType<typeof ta.pivotLow>;
  secondaryHigh: ReturnType<typeof ta.pivotHigh>;
  secondaryLow: ReturnType<typeof ta.pivotLow>;
  range: ReturnType<typeof ta.sma>;
  tracker: OrderBlockTrackerState;
  slots: BoxHandle[];
  middleLines: LineHandle[];
}

export const classicOrderBlocksIndicator: RuntimeIndicatorDef<
  OrderBlocksState,
  OrderBlockSettings
> = {
  kind: "runtime",
  id: "classicOrderBlocks",
  label: "Classic Order Blocks",
  category: "technical",
  defaultSettings: DEFAULT_ORDER_BLOCK_SETTINGS,
  settingsSchema: ORDER_BLOCK_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  createState(settings: OrderBlockSettings): OrderBlocksState {
    const L = settings.pivotLength;
    return {
      primaryHigh: ta.pivotHigh(L, L),
      primaryLow: ta.pivotLow(L, L),
      secondaryHigh: ta.pivotHigh(SECONDARY_LEFT_BARS, L),
      secondaryLow: ta.pivotLow(SECONDARY_LEFT_BARS, L),
      range: ta.sma(ZONE_WIDTH_LENGTH),
      tracker: createOrderBlockTrackerState({
        keepStack: settings.stackPivots,
        maxBlocks: settings.maxBlocks,
      }),
      slots: Array.from({ length: 200 }, () =>
        draw.box({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          borderColor: "transparent",
          backgroundColor: "transparent",
          text: "",
          fontSize: 12,
          textAlign: "left",
          fontFamily:
            '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
          cornerRadius: 6,
          textPadding: 8,
          keepTextClear: true,
          textAfterBox: true,
        }),
      ),
      middleLines: Array.from({ length: 200 }, () =>
        draw.line({
          time1: 0,
          price1: 0,
          time2: 0,
          price2: 0,
          color: "transparent",
          style: "dashed",
        }),
      ),
    };
  },
  onBar(ctx: IndicatorBarCtx<OrderBlocksState, OrderBlockSettings>): void {
    const { bar, state, settings, replace } = ctx;
    const primaryHigh = state.primaryHigh.push(bar.high, replace);
    const primaryLow = state.primaryLow.push(bar.low, replace);
    const secondaryHigh = state.secondaryHigh.push(bar.high, replace);
    const secondaryLow = state.secondaryLow.push(bar.low, replace);
    const range = state.range.push(bar.high - bar.low, replace);
    if (!bar.closed) return;
    advanceOrderBlocks(
      state.tracker,
      {
        time: bar.ts_open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      },
      { primaryHigh, primaryLow, secondaryHigh, secondaryLow },
      range === null ? null : range * settings.widthMultiplier,
      settings.pivotLength,
    );
    if (ctx.drawNow === false) return;
    renderOrderBlocks(
      state.slots,
      state.middleLines,
      state.tracker.activeBlocks,
      state.tracker.mitigatedBlocks,
      settings,
      bar.ts_open,
    );
  },
};
