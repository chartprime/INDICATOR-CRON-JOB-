import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndicatorRuntime } from "../indicatorRuntime";
import { ta } from "../ta";
import { draw } from "../draw";
import { resetDrawOwnerScopeForTests } from "../draw/creationScope";
import { handlesForOwners, resetDrawRegistryForTests } from "../draw/registry";
import type { BarFrame, TradeFrame } from "../../../types/frames";
import type { IndicatorLiquidity } from "../indicatorLiquidity";
import type { IndicatorBandHistory } from "../bandHistory";
import type {
  IndicatorBarCtx,
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../indicatorTypes";

afterEach(() => {
  resetDrawRegistryForTests();
  resetDrawOwnerScopeForTests();
});

function bar(ts_open: number, overrides: Partial<BarFrame> = {}): BarFrame {
  return {
    type: "bar",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    interval_ms: 60_000,
    ts_open,
    open: 1,
    high: 2,
    low: 1,
    close: 1.5,
    volume: 1,
    trade_count: 1,
    closed: true,
    ...overrides,
  } as BarFrame;
}

function trade(
  ts_exchange: number,
  overrides: Partial<TradeFrame> = {},
): TradeFrame {
  return {
    type: "trade",
    symbol: "BTC-USDT",
    provider: "BINANCE",
    marketKind: "SPOT",
    ts_exchange,
    price: 100,
    size: 1,
    side: "buy",
    trade_id: `t-${ts_exchange}`,
    ...overrides,
  } as TradeFrame;
}

interface FakeSettings {
  length: number;
  color: string;
}

interface FakeState {
  generation: number;
  appendCount: number;
  replaceCount: number;
  replayCount: number;
}

const FAKE_SCHEMA: readonly SettingsFieldSchema<FakeSettings>[] = [
  {
    kind: "numeric",
    key: "length",
    label: "Length",
    min: 1,
    max: 100,
    step: 1,
    affects: "recompute",
  },
  {
    kind: "radioGroup",
    key: "color",
    label: "Color",
    affects: "cosmetic",
    options: [
      { value: "red", label: "Red" },
      { value: "blue", label: "Blue" },
    ],
  },
];

function makeFakeDef(): RuntimeIndicatorDef<FakeState, FakeSettings> {
  let createStateCalls = 0;
  return {
    kind: "runtime",
    id: "fake",
    label: "Fake",
    category: "technical",
    defaultSettings: { length: 1, color: "red" },
    settingsSchema: FAKE_SCHEMA,
    lines: [
      { key: "generation" },
      { key: "appendCount" },
      { key: "replaceCount" },
      { key: "replayCount" },
      { key: "totalCalls" },
    ],
    placement: { kind: "overlay" },
    createState: () => {
      createStateCalls += 1;
      return {
        generation: createStateCalls,
        appendCount: 0,
        replaceCount: 0,
        replayCount: 0,
      };
    },
    onBar: (ctx) => {
      if (ctx.replaying) ctx.state.replayCount += 1;
      else if (ctx.replace) ctx.state.replaceCount += 1;
      else ctx.state.appendCount += 1;
    },
    readOutput: (state) => ({
      generation: state.generation,
      appendCount: state.appendCount,
      replaceCount: state.replaceCount,
      replayCount: state.replayCount,
      totalCalls: state.appendCount + state.replaceCount,
    }),
  };
}

function activate(
  runtime: ReturnType<typeof createIndicatorRuntime>,
  bars: readonly BarFrame[] = [],
) {
  runtime.setActive(new Set(["fake"]), {}, bars);
}

describe("createIndicatorRuntime", () => {
  it("limits full replay to an indicator's configured maxReplayBars", () => {
    const replayedTs: number[] = [];
    const cappedDef: RuntimeIndicatorDef<FakeState, FakeSettings> = {
      ...makeFakeDef(),
      id: "capped",
      maxReplayBars: 3,
      onBar: (ctx) => {
        if (ctx.replaying) replayedTs.push(ctx.bar.ts_open);
      },
    };
    const bars = Array.from({ length: 5 }, (_, index) => bar(index));
    const runtime = createIndicatorRuntime([
      cappedDef as RuntimeIndicatorDef<unknown, unknown>,
    ]);

    runtime.setActive(new Set(["capped"]), {}, bars);
    expect(replayedTs).toEqual([2, 3, 4]);

    runtime.updateSettings("capped", { length: 2, color: "red" }, bars);
    expect(replayedTs).toEqual([2, 3, 4, 2, 3, 4]);
  });

  it("rejects duplicate indicator ids and duplicate line keys before either can silently overwrite another runtime output", () => {
    const duplicateId = makeFakeDef();
    const duplicateLine = makeFakeDef();
    duplicateLine.id = "different";
    duplicateLine.lines = [{ key: "value" }, { key: "value" }];

    expect(() =>
      createIndicatorRuntime([
        makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
        duplicateId as RuntimeIndicatorDef<unknown, unknown>,
      ]),
    ).toThrow(/duplicate indicator id/);
    expect(() =>
      createIndicatorRuntime([
        duplicateLine as RuntimeIndicatorDef<unknown, unknown>,
      ]),
    ).toThrow(/duplicate line key/);
  });

  it("rejects a def that declares crossAttachments, loudly, rather than silently ignoring an unimplemented mechanism (TA.05 audit finding)", () => {
    const withCrossAttachments = makeFakeDef();
    withCrossAttachments.crossAttachments = [
      {
        attachToIndicatorId: "other",
        attachToLineKey: "value",
        createPrimitive: () => null,
      },
    ];

    expect(() =>
      createIndicatorRuntime([
        withCrossAttachments as RuntimeIndicatorDef<unknown, unknown>,
      ]),
    ).toThrow(/crossAttachments.*not implemented/);
  });

  it("accepts a def with no crossAttachments, and one with an explicitly empty crossAttachments array", () => {
    const withoutField = makeFakeDef();
    const withEmptyArray = makeFakeDef();
    withEmptyArray.id = "empty-cross-attachments";
    withEmptyArray.crossAttachments = [];

    expect(() =>
      createIndicatorRuntime([
        withoutField as RuntimeIndicatorDef<unknown, unknown>,
      ]),
    ).not.toThrow();
    expect(() =>
      createIndicatorRuntime([
        withEmptyArray as RuntimeIndicatorDef<unknown, unknown>,
      ]),
    ).not.toThrow();
  });

  it("APPENDED then REPLACED_EDGE for the same bar closing produces exactly one output slot, not two", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    activate(runtime);
    const bars: BarFrame[] = [];

    const openBar = bar(1000, { closed: false });
    bars.push(openBar);
    runtime.onBar(openBar, "APPENDED", bars);

    const closedBar = bar(1000, { closed: true });
    bars[0] = closedBar;
    runtime.onBar(closedBar, "REPLACED_EDGE", bars);

    const output = runtime.getOutput("fake")!;
    expect(output.totalCalls).toHaveLength(1);
    expect(output.appendCount.at(-1)).toBe(1);
    expect(output.replaceCount.at(-1)).toBe(1);
    expect(output.totalCalls.at(-1)).toBe(2);
  });

  it("an open bar mutated three times produces three onBar calls, replace each time, no double-counted accumulator", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    activate(runtime);
    const bars: BarFrame[] = [bar(1000, { closed: false })];
    runtime.onBar(bars[0], "APPENDED", bars);

    for (let i = 0; i < 3; i += 1) {
      bars[0] = bar(1000, { closed: false, close: 1.5 + i });
      runtime.onBar(bars[0], "REPLACED_EDGE", bars);
    }

    const output = runtime.getOutput("fake")!;
    expect(output.totalCalls).toHaveLength(1);
    expect(output.appendCount.at(-1)).toBe(1);
    expect(output.replaceCount.at(-1)).toBe(3);
  });

  it("REBUILT triggers a full replay -- fresh state, not one incremental call", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000), bar(2000), bar(3000)];
    activate(runtime, seedBars);
    const generationAfterActivation = runtime
      .getOutput("fake")!
      .generation.at(-1);

    const rebuiltBars = [bar(500), ...seedBars];
    runtime.onBar(bar(500), "REBUILT", rebuiltBars);

    const output = runtime.getOutput("fake")!;
    expect(output.generation.at(-1)).not.toBe(generationAfterActivation);
    expect(output.totalCalls).toHaveLength(4);
    expect(output.replayCount).toEqual([1, 2, 3, 4]);
    expect(output.appendCount.every((count) => count === 0)).toBe(true);
  });

  it("REJECTED_REOPEN causes zero state mutation and zero onBar calls", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000), bar(2000)];
    activate(runtime, seedBars);
    // Deep-clone: getOutput's arrays are mutated in place by the runtime, so a
    // shallow copy here would alias the very state being asserted against.
    const beforeSnapshot = structuredClone(runtime.getOutput("fake"));

    runtime.onBar(bar(2000, { closed: false }), "REJECTED_REOPEN", seedBars);

    const after = runtime.getOutput("fake")!;
    expect(after.totalCalls).toHaveLength(2);
    expect(after).toEqual(beforeSnapshot);
  });

  it("onSnapshot([]) then onSnapshot(full) resets cleanly -- the second call is not polluted by the first", () => {
    // Activate with non-empty history first so the first activation's state
    // is genuinely non-zero -- otherwise a bug that reuses stale state instead
    // of resetting it is invisible, since a fresh reset and stale zero state
    // would look identical.
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    activate(runtime, [bar(100), bar(200), bar(300), bar(400), bar(500)]);
    const generationBeforeSwitch = runtime.getOutput("fake")!.generation.at(-1);

    runtime.onSnapshot([]);
    expect(runtime.getOutput("fake")!.totalCalls).toHaveLength(0);

    const fullBars = [bar(1000), bar(2000), bar(3000)];
    runtime.onSnapshot(fullBars);

    const output = runtime.getOutput("fake")!;
    expect(output.generation.at(-1)).not.toBe(generationBeforeSwitch);
    expect(output.totalCalls).toHaveLength(3);
    expect(output.appendCount.every((count) => count === 0)).toBe(true);
    expect(output.replayCount).toEqual([1, 2, 3]);
  });

  it("getOutput with no intervening bar activity triggers zero onBar calls -- serves cached output", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000), bar(2000)];
    activate(runtime, seedBars);

    // getOutput returns the same live record by reference, so snapshot each
    // call before the next one can mutate it -- otherwise these would compare
    // the same object against itself regardless of what getOutput actually did.
    const first = structuredClone(runtime.getOutput("fake"));
    const second = structuredClone(runtime.getOutput("fake"));
    const third = structuredClone(runtime.getOutput("fake"));

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first!.totalCalls).toHaveLength(2);
  });

  it("a newly-activated indicator warm-starts by replaying the current bars before any live bar arrives", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000), bar(2000), bar(3000), bar(4000)];

    activate(runtime, seedBars);

    const output = runtime.getOutput("fake")!;
    expect(output.totalCalls).toHaveLength(4);
    expect(output.replayCount).toEqual([1, 2, 3, 4]);
    expect(output.appendCount.every((count) => count === 0)).toBe(true);
  });

  it("a recompute-tagged settings change triggers a full replay; a cosmetic-only change leaves state untouched", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000), bar(2000)];
    activate(runtime, seedBars);
    const generationBefore = runtime.getOutput("fake")!.generation.at(-1);

    runtime.updateSettings("fake", { length: 1, color: "blue" }, seedBars);
    expect(runtime.getOutput("fake")!.generation.at(-1)).toBe(generationBefore);

    runtime.updateSettings("fake", { length: 5, color: "blue" }, seedBars);
    expect(runtime.getOutput("fake")!.generation.at(-1)).not.toBe(
      generationBefore,
    );
  });

  it("a tail-identity mismatch on REPLACED_EDGE falls back to a full replay rather than corrupting state", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000), bar(2000)];
    activate(runtime, seedBars);

    const mismatchedBar = bar(9999, { closed: true });
    runtime.onBar(mismatchedBar, "REPLACED_EDGE", [...seedBars, mismatchedBar]);

    const output = runtime.getOutput("fake")!;
    expect(output.totalCalls).toHaveLength(3);
    expect(output.appendCount.every((count) => count === 0)).toBe(true);
  });

  it("discardLeading keeps cached outputs and per-bar colors aligned with a bounded retained chart after an append", () => {
    const runtime = createIndicatorRuntime([
      makeSettingsColoredDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const retainedBars = [bar(1000), bar(2000), bar(3000)];
    runtime.setActive(new Set(["colored"]), {}, retainedBars);

    const nextBar = bar(4000);
    retainedBars.push(nextBar);
    runtime.onBar(nextBar, "APPENDED", retainedBars);
    retainedBars.splice(0, 1);
    runtime.discardLeading(1);

    expect(runtime.getOutput("colored")!.value).toHaveLength(
      retainedBars.length,
    );
    expect(runtime.getLineColors("colored")!.value).toHaveLength(
      retainedBars.length,
    );
    expect(runtime.getOutput("colored")!.value).toEqual([2, 3, 4]);
  });
});

// Outside developers will write these indicators, and their code will
// sometimes throw -- a bug in one indicator must never take down every other
// indicator sharing the same chart. This is the same shape of cascading
// failure this codebase already hit once for real, on the dxFeed side.
function makeBrokenDef(
  overrides: Partial<RuntimeIndicatorDef<unknown, unknown>> = {},
): RuntimeIndicatorDef<unknown, unknown> {
  return {
    kind: "runtime",
    id: "broken",
    label: "Broken",
    category: "technical",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({}),
    onBar: () => {
      throw new Error("boom");
    },
    readOutput: () => ({ value: 1 }),
    ...overrides,
  };
}

describe("createIndicatorRuntime -- fault isolation", () => {
  it("one indicator throwing in onBar does not stop other active indicators from processing the same bar", () => {
    const runtime = createIndicatorRuntime([
      makeBrokenDef(),
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["broken", "fake"]), {}, []);

    const seedBar = bar(1000);
    expect(() => runtime.onBar(seedBar, "APPENDED", [seedBar])).not.toThrow();

    expect(runtime.getOutput("fake")!.totalCalls.at(-1)).toBe(1);
  });

  it("an indicator that throws during createState (warm-start) does not prevent other indicators from warm-starting", () => {
    const throwingCreateState = makeBrokenDef({
      onBar: () => {},
      createState: () => {
        throw new Error("boom in createState");
      },
    });
    const runtime = createIndicatorRuntime([
      throwingCreateState,
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000), bar(2000)];

    expect(() =>
      runtime.setActive(new Set(["broken", "fake"]), {}, seedBars),
    ).not.toThrow();

    expect(runtime.getOutput("fake")!.totalCalls).toHaveLength(2);
  });

  it("an indicator that throws during readOutput does not corrupt or block other indicators' output", () => {
    const throwingReadOutput = makeBrokenDef({
      onBar: () => {},
      readOutput: () => {
        throw new Error("boom in readOutput");
      },
    });
    const runtime = createIndicatorRuntime([
      throwingReadOutput,
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000)];

    expect(() =>
      runtime.setActive(new Set(["broken", "fake"]), {}, seedBars),
    ).not.toThrow();

    expect(runtime.getOutput("fake")!.totalCalls).toHaveLength(1);
  });

  it("a faulted indicator is latched off rather than re-thrown on every subsequent bar", () => {
    let onBarCalls = 0;
    const throwsOnce = makeBrokenDef({
      onBar: () => {
        onBarCalls += 1;
        throw new Error("boom");
      },
    });
    const runtime = createIndicatorRuntime([throwsOnce]);
    runtime.setActive(new Set(["broken"]), {}, []);

    runtime.onBar(bar(1000), "APPENDED", [bar(1000)]);
    runtime.onBar(bar(2000), "APPENDED", [bar(1000), bar(2000)]);
    runtime.onBar(bar(3000), "APPENDED", [bar(1000), bar(2000), bar(3000)]);

    expect(onBarCalls).toBe(1);
  });

  it("getOutput and getLineColors return null once faulted, instead of a stale array shorter than the live bars -- a length-mismatch crash waiting to happen in the caller", () => {
    let callCount = 0;
    const throwsOnThirdBar = makeBrokenDef({
      onBar: () => {
        callCount += 1;
        if (callCount === 3) throw new Error("boom on bar 3");
      },
      lines: [{ key: "value", color: () => "red" }],
    });
    const runtime = createIndicatorRuntime([throwsOnThirdBar]);
    const bars = [bar(1000), bar(2000), bar(3000), bar(4000), bar(5000)];

    runtime.setActive(new Set(["broken"]), {}, bars);

    expect(runtime.getOutput("broken")).toBeNull();
    expect(runtime.getLineColors("broken")).toBeNull();
  });

  it("a throwing getHoverData is contained the same way as onBar/readOutput/color: it faults only that indicator and returns null instead of throwing through the caller", () => {
    const throwingHover = makeBrokenDef({
      onBar: () => {},
      getHoverData: () => {
        throw new Error("boom in getHoverData");
      },
    });
    const runtime = createIndicatorRuntime([
      throwingHover,
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["broken", "fake"]), {}, []);

    let result: unknown;
    expect(() => {
      result = runtime.getHoverData("broken");
    }).not.toThrow();
    expect(result).toBeNull();

    // The fault is latched, and every other indicator keeps working.
    const seedBar = bar(1000);
    runtime.onBar(seedBar, "APPENDED", [seedBar]);
    expect(runtime.getOutput("fake")!.totalCalls.at(-1)).toBe(1);
  });

  it("getHoverData returns null for an already-faulted indicator, without calling its provider again", () => {
    let hoverCalls = 0;
    const throwsOnFirstBar = makeBrokenDef({
      onBar: () => {
        throw new Error("boom on first bar");
      },
      getHoverData: () => {
        hoverCalls += 1;
        return ["should never be reached"];
      },
    });
    const runtime = createIndicatorRuntime([throwsOnFirstBar]);
    runtime.setActive(new Set(["broken"]), {}, []);
    runtime.onBar(bar(1000), "APPENDED", [bar(1000)]);

    expect(runtime.getHoverData("broken")).toBeNull();
    expect(hoverCalls).toBe(0);
  });

  it("getHoverData returns null for an indicator that never declared a hover provider, rather than throwing", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["fake"]), {}, []);

    expect(runtime.getHoverData("fake")).toBeNull();
  });
});

function makeColoredFakeDef(): RuntimeIndicatorDef<FakeState, FakeSettings> {
  const base = makeFakeDef();
  return {
    ...base,
    lines: base.lines.map((line) =>
      line.key === "totalCalls"
        ? {
            key: "totalCalls",
            color: (state: FakeState) =>
              state.appendCount + state.replaceCount >= 2 ? "blue" : "red",
          }
        : line,
    ),
  };
}

describe("createIndicatorRuntime -- per-bar line color tracking", () => {
  it("returns null for indicators with no color-bearing lines", () => {
    const runtime = createIndicatorRuntime([
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    activate(runtime, [bar(1000)]);
    expect(runtime.getLineColors("fake")).toBeNull();
  });

  it("tracks one color per bar for a color-bearing line, growing in lockstep with appended values", () => {
    const runtime = createIndicatorRuntime([
      makeColoredFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    activate(runtime, [bar(1000)]);
    let bars = [bar(1000)];
    bars = [...bars, bar(2000)];
    runtime.onBar(bar(2000), "APPENDED", bars);
    bars = [...bars, bar(3000)];
    runtime.onBar(bar(3000), "APPENDED", bars);

    const colors = runtime.getLineColors("fake")!;
    expect(colors.totalCalls).toEqual(["red", "red", "blue"]);
  });

  it("overwrites the last color entry on a replace, matching the value overwrite behaviour", () => {
    const runtime = createIndicatorRuntime([
      makeColoredFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars: BarFrame[] = [];
    activate(runtime, bars);
    const openBar = bar(1000, { closed: false });
    bars.push(openBar);
    runtime.onBar(openBar, "APPENDED", bars);

    const colorsBefore = runtime.getLineColors("fake")!.totalCalls;
    expect(colorsBefore).toEqual(["red"]);

    bars[0] = bar(1000, { closed: true });
    runtime.onBar(bars[0], "REPLACED_EDGE", bars);
    const colorsAfter = runtime.getLineColors("fake")!.totalCalls;
    expect(colorsAfter).toHaveLength(1);
    expect(colorsAfter[0]).toBe("blue");
  });

  it("a color() that throws faults the indicator, matching onBar/createState/readOutput", () => {
    const throwingColor = makeBrokenDef({
      onBar: () => {},
      lines: [
        {
          key: "value",
          color: () => {
            throw new Error("boom in color");
          },
        },
      ],
    });
    const runtime = createIndicatorRuntime([
      throwingColor,
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(1000)];

    expect(() =>
      runtime.setActive(new Set(["broken", "fake"]), {}, seedBars),
    ).not.toThrow();
    expect(runtime.getOutput("fake")!.totalCalls).toHaveLength(1);
    expect(runtime.getLineColors("broken")).toBeNull();
  });

  it("a non-finite numeric output faults only its own indicator instead of forwarding invalid chart data", () => {
    const invalidOutput = makeBrokenDef({
      onBar: () => {},
      readOutput: () => ({ value: Number.NaN }),
    });
    const runtime = createIndicatorRuntime([
      invalidOutput,
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBar = bar(1000);

    expect(() =>
      runtime.setActive(new Set(["broken", "fake"]), {}, [seedBar]),
    ).not.toThrow();
    expect(runtime.getOutput("broken")).toBeNull();
    expect(runtime.getOutput("fake")!.totalCalls).toHaveLength(1);
  });

  it("an invalid output record faults only its own indicator instead of escaping the runtime boundary", () => {
    const invalidRecord = makeBrokenDef({
      onBar: () => {},
      readOutput: () => null as never,
    });
    const runtime = createIndicatorRuntime([
      invalidRecord,
      makeFakeDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBar = bar(1000);

    expect(() =>
      runtime.setActive(new Set(["broken", "fake"]), {}, [seedBar]),
    ).not.toThrow();
    expect(runtime.getOutput("broken")).toBeNull();
    expect(runtime.getOutput("fake")!.totalCalls).toHaveLength(1);
  });
});

interface ColorSettings {
  length: number;
  color: "red" | "blue";
}

function makeSettingsColoredDef(): RuntimeIndicatorDef<
  FakeState,
  ColorSettings
> {
  return {
    kind: "runtime",
    id: "colored",
    label: "Colored",
    category: "technical",
    defaultSettings: { length: 1, color: "red" },
    settingsSchema: [
      {
        kind: "numeric",
        key: "length",
        label: "Length",
        min: 1,
        max: 100,
        step: 1,
        affects: "recompute",
      },
      {
        kind: "radioGroup",
        key: "color",
        label: "Color",
        affects: "cosmetic",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" },
        ],
      },
    ],
    lines: [
      {
        key: "value",
        color: (_state, settings) => settings.color,
        recolor: (_currentColor, settings) => settings.color,
      },
    ],
    placement: { kind: "overlay" },
    createState: () => ({
      generation: 1,
      appendCount: 0,
      replaceCount: 0,
      replayCount: 0,
    }),
    onBar: (ctx) => {
      if (ctx.replaying) ctx.state.replayCount += 1;
      else if (ctx.replace) ctx.state.replaceCount += 1;
      else ctx.state.appendCount += 1;
    },
    readOutput: (state) => ({
      value: state.appendCount + state.replaceCount + state.replayCount,
    }),
  };
}

describe("createIndicatorRuntime -- cosmetic settings changes recolor already-produced output", () => {
  it("a cosmetic-only settings change immediately recolors every cached bar, without a full replay", () => {
    const runtime = createIndicatorRuntime([
      makeSettingsColoredDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(1000), bar(2000), bar(3000)];
    runtime.setActive(new Set(["colored"]), {}, bars);

    expect(runtime.getLineColors("colored")!.value).toEqual([
      "red",
      "red",
      "red",
    ]);

    runtime.updateSettings("colored", { length: 1, color: "blue" }, bars);

    expect(runtime.getLineColors("colored")!.value).toEqual([
      "blue",
      "blue",
      "blue",
    ]);
    expect(runtime.getOutput("colored")!.value).toEqual([1, 2, 3]);
  });

  it("a recompute-tagged change still recolors too, via the full replay path", () => {
    const runtime = createIndicatorRuntime([
      makeSettingsColoredDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(1000), bar(2000)];
    runtime.setActive(new Set(["colored"]), {}, bars);

    runtime.updateSettings("colored", { length: 5, color: "blue" }, bars);

    expect(runtime.getLineColors("colored")!.value).toEqual(["blue", "blue"]);
  });

  it("a cosmetic change replays instead of corrupting historical dynamic colors when the author has not supplied a safe recolor rule", () => {
    const dynamic = makeColoredFakeDef();
    const def: RuntimeIndicatorDef<FakeState, FakeSettings> = {
      ...dynamic,
      settingsSchema: FAKE_SCHEMA,
      lines: dynamic.lines.map((line) => ({ ...line, recolor: undefined })),
    };
    const runtime = createIndicatorRuntime([
      def as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(1000), bar(2000), bar(3000)];
    runtime.setActive(new Set(["fake"]), {}, bars);
    const colorsBefore = structuredClone(
      runtime.getLineColors("fake")!.totalCalls,
    );
    const generationBefore = runtime.getOutput("fake")!.generation.at(-1)!;

    runtime.updateSettings("fake", { length: 1, color: "blue" }, bars);

    expect(runtime.getOutput("fake")!.generation.at(-1)).toBeGreaterThan(
      generationBefore,
    );
    expect(runtime.getLineColors("fake")!.totalCalls).toEqual(colorsBefore);
  });
});

interface CustomFieldSettings {
  swing: number;
  cosmeticFlag: boolean;
}

function makeCustomFieldDef(
  customFieldKey: keyof CustomFieldSettings | undefined,
): RuntimeIndicatorDef<FakeState, CustomFieldSettings> {
  let createStateCalls = 0;
  const schema: readonly SettingsFieldSchema<CustomFieldSettings>[] = [
    {
      kind: "custom",
      key: customFieldKey,
      tab: "inputs",
      affects: "recompute",
      render: () => null,
    },
    {
      kind: "boolean",
      key: "cosmeticFlag",
      label: "Cosmetic",
      affects: "cosmetic",
      tab: "visibility",
    },
  ];
  return {
    kind: "runtime",
    id: "customField",
    label: "Custom Field",
    category: "technical",
    defaultSettings: { swing: 1, cosmeticFlag: false },
    settingsSchema: schema,
    lines: [{ key: "generation" }],
    placement: { kind: "overlay" },
    createState: () => {
      createStateCalls += 1;
      return {
        generation: createStateCalls,
        appendCount: 0,
        replaceCount: 0,
        replayCount: 0,
      };
    },
    onBar: () => {},
    readOutput: (state) => ({ generation: state.generation }),
  };
}

describe("createIndicatorRuntime -- a custom settings field's recompute detection (TA.05 audit finding)", () => {
  it("an unkeyed custom recompute field still conservatively replays on any settings change, including a cosmetic sibling's -- documented, intentional fallback", () => {
    const runtime = createIndicatorRuntime([
      makeCustomFieldDef(undefined) as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(1000), bar(2000)];
    runtime.setActive(new Set(["customField"]), {}, bars);
    const generationBefore = runtime
      .getOutput("customField")!
      .generation.at(-1)!;

    runtime.updateSettings(
      "customField",
      { swing: 1, cosmeticFlag: true },
      bars,
    );

    expect(runtime.getOutput("customField")!.generation.at(-1)).toBeGreaterThan(
      generationBefore,
    );
  });

  it("a keyed custom recompute field no longer forces a replay when only an unrelated cosmetic sibling changes", () => {
    const runtime = createIndicatorRuntime([
      makeCustomFieldDef("swing") as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(1000), bar(2000)];
    runtime.setActive(new Set(["customField"]), {}, bars);
    const generationBefore = runtime
      .getOutput("customField")!
      .generation.at(-1)!;

    runtime.updateSettings(
      "customField",
      { swing: 1, cosmeticFlag: true },
      bars,
    );

    expect(runtime.getOutput("customField")!.generation.at(-1)).toBe(
      generationBefore,
    );
  });

  it("a keyed custom recompute field still replays when its own value changes", () => {
    const runtime = createIndicatorRuntime([
      makeCustomFieldDef("swing") as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(1000), bar(2000)];
    runtime.setActive(new Set(["customField"]), {}, bars);
    const generationBefore = runtime
      .getOutput("customField")!
      .generation.at(-1)!;

    runtime.updateSettings(
      "customField",
      { swing: 5, cosmeticFlag: false },
      bars,
    );

    expect(runtime.getOutput("customField")!.generation.at(-1)).toBeGreaterThan(
      generationBefore,
    );
  });
});

interface BuggyState {
  value: number | null;
}

describe("TA.02 -- the ta.* persistence footgun, named regression (a stream created in onBar instead of createState)", () => {
  it("produces an obviously-wrong (always-null) output and a loud dev warning, not silently-plausible data", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const buggyDef: RuntimeIndicatorDef<BuggyState, Record<string, never>> = {
      kind: "runtime",
      id: "buggy",
      label: "Buggy",
      category: "technical",
      defaultSettings: {},
      lines: [{ key: "value" }],
      placement: { kind: "overlay" },
      createState: () => ({ value: null }),
      onBar: (ctx) => {
        // The mistake this test exists to catch: a fresh ta.sma(3) is created
        // on every single onBar call instead of once inside createState, so
        // it never actually accumulates history across bars.
        const freshEveryBar = ta.sma(3);
        ctx.state.value = freshEveryBar.push(ctx.bar.close, ctx.replace);
      },
      readOutput: (state) => ({ value: state.value }),
    };

    const runtime = createIndicatorRuntime([
      buggyDef as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [1, 2, 3, 4, 5].map((close, index) =>
      bar(index * 60_000, { close }),
    );

    runtime.setActive(new Set(["buggy"]), {}, bars);

    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain("ta.sma()");

    const output = runtime.getOutput("buggy")!;
    expect(output.value.every((value) => value === null)).toBe(true);

    errorSpy.mockRestore();
  });

  it("the correct usage (the stream created once in createState) produces real output and no warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const correctDef: RuntimeIndicatorDef<
      { sma: ReturnType<typeof ta.sma>; value: number | null },
      Record<string, never>
    > = {
      kind: "runtime",
      id: "correct",
      label: "Correct",
      category: "technical",
      defaultSettings: {},
      lines: [{ key: "value" }],
      placement: { kind: "overlay" },
      createState: () => ({ sma: ta.sma(3), value: null }),
      onBar: (ctx) => {
        ctx.state.value = ctx.state.sma.push(ctx.bar.close, ctx.replace);
      },
      readOutput: (state) => ({ value: state.value }),
    };

    const runtime = createIndicatorRuntime([
      correctDef as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [1, 2, 3, 4, 5].map((close, index) =>
      bar(index * 60_000, { close }),
    );

    runtime.setActive(new Set(["correct"]), {}, bars);

    expect(errorSpy).not.toHaveBeenCalled();
    const output = runtime.getOutput("correct")!;
    expect(output.value.at(-1)).toBeCloseTo(4, 10); // sma(3) of [3,4,5]

    errorSpy.mockRestore();
  });
});

function makeFillDef(): RuntimeIndicatorDef<
  Record<string, never>,
  Record<string, never>
> {
  return {
    kind: "runtime",
    id: "fillUser",
    label: "Fill User",
    category: "technical",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({}),
    onBar: (ctx) => {
      if (ctx.bar.close < 0) ctx.draw.fill(null, null);
      else ctx.draw.fill(ctx.bar.close, 0);
    },
    readOutput: () => ({ value: 0 }),
  };
}

function makeMarkerDef(): RuntimeIndicatorDef<
  Record<string, never>,
  Record<string, never>
> {
  return {
    kind: "runtime",
    id: "markerUser",
    label: "Marker User",
    category: "technical",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({}),
    onBar: (ctx) => {
      if (ctx.bar.close > 0) ctx.markers.plotshape({ shape: "circle" });
    },
    readOutput: () => ({ value: 0 }),
  };
}

function makeLineDef(): RuntimeIndicatorDef<
  { line: ReturnType<typeof draw.line> },
  Record<string, never>
> {
  return {
    kind: "runtime",
    id: "lineUser",
    label: "Line User",
    category: "technical",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({
      line: draw.line({ time1: 0, price1: 0, time2: 1, price2: 1 }),
    }),
    onBar: () => {},
    readOutput: () => ({ value: 0 }),
  };
}

describe("TA.03 -- ctx.draw.fill is committed once per bar-transition, null-aware", () => {
  it("records one fill point per bar during warm-start replay, null where either value is null", () => {
    const runtime = createIndicatorRuntime([
      makeFillDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [
      bar(0, { close: 1 }),
      bar(1000, { close: -1 }),
      bar(2000, { close: 2 }),
    ];
    runtime.setActive(new Set(["fillUser"]), {}, bars);

    const result = runtime.getFillPoints("fillUser")!;
    expect(result.points).toEqual([
      { time: 0, valueA: 1, valueB: 0 },
      null,
      { time: 2000, valueA: 2, valueB: 0 },
    ]);
  });

  it("APPENDED pushes one new fill point without touching earlier ones", () => {
    const runtime = createIndicatorRuntime([
      makeFillDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0, { close: 1 })];
    runtime.setActive(new Set(["fillUser"]), {}, bars);

    const nextBar = bar(1000, { close: 3 });
    bars.push(nextBar);
    runtime.onBar(nextBar, "APPENDED", bars);

    expect(runtime.getFillPoints("fillUser")!.points).toEqual([
      { time: 0, valueA: 1, valueB: 0 },
      { time: 1000, valueA: 3, valueB: 0 },
    ]);
  });

  it("REPLACED_EDGE overwrites only the last fill point, matching the numeric-output overwrite behaviour", () => {
    const runtime = createIndicatorRuntime([
      makeFillDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0, { close: 1 }), bar(1000, { close: 3, closed: false })];
    runtime.setActive(new Set(["fillUser"]), {}, bars);

    bars[1] = bar(1000, { close: 99, closed: true });
    runtime.onBar(bars[1], "REPLACED_EDGE", bars);

    expect(runtime.getFillPoints("fillUser")!.points).toEqual([
      { time: 0, valueA: 1, valueB: 0 },
      { time: 1000, valueA: 99, valueB: 0 },
    ]);
  });

  it("getFillPoints returns null once the indicator is faulted, matching getOutput/getLineColors", () => {
    const throwing = makeBrokenDef({
      onBar: () => {
        throw new Error("boom");
      },
    });
    const runtime = createIndicatorRuntime([throwing]);
    runtime.setActive(new Set(["broken"]), {}, [bar(1000)]);
    expect(runtime.getFillPoints("broken")).toBeNull();
  });
});

describe("ctx.draw.fill names its band, so one indicator can fill several at once", () => {
  /** An inner band every bar, and a ring that only starts on the third. */
  function makeTwoBandDef(): RuntimeIndicatorDef<Record<string, never>, Record<string, never>> {
    return {
      kind: "runtime",
      id: "twoBands",
      label: "Two Bands",
      category: "technical",
      defaultSettings: {},
      lines: [{ key: "value" }],
      placement: { kind: "overlay" },
      createState: () => ({}),
      onBar: (ctx) => {
        ctx.draw.fill(ctx.bar.close, 0, undefined, "inner");
        if (ctx.bar.close >= 3) ctx.draw.fill(ctx.bar.close, -1, undefined, "ring");
      },
      readOutput: () => ({ value: 0 }),
    };
  }

  it("keeps one point per bar per band, backfilling a band first used mid-series", () => {
    const runtime = createIndicatorRuntime([
      makeTwoBandDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [
      bar(0, { close: 1 }),
      bar(1000, { close: 2 }),
      bar(2000, { close: 3 }),
      bar(3000, { close: 1 }),
    ];
    runtime.setActive(new Set(["twoBands"]), {}, bars);

    expect(runtime.getFillKeys("twoBands")).toEqual(["inner", "ring"]);
    expect(runtime.getFillPoints("twoBands", "inner")!.points).toEqual([
      { time: 0, valueA: 1, valueB: 0 },
      { time: 1000, valueA: 2, valueB: 0 },
      { time: 2000, valueA: 3, valueB: 0 },
      { time: 3000, valueA: 1, valueB: 0 },
    ]);
    // The two bars the ring did not exist for are nulls, not a shorter array:
    // every band's points stay one per bar, so none can slide out of step.
    expect(runtime.getFillPoints("twoBands", "ring")!.points).toEqual([
      null,
      null,
      { time: 2000, valueA: 3, valueB: -1 },
      null,
    ]);
  });

  it("backfills a band first used on a live re-delivery of the newest bar to that bar, not one past it (PR #29 review)", () => {
    const runtime = createIndicatorRuntime([
      makeTwoBandDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0, { close: 1 }), bar(1000, { close: 2 })];
    runtime.setActive(new Set(["twoBands"]), {}, bars);
    bars[1] = bar(1000, { close: 3 });
    runtime.onBar(bars[1], "REPLACED_EDGE", bars);
    expect(runtime.getFillPoints("twoBands", "ring")!.points).toEqual([
      null,
      { time: 1000, valueA: 3, valueB: -1 },
    ]);
    expect(runtime.getFillPoints("twoBands", "inner")!.points).toHaveLength(2);
  });

  it("keeps each band's own colour, so an inner band and its ring can differ", () => {
    const def = {
      ...makeTwoBandDef(),
      id: "tinted",
      onBar: (ctx: IndicatorBarCtx<unknown, unknown>) => {
        ctx.draw.fill(ctx.bar.close, 0, { colorAbove: "#111111" }, "inner");
        ctx.draw.fill(ctx.bar.close, -1, { colorAbove: "#222222" }, "ring");
      },
    } as RuntimeIndicatorDef<unknown, unknown>;
    const runtime = createIndicatorRuntime([def]);
    runtime.setActive(new Set(["tinted"]), {}, [bar(0, { close: 1 })]);

    expect(runtime.getFillPoints("tinted", "inner")!.options?.colorAbove).toBe(
      "#111111",
    );
    expect(runtime.getFillPoints("tinted", "ring")!.options?.colorAbove).toBe(
      "#222222",
    );
  });

  it("files an unnamed fill under the default band, and never reports a band that was not filled", () => {
    const runtime = createIndicatorRuntime([
      makeFillDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["fillUser"]), {}, [bar(0, { close: 1 })]);
    expect(runtime.getFillKeys("fillUser")).toEqual(["fill"]);
    expect(runtime.getFillPoints("fillUser", "ring")).toBeNull();
  });
});

describe("TA.03 -- ctx.markers.plotshape/plotchar are batched once per bar-transition", () => {
  it("accumulates one marker per bar that satisfies the condition during warm-start replay", () => {
    const runtime = createIndicatorRuntime([
      makeMarkerDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [
      bar(0, { close: 1 }),
      bar(1000, { close: -1 }),
      bar(2000, { close: 2 }),
    ];
    runtime.setActive(new Set(["markerUser"]), {}, bars);

    const markers = runtime.getMarkers("markerUser")!;
    expect(markers.map((call) => call.time)).toEqual([0, 2000]);
  });

  it("APPENDED adds a new bar's marker onto the existing buffer", () => {
    const runtime = createIndicatorRuntime([
      makeMarkerDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0, { close: 1 })];
    runtime.setActive(new Set(["markerUser"]), {}, bars);

    const nextBar = bar(1000, { close: 5 });
    bars.push(nextBar);
    runtime.onBar(nextBar, "APPENDED", bars);

    expect(runtime.getMarkers("markerUser")!.map((call) => call.time)).toEqual([
      0, 1000,
    ]);
  });

  it("REPLACED_EDGE that flips the bar's condition to false drops that bar's marker instead of leaving a stale one", () => {
    const runtime = createIndicatorRuntime([
      makeMarkerDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0, { close: 1 }), bar(1000, { close: 3, closed: false })];
    runtime.setActive(new Set(["markerUser"]), {}, bars);
    expect(runtime.getMarkers("markerUser")!).toHaveLength(2);

    bars[1] = bar(1000, { close: -3, closed: true });
    runtime.onBar(bars[1], "REPLACED_EDGE", bars);

    expect(runtime.getMarkers("markerUser")!.map((call) => call.time)).toEqual([
      0,
    ]);
  });

  it("REBUILT recomputes markers from scratch rather than doubling up on the old buffer", () => {
    const runtime = createIndicatorRuntime([
      makeMarkerDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const seedBars = [bar(0, { close: 1 }), bar(1000, { close: 2 })];
    runtime.setActive(new Set(["markerUser"]), {}, seedBars);
    expect(runtime.getMarkers("markerUser")!).toHaveLength(2);

    const rebuiltBars = [bar(-500, { close: 1 }), ...seedBars];
    runtime.onBar(bar(-500, { close: 1 }), "REBUILT", rebuiltBars);

    expect(runtime.getMarkers("markerUser")!).toHaveLength(3);
  });

  it("getMarkers returns null once the indicator is faulted", () => {
    const throwing = makeBrokenDef({
      onBar: () => {
        throw new Error("boom");
      },
    });
    const runtime = createIndicatorRuntime([throwing]);
    runtime.setActive(new Set(["broken"]), {}, [bar(1000)]);
    expect(runtime.getMarkers("broken")).toBeNull();
  });

  it("trims sparse marker history by first retained timestamp when chart retention rolls", () => {
    const runtime = createIndicatorRuntime([
      makeMarkerDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [
      bar(0, { close: 1 }),
      bar(1000, { close: 1 }),
      bar(2000, { close: 1 }),
    ];
    runtime.setActive(new Set(["markerUser"]), {}, bars);
    runtime.discardLeading(2, 2000);
    expect(
      runtime.getMarkers("markerUser")?.map((marker) => marker.time),
    ).toEqual([2000]);
  });
});

describe("TA.03 -- deactivating an indicator clears its registered draw objects", () => {
  it("a draw.line() created in createState is removed from the registry once its indicator is deactivated", () => {
    const runtime = createIndicatorRuntime([
      makeLineDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["lineUser"]), {}, [bar(0)]);
    const drawOwnerId = runtime.getDrawOwnerId("lineUser");
    expect(drawOwnerId).not.toBeNull();
    expect(handlesForOwners([drawOwnerId!])).toHaveLength(1);

    runtime.setActive(new Set([]), {}, [bar(0)]);
    expect(handlesForOwners([drawOwnerId!])).toEqual([]);
  });

  it("a settings-triggered full replay does not accumulate a second copy of the same indicator's objects", () => {
    const runtime = createIndicatorRuntime([
      makeLineDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0)];
    runtime.setActive(new Set(["lineUser"]), {}, bars);
    const drawOwnerId = runtime.getDrawOwnerId("lineUser");
    expect(handlesForOwners([drawOwnerId!])).toHaveLength(1);

    runtime.updateSettings("lineUser", {}, bars);
    expect(handlesForOwners([drawOwnerId!])).toHaveLength(1);
  });

  it("isolates same-id draw objects owned by separate chart runtimes", () => {
    const def = makeLineDef() as RuntimeIndicatorDef<unknown, unknown>;
    const first = createIndicatorRuntime([def]);
    const second = createIndicatorRuntime([def]);
    first.setActive(new Set(["lineUser"]), {}, [bar(0)]);
    second.setActive(new Set(["lineUser"]), {}, [bar(0)]);

    const firstOwner = first.getDrawOwnerId("lineUser");
    const secondOwner = second.getDrawOwnerId("lineUser");
    expect(firstOwner).not.toBe(secondOwner);
    expect(handlesForOwners([firstOwner!])).toHaveLength(1);
    expect(handlesForOwners([secondOwner!])).toHaveLength(1);

    first.setActive(new Set([]), {}, [bar(0)]);
    expect(handlesForOwners([firstOwner!])).toEqual([]);
    expect(handlesForOwners([secondOwner!])).toHaveLength(1);
  });
});

function makeTradesDef(): RuntimeIndicatorDef<
  { tradeCount: number },
  Record<string, never>
> {
  return {
    kind: "runtime",
    id: "tradesUser",
    label: "Trades User",
    category: "technical",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({ tradeCount: 0 }),
    onBar: (ctx) => {
      ctx.state.tradeCount = ctx.trades.length;
    },
    readOutput: (state) => ({ value: state.tradeCount }),
  };
}

describe("TA.03.5 -- ctx.trades is handed to onBar for live bars, always empty during replay", () => {
  it("is empty for every bar during warm-start replay", () => {
    const runtime = createIndicatorRuntime([
      makeTradesDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["tradesUser"]), {}, [bar(0), bar(1000)]);
    expect(runtime.getOutput("tradesUser")!.value).toEqual([0, 0]);
  });

  it("passes real trades through on an APPENDED bar", () => {
    const runtime = createIndicatorRuntime([
      makeTradesDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["tradesUser"]), {}, [bar(0)]);
    const bars = [bar(0), bar(1000)];
    runtime.onBar(bar(1000), "APPENDED", bars, [
      trade(1000),
      trade(1010),
      trade(1020),
    ]);
    expect(runtime.getOutput("tradesUser")!.value).toEqual([0, 3]);
  });

  it("passes real trades through on a REPLACED_EDGE bar, overwriting the prior tentative value", () => {
    const runtime = createIndicatorRuntime([
      makeTradesDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["tradesUser"]), {}, []);
    const bars: BarFrame[] = [];

    const openBar = bar(1000, { closed: false });
    bars.push(openBar);
    runtime.onBar(openBar, "APPENDED", bars, [trade(1000)]);
    expect(runtime.getOutput("tradesUser")!.value).toEqual([1]);

    const closedBar = bar(1000, { closed: true });
    bars[0] = closedBar;
    runtime.onBar(closedBar, "REPLACED_EDGE", bars, [
      trade(1000),
      trade(1010),
      trade(1020),
    ]);
    expect(runtime.getOutput("tradesUser")!.value).toEqual([3]);
  });

  it("defaults to empty trades when the caller omits the argument, matching every pre-existing call site", () => {
    const runtime = createIndicatorRuntime([
      makeTradesDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["tradesUser"]), {}, [bar(0)]);
    const bars = [bar(0), bar(1000)];
    runtime.onBar(bar(1000), "APPENDED", bars);
    expect(runtime.getOutput("tradesUser")!.value).toEqual([0, 0]);
  });

  it("REBUILT always yields empty trades even if a non-empty array is (wrongly) passed", () => {
    const runtime = createIndicatorRuntime([
      makeTradesDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["tradesUser"]), {}, [bar(0)]);
    const bars = [bar(0), bar(1000)];
    runtime.onBar(bar(1000), "APPENDED", bars, [trade(1000)]);
    expect(runtime.getOutput("tradesUser")!.value).toEqual([0, 1]);

    const rebuiltBars = [bar(-500), ...bars];
    runtime.onBar(bar(-500), "REBUILT", rebuiltBars, [trade(1000)]);
    expect(runtime.getOutput("tradesUser")!.value).toEqual([0, 0, 0]);
  });
});

function makeLiquidityDef(): RuntimeIndicatorDef<
  { columns: number },
  Record<string, never>
> {
  return {
    kind: "runtime",
    id: "liquidityUser",
    label: "Liquidity User",
    category: "l2",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({ columns: -1 }),
    onBar: (ctx) => {
      ctx.state.columns = ctx.liquidity
        ? ctx.liquidity.feed.fine.columns.length
        : -1;
    },
    readOutput: (state) => ({ value: state.columns }),
  };
}

function fakeLiquidity(columnCount: number): IndicatorLiquidity {
  return {
    feed: {
      epoch: 1,
      deep: null,
      fine: {
        columns: Array.from({ length: columnCount }, (_, index) => ({
          ts: index * 1000,
          lo: 0,
          hi: 0,
          bid: new Float64Array(1),
          ask: new Float64Array(1),
        })),
        columnMs: 1000,
      },
    },
    rowWidth: 2,
    baseAsset: "BTC",
    version: columnCount,
  };
}

describe("TA.03.6 -- ctx.liquidity hands the resting book to onBar, replay included", () => {
  it("cuts historical liquidity at every bar close, including replay, and never replaces a refused cut with the full feed", () => {
    const runtime = createIndicatorRuntime([makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>]);
    const atTime = vi.fn((time: number) => time === 2000 ? null : fakeLiquidity(time / 1000));
    runtime.setLiquidity({ ...fakeLiquidity(99), atTime });
    const bars = [0, 1000, 2000].map((ts) => bar(ts, { interval_ms: 1000 }));
    runtime.setActive(new Set(["liquidityUser"]), {}, bars);
    expect(atTime.mock.calls.map(([time]) => time)).toEqual([1000, 2000, 3000]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([1, -1, 3]);
    const next = bar(3000, { interval_ms: 1000 });
    runtime.onBar(next, "APPENDED", [...bars, next]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([1, -1, 3, 4]);
  });
  it("is absent until the chart supplies a book, so an indicator can tell 'no feed' from 'empty feed'", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["liquidityUser"]), {}, [bar(0)]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([-1]);
  });

  it("reaches an APPENDED bar once set", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setActive(new Set(["liquidityUser"]), {}, [bar(0)]);
    runtime.setLiquidity(fakeLiquidity(4));
    runtime.onBar(bar(1000), "APPENDED", [bar(0), bar(1000)]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([-1, 4]);
  });

  it("is present during a full replay, unlike trades -- the book has history where the tape does not", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setLiquidity(fakeLiquidity(3));
    runtime.setActive(new Set(["liquidityUser"]), {}, [bar(0), bar(1000)]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([3, 3]);
  });

  it("reaches an indicator activated after the book arrived", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setLiquidity(fakeLiquidity(2));
    runtime.setActive(new Set(["liquidityUser"]), {}, []);
    runtime.onBar(bar(0), "APPENDED", [bar(0)]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([2]);
  });

  it("clears back to absent when the chart withdraws the book, rather than serving a stale one", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    runtime.setLiquidity(fakeLiquidity(5));
    runtime.setActive(new Set(["liquidityUser"]), {}, [bar(0)]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([5]);
    runtime.setLiquidity(null);
    runtime.onBar(bar(1000), "APPENDED", [bar(0), bar(1000)]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([5, -1]);
  });
});

describe("TA.03.7 -- the book arriving replays, the way a settings change does", () => {
  it("does not replay candle or trade indicators when only the L2 feed changes", () => {
    const onCandleBar = vi.fn();
    const candleDef: RuntimeIndicatorDef<{ value: number }, Record<string, never>> = {
      kind: "runtime", id: "candleOnly", label: "Candle Only", category: "technical",
      defaultSettings: {}, lines: [{ key: "value" }], placement: { kind: "overlay" },
      createState: () => ({ value: 0 }),
      onBar: (ctx) => { onCandleBar(); ctx.state.value += 1; },
      readOutput: (state) => ({ value: state.value }),
    };
    const runtime = createIndicatorRuntime([
      candleDef as RuntimeIndicatorDef<unknown, unknown>,
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0), bar(1000)];
    runtime.setActive(new Set(["candleOnly", "liquidityUser"]), {}, bars);
    expect(onCandleBar).toHaveBeenCalledTimes(2);
    runtime.setLiquidity(fakeLiquidity(4), bars);
    expect(onCandleBar).toHaveBeenCalledTimes(2);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([4, 4]);
    runtime.setLiquidity(null, bars);
    expect(onCandleBar).toHaveBeenCalledTimes(2);
  });

  it("re-runs every bar when the book arrives, so an indicator that ran without one is not left stale until the next bar closes", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0), bar(1000)];
    runtime.setActive(new Set(["liquidityUser"]), {}, bars);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([-1, -1]);

    runtime.setLiquidity(fakeLiquidity(4), bars);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([4, 4]);
  });

  it("replays on withdrawal too, so zones judged against a book do not keep its verdict once it is gone", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0), bar(1000)];
    runtime.setLiquidity(fakeLiquidity(4), bars);
    runtime.setActive(new Set(["liquidityUser"]), {}, bars);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([4, 4]);

    runtime.setLiquidity(null, bars);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([-1, -1]);
  });

  it("does not replay when the same book is handed over again, which would be a full recompute on every frame", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0), bar(1000)];
    const reader = fakeLiquidity(4);
    runtime.setLiquidity(reader, bars);
    runtime.setActive(new Set(["liquidityUser"]), {}, bars);
    const generation = runtime.getDrawOwnerId("liquidityUser");

    runtime.setLiquidity(reader, bars);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([4, 4]);
    expect(runtime.getDrawOwnerId("liquidityUser")).toBe(generation);
  });

  it("still takes the book without bars, leaving it to apply from the next bar on", () => {
    const runtime = createIndicatorRuntime([
      makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>,
    ]);
    const bars = [bar(0), bar(1000)];
    runtime.setActive(new Set(["liquidityUser"]), {}, bars);
    runtime.setLiquidity(fakeLiquidity(4));
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([-1, -1]);

    runtime.onBar(bar(2000), "APPENDED", [...bars, bar(2000)]);
    expect(runtime.getOutput("liquidityUser")!.value).toEqual([-1, -1, 4]);
  });
});

function makeBandDef(): RuntimeIndicatorDef<{ answered: number[] }, Record<string, never>> {
  return {
    kind: "runtime",
    id: "bandUser",
    label: "Band User",
    category: "l2",
    defaultSettings: {},
    lines: [{ key: "value" }],
    placement: { kind: "overlay" },
    createState: () => ({ answered: [] }),
    onBar: (ctx) => {
      ctx.state.answered.push(ctx.bandHistory ? (ctx.bandHistory.feedFor("k") === null ? 0 : 1) : -1);
    },
    readOutput: (state) => ({ value: state.answered[state.answered.length - 1] }),
    bandHistoryWanted: () => [{ key: "k", fromTs: 0, toTs: 1, priceLo: 1, priceHi: 2, columnMs: 10_000 }],
  };
}

function fakeBands(version: number, answered: boolean): IndicatorBandHistory {
  return {
    version,
    older: () => false,
    feedFor: () => (answered ? { feed: { epoch: 1, deep: null, fine: { columns: [], columnMs: 10_000 } }, rowWidth: 1, gaps: [] } : null),
  };
}

describe("ctx.bandHistory hands the host's band answers to onBar and replays when they change", () => {
  it("is absent until a store is set, then reaches onBar and replays only the indicators that declare wants, only when the store's version moves", () => {
    const calls = { band: 0, plain: 0 };
    const bandDef = makeBandDef();
    const counted: RuntimeIndicatorDef<{ answered: number[] }, Record<string, never>> = { ...bandDef, onBar: (ctx) => { calls.band += 1; bandDef.onBar(ctx); } };
    const plain: RuntimeIndicatorDef<{ columns: number }, Record<string, never>> = { ...makeLiquidityDef(), id: "plainUser", lines: [{ key: "plain" }], readOutput: (state) => ({ plain: state.columns }), onBar: () => { calls.plain += 1; } };
    const runtime = createIndicatorRuntime([counted as RuntimeIndicatorDef<unknown, unknown>, plain as RuntimeIndicatorDef<unknown, unknown>]);
    const bars = [bar(0), bar(1000)];
    runtime.setActive(new Set(["bandUser", "plainUser"]), {}, bars);
    expect(runtime.getOutput("bandUser")!.value).toEqual([-1, -1]);
    expect(calls).toEqual({ band: 2, plain: 2 });
    runtime.setBandHistory(fakeBands(1, false), bars);
    expect(runtime.getOutput("bandUser")!.value).toEqual([0, 0]);
    expect(calls).toEqual({ band: 4, plain: 2 });
    const same = fakeBands(1, true);
    runtime.setBandHistory(same, bars);
    expect(runtime.getOutput("bandUser")!.value).toEqual([1, 1]);
    expect(calls).toEqual({ band: 6, plain: 2 });
    runtime.setBandHistory(same, bars);
    expect(calls).toEqual({ band: 6, plain: 2 });
    (same as { version: number }).version = 2;
    runtime.setBandHistory(same, bars);
    expect(calls).toEqual({ band: 8, plain: 2 });
    runtime.onBar(bar(2000), "APPENDED", [...bars, bar(2000)], []);
    expect(runtime.getOutput("bandUser")!.value).toEqual([1, 1, 1]);
    runtime.setBandHistory(null, [...bars, bar(2000)]);
    expect(runtime.getOutput("bandUser")!.value).toEqual([-1, -1, -1]);
  });

  it("collects the wants of every active indicator that declares them, and none from one that does not", () => {
    const runtime = createIndicatorRuntime([makeBandDef() as RuntimeIndicatorDef<unknown, unknown>, makeLiquidityDef() as RuntimeIndicatorDef<unknown, unknown>]);
    expect(runtime.bandHistoryWants()).toEqual([]);
    runtime.setActive(new Set(["bandUser", "liquidityUser"]), {}, [bar(0)]);
    expect(runtime.bandHistoryWants()).toEqual([{ key: "k", fromTs: 0, toTs: 1, priceLo: 1, priceHi: 2, columnMs: 10_000 }]);
    runtime.setActive(new Set(["liquidityUser"]), {}, [bar(0)]);
    expect(runtime.bandHistoryWants()).toEqual([]);
  });
});
