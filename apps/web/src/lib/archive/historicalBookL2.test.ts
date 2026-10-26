import { describe, expect, it } from "vitest";
import { historicalBookL2 } from "./historicalBookL2";
import type { HistoricalBookSecond } from "./historicalL2States";
import { statusRows } from "../indicators/l2-feed-status/l2FeedStatus";

function second(knownMs: number, lo = 400, trusted = true): HistoricalBookSecond {
  return { openNs: String(BigInt(knownMs - 1000) * 1000000n), closeNs: String(BigInt(knownMs) * 1000000n),
    knownNs: String(BigInt(knownMs) * 1000000n), knownKey: null, segmentId: trusted ? "a".repeat(64) : null,
    complete: true, trusted, reason: trusted ? "OBSERVED_PREFIX" : "SOURCE_GAP",
    flow: { BUY: 0, SELL: 0, UNKNOWN: 0, count: 0 },
    column: trusted ? { ts: knownMs - 1000, lo, hi: lo, bid: new Float64Array([5]), ask: new Float64Array([NaN]), buy: [], sell: [] } : null };
}

describe("historical book SDK view", () => {
  it("reports selected-time archive trust without live age, future columns, or invented wall/event/ladder availability", () => {
    const source = historicalBookL2([second(1000), second(2000, 400, false), second(4000, 800)], 0.25, 1);
    const rowsAt = (time: number) => Object.fromEntries(statusRows(source.atTime!(time), time).map((row) => [row.label, row]));
    const first = rowsAt(1000);
    expect(first["Book trusted at chart time"]).toMatchObject({ value: "yes", tone: "good" });
    expect(first["Trusted columns held"].value).toBe("1");
    expect(first["Last recorded second (UTC)"].value).toBe("1970-01-01T00:00:00.000Z");
    for (const label of ["Walls", "Events", "Ladder"]) expect(first[label].value).toBe("not supplied");
    expect(JSON.stringify(first)).not.toContain("ago");
    expect(rowsAt(2000)["Book trusted at chart time"].value).toBe("no");
    expect(rowsAt(3500)["Book trusted at chart time"].value).toBe("no");
    expect(rowsAt(4000)["Trusted columns held"].value).toBe("2");
    expect(rowsAt(6000)["Book trusted at chart time"].value).toBe("no");
    expect(rowsAt(999)["Last recorded second (UTC)"].value).toBe("none yet");
  });
  it("cuts columns AND price geometry at bar knowledge time, never increasing a previous cut", () => {
    const source = historicalBookL2([second(1000), second(2000, 800)], 0.25, 1);
    const early = source.atTime!(1000);
    expect(early.view(0)?.fine.columns).toHaveLength(1);
    expect(early.lanes()[0].priceHi).toBe(100.25);
    expect(early.atTime!(2000).view(0)?.fine.columns).toHaveLength(1);
    expect(early.trusted(1500)).toBe(false);
    expect(source.atTime!(999).status("l2_view").synced).toBe(false);
    expect(source.view(0)?.fine.columns).toHaveLength(2);
  });
  it("keeps wall/event/ladder channels unavailable and doesn't bridge a coverage gap", () => {
    const source = historicalBookL2([second(1000), second(2000, 400, false), second(4000)], 0.25, 2);
    expect(source.availability).toBe("HISTORICAL");
    expect(source.trusted(2000)).toBe(false);
    expect(source.trusted(3500)).toBe(false);
    expect(source.trusted(4000)).toBe(true);
    expect(source.trusted(6000)).toBe(false);
    expect(source.view(0)?.fine.columns.map((column) => column.ts)).toEqual([0, 3000]);
    expect(source.status("l2_walls").synced).toBe(false);
    expect(source.events().complete).toBe(false);
    expect(source.walls()).toEqual([]);
    expect(source.ladder()).toBeNull();
  });
  it("trusts a recorded second for one second only, so a stretch with no recorded seconds is not trusted", () => {
    const source = historicalBookL2([second(1000), second(4000)], 0.25, 3);
    expect(source.trusted(1000)).toBe(true);
    expect(source.trusted(1999)).toBe(true);
    expect(source.trusted(2000)).toBe(false);
    expect(source.trusted(3500)).toBe(false);
    expect(source.trusted(4000)).toBe(true);
  });
  it("rejects regressing knowledge time and invalid display geometry", () => {
    expect(() => historicalBookL2([second(2000), second(1000)], 0.25, 1)).toThrow("regresses");
    expect(() => historicalBookL2([], 1, 1)).toThrow("geometry");
  });
});
