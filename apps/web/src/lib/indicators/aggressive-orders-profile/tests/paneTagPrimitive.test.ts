import { describe, expect, it } from "vitest";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { PANE_TAG_BOTTOM_PX, PANE_TAG_DARK, PANE_TAG_FONT_PX, PANE_TAG_HEIGHT_PX, PANE_TAG_LEFT_PX, PANE_TAG_LIGHT, PANE_TAG_PAD_PX, PaneTagPrimitive } from "../paneTagPrimitive";

function fakeTarget(height: number) {
  const calls: unknown[][] = [];
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, key) => {
      if (key === "measureText") return (text: string) => ({ width: text.length * 5.5 });
      if (typeof key === "string" && key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push([key, ...args]);
      };
    },
    set: (target, key, value) => {
      target[key as string] = value;
      calls.push(["set", key, value]);
      return true;
    },
  });
  const target = {
    useMediaCoordinateSpace: (draw: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => void) => draw({ context: context as unknown as CanvasRenderingContext2D, mediaSize: { width: 900, height } }),
  } as unknown as CanvasRenderingTarget2D;
  return { target, calls };
}

function draw(tag: PaneTagPrimitive, height: number) {
  const { target, calls } = fakeTarget(height);
  const view = tag.paneViews()[0];
  view.renderer()!.draw(target);
  return { calls, zOrder: view.zOrder?.() };
}

describe("PaneTagPrimitive", () => {
  it("draws its name on a small chip at the bottom-left of its pane, above everything else there", () => {
    expect([PANE_TAG_LEFT_PX, PANE_TAG_BOTTOM_PX, PANE_TAG_HEIGHT_PX, PANE_TAG_PAD_PX, PANE_TAG_FONT_PX]).toEqual([8, 4, 16, 6, 10]);
    const tag = new PaneTagPrimitive("Aggressive Orders Profile", false, "Inter");
    expect(tag.paneViews()).toHaveLength(1);
    const { calls, zOrder } = draw(tag, 480);
    expect(zOrder).toBe("top");
    const top = 480 - PANE_TAG_BOTTOM_PX - PANE_TAG_HEIGHT_PX;
    const width = Math.ceil("Aggressive Orders Profile".length * 5.5) + PANE_TAG_PAD_PX * 2;
    expect(calls).toEqual([
      ["save"],
      ["set", "font", `600 ${PANE_TAG_FONT_PX}px Inter`],
      ["set", "fillStyle", PANE_TAG_LIGHT.fill],
      ["fillRect", PANE_TAG_LEFT_PX, top, width, PANE_TAG_HEIGHT_PX],
      ["set", "strokeStyle", PANE_TAG_LIGHT.border],
      ["set", "lineWidth", 1],
      ["strokeRect", PANE_TAG_LEFT_PX + 0.5, top + 0.5, width - 1, PANE_TAG_HEIGHT_PX - 1],
      ["set", "fillStyle", PANE_TAG_LIGHT.text],
      ["set", "textAlign", "left"],
      ["set", "textBaseline", "middle"],
      ["fillText", "Aggressive Orders Profile", PANE_TAG_LEFT_PX + PANE_TAG_PAD_PX, top + PANE_TAG_HEIGHT_PX / 2],
      ["restore"],
    ]);
  });

  it("uses the dark chip on a dark chart and the chart's own font by default", () => {
    const tag = new PaneTagPrimitive("Profile", true);
    expect(tag.colours).toBe(PANE_TAG_DARK);
    expect(tag.fontFamily).toContain("sans-serif");
    const { calls } = draw(tag, 100);
    expect(calls.filter((call) => call[0] === "set" && (call[1] === "fillStyle" || call[1] === "strokeStyle")).map((call) => call[2])).toEqual([PANE_TAG_DARK.fill, PANE_TAG_DARK.border, PANE_TAG_DARK.text]);
    expect(new PaneTagPrimitive("Profile", false).colours).toBe(PANE_TAG_LIGHT);
    expect(PANE_TAG_DARK).not.toEqual(PANE_TAG_LIGHT);
  });

  it("draws nothing in a pane too short to hold the chip, and the chip when it just fits", () => {
    const tag = new PaneTagPrimitive("Profile", false, "Inter");
    expect(draw(tag, PANE_TAG_BOTTOM_PX + PANE_TAG_HEIGHT_PX - 1).calls).toEqual([]);
    expect(draw(tag, PANE_TAG_BOTTOM_PX + PANE_TAG_HEIGHT_PX).calls.find((call) => call[0] === "fillRect")).toEqual(["fillRect", PANE_TAG_LEFT_PX, 0, Math.ceil("Profile".length * 5.5) + PANE_TAG_PAD_PX * 2, PANE_TAG_HEIGHT_PX]);
  });
});
