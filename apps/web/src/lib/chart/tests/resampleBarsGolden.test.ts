import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BarFrame } from "../../../types/frames";
import { resampleBars } from "../resampleBars";

// Property: the browser resampler gives the answers pinned in the shared golden
// file, which the Python archive rollup is held to as well
// (apps/runtime/conversion/tests/test_candle_rollup_golden.py).
// Oracle: the hand-derived expectations in that file, not either implementation.
// The file also pins where the two implementations differ, and why.

type Run = {
  atMinute: number; count?: number; symbol?: string;
  open: string; high: string; low: string; close: string; volume: string;
};
type Expected = { openMinute: number; open: string; high: string; low: string; close: string; volume: string; closed?: boolean };
type Case = {
  name: string; target: "hour" | "day"; minutes: Run[];
  outcome: "agree" | "differ" | "both-refuse";
  difference?: string;
  python: Expected[] | { error: string };
  js: Expected[] | { error: string };
};

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(
  path.resolve(here, "../../../../../../benchmarks/fixtures/golden/candle-rollup.json"), "utf8")) as { baseMs: number; cases: Case[] };

const MINUTE_MS = 60_000;
const TARGET_MS = { hour: 3_600_000, day: 86_400_000 };

function minuteBars(runs: Run[]): BarFrame[] {
  const bars: BarFrame[] = [];
  for (const run of runs) {
    for (let index = 0; index < (run.count ?? 1); index += 1) {
      bars.push({
        type: "bar", symbol: run.symbol ?? "38", provider: "DATABENTO", assetClass: "FUTURE",
        interval_ms: MINUTE_MS, ts_open: golden.baseMs + (run.atMinute + index) * MINUTE_MS,
        open: Number(run.open), high: Number(run.high), low: Number(run.low), close: Number(run.close),
        volume: Number(run.volume), trade_count: null, closed: true,
      });
    }
  }
  return bars;
}

function asExpected(bars: BarFrame[]): Expected[] {
  return bars.map((bar) => ({
    openMinute: (bar.ts_open - golden.baseMs) / MINUTE_MS,
    open: String(bar.open), high: String(bar.high), low: String(bar.low), close: String(bar.close),
    volume: String(bar.volume), closed: bar.closed,
  }));
}

describe("the browser resampler against the shared golden file", () => {
  it.each(golden.cases.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const bars = minuteBars(entry.minutes);
    if (!Array.isArray(entry.js)) {
      expect(() => resampleBars(bars, TARGET_MS[entry.target])).toThrow(entry.js.error);
      return;
    }
    expect(asExpected(resampleBars(bars, TARGET_MS[entry.target]))).toEqual(entry.js.map((bar) => ({ ...bar })));
  });

  it("the file itself is consistent: agreeing cases give identical values on both sides, differing cases say why", () => {
    for (const entry of golden.cases) {
      if (entry.outcome === "agree") {
        const python = entry.python as Expected[];
        const js = (entry.js as Expected[]).map(({ closed: _closed, ...values }) => values);
        expect(js, entry.name).toEqual(python);
      } else if (entry.outcome === "differ") {
        expect(entry.difference, entry.name).toBeTruthy();
        expect(entry.js, entry.name).not.toEqual(entry.python);
      } else {
        expect(Array.isArray(entry.python) || Array.isArray(entry.js), entry.name).toBe(false);
      }
    }
  });
});
