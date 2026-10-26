import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { IndicatorLiquidity } from "../../../chart/indicatorLiquidity";
import type { BoxData } from "../../../chart/draw/box";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { instrumentKey } from "../../../chart/drawingStore";
import { createIndicatorRuntime } from "../../../chart/indicatorRuntime";
import type { ColumnFeed } from "../../absorption-detector/absorptionColumns";
import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";
import { institutionalOrderBlocksV2Indicator } from "../institutionalOrderBlocksV2";
import { DEFAULT_INSTITUTIONAL_V2_SETTINGS as SHIPPED, type InstitutionalV2Settings } from "../institutionalV2Rules";

const DEFAULT_INSTITUTIONAL_V2_SETTINGS: InstitutionalV2Settings = { ...SHIPPED, source: "tracker" };

const T0 = 1_700_000_000_000;
const S = 1_000;
const STEP = 60 * S;
const COLUMN_MS = 10 * S;
const ID = institutionalOrderBlocksV2Indicator.id;

function bar(ts_open: number, closed = true): BarFrame {
  return {
    type: "bar", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", interval_ms: STEP,
    ts_open, open: 9.5, high: 10, low: 9, close: 9.5, volume: 100, trade_count: 10, closed,
  };
}

/**
 * Two bid walls under the bars' close of 9.5, so no bar closes through them: 400 on row 9 (band 2, the band price sits
 * in) and 200 on row 1 (band 0, five and a half away). Both stand from T0 with nothing traded into them, and both are
 * over the perp's strong size of 200, so both read strong and neither waits on the weak switch.
 */
function book(): IndicatorLiquidity {
  const columns: LiquidityColumn[] = [];
  for (let ts = T0 - 20 * STEP; ts <= T0 + 30 * STEP; ts += COLUMN_MS) {
    const bid = new Float64Array(31);
    if (ts >= T0) {
      bid[9] = 400;
      bid[1] = 200;
    }
    columns.push({ ts, lo: 0, hi: 30, bid, ask: new Float64Array(31), buy: [], sell: [] });
  }
  const feed: ColumnFeed = { epoch: 1, deep: null, fine: { columns, columnMs: COLUMN_MS } };
  return { get feed() { return feed; }, rowWidth: 1, baseAsset: "BTC", version: 1 };
}

function drawn(runtime: ReturnType<typeof createIndicatorRuntime>): string[] {
  const owner = runtime.getDrawOwnerId(ID);
  if (owner === null) return [];
  return handlesForOwners([owner])
    .filter((record) => record.kind === "box")
    .map((record) => record.data as BoxData)
    .filter((box) => box.time1 !== 0 && String(box.text) !== "")
    .map((box) => String(box.text));
}

/** The chart's own path: activate the indicator, hand it the book, then feed the bars one at a time as ChartPanel does. */
function chartWith(settings: InstitutionalV2Settings) {
  resetDrawRegistryForTests();
  const runtime = createIndicatorRuntime([institutionalOrderBlocksV2Indicator as never]);
  const bars: BarFrame[] = [];
  runtime.setActive(new Set([ID]), { [ID]: settings }, bars);
  runtime.setLiquidity(book(), bars);
  for (let i = 0; i < 5; i += 1) {
    bars.push(bar(T0 + i * STEP));
    runtime.onBar(bars[bars.length - 1], "APPENDED", bars);
  }
  return { runtime, bars };
}

describe("a settings change reaches the chart", () => {
  it("shows both walls at the instrument's floor and neither above them", () => {
    const { runtime } = chartWith(DEFAULT_INSTITUTIONAL_V2_SETTINGS);
    expect(drawn(runtime).map((text) => text.split(" · ")[1])).toEqual(["200 BTC", "400 BTC"]);
  });

  it("redraws the moment the trader changes the size floor, without waiting for another bar", () => {
    // The trader, 2026-09-20: "hide walls under doesn't do anything". A floor of 300 must drop the 200 wall as soon as
    // he types it -- not on the next bar, which on a fifteen-minute chart is fifteen minutes away.
    const { runtime, bars } = chartWith(DEFAULT_INSTITUTIONAL_V2_SETTINGS);
    expect(drawn(runtime)).toHaveLength(2);
    runtime.updateSettings(ID, { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [instrumentKey(bar(T0))]: 300 } }, bars);
    expect(drawn(runtime).map((text) => text.split(" · ")[1])).toEqual(["400 BTC"]);
  });

  it("redraws the moment the trader changes the count or which levels it keeps, without waiting for another bar", () => {
    const { runtime, bars } = chartWith(DEFAULT_INSTITUTIONAL_V2_SETTINGS);
    // One a side, furthest (the default): the outer wall. The same one nearest: the band price sits in.
    runtime.updateSettings(ID, { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 1 }, bars);
    expect(drawn(runtime).map((text) => text.split(" · ")[1])).toEqual(["200 BTC"]);
    runtime.updateSettings(ID, { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, levelsPerSide: 1, levelsBy: "nearest" }, bars);
    expect(drawn(runtime).map((text) => text.split(" · ")[1])).toEqual(["400 BTC"]);
    // A floor over both of them hides the outer one -- the one price sits in is a strong wall under a bar, kept whatever
    // it holds -- and lifting it brings the outer one back: the redraw is not one-way.
    runtime.updateSettings(ID, { ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [instrumentKey(bar(T0))]: 500 } }, bars);
    expect(drawn(runtime).map((text) => text.split(" · ")[1])).toEqual(["400 BTC"]);
    runtime.updateSettings(ID, DEFAULT_INSTITUTIONAL_V2_SETTINGS, bars);
    expect(drawn(runtime)).toHaveLength(2);
  });
});
