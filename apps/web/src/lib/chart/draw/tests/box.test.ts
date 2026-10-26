import { afterEach, describe, expect, it } from "vitest";
import { createBox, DEFAULT_BOX_BACKGROUND_COLOR, DEFAULT_BOX_BORDER_COLOR, DEFAULT_BOX_BORDER_WIDTH, DEFAULT_BOX_FONT_SIZE, DEFAULT_BOX_TEXT_ALIGN, DEFAULT_BOX_TEXT_COLOR } from "../box";
import { handlesForOwners, resetDrawRegistryForTests } from "../registry";

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("createBox", () => {
  it("registers one object with the given corners and default styling", () => {
    createBox("volumeProfile", { time1: 1, price1: 100, time2: 5, price2: 90 });
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.kind).toBe("box");
    expect(record.data).toEqual({
      time1: 1, price1: 100, time2: 5, price2: 90,
      borderColor: DEFAULT_BOX_BORDER_COLOR,
      backgroundColor: DEFAULT_BOX_BACKGROUND_COLOR,
      borderWidth: DEFAULT_BOX_BORDER_WIDTH,
      text: "",
      textColor: DEFAULT_BOX_TEXT_COLOR,
      textColorOnDark: "",
      fontSize: DEFAULT_BOX_FONT_SIZE,
      textAlign: DEFAULT_BOX_TEXT_ALIGN,
      textBackground: "",
      cornerRadius: 0,
      tailFade: false,
      fontFamily: "monospace",
      textPadding: 4,
      textAccent: "",
      keepTextClear: false,
      textAfterBox: false,
      textFallbacks: [],
      minHeightPx: 0,
      extendRight: false,
      textOffsetY: 0,
      textVAlign: "middle",
      textOverLines: false,
      textFitsHeight: false,
    });
  });

  it("keeps the ink a box asks for on a dark chart", () => {
    createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1, textColorOnDark: "#f1f5f9" });
    expect(handlesForOwners(["volumeProfile"])[0].data).toMatchObject({ textColorOnDark: "#f1f5f9" });
  });

  it("keeps a box's ask to have its text painted over the lines", () => {
    createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1, textOverLines: true });
    expect(handlesForOwners(["volumeProfile"])[0].data).toMatchObject({ textOverLines: true });
  });

  it("setLeftTop/setRightBottom mutate only the targeted corner", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 10, price2: -10 });
    box.setLeftTop(1, 2);
    box.setRightBottom(20, -20);
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({ time1: 1, price1: 2, time2: 20, price2: -20 });
  });

  it("setBorderColor/setBackgroundColor/setBorderWidth each mutate only their own field", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1 });
    box.setBorderColor("#ff0000");
    box.setBackgroundColor("rgba(255,0,0,0.5)");
    box.setBorderWidth(4);
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({
      borderColor: "#ff0000", backgroundColor: "rgba(255,0,0,0.5)", borderWidth: 4,
      time1: 0, price1: 0, time2: 1, price2: 1,
    });
  });

  it("delete removes the object from the registry", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1 });
    box.delete();
    expect(handlesForOwners(["volumeProfile"])).toEqual([]);
  });

  it("setText/setTextColor each mutate only their own field", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1 });
    box.setText("ABC");
    box.setTextColor("#00ff00");
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({ text: "ABC", textColor: "#00ff00" });
  });
});

describe("createBox text backing", () => {
  it("has no backing unless asked, so every existing box paints as before", () => {
    createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1 });
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({ textBackground: "" });
  });

  it("setTextAccent and setTailFade mutate only their own fields", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1, text: "ABC" });
    box.setTextAccent("#2dd4bf");
    box.setTailFade(true);
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({ text: "ABC", textAccent: "#2dd4bf", tailFade: true, textColor: DEFAULT_BOX_TEXT_COLOR, cornerRadius: 0 });
  });

  it("setTextFallbacks mutates only its own field", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1, text: "ABC" });
    box.setTextFallbacks(["AB", "A"]);
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({ text: "ABC", textFallbacks: ["AB", "A"], textColor: DEFAULT_BOX_TEXT_COLOR });
  });

  it("setMinHeightPx mutates only its own field", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1, text: "ABC", minHeightPx: 4 });
    expect(handlesForOwners(["volumeProfile"])[0].data).toMatchObject({ minHeightPx: 4 });
    box.setMinHeightPx(24);
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({ text: "ABC", minHeightPx: 24, textColor: DEFAULT_BOX_TEXT_COLOR });
  });

  it("setTextOffsetY mutates only its own field", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 10, price2: -10, text: "ABC" });
    box.setTextOffsetY(-7);
    expect(handlesForOwners(["volumeProfile"])[0].data).toMatchObject({ text: "ABC", textOffsetY: -7, extendRight: false });
  });

  it("setExtendRight mutates only its own field", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1, text: "ABC", extendRight: true });
    expect(handlesForOwners(["volumeProfile"])[0].data).toMatchObject({ extendRight: true });
    box.setExtendRight(false);
    expect(handlesForOwners(["volumeProfile"])[0].data).toMatchObject({ text: "ABC", extendRight: false, textColor: DEFAULT_BOX_TEXT_COLOR });
  });

  it("setTextBackground mutates only its own field", () => {
    const box = createBox("volumeProfile", { time1: 0, price1: 0, time2: 1, price2: 1, text: "ABC" });
    box.setTextBackground("#112233");
    const [record] = handlesForOwners(["volumeProfile"]);
    expect(record.data).toMatchObject({ text: "ABC", textBackground: "#112233", textColor: DEFAULT_BOX_TEXT_COLOR });
  });
});
