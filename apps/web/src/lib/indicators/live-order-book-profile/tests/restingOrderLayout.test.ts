import { describe, expect, it } from "vitest";
import type { RestingOrder } from "../restingOrders";
import {
  RESTING_FADE_MS,
  RESTING_FLASH_LIFT,
  RESTING_APPEAR_MS,
  RESTING_FLASH_MS,
  RESTING_GROW_MS,
  RESTING_MIN_HEIGHT_PX,
  RESTING_SHOWN_MAX,
  layoutResting,
  reconcileResting,
  restingAlpha,
  restingFill,
  restingFlash,
  restingUntil,
  type RestingShown,
} from "../restingOrderLayout";

const NOW = 1_700_000_000_000;

function order(key: string, over: Partial<RestingOrder> = {}): RestingOrder {
  const [side, row] = key.split(":");
  return { key, side: side as RestingOrder["side"], row: Number(row), size: 12, peak: 12, since: NOW - 4_000, ending: false, ...over };
}

describe("reconcileResting", () => {
  it("shows a new order from the moment it is first seen, follows its size while it rests, fades one that went, and forgets it once faded", () => {
    const shown = new Map<string, RestingShown>();
    reconcileResting(shown, [order("bid:100")], NOW);
    expect(shown.get("bid:100")).toMatchObject({ seenAt: NOW, endedAt: null, drawn: 0 });
    reconcileResting(shown, [order("bid:100", { size: 8 })], NOW + 500);
    expect(shown.get("bid:100")).toMatchObject({ seenAt: NOW, endedAt: null, order: { size: 8 } });
    reconcileResting(shown, [], NOW + 2_000);
    expect(shown.get("bid:100")?.endedAt).toBe(NOW + 2_000);
    reconcileResting(shown, [], NOW + 2_000 + RESTING_FADE_MS - 1);
    expect(shown.get("bid:100")?.endedAt).toBe(NOW + 2_000);
    reconcileResting(shown, [], NOW + 2_000 + RESTING_FADE_MS);
    expect(shown.has("bid:100")).toBe(false);
  });

  it("treats an order that rests again on a row still fading as new", () => {
    const shown = new Map<string, RestingShown>();
    reconcileResting(shown, [order("ask:120", { since: NOW - 5_000 })], NOW);
    reconcileResting(shown, [], NOW + 1_000);
    reconcileResting(shown, [order("ask:120", { since: NOW - 2_000 })], NOW + 1_600);
    expect(shown.get("ask:120")).toMatchObject({ seenAt: NOW + 1_600, endedAt: null, order: { since: NOW - 2_000 } });
  });
});

describe("restingAlpha", () => {
  const entry = (endedAt: number | null = null, seenAt = NOW): RestingShown => ({ order: order("bid:100"), seenAt, endedAt, drawn: 0 });

  it("grows in over 300 ms and then stands full", () => {
    expect(RESTING_GROW_MS).toBe(300);
    expect(restingAlpha(entry(), NOW)).toBe(0);
    expect(restingAlpha(entry(), NOW + 150)).toBeCloseTo(0.5, 6);
    expect(restingAlpha(entry(), NOW + 300)).toBe(1);
    expect(restingAlpha(entry(), NOW + 60_000)).toBe(1);
  });

  it("fades from what it had when the order went to nothing over two seconds", () => {
    expect(RESTING_FADE_MS).toBe(2_000);
    const ended = NOW + 30_000;
    expect(restingAlpha(entry(ended), ended)).toBe(1);
    expect(restingAlpha(entry(ended), ended + RESTING_FADE_MS / 2)).toBeCloseTo(0.5, 6);
    expect(restingAlpha(entry(ended), ended + RESTING_FADE_MS)).toBe(0);
    expect(restingAlpha(entry(ended), ended + 3 * RESTING_FADE_MS)).toBe(0);
    expect(restingAlpha(entry(NOW + 150), NOW + 150)).toBeCloseTo(0.5, 6);
    expect(restingAlpha(entry(NOW + 150), NOW + 150 + RESTING_FADE_MS / 2)).toBeCloseTo(0.25, 6);
  });
});

describe("restingFlash and restingFill", () => {
  it("lights a bar as it appears, settling over a second, and again the moment its order goes, for 300 ms; the colour lifts towards white by the flash", () => {
    expect([RESTING_FLASH_MS, RESTING_FLASH_LIFT, RESTING_APPEAR_MS]).toEqual([300, 0.6, 1_000]);
    const standing: RestingShown = { order: order("bid:100"), seenAt: NOW - 5_000, endedAt: null, drawn: 0 };
    expect(restingFlash(standing, NOW)).toBe(0);
    const fresh: RestingShown = { order: order("bid:100"), seenAt: NOW, endedAt: null, drawn: 0 };
    expect(restingFlash(fresh, NOW)).toBe(1);
    expect(restingFlash(fresh, NOW + 250)).toBeCloseTo(0.75, 6);
    expect(restingFlash(fresh, NOW + 1_000)).toBe(0);
    expect(restingFlash(fresh, NOW + 5_000)).toBe(0);
    const gone: RestingShown = { order: order("bid:100"), seenAt: NOW - 5_000, endedAt: NOW, drawn: 0 };
    expect(restingFlash(gone, NOW)).toBe(1);
    expect(restingFlash(gone, NOW + 150)).toBeCloseTo(0.5, 6);
    expect(restingFlash(gone, NOW + 300)).toBe(0);
    expect(restingFlash(gone, NOW + 900)).toBe(0);
    expect(restingFill("#7c3aed", 0, 1)).toBe("rgba(124, 58, 237, 1)");
    expect(restingFill("#7c3aed", 0.5, 0.925)).toBe("rgba(163, 117, 242, 0.925)");
    expect(restingFill("#0e9a66", 1, 1)).toBe("rgba(159, 215, 194, 1)");
  });
});

describe("restingUntil", () => {
  it("is when the last bar stops moving: the end of an appearance or of a fade, nothing when all stand still", () => {
    const shown = new Map<string, RestingShown>([
      ["bid:100", { order: order("bid:100"), seenAt: NOW, endedAt: null, drawn: 0 }],
      ["ask:120", { order: order("ask:120"), seenAt: NOW - 60_000, endedAt: NOW - 200, drawn: 0 }],
    ]);
    expect(restingUntil(shown)).toBe(NOW - 200 + RESTING_FADE_MS);
    shown.delete("ask:120");
    expect(restingUntil(shown)).toBe(NOW + RESTING_APPEAR_MS);
    expect(RESTING_APPEAR_MS).toBeGreaterThan(RESTING_GROW_MS);
    expect(restingUntil(new Map())).toBe(0);
  });
});

describe("layoutResting", () => {
  const yOf = (price: number): number | null => (price > 1_000 ? null : 500 - price);
  const own = () => 0;

  it("puts each bar on its own row, never thinner than 8 px, biggest first with its share of the biggest, and leaves out what is off the pane or gone", () => {
    const shown = new Map<string, RestingShown>([
      ["bid:40", { order: order("bid:40", { size: 31 }), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
      ["ask:60", { order: order("ask:60"), seenAt: NOW - 60_000, endedAt: null, drawn: 0 }],
      ["bid:10", { order: order("bid:10"), seenAt: NOW - 60_000, endedAt: NOW - RESTING_FADE_MS, drawn: 0 }],
      ["bid:900", { order: order("bid:900"), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
      ["bid:200", { order: order("bid:200"), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
      ["ask:150", { order: order("ask:150"), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
      ["ask:70", { order: order("ask:70", { size: 62 }), seenAt: NOW - 100, endedAt: null, drawn: 0 }],
      ["bid:45", { order: order("bid:45", { size: 5 }), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
    ]);
    const bars = layoutResting(shown, 5, 1, own, yOf, 500, NOW);
    expect(bars.map((bar) => [bar.key, bar.side, bar.size, bar.share, bar.yTop, bar.yBottom])).toEqual([
      ["ask:70", "ask", 62, 1, 500 - 355 - 1.5, 500 - 350 + 1.5],
      ["bid:40", "bid", 31, 0.5, 500 - 205 - 1.5, 500 - 200 + 1.5],
      ["ask:60", "ask", 12, 12 / 62, 500 - 305 - 1.5, 500 - 300 + 1.5],
      ["bid:45", "bid", 5, 5 / 62, 500 - 230 - 1.5, 500 - 225 + 1.5],
    ]);
    expect(bars.map((bar) => bar.alpha)).toEqual([1 / 3, 1, 1, 1]);
    expect(bars.map((bar) => bar.flash)).toEqual([0.9, 0, 0, 0]);
    expect(RESTING_MIN_HEIGHT_PX).toBe(8);
    const thin = layoutResting(shown, 0.5, 1, own, yOf, 500, NOW);
    expect(thin[0].yBottom - thin[0].yTop).toBe(8);
    expect((thin[0].yTop + thin[0].yBottom) / 2).toBeCloseTo(500 - 35.25, 6);
  });

  it("keeps only the largest six on screen", () => {
    const shown = new Map<string, RestingShown>();
    for (let row = 20; row < 30; row += 1) shown.set(`bid:${row}`, { order: order(`bid:${row}`, { size: row }), seenAt: NOW - 1_000, endedAt: null, drawn: 0 });
    const bars = layoutResting(shown, 5, 1, own, yOf, 500, NOW);
    expect(RESTING_SHOWN_MAX).toBe(6);
    expect(bars.map((bar) => bar.size)).toEqual([29, 28, 27, 26, 25, 24]);
    expect(bars.map((bar) => bar.share)).toEqual([1, 28 / 29, 27 / 29, 26 / 29, 25 / 29, 24 / 29]);
    expect(layoutResting(shown, 5, 1, own, yOf, 500, NOW, 2).map((bar) => bar.size)).toEqual([29, 28]);
  });

  it("merges the orders of one band at the chart's zoom into one bar covering the band, sized as the profile shows the band, flashing and fading with its last order", () => {
    const shown = new Map<string, RestingShown>([
      ["bid:40", { order: order("bid:40", { size: 110 }), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
      ["bid:41", { order: order("bid:41", { size: 0, peak: 190 }), seenAt: NOW - 5_000, endedAt: NOW - 100, drawn: 0 }],
      ["bid:42", { order: order("bid:42", { size: 0, peak: 10 }), seenAt: NOW - 5_000, endedAt: NOW - 250, drawn: 0 }],
      ["bid:44", { order: order("bid:44", { size: 20 }), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
      ["ask:41", { order: order("ask:41", { size: 30 }), seenAt: NOW - 1_000, endedAt: null, drawn: 0 }],
    ]);
    const bands = new Map([["bid:10", 320], ["ask:10", 30]]);
    const bars = layoutResting(shown, 5, 4, (side, band) => bands.get(`${side}:${band}`) ?? 0, yOf, 500, NOW);
    expect(bars.map((bar) => [bar.key, bar.side, bar.size, bar.share, bar.yTop, bar.yBottom, bar.alpha])).toEqual([
      ["bid:10", "bid", 320, 1, 500 - 220, 500 - 200, 1],
      ["ask:10", "ask", 30, 30 / 320, 500 - 220, 500 - 200, 1],
      ["bid:11", "bid", 20, 20 / 320, 500 - 240, 500 - 220, 1],
    ]);
    expect(bars.map((bar) => bar.flash)).toEqual([1 - 100 / RESTING_FLASH_MS, 0, 0]);
    expect(layoutResting(shown, 5, 4, () => 0, yOf, 500, NOW).map((bar) => [bar.key, bar.size])).toEqual([["bid:10", 310], ["ask:10", 30], ["bid:11", 20]]);
    expect(layoutResting(shown, 5, 4, () => 0, yOf, 500, NOW + 500).map((bar) => [bar.key, bar.alpha, bar.flash])).toEqual([["bid:10", 1, 0], ["ask:10", 1, 0], ["bid:11", 1, 0]]);
    expect(layoutResting(shown, 5, 4, () => 0, yOf, 500, NOW + 500).find((bar) => bar.key === "bid:10")?.size).toBe(310);
    expect(layoutResting(shown, 5, 4, () => 0, yOf, 500, NOW + 2_000).find((bar) => bar.key === "bid:10")).toMatchObject({ share: 1, alpha: 1, size: 110 });
  });

  it("remembers on each order the size its bar was drawn at, holds a band there while its orders are on their way out, and fades it there once they have gone, never at what the profile has left", () => {
    const shown = new Map<string, RestingShown>([
      ["ask:80", { order: order("ask:80", { size: 40, peak: 40 }), seenAt: NOW - 5_000, endedAt: null, drawn: 0 }],
      ["ask:81", { order: order("ask:81", { size: 25, peak: 25 }), seenAt: NOW - 5_000, endedAt: null, drawn: 0 }],
      ["ask:85", { order: order("ask:85", { size: 3, peak: 3 }), seenAt: NOW - 5_000, endedAt: null, drawn: 0 }],
    ]);
    expect(layoutResting(shown, 5, 4, () => 90, yOf, 500, NOW).map((bar) => [bar.key, bar.size])).toEqual([["ask:20", 90], ["ask:21", 90]]);
    expect([...shown.values()].map((entry) => entry.drawn)).toEqual([90, 90, 90]);
    shown.get("ask:80")!.order = order("ask:80", { size: 1, peak: 40, ending: true });
    expect(layoutResting(shown, 5, 4, () => 95, yOf, 500, NOW).map((bar) => [bar.key, bar.size])).toEqual([["ask:20", 95], ["ask:21", 95]]);
    shown.get("ask:81")!.order = order("ask:81", { size: 2, peak: 25, ending: true });
    expect(layoutResting(shown, 5, 4, () => 7, yOf, 500, NOW).map((bar) => [bar.key, bar.size, bar.alpha, bar.flash])).toEqual([["ask:20", 95, 1, 0], ["ask:21", 7, 1, 0]]);
    expect(shown.get("ask:80")!.drawn).toBe(95);
    shown.get("ask:80")!.order = order("ask:80", { size: 0, peak: 40 });
    shown.get("ask:80")!.endedAt = NOW - 500;
    shown.get("ask:81")!.order = order("ask:81", { size: 2, peak: 25 });
    shown.get("ask:81")!.endedAt = NOW - 500;
    const bars = layoutResting(shown, 5, 4, () => 7, yOf, 500, NOW);
    expect(bars.map((bar) => [bar.key, bar.size, bar.share])).toEqual([["ask:20", 95, 1], ["ask:21", 7, 7 / 95]]);
    expect(shown.get("ask:85")!.drawn).toBe(7);
    expect(shown.get("ask:80")!.drawn).toBe(95);
    shown.get("ask:80")!.drawn = 0;
    expect(layoutResting(shown, 5, 4, () => 7, yOf, 500, NOW).map((bar) => [bar.key, bar.size])).toEqual([["ask:20", 95], ["ask:21", 7]]);
  });

  it("keeps a bar whose order is going or gone on screen at its place until it has faded, outside the count of the largest six, and shows nothing for an order that ended before its bar was ever drawn", () => {
    const shown = new Map<string, RestingShown>();
    for (let row = 20; row < 28; row += 1) shown.set(`bid:${row}`, { order: order(`bid:${row}`, { size: 100 + row }), seenAt: NOW - 1_000, endedAt: null, drawn: 0 });
    layoutResting(shown, 5, 1, own, yOf, 500, NOW);
    expect([...shown.values()].map((entry) => entry.drawn)).toEqual([0, 0, 122, 123, 124, 125, 126, 127]);
    shown.get("bid:22")!.order = order("bid:22", { size: 0, peak: 122, ending: true });
    shown.get("bid:20")!.order = order("bid:20", { size: 0, peak: 120 });
    shown.get("bid:20")!.endedAt = NOW;
    const going = layoutResting(shown, 5, 1, own, yOf, 500, NOW + 100);
    expect(going.map((bar) => [bar.key, bar.size, bar.flash, bar.alpha])).toEqual([
      ["bid:27", 127, 0, 1],
      ["bid:26", 126, 0, 1],
      ["bid:25", 125, 0, 1],
      ["bid:24", 124, 0, 1],
      ["bid:23", 123, 0, 1],
      ["bid:22", 122, 0, 1],
      ["bid:21", 121, 0, 1],
    ]);
    shown.get("bid:22")!.order = order("bid:22", { size: 0, peak: 122 });
    shown.get("bid:22")!.endedAt = NOW + 100;
    const gone = layoutResting(shown, 5, 1, own, yOf, 500, NOW + 200);
    expect(gone.map((bar) => [bar.key, bar.size, bar.flash, bar.alpha])).toEqual([
      ["bid:27", 127, 0, 1],
      ["bid:26", 126, 0, 1],
      ["bid:25", 125, 0, 1],
      ["bid:24", 124, 0, 1],
      ["bid:23", 123, 0, 1],
      ["bid:22", 122, 1 - 100 / RESTING_FLASH_MS, 1 - 100 / RESTING_FADE_MS],
      ["bid:21", 121, 0, 1],
    ]);
    expect(layoutResting(shown, 5, 1, own, yOf, 500, NOW + 100 + RESTING_FADE_MS).map((bar) => bar.key)).toEqual(["bid:27", "bid:26", "bid:25", "bid:24", "bid:23", "bid:21"]);
  });
});
