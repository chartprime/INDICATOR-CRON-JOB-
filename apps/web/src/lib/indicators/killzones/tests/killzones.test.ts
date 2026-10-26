import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import {
  KILLZONE_SESSIONS,
  buildKillzoneOccurrences,
  isInSession,
  nyLocalDateKey,
  nyLocalMinuteOfDay,
  type KillzoneSessionDef,
  type NyPartsCache,
} from "../killzones";

const INTERVAL_MS = 60_000;

// All fixtures land in January (EST, UTC-5, no DST) so the expected NY time
// can be computed by plain arithmetic without depending on the function
// under test to also get DST right -- DST correctness itself is covered by
// a dedicated summer-vs-winter comparison test below.
function nyTimeUtcMs(day: number, hh: number, mm: number): number {
  return Date.UTC(2026, 0, day, hh + 5, mm);
}

function bar(ts_open: number, high: number, low: number): BarFrame {
  return {
    type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT", interval_ms: INTERVAL_MS, ts_open,
    open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 1, trade_count: 1, closed: true,
  };
}

const NYAM: KillzoneSessionDef = KILLZONE_SESSIONS.find((s) => s.id === "nyam")!;
const ASIA: KillzoneSessionDef = KILLZONE_SESSIONS.find((s) => s.id === "asia")!;

describe("KILLZONE_SESSIONS", () => {
  it("has exactly the six documented sessions with the documented default-shown state", () => {
    expect(KILLZONE_SESSIONS.map((s) => [s.id, s.defaultShown])).toEqual([
      ["asia", true],
      ["london", true],
      ["nyam", true],
      ["nylunch", false],
      ["nypm", true],
      ["rth", false],
    ]);
  });
});

describe("nyLocalMinuteOfDay / nyLocalDateKey", () => {
  it("converts a winter (EST, UTC-5) instant correctly", () => {
    const ms = Date.UTC(2026, 0, 15, 12, 0); // 2026-01-15T12:00:00Z -> 07:00 NY
    expect(nyLocalMinuteOfDay(ms)).toBe(7 * 60);
    expect(nyLocalDateKey(ms)).toBe("2026-01-15");
  });

  it("converts a summer (EDT, UTC-4) instant correctly -- a different fixed offset than winter", () => {
    const ms = Date.UTC(2026, 6, 15, 12, 0); // 2026-07-15T12:00:00Z -> 08:00 NY
    expect(nyLocalMinuteOfDay(ms)).toBe(8 * 60);
    expect(nyLocalDateKey(ms)).toBe("2026-07-15");
  });

  it("rolls back to the previous NY calendar day when UTC is already past midnight NY", () => {
    const ms = Date.UTC(2026, 0, 15, 3, 0); // 2026-01-15T03:00:00Z -> 2026-01-14T22:00 NY
    expect(nyLocalDateKey(ms)).toBe("2026-01-14");
    expect(nyLocalMinuteOfDay(ms)).toBe(22 * 60);
  });

  it("crosses the real 2026 US spring-forward transition correctly -- 01:59 jumps straight to 03:00, not a fabricated fixed-offset difference", () => {
    // Verified directly against the platform's own Intl tzdata: 2026-03-08
    // 06:59 UTC is the last EST minute (01:59 NY); 07:00 UTC is the first
    // EDT minute, and NY local jumps straight to 03:00 -- the 02:00-02:59
    // wall-clock hour never happens that day.
    const beforeMs = Date.UTC(2026, 2, 8, 6, 59);
    const afterMs = Date.UTC(2026, 2, 8, 7, 0);
    expect(nyLocalMinuteOfDay(beforeMs)).toBe(1 * 60 + 59);
    expect(nyLocalMinuteOfDay(afterMs)).toBe(3 * 60);
    expect(nyLocalDateKey(beforeMs)).toBe("2026-03-08");
    expect(nyLocalDateKey(afterMs)).toBe("2026-03-08");
  });
});

describe("isInSession", () => {
  it("normal (non-wrapping) window: start inclusive, end exclusive", () => {
    expect(isInSession(570, 570, 660)).toBe(true); // exactly 09:30
    expect(isInSession(659, 570, 660)).toBe(true); // 10:59
    expect(isInSession(660, 570, 660)).toBe(false); // exactly 11:00 -- excluded
    expect(isInSession(569, 570, 660)).toBe(false); // 09:29
  });

  it("wrapping window (start > end): true on both sides of midnight", () => {
    // Asia: 20:00-00:00 -> startMin=1200, endMin=0
    expect(isInSession(1200, 1200, 0)).toBe(true); // exactly 20:00
    expect(isInSession(1439, 1200, 0)).toBe(true); // 23:59
    expect(isInSession(0, 1200, 0)).toBe(false); // exactly 00:00 -- the session ends here, excluded
    expect(isInSession(600, 1200, 0)).toBe(false); // 10:00, outside
  });

  it("a general wraparound window (not ending at exactly midnight) covers both sides correctly", () => {
    // 22:00-02:00 -> startMin=1320, endMin=120
    expect(isInSession(1320, 1320, 120)).toBe(true);
    expect(isInSession(60, 1320, 120)).toBe(true); // 01:00, past midnight
    expect(isInSession(120, 1320, 120)).toBe(false); // exactly 02:00 -- excluded
    expect(isInSession(700, 1320, 120)).toBe(false); // mid-afternoon, outside
  });

  it("a zero-length window (start === end) is never in session", () => {
    expect(isInSession(500, 500, 500)).toBe(false);
  });
});

describe("buildKillzoneOccurrences", () => {
  it("groups genuinely contiguous in-session bars into one occurrence with the running high/low", () => {
    const bars = [
      bar(nyTimeUtcMs(15, 9, 30), 100, 95),
      bar(nyTimeUtcMs(15, 9, 31), 105, 98),
      bar(nyTimeUtcMs(15, 9, 32), 102, 90),
    ];
    const occurrences = buildKillzoneOccurrences(bars, NYAM, 3);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      startMs: nyTimeUtcMs(15, 9, 30),
      boxEndMs: nyTimeUtcMs(15, 9, 32),
      high: 105,
      low: 90,
    });
  });

  it("a session with missing bars is still ONE occurrence -- futures print gaps inside quiet sessions", () => {
    // Measured 2026-09-02: /ES Asia averages 6 contiguous runs per NY day on a
    // 1-minute chart, /NQ London 4 (max 7). Treating each run as its own
    // occurrence drew up to seven boxes and labels for a single session, and
    // filled the 3-occurrence budget with fragments of one day.
    const bars = [
      bar(nyTimeUtcMs(15, 9, 30), 100, 95),
      bar(nyTimeUtcMs(15, 9, 31), 105, 98),
      bar(nyTimeUtcMs(15, 9, 34), 102, 90),
    ];
    const occurrences = buildKillzoneOccurrences(bars, NYAM, 3);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      startMs: nyTimeUtcMs(15, 9, 30),
      boxEndMs: nyTimeUtcMs(15, 9, 34),
      high: 105,
      low: 90,
    });
  });

  it("the occurrence budget counts session-days, not fragments, so history is not crowded out", () => {
    const bars = [
      bar(nyTimeUtcMs(13, 9, 30), 10, 5), bar(nyTimeUtcMs(13, 9, 40), 11, 4),
      bar(nyTimeUtcMs(14, 9, 30), 20, 15), bar(nyTimeUtcMs(14, 9, 45), 21, 14),
      bar(nyTimeUtcMs(15, 9, 30), 30, 25), bar(nyTimeUtcMs(15, 9, 50), 31, 24),
    ];
    const occurrences = buildKillzoneOccurrences(bars, NYAM, 3);
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((o) => o.high)).toEqual([11, 21, 31]);
  });

  it("bars outside the session window do not start or extend an occurrence", () => {
    const bars = [bar(nyTimeUtcMs(15, 8, 0), 100, 95), bar(nyTimeUtcMs(15, 12, 0), 100, 95)];
    expect(buildKillzoneOccurrences(bars, NYAM, 3)).toEqual([]);
  });

  it("a gap outside the session starts a fresh occurrence on re-entry, not a continuation", () => {
    const bars = [
      bar(nyTimeUtcMs(15, 9, 30), 100, 95),
      bar(nyTimeUtcMs(16, 9, 30), 200, 190), // next day's NYAM, unrelated range
    ];
    const occurrences = buildKillzoneOccurrences(bars, NYAM, 3);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].high).toBe(100);
    expect(occurrences[1].high).toBe(200);
  });

  it("caps the occurrence count at maxOccurrences, dropping the oldest", () => {
    const bars = [
      bar(nyTimeUtcMs(13, 9, 30), 100, 95),
      bar(nyTimeUtcMs(14, 9, 30), 200, 195),
      bar(nyTimeUtcMs(15, 9, 30), 300, 295),
    ];
    const occurrences = buildKillzoneOccurrences(bars, NYAM, 2);
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map((o) => o.high)).toEqual([200, 300]);
  });

  it("the pivot lines extend through bars after the session closes until the data ends", () => {
    const bars = [
      bar(nyTimeUtcMs(15, 9, 30), 100, 95), // session bar: high=100, low=95
      bar(nyTimeUtcMs(15, 11, 30), 99, 96), // after session, doesn't break either side
      bar(nyTimeUtcMs(15, 12, 30), 98, 97), // still doesn't break
    ];
    const [occurrence] = buildKillzoneOccurrences(bars, NYAM, 3);
    expect(occurrence.highBroken).toBe(false);
    expect(occurrence.lowBroken).toBe(false);
    expect(occurrence.highLineEndMs).toBe(nyTimeUtcMs(15, 12, 30));
    expect(occurrence.lowLineEndMs).toBe(nyTimeUtcMs(15, 12, 30));
  });

  it("a pivot line stops extending exactly where price trades through it", () => {
    const bars = [
      bar(nyTimeUtcMs(15, 9, 30), 100, 95), // session: high=100, low=95
      bar(nyTimeUtcMs(15, 11, 30), 99, 96), // still holding
      bar(nyTimeUtcMs(15, 12, 30), 101, 96), // breaks the high (101 > 100)
      bar(nyTimeUtcMs(15, 13, 30), 103, 90), // breaks the low too (90 < 95); high already broken, shouldn't move further
    ];
    const [occurrence] = buildKillzoneOccurrences(bars, NYAM, 3);
    expect(occurrence.highBroken).toBe(true);
    expect(occurrence.highLineEndMs).toBe(nyTimeUtcMs(15, 12, 30));
    expect(occurrence.lowBroken).toBe(true);
    expect(occurrence.lowLineEndMs).toBe(nyTimeUtcMs(15, 13, 30));
  });

  it("an older occurrence's unbroken pivot line freezes at the last bar seen before the next occurrence supersedes it", () => {
    const bars = [
      bar(nyTimeUtcMs(14, 9, 30), 100, 95), // occurrence 1: high=100, low=95, never broken
      bar(nyTimeUtcMs(14, 11, 30), 99, 96), // exits session (NYAM ends 11:00)
      bar(nyTimeUtcMs(14, 11, 31), 99, 96), // holds, one minute later -- last bar before supersession
      bar(nyTimeUtcMs(15, 9, 30), 100, 95), // occurrence 2 begins -- occurrence 1's lines must stop before this
    ];
    const occurrences = buildKillzoneOccurrences(bars, NYAM, 3);
    expect(occurrences).toHaveLength(2);
    const [first] = occurrences;
    expect(first.highBroken).toBe(false);
    expect(first.lowBroken).toBe(false);
    expect(first.highLineEndMs).toBe(nyTimeUtcMs(14, 11, 31));
    expect(first.lowLineEndMs).toBe(nyTimeUtcMs(14, 11, 31));
  });

  it("empty bars produce no occurrences", () => {
    expect(buildKillzoneOccurrences([], NYAM, 3)).toEqual([]);
  });

  it("a shared NyPartsCache avoids re-converting the same bar's timestamp across multiple sessions, without changing the result", () => {
    const bars = [bar(nyTimeUtcMs(15, 9, 30), 100, 95), bar(nyTimeUtcMs(15, 9, 31), 105, 92)];
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    spy.mockClear();

    const cache: NyPartsCache = new Map();
    const uncached = buildKillzoneOccurrences(bars, NYAM, 3);
    const cachedFirstCall = buildKillzoneOccurrences(bars, NYAM, 3, cache);
    const callsAfterFirstSession = spy.mock.calls.length;
    expect(callsAfterFirstSession).toBeGreaterThan(0);

    const cachedSecondCall = buildKillzoneOccurrences(bars, NYAM, 3, cache);
    expect(spy.mock.calls.length).toBe(callsAfterFirstSession); // no new conversions -- every bar was already cached

    // The whole point of caching is that it must never change the answer --
    // assert on the actual returned occurrences, not just call counts, so a
    // caching bug that returns a wrong-but-consistent value (e.g. an off-by-
    // one on the cache key) can't hide behind a passing call-count check.
    expect(cachedSecondCall).toEqual(cachedFirstCall);
    expect(cachedSecondCall).toEqual(uncached);

    spy.mockRestore();
  });

  it("without a cache, each call re-converts every bar's timestamp independently", () => {
    const bars = [bar(nyTimeUtcMs(15, 9, 30), 100, 95)];
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    spy.mockClear();

    buildKillzoneOccurrences(bars, NYAM, 3);
    buildKillzoneOccurrences(bars, NYAM, 3);
    expect(spy.mock.calls.length).toBe(bars.length * 2);

    spy.mockRestore();
  });

  it("Asia's window is entirely same-day (20:00-23:59) -- its own endMin:0 never actually admits a post-midnight bar", () => {
    // Asia is defined as startMin:1200, endMin:0. In isInSession's wraparound
    // formula (minuteOfDay >= startMin || minuteOfDay < endMin), a zero
    // endMin makes the "< endMin" side impossible to satisfy (minuteOfDay is
    // never negative), so this session never actually wraps in practice --
    // it behaves as a plain same-day window ending at midnight. This test
    // proves same-day bars up to 23:59 merge into one occurrence; it does
    // NOT exercise the wraparound continuity path itself -- see the next
    // test for that.
    const bars = [
      bar(nyTimeUtcMs(15, 20, 0), 100, 95), // 20:00 NY, day 15
      bar(nyTimeUtcMs(15, 20, 1), 105, 90), // 20:01 NY, still day 15
      bar(nyTimeUtcMs(15, 20, 2), 108, 88), // 20:02 NY, still day 15
    ];
    const occurrences = buildKillzoneOccurrences(bars, ASIA, 3);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ high: 108, low: 88 });
  });

  it("keeps a genuinely overnight session continuous across the New York date boundary", () => {
    const overnightSession: KillzoneSessionDef = {
      id: "asia", label: "Overnight", startMin: 22 * 60, endMin: 60, defaultShown: true,
      boxColor: "rgba(0,0,0,0.1)", lineColor: "#000000",
    };
    const bars = [
      bar(nyTimeUtcMs(16, 0, 0) - 2 * 60_000, 100, 95), // 23:58 NY, day 15
      bar(nyTimeUtcMs(16, 0, 0) - 60_000, 105, 90), // 23:59 NY, day 15 -- still in session
      bar(nyTimeUtcMs(16, 0, 0), 108, 88), // 00:00 NY, day 16 -- still in session, but a new NY date-key
    ];
    const occurrences = buildKillzoneOccurrences(bars, overnightSession, 3);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ high: 108, low: 88 });
  });

  it("rejects invalid controls and unordered bars instead of rendering ambiguous sessions", () => {
    expect(() => buildKillzoneOccurrences([], NYAM, 0)).toThrow(/maxOccurrences/);
    expect(() => buildKillzoneOccurrences([
      bar(nyTimeUtcMs(15, 10, 0), 100, 95),
      bar(nyTimeUtcMs(15, 9, 30), 100, 95),
    ], NYAM, 3)).toThrow(/chronological/);
  });
});
