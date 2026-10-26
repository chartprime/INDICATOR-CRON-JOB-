import { beforeEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { createIndicatorRuntime } from "../../../chart/indicatorRuntime";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import {
  DEFAULT_SESSION_VWAP_SETTINGS,
  SESSION_VWAP_HIDDEN_COLOR,
  SESSION_VWAP_JOIN_COLOR,
  sessionVwapBandColor,
  sessionVwapIndicator,
  type SessionVwapSettings,
} from "../sessionVwap";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ID = sessionVwapIndicator.id;

function candle(ts_open: number, typical = 100, volume = 1): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: MINUTE,
    ts_open,
    open: typical,
    high: typical + 10,
    low: typical - 10,
    close: typical,
    volume,
    trade_count: 1,
    closed: true,
  } as BarFrame;
}

function chart(settings: Partial<SessionVwapSettings> = {}) {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
  const runtime = createIndicatorRuntime([sessionVwapIndicator as never]);
  const bars: BarFrame[] = [];
  const full: SessionVwapSettings = {
    ...DEFAULT_SESSION_VWAP_SETTINGS,
    sessionPeriodMs: HOUR,
    ...settings,
  };
  runtime.setActive(new Set([ID]), { [ID]: full }, bars);

  function feed(next: BarFrame) {
    bars.push(next);
    runtime.onBar(next, "APPENDED", bars);
  }

  return {
    runtime,
    bars,
    feed,
    settings: full,
    output: () => runtime.getOutput(ID)!,
    colors: () => runtime.getLineColors(ID)!,
    apply: (patch: Partial<SessionVwapSettings>) =>
      runtime.updateSettings(ID, { ...full, ...patch }, bars),
  };
}

beforeEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

describe("session VWAP settings reach the chart", () => {
  it("repaints a color change without replaying the bars", () => {
    const { feed, output, colors, apply } = chart();
    feed(candle(0, 100, 4));
    expect(colors().vwap).toEqual([DEFAULT_SESSION_VWAP_SETTINGS.vwapColor]);
    apply({ vwapColor: "#123456", band1Color: "#654321" });
    // The recolor path, not a replay: the value survives a purely cosmetic edit.
    expect(output().vwap).toEqual([100]);
    expect(colors().vwap).toEqual(["#123456"]);
    // A band keeps its own hue but is painted at its rung of the shared ladder,
    // so the average stays the solid line whatever the bands are set to.
    expect(colors().upper1).toEqual([sessionVwapBandColor("#654321", 1)]);
    expect(colors().upper2).toEqual([sessionVwapBandColor(DEFAULT_SESSION_VWAP_SETTINGS.band2Color, 2)]);
  });

  it("hides the bands by painting them transparent, so toggling them keeps the average", () => {
    const { feed, output, colors, apply } = chart();
    feed(candle(0, 100, 4));
    apply({ showBands: false });
    expect(output().vwap).toEqual([100]);
    expect(colors().upper1).toEqual([SESSION_VWAP_HIDDEN_COLOR]);
    expect(colors().lower1).toEqual([SESSION_VWAP_HIDDEN_COLOR]);
    expect(colors().upper2).toEqual([SESSION_VWAP_HIDDEN_COLOR]);
    expect(colors().lower2).toEqual([SESSION_VWAP_HIDDEN_COLOR]);
    expect(colors().vwap).toEqual([DEFAULT_SESSION_VWAP_SETTINGS.vwapColor]);
    // ...and switching them back on restores them, still without a replay.
    apply({ showBands: true });
    expect(colors().upper1).toEqual([sessionVwapBandColor(DEFAULT_SESSION_VWAP_SETTINGS.band1Color, 1)]);
    expect(output().vwap).toEqual([100]);
  });

  it("keeps a hidden session join hidden through cosmetic edits and band toggles", () => {
    const { feed, colors, apply } = chart();
    feed(candle(0, 100, 1));
    feed(candle(59 * MINUTE, 100, 1));
    expect(colors().vwap).toEqual([DEFAULT_SESSION_VWAP_SETTINGS.vwapColor, SESSION_VWAP_JOIN_COLOR]);
    // A recolour must not resurrect the join: the two invisible colours are kept
    // apart so the stored string alone says which one a point was.
    apply({ vwapColor: "#123456", band1Color: "#654321" });
    expect(colors().vwap).toEqual(["#123456", SESSION_VWAP_JOIN_COLOR]);
    expect(colors().upper1).toEqual([sessionVwapBandColor("#654321", 1), SESSION_VWAP_JOIN_COLOR]);
    // ...and neither does switching the bands off and back on.
    apply({ showBands: false });
    expect(colors().upper1).toEqual([SESSION_VWAP_HIDDEN_COLOR, SESSION_VWAP_JOIN_COLOR]);
    apply({ showBands: true });
    expect(colors().upper1).toEqual([
      sessionVwapBandColor(DEFAULT_SESSION_VWAP_SETTINGS.band1Color, 1),
      SESSION_VWAP_JOIN_COLOR,
    ]);
  });

  it("replays every bar on a session-length change, rebuilding the session", () => {
    const { feed, output, apply } = chart();
    feed(candle(0, 100, 4));
    expect(output().vwap).toEqual([100]);
    // The bars are the source, so a recompute redraws the session rather than
    // blanking it.
    apply({ sessionPeriodMs: 2 * HOUR });
    expect(output().vwap).toEqual([100]);
  });

  it("resizes the bands on a sigma change without losing the average", () => {
    const { feed, output, apply } = chart();
    feed(candle(0, 100, 1));
    feed(candle(MINUTE, 200, 1));
    // 1 @ 100 and 1 @ 200: 150 ± 50.
    expect(output().vwap[1]).toBe(150);
    expect(output().upper2[1]).toBe(250);
    apply({ band2Sigma: 3 });
    expect(output().vwap[1]).toBe(150);
    expect(output().upper2[1]).toBe(300);
  });
});
