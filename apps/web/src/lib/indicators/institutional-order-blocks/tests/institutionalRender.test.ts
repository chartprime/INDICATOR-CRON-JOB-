import { describe, expect, it } from "vitest";
import type { OrderBlock } from "../../classic-order-blocks/orderBlockRules";
import { createZoneRead } from "../bookEvidence";
import { computeKernelRender, DrawKernelPrimitive } from "../../../chart/draw/kernelPrimitive";
import type { DrawObjectRecord } from "../../../chart/draw/registry";
import { MITIGATED_FILL_ALPHA } from "../../classic-order-blocks/orderBlockRender";
import { NO_CARD, REJECTED_FILL_ALPHA, STRONG_FILL_ALPHA, WEAK_FILL_ALPHA, ZONE_TEXT, ZONE_TEXT_ON_DARK, describeBlock, isShownInstitutional, renderInstitutionalBlocks, shortenBlock } from "../institutionalRender";
import { DEFAULT_INSTITUTIONAL_SETTINGS } from "../institutionalRules";
import type { InstitutionalBlock } from "../institutionalTracker";

const BLOCK: OrderBlock = { side: "bullish", tier: "primary", pivotTime: 1, baseTime: 3, breakTime: 5, top: 10, bottom: 9, mitigatedTime: null, volume: 100 };

function entry(overrides: Partial<InstitutionalBlock> = {}): InstitutionalBlock {
  return {
    block: BLOCK, verdict: "strong", reason: null, gap: null, read: createZoneRead(), readAt: 0, rowWidth: 1, oldest: 0, want: null, historical: false, gaps: [],
    evidence: { held: true, standing: true, peak: 1240, current: 1240, hit: 830, delta: 0.184 },
    ...overrides,
  };
}

/** Every grade drawn: these tests are about the order zones are laid in, not about which the trader has switched on. */
const SHOWN_ALL = { ...DEFAULT_INSTITUTIONAL_SETTINGS, showWeak: true, showRejected: true, showUnverifiable: true };

describe("describeBlock", () => {
  it("says the grade, the wall as it stands, what traded into it and the delta on one line, in the book's unit", () => {
    expect(describeBlock(entry(), "BTC")).toBe("Strong OB · 1.2k BTC · Traded 830 BTC · +18% Delta");
  });

  it("says the same words for either side, since the band's colour already says which", () => {
    expect(describeBlock(entry({ block: { ...BLOCK, side: "bearish" } }), "BTC")).toBe(describeBlock(entry(), "BTC"));
  });

  it("leaves the unit off when the book has none", () => {
    expect(describeBlock(entry(), "")).toBe("Strong OB · 1.2k · Traded 830 · +18% Delta");
  });

  it("shows the wall as it is now, not at its largest, so a wall eaten down reads as what is left", () => {
    expect(describeBlock(entry({ verdict: "weak", evidence: { held: true, standing: true, peak: 130, current: 85, hit: 421, delta: 0.18 } }), "BTC")).toBe("Weak OB · 85.0 BTC · Traded 421 BTC · +18% Delta");
  });

  it("says only that no wall stood when none did, instead of a row of zeros", () => {
    expect(describeBlock(entry({ verdict: "rejected", evidence: { held: false, standing: false, peak: 0, current: 0, hit: 0, delta: 0.02 } }), "BTC")).toBe("Rejected OB · no wall stood here · +2% Delta");
  });

  it("says a wall has gone, and what it was at its largest, on a zone that has gone weak", () => {
    expect(describeBlock(entry({ verdict: "weak", evidence: { held: true, standing: false, peak: 52, current: 0, hit: 41, delta: 0.18 } }), "BTC")).toBe("Weak OB · wall gone (was 52.0 BTC) · Traded 41.0 BTC · +18% Delta");
  });

  it("calls a wall that left with too little traded into it a pull", () => {
    expect(describeBlock(entry({ verdict: "rejected", evidence: { held: true, standing: false, peak: 52, current: 0, hit: 3, delta: 0.18 } }), "BTC")).toBe("Rejected OB · wall pulled (was 52.0 BTC) · Traded 3.00 BTC · +18% Delta");
  });

  it("signs a delta against the block", () => {
    expect(describeBlock(entry({ verdict: "weak", evidence: { held: true, standing: true, peak: 50, current: 50, hit: 40, delta: -0.3 } }), "")).toBe("Weak OB · 50.0 · Traded 40.0 · -30% Delta");
  });

  it("reads the same whether the grade came from the recording or the live book, holes in the recording included", () => {
    expect(describeBlock(entry({ historical: true }), "BTC")).toBe("Strong OB · 1.2k BTC · Traded 830 BTC · +18% Delta");
    expect(describeBlock(entry({ historical: true }), "BTC")).toBe(describeBlock(entry({ historical: false }), "BTC"));
    expect(describeBlock(entry({ historical: true, gaps: [{ from: Date.UTC(2026, 8, 20, 9, 5), to: Date.UTC(2026, 8, 20, 9, 30) }, { from: 0, to: 1 }] }), "BTC")).toBe("Strong OB · 1.2k BTC · Traded 830 BTC · +18% Delta");
    expect(describeBlock(entry({ verdict: "rejected", historical: true, evidence: { held: false, standing: false, peak: 0, current: 0, hit: 0, delta: 0.02 } }), "BTC")).toBe("Rejected OB · no wall stood here · +2% Delta");
    expect(shortenBlock(entry({ historical: true, gaps: [{ from: Date.UTC(2026, 8, 20, 9, 5), to: Date.UTC(2026, 8, 20, 9, 30) }] }), "BTC")).toEqual(shortenBlock(entry({ historical: false }), "BTC"));
    expect(shortenBlock(entry({ historical: true }), "BTC")[0]).toBe("Strong OB · 1.2k BTC · Traded 830 BTC");
    for (const text of [...shortenBlock(entry({ historical: true, gaps: [{ from: 0, to: 1 }] }), "BTC"), describeBlock(entry({ historical: true, gaps: [{ from: 0, to: 1 }] }), "BTC")]) expect(text).not.toMatch(/recording|missing/);
  });

  it("says why an unverified zone could not be read", () => {
    const why = (reason: InstitutionalBlock["reason"]) => describeBlock(entry({ verdict: "unverifiable", evidence: null, reason }), "BTC");
    expect(why("before")).toBe("Unverified OB · book not reached");
    expect(why("older")).toBe("Unverified OB · older than the recording");
    expect(why("after")).toBe("Unverified OB · book still printing");
    expect(why("hole")).toBe("Unverified OB · no book recorded");
    expect(why("rows")).toBe("Unverified OB · zone thinner than a row");
    expect(why("feed")).toBe("Unverified OB · no book");
  });

  it("says only that no book was recorded for a zone whose whole window fell in a recording gap, without the gap's times", () => {
    const gap = { from: Date.UTC(2026, 8, 16, 21, 53, 20), to: Date.UTC(2026, 8, 16, 21, 55, 0) };
    expect(describeBlock(entry({ verdict: "unverifiable", evidence: null, reason: "hole", gap }), "ETH")).toBe("Unverified OB · no book recorded");
    expect(shortenBlock(entry({ verdict: "unverifiable", evidence: null, reason: "hole", gap }), "ETH")).toEqual(["Unverified OB"]);
  });
});

describe("shortenBlock", () => {
  it("drops the delta, then what traded, then the wall, never the grade", () => {
    expect(shortenBlock(entry(), "BTC")).toEqual([
      "Strong OB · 1.2k BTC · Traded 830 BTC",
      "Strong OB · 1.2k BTC",
      "Strong OB",
    ]);
  });

  it("drops what a zone with no wall has to drop, and leaves an unread one its grade", () => {
    expect(shortenBlock(entry({ verdict: "rejected", evidence: { held: false, standing: false, peak: 0, current: 0, hit: 0, delta: 0 } }), "BTC")).toEqual([
      "Rejected OB · no wall stood here",
      "Rejected OB",
    ]);
    expect(shortenBlock(entry({ verdict: "unverifiable", evidence: null, reason: "before" }), "BTC")).toEqual(["Unverified OB"]);
  });
});

describe("renderInstitutionalBlocks", () => {
  function slot() {
    const data: Record<string, unknown> = { text: "", time1: 0, price1: 0, card: "", body: "", accent: "", tail: null, short: null, pinned: null };
    return {
      handle: {
        setLeftTop: (time: number, price: number) => { data.time1 = time; data.price1 = price; },
        setRightBottom: () => {},
        setBorderColor: () => {},
        setBackgroundColor: () => {},
        setBorderWidth: () => {},
        setText: (text: string) => { data.text = text; },
        setTextColor: (color: string) => { data.body = color; },
        setTextBackground: (color: string) => { data.card = color; },
        setTextAccent: (color: string) => { data.accent = color; },
        setTailFade: (on: boolean) => { data.tail = on; },
        setTextFallbacks: (texts: readonly string[]) => { data.short = texts; },
        setMinHeightPx: () => {},
        setExtendRight: (on: boolean) => { data.pinned = on; },
        setTextOffsetY: () => {},
        delete: () => {},
      },
      data,
    };
  }

  /** The verdict written into each slot, in slot order: the kernel paints slot 0 first, so the last one is on top. */
  function painted(entries: readonly InstitutionalBlock[], settings = SHOWN_ALL) {
    const slots = Array.from({ length: 6 }, slot);
    renderInstitutionalBlocks(slots.map((s) => s.handle), entries, settings, 99, "BTC");
    return slots.map((s) => String(s.data.text).split(" ")[0].toLowerCase()).filter((text) => text !== "");
  }

  const graded = (verdict: InstitutionalBlock["verdict"], top: number) =>
    entry({ verdict, block: { ...BLOCK, top, bottom: top - 1 } });

  it("runs a live zone to the price axis, stops a spent one at its bar, and lets go of a slot whose zone is gone", () => {
    const slots = Array.from({ length: 2 }, slot);
    const spent = entry({ block: { ...BLOCK, top: 20, bottom: 19, mitigatedTime: 5 } });
    renderInstitutionalBlocks(slots.map((s) => s.handle), [spent, entry()], { ...SHOWN_ALL, showMitigated: true }, 99, "BTC");
    expect(slots.map((s) => s.data.pinned)).toEqual([false, true]);
    renderInstitutionalBlocks(slots.map((s) => s.handle), [], SHOWN_ALL, 99, "BTC");
    expect(slots.map((s) => s.data.pinned)).toEqual([false, false]);
  });

  it("paints the strongest zone last, so it reads on top of the ones it overlaps", () => {
    expect(painted([graded("rejected", 10), graded("strong", 11), graded("weak", 12)])).toEqual(["rejected", "weak", "strong"]);
  });

  it("orders every grade, with what the book could not read furthest back", () => {
    expect(painted([graded("strong", 10), graded("unverifiable", 11), graded("weak", 12), graded("rejected", 13)]))
      .toEqual(["unverified", "rejected", "weak", "strong"]);
  });

  it("puts a spent block behind them all, whatever it was graded", () => {
    // Its own rows, clear of the others: a spent block nested in a live one is dropped, which is a different rule.
    const spent = entry({ verdict: "strong", block: { ...BLOCK, top: 14, bottom: 13, mitigatedTime: 5 } });
    expect(painted([graded("rejected", 10), spent, graded("weak", 12)], { ...SHOWN_ALL, showMitigated: true }))
      .toEqual(["strong", "rejected", "weak"]);
  });

  it("starts a zone at the candle that set its base, not at the swing it broke", () => {
    const slots = Array.from({ length: 1 }, slot);
    renderInstitutionalBlocks(slots.map((s) => s.handle), [entry()], SHOWN_ALL, 99, "BTC");
    expect(slots[0].data.time1).toBe(3);
  });

  it("puts the older of two unverified zones in front, and keeps the older when one sits inside the other", () => {
    const [older, newer] = [graded("unverifiable", 10), graded("unverifiable", 11)];
    const slots = Array.from({ length: 3 }, slot);
    renderInstitutionalBlocks(slots.map((s) => s.handle), [older, newer], SHOWN_ALL, 99, "BTC");
    expect(slots.map((s) => s.data.price1)).toEqual([11, 10, 0]);
    const kept = Array.from({ length: 2 }, slot);
    const wide = entry({ verdict: "unverifiable", block: { ...BLOCK, top: 20, bottom: 10 } });
    const inside = entry({ verdict: "unverifiable", block: { ...BLOCK, top: 15, bottom: 12 } });
    renderInstitutionalBlocks(kept.map((s) => s.handle), [wide, inside], SHOWN_ALL, 99, "BTC");
    expect(kept.map((s) => s.data.price1)).toEqual([20, 0]);
  });

  it("keeps formation order within a grade, so the newest of equals is in front", () => {
    const [older, newer] = [graded("weak", 10), graded("weak", 11)];
    const slots = Array.from({ length: 3 }, slot);
    renderInstitutionalBlocks(slots.map((s) => s.handle), [older, newer], SHOWN_ALL, 99, "BTC");
    expect(slots.map((s) => s.data.price1)).toEqual([10, 11, 0]);
  });

  /** The grades painted, in slot order, for zones given as [verdict, top, bottom]. */
  function nested(zones: readonly [InstitutionalBlock["verdict"], number, number][]) {
    const slots = Array.from({ length: 6 }, slot);
    const blocks = zones.map(([verdict, top, bottom]) => entry({ verdict, block: { ...BLOCK, top, bottom } }));
    renderInstitutionalBlocks(slots.map((s) => s.handle), blocks, SHOWN_ALL, 99, "BTC");
    return slots.map((s) => String(s.data.text).split(" ")[0].toLowerCase()).filter((text) => text !== "");
  }

  it("drops a zone drawn over the whole of a better-graded one, since the two are one level read twice", () => {
    expect(nested([["strong", 20, 10], ["weak", 15, 12]])).toEqual(["strong"]);
  });

  it("drops the bigger zone when the one inside it is the better graded", () => {
    expect(nested([["weak", 20, 10], ["strong", 15, 12]])).toEqual(["strong"]);
  });

  it("keeps one of two zones graded alike, the newer, rather than dropping both or neither", () => {
    expect(nested([["weak", 20, 10], ["weak", 20, 10]])).toEqual(["weak"]);
    expect(nested([["weak", 20, 10], ["weak", 15, 12]])).toEqual(["weak"]);
  });

  it("keeps both zones that merely cross, since they are two levels", () => {
    expect(nested([["strong", 20, 12], ["weak", 15, 10]])).toEqual(["weak", "strong"]);
  });

  it("keeps a zone nested inside one the trader has switched off", () => {
    const slots = Array.from({ length: 3 }, slot);
    const outer = entry({ verdict: "rejected", block: { ...BLOCK, top: 20, bottom: 10 } });
    const inner = entry({ verdict: "weak", block: { ...BLOCK, top: 15, bottom: 12 } });
    renderInstitutionalBlocks(slots.map((s) => s.handle), [outer, inner], { ...SHOWN_ALL, showRejected: false }, 99, "BTC");
    expect(slots.map((s) => String(s.data.text).split(" ")[0]).filter((t) => t !== "")).toEqual(["Weak"]);
  });

  it("clears the slots no zone was given, so a hidden grade leaves nothing painted", () => {
    const hidden = { ...SHOWN_ALL, showRejected: false };
    expect(painted([graded("rejected", 10), graded("strong", 11)], hidden)).toEqual(["strong"]);
  });

  it("selects visible grades before applying the slot cap", () => {
    const slots = Array.from({ length: 1 }, slot);
    renderInstitutionalBlocks(
      slots.map((s) => s.handle),
      [graded("strong", 10), graded("rejected", 12)],
      DEFAULT_INSTITUTIONAL_SETTINGS,
      99,
      "BTC",
    );
    expect(slots[0].data.text).toContain("Strong OB");
  });


  it("writes the words inside the zone in dark ink whatever the grade, with no card behind them", () => {
    const slots = Array.from({ length: 3 }, slot);
    renderInstitutionalBlocks(slots.map((s) => s.handle), [graded("rejected", 10), graded("strong", 12)], SHOWN_ALL, 99, "BTC");
    expect(slots.map((s) => [s.data.card, s.data.body, s.data.accent, s.data.tail])).toEqual([
      [NO_CARD, ZONE_TEXT, "", true],
      [NO_CARD, ZONE_TEXT, "", true],
      ["", "", "", null],
    ]);
  });

  it("gives every zone its short forms, so a zone too narrow for the whole line still says what it is", () => {
    const slots = Array.from({ length: 1 }, slot);
    renderInstitutionalBlocks(slots.map((s) => s.handle), [entry()], DEFAULT_INSTITUTIONAL_SETTINGS, 99, "BTC");
    expect(slots[0].data.short).toEqual(["Strong OB · 1.2k BTC · Traded 830 BTC", "Strong OB · 1.2k BTC", "Strong OB"]);
  });

  it("stops a spent zone where it was spent, its words inside it with no card, while a live one runs on to the axis", () => {
    const slots = Array.from({ length: 1 }, slot);
    const spent = entry({ block: { ...BLOCK, mitigatedTime: 5 } });
    renderInstitutionalBlocks(slots.map((s) => s.handle), [spent], { ...DEFAULT_INSTITUTIONAL_SETTINGS, showMitigated: true }, 99, "BTC");
    expect([slots[0].data.card, slots[0].data.accent, slots[0].data.tail]).toEqual([NO_CARD, "", false]);
  });


});

describe("isShownInstitutional", () => {
  it("keeps the classic tier and mitigation gates in front of the verdict gate", () => {
    const settings = SHOWN_ALL;
    expect(isShownInstitutional(entry(), settings)).toBe(true);
    expect(isShownInstitutional(entry({ block: { ...BLOCK, tier: "secondary" } }), settings)).toBe(false);
    expect(isShownInstitutional(entry({ block: { ...BLOCK, mitigatedTime: 3 } }), settings)).toBe(false);
    expect(isShownInstitutional(entry({ block: { ...BLOCK, mitigatedTime: 3 } }), { ...settings, showMitigated: true })).toBe(true);
    expect(isShownInstitutional(entry({ verdict: "rejected" }), { ...settings, showRejected: false })).toBe(false);
    expect(isShownInstitutional(entry({ verdict: "rejected" }), settings)).toBe(true);
  });
});

describe("the words inside the zone", () => {
  function luminance(hex: string): number {
    const value = Number.parseInt(hex.slice(1), 16);
    const channel = (shift: number) => {
      const c = ((value >> shift) & 255) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  }

  it("sit a padding in from the zone's right end with nothing visible painted behind them", () => {
    const record = { handleId: 1, ownerId: "ob", kind: "box", data: { time1: 100, price1: 10, time2: 400, price2: 30, borderColor: "#111", backgroundColor: "#222", borderWidth: 1, text: "Strong OB", textColor: ZONE_TEXT, fontSize: 12, textAlign: "right", textBackground: NO_CARD, textPadding: 8, textAccent: "" } } as DrawObjectRecord;
    const [box] = computeKernelRender([record], new Map(), new Map(), (value) => value, (value) => value, 1_000).boxes;
    const context = new Proxy({} as Record<string, unknown>, {
      get: (target, key) => (key === "measureText" ? (text: string) => ({ width: text.length * 6 }) : key in target ? target[key as string] : () => {}),
    }) as unknown as CanvasRenderingContext2D;
    const [placed] = new DrawKernelPrimitive().cardPlacements(context, [box], 1_000);
    expect(placed.card?.textX).toBe(400 - 8);
    expect(placed.card?.backing).not.toBeNull();
    expect(NO_CARD).toBe("transparent");
  });

  it("are written in a dark ink that reads on the light chart and on the zones' pale fills", () => {
    expect(ZONE_TEXT).toMatch(/^#[0-9a-f]{6}$/i);
    expect(luminance(ZONE_TEXT)).toBeLessThan(0.05);
  });

  const zoneRecord = (price2: number): DrawObjectRecord => ({ handleId: 1, ownerId: "ob", kind: "box", data: { time1: 100, price1: 10, time2: 400, price2, borderColor: "#111", backgroundColor: "#222", borderWidth: 1, text: "Strong OB · 1.2k BTC", textFallbacks: ["Strong OB"], textColor: ZONE_TEXT, textColorOnDark: ZONE_TEXT_ON_DARK, fontSize: 12, textAlign: "right", textBackground: NO_CARD, textPadding: 8, textAccent: "", textFitsHeight: true } } as DrawObjectRecord);

  it("stay off a zone shorter than one line of them, so a thin zone paints no words over the candles", () => {
    // One 12 px line is 15.6 px tall: a zone from 10 to 25 is 15 px, one to 26 is 16.
    const context = new Proxy({} as Record<string, unknown>, {
      get: (target, key) => (key === "measureText" ? (text: string) => ({ width: text.length * 6 }) : key in target ? target[key as string] : () => {}),
    }) as unknown as CanvasRenderingContext2D;
    const cardOn = (price2: number) => {
      const [box] = computeKernelRender([zoneRecord(price2)], new Map(), new Map(), (value) => value, (value) => value, 1_000).boxes;
      return new DrawKernelPrimitive().cardPlacements(context, [box], 1_000)[0].card;
    };
    expect(cardOn(25)).toBeNull();
    expect(cardOn(26)?.lines).toEqual(["Strong OB · 1.2k BTC"]);
  });

  it("take a light ink on the dark chart and the dark ink on the light one, each reading at 4.5 : 1 or better on every zone's fill", () => {
    const inkOn = (dark: boolean) => computeKernelRender([zoneRecord(30)], new Map(), new Map(), (value) => value, (value) => value, 1_000, 1_000, dark).boxes[0].textColor;
    expect(inkOn(true)).toBe(ZONE_TEXT_ON_DARK);
    expect(inkOn(false)).toBe(ZONE_TEXT);
    // The dark chart is Historical Mode's --bg, the light one the Live chart's background.
    const rgb = (hex: string) => [16, 8, 0].map((shift) => (Number.parseInt(hex.slice(1), 16) >> shift) & 255);
    const lum = (channels: number[]) => {
      const [r, g, b] = channels.map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (ink: string, fill: string, alpha: number, chart: string) => {
      const under = rgb(fill).map((c, index) => c * alpha + rgb(chart)[index] * (1 - alpha));
      const [hi, lo] = [lum(rgb(ink)), lum(under)].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const alpha of [STRONG_FILL_ALPHA, WEAK_FILL_ALPHA, REJECTED_FILL_ALPHA, MITIGATED_FILL_ALPHA, 0]) {
      for (const fill of [SHOWN_ALL.bullishColor, SHOWN_ALL.bearishColor]) {
        expect(contrast(ZONE_TEXT_ON_DARK, fill, alpha, "#0c0c0c")).toBeGreaterThanOrEqual(4.5);
        expect(contrast(ZONE_TEXT, fill, alpha, "#f2efe6")).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
