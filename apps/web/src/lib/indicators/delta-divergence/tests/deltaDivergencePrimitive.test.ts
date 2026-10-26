import { describe, expect, it, vi } from "vitest";
import { DeltaDivergencePrimitive } from "../deltaDivergencePrimitive";
import type { Divergence } from "../deltaDivergence";

const divergence: Divergence = {
  type: "bearish",
  priceFrom: { index: 0, ts_open: 60_000, price: 100 },
  priceTo: { index: 1, ts_open: 120_000, price: 110 },
  cvdFrom: { index: 0, ts_open: 60_000, value: 40 },
  cvdTo: { index: 1, ts_open: 120_000, value: 10 },
  reasons: [],
};

function attach(
  primitive: DeltaDivergencePrimitive,
  visibleRange: { from: number; to: number } | null = { from: 0, to: 1_000 },
) {
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: {
      timeScale: () => ({
        getVisibleRange: () => visibleRange,
        timeToCoordinate: (time: number) => time * 10,
      }),
    },
    series: { priceToCoordinate: (price: number) => price * 2 },
    requestUpdate,
  } as never);
  return requestUpdate;
}

// This suite covered geometry only -- renderLines/renderBands -- and never
// drove a renderer, so the draw path had no coverage at all. L1L2-V2-087 lives
// on that path.
function fakeCanvasTarget() {
  const saveStack: Array<Record<string, unknown>> = [];
  const STYLE_KEYS = ["fillStyle", "strokeStyle", "lineWidth"] as const;
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    save: () => {
      saveStack.push(
        Object.fromEntries(
          STYLE_KEYS.map((k) => [k, (context as Record<string, unknown>)[k]]),
        ),
      );
    },
    restore: () => {
      const top = saveStack.pop();
      if (top)
        for (const k of STYLE_KEYS)
          (context as Record<string, unknown>)[k] = top[k];
    },
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
  };
  return {
    context,
    saveStack,
    useMediaCoordinateSpace: (
      callback: (scope: {
        context: typeof context;
        mediaSize: { width: number; height: number };
      }) => void,
    ) => callback({ context, mediaSize: { width: 800, height: 400 } }),
  };
}

describe("DeltaDivergencePrimitive", () => {
  it("draws price-kind lines from the swing prices when constructed with valueKind 'price'", () => {
    const primitive = new DeltaDivergencePrimitive("price");
    const requestUpdate = attach(primitive);

    primitive.setDivergences([divergence]);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive.updateAllViews();

    expect(primitive.renderLines).toEqual([
      expect.objectContaining({ y1: 200, y2: 220, color: "#dc2626" }),
    ]);
    expect(primitive.renderBands).toEqual([
      expect.objectContaining({ x1: 600, x2: 1200 }),
    ]);
  });

  it("draws cvd-kind lines from the cvd values when constructed with valueKind 'cvd'", () => {
    const primitive = new DeltaDivergencePrimitive("cvd");
    attach(primitive);

    primitive.setDivergences([divergence]);
    primitive.updateAllViews();

    expect(primitive.renderLines).toEqual([
      expect.objectContaining({ y1: 80, y2: 20, color: "#dc2626" }),
    ]);
  });

  it("excludes a divergence entirely outside the visible time range", () => {
    const primitive = new DeltaDivergencePrimitive("price");
    attach(primitive, { from: 500, to: 1_000 });

    primitive.setDivergences([divergence]);
    primitive.updateAllViews();

    expect(primitive.renderLines).toEqual([]);
    expect(primitive.renderBands).toEqual([]);
  });

  it("uses its own default line colors until a host supplies a palette", () => {
    const primitive = new DeltaDivergencePrimitive("cvd");
    attach(primitive);
    primitive.setDivergences([divergence]);
    primitive.updateAllViews();
    expect(primitive.renderLines).toEqual([
      expect.objectContaining({ color: "#dc2626" }),
    ]);

    // A host whose pane uses a brighter palette overrides both directions,
    // and the override survives later data-only updates.
    primitive.setLinePalette({ bullish: "#22c55e", bearish: "#e43535" });
    primitive.updateAllViews();
    expect(primitive.renderLines).toEqual([
      expect.objectContaining({ color: "#e43535" }),
    ]);

    primitive.setDivergences([divergence]);
    primitive.updateAllViews();
    expect(primitive.renderLines).toEqual([
      expect.objectContaining({ color: "#e43535" }),
    ]);
  });

  it("clears stale render state when divergences are removed or the primitive detaches", () => {
    const primitive = new DeltaDivergencePrimitive("price");
    attach(primitive);
    primitive.setDivergences([divergence]);
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(1);

    primitive.setDivergences([]);
    primitive.updateAllViews();
    expect(primitive.renderLines).toEqual([]);
    expect(primitive.renderBands).toEqual([]);

    primitive.setDivergences([divergence]);
    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.renderLines).toEqual([]);
    expect(primitive.renderBands).toEqual([]);
  });

  // Every pane primitive shares one 2D context, drawn in attach order. A
  // primitive that assigns fillStyle/strokeStyle/lineWidth and returns without
  // restoring leaves them set for whatever draws next.
  it("leaves the shared canvas context exactly as it found it, on every pane view", () => {
    const primitive = new DeltaDivergencePrimitive("price");
    attach(primitive);
    primitive.setDivergences([divergence]);
    primitive.updateAllViews();

    for (const view of primitive.paneViews()) {
      const target = fakeCanvasTarget();
      target.context.fillStyle = "#sentinelFill";
      target.context.strokeStyle = "#sentinelStroke";
      target.context.lineWidth = 99;

      view.renderer()?.draw?.(target as never);

      expect(target.context.fillStyle).toBe("#sentinelFill");
      expect(target.context.strokeStyle).toBe("#sentinelStroke");
      expect(target.context.lineWidth).toBe(99);
      expect(target.saveStack).toHaveLength(0);
    }
  });
});
