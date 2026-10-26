import { describe, expect, it } from "vitest";
import type { IcebergOrder, IcebergOrdersFrame } from "../../types/frames";
import { IcebergBook } from "./icebergBook";

function iceberg(overrides: Partial<IcebergOrder> = {}): IcebergOrder {
  return {
    id: "a", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 2, executed: 12,
    startedAt: 1000, markedAt: 1500, updatedAt: 2000, status: "active", ...overrides,
  };
}

function frame(overrides: Partial<Pick<IcebergOrdersFrame, "ts" | "seq" | "reset" | "icebergs" | "watched" | "liveSince">> = {}): IcebergOrdersFrame {
  return { type: "iceberg_orders", provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE", ts: 5000, seq: 0, reset: true, icebergs: [], watched: [], liveSince: 4000, ...overrides } as IcebergOrdersFrame;
}

describe("IcebergBook", () => {
  it("starts empty and untrusted; a reset page makes it synced and holds exactly that page", () => {
    const book = new IcebergBook();
    expect(book.trusted()).toBe(false);
    expect(book.list()).toEqual([]);
    expect(book.apply(frame({ icebergs: [iceberg()] }))).toBe("reset");
    expect(book.trusted()).toBe(true);
    expect(book.list()).toEqual([iceberg()]);
    expect(book.version).toBe(1);
    expect(book.lastTs).toBe(5000);
  });

  it("an increment before any reset is ignored, so a page from before a pair switch cannot seed the book", () => {
    const book = new IcebergBook();
    expect(book.apply(frame({ reset: false, seq: 3, icebergs: [iceberg()] }))).toBe("ignored");
    expect(book.size).toBe(0);
    expect(book.version).toBe(0);
  });

  it("increments upsert by id, keeping the newest updatedAt and never going back", () => {
    const book = new IcebergBook();
    book.apply(frame({ icebergs: [iceberg()] }));
    expect(book.apply(frame({ reset: false, seq: 1, icebergs: [iceberg({ executed: 20, updatedAt: 3000 })] }))).toBe("applied");
    expect(book.get("a")?.executed).toBe(20);
    expect(book.apply(frame({ reset: false, seq: 2, icebergs: [iceberg({ executed: 12, updatedAt: 2000 })] }))).toBe("ignored");
    expect(book.get("a")?.executed).toBe(20);
    expect(book.version).toBe(2);
    expect(book.lastSeq).toBe(1);
  });

  it("a later reset replaces everything held", () => {
    const book = new IcebergBook();
    book.apply(frame({ icebergs: [iceberg(), iceberg({ id: "b", markedAt: 1600 })] }));
    book.apply(frame({ seq: 0, icebergs: [iceberg({ id: "c" })] }));
    expect(book.list().map((entry) => entry.id)).toEqual(["c"]);
  });

  it("list is oldest mark first, frozen, and cached until something changes", () => {
    const book = new IcebergBook();
    book.apply(frame({ icebergs: [iceberg({ id: "late", markedAt: 9000 }), iceberg({ id: "early", markedAt: 1500 })] }));
    const first = book.list();
    expect(first.map((entry) => entry.id)).toEqual(["early", "late"]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(book.list()).toBe(first);
    book.apply(frame({ reset: false, seq: 1, icebergs: [iceberg({ id: "mid", markedAt: 5000 })] }));
    expect(book.list().map((entry) => entry.id)).toEqual(["early", "mid", "late"]);
  });

  it("a dropped socket leaves the held icebergs visible but untrusted until the next reset", () => {
    const book = new IcebergBook();
    book.apply(frame({ icebergs: [iceberg()] }));
    book.markUntrusted();
    expect(book.trusted()).toBe(false);
    expect(book.size).toBe(1);
    expect(book.version).toBe(2);
    book.markUntrusted();
    expect(book.version).toBe(2);
    book.apply(frame({ icebergs: [iceberg()] }));
    expect(book.trusted()).toBe(true);
  });

  it("liveSince is the runtime's start as the latest applied page says it; an ignored page leaves it; clear forgets it", () => {
    const book = new IcebergBook();
    expect(book.liveSince).toBeNull();
    book.apply(frame({ liveSince: 4000 }));
    expect(book.liveSince).toBe(4000);
    book.apply(frame({ seq: 1, reset: false, icebergs: [iceberg({ id: "n" })], liveSince: 4500 }));
    expect(book.liveSince).toBe(4500);
    book.apply(frame({ seq: 2, reset: false, icebergs: [iceberg({ id: "n", updatedAt: 1 })], liveSince: 9000 }));
    expect(book.liveSince).toBe(4500);
    book.clear();
    expect(book.liveSince).toBeNull();
  });

  it("historyFrom is the older of the first watched span's start and the runtime's own oldest settled mark; a host iceberg or a live one never moves it; clear forgets it", () => {
    const book = new IcebergBook();
    expect(book.historyFrom).toBeNull();
    book.apply(frame({ ts: 5000, icebergs: [iceberg({ id: "h", markedAt: 100, origin: "host", status: "filled" }), iceberg({ id: "a", markedAt: 400, status: "active" })] }));
    expect(book.historyFrom).toBeNull();
    book.apply(frame({ seq: 1, reset: false, icebergs: [iceberg({ id: "own", markedAt: 900, status: "filled" })], watched: [[1000, 2000]] }));
    expect(book.historyFrom).toBe(900);
    book.apply(frame({ seq: 2, reset: false, icebergs: [iceberg({ id: "later", markedAt: 1500, status: "filled" })], watched: [[1000, 2000]] }));
    expect(book.historyFrom).toBe(900);
    book.apply(frame({ seq: 3, reset: false, icebergs: [iceberg({ id: "older-host", markedAt: 10, origin: "host", status: "filled" })], watched: [[800, 2000]] }));
    expect(book.historyFrom).toBe(800);
    book.clear();
    expect(book.historyFrom).toBeNull();
  });

  it("every applied page brings the runtime's watched spans; historyFrom is the first span's start; an ignored page changes nothing; clear forgets them", () => {
    const book = new IcebergBook();
    expect(book.watched).toEqual([]);
    expect(book.historyFrom).toBeNull();
    book.apply(frame({ watched: [[1000, 2000], [3000, 4000]] }));
    expect(book.watched).toEqual([[1000, 2000], [3000, 4000]]);
    expect(book.historyFrom).toBe(1000);
    book.apply(frame({ seq: 1, reset: false, icebergs: [iceberg({ id: "n" })], watched: [[1000, 4500]] }));
    expect(book.watched).toEqual([[1000, 4500]]);
    book.apply(frame({ seq: 2, reset: false, icebergs: [iceberg({ id: "n", updatedAt: 1 })], watched: [[1000, 5000]] }));
    expect(book.watched).toEqual([[1000, 4500]]);
    book.clear();
    expect(book.watched).toEqual([]);
    expect(book.historyFrom).toBeNull();
  });

  it("clear forgets everything, including sync, so the next pair starts from its own reset", () => {
    const book = new IcebergBook();
    book.apply(frame({ icebergs: [iceberg()] }));
    book.clear();
    expect(book.size).toBe(0);
    expect(book.trusted()).toBe(false);
    expect(book.lastTs).toBe(0);
    expect(book.apply(frame({ reset: false, seq: 7, icebergs: [iceberg()] }))).toBe("ignored");
  });
});
