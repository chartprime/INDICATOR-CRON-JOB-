import { describe, expect, it, vi } from "vitest";
import { RollMarkerPrimitive } from "./rollMarkerPrimitive";

describe("RollMarkerPrimitive", () => {
  it("keeps a private ordered marker set and renders only markers visible on the active time scale", () => {
    const primitive = new RollMarkerPrimitive();
    const requestUpdate = vi.fn();
    primitive.attached({
      chart: {
        timeScale: () => ({
          width: () => 100,
          timeToCoordinate: (time: number) => time === 20 ? 25 : time === 30 ? 125 : null,
        }),
      },
      requestUpdate,
    } as never);

    primitive.setMarkers([
      { time: 30_000, label: "late" },
      { time: 20_000, label: "early" },
    ]);
    primitive.updateAllViews();

    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(primitive.rendered).toEqual([{ x: 25, label: "early" }]);
    expect(() => primitive.setMarkers([{ time: 20_000, label: "one" }, { time: 20_000, label: "two" }]))
      .toThrow("unique safe timestamps");
    primitive.detached();
    expect(primitive.rendered).toEqual([]);
  });
});
