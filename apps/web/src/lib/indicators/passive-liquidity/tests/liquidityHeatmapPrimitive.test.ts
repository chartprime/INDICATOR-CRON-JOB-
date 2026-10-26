// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../liquiditySettings";

const layoutMock = vi.hoisted(() => ({ freeRight: 0, gaps: [] }));

vi.mock("../liquidityHeatmapLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../liquidityHeatmapLayout")>()),
  computeHeatmapLayout: vi.fn(() => ({ freeRight: layoutMock.freeRight, ladder: [], ladderMax: 0 })),
}));

const { LiquidityHeatmapPrimitive } = await import("../liquidityHeatmapPrimitive");
const { LADDER_EDGE_GAP_PX, LADDER_LABEL_WIDTH_PX, ladderReachPx } = await import("../liquidityLadderRenderer");

function attached() {
  const requestUpdate = vi.fn();
  const primitive = new LiquidityHeatmapPrimitive();
  primitive.attached({
    chart: { timeScale: () => ({ options: () => ({ rightOffset: 0, barSpacing: 6 }), applyOptions: vi.fn(), scrollPosition: () => 0 }) },
    series: {},
    requestUpdate,
  } as never);
  primitive.setGrid({} as never);
  return { primitive, requestUpdate };
}

function viewWith(primitive: InstanceType<typeof LiquidityHeatmapPrimitive>, freeRight: number): void {
  layoutMock.freeRight = freeRight;
  primitive.updateAllViews();
}

describe("LiquidityHeatmapPrimitive's ladder width", () => {
  it("is the width the ladder draws: its reach held to the free space right of the last candle, never under the label strip, plus its gap from the axis", () => {
    const { primitive } = attached();
    viewWith(primitive, 50);
    expect(primitive.ladderWidthPx(1_200)).toBe(LADDER_EDGE_GAP_PX + 50);
    viewWith(primitive, 400);
    expect(primitive.ladderWidthPx(1_200)).toBe(LADDER_EDGE_GAP_PX + 0.12 * 1_200);
    viewWith(primitive, 10);
    expect(primitive.ladderWidthPx(1_200)).toBe(LADDER_EDGE_GAP_PX + LADDER_LABEL_WIDTH_PX);
    primitive.setSettings({ ...DEFAULT_LIQUIDITY_SETTINGS, ladderReach: 0.01 });
    viewWith(primitive, 400);
    expect(ladderReachPx(primitive, 1_200, 1)).toBe(12);
    expect(primitive.ladderWidthPx(1_200)).toBe(LADDER_EDGE_GAP_PX + LADDER_LABEL_WIDTH_PX);
  });

  it("asks for one more update when the free space right of the last candle moves, so what stops at the ladder follows it, and none while it stays", () => {
    const { primitive, requestUpdate } = attached();
    viewWith(primitive, 50);
    requestUpdate.mockClear();
    viewWith(primitive, 50);
    expect(requestUpdate).not.toHaveBeenCalled();
    viewWith(primitive, 80);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });
});
