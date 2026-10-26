const { parseDay } = require("../../../scripts/maintain/audit-dxfeed-order-book-continuity");
const { DAY_MS } = require("../../../src/storage/archive-schedule");

describe("dxFeed offline operational tools", () => {
  test("continuity audit defaults to the last complete UTC day", () => {
    const now = Date.parse("2026-08-31T13:00:00.000Z");
    expect(parseDay(undefined, now)).toBe(Date.parse("2026-08-30T00:00:00.000Z"));
  });

  test("continuity audit accepts only exact UTC calendar dates", () => {
    expect(parseDay("2026-08-30", 0)).toBe(Date.parse("2026-08-30T00:00:00.000Z"));
    expect(() => parseDay("2026-08-30T01:00:00Z", 0)).toThrow(/YYYY-MM-DD/);
    expect(DAY_MS).toBe(86_400_000);
  });
});
