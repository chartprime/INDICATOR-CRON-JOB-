// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChart, LineSeries, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { nearestSeriesTime, snappedTimeToCoordinate } from "../../indicators/drawing-tools/trendlineGeometry";

// A2.20 / L1L2-V2-091. Every other test in this repository that touches the
// charting library replaces it with vi.hoisted mocks, so timeToCoordinate
// returns whatever the mock was told to return. That is legitimate for testing
// wiring and lifecycle -- but it means NO test exercised the real time scale,
// and that blind spot is exactly why L1L2-V2-090 could not be caught
// internally: only the real library knows that a time absent from the current
// series resolves to null rather than to an interpolated coordinate.
// Trendlines and Fibonacci retracements vanished on a timeframe switch for
// that reason, and proving it required standing a real chart up by hand.
//
// This file pins the library behaviour our drawing geometry is built on, so a
// lightweight-charts upgrade that changes it fails here rather than silently
// making drawings disappear again.

const MIN = 60_000;
const BASE = 1_700_000_000_000;

function seconds(ms: number): UTCTimestamp {
  return (ms / 1000) as UTCTimestamp;
}

describe("lightweight-charts time scale, against the real library", () => {
  let container: HTMLDivElement;
  let chart: IChartApi;

  beforeEach(() => {
    container = document.createElement("div");
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    document.body.appendChild(container);
    chart = createChart(container, { width: 800, height: 400 });
  });

  afterEach(() => {
    chart.remove();
    container.remove();
  });

  function oneMinuteSeries(barCount: number) {
    const series = chart.addSeries(LineSeries, {});
    series.setData(
      Array.from({ length: barCount }, (_, i) => ({ time: seconds(BASE + i * MIN), value: 100 + i })),
    );
    chart.timeScale().fitContent();
    return series;
  }

  it("resolves a coordinate for a time that is present on the series", () => {
    oneMinuteSeries(30);

    const coordinate = chart.timeScale().timeToCoordinate(seconds(BASE + 10 * MIN));

    expect(coordinate).not.toBeNull();
    expect(Number.isFinite(coordinate as number)).toBe(true);
  });

  // The whole of L1L2-V2-090 in one assertion. A 1-minute anchor is a real
  // instant that the 15-minute series simply has no bar for, and the library
  // does not interpolate -- it returns null. Both drawing geometry helpers
  // return null if any endpoint is null, and the primitives skip a null
  // segment, so the drawing disappeared.
  it("returns null for a real time that is not a bar on the current series", () => {
    const fifteenMinute = chart.addSeries(LineSeries, {});
    fifteenMinute.setData(
      Array.from({ length: 20 }, (_, i) => ({ time: seconds(BASE + i * 15 * MIN), value: 100 + i })),
    );
    chart.timeScale().fitContent();

    const onGrid = chart.timeScale().timeToCoordinate(seconds(BASE + 15 * MIN));
    const offGrid = chart.timeScale().timeToCoordinate(seconds(BASE + 7 * MIN));

    expect(onGrid).not.toBeNull();
    expect(offGrid).toBeNull();
  });

  // And the fix, verified against the same real library rather than against a
  // hand-built series double.
  it("snappedTimeToCoordinate recovers an off-grid anchor that the raw call drops", () => {
    const seriesTimes: number[] = Array.from({ length: 20 }, (_, i) => (BASE + i * 15 * MIN) / 1000);
    const fifteenMinute = chart.addSeries(LineSeries, {});
    fifteenMinute.setData(seriesTimes.map((time, i) => ({ time: time as UTCTimestamp, value: 100 + i })));
    chart.timeScale().fitContent();

    const raw = (timeSeconds: number): number | null =>
      chart.timeScale().timeToCoordinate(timeSeconds as UTCTimestamp);
    const offGrid = (BASE + 7 * MIN) / 1000;

    expect(raw(offGrid)).toBeNull();
    expect(snappedTimeToCoordinate(raw, seriesTimes)(offGrid)).not.toBeNull();
  });

  it("leaves an on-grid anchor exactly where the library puts it, rather than snapping it too", () => {
    const seriesTimes: number[] = Array.from({ length: 20 }, (_, i) => (BASE + i * 15 * MIN) / 1000);
    const fifteenMinute = chart.addSeries(LineSeries, {});
    fifteenMinute.setData(seriesTimes.map((time, i) => ({ time: time as UTCTimestamp, value: 100 + i })));
    chart.timeScale().fitContent();

    const raw = (timeSeconds: number): number | null =>
      chart.timeScale().timeToCoordinate(timeSeconds as UTCTimestamp);
    const onGrid = (BASE + 15 * MIN) / 1000;

    expect(snappedTimeToCoordinate(raw, seriesTimes)(onGrid)).toBe(raw(onGrid));
  });

  it("nearestSeriesTime picks a real series time for an off-grid anchor", () => {
    const seriesTimes: number[] = Array.from({ length: 20 }, (_, i) => (BASE + i * 15 * MIN) / 1000);

    const nearest = nearestSeriesTime((BASE + 7 * MIN) / 1000, seriesTimes);

    expect(seriesTimes).toContain(nearest);
  });
});
