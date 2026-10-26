import { describe, expect, test } from "vitest";
import { LOG_SLIDER_STEPS, logSliderMidpoint, logSliderToValue, valueToLogSlider } from "../logSlider";
import {
  DEFAULT_TOP_FRACTION, MIN_TOP_FRACTION, MAX_TOP_FRACTION,
  DEFAULT_WHALE_THRESHOLD_CONTRACTS, MIN_WHALE_THRESHOLD_CONTRACTS, MAX_WHALE_THRESHOLD_CONTRACTS,
} from "../../indicators/whale-detector/whaleTrades";

describe("logSlider", () => {
  test("the slider's centre is the geometric midpoint, which is what makes 'default in the middle' true", () => {
    expect(logSliderMidpoint(1, 400)).toBeCloseTo(20, 10);
  });

  test("each product default sits exactly at the centre of its own slider", () => {
    expect(valueToLogSlider(DEFAULT_WHALE_THRESHOLD_CONTRACTS, MIN_WHALE_THRESHOLD_CONTRACTS, MAX_WHALE_THRESHOLD_CONTRACTS))
      .toBe(LOG_SLIDER_STEPS / 2);
    expect(valueToLogSlider(DEFAULT_TOP_FRACTION, MIN_TOP_FRACTION, MAX_TOP_FRACTION))
      .toBe(LOG_SLIDER_STEPS / 2);
  });

  test("the ends of the travel are exactly the declared bounds", () => {
    expect(logSliderToValue(0, 1, 400)).toBeCloseTo(1, 12);
    expect(logSliderToValue(LOG_SLIDER_STEPS, 1, 400)).toBeCloseTo(400, 10);
  });

  test("position and value round-trip to within one slider step, so re-opening shows the same handle", () => {
    // One step spans a factor of (max/min)^(1/steps) = 400^(1/1000), i.e. ~0.6%.
    const stepFactor = Math.pow(400, 1 / LOG_SLIDER_STEPS);
    for (const value of [1, 5, 20, 100, 400]) {
      const position = valueToLogSlider(value, 1, 400);
      const roundTripped = logSliderToValue(position, 1, 400);
      expect(roundTripped / value).toBeGreaterThan(1 / stepFactor);
      expect(roundTripped / value).toBeLessThan(stepFactor);
    }
  });

  test("a log scale spends half its travel below the midpoint, unlike the linear slider it replaces", () => {
    // The old linear $1k-$150M slider put $50k at 0.03% of its travel.
    const quarter = logSliderToValue(LOG_SLIDER_STEPS / 4, 20_000, 50_000_000);
    expect(quarter).toBeGreaterThan(20_000);
    expect(quarter).toBeLessThan(1_000_000);
  });

  test("out-of-range input is clamped rather than producing a handle off the track", () => {
    expect(logSliderToValue(-50, 1, 400)).toBeCloseTo(1, 12);
    expect(logSliderToValue(99_999, 1, 400)).toBeCloseTo(400, 10);
    expect(valueToLogSlider(0.001, 1, 400)).toBe(0);
    expect(valueToLogSlider(99_999, 1, 400)).toBe(LOG_SLIDER_STEPS);
  });

  test("invalid bounds are rejected rather than silently producing NaN positions", () => {
    expect(() => logSliderToValue(0, 0, 400)).toThrow(/min/);
    expect(() => logSliderToValue(0, 10, 10)).toThrow(/max/);
    expect(() => valueToLogSlider(5, -1, 400)).toThrow(/min/);
    expect(() => valueToLogSlider(5, 400, 1)).toThrow(/max/);
  });
});
