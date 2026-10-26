import { describe, expect, it } from "vitest";
import { formatCountdown } from "../formatCountdown";

describe("formatCountdown", () => {
  it("formats under a minute as M:SS", () => {
    expect(formatCountdown(42_000)).toBe("0:42");
  });

  it("formats minutes and seconds without a leading zero on minutes", () => {
    expect(formatCountdown(12 * 60_000 + 34_000)).toBe("12:34");
  });

  it("formats an hour or more as H:MM:SS", () => {
    expect(formatCountdown(3 * 3_600_000 + 5 * 60_000 + 9_000)).toBe("3:05:09");
  });

  it("rounds up to the next whole second rather than truncating", () => {
    expect(formatCountdown(41_500)).toBe("0:42");
  });

  it("floors at zero rather than going negative once the bar has closed", () => {
    expect(formatCountdown(-500)).toBe("0:00");
  });

  it("formats exactly zero remaining as 0:00", () => {
    expect(formatCountdown(0)).toBe("0:00");
  });

  it("rolls over cleanly at the hour boundary", () => {
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
    expect(formatCountdown(3_599_500)).toBe("1:00:00");
  });
});
