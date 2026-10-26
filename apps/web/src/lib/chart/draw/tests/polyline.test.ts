import { afterEach, describe, expect, it } from "vitest";
import { createPolyline, DEFAULT_POLYLINE_COLOR, DEFAULT_POLYLINE_WIDTH } from "../polyline";
import { handlesForOwners, resetDrawRegistryForTests } from "../registry";

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("createPolyline", () => {
  it("registers one object with the given points and default styling", () => {
    const points = [{ time: 1, price: 10 }, { time: 2, price: 20 }, { time: 3, price: 15 }];
    createPolyline("zigzag", { points });
    const [record] = handlesForOwners(["zigzag"]);
    expect(record.kind).toBe("polyline");
    expect(record.data).toEqual({ points, color: DEFAULT_POLYLINE_COLOR, width: DEFAULT_POLYLINE_WIDTH, style: "solid" });
  });

  it("setPoints replaces the whole point list", () => {
    const polyline = createPolyline("zigzag", { points: [{ time: 0, price: 0 }] });
    const next = [{ time: 1, price: 1 }, { time: 2, price: 4 }];
    polyline.setPoints(next);
    const [record] = handlesForOwners(["zigzag"]);
    expect(record.data).toMatchObject({ points: next });
  });

  it("setColor/setWidth/setStyle each mutate only their own field", () => {
    const polyline = createPolyline("zigzag", { points: [{ time: 0, price: 0 }] });
    polyline.setColor("#ff00ff");
    polyline.setWidth(4);
    polyline.setStyle("dashed");
    const [record] = handlesForOwners(["zigzag"]);
    expect(record.data).toMatchObject({ color: "#ff00ff", width: 4, style: "dashed" });
  });

  it("delete removes the object from the registry", () => {
    const polyline = createPolyline("zigzag", { points: [{ time: 0, price: 0 }] });
    polyline.delete();
    expect(handlesForOwners(["zigzag"])).toEqual([]);
  });
});
