"use strict";

// Block 7 W1 (report 57, GE-14): the governed market calendar decides which
// equity minutes belong on the chart (regular session only). These are the
// calendar fixtures the plan names: both DST switches, a full holiday, the
// early closes, and the weekend. Times are exchange-local in the comments.
const calendarConfig = require("../../../../../config/market-calendar.json");
const {
  createMarketCalendar, equitySessionAt, isEquityChartTime, inChartSession, coversTime, EQUITY_CALENDAR_COVERAGE,
  isMarketOpen, isClosedThroughout,
} = require("../../../src/providers/shared/market-calendar");

const at = (iso) => Date.parse(iso);
const clone = () => JSON.parse(JSON.stringify(calendarConfig));

describe("market calendar: equity sessions", () => {
  test.each([
    ["2026-09-23T13:29:59.999Z", "EXTENDED", "09:29:59.999 EDT"],
    ["2026-09-23T13:30:00.000Z", "REGULAR", "09:30 EDT open"],
    ["2026-09-23T19:59:59.999Z", "REGULAR", "15:59:59.999 EDT"],
    ["2026-09-23T20:00:00.000Z", "EXTENDED", "16:00 EDT close"],
    ["2026-09-23T07:59:59.999Z", "CLOSED", "03:59 EDT"],
    ["2026-09-23T08:00:00.000Z", "EXTENDED", "04:00 EDT pre-market"],
    ["2026-09-24T00:00:00.000Z", "CLOSED", "20:00 EDT"],
    ["2026-03-06T14:30:00.000Z", "REGULAR", "Fri before spring DST, 09:30 EST"],
    ["2026-03-09T13:30:00.000Z", "REGULAR", "Mon after spring DST, 09:30 EDT"],
    ["2026-03-09T14:29:00.000Z", "REGULAR", "same UTC clock as a pre-open EST minute"],
    ["2026-03-06T14:29:00.000Z", "EXTENDED", "09:29 EST"],
    ["2026-10-30T13:30:00.000Z", "REGULAR", "Fri before fall DST, 09:30 EDT"],
    ["2026-11-02T13:30:00.000Z", "EXTENDED", "Mon after fall DST, 08:30 EST"],
    ["2026-11-02T14:30:00.000Z", "REGULAR", "09:30 EST"],
    ["2026-11-02T21:00:00.000Z", "EXTENDED", "16:00 EST"],
    ["2026-11-26T15:00:00.000Z", "CLOSED", "Thanksgiving"],
    ["2026-11-27T14:30:00.000Z", "REGULAR", "day after Thanksgiving open"],
    ["2026-11-27T17:59:59.999Z", "REGULAR", "12:59:59.999 EST early close day"],
    ["2026-11-27T18:00:00.000Z", "EXTENDED", "13:00 EST early close"],
    ["2026-12-24T18:00:00.000Z", "EXTENDED", "Christmas Eve 13:00 EST"],
    ["2026-12-25T15:00:00.000Z", "CLOSED", "Christmas"],
    ["2026-09-26T15:00:00.000Z", "CLOSED", "Saturday"],
    ["2026-09-27T15:00:00.000Z", "CLOSED", "Sunday"],
    ["2027-03-26T14:00:00.000Z", "CLOSED", "Good Friday 2027"],
    ["2027-11-26T18:30:00.000Z", "EXTENDED", "2027 early close 13:30 EST"],
  ])("%s is %s (%s)", (iso, expected) => {
    expect(equitySessionAt(at(iso))).toBe(expected);
    expect(isEquityChartTime(at(iso))).toBe(expected === "REGULAR");
  });

  test("a trading day's chart minutes are exactly 390, or 210 on an early close, and 0 on a holiday", () => {
    const chartMinutes = (day) => {
      let count = 0;
      const start = at(`${day}T00:00:00Z`);
      for (let ts = start; ts < start + 86_400_000; ts += 60_000) if (isEquityChartTime(ts)) count += 1;
      return count;
    };
    expect(chartMinutes("2026-09-23")).toBe(390);
    expect(chartMinutes("2026-03-09")).toBe(390);
    expect(chartMinutes("2026-11-02")).toBe(390);
    expect(chartMinutes("2026-11-27")).toBe(210);
    expect(chartMinutes("2026-11-26")).toBe(0);
  });

  test("futures are never filtered by the equity chart session", () => {
    expect(inChartSession("FUTURE", at("2026-09-23T02:00:00Z"))).toBe(true);
    expect(inChartSession("FUTURE", at("2026-11-26T15:00:00Z"))).toBe(true);
    expect(inChartSession("EQUITY", at("2026-09-23T02:00:00Z"))).toBe(false);
  });

  test("the calendar is loaded fail-closed: malformed entries stop the process instead of guessing", () => {
    const bad = (mutate) => { const config = clone(); mutate(config); return () => createMarketCalendar(config); };
    expect(bad((c) => { c.equity.holidays = ["2026-01-19", "2026-01-01"]; })).toThrow(/ascending/);
    expect(bad((c) => { c.equity.holidays.push("2028-01-03"); })).toThrow(/outside coverage/);
    expect(bad((c) => { c.equity.earlyCloses = ["2026-11-28"]; })).toThrow(/weekend/);
    expect(bad((c) => { c.equity.earlyCloses = ["2026-11-26"]; })).toThrow(/both a holiday/);
    expect(bad((c) => { c.equity.regularOpen = "9:30"; })).toThrow(/HH:MM/);
    expect(bad((c) => { c.equity.earlyClose = "17:00"; })).toThrow(/ordered/);
    expect(bad((c) => { c.equity.chartSession = "EXTENDED"; })).toThrow(/chartSession/);
    expect(bad((c) => { c.equity.sources = []; })).toThrow(/sources/);
    expect(bad((c) => { c.equity.holidays = ["2026-02-30"]; })).toThrow(/invalid date/);
    expect(() => equitySessionAt(-1)).toThrow(/timestamp/);
  });

  test("coverage is explicit, and it still has at least 60 days of runway (renew from the exchange pages when this fails)", () => {
    expect(EQUITY_CALENDAR_COVERAGE).toEqual({ from: "2025-09-01", to: "2027-12-31" });
    expect(coversTime(at("2027-12-31T23:00:00Z"))).toBe(true);
    expect(coversTime(at("2028-01-01T12:00:00Z"))).toBe(false);
    expect(coversTime(Date.now() + 60 * 86_400_000)).toBe(true);
  });
});

describe("market calendar: is the market open (Block 8 #5: a closed market is not an outage)", () => {
  test.each([
    ["EQUITY", "2026-09-25T01:11:00Z", false, "21:11 EDT Thu, after the 20:00 extended close: the Block 8 AAPL case"],
    ["EQUITY", "2026-09-24T14:00:00Z", true, "10:00 EDT regular session"],
    ["EQUITY", "2026-09-24T23:30:00Z", true, "19:30 EDT extended hours"],
    ["EQUITY", "2026-09-26T15:00:00Z", false, "Saturday"],
    ["FUTURE", "2026-09-24T21:30:00Z", false, "17:30 EDT Thu, the daily Globex break"],
    ["FUTURE", "2026-09-24T22:00:00Z", true, "18:00 EDT Thu, Globex reopens"],
    ["FUTURE", "2026-09-25T01:11:00Z", true, "21:11 EDT Thu overnight session"],
    ["FUTURE", "2026-09-25T21:05:00Z", false, "17:05 EDT Fri, weekend close"],
    ["FUTURE", "2026-09-27T21:59:00Z", false, "17:59 EDT Sun, before the open"],
    ["FUTURE", "2026-09-27T22:00:00Z", true, "18:00 EDT Sun, the weekly open"],
    ["SPOT", "2026-09-26T15:00:00Z", true, "crypto never closes"],
  ])("%s at %s -> open %s (%s)", (assetClass, iso, open) => {
    expect(isMarketOpen(assetClass, at(iso))).toBe(open);
  });

  test("a window is closed throughout only when no minute of it trades", () => {
    expect(isClosedThroughout("EQUITY", at("2026-09-25T00:30:00Z"), at("2026-09-25T02:00:00Z"))).toBe(true);
    expect(isClosedThroughout("EQUITY", at("2026-09-24T23:30:00Z"), at("2026-09-25T00:30:00Z"))).toBe(false);
    expect(isClosedThroughout("FUTURE", at("2026-09-24T21:05:00Z"), at("2026-09-24T21:55:00Z"))).toBe(true);
    expect(isClosedThroughout("FUTURE", at("2026-09-24T21:05:00Z"), at("2026-09-24T22:10:00Z"))).toBe(false);
    expect(isClosedThroughout("PERPETUAL", at("2026-09-26T00:00:00Z"), at("2026-09-26T02:00:00Z"))).toBe(false);
  });
});
