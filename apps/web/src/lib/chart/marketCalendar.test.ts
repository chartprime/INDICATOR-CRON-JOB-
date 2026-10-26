import { describe, expect, it } from "vitest";
import { equitySessionAt, futureSessionOpenAt, inChartSession } from "./marketCalendar";

// Report 57 W1, GE-14: the browser's copy of the governed market calendar.
// The runtime has the full fixture table and a property test comparing the
// two evaluators minute by minute; these are the browser-side anchors.
const at = (iso: string) => Date.parse(iso);

describe("marketCalendar (browser)", () => {
  it.each([
    ["2026-09-23T13:29:00Z", "EXTENDED"],
    ["2026-09-23T13:30:00Z", "REGULAR"],
    ["2026-09-23T20:00:00Z", "EXTENDED"],
    ["2026-11-02T14:29:00Z", "EXTENDED"],
    ["2026-11-02T14:30:00Z", "REGULAR"],
    ["2026-11-26T15:00:00Z", "CLOSED"],
    ["2026-11-27T18:00:00Z", "EXTENDED"],
    ["2026-09-26T15:00:00Z", "CLOSED"],
  ])("%s is %s", (iso, session) => {
    expect(equitySessionAt(at(iso))).toBe(session);
  });

  it("filters equities only, whatever the provider", () => {
    const night = at("2026-09-23T02:00:00Z");
    expect(inChartSession({ assetClass: "EQUITY" }, night)).toBe(false);
    expect(inChartSession({ assetClass: "FUTURE" }, night)).toBe(true);
    expect(inChartSession({}, night)).toBe(true);
  });

  it.each([
    ["2026-09-21T20:59:00Z", true],
    ["2026-09-21T21:30:00Z", false],
    ["2026-09-21T22:00:00Z", true],
    ["2026-09-19T15:00:00Z", false],
    ["2026-09-20T21:59:00Z", false],
    ["2026-09-20T22:00:00Z", true],
    ["2026-11-02T22:30:00Z", false],
    ["2026-11-02T23:00:00Z", true],
  ])("%s future electronic session is %s", (iso, open) => {
    expect(futureSessionOpenAt(at(iso))).toBe(open);
  });
});
