import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTITUTIONAL_SETTINGS,
  DELTA_MIN,
  INSTITUTIONAL_SETTINGS_SCHEMA,
  isShownVerdict,
  thresholdsFor,
  thresholdsOf,
  verdictOf,
  zoneRows,
  type BookEvidence,
} from "../institutionalRules";

const T = { wall: 10, hit: 8, bandRows: 1 };

function evidence(overrides: Partial<BookEvidence> = {}): BookEvidence {
  return { held: true, standing: true, peak: 12, current: 12, hit: 9, delta: 0.2, ...overrides };
}

describe("zoneRows", () => {
  it("returns every row the zone covers", () => {
    expect(zoneRows(105, 100, 2)).toEqual({ rowLo: 50, rowHi: 52 });
  });

  it("counts an edge row in full when the zone covers only part of it", () => {
    expect(zoneRows(103, 101, 2)).toEqual({ rowLo: 50, rowHi: 51 });
  });

  it("leaves out a row that meets the zone at a single price, matching the classic block's near-edge touch rule", () => {
    expect(zoneRows(104, 100, 2)).toEqual({ rowLo: 50, rowHi: 51 });
    expect(zoneRows(106, 100, 2)!.rowLo).toBe(50);
  });

  it("has no rows for a zone of no height, rather than one arbitrary row", () => {
    expect(zoneRows(100, 100, 2)).toBeNull();
  });

  it("refuses an inverted zone instead of silently swapping the edges", () => {
    expect(zoneRows(100, 105, 2)).toBeNull();
  });

  it("refuses a row width that cannot place a price", () => {
    expect(zoneRows(105, 100, 0)).toBeNull();
    expect(zoneRows(105, 100, -2)).toBeNull();
    expect(zoneRows(Number.NaN, 100, 2)).toBeNull();
    expect(zoneRows(105, Number.POSITIVE_INFINITY, 2)).toBeNull();
  });
});

describe("thresholdsFor", () => {
  it("gives each crypto instrument the trader's measured wall and hit sizes", () => {
    expect(thresholdsFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toEqual({ wall: 50, hit: 40 });
    expect(thresholdsFor({ symbol: "BTC-USDT", provider: "BINANCE", marketKind: "SPOT" })).toEqual({ wall: 10, hit: 5 });
    expect(thresholdsFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toEqual({ wall: 600, hit: 300 });
    expect(thresholdsFor({ symbol: "ETH-USDT", provider: "BINANCE", marketKind: "SPOT" })).toEqual({ wall: 180, hit: 60 });
  });

  it("gives the futures and equities the trader's provisional sizes by root and by name", () => {
    expect(thresholdsFor({ symbol: "/NQU26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toEqual({ wall: 10, hit: 8 });
    expect(thresholdsFor({ symbol: "/MNQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toEqual({ wall: 10, hit: 8 });
    expect(thresholdsFor({ symbol: "/ESU26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toEqual({ wall: 30, hit: 20 });
    expect(thresholdsFor({ symbol: "/MESU26:XCME", provider: "DXFEED", assetClass: "FUTURE" })).toEqual({ wall: 30, hit: 20 });
    expect(thresholdsFor({ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" })).toEqual({ wall: 1000, hit: 3000 });
    expect(thresholdsFor({ symbol: "NVDA", provider: "DXFEED", assetClass: "EQUITY" })).toEqual({ wall: 1000, hit: 3000 });
    expect(thresholdsFor({ symbol: "TSLA", provider: "DXFEED", assetClass: "EQUITY" })).toEqual({ wall: 1000, hit: 2000 });
  });

  it("falls back to the smallest sizes for an instrument it does not know, rather than to none", () => {
    expect(thresholdsFor({ symbol: "SOL-USDT", provider: "BINANCE", marketKind: "PERPETUAL" })).toEqual({ wall: 10, hit: 5 });
    expect(thresholdsFor({ symbol: "/CLX26:NYMEX", provider: "DXFEED", assetClass: "FUTURE" })).toEqual({ wall: 10, hit: 8 });
  });
});

describe("thresholdsOf", () => {
  const btc = { symbol: "BTC-USDT", provider: "BINANCE" as const, marketKind: "PERPETUAL" as const };

  it("takes the instrument's defaults when the settings are zero, the width being the second indicator's", () => {
    expect(thresholdsOf(DEFAULT_INSTITUTIONAL_SETTINGS, btc)).toEqual({ wall: 50, hit: 40, bandRows: 4 });
    expect(thresholdsOf(DEFAULT_INSTITUTIONAL_SETTINGS, { ...btc, symbol: "ETH-USDT" })).toEqual({ wall: 600, hit: 300, bandRows: 8 });
  });

  it("lets each size and the width be overridden on its own, the width whole", () => {
    expect(thresholdsOf({ ...DEFAULT_INSTITUTIONAL_SETTINGS, wallSize: 80 }, btc)).toEqual({ wall: 80, hit: 40, bandRows: 4 });
    expect(thresholdsOf({ ...DEFAULT_INSTITUTIONAL_SETTINGS, hitSize: 15 }, btc)).toEqual({ wall: 50, hit: 15, bandRows: 4 });
    expect(thresholdsOf({ ...DEFAULT_INSTITUTIONAL_SETTINGS, bandRows: 2.9 }, btc)).toEqual({ wall: 50, hit: 40, bandRows: 2 });
  });
});

describe("verdictOf", () => {
  it("is strong when a wall stood, was hit enough, the leg followed, and the wall is still there", () => {
    expect(verdictOf(evidence(), T)).toBe("strong");
  });

  it("reports no reading as unverifiable, never as a rejection -- we did not see the book, the book did not say no", () => {
    expect(verdictOf(null, T)).toBe("unverifiable");
  });

  it("rejects a block with no wall behind it however the hit and the delta look", () => {
    expect(verdictOf(evidence({ held: false }), T)).toBe("rejected");
  });

  it("is weak when the wall was hit but the leg did not follow", () => {
    expect(verdictOf(evidence({ delta: 0.1 }), T)).toBe("weak");
  });

  it("is weak when the leg followed but the wall was not hit enough while it stood", () => {
    expect(verdictOf(evidence({ hit: 7 }), T)).toBe("weak");
  });

  it("goes from strong to weak once the wall has gone, so the grade is live", () => {
    expect(verdictOf(evidence({ standing: false }), T)).toBe("weak");
  });

  it("rejects a wall that stood, was never hit enough, and left -- a spoof", () => {
    expect(verdictOf(evidence({ hit: 7, standing: false }), T)).toBe("rejected");
    expect(verdictOf(evidence({ hit: 7, standing: false, delta: 0.5 }), T)).toBe("rejected");
  });

  it("keeps a standing wall that was not hit enough as weak, not rejected: it may still be hit", () => {
    expect(verdictOf(evidence({ hit: 0 }), T)).toBe("weak");
  });

  it("reads the delta in the block's direction, so flow against it never confirms", () => {
    expect(verdictOf(evidence({ delta: -0.5 }), T)).toBe("weak");
  });

  it("accepts a threshold met exactly, since the sizes are minimums", () => {
    expect(verdictOf(evidence({ hit: 8, delta: DELTA_MIN }), T)).toBe("strong");
  });
});

describe("institutional settings", () => {
  it("asks for a replay only where a change alters what is read, since a replay re-reads every zone's window", () => {
    const affects = new Map(INSTITUTIONAL_SETTINGS_SCHEMA.flatMap((field) => (field.kind === "staticHint" ? [] : [[field.key, field.affects] as const])));
    for (const key of ["pivotLength", "widthMultiplier", "stackPivots"] as const) expect(affects.get(key)).toBe("recompute");
    for (const key of ["showSecondary", "showWeak", "showUnverifiable", "showRejected", "showMitigated", "bullishColor", "bearishColor"] as const) expect(affects.get(key)).toBe("cosmetic");
  });

  it("offers every setting but the sizes, which the trader took off the menu on 2026-09-21 so a size typed on one book never reads another, and carries no paragraph of text", () => {
    const offered = new Set(
      INSTITUTIONAL_SETTINGS_SCHEMA.flatMap((field) => (field.kind === "staticHint" ? [] : [field.key])),
    );
    const defined = new Set(Object.keys(DEFAULT_INSTITUTIONAL_SETTINGS));
    defined.delete("wallSize");
    defined.delete("hitSize");
    expect(offered).toEqual(defined);
    expect(INSTITUTIONAL_SETTINGS_SCHEMA.some((field) => field.kind === "staticHint")).toBe(false);
  });

  it("defaults the sizes to the instrument's own and draws only what the book backed, the rest being switches", () => {
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.wallSize).toBe(0);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.hitSize).toBe(0);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.showWeak).toBe(false);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.showUnverifiable).toBe(false);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.showRejected).toBe(false);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.showMitigated).toBe(false);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.showSecondary).toBe(false);
  });

  it("shows a strong zone on the defaults and nothing else, which is what a trader sees before touching a switch", () => {
    expect(isShownVerdict("strong", DEFAULT_INSTITUTIONAL_SETTINGS)).toBe(true);
    for (const verdict of ["weak", "rejected", "unverifiable"] as const) expect(isShownVerdict(verdict, DEFAULT_INSTITUTIONAL_SETTINGS)).toBe(false);
  });

  it("keeps the classic geometry defaults, so the same zones are graded and not different ones", () => {
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.pivotLength).toBe(7);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.widthMultiplier).toBe(1);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.stackPivots).toBe(true);
    expect(DEFAULT_INSTITUTIONAL_SETTINGS.showSecondary).toBe(false);
  });
});

describe("isShownVerdict", () => {
  it("always draws a strong block", () => {
    expect(isShownVerdict("strong", { ...DEFAULT_INSTITUTIONAL_SETTINGS, showWeak: false, showUnverifiable: false, showRejected: false })).toBe(true);
  });

  it("draws each of the other grades only when its own toggle is on", () => {
    const off = { ...DEFAULT_INSTITUTIONAL_SETTINGS, showWeak: false, showRejected: false, showUnverifiable: false };
    expect(isShownVerdict("weak", off)).toBe(false);
    expect(isShownVerdict("rejected", off)).toBe(false);
    expect(isShownVerdict("unverifiable", off)).toBe(false);
    expect(isShownVerdict("weak", { ...off, showWeak: true })).toBe(true);
    expect(isShownVerdict("rejected", { ...off, showRejected: true })).toBe(true);
    expect(isShownVerdict("unverifiable", { ...off, showUnverifiable: true })).toBe(true);
  });
});
