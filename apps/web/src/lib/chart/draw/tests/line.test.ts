import { afterEach, describe, expect, it } from "vitest";
import { createLine, DEFAULT_LINE_COLOR, DEFAULT_LINE_WIDTH, type LineData } from "../line";
import { get, handlesForOwners, resetDrawRegistryForTests } from "../registry";

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("createLine", () => {
  it("registers one object under the given owner with the given endpoints and default styling", () => {
    createLine("rsi", { time1: 1, price1: 10, time2: 2, price2: 20 });
    const [record] = handlesForOwners(["rsi"]);
    expect(record.kind).toBe("line");
    expect(record.data).toEqual({
      time1: 1, price1: 10, time2: 2, price2: 20,
      color: DEFAULT_LINE_COLOR, width: DEFAULT_LINE_WIDTH, style: "solid", extend: "none",
    });
  });

  it("accepts explicit color/width/style/extend overrides at creation", () => {
    createLine("rsi", {
      time1: 0, price1: 0, time2: 1, price2: 1,
      color: "#ff0000", width: 3, style: "dashed", extend: "both",
    });
    const [record] = handlesForOwners(["rsi"]);
    expect(record.data).toMatchObject({ color: "#ff0000", width: 3, style: "dashed", extend: "both" });
  });

  it("setXY1/setXY2 mutate only the targeted endpoint", () => {
    const line = createLine("rsi", { time1: 0, price1: 0, time2: 10, price2: 10 });
    line.setXY1(5, 6);
    line.setXY2(20, 30);
    const [record] = handlesForOwners(["rsi"]);
    expect(record.data).toMatchObject({ time1: 5, price1: 6, time2: 20, price2: 30 });
  });

  it("setColor, setWidth, setStyle, setExtend each mutate only their own field", () => {
    const line = createLine("rsi", { time1: 0, price1: 0, time2: 1, price2: 1 });
    line.setColor("#00ff00");
    line.setWidth(5);
    line.setStyle("dotted");
    line.setExtend("right");
    const [record] = handlesForOwners(["rsi"]);
    expect(record.data as LineData).toMatchObject({
      color: "#00ff00", width: 5, style: "dotted", extend: "right",
      time1: 0, price1: 0, time2: 1, price2: 1,
    });
  });

  it("delete removes the object from the registry", () => {
    const line = createLine("rsi", { time1: 0, price1: 0, time2: 1, price2: 1 });
    line.delete();
    expect(handlesForOwners(["rsi"])).toEqual([]);
  });

  it("a mutation after delete does not resurrect the object or throw", () => {
    const line = createLine("rsi", { time1: 0, price1: 0, time2: 1, price2: 1 });
    line.delete();
    expect(() => line.setColor("#000000")).not.toThrow();
    expect(handlesForOwners(["rsi"])).toEqual([]);
  });

  it("two lines from the same owner are independent handles", () => {
    const first = createLine("rsi", { time1: 0, price1: 0, time2: 1, price2: 1 });
    const second = createLine("rsi", { time1: 2, price1: 2, time2: 3, price2: 3 });
    first.setColor("#111111");
    const records = handlesForOwners(["rsi"]);
    expect(records).toHaveLength(2);
    expect(records[0].data).toMatchObject({ color: "#111111" });
    expect(records[1].data).toMatchObject({ color: DEFAULT_LINE_COLOR });
    expect(get(records[1].handleId)?.data).toMatchObject({ time1: 2 });
    void second;
  });
});
