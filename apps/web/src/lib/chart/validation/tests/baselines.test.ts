import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bollingerIndicator } from "../../../indicators/bollinger/bollinger";
import { cvdDivergenceIndicator } from "../../../indicators/cvd-divergence/cvdDivergenceIndicator";
import { l2FeedStatusIndicator } from "../../../indicators/l2-feed-status/l2FeedStatus";
import { rsiIndicator } from "../../../indicators/rsi/rsi";
import { MAX_RETAINED_SOURCE_BARS } from "../../candleLifecycle";
import { resetDrawOwnerScopeForTests } from "../../draw/creationScope";
import { resetDrawRegistryForTests } from "../../draw/registry";
import type { RuntimeIndicatorDef } from "../../indicatorTypes";
import { fakeL2, ladderOf, tradeEvent, wallLifecycle } from "../fakeL2";
import { trendBars } from "../fixtures";
import type { LiveExtras } from "../liveDrive";
import {
  formatFormingBarProbe,
  formatReplayProbe,
  formatRolloverProbe,
  probeFormingBar,
  probeReplay,
  probeRollover,
} from "../perfProbe";

// Protocol check 6 reference points (PM/cycle1/validation-protocol.md). Opt-in,
// never a gate: the numbers depend on the machine.
//   VALIDATION_BASELINES=1 NODE_OPTIONS=--expose-gc npx vitest run src/lib/chart/validation/tests/baselines.test.ts
//   VALIDATION_BASELINES_OUT=<file> also keeps the JSON.

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

function scriptedBook(t0: number) {
  const walls = Array.from({ length: 20 }, (_, index) =>
    wallLifecycle({ id: index + 1, side: index % 2 === 0 ? "bid" : "ask", row: 60_000 + (index % 2 === 0 ? -1 : 1) * (5 + index), size: 200 + index * 10, startTs: t0 + index * 30_000, shrinkTs: t0 + index * 30_000 + 10_000, endTs: index % 3 === 0 ? t0 + index * 30_000 + 25_000 : undefined, endedBy: "pulled" }),
  );
  const events = walls.flatMap((wall) => wall.events);
  for (let index = 0; index < 2_000; index += 1) events.push(tradeEvent(t0 + index * 1_000, index % 2 === 0 ? "buy" : "sell", 60_000 + (index % 7), 0.5));
  events.sort((a, b) => a.ts - b.ts);
  return fakeL2({ lastTs: t0 + 2_000_000, ladder: ladderOf(60_000, 500, 0.5, 1.5), walls: walls.map((wall) => wall.wall), events });
}

interface Subject {
  def: RuntimeIndicatorDef<unknown, unknown>;
  settings: unknown;
  extras?: LiveExtras;
}

describe.runIf(process.env.VALIDATION_BASELINES === "1")("performance baselines (protocol check 6)", () => {
  it("measures rsi, bollinger, cvd-divergence and l2-feed-status", () => {
    const { bars } = trendBars({ count: MAX_RETAINED_SOURCE_BARS, driftPerBar: 0.5, noise: 25 });
    const subjects: Subject[] = [
      { def: rsiIndicator as RuntimeIndicatorDef<unknown, unknown>, settings: rsiIndicator.defaultSettings },
      { def: bollingerIndicator as RuntimeIndicatorDef<unknown, unknown>, settings: bollingerIndicator.defaultSettings },
      { def: cvdDivergenceIndicator as RuntimeIndicatorDef<unknown, unknown>, settings: cvdDivergenceIndicator.defaultSettings },
      { def: l2FeedStatusIndicator as RuntimeIndicatorDef<unknown, unknown>, settings: {}, extras: { l2: scriptedBook(bars[0].ts_open) } },
    ];
    const rows = [];
    const lines: string[] = [];
    for (const { def, settings, extras } of subjects) {
      const replay = probeReplay(def, bars, settings, extras);
      const forming = probeFormingBar(def, bars.slice(-200), settings, { seconds: 60, revisionsPerSecond: 50, printsPerMinute: 1_000, extras });
      const rollover = probeRollover(def, bars, settings, { extraBars: 1_000, extras });
      lines.push(formatReplayProbe(replay), formatFormingBarProbe(forming), formatRolloverProbe(rollover));
      rows.push({ id: def.id, replay, forming, rollover });
      resetDrawRegistryForTests();
    }
    console.log(lines.join("\n"));
    if (process.env.VALIDATION_BASELINES_OUT) {
      writeFileSync(process.env.VALIDATION_BASELINES_OUT, `${JSON.stringify({ bars: MAX_RETAINED_SOURCE_BARS, node: process.version, rows }, null, 2)}\n`);
    }
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.replay.faulted).toBe(false);
      expect(row.forming.faulted).toBe(false);
      expect(row.rollover.faulted).toBe(false);
    }
  }, 600_000);
});
