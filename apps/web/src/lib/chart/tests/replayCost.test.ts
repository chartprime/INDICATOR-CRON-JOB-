import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createIndicatorRuntime } from "../indicatorRuntime";
import { RUNTIME_INDICATOR_DEFS } from "../indicatorRegistry";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { drawRegistryStats, resetDrawRegistryForTests, setRequestUpdate } from "../draw/registry";
import type { BarFrame } from "../../../types/frames";

// Report 57 W4 (GE-19): what one indicator activation costs over the density
// benchmark's 10,080 one-minute bars. Opt-in measurement, never a gate:
// W4_REPLAY_BENCH=1 runs it, W4_REPLAY_BENCH_OUT=<file> keeps the JSON.

const MINUTE_MS = 60_000;
const BARS = 10_080;

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function densityBars(count: number): BarFrame[] {
  const random = seeded(7);
  const out: BarFrame[] = [];
  let price = 60_000;
  let drift = 0;
  for (let index = 0; index < count; index += 1) {
    if (index % 90 === 0) drift = (random() - 0.5) * 6;
    const open = price;
    const close = Math.max(1, open + drift + (random() - 0.5) * 40);
    const high = Math.max(open, close) + random() * 15;
    const low = Math.min(open, close) - random() * 15;
    const volume = Math.round(50 + random() * 450);
    out.push({
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL",
      interval_ms: MINUTE_MS, ts_open: 1_780_000_000_000 + index * MINUTE_MS,
      open, high, low, close, volume, buy_volume: Math.round(volume * (0.3 + random() * 0.4)),
      trade_count: Math.round(volume / 3), closed: true,
    } as BarFrame);
    price = close;
  }
  return out;
}

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

describe.runIf(process.env.W4_REPLAY_BENCH === "1")("replay cost per indicator (W4 measurement)", () => {
  it("activates every runtime indicator over 10,080 bars", () => {
    const bars = densityBars(BARS);
    const rows = [];
    for (const def of RUNTIME_INDICATOR_DEFS) {
      const runtime = createIndicatorRuntime(RUNTIME_INDICATOR_DEFS);
      runtime.setActive(new Set([def.id]), {}, []);
      const owner = runtime.getDrawOwnerId(def.id);
      let notifies = 0;
      if (owner !== null) setRequestUpdate(owner, () => { notifies += 1; });
      const started = performance.now();
      runtime.onSnapshot(bars);
      const replayMs = performance.now() - started;
      const objects = drawRegistryStats().objects;
      rows.push({ id: def.id, replayMs: Math.round(replayMs), notifies, objects, faulted: runtime.getOutput(def.id) === null && def.lines.length > 0 });
      resetDrawRegistryForTests();
    }
    rows.sort((a, b) => b.replayMs - a.replayMs);
    console.table(rows);
    if (process.env.W4_REPLAY_BENCH_OUT) writeFileSync(process.env.W4_REPLAY_BENCH_OUT, `${JSON.stringify({ bars: BARS, rows }, null, 2)}\n`);
    expect(rows.length).toBe(RUNTIME_INDICATOR_DEFS.length);
  }, 300_000);
});
