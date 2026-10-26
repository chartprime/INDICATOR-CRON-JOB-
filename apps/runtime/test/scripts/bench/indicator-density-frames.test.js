"use strict";

const { densityHistory, liveBarFrame, liveColumnFrame, seeded, MAX_FRAME_COLUMNS } = require("../../../scripts/bench/indicator-density-frames");

describe("indicator-density-frames", () => {
  const nowMs = 1_790_000_000_000;

  test("builds contract-valid dense history that chains per tier the way the browser grid requires", () => {
    // Every frame is built by the runtime's own liquidityFrame, which throws on anything the wire contract refuses.
    const history = densityHistory({ nowMs, bars: 500, rows: 400, deepColumns: 300, fineColumns: 130 });
    const byTier = new Map();
    for (const frame of history.liquidityFrames) {
      expect(frame.columns.length).toBeLessThanOrEqual(MAX_FRAME_COLUMNS);
      const tier = byTier.get(frame.column_ms) ?? [];
      tier.push(frame);
      byTier.set(frame.column_ms, tier);
    }
    expect([...byTier.keys()].sort((a, b) => a - b)).toEqual([1_000, 10_000]);
    for (const frames of byTier.values()) {
      let seq = 0;
      frames.forEach((frame, index) => {
        expect(frame.reset).toBe(index === 0);
        expect(frame.seq - frame.columns.length).toBe(seq);
        seq = frame.seq;
      });
    }
    const deepLast = byTier.get(10_000).at(-1).columns.at(-1).ts;
    const fineFirst = byTier.get(1_000)[0].columns[0].ts;
    expect(deepLast + 10_000).toBeLessThanOrEqual(fineFirst);
    expect(history.bars).toHaveLength(500);
    expect(history.bars.map((bar) => bar.ts_open)).toEqual([...history.bars.map((bar) => bar.ts_open)].sort((a, b) => a - b));
    expect(history.walls.size).toBeGreaterThan(0);
  });

  test("appends live columns that continue the fine tier's sequence", () => {
    const history = densityHistory({ nowMs, bars: 50, rows: 64, deepColumns: 20, fineColumns: 30 });
    const frame = liveColumnFrame({ history, ts: history.lastFineTs + 1_000, seq: history.fineSeq + 1, rows: 64, random: seeded(3) });
    expect(frame).toMatchObject({ type: "liquidity", reset: false, column_ms: 1_000, seq: history.fineSeq + 1 });
    expect(frame.columns).toHaveLength(1);
    expect(frame.columns[0].hi - frame.columns[0].lo + 1).toBe(64);
  });

  test("judges each scenario against the Gate E budgets and the baseline", () => {
    const { verdict, quantiles } = require("../../../scripts/bench/indicator-density");
    expect(quantiles([])).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null });
    expect(quantiles([10, 20, 30, 40])).toMatchObject({ count: 4, p50: 20, max: 40 });
    const phase = (p95, longest = null) => ({ longTaskMs: { max: longest }, frameIntervalMs: { p95 } });
    const result = (scenario, steady, hover, longest = null, errors = []) => ({ scenario, phases: { steady: phase(steady, longest), hover: phase(hover) }, pageErrors: errors });
    expect(verdict([result("baseline", 16.7, 16.7), result("bookMap", 20, 24)]).pass).toBe(true);
    const slow = verdict([result("baseline", 16.7, 16.7), result("bookMap", 16.8, 50)]);
    expect(slow.pass).toBe(false);
    expect(slow.checks.filter((check) => !check.pass).map((check) => check.check)).toEqual(["hover frame interval p95 ≤ 33 ms", "hover p95 added over baseline ≤ 8 ms"]);
    expect(verdict([result("baseline", 16.7, 16.7, 120)]).pass).toBe(false);
    expect(verdict([result("baseline", 16.7, 16.7, null, ["boom"])]).pass).toBe(false);
  });

  test("refuses a fast benchmark when the chart, requested indicator, or liquidity did not load", () => {
    const { scenarioReadinessIssues } = require("../../../scripts/bench/indicator-density");
    const ready = { chartCanvas: true, ohlcReadout: true, liveBadge: true, indicatorRows: 2, hiddenIndicatorRows: 0, liquidityLoaded: true };
    const favorites = ["l2BookMap", "passiveLiquidity"];
    expect(scenarioReadinessIssues(ready, favorites)).toEqual([]);
    expect(scenarioReadinessIssues({ ...ready, ohlcReadout: false }, favorites)).toContain("candle history not displayed");
    expect(scenarioReadinessIssues({ ...ready, indicatorRows: 0 }, favorites)).toContain("expected 2 indicator rows, found 0");
    expect(scenarioReadinessIssues({ ...ready, liquidityLoaded: false }, favorites)).toContain("liquidity history not displayed");
    expect(scenarioReadinessIssues({ ...ready, hiddenIndicatorRows: 1 }, favorites)).toContain("one or more indicators hidden");
  });

  test("refuses rows outside what one wire column may carry", () => {
    expect(() => densityHistory({ nowMs, rows: 4 })).toThrow(/invalid history options/);
    expect(() => densityHistory({ nowMs, rows: 4_096 })).toThrow(/invalid history options/);
  });

  test("answers a size-filtered wall request from the dense whale set, with every wall past the cut or exempt by outcome, newest cursor first", () => {
    const { historyWallsPage, WHALE_WALL_COUNT } = require("../../../scripts/bench/indicator-density-frames");
    const history = densityHistory({ nowMs, bars: 50, rows: 64, deepColumns: 20, fineColumns: 30 });
    const everything = [];
    let after = null;
    for (;;) {
      const page = historyWallsPage({ history, fromTs: nowMs - 49 * 3_600_000, toTs: nowMs, limit: 400, after, minUsd: 0, alwaysOutcomes: [] });
      everything.push(...page.walls);
      if (page.next === null) break;
      after = page.next;
    }
    expect(WHALE_WALL_COUNT).toBe(1_500);
    expect(everything).toHaveLength(1_500);
    expect(new Set(everything.map((wall) => `${wall.side}|${wall.row}|${wall.span}|${wall.startTs}`)).size).toBe(WHALE_WALL_COUNT);
    expect(everything.every((wall) => wall.endTs > wall.startTs && wall.endTs < nowMs)).toBe(true);
    const cut = 40_000_000;
    const filtered = historyWallsPage({ history, fromTs: nowMs - 49 * 3_600_000, toTs: nowMs, limit: 5_000, minUsd: cut, alwaysOutcomes: ["filled", "partial"] });
    expect(filtered.walls.length).toBeGreaterThan(0);
    expect(filtered.walls.length).toBeLessThanOrEqual(WHALE_WALL_COUNT);
    for (const wall of filtered.walls) expect(wall.peak * (wall.row + wall.span / 2) * history.rowWidth >= cut || ["filled", "partial"].includes(wall.endedBy)).toBe(true);
    const dropped = everything.filter((wall) => !filtered.walls.some((kept) => kept.id === wall.id));
    expect(dropped.length).toBeGreaterThan(0);
    for (const wall of dropped) expect(wall.peak * (wall.row + wall.span / 2) * history.rowWidth < cut && !["filled", "partial"].includes(wall.endedBy)).toBe(true);
    const pulled = everything.find((wall) => wall.endedBy === "pulled");
    const edge = pulled.peak * (pulled.row + pulled.span / 2) * history.rowWidth;
    const atEdge = (minUsd) => historyWallsPage({ history, fromTs: nowMs - 49 * 3_600_000, toTs: nowMs, limit: 5_000, minUsd, alwaysOutcomes: ["filled"] }).walls.some((wall) => wall.id === pulled.id);
    expect(atEdge(edge)).toBe(true);
    expect(atEdge(edge + 1)).toBe(false);
    const unfiltered = historyWallsPage({ history, fromTs: nowMs - 49 * 3_600_000, toTs: nowMs, limit: 5_000 });
    expect(unfiltered.walls.length).toBeLessThan(WHALE_WALL_COUNT);
  });

  test("gates the whale scenario's pan, history and every timeframe switch as well as steady and hover, and no other scenario's", () => {
    const { verdict } = require("../../../scripts/bench/indicator-density");
    const phase = (p95) => ({ longTaskMs: { max: null }, frameIntervalMs: { p95 } });
    const whale = (over = {}) => ({ scenario: "whaleHeatmap", pageErrors: [], phases: { steady: phase(16.7), hover: phase(16.7), pan: phase(20), history: phase(20), ...over.phases }, timeframeSwitches: over.timeframeSwitches ?? [{ label: "5m", frameIntervalMs: { p95: 20 } }, { label: "1h", frameIntervalMs: { p95: 25 } }] });
    const base = { scenario: "baseline", pageErrors: [], phases: { steady: phase(16.7), hover: phase(16.7), pan: phase(16.7), history: phase(16.7) } };
    expect(verdict([base, whale()]).pass).toBe(true);
    const failing = (result) => verdict([base, result]).checks.filter((check) => !check.pass).map((check) => check.check);
    expect(failing(whale({ phases: { pan: phase(40) } }))).toEqual(["pan frame interval p95 ≤ 33 ms"]);
    expect(failing(whale({ phases: { history: phase(40) } }))).toEqual(["history frame interval p95 ≤ 33 ms"]);
    expect(failing(whale({ timeframeSwitches: [{ label: "5m", frameIntervalMs: { p95: 20 } }, { label: "1h", frameIntervalMs: { p95: 50 } }] }))).toEqual(["every timeframe switch frame interval p95 ≤ 33 ms"]);
    expect(failing(whale({ timeframeSwitches: [] }))).toEqual(["every timeframe switch frame interval p95 ≤ 33 ms"]);
    const noHistory = whale();
    delete noHistory.phases.history;
    expect(failing(noHistory)).toEqual(["history frame interval p95 ≤ 33 ms"]);
    const bookMap = { scenario: "bookMap", pageErrors: [], phases: { steady: phase(16.7), hover: phase(16.7), pan: phase(90), history: phase(90) } };
    expect(verdict([base, bookMap]).pass).toBe(true);
  });

  test("lists the whale heatmap among the scenarios, outside the all-indicators set", () => {
    const { SCENARIOS } = require("../../../scripts/bench/indicator-density");
    expect(SCENARIOS.whaleHeatmap).toEqual(["whaleLimitOrderHeatmap"]);
    expect(SCENARIOS.all).not.toContain("whaleLimitOrderHeatmap");
    expect(SCENARIOS.everything).not.toContain("whaleLimitOrderHeatmap");
  });

  test("develops the live minute and closes it exactly once when the minute rolls (report 57 W4)", () => {
    const history = densityHistory({ nowMs, bars: 50, rows: 64, deepColumns: 20, fineColumns: 30 });
    const random = seeded(5);
    const minute = Math.floor(nowMs / 60_000) * 60_000;
    const first = liveBarFrame({ history, previous: null, nowMs, random });
    const second = liveBarFrame({ history, previous: first.next, nowMs: nowMs + 250, random });
    const rolled = liveBarFrame({ history, previous: second.next, nowMs: minute + 60_000, random });
    expect(first.frames.map((frame) => [frame.ts_open, frame.closed])).toEqual([[minute, false]]);
    expect(second.next.volume).toBeGreaterThan(first.next.volume);
    expect(second.next.high).toBeGreaterThanOrEqual(second.next.close);
    expect(rolled.frames.map((frame) => [frame.ts_open, frame.closed])).toEqual([[minute, true], [minute + 60_000, false]]);
    expect(rolled.frames[0].volume).toBe(second.next.volume);
  });
});
