import { afterEach, describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../../../chart/draw/registry";
import { BINANCE_PERP, barFrame, compressionBreakoutBars, compressionFailedBreakBars, openLiveSession, replayCapture } from "../../../chart/validation";
import {
  CB_BOX_POOL,
  CB_BULL_COLOR,
  CB_EDGE_JOIN_COLOR,
  CB_RANGE_COLOR,
  CB_TABLE_MAX_CHARS,
  CB_WARN_COLOR,
  COMPRESSION_BREAKOUT_DEFAULT_SETTINGS,
  breakBasisText,
  compressionBreakoutIndicator,
  decimalsOf,
  rangeRowText,
  tableRows,
  withAlpha,
} from "../compressionBreakout";
import { createCompressionBreakoutEngine, type Reading } from "../compressionBreakoutMath";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

const SETTINGS = COMPRESSION_BREAKOUT_DEFAULT_SETTINGS;

function readingsOf(bars: readonly BarFrame[]): Reading[] {
  const engine = createCompressionBreakoutEngine(SETTINGS);
  return bars.map((bar) => engine.onBar(bar));
}

describe("compressionBreakout -- table strings (UX string table, every string at most 30 characters)", () => {
  const { bars } = compressionFailedBreakBars({ seed: 9 });
  const readings = readingsOf(bars);

  function rowsAt(index: number): string[] {
    return tableRows(readings[index], SETTINGS).map((row) => row.text);
  }

  it("warm-up writes one row only, then four", () => {
    expect(tableRows(null, SETTINGS)).toEqual([{ text: "Warming up · 0 of 40 bars", color: "#d1d4dc" }]);
    expect(rowsAt(12)).toEqual(["Warming up · 13 of 40 bars"]);
    expect(rowsAt(38)).toEqual(["Warming up · 39 of 40 bars"]);
    expect(rowsAt(39)).toHaveLength(4);
  });

  it("every row of every bar is within the limit and uses the approved words", () => {
    const seen = new Set<string>();
    readings.forEach((reading) => {
      for (const row of tableRows(reading, SETTINGS)) {
        expect(row.text.length).toBeLessThanOrEqual(CB_TABLE_MAX_CHARS);
        seen.add(row.text.replace(/\d+(\.\d+)?/g, "n").replace(/\d\d:\d\d/g, "hh:mm"));
      }
    });
    const forms = [...seen];
    expect(forms.some((text) => text.startsWith("Range n–n"))).toBe(true);
    expect(forms).toContain("Trend warming · n of n");
    expect(forms.some((text) => text.startsWith("Trend ") && text.includes("MA n/n"))).toBe(true);
    expect(forms).toContain("Range forming · n of n");
    expect(forms.some((text) => /^Range · n bars · width n×$/.test(text))).toBe(true);
    expect(forms).toContain("Break ↑ · range+vol");
    expect(forms).toContain("Failed break");
    expect(forms.some((text) => /^Watching · width n×$/.test(text))).toBe(true);
    expect(forms.some((text) => /^Last ↑ n:n · range\+vol$/.test(text) || /^Last ↑ hh:mm · range\+vol$/.test(text))).toBe(true);
    expect(forms.some((text) => text.startsWith("Last failed ↑"))).toBe(true);
    expect(forms).toContain("—");
  });

  it("the break, failure and holding rows carry their colours and words", () => {
    const breakIndex = 220; // the labelled break; earlier unconfirmed breaks inside the compression are not the subject here
    expect(readings[breakIndex].decision.kind).toBe("break");
    const rows = tableRows(readings[breakIndex], SETTINGS);
    expect(rows[2]).toEqual({ text: "Break ↑ · range+vol", color: CB_BULL_COLOR });
    expect(rows[3].text).toMatch(/^Last ↑ \d\d:\d\d · range\+vol$/);
    const failed = tableRows(readings[breakIndex + 1], SETTINGS);
    expect(failed[2]).toEqual({ text: "Failed break", color: CB_WARN_COLOR });
    expect(failed[3].text).toMatch(/^Last failed ↑ \d\d:\d\d$/);
    expect(failed[0].text).toMatch(/^Range \d+(\.\d+)?–\d+(\.\d+)?$/);
    const after = tableRows(readings[breakIndex + 2], SETTINGS);
    expect(after[0].text).toBe("No range");
    expect(after[2].text).toMatch(/^Watching( · width \d+\.\d×)?$/);
  });

  it("holding and held-outside rows on the continuation fixture", () => {
    const { bars: held } = compressionBreakoutBars({ seed: 7 });
    const r = readingsOf(held);
    const b = 220;
    expect(tableRows(r[b + 2], SETTINGS)[2].text).toBe("Holding · 2 of 5 bars");
    expect(tableRows(r[b + 5], SETTINGS)[2].text).toBe("Held outside · 5 bars");
    expect(tableRows(r[b + 6], SETTINGS)[3].text).toMatch(/^Last held ↑ \d\d:\d\d · 5 bars$/);
  });

  it("the basis words cover every testability and pass combination", () => {
    expect(breakBasisText(3, 3)).toBe("range+vol");
    expect(breakBasisText(1, 3)).toBe("range only");
    expect(breakBasisText(2, 3)).toBe("vol only");
    expect(breakBasisText(0, 3)).toBe("unconfirmed");
    expect(breakBasisText(1, 1)).toBe("range, vol n/a");
    expect(breakBasisText(0, 1)).toBe("vol n/a");
    expect(breakBasisText(2, 2)).toBe("vol, range n/a");
    expect(breakBasisText(0, 2)).toBe("range n/a");
    expect(breakBasisText(0, 0)).toBe("no baseline");
    expect("Last ↑ 26 Oct · range, vol n/a".length).toBe(30);
  });

  it("row 1 prints lo–hi at the instrument's precision without separators, or six significant digits when it would not fit", () => {
    expect(rangeRowText(67_237.22, 66_878.17)).toBe("Range 66878.17–67237.22");
    expect(rangeRowText(60_055, 59_945)).toBe("Range 59945–60055");
    expect(rangeRowText(0.12345678, 0.12300001)).toBe("Range 0.12300001–0.12345678");
    expect(rangeRowText(123_456.123456, 123_455.123456)).toBe("Range 123455–123456");
    expect(rangeRowText(123_456.123456, 123_455.123456).length).toBeLessThanOrEqual(CB_TABLE_MAX_CHARS);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(decimalsOf(100)).toBe(0);
  });

  it("withAlpha handles short and long hex and leaves other strings alone", () => {
    expect(withAlpha("#fff", 0.5)).toBe("rgba(255,255,255,0.5)");
    expect(withAlpha(CB_RANGE_COLOR, 0.14)).toBe("rgba(134,114,179,0.14)");
    expect(withAlpha("rgb(1,2,3)", 0.5)).toBe("rgb(1,2,3)");
  });
});

describe("compressionBreakout -- outputs, markers and the box pool through the runtime", () => {
  it("rangeHigh/rangeLow carry the snapshot edges whenever a range exists, forming included, and null otherwise; seams are pulses", () => {
    const { bars } = compressionBreakoutBars({ seed: 7 });
    const capture = replayCapture(compressionBreakoutIndicator, bars, SETTINGS);
    expect(capture.faulted).toBe(false);
    const readings = readingsOf(bars);
    bars.forEach((_, index) => {
      expect(capture.outputs.rangeHigh[index]).toBe(readings[index].rangeHigh);
      expect(capture.outputs.rangeLow[index]).toBe(readings[index].rangeLow);
    });
    const firstForming = readings.findIndex((reading) => reading.active !== null && reading.active.age === 0);
    expect(firstForming).toBeGreaterThanOrEqual(40);
    expect(capture.outputs.rangeHigh[firstForming]).not.toBeNull();
    expect(capture.outputs.rangeHigh[firstForming]).toBe(readings[firstForming].active!.hi);
    expect(capture.outputs.rangeHigh[220]).not.toBeNull();
    expect(capture.outputs.rangeHigh[225]).not.toBeNull();
    expect(capture.outputs.rangeHigh[226]).toBeNull();
    expect(compressionBreakoutIndicator.readOutput(compressionBreakoutIndicator.createState(SETTINGS))).toMatchObject({ rangeHigh: null, breakDir: 0, pending: 0 });
  });

  it("a confirmed break draws one solid arrow; a marked failure one warn circle; a faded arrow for one test; nothing for grade 0", () => {
    const { bars } = compressionFailedBreakBars({ seed: 9 });
    const capture = replayCapture(compressionBreakoutIndicator, bars, SETTINGS);
    const arrows = capture.markers.filter((call) => call.shape === "arrowUp" || call.shape === "arrowDown");
    const circles = capture.markers.filter((call) => call.shape === "circle");
    expect(arrows.some((call) => call.time === bars[220].ts_open && call.color === CB_BULL_COLOR && call.position === "belowBar")).toBe(true);
    expect(circles.some((call) => call.time === bars[221].ts_open && call.color === CB_WARN_COLOR && call.position === "inBar")).toBe(true);
    const perTime = new Map<number, number>();
    for (const call of capture.markers) perTime.set(call.time, (perTime.get(call.time) ?? 0) + 1);
    for (const count of perTime.values()) expect(count).toBe(1);
    const off = replayCapture(compressionBreakoutIndicator, bars, { ...SETTINGS, showMarkers: false });
    expect(off.markers).toEqual([]);
    // Grade 1 on a hand-built break: the arrow is the faded colour.
    const t0 = 1_780_000_000_000;
    const base = Array.from({ length: 47 }, (_, index) => {
      const up = index % 2 === 1;
      const spec = index === 46 ? { open: 60_050, high: 60_305, low: 60_045, close: 60_300, volume: 100 } : up ? { open: 59_950, high: 60_055, low: 59_945, close: 60_050, volume: 100 } : { open: 60_050, high: 60_055, low: 59_945, close: 59_950, volume: 100 };
      return barFrame(t0 + index * 60_000, { ...spec, tradeCount: 10 }, BINANCE_PERP);
    });
    const faded = replayCapture(compressionBreakoutIndicator, base, SETTINGS);
    expect(faded.markers).toHaveLength(1);
    expect(faded.markers[0].color).toBe(withAlpha(CB_BULL_COLOR, 0.65));
    const unconfirmed = base.map((bar, index) => (index === 46 ? ({ ...bar, high: 60_070, close: 60_060 } as BarFrame) : bar));
    expect(replayCapture(compressionBreakoutIndicator, unconfirmed, SETTINGS).markers).toEqual([]);
  });

  it("the edge line's last point is painted the invisible join colour on the outcome bar and purple otherwise", () => {
    const { bars } = compressionBreakoutBars({ seed: 7 });
    const session = openLiveSession(compressionBreakoutIndicator, SETTINGS, {}, []);
    try {
      for (const bar of bars.slice(0, 226)) session.dispatch({ bar });
      const colors = session.runtime.getLineColors(compressionBreakoutIndicator.id)!;
      expect(colors.rangeHigh[224]).toBe(CB_RANGE_COLOR);
      expect(colors.rangeHigh[225]).toBe(CB_EDGE_JOIN_COLOR);
      // An abandoned range's last point is painted the join colour too, so a forming range never joins the next one.
      const readings = readingsOf(bars.slice(0, 226));
      const abandoned = readings.findIndex((reading) => reading.decision.kind === "abandoned");
      if (abandoned >= 0) expect(colors.rangeHigh[abandoned]).toBe(CB_EDGE_JOIN_COLOR);
    } finally {
      session.close();
    }
  });

  it("creates a pool of eight boxes and one table; the active box and held boxes carry their coordinates", () => {
    const { bars } = compressionFailedBreakBars({ seed: 9 });
    const session = openLiveSession(compressionBreakoutIndicator, { ...SETTINGS, holdBars: 200 }, {}, []);
    try {
      for (const bar of bars.slice(0, 300)) session.dispatch({ bar });
      const owner = session.runtime.getDrawOwnerId(compressionBreakoutIndicator.id)!;
      const records = handlesForOwners([owner]);
      expect(records.filter((record) => record.kind === "box")).toHaveLength(CB_BOX_POOL);
      expect(records.filter((record) => record.kind === "table")).toHaveLength(1);
      const boxes = records.filter((record) => record.kind === "box").map((record) => record.data as { time1: number; backgroundColor: string; borderColor: string });
      const drawn = boxes.filter((box) => box.time1 > 0 && box.backgroundColor !== "rgba(0,0,0,0)");
      expect(drawn.length).toBeGreaterThanOrEqual(2);
      expect(drawn.some((box) => box.borderColor === withAlpha(CB_WARN_COLOR, 0.5))).toBe(true);
      const hidden = replayCapture(compressionBreakoutIndicator, bars, { ...SETTINGS, showRanges: false });
      expect(hidden.faulted).toBe(false);
    } finally {
      session.close();
    }
  });

  it("every settings key is in the schema, the three primary controls have no tab, and the rest are advanced or visibility", () => {
    const schema = compressionBreakoutIndicator.settingsSchema!;
    const keys = schema.filter((field) => field.kind !== "staticHint").map((field) => (field as { key: string }).key);
    expect(new Set(keys)).toEqual(new Set(Object.keys(SETTINGS)));
    const primary = schema.filter((field) => field.kind !== "staticHint" && field.tab === undefined).map((field) => (field as { key: string }).key);
    expect(primary).toEqual(["rangeLength", "minCompressionBars", "confirmMultiple"]);
    for (const field of schema) {
      if (field.kind === "numeric") expect(field.step).toBeGreaterThan(0);
    }
    expect(compressionBreakoutIndicator.maxReplayBars).toBe(10_080);
    expect(compressionBreakoutIndicator.placement).toEqual({ kind: "overlay" });
  });
});
