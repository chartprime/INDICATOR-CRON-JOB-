const { detectChanges } = require("./l2-change-detector");

function scan(bidZones, askZones = []) {
  return { bidZones, askZones };
}

describe("detectChanges", () => {
  test("every qualifying zone in the very first scan is reported as APPEARED", () => {
    const events = detectChanges(undefined, scan([{ priceBand: 100, size: 50 }]));
    expect(events).toEqual([
      { priceBand: 100, sizeBefore: null, sizeAfter: 50, label: "APPEARED", side: "bid" },
    ]);
  });

  test("a zone growing 30% or more is reported as GREW with the exact before/after sizes", () => {
    const previous = scan([{ priceBand: 100, size: 50 }]);
    const current = scan([{ priceBand: 100, size: 70 }]); // +40%
    expect(detectChanges(previous, current)).toEqual([
      { priceBand: 100, sizeBefore: 50, sizeAfter: 70, label: "GREW", side: "bid" },
    ]);
  });

  test("a zone shrinking 30% or more is reported as SHRANK", () => {
    const previous = scan([{ priceBand: 100, size: 50 }]);
    const current = scan([{ priceBand: 100, size: 30 }]); // -40%
    expect(detectChanges(previous, current)).toEqual([
      { priceBand: 100, sizeBefore: 50, sizeAfter: 30, label: "SHRANK", side: "bid" },
    ]);
  });

  test("a change under the 30% threshold produces no event", () => {
    const previous = scan([{ priceBand: 100, size: 50 }]);
    const current = scan([{ priceBand: 100, size: 55 }]); // +10%
    expect(detectChanges(previous, current)).toEqual([]);
  });

  test("a zone that drops out of the qualifying list is reported as DISAPPEARED", () => {
    const previous = scan([{ priceBand: 100, size: 50 }]);
    const current = scan([]);
    expect(detectChanges(previous, current)).toEqual([
      { priceBand: 100, sizeBefore: 50, sizeAfter: null, label: "DISAPPEARED", side: "bid" },
    ]);
  });

  test("an unchanged zone set between two scans produces no events at all", () => {
    const previous = scan([{ priceBand: 100, size: 50 }], [{ priceBand: 200, size: 60 }]);
    const current = scan([{ priceBand: 100, size: 50 }], [{ priceBand: 200, size: 60 }]);
    expect(detectChanges(previous, current)).toEqual([]);
  });

  test("bid-side and ask-side changes are each labeled with their own side", () => {
    const previous = scan([{ priceBand: 100, size: 50 }], [{ priceBand: 200, size: 50 }]);
    const current = scan([{ priceBand: 100, size: 70 }], [{ priceBand: 200, size: 20 }]);
    const events = detectChanges(previous, current);
    expect(events).toContainEqual({ priceBand: 100, sizeBefore: 50, sizeAfter: 70, label: "GREW", side: "bid" });
    expect(events).toContainEqual({ priceBand: 200, sizeBefore: 50, sizeAfter: 20, label: "SHRANK", side: "ask" });
  });

  test("no current scan (book unavailable) produces no events, even against a real previous scan", () => {
    const previous = scan([{ priceBand: 100, size: 50 }]);
    expect(detectChanges(previous, null)).toEqual([]);
  });
});
