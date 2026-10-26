// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AbsorptionPrimitive } from "./absorption-detector/absorptionPrimitive";
import { AggressiveOrdersPrimitive } from "./aggressive-orders/aggressiveOrdersPrimitive";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function installAnimationFrame(): ReturnType<typeof vi.fn> {
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 41));
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return cancel;
}

describe("chart primitive lifecycle", () => {
  it("cancels Aggressive Orders' pending repaint when detached", () => {
    const cancel = installAnimationFrame();
    const primitive = new AggressiveOrdersPrimitive({ buy: "#fff", sell: "#000", stroke: "#111" });

    primitive.setSettings(primitive.settings);
    primitive.detached();

    expect(cancel).toHaveBeenCalledExactlyOnceWith(41);
  });

  it("cancels Absorption's pending repaint when detached", () => {
    const cancel = installAnimationFrame();
    const primitive = new AbsorptionPrimitive();

    primitive.setSettings(primitive.settings);
    primitive.detached();

    expect(cancel).toHaveBeenCalledExactlyOnceWith(41);
  });

  it("cancels timer-fallback repaints without requiring browser animation APIs", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const aggressive = new AggressiveOrdersPrimitive({ buy: "#fff", sell: "#000", stroke: "#111" });
    const absorption = new AbsorptionPrimitive();

    aggressive.setSettings(aggressive.settings);
    absorption.setSettings(absorption.settings);

    expect(() => {
      aggressive.detached();
      absorption.detached();
    }).not.toThrow();
    expect(clear).toHaveBeenCalled();
  });

  it("wakes the throttled absorption recompute once its interval has passed, and has no judgement timer to wait on since a sphere prints at once", () => {
    vi.useFakeTimers();
    const primitive = new AbsorptionPrimitive();
    const internal = primitive as unknown as {
      _schedule: () => void;
      _scheduleNextJudgement?: unknown;
      _scheduleRecompute: (now: number) => void;
    };
    const schedule = vi.spyOn(internal, "_schedule");

    expect(internal._scheduleNextJudgement).toBeUndefined();
    internal._scheduleRecompute(0);

    vi.advanceTimersByTime(254);
    expect(schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(schedule).toHaveBeenCalledExactlyOnceWith();
  });
});
