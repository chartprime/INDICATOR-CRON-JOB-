const { dayStartMs } = require("../../src/storage/archive-schedule");

describe("dayStartMs", () => {
  test("floors to the start of the UTC calendar day", () => {
    expect(dayStartMs(Date.UTC(2026, 0, 15, 13, 45, 30))).toBe(Date.UTC(2026, 0, 15));
    expect(dayStartMs(Date.UTC(2026, 0, 15, 0, 0, 0))).toBe(Date.UTC(2026, 0, 15));
    expect(dayStartMs(Date.UTC(2026, 0, 15, 23, 59, 59, 999))).toBe(Date.UTC(2026, 0, 15));
  });

  test("rejects a negative or non-integer input", () => {
    expect(() => dayStartMs(-1)).toThrow(/nowMs/);
    expect(() => dayStartMs(1.5)).toThrow(/nowMs/);
  });
});
