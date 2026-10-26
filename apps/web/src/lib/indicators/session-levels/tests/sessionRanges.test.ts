import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { KILLZONE_SESSIONS, buildKillzoneOccurrences, type KillzoneId } from "../../killzones/killzones";
import { MAX_RANGES, ORB_SESSION, ORB_WINDOWS_MIN, applyBar, createRangeBuilder, type OrbWindowMin, type Range, type RangeBuilder, type RangeSettings } from "../sessionRanges";

const MINUTE = 60_000;

// January is EST (UTC-5, no DST), so a New York time is plain arithmetic, as in Agha's killzones tests.
function ny(day: number, hh: number, mm: number): number {
  return Date.UTC(2026, 0, day, hh + 5, mm);
}

function bar(ts_open: number, high: number, low: number, interval_ms = MINUTE, closed = true): BarFrame {
  return {
    type: "bar", symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE", interval_ms, ts_open,
    open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1, trade_count: 1, closed,
  } as BarFrame;
}

/** One-minute bars from `from` to `to` inclusive, the high climbing one a minute and the low falling one every two. */
function minutes(from: number, to: number, base = 100): BarFrame[] {
  const bars: BarFrame[] = [];
  for (let ts = from, i = 0; ts <= to; ts += MINUTE, i += 1) bars.push(bar(ts, base + (i % 7), base - (i % 5)));
  return bars;
}

function settings(sessions: readonly KillzoneId[] = ["nyam"], windows: readonly OrbWindowMin[] = ORB_WINDOWS_MIN, sessionLevels = true): RangeSettings {
  return { sessions: new Set(sessions), windows: new Set(windows), sessionLevels };
}

function build(bars: readonly BarFrame[], settingsUsed = settings()): RangeBuilder {
  const builder = createRangeBuilder();
  for (const b of bars) applyBar(builder, b, settingsUsed);
  return builder;
}

function shape(range: Range): unknown {
  return { kind: range.kind, sessionId: range.sessionId, startMs: range.startMs, endMs: range.endMs, high: range.high, low: range.low, ...(range.kind === "orb" ? { windowMin: range.windowMin } : {}) };
}

const LONDON = KILLZONE_SESSIONS.find((session) => session.id === "london")!;
const ASIA = KILLZONE_SESSIONS.find((session) => session.id === "asia")!;

describe("session ranges", () => {
  it("closes London's range on the first bar after 05:00 with the start, end, high and low of Agha's occurrence", () => {
    const bars = minutes(ny(15, 1, 50), ny(15, 5, 10));
    const builder = build(bars, settings(["london"]));
    const [his] = buildKillzoneOccurrences(bars, LONDON, 3);
    expect(builder.ranges.map(shape)).toEqual([
      { kind: "session", sessionId: "london", startMs: his.startMs, endMs: his.boxEndMs, high: his.high, low: his.low },
    ]);
    expect(builder.ranges[0]).toMatchObject({ startMs: ny(15, 2, 0), endMs: ny(15, 4, 59) });
  });

  it("hands out no session range while the session is still running", () => {
    const builder = build(minutes(ny(15, 1, 50), ny(15, 4, 0)), settings(["london"]));
    expect(builder.ranges).toEqual([]);
  });

  it("builds Asia, which runs to midnight, as one range that matches Agha's occurrence", () => {
    const bars = minutes(ny(15, 19, 55), ny(16, 0, 5));
    const builder = build(bars, settings(["asia"]));
    const [his] = buildKillzoneOccurrences(bars, ASIA, 3);
    expect(builder.ranges.map(shape)).toEqual([
      { kind: "session", sessionId: "asia", startMs: his.startMs, endMs: his.boxEndMs, high: his.high, low: his.low },
    ]);
    expect(builder.ranges[0]).toMatchObject({ startMs: ny(15, 20, 0), endMs: ny(15, 23, 59) });
  });

  it("makes opening ranges for NY AM alone: London and RTH, which shares NY AM's start, get none", () => {
    expect(ORB_SESSION).toBe("nyam");
    const morning = build(minutes(ny(15, 9, 30), ny(15, 10, 5)), settings(["nyam", "rth"]));
    expect(morning.ranges.map((range) => [range.sessionId, range.kind === "orb" ? range.windowMin : 0])).toEqual([["nyam", 5], ["nyam", 15], ["nyam", 30]]);
    expect(build(minutes(ny(15, 2, 0), ny(15, 2, 40)), settings(["london"])).ranges).toEqual([]);
  });

  it("closes each opening range on the last closed bar of its window: five, fifteen and thirty minutes from 09:30", () => {
    const bars = minutes(ny(15, 9, 30), ny(15, 10, 10));
    const builder = createRangeBuilder();
    const upTo = (hh: number, mm: number) => {
      for (const b of bars) if (b.ts_open > builder.lastOpen && b.ts_open <= ny(15, hh, mm)) applyBar(builder, b, settings());
      return builder.ranges.map(shape);
    };
    expect(upTo(9, 33)).toEqual([]);
    expect(upTo(9, 34)).toEqual([{ kind: "orb", sessionId: "nyam", windowMin: 5, startMs: ny(15, 9, 30), endMs: ny(15, 9, 34), high: 104, low: 96 }]);
    expect(upTo(9, 43)).toHaveLength(1);
    expect(upTo(9, 44)[1]).toEqual({ kind: "orb", sessionId: "nyam", windowMin: 15, startMs: ny(15, 9, 30), endMs: ny(15, 9, 44), high: 106, low: 96 });
    expect(upTo(9, 58)).toHaveLength(2);
    expect(upTo(9, 59)[2]).toEqual({ kind: "orb", sessionId: "nyam", windowMin: 30, startMs: ny(15, 9, 30), endMs: ny(15, 9, 59), high: 106, low: 96 });
    expect(upTo(10, 10)).toHaveLength(3);
  });

  it("closes a window on the bar after it when the window's last bar never arrived closed, keeping that bar's high and low", () => {
    const only5 = settings(["nyam"], [5]);
    const builder = build([...minutes(ny(15, 9, 30), ny(15, 9, 33)), bar(ny(15, 9, 34), 150, 50, MINUTE, false)], only5);
    expect(builder.ranges).toEqual([]);
    applyBar(builder, bar(ny(15, 9, 35), 101, 99, MINUTE, false), only5);
    expect(builder.ranges.map(shape)).toEqual([{ kind: "orb", sessionId: "nyam", windowMin: 5, startMs: ny(15, 9, 30), endMs: ny(15, 9, 34), high: 150, low: 50 }]);
  });

  it("reads a re-emitted bar once: the open bar again, wider, widens the range and makes no second one", () => {
    const only5 = settings(["nyam"], [5]);
    const builder = build(minutes(ny(15, 9, 30), ny(15, 9, 33)), only5);
    applyBar(builder, bar(ny(15, 9, 34), 110, 95, MINUTE, false), only5);
    applyBar(builder, bar(ny(15, 9, 34), 120, 90, MINUTE, false), only5);
    applyBar(builder, bar(ny(15, 9, 34), 120, 90), only5);
    expect(builder.ranges.map(shape)).toEqual([{ kind: "orb", sessionId: "nyam", windowMin: 5, startMs: ny(15, 9, 30), endMs: ny(15, 9, 34), high: 120, low: 90 }]);
  });

  it("skips an opening range the chart's bars cannot make: no five-minute range on a fifteen-minute chart, all three on a five-minute one", () => {
    const fifteen = build([30, 45, 60, 75].map((mm) => bar(ny(15, 9, mm), 100 + mm, 100 - mm, 15 * MINUTE)));
    expect(fifteen.ranges.map(shape)).toEqual([
      { kind: "orb", sessionId: "nyam", windowMin: 15, startMs: ny(15, 9, 30), endMs: ny(15, 9, 30), high: 130, low: 70 },
      { kind: "orb", sessionId: "nyam", windowMin: 30, startMs: ny(15, 9, 30), endMs: ny(15, 9, 45), high: 145, low: 55 },
    ]);
    const five = build([30, 35, 40, 45, 50, 55, 60].map((mm) => bar(ny(15, 9, mm), 100 + mm, 100 - mm, 5 * MINUTE)));
    expect(five.ranges.map((range) => (range.kind === "orb" ? [range.windowMin, range.endMs] : null))).toEqual([[5, ny(15, 9, 30)], [15, ny(15, 9, 40)], [30, ny(15, 9, 55)]]);
  });

  it("skips the opening ranges when the chart's first NY AM bar is not 09:30, and keeps the session range", () => {
    const builder = build(minutes(ny(15, 9, 37), ny(15, 11, 2)));
    expect(builder.ranges.map((range) => range.kind)).toEqual(["session"]);
    expect(builder.ranges[0]).toMatchObject({ startMs: ny(15, 9, 37), endMs: ny(15, 10, 59) });
  });

  it("drops a window the bars left unfinished, and keeps the ones that closed", () => {
    const builder = build([...minutes(ny(15, 9, 30), ny(15, 9, 40)), bar(ny(15, 12, 0), 100, 100)]);
    expect(builder.ranges.map((range) => (range.kind === "orb" ? `orb${range.windowMin}` : range.kind))).toEqual(["orb5", "session"]);
  });

  it("drops yesterday's NY AM ranges the moment NY AM opens again, and not before", () => {
    const builder = build(minutes(ny(15, 9, 28), ny(15, 11, 2)));
    applyBar(builder, bar(ny(15, 14, 0), 100, 100), settings());
    applyBar(builder, bar(ny(16, 9, 29), 100, 100), settings());
    expect(builder.ranges).toHaveLength(4);
    applyBar(builder, bar(ny(16, 9, 30), 100, 100), settings());
    expect(builder.ranges).toEqual([]);
  });

  it("starts a new occurrence after a gap longer than the session, so Thursday's and Sunday's Asia do not merge", () => {
    const thursday = minutes(ny(15, 20, 0), ny(15, 20, 30));
    const sunday = minutes(ny(18, 20, 0), ny(18, 20, 30));
    const builder = build([...thursday, ...sunday, bar(ny(19, 0, 0), 100, 100)], settings(["asia"]));
    expect(builder.ranges.map(shape)).toEqual([
      { kind: "session", sessionId: "asia", startMs: ny(18, 20, 0), endMs: ny(18, 20, 30), high: 106, low: 96 },
    ]);
  });

  it("starts a new occurrence when the bar interval changes inside a session, as Agha's occurrences do", () => {
    const bars = [...minutes(ny(15, 2, 0), ny(15, 2, 9)), bar(ny(15, 2, 10), 100, 100, 5 * MINUTE), bar(ny(15, 2, 15), 100, 100, 5 * MINUTE), bar(ny(15, 5, 0), 100, 100, 5 * MINUTE)];
    const builder = build(bars, settings(["london"]));
    const his = buildKillzoneOccurrences(bars, LONDON, 3);
    expect(his.map((occurrence) => [occurrence.startMs, occurrence.boxEndMs])).toEqual([[ny(15, 2, 0), ny(15, 2, 9)], [ny(15, 2, 10), ny(15, 2, 15)]]);
    expect(builder.ranges.map(shape)).toEqual([{ kind: "session", sessionId: "london", startMs: ny(15, 2, 10), endMs: ny(15, 2, 15), high: 100, low: 100 }]);
  });

  it("ignores a bar older than the last one", () => {
    const builder = build(minutes(ny(15, 9, 30), ny(15, 9, 50)));
    const before = JSON.stringify(builder.ranges);
    applyBar(builder, bar(ny(15, 9, 31), 999, 1), settings());
    expect(JSON.stringify(builder.ranges)).toBe(before);
    expect(builder.lastOpen).toBe(ny(15, 9, 50));
  });

  it("builds nothing for a session that is off, keeps each opening range on its own checkbox whatever NY AM's, and only opening ranges when the session levels are off", () => {
    const bars = minutes(ny(15, 9, 28), ny(15, 11, 2));
    expect(build(bars, settings(["asia"], [])).ranges).toEqual([]);
    expect(build(bars, settings(["asia"], [5, 30])).ranges.map((range) => (range.kind === "orb" ? range.windowMin : range.sessionId))).toEqual([5, 30]);
    expect(build(bars, settings(["nyam"], [])).ranges.map((range) => range.kind)).toEqual(["session"]);
    expect(build(bars, settings(["nyam"], [15], false)).ranges.map(shape)).toEqual([
      { kind: "orb", sessionId: "nyam", windowMin: 15, startMs: ny(15, 9, 30), endMs: ny(15, 9, 44), high: 106, low: 96 },
    ]);
  });

  it("keeps today's ranges only: every session on over four days leaves the eight of the last day, under the slot bound", () => {
    const all = settings(KILLZONE_SESSIONS.map((session) => session.id));
    const bars: BarFrame[] = [];
    for (let day = 5; day < 9; day += 1) bars.push(...minutes(ny(day, 0, 0), ny(day, 23, 59)));
    const builder = build(bars, all);
    expect(builder.ranges).toHaveLength(8);
    expect(builder.ranges.length).toBeLessThanOrEqual(MAX_RANGES);
    expect(builder.ranges.map((range) => [range.sessionId, range.kind === "orb" ? range.windowMin : 0])).toEqual([
      ["london", 0], ["nyam", 5], ["nyam", 15], ["nyam", 30], ["nyam", 0], ["nylunch", 0], ["nypm", 0], ["rth", 0],
    ]);
    expect(builder.ranges.every((range) => range.startMs >= ny(8, 0, 0))).toBe(true);
  });

  it("builds no session while the futures week is shut, Friday 17:00 ET to Sunday 18:00: Friday's ranges stay through the weekend and Sunday's Asia is the next", () => {
    const week = settings(["asia", "london"], []);
    const builder = build([...minutes(ny(16, 1, 50), ny(16, 23, 59)), ...minutes(ny(17, 0, 0), ny(17, 23, 59)), ...minutes(ny(18, 0, 0), ny(18, 19, 59))], week);
    expect(builder.ranges.map((range) => [range.sessionId, range.startMs])).toEqual([["london", ny(16, 2, 0)]]);
    expect(builder.running.size).toBe(0);
    for (const b of minutes(ny(18, 20, 0), ny(18, 20, 30))) applyBar(builder, b, week);
    expect([...builder.running.keys()]).toEqual(["asia"]);
    applyBar(builder, bar(ny(19, 0, 0), 100, 100), week);
    expect(builder.ranges.map((range) => [range.sessionId, range.startMs])).toEqual([["london", ny(16, 2, 0)], ["asia", ny(18, 20, 0)]]);
    for (const b of minutes(ny(19, 2, 0), ny(19, 5, 0))) applyBar(builder, b, week);
    expect(builder.ranges.map((range) => [range.sessionId, range.startMs])).toEqual([["asia", ny(18, 20, 0)], ["london", ny(19, 2, 0)]]);
  });

  it("keeps Thursday's Asia through Friday night: no Asia opens after the Friday close", () => {
    const builder = build([...minutes(ny(15, 20, 0), ny(16, 0, 5)), ...minutes(ny(16, 20, 0), ny(16, 23, 59))], settings(["asia"]));
    expect(builder.ranges.map((range) => [range.sessionId, range.startMs])).toEqual([["asia", ny(15, 20, 0)]]);
    expect(builder.running.size).toBe(0);
  });

  it("still marks a touch of Friday's level by a weekend bar", () => {
    const builder = build(minutes(ny(16, 1, 50), ny(16, 5, 0)), settings(["london"]));
    expect(builder.ranges[0]).toMatchObject({ high: 106, highTouchMs: null });
    applyBar(builder, bar(ny(17, 12, 0), 107, 100), settings(["london"]));
    expect(builder.ranges[0].highTouchMs).toBe(ny(17, 12, 0));
  });
});

describe("where a level is touched", () => {
  it("marks the first bar after the range whose wick reaches the level, a touch or a wick through alike, and leaves an unreached one open", () => {
    const session = minutes(ny(15, 2, 0), ny(15, 4, 59));
    const after = [bar(ny(15, 5, 0), 105, 97), bar(ny(15, 5, 1), 106, 97), bar(ny(15, 5, 2), 108, 97), bar(ny(15, 5, 3), 105, 97)];
    const [range] = build([...session, ...after], settings(["london"])).ranges;
    expect(range).toMatchObject({ high: 106, low: 96, highTouchMs: ny(15, 5, 1), lowTouchMs: null });
    const [through] = build([...session, bar(ny(15, 5, 0), 105, 95)], settings(["london"])).ranges;
    expect(through).toMatchObject({ highTouchMs: null, lowTouchMs: ny(15, 5, 0) });
  });

  it("does not count the range's own last bar, whose high is the range's", () => {
    const only5 = settings(["nyam"], [5]);
    const builder = build(minutes(ny(15, 9, 30), ny(15, 9, 34)), only5);
    expect(builder.ranges[0]).toMatchObject({ high: 104, highTouchMs: null, lowTouchMs: null });
    applyBar(builder, bar(ny(15, 9, 35), 104, 99), only5);
    expect(builder.ranges[0]).toMatchObject({ highTouchMs: ny(15, 9, 35), lowTouchMs: null });
  });

  it("marks a touch on the open bar the moment its wick gets there, and keeps it when a later bar goes further", () => {
    const only5 = settings(["nyam"], [5]);
    const builder = build(minutes(ny(15, 9, 30), ny(15, 9, 34)), only5);
    applyBar(builder, bar(ny(15, 9, 35), 101, 99, MINUTE, false), only5);
    expect(builder.ranges[0].highTouchMs).toBeNull();
    applyBar(builder, bar(ny(15, 9, 35), 104, 99, MINUTE, false), only5);
    expect(builder.ranges[0].highTouchMs).toBe(ny(15, 9, 35));
    applyBar(builder, bar(ny(15, 9, 36), 110, 99), only5);
    expect(builder.ranges[0].highTouchMs).toBe(ny(15, 9, 35));
  });

  it("drops the touch with its range when the session opens again", () => {
    const bars = [...minutes(ny(15, 2, 0), ny(15, 4, 59)), bar(ny(16, 1, 59), 106, 100)];
    const builder = build(bars, settings(["london"]));
    expect(builder.ranges[0].highTouchMs).toBe(ny(16, 1, 59));
    applyBar(builder, bar(ny(16, 2, 0), 999, 1), settings(["london"]));
    expect(builder.ranges).toEqual([]);
  });
});
