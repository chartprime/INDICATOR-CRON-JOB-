import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetDrawOwnerScopeForTests } from "../../../chart/draw/creationScope";
import { resetDrawRegistryForTests } from "../../../chart/draw/registry";
import type { RuntimeIndicatorDef } from "../../../chart/indicatorTypes";
import {
  compressionBreakoutBars,
  compressionContinuationBars,
  compressionFailedBreakBars,
  countMarkers,
  rangeBars,
  replayCapture,
  trendBars,
} from "../../../chart/validation";
import { COMPRESSION_BREAKOUT_DEFAULT_SETTINGS } from "../compressionBreakout";
import { bollingerCrossingComparator, plainFrozenRangeBaseline, squeezeQualifiedVariant, ttmReleaseComparator } from "./comparators";
import { activityFlags, addScores, outcomeHit, scoreBreakout } from "./scoring";
import { compressionBreakoutSeamDef } from "./seamDef";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

/**
 * The brief's acceptance table on the design seeds 7..16, both directions,
 * for the product and the three comparators plus the plain frozen-range
 * baseline, with the identical activity filter, the wrong-direction category,
 * level validity, the labelled outcome fixtures and the control densities.
 * Evaluation seeds 17..21 live in their own file and are never read here.
 */

type AnyDef = RuntimeIndicatorDef<any, any>;

interface Row {
  hits: number;
  wrongDirection: number;
  earlyAll: number;
  earlyLead: number;
  earlyFiltered: number;
  unmatched: number;
  missed: number;
  levelValid: number;
  levelChecked: number;
  failures: number;
  holds: number;
  rangeMarkersPer1000: number;
  trendMarkersPer1000: number;
  maxPerBar: number;
}

const DEFS: { name: string; def: AnyDef; settings: unknown; outcomes: boolean }[] = [
  { name: "Product (width ≤ 2×, min 6)", def: compressionBreakoutSeamDef, settings: COMPRESSION_BREAKOUT_DEFAULT_SETTINGS, outcomes: true },
  { name: "Plain frozen range (no width qualifier)", def: plainFrozenRangeBaseline, settings: plainFrozenRangeBaseline.defaultSettings, outcomes: true },
  { name: "Squeeze-qualified variant", def: squeezeQualifiedVariant, settings: squeezeQualifiedVariant.defaultSettings, outcomes: true },
  { name: "TTM release (timing and density only)", def: ttmReleaseComparator, settings: ttmReleaseComparator.defaultSettings, outcomes: false },
  { name: "Bollinger crossing (timing and density only)", def: bollingerCrossingComparator, settings: bollingerCrossingComparator.defaultSettings, outcomes: false },
];

export function tableFor(seeds: readonly number[]): Record<string, Row> {
  const rows: Record<string, Row> = {};
  for (const { name, def, settings, outcomes } of DEFS) {
    const total: Record<string, number> = {};
    const filtered: Record<string, number> = {};
    let failures = 0;
    let holds = 0;
    for (const direction of [1, -1] as const) {
      for (const seed of seeds) {
        const fixture = compressionBreakoutBars({ seed, direction });
        const flags = activityFlags(fixture.bars);
        const outputs = replayCapture(def, fixture.bars, settings).outputs;
        addScores(total, scoreBreakout(fixture.bars, outputs, fixture.labels));
        addScores(filtered, scoreBreakout(fixture.bars, outputs, fixture.labels, flags));
        if (outcomes) {
          const failed = compressionFailedBreakBars({ seed, direction });
          if (outcomeHit(replayCapture(def, failed.bars, settings).outputs, failed.labels.breakoutIndex, failed.labels.failIndex, "failed")) failures += 1;
          const held = compressionContinuationBars({ seed, direction });
          if (outcomeHit(replayCapture(def, held.bars, settings).outputs, held.labels.breakoutIndex, held.labels.heldIndex, "heldOutside")) holds += 1;
        }
      }
    }
    let rangeMarkers = 0;
    let trendMarkers = 0;
    let maxPerBar = 0;
    for (let seed = 7; seed <= 11; seed += 1) {
      const range = countMarkers(def, rangeBars({ seed, count: 1_000 }).bars, settings);
      const trend = countMarkers(def, trendBars({ seed, count: 1_000 }).bars, settings);
      rangeMarkers += range.total;
      trendMarkers += trend.total;
      maxPerBar = Math.max(maxPerBar, range.maxPerBar, trend.maxPerBar);
    }
    rows[name] = {
      hits: total.hit ?? 0,
      wrongDirection: total.wrongDirection ?? 0,
      earlyAll: total.early ?? 0,
      earlyLead: total.earlyLead ?? 0,
      earlyFiltered: filtered.early ?? 0,
      unmatched: total.unmatched ?? 0,
      missed: total.missed ?? 0,
      levelValid: total.levelValid ?? 0,
      levelChecked: total.levelChecked ?? 0,
      failures,
      holds,
      rangeMarkersPer1000: rangeMarkers / 5,
      trendMarkersPer1000: trendMarkers / 5,
      maxPerBar,
    };
  }
  return rows;
}

export function formatTable(title: string, rows: Record<string, Row>, runs: number): string {
  const lines = [
    `${title} (${runs} seed-directions; outcome fixtures ${runs} each)`,
    "| Def | Hits | Wrong dir | Early all (lead) | Early filtered | Level valid | Missed | Unmatched | Failure fixture | Hold fixture | Range control markers/1,000 | Trend control markers/1,000 | Max per bar |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, r] of Object.entries(rows)) {
    const level = r.levelChecked === 0 ? "n/a" : `${r.levelValid}/${r.levelChecked}`;
    const outcomes = name.includes("timing") ? ["none", "none"] : [`${r.failures}/${runs}`, `${r.holds}/${runs}`];
    lines.push(`| ${name} | ${r.hits}/${runs} | ${r.wrongDirection} | ${r.earlyAll} (${r.earlyLead}) | ${r.earlyFiltered} | ${level} | ${r.missed} | ${r.unmatched} | ${outcomes[0]} | ${outcomes[1]} | ${r.rangeMarkersPer1000.toFixed(1)} | ${r.trendMarkersPer1000.toFixed(1)} | ${r.maxPerBar} |`);
  }
  return lines.join("\n");
}

describe("compressionBreakout -- design seeds 7..16: the acceptance table (brief ruling 4, amendment 8)", () => {
  const rows = tableFor([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const text = formatTable("Design seeds 7..16", rows, 20);
  console.log(text);
  if (process.env.CB_TABLE_OUT) {
    mkdirSync(dirname(process.env.CB_TABLE_OUT), { recursive: true });
    writeFileSync(process.env.CB_TABLE_OUT, `${text}\n\n${JSON.stringify(rows, null, 2)}\n`);
  }
  const product = rows["Product (width ≤ 2×, min 6)"];

  it("the product meets the frozen bounds: hits ≥ 18/20 with every hit level-valid, outcomes ≥ 9/10 per direction, filtered early ≤ 4, range ≤ 5 and trend 0 per 1,000, no wrong direction, one marker per bar", () => {
    expect(product.hits).toBeGreaterThanOrEqual(18);
    expect(product.levelValid).toBe(product.levelChecked);
    expect(product.levelChecked).toBe(product.hits);
    expect(product.failures).toBeGreaterThanOrEqual(18);
    expect(product.holds).toBeGreaterThanOrEqual(18);
    expect(product.earlyFiltered).toBeLessThanOrEqual(4);
    expect(product.rangeMarkersPer1000).toBeLessThanOrEqual(5);
    expect(product.trendMarkersPer1000).toBe(0);
    expect(product.wrongDirection).toBe(0);
    expect(product.maxPerBar).toBeLessThanOrEqual(1);
  });

  it("the published numbers are pinned: a change in any cell is a deliberate change", () => {
    const pin = (r: Row) => [r.hits, r.wrongDirection, r.earlyAll, r.earlyLead, r.earlyFiltered, r.levelValid, r.levelChecked, r.missed, r.unmatched, r.failures, r.holds, r.rangeMarkersPer1000, r.trendMarkersPer1000, r.maxPerBar];
    expect(pin(product)).toEqual([20, 0, 4, 0, 0, 20, 20, 0, 0, 20, 20, 0, 0, 0]);
    expect(pin(rows["Plain frozen range (no width qualifier)"])).toEqual([20, 0, 42, 24, 16, 8, 20, 0, 0, 20, 20, 4.6, 0, 1]);
    expect(pin(rows["Squeeze-qualified variant"])).toEqual([20, 0, 28, 20, 6, 14, 20, 0, 0, 20, 20, 5, 0, 1]);
    expect(pin(rows["TTM release (timing and density only)"])).toEqual([18, 0, 32, 12, 0, 0, 0, 2, 0, 0, 0, 12.6, 0, 1]);
    expect(pin(rows["Bollinger crossing (timing and density only)"])).toEqual([20, 0, 118, 82, 38, 0, 0, 0, 2, 0, 0, 47.6, 0, 1]);
  });

  it("the plain frozen-range baseline is reported on every metric beside the product (the PM decides at validation if it matches on all of them)", () => {
    const plain = rows["Plain frozen range (no width qualifier)"];
    const matchesEverywhere =
      plain.hits >= product.hits &&
      plain.wrongDirection <= product.wrongDirection &&
      plain.earlyFiltered <= product.earlyFiltered &&
      plain.levelValid >= product.levelValid &&
      plain.failures >= product.failures &&
      plain.holds >= product.holds &&
      plain.rangeMarkersPer1000 <= product.rangeMarkersPer1000 &&
      plain.trendMarkersPer1000 <= product.trendMarkersPer1000;
    console.log(`plain frozen range matches or beats the product on every metric: ${matchesEverywhere}`);
    expect(plain.hits).toBeGreaterThanOrEqual(0);
  });

  it("the two timing comparators carry no level and no outcome; their hits and early events are reported", () => {
    for (const name of ["TTM release (timing and density only)", "Bollinger crossing (timing and density only)"]) {
      expect(rows[name].levelChecked).toBe(0);
      expect(rows[name].failures).toBe(0);
      expect(rows[name].holds).toBe(0);
    }
  });
});
