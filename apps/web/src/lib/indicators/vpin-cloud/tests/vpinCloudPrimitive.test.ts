import { describe, expect, it, vi } from "vitest";
import { VpinCloudPrimitive, DEFAULT_VPIN_CLOUD_SETTINGS } from "../vpinCloudPrimitive";
import type { BarFrame, VpinReading } from "../../../../types/frames";

function fakeCanvasTarget() {
  const fillCalls: number[] = [];
  const saveStack: Array<Record<string, unknown>> = [];
  const STYLE_KEYS = ["fillStyle", "strokeStyle", "lineWidth"] as const;
  const context = {
    save: () => {
      saveStack.push(Object.fromEntries(STYLE_KEYS.map((k) => [k, (context as Record<string, unknown>)[k]])));
    },
    restore: () => {
      const top = saveStack.pop();
      if (top) for (const k of STYLE_KEYS) (context as Record<string, unknown>)[k] = top[k];
    },
    fillStyle: "",
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => fillCalls.push(1),
  };
  return {
    fillCalls,
    context,
    saveStack,
    useMediaCoordinateSpace: (callback: (scope: { context: typeof context }) => void) => callback({ context }),
  };
}

function fakeTimeScale({ hasPoints = true, widthPx = 800 } = {}) {
  return {
    timeToCoordinate: (time: number) => (hasPoints ? time * 10 : null),
    width: () => widthPx,
  };
}

function attach(primitive: VpinCloudPrimitive, timeScaleOverrides: Parameters<typeof fakeTimeScale>[0] = {}) {
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: { timeScale: () => fakeTimeScale(timeScaleOverrides) },
    series: { priceToCoordinate: (price: number) => price * 2 },
    requestUpdate,
  } as never);
  return requestUpdate;
}

function bar(tsOpen: number): BarFrame {
  return {
    type: "bar", provider: "BINANCE", symbol: "BTC-USDT", marketKind: "SPOT",
    interval_ms: 100, ts_open: tsOpen, open: 100, high: 105, low: 95, close: 100,
    volume: 10, trade_count: 5, closed: true,
  };
}

function reading(sealTs: number, overrides: Partial<VpinReading> = {}): VpinReading {
  return {
    seal_ts: sealTs, active: true, direction: "buy", strength: 0.5,
    z_vpin: 1, z_velocity: 0.1, z_acceleration: 0.01, activated_at_ts: sealTs - 10,
    ...overrides,
  };
}

describe("VpinCloudPrimitive", () => {
  it("renders nothing before it has ever been attached", () => {
    const primitive = new VpinCloudPrimitive();
    primitive.setReadings([reading(200)]);
    primitive.setBars([bar(0)]);
    primitive.updateAllViews();

    expect(primitive.renderPolygons).toEqual([]);
  });

  it("renders nothing when there are no readings, or no bars", () => {
    const primitive = new VpinCloudPrimitive();
    attach(primitive);
    primitive.setBars([bar(0), bar(100)]);
    primitive.updateAllViews();
    expect(primitive.renderPolygons).toEqual([]);

    primitive.setReadings([reading(200)]);
    primitive.setBars([]);
    primitive.updateAllViews();
    expect(primitive.renderPolygons).toEqual([]);
  });

  it("produces one polygon per cloud layer for an active run", () => {
    const primitive = new VpinCloudPrimitive();
    attach(primitive);
    primitive.setBars([bar(0), bar(100), bar(200)]);
    primitive.setReadings([reading(50, { direction: "buy", strength: 0.6 })]);
    primitive.updateAllViews();

    expect(primitive.renderPolygons.length).toBe(4);
    expect(primitive.renderPolygons.every((p) => p.fill.startsWith("rgba(16,220,128,"))).toBe(true);
  });

  it("renders on the sell side with the sell color when direction is sell", () => {
    const primitive = new VpinCloudPrimitive();
    attach(primitive);
    primitive.setBars([bar(0), bar(100)]);
    primitive.setReadings([reading(50, { direction: "sell", strength: 0.6 })]);
    primitive.updateAllViews();

    expect(primitive.renderPolygons.length).toBeGreaterThan(0);
    expect(primitive.renderPolygons.every((p) => p.fill.startsWith("rgba(255,64,64,"))).toBe(true);
  });

  it("never renders both sides for the same run -- VPIN direction is mutually exclusive by design", () => {
    const primitive = new VpinCloudPrimitive();
    attach(primitive);
    primitive.setBars([bar(0), bar(100)]);
    primitive.setReadings([
      reading(50, { direction: "buy", strength: 0.6 }),
      reading(150, { direction: "sell", strength: 0.4 }),
    ]);
    primitive.updateAllViews();

    const hasBuy = primitive.renderPolygons.some((p) => p.fill.includes("16,220,128"));
    const hasSell = primitive.renderPolygons.some((p) => p.fill.includes("255,64,64"));
    expect(hasBuy && hasSell).toBe(false);
  });

  it("actually draws a filled shape per polygon through the pane view -- not just computes geometry", () => {
    const primitive = new VpinCloudPrimitive();
    attach(primitive);
    primitive.setBars([bar(0), bar(100), bar(200)]);
    primitive.setReadings([reading(50, { direction: "buy", strength: 0.6 })]);
    primitive.updateAllViews();

    const target = fakeCanvasTarget();
    primitive.paneViews()[0].renderer()?.draw?.(target as never);

    expect(target.fillCalls.length).toBe(primitive.renderPolygons.length);
  });

  // L1L2-V2-087. Every pane primitive draws onto the same shared 2D context,
  // in attach order. A primitive that assigns fillStyle and returns without
  // restoring leaves its colour sitting there for whatever draws next, so the
  // next indicator's appearance depends on which indicators happen to be
  // enabled and in what order -- exactly the cross-indicator coupling Phase 18
  // existed to remove. Latent today only because every other primitive happens
  // to assign before it draws.
  it("leaves the shared canvas context exactly as it found it", () => {
    const primitive = new VpinCloudPrimitive();
    attach(primitive);
    primitive.setBars([bar(0), bar(100), bar(200)]);
    primitive.setReadings([reading(50, { direction: "buy", strength: 0.6 })]);
    primitive.updateAllViews();

    const target = fakeCanvasTarget();
    target.context.fillStyle = "#sentinel";
    primitive.paneViews()[0].renderer()?.draw?.(target as never);

    expect(target.context.fillStyle).toBe("#sentinel");
    expect(target.saveStack).toHaveLength(0);
  });

  it("calls requestUpdate on every setter", () => {
    const primitive = new VpinCloudPrimitive();
    const requestUpdate = attach(primitive);
    requestUpdate.mockClear();

    primitive.setReadings([reading(50)]);
    primitive.setBars([bar(0)]);
    primitive.setSettings(DEFAULT_VPIN_CLOUD_SETTINGS);

    expect(requestUpdate).toHaveBeenCalledTimes(3);
  });

  it("does not redraw retained VPIN history for idle animation ticks", () => {
    const primitive = new VpinCloudPrimitive();
    const requestUpdate = attach(primitive);
    primitive.setReadings([reading(50, { active: false, direction: null, strength: 0, activated_at_ts: null })]);
    requestUpdate.mockClear();

    primitive.setMotionNow(1_000);

    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("stops requesting the motion clock once an active cloud has finished blooming", () => {
    const primitive = new VpinCloudPrimitive();
    const requestUpdate = attach(primitive);
    primitive.setReadings([reading(50, { activated_at_ts: 50 })]);
    primitive.setMotionOptions({ bloomDurationMs: 100 });
    primitive.setMotionNow(60);
    requestUpdate.mockClear();

    primitive.setMotionNow(1_000);
    expect(requestUpdate).toHaveBeenCalledTimes(1); // final settle redraw

    requestUpdate.mockClear();
    primitive.setMotionNow(1_100);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("clears geometry on detach", () => {
    const primitive = new VpinCloudPrimitive();
    attach(primitive);
    primitive.setBars([bar(0), bar(100)]);
    primitive.setReadings([reading(50, { strength: 0.6 })]);
    primitive.updateAllViews();
    expect(primitive.renderPolygons.length).toBeGreaterThan(0);

    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.renderPolygons).toEqual([]);
  });

  function alphaOf(fill: string): number {
    return Number(/,([^,]+)\)$/.exec(fill)?.[1]);
  }

  describe("motion layer", () => {
    it("boosts every polygon's alpha right at activation, settling back to baseline after the bloom window", () => {
      const primitive = new VpinCloudPrimitive();
      attach(primitive);
      primitive.setBars([bar(0), bar(100)]);
      primitive.setReadings([reading(1_000, { activated_at_ts: 1_000 })]);
      primitive.setMotionOptions({ bloomDurationMs: 500 });

      primitive.setMotionNow(1_000);
      primitive.updateAllViews();
      const boosted = primitive.renderPolygons.map((p) => alphaOf(p.fill));

      primitive.setMotionNow(10_000);
      primitive.updateAllViews();
      const settled = primitive.renderPolygons.map((p) => alphaOf(p.fill));

      expect(boosted.every((a, i) => a > settled[i])).toBe(true);
    });

    it("boosts only the outermost layer's alpha from acceleration, leaving the inner layers untouched", () => {
      const primitive = new VpinCloudPrimitive();
      attach(primitive);
      primitive.setBars([bar(0), bar(100), bar(200)]);
      primitive.setReadings([reading(50, { activated_at_ts: 50, z_acceleration: 5 })]);
      primitive.setMotionOptions({ bloomDurationMs: 0, edgeAccelScale: 2 });
      primitive.setMotionNow(2_000);
      primitive.updateAllViews();

      const outer = primitive.renderPolygons.filter((p) => p.layerIndex === 0);
      const inner = primitive.renderPolygons.filter((p) => p.layerIndex > 0);
      expect(outer.length).toBeGreaterThan(0);
      expect(inner.length).toBeGreaterThan(0);

      primitive.setMotionOptions({ bloomDurationMs: 0, edgeAccelScale: 2 });
      primitive.setReadings([reading(50, { activated_at_ts: 50, z_acceleration: 0 })]);
      primitive.updateAllViews();
      const outerNoAccel = primitive.renderPolygons.filter((p) => p.layerIndex === 0);
      const innerNoAccel = primitive.renderPolygons.filter((p) => p.layerIndex > 0);

      expect(alphaOf(outer[0].fill)).toBeGreaterThan(alphaOf(outerNoAccel[0].fill));
      expect(alphaOf(inner[0].fill)).toBeCloseTo(alphaOf(innerNoAccel[0].fill), 10);
    });

    it("keeps rendering the last active cloud, fading it out, through the decay window after deactivation", () => {
      const primitive = new VpinCloudPrimitive();
      attach(primitive);
      // Two bars whose closes both sit at/after the deactivation reading's
      // own seal_ts, deliberately: this is the case the cache actually
      // covers -- deactivation superseding the active reading for every
      // bar currently on screen, so the fresh geometry goes fully empty (a
      // bar an OLDER reading already covers keeps showing its own true
      // historical state regardless, by design -- decay only matters once
      // the live edge itself has nothing left to draw).
      primitive.setBars([bar(0), bar(10)]);
      primitive.setMotionOptions({ decayDurationMs: 800 });

      primitive.setReadings([reading(5, { direction: "buy", strength: 0.6, activated_at_ts: 5 })]);
      primitive.setMotionNow(5);
      primitive.updateAllViews();
      const activePolygons = primitive.renderPolygons;
      expect(activePolygons.length).toBeGreaterThan(0);

      primitive.setReadings([
        reading(5, { direction: "buy", strength: 0.6, activated_at_ts: 5 }),
        reading(8, { active: false, direction: null, strength: 0, activated_at_ts: null }),
      ]);
      primitive.setMotionNow(400);
      primitive.updateAllViews();

      expect(primitive.renderPolygons.length).toBe(activePolygons.length);
      expect(alphaOf(primitive.renderPolygons[0].fill)).toBeLessThan(alphaOf(activePolygons[0].fill));

      primitive.setMotionNow(2_000);
      primitive.updateAllViews();
      expect(primitive.renderPolygons).toEqual([]);
    });

    it("re-projects the decaying cloud through the chart's current pan/zoom, not a stale cached screen position", () => {
      const primitive = new VpinCloudPrimitive();
      let priceScale = 2;
      const requestUpdate = vi.fn();
      primitive.attached({
        chart: { timeScale: () => fakeTimeScale() },
        series: { priceToCoordinate: (price: number) => price * priceScale },
        requestUpdate,
      } as never);
      primitive.setBars([bar(0), bar(10)]);
      primitive.setMotionOptions({ decayDurationMs: 800 });
      primitive.setReadings([reading(5, { direction: "buy", strength: 0.6, activated_at_ts: 5 })]);
      primitive.setMotionNow(5);
      primitive.updateAllViews();
      const activeY = primitive.renderPolygons[0].points[0].y;

      primitive.setReadings([
        reading(5, { direction: "buy", strength: 0.6, activated_at_ts: 5 }),
        reading(8, { active: false, direction: null, strength: 0, activated_at_ts: null }),
      ]);
      priceScale = 20;
      primitive.setMotionNow(400);
      primitive.updateAllViews();

      expect(primitive.renderPolygons.length).toBeGreaterThan(0);
      expect(primitive.renderPolygons[0].points[0].y).not.toBe(activeY);
      expect(primitive.renderPolygons[0].points[0].y).toBe(95 * 20 + 4);
    });
  });
});
