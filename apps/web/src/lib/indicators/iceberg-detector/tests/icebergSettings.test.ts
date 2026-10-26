import { describe, expect, it } from "vitest";
import type { IcebergOrder } from "../../../../types/frames";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";
import {
  DAY_MS,
  DEFAULT_ICEBERG_SETTINGS,
  ICEBERG_HISTORY_OPTIONS,
  ICEBERG_SETTINGS_REVISION,
  compactIcebergSize,
  formatIcebergSize,
  icebergCardTextOf,
  icebergColorOf,
  icebergHistoryDaysOf,
  icebergMarkScaleOf,
  icebergShapeOf,
  icebergPlacementOf,
  ICEBERG_PLACEMENTS,
  icebergSizeTopPercentOf,
  icebergHistoryFromText,
  icebergTotalOf,
  shownIcebergs, biggestPerCandle, icebergMinTranchesOf } from "../icebergSettings";

function iceberg(overrides: Partial<IcebergOrder> = {}): IcebergOrder {
  return {
    id: "a", kind: "native", confidence: "certain", origin: "runtime", side: "bid", price: 31188, display: 10, tranches: 3, executed: 32,
    startedAt: 1000, markedAt: 1500, updatedAt: 2000, status: "filled", ...overrides,
  };
}

describe("iceberg settings", () => {
  it("offers off and three spans, defaults to off, and reads anything else saved as the default", () => {
    expect(ICEBERG_HISTORY_OPTIONS.map(([days]) => days)).toEqual([0, 1, 3, 5]);
    expect(icebergHistoryDaysOf(undefined)).toBe(0);
    expect(icebergHistoryDaysOf({ historyDays: 1 })).toBe(1);
    expect(icebergHistoryDaysOf({ historyDays: 5 })).toBe(5);
    expect(icebergHistoryDaysOf({ historyDays: 7 })).toBe(0);
    expect(icebergHistoryDaysOf({ historyDays: Number.NaN })).toBe(0);
  });

  it("colours follow the heatmap's sides until the trader picks his own, and the scale is bounded", () => {
    expect(icebergColorOf(undefined, "bid")).toBe(DEFAULT_LIQUIDITY_SETTINGS.bidColor);
    expect(icebergColorOf({ askColor: "#ff8800" }, "ask")).toBe("#ff8800");
    expect(icebergColorOf({ askColor: "" }, "ask")).toBe(DEFAULT_LIQUIDITY_SETTINGS.askColor);
    expect(icebergMarkScaleOf(undefined)).toBe(1);
    expect(icebergMarkScaleOf({ markScale: 2 })).toBe(2);
    expect(icebergMarkScaleOf({ markScale: 9 })).toBe(3);
    expect(icebergMarkScaleOf({ markScale: -1 })).toBe(1);
    expect(DEFAULT_ICEBERG_SETTINGS).toMatchObject({ historyDays: 0, showPulled: true, labels: true, markScale: 1, sizeTopPercent: 20, markShape: "auto", minTranches: 2, revision: ICEBERG_SETTINGS_REVISION });
    expect(ICEBERG_SETTINGS_REVISION).toBe(2);
    expect(DEFAULT_ICEBERG_SETTINGS).not.toHaveProperty("showWeak");
  });

  it("a native iceberg's total is its clip times the exchange's refill count, never less than what traded through it", () => {
    const native = (fields: { display: number; tranches: number; executed: number }) => icebergTotalOf({ kind: "native", ...fields });
    expect(native({ display: 10, tranches: 4, executed: 32 })).toEqual({ total: 40, perOrder: 10, orders: 4 });
    expect(native({ display: 2, tranches: 80, executed: 160 })).toEqual({ total: 160, perOrder: 2, orders: 80 });
    expect(native({ display: 10, tranches: 3, executed: 32 })).toEqual({ total: 40, perOrder: 10, orders: 4 });
    expect(native({ display: 10, tranches: 2, executed: 20 })).toEqual({ total: 20, perOrder: 10, orders: 2 });
    expect(native({ display: 3, tranches: 1, executed: 9.000000000000002 })).toEqual({ total: 9, perOrder: 3, orders: 3 });
    expect(native({ display: 0, tranches: 2, executed: 5 })).toEqual({ total: 5, perOrder: 0, orders: 2 });
    expect(native({ display: 3.365, tranches: 23, executed: 7.005 })).toMatchObject({ perOrder: 3.365, orders: 23 });
    expect(native({ display: 3.365, tranches: 23, executed: 7.005 }).total).toBeCloseTo(77.395, 9);
  });

  it("a probable iceberg's orders are what traded divided by the size shown, rounded up: the 100 ms refill count is only a hint", () => {
    const probable = (fields: { display: number; tranches: number; executed: number }) => icebergTotalOf({ kind: "probable", ...fields });
    expect(probable({ display: 3.365, tranches: 23, executed: 7.005 })).toEqual({ total: 10.095, perOrder: 3.365, orders: 3 });
    expect(probable({ display: 16.227, tranches: 3, executed: 40.045 })).toEqual({ total: 48.681, perOrder: 16.227, orders: 3 });
    expect(probable({ display: 5.266, tranches: 3, executed: 8.939 }).orders).toBe(2);
    expect(probable({ display: 5.266, tranches: 3, executed: 8.939 }).total).toBeCloseTo(10.532, 9);
    expect(probable({ display: 10, tranches: 5, executed: 1 })).toEqual({ total: 10, perOrder: 10, orders: 1 });
    expect(probable({ display: 10, tranches: 5, executed: 0 })).toEqual({ total: 10, perOrder: 10, orders: 1 });
    expect(probable({ display: 0, tranches: 7, executed: 5 })).toEqual({ total: 5, perOrder: 0, orders: 1 });
  });

  it("the card writes the total, then size per order times orders in brackets: lots whole, coins to three significant digits", () => {
    expect(icebergCardTextOf({ kind: "native", display: 2, tranches: 80, executed: 160 })).toEqual({ total: "160", breakdown: "(2 × 80)" });
    expect(icebergCardTextOf({ kind: "probable", display: 5.266, tranches: 3, executed: 8.939 })).toEqual({ total: "10.5", breakdown: "(5.27 × 2)" });
    expect(icebergCardTextOf({ kind: "native", display: 5.266, tranches: 3, executed: 8.939 })).toEqual({ total: "15.8", breakdown: "(5.27 × 3)" });
    expect(icebergCardTextOf({ kind: "probable", display: 38, tranches: 2, executed: 697.14 })).toEqual({ total: "722", breakdown: "(38 × 19)" });
    expect(icebergCardTextOf({ kind: "probable", display: 0.255, tranches: 1, executed: 0.9 })).toEqual({ total: "1.02", breakdown: "(0.255 × 4)" });
    expect(icebergCardTextOf({ kind: "probable", display: 3.365, tranches: 23, executed: 7.005 })).toEqual({ total: "10.1", breakdown: "(3.37 × 3)" });
    for (const [display, orders] of [[10.05, 3], [11.023, 4], [152.347, 12], [0.0034, 7], [5.266, 3]] as const) {
      const text = icebergCardTextOf({ kind: "native", display, tranches: orders, executed: 0 });
      const [, per, count] = /^\((\S+) × (\d+)\)$/.exec(text.breakdown)!;
      expect(Number(count)).toBe(orders);
      expect(text.total).toBe(compactIcebergSize(Number(per) * orders));
    }
    expect(icebergCardTextOf({ kind: "native", display: 11.023, tranches: 4, executed: 37.436 })).toEqual({ total: "44", breakdown: "(11 × 4)" });
    expect(compactIcebergSize(9.996)).toBe("10");
    expect(compactIcebergSize(99.96)).toBe("100");
    expect(compactIcebergSize(4.974)).toBe("4.97");
    expect(compactIcebergSize(0.0034)).toBe("0.0034");
    expect(compactIcebergSize(Number.NaN)).toBe("0");
    expect(compactIcebergSize(1e-7)).toBe("0");
    expect(formatIcebergSize(0.5)).toBe("0.5");
    expect(formatIcebergSize(37.436)).toBe("37.4");
    expect(formatIcebergSize(697.14)).toBe("697");
    expect(formatIcebergSize(Number.NaN)).toBe("0");
  });

  it("the mark shape is the trader's pick of dot, triangle or circle; left on auto, a native iceberg is a dot and a probable one a circle", () => {
    expect(icebergShapeOf(undefined, "native")).toBe("dot");
    expect(ICEBERG_PLACEMENTS.map(([placement]) => placement)).toEqual(["price", "candle"]);
    expect(icebergPlacementOf(undefined)).toBe("price");
    expect(icebergPlacementOf({})).toBe("price");
    expect(icebergPlacementOf({ placement: "candle" })).toBe("candle");
    expect(icebergPlacementOf({ placement: "price" })).toBe("price");
    expect(icebergPlacementOf({ placement: "wick" })).toBe("price");
    expect(DEFAULT_ICEBERG_SETTINGS.placement).toBe("price");
    expect(icebergShapeOf(undefined, "probable")).toBe("circle");
    expect(icebergShapeOf({ markShape: "auto" }, "native")).toBe("dot");
    expect(icebergShapeOf({ markShape: "triangle" }, "native")).toBe("triangle");
    expect(icebergShapeOf({ markShape: "dot" }, "probable")).toBe("dot");
    expect(icebergShapeOf({ markShape: "circle" }, "native")).toBe("circle");
    expect(icebergShapeOf({ markShape: "hexagon" }, "probable")).toBe("circle");
  });

  it("the size slider is a whole percentage from 1 to 100, and anything unreadable shows them all", () => {
    expect(icebergSizeTopPercentOf(undefined)).toBe(100);
    expect(icebergSizeTopPercentOf({ sizeTopPercent: 25 })).toBe(25);
    expect(icebergSizeTopPercentOf({ sizeTopPercent: 33.4 })).toBe(33);
    expect(icebergSizeTopPercentOf({ sizeTopPercent: 0 })).toBe(1);
    expect(icebergSizeTopPercentOf({ sizeTopPercent: 150 })).toBe(100);
    expect(icebergSizeTopPercentOf({ sizeTopPercent: Number.NaN })).toBe(100);
  });

  it("the legend says where the watched history starts, as month-day hour:minute in UTC, and nothing when nothing was watched", () => {
    expect(icebergHistoryFromText(Date.UTC(2026, 9, 8, 21, 4, 59))).toBe("10-08 21:04 UTC");
    expect(icebergHistoryFromText(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("01-01 00:00 UTC");
    expect(icebergHistoryFromText(null)).toBe("");
  });

  describe("what is shown", () => {
    const now = 10 * DAY_MS;
    const live = iceberg({ id: "live", status: "active", markedAt: now - 8 * DAY_MS });
    const today = iceberg({ id: "today", markedAt: now - 1000 });
    const twoDays = iceberg({ id: "two", markedAt: now - 2 * DAY_MS });
    const fourDays = iceberg({ id: "four", markedAt: now - 4 * DAY_MS });
    const pulled = iceberg({ id: "pulled", status: "pulled", markedAt: now - 1000 });
    const weak = iceberg({ id: "weak", kind: "probable", confidence: "weak", origin: "runtime", status: "ended", markedAt: now - 1000 });
    const list = [live, today, twoDays, fourDays, pulled, weak];

    it("a live iceberg is always shown, however old its mark; settled ones only inside the span", () => {
      expect(shownIcebergs(list, { historyDays: 1 }, now).map((entry) => entry.id)).toEqual(["live", "today", "weak"]);
      expect(shownIcebergs(list, { historyDays: 3 }, now).map((entry) => entry.id)).toEqual(["live", "today", "two", "weak"]);
      expect(shownIcebergs(list, { historyDays: 5 }, now).map((entry) => entry.id)).toEqual(["live", "today", "two", "four", "weak"]);
    });

    it("off is like absorption: the runtime's own icebergs marked since this runtime started, a live one too, nothing from the host and nothing from before the start; a span shows both inside its days", () => {
      const since = now - 2 * DAY_MS - 1;
      const hosted = iceberg({ id: "hosted", markedAt: now - 1000, origin: "host" });
      const before = iceberg({ id: "before", markedAt: since - 1 });
      const atStart = iceberg({ id: "at-start", markedAt: since });
      expect(shownIcebergs([...list, hosted, before, atStart], { historyDays: 0 }, now, since).map((entry) => entry.id)).toEqual(["live", "today", "two", "weak", "at-start"]);
      expect(shownIcebergs([...list, hosted, before, atStart], { historyDays: 0, showPulled: true }, now, since).map((entry) => entry.id)).toEqual(["live", "today", "two", "pulled", "weak", "at-start"]);
      expect(shownIcebergs([...list, hosted, before, atStart], { historyDays: 0 }, now, null).map((entry) => entry.id)).toEqual(["live"]);
      expect(shownIcebergs([...list, hosted, before, atStart], { historyDays: 1 }, now, since).map((entry) => entry.id)).toEqual(["live", "today", "weak", "hosted"]);
    });

    it("the refills slider hides an iceberg whose card prints a smaller ×N than asked, the N in (size × N), live ones too; it reads 1 to 10 and 2 by default", () => {
      expect(icebergMinTranchesOf(undefined)).toBe(2);
      expect(icebergMinTranchesOf({ minTranches: 1 })).toBe(1);
      expect(icebergMinTranchesOf({ minTranches: 10 })).toBe(10);
      expect(icebergMinTranchesOf({ minTranches: 0 })).toBe(1);
      expect(icebergMinTranchesOf({ minTranches: 11 })).toBe(10);
      expect(icebergMinTranchesOf({ minTranches: 2.5 })).toBe(2);
      expect(icebergMinTranchesOf({ minTranches: Number.NaN })).toBe(2);
      const nativeFour = iceberg({ id: "native-four", display: 10, tranches: 2, executed: 32, markedAt: now - 1000 });
      const probableNine = iceberg({ id: "probable-nine", kind: "probable", confidence: "strong", display: 1.545, tranches: 2, executed: 12.475, markedAt: now - 1000 });
      const probableThree = iceberg({ id: "probable-three", kind: "probable", confidence: "strong", display: 3.365, tranches: 23, executed: 7.005, markedAt: now - 1000 });
      const liveOnce = iceberg({ id: "live-once", kind: "probable", confidence: "strong", display: 10, tranches: 5, executed: 1, status: "active" });
      const marks = [nativeFour, probableNine, probableThree, liveOnce];
      expect(marks.map((entry) => icebergCardTextOf(entry).breakdown)).toEqual(["(10 × 4)", "(1.54 × 9)", "(3.37 × 3)", "(10 × 1)"]);
      const ids = (minTranches?: number) => shownIcebergs(marks, { historyDays: 1, minTranches }, now).map((entry) => entry.id);
      expect(ids()).toEqual(["native-four", "probable-nine", "probable-three"]);
      expect(ids(1)).toEqual(["native-four", "probable-nine", "probable-three", "live-once"]);
      expect(ids(4)).toEqual(["native-four", "probable-nine"]);
      expect(ids(5)).toEqual(["probable-nine"]);
      expect(ids(10)).toEqual([]);
      for (let floor = 1; floor <= 10; floor += 1) {
        for (const entry of marks) expect(ids(floor).includes(entry.id)).toBe(Number(/× (\d+)\)$/.exec(icebergCardTextOf(entry).breakdown)![1]) >= floor);
      }
    });

    it("from the hour up, one iceberg a candle: the biggest by total, ties by what traded then the newest; below the hour every iceberg stays; a mark without a candle stays", () => {
      const hour = 3_600_000;
      const open = (ts: number) => (ts < 0 ? null : Math.floor(ts / hour) * hour);
      const a = iceberg({ id: "a", markedAt: 10 * hour + 1, display: 10, tranches: 2, executed: 20 });
      const b = iceberg({ id: "b", markedAt: 10 * hour + 2, display: 10, tranches: 3, executed: 30 });
      const c = iceberg({ id: "c", markedAt: 10 * hour + 5, display: 10, tranches: 3, executed: 29 });
      const d = iceberg({ id: "d", markedAt: 11 * hour + 1, display: 1, tranches: 2, executed: 2 });
      const e = iceberg({ id: "e", markedAt: 10 * hour + 4, display: 10, tranches: 3, executed: 30 });
      const orphan = iceberg({ id: "orphan", markedAt: -5, display: 1, tranches: 2, executed: 1 });
      expect(biggestPerCandle([a, b, c, d, e, orphan], hour, open).map((entry) => entry.id)).toEqual(["d", "e", "orphan"]);
      expect(biggestPerCandle([a, b, c, d, e, orphan], 4 * hour, open).map((entry) => entry.id)).toEqual(["d", "e", "orphan"]);
      expect(biggestPerCandle([a, b, c, d, e, orphan], hour - 1, open).map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e", "orphan"]);
      expect(biggestPerCandle([], hour, open)).toEqual([]);
    });

    it("the size slider keeps exactly the biggest share by total, ties broken by what traded then by age, at least one, after the other filters", () => {
      const sized = [10, 20, 30, 40, 50].map((total, index) => iceberg({ id: `t${total}`, display: 10, tranches: total / 10, executed: total - 1, markedAt: now - 1000 - index }));
      const ids = (top: number, extra: IcebergOrder[] = []) => shownIcebergs([...sized, ...extra], { historyDays: 1, sizeTopPercent: top, minTranches: 1 }, now).map((entry) => entry.id);
      expect(ids(100)).toEqual(["t10", "t20", "t30", "t40", "t50"]);
      expect(ids(50)).toEqual(["t30", "t40", "t50"]);
      expect(ids(40)).toEqual(["t40", "t50"]);
      expect(ids(20)).toEqual(["t50"]);
      expect(ids(1)).toEqual(["t50"]);
      expect(ids(33, [iceberg({ id: "tie", display: 10, tranches: 4, executed: 39, markedAt: now - 10 })])).toEqual(["t50", "tie"]);
      expect(ids(33, [iceberg({ id: "tie", display: 10, tranches: 4, executed: 38, markedAt: now - 10 })])).toEqual(["t40", "t50"]);
      expect(ids(40, [iceberg({ id: "tie", display: 10, tranches: 4, executed: 39, markedAt: now - 10 })])).toEqual(["t40", "t50", "tie"]);
      expect(ids(20, [iceberg({ id: "huge", status: "pulled", display: 10, tranches: 90, executed: 900, markedAt: now - 10 })])).toEqual(["t50"]);
      const lots = [40, 40, 40, 40, 40, 40, 30, 30, 30, 20].map((total, index) => iceberg({ id: `n${index}`, display: 10, tranches: total / 10, executed: total - 2, markedAt: now - 1000 - index }));
      const nq = (top: number) => shownIcebergs(lots, { historyDays: 1, sizeTopPercent: top, minTranches: 1 }, now).map((entry) => entry.id);
      expect(nq(10)).toEqual(["n0"]);
      expect(nq(50)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
      expect(nq(70)).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "n6"]);
    });

    it("a span only adds to what off shows: the live window and the older history are ranked apart by the size share, so bigger old marks never push out a live one", () => {
      const since = now - 4 * 3_600_000;
      const liveBig = iceberg({ id: "live-big", markedAt: since + 1000, display: 10, tranches: 2, executed: 20 });
      const liveSmall = iceberg({ id: "live-small", markedAt: since + 2000, display: 5, tranches: 2, executed: 10 });
      const oldHuge = iceberg({ id: "old-huge", markedAt: since - 1000, display: 20, tranches: 2, executed: 40 });
      const oldBig = iceberg({ id: "old-big", markedAt: since - 2000, display: 15, tranches: 2, executed: 30 });
      const oldMid = iceberg({ id: "old-mid", markedAt: since - 3000, display: 12, tranches: 2, executed: 24 });
      const hosted = iceberg({ id: "host", origin: "host", markedAt: since + 3000, display: 50, tranches: 2, executed: 100 });
      const marks = [oldMid, oldBig, oldHuge, liveBig, liveSmall, hosted];
      const ids = (days: number, list: IcebergOrder[] = marks) => shownIcebergs(list, { historyDays: days, sizeTopPercent: 50, showPulled: false }, now, since).map((entry) => entry.id);
      expect(ids(0)).toEqual(["live-big"]);
      expect(ids(1)).toEqual(["old-huge", "live-big", "host"]);
      for (const days of [1, 3, 5]) expect(ids(days)).toEqual(expect.arrayContaining(ids(0)));
      const stillRefilling = iceberg({ id: "still", status: "active", markedAt: since - 9000, display: 1, tranches: 2, executed: 2 });
      expect(ids(0, [stillRefilling, oldHuge])).toEqual(["still"]);
      expect(ids(1, [stillRefilling, oldHuge])).toEqual(["still", "old-huge"]);
    });

    it("drawn, a span only adds below the hour; from the hour up a candle keeps the biggest of everything shown, so a span can replace a smaller live mark in its candle", () => {
      const hour = 3_600_000;
      const minute = 60_000;
      const since = now - 3 * hour - 23 * minute;
      const older = iceberg({ id: "older", markedAt: since - 10 * minute, display: 20, tranches: 2, executed: 40 });
      const live = iceberg({ id: "live", markedAt: since + 5 * minute, display: 10, tranches: 2, executed: 20 });
      const drawn = (days: number, intervalMs: number) =>
        biggestPerCandle(shownIcebergs([older, live], { historyDays: days, sizeTopPercent: 20 }, now, since), intervalMs, (ts) => Math.floor(ts / intervalMs) * intervalMs).map((entry) => entry.id);
      for (const intervalMs of [minute, 5 * minute, 15 * minute]) {
        expect(drawn(0, intervalMs)).toEqual(["live"]);
        expect(drawn(1, intervalMs)).toEqual(["older", "live"]);
      }
      for (const intervalMs of [hour, 4 * hour, DAY_MS]) {
        expect(drawn(0, intervalMs)).toEqual(["live"]);
        expect(drawn(1, intervalMs)).toEqual(["older"]);
      }
    });

    it("a pulled one appears only when asked for; a weak one always shows, there is no switch for it", () => {
      expect(shownIcebergs(list, { historyDays: 1, showPulled: true }, now).map((entry) => entry.id)).toEqual(["live", "today", "pulled", "weak"]);
      expect(shownIcebergs(list, { historyDays: 1, showPulled: false }, now).map((entry) => entry.id)).toEqual(["live", "today", "weak"]);
    });
  });
});
