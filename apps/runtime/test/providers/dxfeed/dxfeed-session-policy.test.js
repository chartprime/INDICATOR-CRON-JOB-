const { SESSION_POLICY, classifyDxFeedSession } = require("../../../src/providers/dxfeed/dxfeed-session-policy");

function at(iso) { return Date.parse(iso); }

describe("dxFeed session policy", () => {
  test("names the equity chart policy and keeps the extended-hours label", () => {
    expect(SESSION_POLICY.mode).toBe("EQUITY_CHART_REGULAR_ONLY");
    expect(classifyDxFeedSession("EQUITY", at("2026-09-21T12:00:00Z"))).toBe("EXTENDED"); // 08:00 EDT
    expect(classifyDxFeedSession("EQUITY", at("2026-09-21T14:00:00Z"))).toBe("REGULAR"); // 10:00 EDT
    expect(classifyDxFeedSession("EQUITY", at("2026-09-21T01:00:00Z"))).toBe("CLOSED");
  });

  test("uses IANA DST rules rather than a fixed UTC offset", () => {
    expect(classifyDxFeedSession("EQUITY", at("2026-01-12T14:00:00Z"))).toBe("EXTENDED"); // 09:00 EST
    expect(classifyDxFeedSession("EQUITY", at("2026-07-13T13:00:00Z"))).toBe("EXTENDED"); // 09:00 EDT
    expect(classifyDxFeedSession("EQUITY", at("2026-01-12T15:00:00Z"))).toBe("REGULAR");
    expect(classifyDxFeedSession("EQUITY", at("2026-07-13T14:00:00Z"))).toBe("REGULAR");
  });

  test("names the CME maintenance break and weekend closure", () => {
    expect(classifyDxFeedSession("FUTURE", at("2026-09-21T21:30:00Z"))).toBe("MAINTENANCE"); // 17:30 EDT
    expect(classifyDxFeedSession("FUTURE", at("2026-09-21T22:30:00Z"))).toBe("ELECTRONIC");
    expect(classifyDxFeedSession("FUTURE", at("2026-09-19T15:00:00Z"))).toBe("CLOSED");
  });

  test("rejects unsupported identities and unsafe timestamps", () => {
    expect(() => classifyDxFeedSession("CRYPTO", 1)).toThrow(/asset class/);
    expect(() => classifyDxFeedSession("EQUITY", -1)).toThrow(/timestamp/);
  });
});

describe("dxFeed equity session labels follow the governed market calendar (report 57 W1)", () => {
  test("an exchange holiday is closed all day, not EXTENDED/REGULAR by the clock", () => {
    expect(classifyDxFeedSession("EQUITY", at("2026-11-26T15:00:00Z"))).toBe("CLOSED"); // Thanksgiving 10:00 EST
    expect(classifyDxFeedSession("EQUITY", at("2026-04-03T14:00:00Z"))).toBe("CLOSED"); // Good Friday 10:00 EDT
  });

  test("an early-close day ends the regular session at 13:00 ET", () => {
    expect(classifyDxFeedSession("EQUITY", at("2026-11-27T17:59:00Z"))).toBe("REGULAR"); // 12:59 EST
    expect(classifyDxFeedSession("EQUITY", at("2026-11-27T18:00:00Z"))).toBe("EXTENDED"); // 13:00 EST
  });
});
