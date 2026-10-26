import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests, withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests, tablesForOwners } from "../../../chart/draw/registry";
import type { TableData } from "../../../chart/draw/table";
import { HISTORICAL_INDICATOR_POLICIES, INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { captureMarkers, relativeVolumeEquityFixture, replayCapture } from "../../../chart/validation";
import {
  RELATIVE_VOLUME_DEFAULT_SETTINGS,
  RELATIVE_VOLUME_SETTINGS_SCHEMA,
  RVOL_BELOW_ONE_COLOR,
  RVOL_FILL_COLOR_ABOVE,
  RVOL_HOT_COLOR,
  RVOL_LINE_COLOR,
  RVOL_TABLE_TEXT_COLOR,
  relativeVolumeIndicator,
  relativeVolumeTableRows,
  rvolLineColor,
  statusText,
  withAlpha,
  type RelativeVolumeSettings,
  type RelativeVolumeState,
} from "../relativeVolume";
import type { RvolReading } from "../relativeVolumeMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const OWNER = "test:relativeVolume";

function openState(settings: RelativeVolumeSettings = RELATIVE_VOLUME_DEFAULT_SETTINGS): RelativeVolumeState {
  return withDrawOwnerScope(OWNER, () => relativeVolumeIndicator.createState(settings));
}

function ctxOf(state: RelativeVolumeState, bar: BarFrame, settings: RelativeVolumeSettings, replace: boolean, markers: IndicatorBarCtx<RelativeVolumeState, RelativeVolumeSettings>["markers"], fills: (number | null)[][] = []): IndicatorBarCtx<RelativeVolumeState, RelativeVolumeSettings> {
  return {
    bar,
    state,
    settings,
    replace,
    replaying: false,
    drawNow: true,
    trades: [],
    ta: {},
    draw: {
      fill: (a, b) => {
        fills.push([a, b]);
      },
    },
    markers,
    pane: { paneIndex: 0 },
  };
}

function pendingTexts(): string[] {
  const [table] = tablesForOwners([OWNER]);
  const grid = (table.data as TableData).pendingGrid;
  return Object.keys(grid)
    .sort()
    .map((key) => grid[key].text);
}

const reading = (overrides: Partial<RvolReading>): RvolReading => ({
  tsOpen: 0,
  key: 570,
  volume: 2_400,
  rvol: 2.4,
  rolling: 1.1,
  slotMeanRatio: 2.3,
  priorCount: 7,
  rollingCount: 20,
  requiredPrior: 3,
  confirmed: true,
  status: "ready",
  ...overrides,
});

describe("relativeVolume -- identity, registry and Historical Mode policy", () => {
  it("is registered last with the brief's identity and an honest candle-only policy", () => {
    // Appended in its own build; later builds append after it (the registry is append-only).
    expect(INDICATOR_REGISTRY.map((def) => def.id)).toContain("relativeVolume");
    expect(INDICATOR_REGISTRY.findIndex((def) => def.id === "relativeVolume")).toBeGreaterThan(INDICATOR_REGISTRY.findIndex((def) => def.id === "liveRangeControl"));
    expect(relativeVolumeIndicator.label).toBe("Relative Volume (Time of Day)");
    expect(relativeVolumeIndicator.category).toBe("technical");
    expect(relativeVolumeIndicator.placement).toEqual({ kind: "ownPane", priceLines: [1, 2, 3], autoscaleRange: { min: 0, max: 4 } });
    expect(relativeVolumeIndicator.timeframeGate).toBeUndefined();
    expect(relativeVolumeIndicator.ticksWanted).toBeUndefined();
    expect(HISTORICAL_INDICATOR_POLICIES.relativeVolume).toEqual({ requiredCapabilities: ["ohlcv"] });
    expect(historicalIndicatorAvailability("relativeVolume", new Set(["ohlcv"]), "DXFEED")).toEqual({ available: true, reason: null });
    expect(historicalIndicatorAvailability("relativeVolume", new Set(), "BINANCE").available).toBe(false);
  });

  it("Historical Mode policy is honest: a candle-only replay with no extras produces real ratios", () => {
    const { bars } = relativeVolumeEquityFixture();
    const capture = replayCapture(relativeVolumeIndicator, bars.slice(0, 4 * 390), RELATIVE_VOLUME_DEFAULT_SETTINGS);
    expect(capture.faulted).toBe(false);
    expect(capture.outputs.rvol.slice(3 * 390).every((value) => value !== null)).toBe(true);
  });
});

describe("relativeVolume -- settings schema (UX standard part 2)", () => {
  const fields = RELATIVE_VOLUME_SETTINGS_SCHEMA.filter((field) => field.kind !== "staticHint");
  const keyOf = (field: (typeof fields)[number]) => String(field.key);
  const labelOf = (field: (typeof fields)[number]) => ("label" in field ? field.label : "");
  const affectsOf = (field: (typeof fields)[number]) => field.affects;

  it("covers every settings key once, with step > 0 on every numeric field", () => {
    const keys = fields.map(keyOf);
    expect([...keys].sort()).toEqual(Object.keys(RELATIVE_VOLUME_DEFAULT_SETTINGS).sort());
    for (const field of fields) {
      if (field.kind === "numeric" || field.kind === "slider") expect(field.step).toBeGreaterThan(0);
    }
  });

  it("has two primary controls on the Inputs tab, the clock and minimum under Advanced, toggles and colours under Visibility", () => {
    const primary = fields.filter((field) => field.tab === undefined || field.tab === "inputs");
    expect(primary.map(keyOf)).toEqual(["sessions", "hotThreshold"]);
    expect(primary.map(labelOf)).toEqual(["Lookback (prior bars)", "Unusual above (×)"]);
    const advanced = fields.filter((field) => field.tab === "advanced");
    expect(advanced.map(keyOf)).toEqual(["minSessions", "clock"]);
    expect(advanced.map(labelOf)).toEqual(["Minimum prior bars", "Clock"]);
    const visibility = fields.filter((field) => field.tab === "visibility");
    expect(visibility.map(keyOf)).toEqual(["showRolling", "showMarkers"]);
    expect(visibility.map(labelOf)).toEqual(["Show rolling 20", "Show unusual markers"]);
    const clock = advanced.find((field) => field.kind === "select");
    expect(clock && clock.kind === "select" ? clock.options.map((option) => option.label) : []).toEqual(["Automatic", "New York", "UTC"]);
  });

  it("every setting changes the math, the colouring of history or a marker, so every setting replays; there is no cosmetic setting and the colours are fixed", () => {
    const affects = Object.fromEntries(fields.map((field) => [keyOf(field), affectsOf(field)]));
    expect(affects).toEqual({
      sessions: "recompute",
      hotThreshold: "recompute",
      minSessions: "recompute",
      clock: "recompute",
      showRolling: "recompute",
      showMarkers: "recompute",
    });
    expect(fields.some((field) => field.kind === "color")).toBe(false);
    const sessions = fields.find((field) => keyOf(field) === "sessions");
    expect(sessions && sessions.kind === "numeric" ? [sessions.min, sessions.max, sessions.step] : null).toEqual([3, 60, 1]);
    for (const line of relativeVolumeIndicator.lines) expect(typeof line.recolor).toBe("function");
    const hints = RELATIVE_VOLUME_SETTINGS_SCHEMA.filter((field) => field.kind === "staticHint");
    for (const hint of hints) {
      expect(hint.kind === "staticHint" ? hint.text.endsWith("Replays every bar.") : false).toBe(true);
      expect(hint.tab).toBeUndefined();
    }
  });

  it("defaults are the brief's", () => {
    expect(RELATIVE_VOLUME_DEFAULT_SETTINGS).toEqual({
      sessions: 10,
      hotThreshold: 2,
      minSessions: 3,
      clock: "auto",
      showRolling: false,
      showMarkers: true,
    });
  });
});

describe("relativeVolume -- colours, table copy and status precedence", () => {
  const settings = RELATIVE_VOLUME_DEFAULT_SETTINGS;

  it("colours the line purple at or above 1, blue when unusual, grey below 1, and at 50 percent alpha while forming", () => {
    expect(rvolLineColor(reading({ rvol: 1.4 }), settings)).toBe(RVOL_LINE_COLOR);
    expect(rvolLineColor(reading({ rvol: 1 }), settings)).toBe(RVOL_LINE_COLOR);
    expect(rvolLineColor(reading({ rvol: 2 }), settings)).toBe(RVOL_HOT_COLOR);
    expect(rvolLineColor(reading({ rvol: 0.6 }), settings)).toBe(RVOL_BELOW_ONE_COLOR);
    expect(rvolLineColor(reading({ rvol: 2.4, confirmed: false, status: "forming" }), settings)).toBe("rgba(37,99,235,0.5)");
    expect(rvolLineColor(reading({ rvol: 1.2, confirmed: false, status: "forming" }), settings)).toBe("rgba(134,114,179,0.5)");
    expect(rvolLineColor(null, settings)).toBe(RVOL_LINE_COLOR);
    expect(withAlpha("#8672b3", 0.15)).toBe("rgba(134,114,179,0.15)");
    expect(withAlpha("#abc", 0.5)).toBe("rgba(170,187,204,0.5)");
    expect(withAlpha("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });

  it("writes the approved table strings", () => {
    expect(relativeVolumeTableRows(reading({}), settings).map((row) => row.text)).toEqual(["RVOL 2.4× · 7 prior", "Rolling 1.1× · 20 bars", ""]);
    expect(relativeVolumeTableRows(reading({}), settings)[0].color).toBe(RVOL_HOT_COLOR);
    expect(relativeVolumeTableRows(reading({}), settings)[1].color).toBe(RVOL_TABLE_TEXT_COLOR);
    const learning = reading({ rvol: null, slotMeanRatio: null, priorCount: 1, status: "learning" });
    expect(relativeVolumeTableRows(learning, settings).map((row) => row.text)).toEqual(["RVOL — · 1 prior", "Rolling 1.1× · 20 bars", "Learning · 1 of 3 prior"]);
    expect(statusText(reading({ status: "forming", confirmed: false }))).toBe("Forming · vs full bar");
    expect(statusText(reading({ status: "unsupported", rvol: null, rolling: null }))).toBe("Needs 1m to 1h");
    expect(statusText(reading({ status: "noVolume", rvol: null, rolling: null, volume: null }))).toBe("No usable volume");
    expect(statusText(reading({ status: "noBaseline", rvol: null }))).toBe("No usable baseline");
    expect(statusText(null)).toBe("");
    expect(relativeVolumeTableRows(reading({ rolling: null, rollingCount: 5 }), settings)[1].text).toBe("Rolling — · 20 bars");
    for (const row of relativeVolumeTableRows(learning, settings)) expect(row.text.length).toBeLessThanOrEqual(30);
  });

  it("the status row follows the brief's precedence on real bars: unsupported timeframe first, then no volume, learning, forming, ready", () => {
    const { bars } = relativeVolumeEquityFixture();
    const fourHour = { ...bars[0], interval_ms: 4 * 3_600_000 } as BarFrame;
    const state = openState();
    const capture = captureMarkers(() => 0);
    relativeVolumeIndicator.onBar(ctxOf(state, fourHour, settings, false, capture.markers));
    expect(pendingTexts()).toEqual(["RVOL — · 0 prior", "Rolling — · 20 bars", "Needs 1m to 1h"]);
    expect(relativeVolumeIndicator.readOutput(state)).toEqual({ rvol: null, rolling: null });

    const fresh = openState();
    for (const bar of bars.slice(0, 3 * 390)) relativeVolumeIndicator.onBar(ctxOf(fresh, bar, settings, false, capture.markers));
    expect(pendingTexts()[2]).toBe("Learning · 2 of 3 prior");
    const ready = bars[3 * 390 + 5];
    relativeVolumeIndicator.onBar(ctxOf(fresh, bars[3 * 390], settings, false, capture.markers));
    for (const bar of bars.slice(3 * 390 + 1, 3 * 390 + 5)) relativeVolumeIndicator.onBar(ctxOf(fresh, bar, settings, false, capture.markers));
    relativeVolumeIndicator.onBar(ctxOf(fresh, { ...ready, closed: false, volume: 10 }, settings, false, capture.markers));
    expect(pendingTexts()[2]).toBe("Forming · vs full bar");
    relativeVolumeIndicator.onBar(ctxOf(fresh, { ...ready, closed: true, volume: Number.NaN }, settings, true, capture.markers));
    expect(pendingTexts()[2]).toBe("No usable volume");
    relativeVolumeIndicator.onBar(ctxOf(fresh, ready, settings, true, capture.markers));
    expect(pendingTexts()[2]).toBe("");
    expect(pendingTexts()[0]).toMatch(/^RVOL \d+\.\d× · 3 prior$/);
  });
});

describe("relativeVolume -- markers, fill and replace semantics", () => {
  const settings = RELATIVE_VOLUME_DEFAULT_SETTINGS;
  const { bars } = relativeVolumeEquityFixture();
  const warm = bars.slice(0, 3 * 390 + 40);

  function warmed(state: RelativeVolumeState, markers: IndicatorBarCtx<RelativeVolumeState, RelativeVolumeSettings>["markers"], fills: (number | null)[][] = []) {
    for (const bar of warm) relativeVolumeIndicator.onBar(ctxOf(state, bar, settings, false, markers, fills));
  }

  it("draws one circle above the bar when hot, size 2 from 3x, provisional at 50 percent alpha, nothing otherwise", () => {
    const state = openState();
    const fills: (number | null)[][] = [];
    let time = 0;
    const capture = captureMarkers(() => time);
    warmed(state, capture.markers, fills);
    const next = bars[warm.length];
    time = next.ts_open;
    capture.reset();
    relativeVolumeIndicator.onBar(ctxOf(state, { ...next, closed: false, volume: 1 }, settings, false, capture.markers, fills));
    const quiet = relativeVolumeIndicator.readOutput(state).rvol!;
    expect(quiet).toBeLessThan(2);
    expect(capture.calls).toEqual([]);
    const denominator = 1 / quiet;
    relativeVolumeIndicator.onBar(ctxOf(state, { ...next, closed: false, volume: Math.ceil(denominator * 2.1) }, settings, true, capture.markers, fills));
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]).toMatchObject({ shape: "circle", position: "aboveBar", color: "rgba(37,99,235,0.5)", size: 1, time: next.ts_open });
    capture.reset();
    relativeVolumeIndicator.onBar(ctxOf(state, { ...next, closed: true, volume: Math.ceil(denominator * 3.2) }, settings, true, capture.markers, fills));
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]).toMatchObject({ shape: "circle", position: "aboveBar", color: RVOL_HOT_COLOR, size: 2 });
    expect(fills[fills.length - 1]).toEqual([relativeVolumeIndicator.readOutput(state).rvol, 1]);
    expect(RVOL_FILL_COLOR_ABOVE).toBe("rgba(134,114,179,0.15)");
  });

  it("showMarkers off draws no marker while the ratio is unchanged; a threshold above 3 makes every drawn marker large", () => {
    const quietSettings = { ...settings, showMarkers: false };
    const state = openState(quietSettings);
    const capture = captureMarkers(() => 0);
    const fills: (number | null)[][] = [];
    for (const bar of warm) relativeVolumeIndicator.onBar(ctxOf(state, bar, quietSettings, false, capture.markers, fills));
    const next = bars[warm.length];
    relativeVolumeIndicator.onBar(ctxOf(state, { ...next, volume: next.volume * 10 }, quietSettings, false, capture.markers, fills));
    expect(relativeVolumeIndicator.readOutput(state).rvol).toBeGreaterThan(3);
    expect(capture.calls).toEqual([]);

    const strict = { ...settings, hotThreshold: 4 };
    const strictState = openState(strict);
    for (const bar of warm) relativeVolumeIndicator.onBar(ctxOf(strictState, bar, strict, false, capture.markers, fills));
    relativeVolumeIndicator.onBar(ctxOf(strictState, { ...next, volume: next.volume * 10 }, strict, false, capture.markers, fills));
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0].size).toBe(2);
  });

  it("a replace:true revision never commits: the slot ring is untouched until the close", () => {
    const state = openState();
    const capture = captureMarkers(() => 0);
    warmed(state, capture.markers);
    const next = bars[warm.length];
    const ringBefore = JSON.stringify(state.engine.slotRing(570 + 40)!.items);
    for (const share of [0.2, 0.5, 0.8]) {
      relativeVolumeIndicator.onBar(ctxOf(state, { ...next, closed: false, volume: Math.round(next.volume * share) }, settings, share !== 0.2, capture.markers));
      expect(JSON.stringify(state.engine.slotRing(570 + 40)!.items)).toBe(ringBefore);
    }
    relativeVolumeIndicator.onBar(ctxOf(state, next, settings, true, capture.markers));
    expect(state.engine.slotRing(570 + 40)!.items).toHaveLength(4);
  });
});
