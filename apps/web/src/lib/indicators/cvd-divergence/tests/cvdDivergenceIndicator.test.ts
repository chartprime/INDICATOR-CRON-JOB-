import { describe, expect, it } from "vitest";
import {
  cvdDivergenceIndicator,
  DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
} from "../cvdDivergenceIndicator";
import {
  DEFAULT_CVD_PERIOD,
  MAX_CVD_PERIOD,
  MAX_CVD_PIVOT_PERIODS,
  MIN_CVD_PERIOD,
  MIN_CVD_PIVOT_DISTANCE,
  MIN_CVD_PIVOT_PERIODS,
  MIN_CVD_SMA_LENGTH,
} from "../cvdDivergence";

describe("cvdDivergenceIndicator", () => {
  it("registers as a runtime indicator in the L1 category, next to the other candle-flow studies", () => {
    expect(cvdDivergenceIndicator.kind).toBe("runtime");
    expect(cvdDivergenceIndicator.id).toBe("cvdDivergence");
    expect(cvdDivergenceIndicator.label).toBe("CVD Divergence");
    expect(cvdDivergenceIndicator.category).toBe("l1");
  });

  it("defaults to the study's own Period, with the fractal width retuned by the operator", () => {
    expect(DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.period).toBe(21);
    // The study used 2; the operator widened it to 5, which also raises the
    // fractal floor on how close two same-kind pivots can be to 11 bars.
    expect(DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.pivotPeriods).toBe(5);
    expect(DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.showLabels).toBe(true);
  });

  it("defaults period to DEFAULT_CVD_PERIOD rather than a second copy of 21", () => {
    expect(DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.period).toBe(
      DEFAULT_CVD_PERIOD,
    );
  });

  it("bounds the integer sliders by the module's own exported limits", () => {
    const period = cvdDivergenceIndicator.settingsSchema!.find(
      (field) => field.kind === "slider" && field.key === "period",
    );
    const pivot = cvdDivergenceIndicator.settingsSchema!.find(
      (field) => field.kind === "slider" && field.key === "pivotPeriods",
    );
    expect(period).toMatchObject({
      min: MIN_CVD_PERIOD,
      max: MAX_CVD_PERIOD,
      affects: "recompute",
    });
    expect(pivot).toMatchObject({
      min: MIN_CVD_PIVOT_PERIODS,
      max: MAX_CVD_PIVOT_PERIODS,
      affects: "recompute",
    });
  });

  it("offers every integer input as a whole-step slider, never as a typed box", () => {
    const schema = cvdDivergenceIndicator.settingsSchema!;
    expect(schema.filter((field) => field.kind === "numeric")).toEqual([]);
    const sliders = schema.filter((field) => field.kind === "slider");
    expect(sliders.flatMap((field) => [field.key]).sort()).toEqual(
      [
        "period",
        "pivotPeriods",
        "minPivotDistance",
        "maxPivotDistance",
        "cumulativeMinPivotDistance",
        "cumulativeMaxPivotDistance",
        // Registered but hidden: the custom trend-filter rows own these two.
        "oscillatorTrendFilterSmaLength",
        "cumulativeTrendFilterSmaLength",
      ].sort(),
    );
    // A whole step, or the slider would land between the integers it means.
    for (const field of sliders) expect(field.step).toBe(1);
    for (const key of [
      "oscillatorTrendFilterSmaLength",
      "cumulativeTrendFilterSmaLength",
    ] as const) {
      expect(sliders.find((field) => field.key === key)).toMatchObject({
        min: MIN_CVD_SMA_LENGTH,
        max: 100,
      });
    }
    // Both ends of the distance window stop at the module's own ceiling.
    for (const key of [
      "minPivotDistance",
      "maxPivotDistance",
      "cumulativeMinPivotDistance",
      "cumulativeMaxPivotDistance",
    ] as const) {
      expect(sliders.find((field) => field.key === key)).toMatchObject({
        min: MIN_CVD_PIVOT_DISTANCE,
        max: 100,
      });
    }
  });

  it("marks only the presentation toggles cosmetic, since everything else is rebuilt into the oscillator series", () => {
    const cosmetic = cvdDivergenceIndicator.settingsSchema!.filter(
      (field) => field.kind !== "staticHint" && field.affects === "cosmetic",
    );
    expect(
      cosmetic
        .map(
          (field) =>
            (
              field as {
                key: keyof typeof DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS;
              }
            ).key,
        )
        .sort(),
    ).toEqual(["showCumulativeCvd", "showCumulativeDivergences", "showLabels"]);
  });

  it("leaves the borrowed cumulative CVD off by default, and in line form when switched on", () => {
    // Off by default so CVD Divergence's own reading stands alone until asked;
    // line because the cumulative total's shape reads better as a line than as
    // candles at most chart intervals.
    expect(DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.showCumulativeCvd).toBe(
      false,
    );
    expect(
      DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.cumulativeCvdDisplayMode,
    ).toBe("line");
  });

  it("offers a line/candles choice for the borrowed series, defaulting to line", () => {
    const mode = cvdDivergenceIndicator.settingsSchema!.find(
      (field) =>
        field.kind === "radioGroup" && field.key === "cumulativeCvdDisplayMode",
    );
    expect(mode).toBeDefined();
    expect(
      (mode as { options: readonly { value: string }[] }).options.map(
        (option) => option.value,
      ),
    ).toEqual(["line", "candles"]);
    // Swapping series type is structural, not cosmetic.
    expect((mode as { affects: string }).affects).toBe("recompute");
  });

  it("gives each series its own independent trend filter", () => {
    // Two custom fields, not one: the oscillator and the borrowed cumulative
    // series are separately gated, each with its own toggle and its own
    // average length, because the two series have different shapes.
    const customFields = cvdDivergenceIndicator.settingsSchema!.filter(
      (field) => field.kind === "custom",
    );
    expect(customFields).toHaveLength(2);

    const defaults = DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS;
    expect(defaults.oscillatorTrendFilterEnabled).toBe(false);
    expect(defaults.cumulativeTrendFilterEnabled).toBe(false);
    // Independent keys, so switching one on cannot switch the other on.
    expect(defaults).toHaveProperty("oscillatorTrendFilterSmaLength");
    expect(defaults).toHaveProperty("cumulativeTrendFilterSmaLength");
    // ... and each direction is independent too, with the CUMULATIVE series
    // defaulting to the inverted reading and the oscillator to the normal one.
    expect(defaults.oscillatorTrendFilterInverted).toBe(false);
    expect(defaults.cumulativeTrendFilterInverted).toBe(true);
  });

  it("detects pivots on the CVD by default, with a recompute toggle for price", () => {
    expect(DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.pivotsOnPrice).toBe(false);
    const field = cvdDivergenceIndicator.settingsSchema!.find(
      (f) => f.kind === "boolean" && f.key === "pivotsOnPrice",
    );
    expect(field).toMatchObject({ tab: "inputs", affects: "recompute" });
  });

  it("has no line outputs -- the histogram and divergence segments are hand-wired in ChartPanel.tsx", () => {
    expect(cvdDivergenceIndicator.lines).toEqual([]);
    expect(cvdDivergenceIndicator.crossAttachments).toBeUndefined();
    expect(cvdDivergenceIndicator.placement).toEqual({ kind: "overlay" });
  });

  it("onBar/readOutput are intentionally inert -- nothing is derived from ctx.bar", () => {
    const state = cvdDivergenceIndicator.createState(
      DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
    );
    expect(() =>
      cvdDivergenceIndicator.onBar({
        bar: { ts_open: 0 } as never,
        trades: [],
        tradeAvailability: "HISTORICAL_UNAVAILABLE",
        state,
        settings: DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS,
        replace: false,
        replaying: true,
        ta: {},
        draw: { fill: () => {} },
        markers: { plotshape: () => {}, plotchar: () => {} },
        pane: { paneIndex: 0 },
      }),
    ).not.toThrow();
    expect(cvdDivergenceIndicator.readOutput(state)).toEqual({});
  });
});
