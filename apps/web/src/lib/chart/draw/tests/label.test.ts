import { afterEach, describe, expect, it } from "vitest";
import {
  createLabel,
  DEFAULT_LABEL_COLOR,
  DEFAULT_LABEL_SIZE,
  DEFAULT_LABEL_TEXT_COLOR,
} from "../label";
import { handlesForOwners, resetDrawRegistryForTests } from "../registry";

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("createLabel", () => {
  it("registers one object at the given point with empty text and default styling", () => {
    createLabel("whaleDetector", { time: 3, price: 50000 });
    const [record] = handlesForOwners(["whaleDetector"]);
    expect(record.kind).toBe("label");
    expect(record.data).toEqual({
      time: 3,
      price: 50000,
      text: "",
      color: DEFAULT_LABEL_COLOR,
      textColor: DEFAULT_LABEL_TEXT_COLOR,
      size: DEFAULT_LABEL_SIZE,
      textSize: DEFAULT_LABEL_SIZE,
      textAlign: "center",
      offsetX: 0,
      barOffset: 0,
    });
  });

  it("accepts explicit text/color/textColor/size overrides at creation", () => {
    createLabel("whaleDetector", {
      time: 0,
      price: 0,
      text: "BUY",
      color: "#00aa00",
      textColor: "#ffffff",
      size: 20,
    });
    const [record] = handlesForOwners(["whaleDetector"]);
    expect(record.data).toMatchObject({
      text: "BUY",
      color: "#00aa00",
      textColor: "#ffffff",
      size: 20,
    });
  });

  it("setXY, setText, setColor, setTextColor, setSize each mutate only their own field", () => {
    const label = createLabel("whaleDetector", { time: 0, price: 0 });
    label.setXY(5, 6);
    label.setText("SELL");
    label.setColor("#ff0000");
    label.setTextColor("#000000");
    label.setSize(30);
    label.setTextSize(14);
    const [record] = handlesForOwners(["whaleDetector"]);
    expect(record.data).toEqual({
      time: 5,
      price: 6,
      text: "SELL",
      color: "#ff0000",
      textColor: "#000000",
      size: 30,
      textSize: 14,
      textAlign: "center",
      offsetX: 0,
      barOffset: 0,
    });
  });

  it("delete removes the object from the registry", () => {
    const label = createLabel("whaleDetector", { time: 0, price: 0 });
    label.delete();
    expect(handlesForOwners(["whaleDetector"])).toEqual([]);
  });
});
