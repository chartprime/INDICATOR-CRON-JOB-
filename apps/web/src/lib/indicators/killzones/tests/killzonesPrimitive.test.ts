import { describe, expect, it, vi } from "vitest";
import { KillzonesPrimitive } from "../killzonesPrimitive";
import type { KillzoneSessionInput } from "../killzonesPrimitive";

const sessions: readonly KillzoneSessionInput[] = [
  {
    session: {
      id: "nyam",
      label: "NY AM",
      startMin: 570,
      endMin: 660,
      defaultShown: true,
      boxColor: "rgba(1,2,3,0.1)",
      lineColor: "#010203",
    },
    occurrences: [
      {
        sessionId: "nyam",
        startMs: 60_000,
        boxEndMs: 120_000,
        high: 110,
        low: 90,
        highLineEndMs: 180_000,
        lowLineEndMs: 240_000,
        highBroken: false,
        lowBroken: false,
      },
    ],
  },
];

function attach(primitive: KillzonesPrimitive) {
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: { timeScale: () => ({ options: () => ({ barSpacing: 8 }), timeToCoordinate: (time: number) => time * 10 }) },
    series: { priceToCoordinate: (price: number) => price * 2 },
    requestUpdate,
  } as never);
  return requestUpdate;
}

describe("KillzonesPrimitive", () => {
  it("renders session boxes and independent high/low pivot endpoints from the supplied occurrence", () => {
    const primitive = new KillzonesPrimitive();
    const requestUpdate = attach(primitive);

    primitive.setSessions(sessions);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    primitive.updateAllViews();

    expect(primitive.renderBoxes).toEqual([
      expect.objectContaining({ x1: 600, x2: 1208, yTop: 220, yBottom: 180, label: "NY AM" }),
    ]);
    expect(primitive.renderLines).toEqual([
      expect.objectContaining({ x1: 600, x2: 1800, y: 220, label: "NY AM.H", labelAbove: true }),
      expect.objectContaining({ x1: 600, x2: 2400, y: 180, label: "NY AM.L", labelAbove: false }),
    ]);
  });

  it("clears stale render state when sessions are removed or the primitive detaches", () => {
    const primitive = new KillzonesPrimitive();
    attach(primitive);
    primitive.setSessions(sessions);
    primitive.updateAllViews();
    expect(primitive.renderBoxes).toHaveLength(1);

    primitive.setSessions([]);
    primitive.updateAllViews();
    expect(primitive.renderBoxes).toEqual([]);
    expect(primitive.renderLines).toEqual([]);

    primitive.setSessions(sessions);
    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.renderBoxes).toEqual([]);
    expect(primitive.renderLines).toEqual([]);
  });
});
