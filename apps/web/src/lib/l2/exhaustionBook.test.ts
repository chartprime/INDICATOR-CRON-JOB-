import { describe, expect, it } from "vitest";
import type { ExhaustionShade, ExhaustionShadesFrame } from "../../types/frames";
import { ExhaustionBook } from "./exhaustionBook";

const T = 1_790_000_000_000;

function shade(i: number, over: Partial<ExhaustionShade> = {}): ExhaustionShade {
  return {
    id: `s${i}`, candleMs: 60000, side: "buyers", status: "open", intensity: 1, score: 3, readings: { rate: true, progress: false, delta: true, divergence: false, prints: true, book: false }, values: { rate: 0.211, progress: 0, delta: -0.4, divergence: -1.4, prints: null, book: 0.5 },
    raw: { own: 3, other: 7, legOwn: 14.222, moved: 0, legMoved: 1.778, big: 0, legBig: 0, extremeOwn: 20, extremeOther: 0, bookNow: 1, bookAt: 2, bookBand: 0 },
    startTs: T + i * 60_000, endTs: T + (i + 1) * 60_000, extremeTs: T - 60_000, extremePrice: 104, legStartTs: T - 600_000, legStartPrice: 101,
    legSize: 3, efficiency: 1, atr: 1, judgedAt: null, updatedAt: T + (i + 1) * 60_000, origin: "runtime", ...over,
  };
}

function frame(over: Partial<ExhaustionShadesFrame> = {}): ExhaustionShadesFrame {
  const base: ExhaustionShadesFrame = { type: "exhaustion_shades", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", ts: T, seq: 0, reset: true, shades: [], liveSince: T - 3_600_000, loading: null };
  return { ...base, ...over } as ExhaustionShadesFrame;
}

describe("ExhaustionBook", () => {
  it("an increment before any reset is ignored; a reset replaces and syncs; later increments apply by id keeping the newest update", () => {
    const book = new ExhaustionBook();
    expect(book.apply(frame({ reset: false, shades: [shade(1)] }))).toBe("ignored");
    expect(book.trusted()).toBe(false);
    expect(book.apply(frame({ shades: [shade(2), shade(1)] }))).toBe("reset");
    expect(book.trusted()).toBe(true);
    expect(book.list().map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(book.liveSince).toBe(T - 3_600_000);
    expect(book.apply(frame({ reset: false, seq: 1, ts: T + 1, shades: [shade(1, { status: "held", judgedAt: T + 300_000, updatedAt: T + 300_000 })] }))).toBe("applied");
    expect(book.get("s1")?.status).toBe("held");
    expect(book.apply(frame({ reset: false, seq: 2, ts: T + 2, shades: [shade(1, { status: "open", updatedAt: T + 1 })] }))).toBe("ignored");
    expect(book.get("s1")?.status).toBe("held");
    expect([book.lastSeq, book.lastTs, book.size, book.version]).toEqual([1, T + 1, 2, 2]);
  });

  it("the list is in start order then id, frozen and cached until the next change", () => {
    const book = new ExhaustionBook();
    book.apply(frame({ shades: [shade(3), shade(1), shade(2, { startTs: T + 60_000, id: "a" })] }));
    const list = book.list();
    expect(list.map((s) => s.id)).toEqual(["a", "s1", "s3"]);
    expect(Object.isFrozen(list)).toBe(true);
    expect(book.list()).toBe(list);
    book.apply(frame({ reset: false, seq: 1, shades: [shade(4)] }));
    expect(book.list()).not.toBe(list);
  });

  it("loading follows the frames: a reset or an increment sets it, an increment that changes nothing but loading still counts as applied, clear forgets it", () => {
    const book = new ExhaustionBook();
    expect(book.loading).toBeNull();
    expect(book.apply(frame({ shades: [shade(1)], loading: T - 86_400_000 }))).toBe("reset");
    expect(book.loading).toBe(T - 86_400_000);
    expect(book.apply(frame({ reset: false, seq: 1, ts: T + 1, shades: [shade(1, { updatedAt: T - 1 })], loading: T - 86_400_000 }))).toBe("ignored");
    expect(book.version).toBe(1);
    expect(book.apply(frame({ reset: false, seq: 2, ts: T + 2, shades: [shade(1, { updatedAt: T - 1 })], loading: null }))).toBe("applied");
    expect([book.loading, book.lastSeq, book.lastTs, book.version]).toEqual([null, 2, T + 2, 2]);
    book.apply(frame({ seq: 3, ts: T + 3, shades: [], loading: T - 3 * 86_400_000 }));
    book.clear();
    expect(book.loading).toBeNull();
  });

  it("markUntrusted keeps the shades but flags the book until the next reset; clear empties it", () => {
    const book = new ExhaustionBook();
    book.apply(frame({ shades: [shade(1)] }));
    book.markUntrusted();
    expect(book.trusted()).toBe(false);
    expect(book.size).toBe(1);
    const version = book.version;
    book.markUntrusted();
    expect(book.version).toBe(version);
    book.apply(frame({ seq: 3, shades: [shade(2)] }));
    expect(book.trusted()).toBe(true);
    expect(book.list().map((s) => s.id)).toEqual(["s2"]);
    book.clear();
    expect([book.size, book.trusted(), book.liveSince, book.lastSeq, book.lastTs]).toEqual([0, false, null, -1, 0]);
  });
});
