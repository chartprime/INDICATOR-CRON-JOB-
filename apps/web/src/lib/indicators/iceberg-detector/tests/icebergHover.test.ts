import { describe, expect, it } from "vitest";
import type { IcebergOrder } from "../../../../types/frames";
import { describeIceberg } from "../icebergHover";

const T = Date.UTC(2026, 9, 8, 16, 10, 0);

function iceberg(overrides: Partial<IcebergOrder> = {}): IcebergOrder {
  return {
    id: "a", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 4, executed: 32,
    startedAt: T, markedAt: T + 7000, updatedAt: T + 127_000, status: "filled", ...overrides,
  };
}

describe("describeIceberg", () => {
  it("the card is three plain lines: what and which side, the total as orders times size, what traded; and when it was marked with how long it ran", () => {
    const hover = describeIceberg(iceberg(), "contracts");
    expect(hover.side).toBe("bid");
    expect(hover.kind).toBe("native");
    expect(hover.title).toBe("Native iceberg · bid");
    expect(hover.headline).toBe("Total 40 contracts · 4 orders of 10 contracts");
    expect(hover.detailLine).toBe("32 contracts traded");
    expect(hover.whenLine).toBe("marked 16:10:07 UTC · 2 min");
  });

  it("a probable iceberg reads the same way, whatever its confidence or how it ended; a live one says it is still refilling", () => {
    const strong = describeIceberg(iceberg({ kind: "probable", confidence: "strong", origin: "runtime", side: "ask", display: 1.545, executed: 12.475, tranches: 2, status: "ended", updatedAt: T + 6200 }), "BTC");
    expect(strong.title).toBe("Probable iceberg · ask");
    expect(strong.headline).toBe("Total 13.9 BTC · 9 orders of 1.545 BTC");
    const bouncing = describeIceberg(iceberg({ kind: "probable", confidence: "probable", origin: "runtime", display: 3.365, executed: 7.005, tranches: 23, status: "ended" }), "BTC");
    expect(bouncing.headline).toBe("Total 10.1 BTC · 3 orders of 3.365 BTC");
    expect(strong.detailLine).toBe("12.5 BTC traded");
    expect(strong.whenLine).toBe("marked 16:10:07 UTC · 6 s");
    const weak = describeIceberg(iceberg({ kind: "probable", confidence: "weak", origin: "runtime", status: "active", tranches: 4, executed: 8 }), "BTC");
    expect(weak.title).toBe("Probable iceberg · bid");
    expect(weak.headline).toBe("Total 10 BTC · 1 order of 10 BTC");
    expect(weak.detailLine).toBe("8 BTC traded · still refilling");
    for (const status of ["pulled", "replaced", "interrupted", "ended", "filled"] as const) expect(describeIceberg(iceberg({ status }), "").detailLine).toBe("32 traded");
  });

  it("a unit-less instrument shows bare numbers, and the run length reads in seconds, minutes or hours", () => {
    expect(describeIceberg(iceberg(), "").headline).toBe("Total 40 · 4 orders of 10");
    expect(describeIceberg(iceberg({ display: 11.023, tranches: 4, executed: 37.436 }), "BTC").headline).toBe("Total 44 BTC · 4 orders of 11 BTC");
    expect(describeIceberg(iceberg({ updatedAt: T + 900 }), "").whenLine).toBe("marked 16:10:07 UTC · under a second");
    expect(describeIceberg(iceberg({ updatedAt: T + 5_400_000 }), "").whenLine).toBe("marked 16:10:07 UTC · 1.5 h");
  });
});
