// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LABEL_CHAR_EM, LABEL_PAD_PX } from "../../live-delta-profile/deltaProfileLayout";
import { MIN_LABEL_FONT_PX } from "../../axis-profile/axisProfileLayout";
import { ZOOMED_OUT_REACH, bookBarPx, bookColumnPx, bookLabels, bookRowsReadable, bookStubPx, layoutBook, spreadPrice, type BookBar } from "../bookProfileLayout";
import type { BookRow } from "../bookProfileSource";

const yOf = (price: number): number | null => (price > 1_000 ? null : 500 - price);

describe("layoutBook", () => {
  it("places one bar per band in view, sized against the biggest in view, bids and asks apart", () => {
    const bands: BookRow[] = [
      { index: 10, price: 100, priceTo: 110, bid: 40, ask: 0 },
      { index: 11, price: 110, priceTo: 120, bid: 0, ask: 10 },
      { index: 12, price: 120, priceTo: 130, bid: 0, ask: 5 },
    ];
    expect(layoutBook(bands, yOf, 500)).toEqual([
      { index: 20, yTop: 390, yBottom: 400, side: "bid", size: 40, share: 1 },
      { index: 23, yTop: 380, yBottom: 390, side: "ask", size: 10, share: 0.25 },
      { index: 25, yTop: 370, yBottom: 380, side: "ask", size: 5, share: 0.125 },
    ]);
  });

  it("splits a band the spread sits in: the bid on its lower half, the ask on its upper half", () => {
    const bands: BookRow[] = [{ index: 10, price: 100, priceTo: 110, bid: 8, ask: 2 }];
    expect(layoutBook(bands, yOf, 500)).toEqual([
      { index: 20, yTop: 395, yBottom: 400, side: "bid", size: 8, share: 1 },
      { index: 21, yTop: 390, yBottom: 395, side: "ask", size: 2, share: 0.25 },
    ]);
  });

  it("leaves out what is off the pane and what the chart cannot place, and gives no share when nothing is in view", () => {
    const bands: BookRow[] = [
      { index: 10, price: 100, priceTo: 110, bid: 40, ask: 0 },
      { index: 60, price: 600, priceTo: 610, bid: 90, ask: 0 },
      { index: 200, price: 2_000, priceTo: 2_010, bid: 0, ask: 900 },
      { index: 99, price: 995, priceTo: 1_005, bid: 0, ask: 900 },
    ];
    expect(layoutBook(bands, yOf, 500).map((bar) => [bar.index, bar.share])).toEqual([[20, 1]]);
    expect(layoutBook([], yOf, 500)).toEqual([]);
  });
});

describe("bookLabels", () => {
  const row = (index: number, yTop: number, size: number, height = 2): BookBar => ({ index, yTop, yBottom: yTop + height, side: "bid", size, share: 0 });

  it("numbers every row that is tall enough for one", () => {
    const bars = layoutBook([
      { index: 10, price: 100, priceTo: 110, bid: 40, ask: 0 },
      { index: 11, price: 110, priceTo: 120, bid: 0, ask: 10 },
      { index: 12, price: 120, priceTo: 130, bid: 0, ask: 5 },
    ], yOf, 500);
    expect(bookLabels(bars, 8)).toEqual(bars);
    expect(bookLabels(bars, 10).map((bar) => bar.index)).toEqual([20, 23, 25]);
  });

  it("on rows thinner than a number gives the numbers to the biggest rows first, the lower index on a tie, in the rows' own order, never two overlapping", () => {
    const bars = [row(1, 0, 5), row(2, 2, 9), row(3, 4, 1), row(4, 6, 9), row(5, 8, 2), row(6, 20, 1)];
    expect(bookLabels(bars, 8).map((bar) => bar.index)).toEqual([2, 6]);
    expect(bookLabels([row(1, 3, 1), row(2, 11, 1)], 8).map((bar) => bar.index)).toEqual([1, 2]);
    expect(bookLabels([row(1, 3, 1), row(2, 10.9, 2)], 8).map((bar) => bar.index)).toEqual([2]);
    expect(bookLabels([], 8)).toEqual([]);
  });
});

describe("spreadPrice", () => {
  it("is the middle of the gap between the best bid and the best ask, null while a side is missing", () => {
    expect(spreadPrice({ bidRow: 102, askRow: 105 }, 2)).toBe(208);
    expect(spreadPrice({ bidRow: 102, askRow: 103 }, 2)).toBe(206);
    expect(spreadPrice({ bidRow: null, askRow: 103 }, 2)).toBeNull();
    expect(spreadPrice({ bidRow: 102, askRow: null }, 2)).toBeNull();
  });
});

describe("the zoomed-out column", () => {
  it("rows are readable from the height that fits the smallest number, the same line the numbers use", () => {
    expect(bookRowsReadable(MIN_LABEL_FONT_PX + 2)).toBe(true);
    expect(bookRowsReadable(MIN_LABEL_FONT_PX + 1.99)).toBe(false);
    expect(bookRowsReadable(32)).toBe(true);
    expect(bookRowsReadable(0)).toBe(false);
  });

  it("scales the column down gradually with the row height, from the full room at the readable line to a third of it, never less, and every level keeps at least the stub, three characters wide at the font", () => {
    expect(bookStubPx(8)).toBe(bookBarPx(0.001, 500, "123", 8));
    expect(bookStubPx(11)).toBe(bookBarPx(0.001, 500, "999", 11));
    expect(bookStubPx(8)).toBeLessThan(bookStubPx(11));
    expect(ZOOMED_OUT_REACH).toBe(1 / 3);
    expect(bookColumnPx(1, 300, 8, 10)).toBe(300);
    expect(bookColumnPx(1, 300, 8, 5)).toBe(150);
    expect(bookColumnPx(1, 300, 8, 4)).toBe(120);
    expect(bookColumnPx(1, 300, 8, 2)).toBe(100);
    expect(bookColumnPx(1, 300, 8, 0.5)).toBe(100);
    expect(bookColumnPx(0.5, 300, 8, 5)).toBe(75);
    expect(bookColumnPx(0.1, 300, 8, 5)).toBe(bookStubPx(8));
    expect(bookColumnPx(0, 300, 8, 5)).toBe(0);
    expect(bookColumnPx(1, 10, 8, 5)).toBe(10);
  });
});

describe("bookBarPx", () => {
  it("is the bar's share of the room, but never narrower than its number, so every level with size shows as a bar wide enough for it; nothing without size", () => {
    expect(bookBarPx(0.5, 200, "100", 11)).toBe(100);
    expect(bookBarPx(0.001, 200, "7", 11)).toBe(Math.ceil(LABEL_CHAR_EM * 11 + LABEL_PAD_PX));
    expect(bookBarPx(0.001, 200, "123", 8)).toBe(Math.ceil(3 * LABEL_CHAR_EM * 8 + LABEL_PAD_PX));
    expect(bookBarPx(0.05, 200, "12", 11)).toBe(Math.ceil(2 * LABEL_CHAR_EM * 11 + LABEL_PAD_PX));
    expect(bookBarPx(1, 200, "9", 11)).toBe(200);
    expect(bookBarPx(0, 200, "0", 11)).toBe(0);
    expect(bookBarPx(0.5, 1, "9", 11)).toBe(1);
  });
});
