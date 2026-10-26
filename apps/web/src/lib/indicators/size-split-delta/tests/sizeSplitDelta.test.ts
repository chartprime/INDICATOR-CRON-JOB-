import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests, withDrawOwnerScope } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests, tablesForOwners } from "../../../chart/draw/registry";
import type { TableData } from "../../../chart/draw/table";
import { HISTORICAL_INDICATOR_POLICIES, INDICATOR_REGISTRY, historicalIndicatorAvailability } from "../../../chart/indicatorRegistry";
import type { IndicatorBarCtx } from "../../../chart/indicatorTypes";
import { BINANCE_PERP, DXFEED_EQUITY, DXFEED_FUTURE, FIXTURE_T0, MINUTE_MS, captureMarkers, replayCapture, sizeSplitFixture, tapeOf, ticksOf, tradeFrame } from "../../../chart/validation";
import {
  SIZE_SPLIT_DEFAULT_SETTINGS,
  SIZE_SPLIT_LARGE_COLOR,
  SIZE_SPLIT_SETTINGS_SCHEMA,
  SIZE_SPLIT_SMALL_COLOR,
  SIZE_SPLIT_TABLE_MAX_CHARS,
  conditionText,
  sizeSplitDeltaIndicator,
  sizeSplitSettingsFieldsFor,
  sizeSplitTableRows,
  sizeUnitOf,
  stateText,
  statusText,
  withAlpha,
  type SizeSplitDeltaSettings,
  type SizeSplitDeltaState,
} from "../sizeSplitDelta";
import type { SizeSplitReading } from "../sizeSplitDeltaMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const OWNER = "test:sizeSplitDelta";

function openState(settings: SizeSplitDeltaSettings = SIZE_SPLIT_DEFAULT_SETTINGS): SizeSplitDeltaState {
  return withDrawOwnerScope(OWNER, () => sizeSplitDeltaIndicator.createState(settings));
}

function ctxOf(
  state: SizeSplitDeltaState,
  bar: BarFrame,
  settings: SizeSplitDeltaSettings,
  markers: IndicatorBarCtx<SizeSplitDeltaState, SizeSplitDeltaSettings>["markers"],
  ticks: IndicatorBarCtx<SizeSplitDeltaState, SizeSplitDeltaSettings>["ticks"],
): IndicatorBarCtx<SizeSplitDeltaState, SizeSplitDeltaSettings> {
  return { bar, state, settings, replace: !bar.closed, replaying: false, drawNow: true, trades: [], ticks, ta: {}, draw: { fill: () => {} }, markers, pane: { paneIndex: 0 } };
}

function pendingTexts(): string[] {
  const [table] = tablesForOwners([OWNER]);
  const grid = (table.data as TableData).pendingGrid;
  return Object.keys(grid)
    .sort()
    .map((key) => grid[key].text);
}

const reading = (overrides: Partial<SizeSplitReading>): SizeSplitReading => ({
  tsOpen: FIXTURE_T0,
  large: 12.4,
  small: -8.1,
  largeBar: 1,
  smallBar: -0.5,
  share: 1,
  tier: 0.106,
  sizesLearned: 4_096,
  status: "ready",
  gapBars: 0,
  confirmed: true,
  valid: true,
  ringLength: 20,
  state: "confirms",
  divergence: null,
  depth: null,
  conflictHeld: false,
  conflictOnset: false,
  conflictSums: null,
  condition: null,
  ...overrides,
});

const BINANCE_STATE = { provider: "BINANCE" as const, symbol: "BTC-USDT", assetClass: null };

describe("sizeSplitDelta -- identity, registry and Historical Mode policy (protocol check 10)", () => {
  it("is registered last with the brief's identity, reads the tick store and is unavailable in Historical Mode", () => {
    expect(INDICATOR_REGISTRY[INDICATOR_REGISTRY.length - 1].id).toBe("sizeSplitDelta");
    expect(sizeSplitDeltaIndicator.label).toBe("Size-Split Delta (large vs small)");
    expect(sizeSplitDeltaIndicator.category).toBe("l1");
    expect(sizeSplitDeltaIndicator.ticksWanted).toBe(true);
    expect(sizeSplitDeltaIndicator.maxReplayBars).toBe(10_080);
    expect(sizeSplitDeltaIndicator.placement).toEqual({ kind: "ownPane", priceLines: [0] });
    expect(sizeSplitDeltaIndicator.timeframeGate).toBeUndefined();
    expect(sizeSplitDeltaIndicator.lines.map((line) => line.key)).toEqual(["large", "small", "largeBar", "smallBar"]);
    expect(HISTORICAL_INDICATOR_POLICIES.sizeSplitDelta).toEqual({ unavailableReason: "Needs the live tape: the archive keeps only the largest prints of each minute." });
    expect(historicalIndicatorAvailability("sizeSplitDelta", new Set(["ohlcv", "buy_volume", "trade_families", "l2_states"]), "DXFEED").available).toBe(false);
    expect(historicalIndicatorAvailability("sizeSplitDelta", new Set(["ohlcv", "buy_volume"]), "BINANCE").reason).toContain("live tape");
  });

  it("Historical Mode policy is honest: a replay with no print store is null everywhere, draws no marker and says what it needs", () => {
    const { bars } = sizeSplitFixture();
    const capture = replayCapture(sizeSplitDeltaIndicator, bars, { ...SIZE_SPLIT_DEFAULT_SETTINGS, showBarLines: true });
    expect(capture.faulted).toBe(false);
    for (const values of Object.values(capture.outputs)) expect(values.every((value) => value === null)).toBe(true);
    expect(capture.markers).toEqual([]);
    const state = openState();
    const { markers } = captureMarkers(() => bars[0].ts_open);
    sizeSplitDeltaIndicator.onBar(ctxOf(state, bars[0], SIZE_SPLIT_DEFAULT_SETTINGS, markers, undefined));
    expect(pendingTexts()).toEqual(["—", "—", "Needs live tape · no feed"]);
  });

  it("never reads candle sides or the per-bar trade buffer", () => {
    const folder = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of ["sizeSplitDelta.ts", "sizeSplitDeltaMath.ts"]) {
      const source = readFileSync(join(folder, file), "utf8");
      expect(source).not.toMatch(/buy_volume|sell_volume|barSides|barDelta|ctx\.trades|tradeAvailability/);
    }
  });
});

describe("sizeSplitDelta -- settings schema (UX standard part 2, brief Controls)", () => {
  const fields = SIZE_SPLIT_SETTINGS_SCHEMA.filter((field) => field.kind !== "staticHint");
  const keyOf = (field: (typeof fields)[number]) => String(field.key);
  const labelOf = (field: (typeof fields)[number]) => ("label" in field ? field.label : "");

  it("covers every settings key once, with step > 0 on every numeric field", () => {
    expect(fields.map(keyOf).sort()).toEqual(Object.keys(SIZE_SPLIT_DEFAULT_SETTINGS).sort());
    for (const field of fields) if (field.kind === "numeric" || field.kind === "slider") expect(field.step).toBeGreaterThan(0);
  });

  it("has three primary controls, four advanced and four visibility toggles; everything replays; no colour pickers", () => {
    const primary = fields.filter((field) => field.tab === undefined || field.tab === "inputs");
    expect(primary.map(keyOf)).toEqual(["tierMode", "tierSize", "anchor"]);
    expect(primary.map(labelOf)).toEqual(["Large tier", "Large from (units)", "Anchor"]);
    expect(fields.filter((field) => field.tab === "advanced").map(keyOf)).toEqual(["K", "m", "q", "minTapeShare"]);
    expect(fields.filter((field) => field.tab === "visibility").map(keyOf)).toEqual(["showSmall", "showDivergence", "showConflict", "showBarLines"]);
    for (const field of fields) expect(field.affects).toBe("recompute");
    expect(fields.some((field) => field.kind === "color")).toBe(false);
    const tierSize = fields.find((field) => keyOf(field) === "tierSize");
    expect(tierSize && "visibleIf" in tierSize && tierSize.visibleIf ? [tierSize.visibleIf({ ...SIZE_SPLIT_DEFAULT_SETTINGS, tierMode: "fixed" }), tierSize.visibleIf(SIZE_SPLIT_DEFAULT_SETTINGS)] : null).toEqual([true, false]);
    const hint = SIZE_SPLIT_SETTINGS_SCHEMA.find((field) => field.kind === "staticHint");
    expect(hint && hint.kind === "staticHint" ? hint.text : "").toContain("200 trade frames from complete windows, then the next bar open");
    expect(hint && hint.kind === "staticHint" ? hint.text : "").not.toMatch(/minute/);
    for (const line of sizeSplitDeltaIndicator.lines) expect(typeof line.recolor).toBe("function");
  });

  it("defaults are the brief's: auto tier, day anchor, K 20, m 2, q 2, share 0.5, conflict circles off, per-bar lines off", () => {
    expect(SIZE_SPLIT_DEFAULT_SETTINGS).toEqual({
      tierMode: "auto",
      tierSize: 0.5,
      anchor: "day",
      K: 20,
      m: 2,
      q: 2,
      minTapeShare: 0.5,
      showSmall: true,
      showDivergence: true,
      showConflict: false,
      showBarLines: false,
    });
  });

  it("suggests the fixed size per instrument in the field label and keeps the schema otherwise", () => {
    const binance = sizeSplitSettingsFieldsFor({ ...BINANCE_PERP });
    expect(binance.tierSize && "label" in binance.tierSize ? binance.tierSize.label : "").toBe("Large from (BTC, try 0.5)");
    const future = sizeSplitSettingsFieldsFor({ ...DXFEED_FUTURE });
    expect(future.tierSize && future.tierSize.kind === "numeric" ? [future.tierSize.label, future.tierSize.min, future.tierSize.step] : null).toEqual(["Large from (contracts, try 20)", 1, 1]);
    const equity = sizeSplitSettingsFieldsFor({ ...DXFEED_EQUITY });
    expect(equity.tierSize && equity.tierSize.kind === "numeric" ? [equity.tierSize.label, equity.tierSize.step] : null).toEqual(["Large from (shares, try 2,000)", 100]);
    expect(sizeUnitOf(BINANCE_STATE)).toBe("BTC");
    expect(sizeUnitOf({ provider: "DXFEED", symbol: "/NQU26:XCME", assetClass: "FUTURE" })).toBe("contracts");
    expect(sizeUnitOf({ provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" })).toBe("shares");
  });
});

describe("sizeSplitDelta -- table copy (brief Default view, rule 12, amendments 5 and 7)", () => {
  it("row (a) is the confirmation state with compact values, drops the values when a row would exceed 30 characters, and names the warm-up of the ring", () => {
    expect(stateText(reading({}), 20)).toBe("L +12.4 · S −8.1 · confirms");
    expect(stateText(reading({ state: "lags" }), 20)).toBe("L +12.4 · S −8.1 · lags");
    expect(stateText(reading({ state: "noExtreme" }), 20)).toBe("L +12.4 · S −8.1 · no extreme");
    expect(stateText(reading({ state: "noExtreme" }), 20).length).toBeLessThanOrEqual(SIZE_SPLIT_TABLE_MAX_CHARS);
    expect(stateText(reading({ state: "noExtreme", large: 12_300, small: -45_600 }), 20)).toBe("no extreme");
    expect(stateText(reading({ state: null, ringLength: 7 }), 20)).toBe("Need 20 valid bars");
    expect(stateText(reading({ valid: false, large: null, small: null }), 20)).toBe("—");
    expect(stateText(null, 20)).toBe("—");
  });

  it("row (b) is the last condition with its time and value, divergence or conflict, cleared to a dash when none", () => {
    expect(conditionText(reading({}), "BINANCE")).toBe("—");
    expect(conditionText(reading({ condition: { kind: "divergence", direction: "bearish", tsOpen: FIXTURE_T0, values: [-8.1] } }), "BINANCE")).toBe("Div ↓ 20:26 · −8.1");
    expect(conditionText(reading({ condition: { kind: "divergence", direction: "bullish", tsOpen: FIXTURE_T0, values: [6] } }), "BINANCE")).toBe("Div ↑ 20:26 · +6");
    const conflict = conditionText(reading({ condition: { kind: "conflict", direction: null, tsOpen: FIXTURE_T0, values: [4.2, -3.1] } }), "BINANCE");
    expect(conflict).toBe("Conflict 20:26 · +4.2/−3.1");
    expect(conflict.length).toBeLessThanOrEqual(SIZE_SPLIT_TABLE_MAX_CHARS);
    // Three significant digits keep the longest conflict row at exactly 30 characters.
    const widest = conditionText(reading({ condition: { kind: "conflict", direction: null, tsOpen: FIXTURE_T0, values: [1_230_000, -9_880_000] } }), "BINANCE");
    expect(widest).toBe("Conflict 20:26 · +1.23M/\u22129.88M");
    expect(widest.length).toBe(SIZE_SPLIT_TABLE_MAX_CHARS);
  });

  it("row (c) status strings follow the precedence and stay within 30 characters", () => {
    const strings = [
      statusText(reading({ status: "noFeed" }), "BTC", 0.5),
      statusText(reading({ status: "thinned" }), "BTC", 0.5),
      statusText(reading({ status: "learning", sizesLearned: 120 }), "BTC", 0.5),
      statusText(reading({ status: "shareUnknown", share: null }), "BTC", 0.5),
      statusText(reading({ status: "shareMismatch", share: 1.6 }), "BTC", 0.5),
      statusText(reading({ status: "shareLow", share: 0.38 }), "BTC", 0.5),
      statusText(reading({ status: "gap", gapBars: 3 }), "BTC", 0.5),
      statusText(reading({ status: "gap", gapBars: 1 }), "BTC", 0.5),
      statusText(reading({ status: "forming", confirmed: false }), "BTC", 0.5),
      statusText(reading({}), "BTC", 0.5),
      statusText(reading({ tier: 20, share: 0.999 }), "contracts", 0.5),
      statusText(reading({ tier: 2_000 }), "shares", 0.5),
    ];
    expect(strings).toEqual([
      "Needs live tape · no feed",
      "Needs live tape · thinned",
      "Learning sizes · 120/200",
      "Tape share unknown",
      "Tape 160% · mismatch",
      "Tape 38% · below 50%",
      "Tape gap · 3 bars",
      "Tape gap · 1 bar",
      "Forming",
      "≥ 0.106 BTC · tape 100%",
      "≥ 20 contracts · tape 100%",
      "≥ 2k shares · tape 100%",
    ]);
    for (const text of strings) expect(text.length).toBeLessThanOrEqual(SIZE_SPLIT_TABLE_MAX_CHARS);
    expect(sizeSplitTableRows(reading({}), SIZE_SPLIT_DEFAULT_SETTINGS, BINANCE_STATE).map((row) => row.text)).toEqual(["L +12.4 · S −8.1 · confirms", "—", "≥ 0.106 BTC · tape 100%"]);
    expect(sizeSplitTableRows(reading({}), SIZE_SPLIT_DEFAULT_SETTINGS, BINANCE_STATE)[0].color).toBe(SIZE_SPLIT_LARGE_COLOR);
  });
});

describe("sizeSplitDelta -- markers, colours and outputs through a hand-built ctx", () => {
  const settings: SizeSplitDeltaSettings = { ...SIZE_SPLIT_DEFAULT_SETTINGS, tierMode: "fixed", tierSize: 1, anchor: "tape", K: 1, showBarLines: true };
  const A = FIXTURE_T0;
  const B = A + MINUTE_MS;
  const prints = [
    tradeFrame(A + 1_000, 100, 2, "buy", BINANCE_PERP, "a0"),
    tradeFrame(A + 2_000, 100, 0.5, "sell", BINANCE_PERP, "a1"),
    tradeFrame(B + 1_000, 101, 5, "sell", BINANCE_PERP, "b0"),
    tradeFrame(B + 2_000, 101, 0.4, "buy", BINANCE_PERP, "b1"),
  ];
  const bar = (tsOpen: number, close: number, volume: number, closed: boolean): BarFrame =>
    ({ type: "bar", ...BINANCE_PERP, interval_ms: MINUTE_MS, ts_open: tsOpen, open: close, high: close, low: close, close, volume, trade_count: null, closed }) as BarFrame;

  it("draws the bearish arrow above the bar in the large line's colour, provisional while forming and final at the close, and blanks hidden lines in readOutput", () => {
    const ticks = ticksOf(tapeOf(prints, A));
    const state = openState(settings);
    const capture = captureMarkers(() => B);
    sizeSplitDeltaIndicator.onBar(ctxOf(state, bar(A, 100, 2.5, true), settings, capture.markers, ticks));
    expect(capture.calls).toEqual([]);
    expect(sizeSplitDeltaIndicator.readOutput(state)).toEqual({ large: 2, small: -0.5, largeBar: 2, smallBar: -0.5 });
    expect(sizeSplitDeltaIndicator.lines[0].color!(state, settings)).toBe(SIZE_SPLIT_LARGE_COLOR);
    capture.reset();
    sizeSplitDeltaIndicator.onBar(ctxOf(state, bar(B, 101, 5.4, false), settings, capture.markers, ticks));
    expect(capture.calls).toHaveLength(1);
    expect(capture.calls[0]).toMatchObject({ shape: "arrowDown", position: "aboveBar", color: withAlpha(SIZE_SPLIT_LARGE_COLOR, 0.5), time: B });
    expect(sizeSplitDeltaIndicator.lines[1].color!(state, settings)).toBe(withAlpha(SIZE_SPLIT_SMALL_COLOR, 0.5));
    expect(pendingTexts()).toEqual(["L −3 · S −0.1 · lags", "Div ↓ 20:27 · −5", "Forming"]);
    capture.reset();
    sizeSplitDeltaIndicator.onBar(ctxOf(state, bar(B, 101, 5.4, true), settings, capture.markers, ticks));
    expect(capture.calls[0]).toMatchObject({ shape: "arrowDown", color: SIZE_SPLIT_LARGE_COLOR });
    expect(pendingTexts()[2]).toBe("≥ 1 BTC · tape 100%");
    const hidden = openState({ ...settings, showSmall: false, showBarLines: false });
    sizeSplitDeltaIndicator.onBar(ctxOf(hidden, bar(A, 100, 2.5, true), { ...settings, showSmall: false, showBarLines: false }, captureMarkers(() => A).markers, ticks));
    expect(sizeSplitDeltaIndicator.readOutput(hidden)).toEqual({ large: 2, small: null, largeBar: null, smallBar: null });
    const noArrows = openState({ ...settings, showDivergence: false });
    const quiet = captureMarkers(() => B);
    sizeSplitDeltaIndicator.onBar(ctxOf(noArrows, bar(A, 100, 2.5, true), { ...settings, showDivergence: false }, quiet.markers, ticks));
    sizeSplitDeltaIndicator.onBar(ctxOf(noArrows, bar(B, 101, 5.4, true), { ...settings, showDivergence: false }, quiet.markers, ticks));
    expect(quiet.calls).toEqual([]);
  });
});
