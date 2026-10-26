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
  visibleCondition,
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
const DASH = "—";
const MINUS = "−";

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

function pendingGrid(): Record<string, { text: string; textColor: string }> {
  const [table] = tablesForOwners([OWNER]);
  return (table.data as TableData).pendingGrid;
}

function pendingTexts(): string[] {
  const grid = pendingGrid();
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
  committed: true,
  confirmed: true,
  valid: true,
  ringLength: 20,
  state: "confirms",
  divergence: null,
  divergenceHeld: null,
  depth: null,
  conflictHeld: false,
  conflictOnset: false,
  conflictSums: null,
  lastDivergence: null,
  lastConflict: null,
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
    expect(pendingTexts()).toEqual([DASH, DASH, "Needs live tape · no feed"]);
  });

  it("never reads candle sides or the per-bar trade buffer", () => {
    const folder = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of ["sizeSplitDelta.ts", "sizeSplitDeltaMath.ts"]) {
      const source = readFileSync(join(folder, file), "utf8");
      expect(source).not.toMatch(/buy_volume|sell_volume|barSides|barDelta|ctx\.trades|tradeAvailability/);
    }
  });
});

describe("sizeSplitDelta -- settings schema (UX standard part 2, brief Controls, UX notes 10 and 11)", () => {
  const fields = SIZE_SPLIT_SETTINGS_SCHEMA.filter((field) => field.kind !== "staticHint");
  const keyOf = (field: (typeof fields)[number]) => String(field.key);
  const labelOf = (field: (typeof fields)[number]) => ("label" in field ? field.label : "");

  it("covers every settings key once, with step > 0 on every numeric field", () => {
    expect(fields.map(keyOf).sort()).toEqual(Object.keys(SIZE_SPLIT_DEFAULT_SETTINGS).sort());
    for (const field of fields) if (field.kind === "numeric" || field.kind === "slider") expect(field.step).toBeGreaterThan(0);
  });

  it("has three primary controls, four advanced and four visibility toggles with the UX notes' labels; everything replays; no colour pickers", () => {
    const primary = fields.filter((field) => field.tab === undefined || field.tab === "inputs");
    expect(primary.map(keyOf)).toEqual(["tierMode", "tierSize", "anchor"]);
    expect(primary.map(labelOf)).toEqual(["Large tier", "Large from (units)", "Anchor"]);
    expect(fields.filter((field) => field.tab === "advanced").map(labelOf)).toEqual(["Extreme window (bars)", "Divergence depth (×)", "Conflict strength (×)", "Tape share floor (0–1)"]);
    expect(fields.filter((field) => field.tab === "visibility").map(labelOf)).toEqual(["Show small tier (blue)", "Show divergence arrows", "Show conflict circles", "Show per-bar lines"]);
    const tierMode = fields.find((field) => keyOf(field) === "tierMode");
    expect(tierMode && tierMode.kind === "select" ? tierMode.options.map((option) => option.label) : []).toEqual(["Largest 2% of prints", "Fixed size"]);
    for (const field of fields) expect(field.affects).toBe("recompute");
    expect(fields.some((field) => field.kind === "color")).toBe(false);
    const tierSize = fields.find((field) => keyOf(field) === "tierSize");
    expect(tierSize && "visibleIf" in tierSize && tierSize.visibleIf ? [tierSize.visibleIf({ ...SIZE_SPLIT_DEFAULT_SETTINGS, tierMode: "fixed" }), tierSize.visibleIf(SIZE_SPLIT_DEFAULT_SETTINGS)] : null).toEqual([true, false]);
    for (const line of sizeSplitDeltaIndicator.lines) expect(typeof line.recolor).toBe("function");
  });

  it("carries one hint per primary control and the closing paragraph, in the UX notes' words, the fixed-size hint following its field", () => {
    const hints = SIZE_SPLIT_SETTINGS_SCHEMA.filter((field) => field.kind === "staticHint");
    expect(hints).toHaveLength(4);
    expect(hints.map((hint) => (hint.kind === "staticHint" ? hint.text : ""))).toEqual([
      "Large means the biggest 2 % of recent prints, learned from the first 200 prints after connect, or a size you set. Replays every bar.",
      "Prints at or above this size count as large. Try 0.5 BTC, 20 contracts or 2,000 shares. Replays every bar.",
      "Both lines restart from zero each day or week, or run from the first bar the tape covers. Replays every bar.",
      "Needs the live tape; lines start one bar after connect. Arrow: price made a new high or low that the large prints did not. Circle: large and small prints pulling opposite ways.",
    ]);
    expect(hints[1].visibleIf?.({ ...SIZE_SPLIT_DEFAULT_SETTINGS, tierMode: "fixed" })).toBe(true);
    expect(hints[1].visibleIf?.(SIZE_SPLIT_DEFAULT_SETTINGS)).toBe(false);
    for (const hint of hints) expect(hint.tab).toBeUndefined();
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

  it("names the instrument's unit in the fixed-size label and keeps the schema otherwise", () => {
    const binance = sizeSplitSettingsFieldsFor({ ...BINANCE_PERP });
    expect(binance.tierSize && "label" in binance.tierSize ? binance.tierSize.label : "").toBe("Large from (BTC)");
    const future = sizeSplitSettingsFieldsFor({ ...DXFEED_FUTURE });
    expect(future.tierSize && future.tierSize.kind === "numeric" ? [future.tierSize.label, future.tierSize.min, future.tierSize.step] : null).toEqual(["Large from (contracts)", 1, 1]);
    const equity = sizeSplitSettingsFieldsFor({ ...DXFEED_EQUITY });
    expect(equity.tierSize && equity.tierSize.kind === "numeric" ? [equity.tierSize.label, equity.tierSize.step] : null).toEqual(["Large from (shares)", 100]);
    expect(sizeUnitOf(BINANCE_STATE)).toBe("BTC");
    expect(sizeUnitOf({ provider: "DXFEED", symbol: "/NQU26:XCME", assetClass: "FUTURE" })).toBe("contracts");
    expect(sizeUnitOf({ provider: "DXFEED", symbol: "AAPL", assetClass: "EQUITY" })).toBe("shares");
  });
});

describe("sizeSplitDelta -- table copy (brief Default view, rule 12, amendments 5 and 7, UX notes 1 to 3, 6, 8, 9)", () => {
  it("row (a) is the confirmation state with compact values, falls back to a subject word when a row would exceed 30 characters, and names the warm-up of the ring", () => {
    expect(stateText(reading({}), 20)).toBe(`L +12.4 · S ${MINUS}8.1 · confirms`);
    expect(stateText(reading({ state: "lags" }), 20)).toBe(`L +12.4 · S ${MINUS}8.1 · lags`);
    expect(stateText(reading({ state: "noExtreme" }), 20)).toBe(`L +12.4 · S ${MINUS}8.1 · no extreme`);
    expect(stateText(reading({ state: "noExtreme" }), 20).length).toBeLessThanOrEqual(SIZE_SPLIT_TABLE_MAX_CHARS);
    // Three-significant-digit values make the widest "confirms" row exactly 30 characters, so only "no extreme" can overflow;
    // the "Large confirms" / "Large lags" fallbacks exist for the day a value grows past the formatter's six characters.
    expect(stateText(reading({ state: "noExtreme", large: 12_300, small: -45_600 }), 20)).toBe("No extreme");
    const widest = stateText(reading({ state: "confirms", large: 1_230_000, small: -9_880_000 }), 20);
    expect(widest).toBe(`L +1.23M · S ${MINUS}9.88M · confirms`);
    expect(widest.length).toBe(SIZE_SPLIT_TABLE_MAX_CHARS);
    expect(stateText(reading({ state: "lags", large: 1_230_000, small: -9_880_000 }), 20)).toBe(`L +1.23M · S ${MINUS}9.88M · lags`);
    expect(stateText(reading({ state: null, ringLength: 7 }), 20)).toBe("Need 20 valid bars");
    expect(stateText(reading({ valid: false, large: null, small: null }), 20)).toBe(DASH);
    expect(stateText(null, 20)).toBe(DASH);
  });

  it("row (b) is the newest visible condition with its time and value, divergence winning on the same bar, a dash when none", () => {
    const divergence = { kind: "divergence" as const, direction: "bearish" as const, tsOpen: FIXTURE_T0, values: [-8_120] };
    const conflict = { kind: "conflict" as const, direction: null, tsOpen: FIXTURE_T0 + MINUTE_MS, values: [4.2, -3.1] };
    expect(conditionText(null, "BINANCE")).toBe(DASH);
    expect(conditionText(divergence, "BINANCE")).toBe(`Divergence ↓ 20:26 · ${MINUS}8.12k`);
    expect(conditionText({ ...divergence, direction: "bullish", values: [6] }, "BINANCE")).toBe("Divergence ↑ 20:26 · +6");
    expect(conditionText(conflict, "BINANCE")).toBe(`Conflict 20:27 · +4.2/${MINUS}3.1`);
    // Three significant digits keep the longest conflict row at exactly 30 characters.
    const widest = conditionText({ ...conflict, values: [1_230_000, -9_880_000] }, "BINANCE");
    expect(widest).toBe(`Conflict 20:27 · +1.23M/${MINUS}9.88M`);
    expect(widest.length).toBe(SIZE_SPLIT_TABLE_MAX_CHARS);
    const both = reading({ lastDivergence: divergence, lastConflict: conflict });
    expect(visibleCondition(both, SIZE_SPLIT_DEFAULT_SETTINGS)).toBe(divergence);
    expect(visibleCondition(both, { showDivergence: true, showConflict: true })).toBe(conflict);
    expect(visibleCondition(both, { showDivergence: false, showConflict: true })).toBe(conflict);
    expect(visibleCondition(both, { showDivergence: false, showConflict: false })).toBeNull();
    const sameBar = reading({ lastDivergence: divergence, lastConflict: { ...conflict, tsOpen: FIXTURE_T0 } });
    expect(visibleCondition(sameBar, { showDivergence: true, showConflict: true })).toBe(divergence);
  });

  it("row (c) status strings follow the precedence and stay within 30 characters", () => {
    const strings = [
      statusText(reading({ status: "noFeed" }), "BTC", 0.5),
      statusText(reading({ status: "tapeStarting" }), "BTC", 0.5),
      statusText(reading({ status: "thinned" }), "BTC", 0.5),
      statusText(reading({ status: "learning", sizesLearned: 120 }), "BTC", 0.5),
      statusText(reading({ status: "shareUnknown", share: null }), "BTC", 0.5),
      statusText(reading({ status: "shareMismatch", share: 1.6 }), "BTC", 0.5),
      statusText(reading({ status: "shareLow", share: 0.38 }), "BTC", 0.5),
      statusText(reading({ status: "gap", gapBars: 3 }), "BTC", 0.5),
      statusText(reading({ status: "gap", gapBars: 1 }), "BTC", 0.5),
      statusText(reading({ status: "forming", committed: false, confirmed: false }), "BTC", 0.5),
      statusText(reading({}), "BTC", 0.5),
      statusText(reading({ tier: 20, share: 0.999 }), "contracts", 0.5),
      statusText(reading({ tier: 2_000 }), "shares", 0.5),
    ];
    expect(strings).toEqual([
      "Needs live tape · no feed",
      "Tape live · next bar",
      "Needs live tape · thinned",
      "Learning sizes · 120 of 200",
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
    const rows = sizeSplitTableRows(reading({ committed: false, confirmed: false, status: "forming" }), SIZE_SPLIT_DEFAULT_SETTINGS, BINANCE_STATE);
    expect(rows.map((row) => row.text)).toEqual([`L +12.4 · S ${MINUS}8.1 · confirms`, DASH, "Forming"]);
    // Row (a) is always the current reading, so it is never dimmed (UX finding 1).
    expect(rows[0].color).toBe(SIZE_SPLIT_LARGE_COLOR);
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

  it("draws the bearish arrow (size 2) above the bar in the large line's colour, provisional while forming and final once committed, and blanks hidden lines in readOutput", () => {
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
    expect(capture.calls[0]).toMatchObject({ shape: "arrowDown", position: "aboveBar", color: withAlpha(SIZE_SPLIT_LARGE_COLOR, 0.5), size: 2, time: B });
    expect(sizeSplitDeltaIndicator.lines[1].color!(state, settings)).toBe(withAlpha(SIZE_SPLIT_SMALL_COLOR, 0.5));
    expect(pendingTexts()).toEqual([`L ${MINUS}3 · S ${MINUS}0.1 · lags`, `Divergence ↓ 20:27 · ${MINUS}5`, "Forming"]);
    expect(pendingGrid()["0,0"].textColor).toBe(SIZE_SPLIT_LARGE_COLOR);
    capture.reset();
    sizeSplitDeltaIndicator.onBar(ctxOf(state, bar(B, 101, 5.4, true), settings, capture.markers, ticks));
    expect(capture.calls[0]).toMatchObject({ shape: "arrowDown", color: SIZE_SPLIT_LARGE_COLOR, size: 2 });
    expect(pendingTexts()[2]).toBe("≥ 1 BTC · tape 100%");
    // A bar committed by supersession is no longer provisional (UX finding 5).
    const superseded = openState(settings);
    const later = captureMarkers(() => B);
    sizeSplitDeltaIndicator.onBar(ctxOf(superseded, bar(A, 100, 2.5, false), settings, later.markers, ticks));
    expect(sizeSplitDeltaIndicator.lines[0].color!(superseded, settings)).toBe(withAlpha(SIZE_SPLIT_LARGE_COLOR, 0.5));
    sizeSplitDeltaIndicator.onBar(ctxOf(superseded, bar(B, 101, 5.4, false), settings, later.markers, ticks));
    expect(superseded.engine.committed[0].confirmed).toBe(false);
    expect(superseded.engine.committed[0].valid).toBe(true);
    const hidden = openState({ ...settings, showSmall: false, showBarLines: false });
    sizeSplitDeltaIndicator.onBar(ctxOf(hidden, bar(A, 100, 2.5, true), { ...settings, showSmall: false, showBarLines: false }, captureMarkers(() => A).markers, ticks));
    expect(sizeSplitDeltaIndicator.readOutput(hidden)).toEqual({ large: 2, small: null, largeBar: null, smallBar: null });
    const noArrows = openState({ ...settings, showDivergence: false });
    const quiet = captureMarkers(() => B);
    sizeSplitDeltaIndicator.onBar(ctxOf(noArrows, bar(A, 100, 2.5, true), { ...settings, showDivergence: false }, quiet.markers, ticks));
    sizeSplitDeltaIndicator.onBar(ctxOf(noArrows, bar(B, 101, 5.4, true), { ...settings, showDivergence: false }, quiet.markers, ticks));
    expect(quiet.calls).toEqual([]);
    // With the arrows hidden, row (b) no longer names the divergence (UX finding 3).
    expect(pendingTexts()[1]).toBe(DASH);
  });
});
