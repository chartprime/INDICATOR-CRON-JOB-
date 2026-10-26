import { describe, expect, it } from "vitest";
import type { InitiativeBand, InitiativeBandsFrame } from "../../types/frames";
import { InitiativeBook } from "./initiativeBook";

const T = 1_790_000_000_000;

function band(i: number, over: Partial<InitiativeBand> = {}): InitiativeBand {
  return {
    id: `b${i}`, candleMs: 60000, side: "down", dominant: "sellers", dominantShare: 0.75, score: 4,
    facts: { efficiency: { yes: true, value: 0.714 }, closes: { yes: true, value: 2 }, burst: { yes: false, value: 0.8 }, delta: { yes: true, rank: 1, share: 0.75 }, prints: { yes: true, rank: 0.833, perCandle: 1 } },
    pivotTs: T + i * 60_000, pivotPrice: 108, frozenTs: T + (i + 3) * 60_000, frozenPrice: 105.5, windowCandles: 3, atr: 1,
    legExtremePrice: 105, legExtremeTs: T + (i + 3) * 60_000, legEndTs: null, updatedAt: T + (i + 4) * 60_000, origin: "runtime", ...over,
  };
}

function frame(over: Partial<InitiativeBandsFrame> = {}): InitiativeBandsFrame {
  const base: InitiativeBandsFrame = { type: "initiative_bands", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: T, seq: 0, reset: true, bands: [], liveSince: T - 3_600_000, loading: null };
  return { ...base, ...over } as InitiativeBandsFrame;
}

describe("InitiativeBook", () => {
  it("an increment before any reset is ignored; a reset replaces and syncs; later increments apply by id keeping the newest update", () => {
    const book = new InitiativeBook();
    expect(book.apply(frame({ reset: false, bands: [band(1)] }))).toBe("ignored");
    expect(book.trusted()).toBe(false);
    expect(book.apply(frame({ bands: [band(2), band(1)] }))).toBe("reset");
    expect(book.trusted()).toBe(true);
    expect(book.list().map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(book.liveSince).toBe(T - 3_600_000);
    expect(book.apply(frame({ reset: false, seq: 1, ts: T + 1, bands: [band(1, { legEndTs: T + 600_000, updatedAt: T + 600_000 })] }))).toBe("applied");
    expect(book.get("b1")?.legEndTs).toBe(T + 600_000);
    expect(book.apply(frame({ reset: false, seq: 2, ts: T + 2, bands: [band(1, { legEndTs: null, updatedAt: T + 1 })] }))).toBe("ignored");
    expect(book.get("b1")?.legEndTs).toBe(T + 600_000);
    expect([book.lastSeq, book.lastTs, book.size, book.version]).toEqual([1, T + 1, 2, 2]);
  });

  it("the list is in pivot order then id, frozen and cached until the next change", () => {
    const book = new InitiativeBook();
    book.apply(frame({ bands: [band(3, { id: "0late" }), band(1), band(2, { pivotTs: T + 60_000, id: "a" })] }));
    const list = book.list();
    expect(list.map((b) => b.id)).toEqual(["a", "b1", "0late"]);
    expect(Object.isFrozen(list)).toBe(true);
    expect(book.list()).toBe(list);
    book.apply(frame({ reset: false, seq: 1, bands: [band(4)] }));
    expect(book.list()).not.toBe(list);
  });

  it("loading follows the frames: a reset or an increment sets it, an increment that changes nothing but loading still counts as applied, clear forgets it", () => {
    const book = new InitiativeBook();
    expect(book.loading).toBeNull();
    expect(book.apply(frame({ bands: [band(1)], loading: T - 86_400_000 }))).toBe("reset");
    expect(book.loading).toBe(T - 86_400_000);
    expect(book.apply(frame({ reset: false, seq: 1, ts: T + 1, bands: [band(1, { updatedAt: T - 1 })], loading: T - 86_400_000 }))).toBe("ignored");
    expect(book.version).toBe(1);
    expect(book.apply(frame({ reset: false, seq: 2, ts: T + 2, bands: [band(1, { updatedAt: T - 1 })], loading: null }))).toBe("applied");
    expect([book.loading, book.lastSeq, book.lastTs, book.version]).toEqual([null, 2, T + 2, 2]);
    book.apply(frame({ seq: 3, ts: T + 3, bands: [], loading: T - 3 * 86_400_000 }));
    book.clear();
    expect(book.loading).toBeNull();
  });

  it("a band frozen more than a week before the frame's clock is dropped, from the frame and from the book, and the drop alone counts as applied", () => {
    const WEEK = 7 * 86_400_000;
    const frozen1 = band(1).frozenTs;
    const book = new InitiativeBook();
    expect(book.apply(frame({ ts: frozen1 + WEEK + 1, bands: [band(1), band(2, { frozenTs: frozen1 + WEEK })] }))).toBe("reset");
    expect(book.list().map((b) => b.id)).toEqual(["b2"]);
    expect(book.get("b1")).toBeUndefined();
    const book2 = new InitiativeBook();
    book2.apply(frame({ bands: [band(1), band(2)] }));
    expect(book2.apply(frame({ reset: false, seq: 1, ts: band(2).frozenTs + WEEK + 1, bands: [] }))).toBe("applied");
    expect(book2.list().map((b) => b.id)).toEqual([]);
    expect([book2.size, book2.version]).toEqual([0, 2]);
    const book3 = new InitiativeBook();
    book3.apply(frame({ bands: [band(1), band(2)] }));
    expect(book3.apply(frame({ reset: false, seq: 1, ts: frozen1 + WEEK, bands: [] }))).toBe("ignored");
    expect(book3.list().map((b) => b.id)).toEqual(["b1", "b2"]);
  });

  it("markUntrusted keeps the bands but flags the book until the next reset; clear empties it", () => {
    const book = new InitiativeBook();
    book.apply(frame({ bands: [band(1)] }));
    book.markUntrusted();
    expect(book.trusted()).toBe(false);
    expect(book.size).toBe(1);
    const version = book.version;
    book.markUntrusted();
    expect(book.version).toBe(version);
    book.apply(frame({ seq: 3, bands: [band(2)] }));
    expect(book.trusted()).toBe(true);
    expect(book.list().map((b) => b.id)).toEqual(["b2"]);
    book.clear();
    expect([book.size, book.trusted(), book.liveSince, book.lastSeq, book.lastTs]).toEqual([0, false, null, -1, 0]);
  });
});
