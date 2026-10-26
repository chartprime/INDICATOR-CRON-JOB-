import type {
  IndicatorBarCtx,
  RuntimeIndicatorDef,
} from "../../chart/indicatorTypes";
import { ta } from "../../chart/ta";
import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import {
  DEFAULT_MAX_ORDER_BLOCKS,
  SECONDARY_LEFT_BARS,
  ZONE_WIDTH_LENGTH,
} from "../classic-order-blocks/orderBlockRules";
import type { BookInput } from "./institutionalTracker";
import {
  DEFAULT_INSTITUTIONAL_SETTINGS,
  FLASH_WALL_MS,
  INSTITUTIONAL_SETTINGS_SCHEMA,
  thresholdsOf,
  type InstitutionalSettings,
} from "./institutionalRules";
import { renderInstitutionalBlocks, ZONE_TEXT_ON_DARK } from "./institutionalRender";
import {
  advanceInstitutional,
  bandWantsOf,
  createInstitutionalTrackerState,
  type InstitutionalTrackerState,
} from "./institutionalTracker";

export const BOX_FONT_SIZE = 12;
export const BOX_FONT_FAMILY =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';
export const BOX_CORNER_RADIUS = 6;
export const BOX_TEXT_PADDING = 8;

export interface InstitutionalState {
  primaryHigh: ReturnType<typeof ta.pivotHigh>;
  primaryLow: ReturnType<typeof ta.pivotLow>;
  secondaryHigh: ReturnType<typeof ta.pivotHigh>;
  secondaryLow: ReturnType<typeof ta.pivotLow>;
  range: ReturnType<typeof ta.sma>;
  tracker: InstitutionalTrackerState;
  slots: BoxHandle[];
}

export const institutionalOrderBlocksIndicator: RuntimeIndicatorDef<
  InstitutionalState,
  InstitutionalSettings
> = {
  kind: "runtime",
  id: "institutionalOrderBlocks",
  label: "Institutional Order Blocks",
  category: "l2",
  defaultSettings: DEFAULT_INSTITUTIONAL_SETTINGS,
  settingsSchema: INSTITUTIONAL_SETTINGS_SCHEMA,
  lines: [],
  placement: { kind: "overlay" },
  readOutput: () => ({}),
  bandHistoryWanted: (state) => bandWantsOf(state.tracker),
  createState(settings: InstitutionalSettings): InstitutionalState {
    const L = settings.pivotLength;
    return {
      primaryHigh: ta.pivotHigh(L, L),
      primaryLow: ta.pivotLow(L, L),
      secondaryHigh: ta.pivotHigh(SECONDARY_LEFT_BARS, L),
      secondaryLow: ta.pivotLow(SECONDARY_LEFT_BARS, L),
      range: ta.sma(ZONE_WIDTH_LENGTH),
      tracker: createInstitutionalTrackerState({
        keepStack: settings.stackPivots,
        maxBlocks: settings.maxBlocks,
      }),
      slots: Array.from(
        { length: settings.maxBlocks ?? DEFAULT_MAX_ORDER_BLOCKS },
        () =>
          draw.box({
            time1: 0,
            price1: 0,
            time2: 0,
            price2: 0,
            borderColor: "transparent",
            backgroundColor: "transparent",
            text: "",
            textColorOnDark: ZONE_TEXT_ON_DARK,
            textFitsHeight: true,
            fontSize: BOX_FONT_SIZE,
            textAlign: "right",
            fontFamily: BOX_FONT_FAMILY,
            cornerRadius: BOX_CORNER_RADIUS,
            textPadding: BOX_TEXT_PADDING,
          }),
      ),
    };
  },
  onBar(ctx: IndicatorBarCtx<InstitutionalState, InstitutionalSettings>): void {
    const { bar, state, settings, replace, liquidity, bandHistory } = ctx;
    const primaryHigh = state.primaryHigh.push(bar.high, replace);
    const primaryLow = state.primaryLow.push(bar.low, replace);
    const secondaryHigh = state.secondaryHigh.push(bar.high, replace);
    const secondaryLow = state.secondaryLow.push(bar.low, replace);
    const range = state.range.push(bar.high - bar.low, replace);
    if (bar.closed) {
      const book: BookInput | null = liquidity
        ? { reader: liquidity, flashMs: FLASH_WALL_MS, barMs: bar.interval_ms, bands: bandHistory ?? null, edgeUnknown: ctx.l2?.availability === "HISTORICAL" }
        : null;
      advanceInstitutional(
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
        book,
        thresholdsOf(settings, bar),
      );
    }
    if (ctx.drawNow === false) return;
    renderInstitutionalBlocks(
      state.slots,
      state.tracker.blocks,
      settings,
      bar.ts_open,
      liquidity?.baseAsset ?? "",
    );
  },
};
