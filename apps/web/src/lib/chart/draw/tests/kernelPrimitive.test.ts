import { afterEach, describe, expect, it, vi } from "vitest";
import { computeKernelRender, DrawKernelPrimitive } from "../kernelPrimitive";
import { createBox } from "../box";
import { createLabel } from "../label";
import { createLine } from "../line";
import { createPolyline } from "../polyline";
import { resetDrawRegistryForTests, type DrawObjectRecord } from "../registry";
import type { FillPoint } from "../fill";

afterEach(() => {
  resetDrawRegistryForTests();
});

const identity: (value: number) => number | null = (value) => value;
const offscreen: (value: number) => number | null = () => null;

describe("computeKernelRender -- per-kind geometry", () => {
  it("runs a box that extends right to the pane's edge wherever its own right end is, on screen or past it, and leaves one that does not where it is", () => {
    const box = (time2: number, extendRight?: boolean) => ({ handleId: 1, ownerId: "a", kind: "box", data: { time1: 1, price1: 10, time2, price2: 5, borderColor: "#111", backgroundColor: "#222", borderWidth: 1, text: "", textColor: "#fff", fontSize: 10, textAlign: "right", textBackground: "", extendRight } }) as DrawObjectRecord;
    const right = (record: DrawObjectRecord) => computeKernelRender([record], new Map(), new Map(), identity, identity, 100).boxes.map(({ x1, x2 }) => [x1, x2]);
    expect(right(box(40, true))).toEqual([[1, 100]]);
    expect(right(box(250, true))).toEqual([[1, 100]]);
    expect(right(box(40, false))).toEqual([[1, 40]]);
    expect(right(box(40))).toEqual([[1, 40]]);
  });

  it("stops a box that extends right, and a fading tail, at the right edge it is given instead of the pane's, and leaves the others alone", () => {
    const box = (time2: number, extras: { extendRight?: boolean; tailFade?: boolean }) => ({ handleId: 1, ownerId: "a", kind: "box", data: { time1: 1, price1: 10, time2, price2: 5, borderColor: "#111", backgroundColor: "#222", borderWidth: 1, text: "", textColor: "#fff", fontSize: 10, textAlign: "right", textBackground: "", ...extras } }) as DrawObjectRecord;
    const placed = (record: DrawObjectRecord) => computeKernelRender([record], new Map(), new Map(), identity, identity, 100, 70).boxes.map(({ x1, x2, tailToX }) => [x1, x2, tailToX]);
    expect(placed(box(40, { extendRight: true }))[0].slice(0, 2)).toEqual([1, 70]);
    expect(placed(box(40, { tailFade: true }))).toEqual([[1, 40, 70]]);
    expect(placed(box(40, {}))).toEqual([[1, 40, 40]]);
    expect(placed(box(90, {}))).toEqual([[1, 90, 90]]);
    expect(computeKernelRender([box(40, { extendRight: true })], new Map(), new Map(), identity, identity, 100).boxes[0].x2).toBe(100);
  });

  it("grows a box shorter than its minimum height evenly about its middle, and leaves a taller one and one with no minimum as they are", () => {
    const box = (price1: number, price2: number, minHeightPx?: number) => ({ handleId: 1, ownerId: "a", kind: "box", data: { time1: 1, price1, time2: 5, price2, borderColor: "#111", backgroundColor: "#222", borderWidth: 1, text: "", textColor: "#fff", fontSize: 10, textAlign: "left", textBackground: "", minHeightPx } }) as DrawObjectRecord;
    const heights = (record: DrawObjectRecord) => computeKernelRender([record], new Map(), new Map(), identity, identity, 100).boxes.map(({ y1, y2 }) => [y1, y2]);
    expect(heights(box(52, 50, 20))).toEqual([[41, 61]]);
    expect(heights(box(50, 52, 20))).toEqual([[41, 61]]);
    expect(heights(box(80, 50, 20))).toEqual([[50, 80]]);
    expect(heights(box(52, 50))).toEqual([[50, 52]]);
    expect(heights(box(52, 50, 0))).toEqual([[50, 52]]);
  });

  it("converts a line's domain endpoints to pixel coordinates, unextended by default", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "line",
        data: {
          time1: 1,
          price1: 10,
          time2: 2,
          price2: 20,
          color: "#fff",
          width: 2,
          style: "solid",
          extend: "none",
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      (t) => t * 10,
      (p) => p,
      1000,
    );
    expect(result.lines).toEqual([
      {
        x1: 10,
        y1: 10,
        x2: 20,
        y2: 20,
        color: "#fff",
        width: 2,
        style: "solid",
      },
    ]);
  });

  it("extends a line rightward to the pane's edge along its own slope", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "line",
        data: {
          time1: 0,
          price1: 0,
          time2: 10,
          price2: 10,
          color: "#fff",
          width: 1,
          style: "solid",
          extend: "right",
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      (t) => t,
      (p) => p,
      100,
    );
    expect(result.lines[0]).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 100 });
  });

  it("extends a line in both directions to both pane edges", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "line",
        data: {
          time1: 20,
          price1: 20,
          time2: 30,
          price2: 30,
          color: "#fff",
          width: 1,
          style: "solid",
          extend: "both",
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      (t) => t,
      (p) => p,
      100,
    );
    expect(result.lines[0]).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 100 });
  });

  it("does not extend a vertical line (dx=0) -- left unchanged rather than producing NaN", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "line",
        data: {
          time1: 5,
          price1: 0,
          time2: 5,
          price2: 10,
          color: "#fff",
          width: 1,
          style: "solid",
          extend: "both",
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      (t) => t,
      (p) => p,
      100,
    );
    expect(result.lines[0]).toMatchObject({ x1: 5, y1: 0, x2: 5, y2: 10 });
  });

  it("drops a line whose endpoint falls off the visible range (a coordinate function returning null)", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "line",
        data: {
          time1: 0,
          price1: 0,
          time2: 1,
          price2: 1,
          color: "#fff",
          width: 1,
          style: "solid",
          extend: "none",
        },
      },
    ] as DrawObjectRecord[];
    expect(
      computeKernelRender(
        objects,
        new Map(),
        new Map(),
        offscreen,
        identity,
        100,
      ).lines,
    ).toEqual([]);
  });

  it("normalizes a box's corners so x1<=x2 and y1<=y2 regardless of which corner was given first", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "box",
        data: {
          time1: 10,
          price1: 5,
          time2: 2,
          price2: 20,
          borderColor: "#111",
          backgroundColor: "#222",
          borderWidth: 1,
          text: "",
          textColor: "#787b86",
          fontSize: 10,
          textAlign: "left",
          textBackground: "",
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      identity,
      identity,
      100,
    );
    expect(result.boxes).toEqual([
      {
        x1: 2,
        y1: 5,
        x2: 10,
        y2: 20,
        borderColor: "#111",
        backgroundColor: "#222",
        borderWidth: 1,
        text: "",
        textColor: "#787b86",
        fontSize: 10,
        textAlign: "left",
        textBackground: "",
        cornerRadius: 0,
        tailToX: 10,
        fontFamily: "monospace",
        textPadding: 4,
        textAccent: "",
        textAfterBox: false,
        keepTextClear: false,
        textFallbacks: [],
        textOffsetY: 0,
        textVAlign: "middle",
        textOverLines: false,
        textFitsHeight: false,
      },
    ]);
  });

  it("converts a label's point to pixel coordinates", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "label",
        data: {
          time: 3,
          price: 30,
          text: "hi",
          color: "#111",
          textColor: "#fff",
          size: 12,
          textAlign: "center",
          offsetX: 0,
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      identity,
      identity,
      100,
    );
    expect(result.labels).toEqual([
      {
        x: 3,
        y: 30,
        text: "hi",
        color: "#111",
        textColor: "#fff",
        size: 12,
        textAlign: "center",
        offsetX: 0,
      },
    ]);
  });

  it("carries a label one or more bars into the future by the time scale's own bar width", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "label",
        data: {
          time: 5,
          price: 25,
          text: "+1",
          color: "#222",
          textColor: "#eee",
          size: 0,
          textAlign: "left",
          offsetX: 0,
          barOffset: 2,
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      identity,
      identity,
      100,
      100,
      false,
      7,
    );
    // 5 (the time's own coordinate) + 2 bars × 7px -- a bar that has not
    // happened yet has no coordinate, so the width is what carries it there.
    expect(result.labels[0].x).toBe(19);
  });

  it("leaves a label with no bar offset exactly on its time's coordinate", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "label",
        data: {
          time: 5,
          price: 25,
          text: "TEST",
          color: "#222",
          textColor: "#eee",
          size: 14,
          textAlign: "left",
          offsetX: 8,
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      identity,
      identity,
      100,
    );
    expect(result.labels).toEqual([
      {
        x: 5,
        y: 25,
        text: "TEST",
        color: "#222",
        textColor: "#eee",
        size: 14,
        textAlign: "left",
        offsetX: 8,
      },
    ]);
  });

  it("converts a polyline's points, dropping only the points that fall off the visible range", () => {
    const offscreenAtTwo = (value: number) => (value === 2 ? null : value);
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "polyline",
        data: {
          points: [
            { time: 1, price: 1 },
            { time: 2, price: 2 },
            { time: 3, price: 3 },
          ],
          color: "#fff",
          width: 1,
          style: "solid",
        },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      offscreenAtTwo,
      identity,
      100,
    );
    expect(result.polylines[0].points).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 3 },
    ]);
  });

  it("drops a polyline that has fewer than two remaining visible points", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "polyline",
        data: {
          points: [{ time: 1, price: 1 }],
          color: "#fff",
          width: 1,
          style: "solid",
        },
      },
    ] as DrawObjectRecord[];
    expect(
      computeKernelRender(
        objects,
        new Map(),
        new Map(),
        identity,
        identity,
        100,
      ).polylines,
    ).toEqual([]);
  });

  it("ignores a table object entirely -- it renders through the DOM overlay, not this canvas kernel", () => {
    const objects = [
      {
        handleId: 1,
        ownerId: "a",
        kind: "table",
        data: { pendingGrid: {}, committedGrid: {} },
      },
    ] as DrawObjectRecord[];
    const result = computeKernelRender(
      objects,
      new Map(),
      new Map(),
      identity,
      identity,
      100,
    );
    expect(result).toEqual({
      fillSegments: [],
      boxes: [],
      lines: [],
      polylines: [],
      labels: [],
    });
  });

  it("includes fill segments computed from the given per-owner fill points and options", () => {
    const fillPointsByOwner = new Map<string, readonly (FillPoint | null)[]>([
      [
        "a",
        [
          { time: 0, valueA: 2, valueB: 1 },
          { time: 1, valueA: 2, valueB: 1 },
        ],
      ],
    ]);
    const result = computeKernelRender(
      [],
      fillPointsByOwner,
      new Map(),
      identity,
      identity,
      100,
    );
    expect(result.fillSegments).toHaveLength(1);
  });

  it("returns the shared empty-pieces result when there are no objects and no fill points", () => {
    expect(
      computeKernelRender([], new Map(), new Map(), identity, identity, 100),
    ).toEqual({
      fillSegments: [],
      boxes: [],
      lines: [],
      polylines: [],
      labels: [],
    });
  });
});

function fakeCanvasTarget() {
  const saveStack: Array<Record<string, unknown>> = [];
  const STYLE_KEYS = ["fillStyle", "strokeStyle", "lineWidth"] as const;
  const context = {
    save: () => {
      saveStack.push(
        Object.fromEntries(
          STYLE_KEYS.map((key) => [
            key,
            (context as Record<string, unknown>)[key],
          ]),
        ),
      );
    },
    restore: () => {
      const top = saveStack.pop();
      if (top)
        for (const key of STYLE_KEYS)
          (context as Record<string, unknown>)[key] = top[key];
    },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    fillRect: (_x: number, _y: number, _w: number, _h: number) => {},
    strokeRect: () => {},
    setLineDash: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    fillText: (_text: string, _x: number, _y: number) => {},
    measureText: (text: string) => ({ width: text.length * 6 }),
    roundRect: (_x: number, _y: number, _w: number, _h: number, _r: number | number[]) => {},
    createLinearGradient: (_x0: number, _y0: number, _x1: number, _y1: number) => ({ addColorStop: (_at: number, _color: string) => {} }),
  };
  return {
    context,
    saveStack,
    useMediaCoordinateSpace: (
      callback: (scope: { context: typeof context }) => void,
    ) => callback({ context }),
  };
}

function attach(primitive: DrawKernelPrimitive, widthPx = 800) {
  const requestUpdate = vi.fn();
  primitive.attached({
    chart: {
      timeScale: () => ({
        timeToCoordinate: (time: number) => Number(time) * 1000,
        width: () => widthPx,
        getVisibleRange: () => null,
        getVisibleLogicalRange: () => null,
        options: () => ({ barSpacing: 6 }),
      }),
    },
    series: { priceToCoordinate: (price: number) => price },
    requestUpdate,
  } as never);
  return requestUpdate;
}

describe("DrawKernelPrimitive -- L1L2-V2-087, the shared canvas context must be restored", () => {
  it("leaves the shared canvas context exactly as it found it, on every pane view", () => {
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    createLine("a", { time1: 0, price1: 0, time2: 1000, price2: 1000 });
    createBox("a", { time1: 0, price1: 0, time2: 1000, price2: 1000 });
    createLabel("a", { time: 0, price: 0, text: "x" });
    createPolyline("a", {
      points: [
        { time: 0, price: 0 },
        { time: 1000, price: 1000 },
      ],
    });
    primitive.setOwnerIds(["a"]);
    primitive.setFillPoints("a", [
      { time: 0, valueA: 1, valueB: 0 },
      { time: 1, valueA: 1, valueB: 0 },
    ]);
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

describe("DrawKernelPrimitive -- multi-owner pane isolation", () => {
  it("setOwnerIds restricts rendering to only the given owners' registered objects", () => {
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    createLine("a", { time1: 0, price1: 0, time2: 1, price2: 1 });
    createLine("b", { time1: 2, price1: 2, time2: 3, price2: 3 });

    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(1);

    primitive.setOwnerIds(["a", "b"]);
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(2);
  });

  it("removing an owner from setOwnerIds also drops its previously-set fill points", () => {
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    primitive.setOwnerIds(["a"]);
    primitive.setFillPoints("a", [
      { time: 0, valueA: 1, valueB: 0 },
      { time: 1, valueA: 1, valueB: 0 },
    ]);
    primitive.updateAllViews();
    expect(primitive.renderFillSegments.length).toBeGreaterThan(0);

    primitive.setOwnerIds([]);
    primitive.updateAllViews();
    expect(primitive.renderFillSegments).toEqual([]);
  });

  it("clears an owner's previous fill styling when that owner no longer supplies options", () => {
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    primitive.setOwnerIds(["a"]);
    const points = [
      { time: 0, valueA: 1, valueB: 0 },
      { time: 1, valueA: 1, valueB: 0 },
    ];
    primitive.setFillPoints("a", points, { colorAbove: "#ff0000" });
    primitive.setFillPoints("a", points);
    primitive.updateAllViews();
    expect(primitive.renderFillSegments[0]?.color).not.toBe("#ff0000");
  });
});

describe("DrawKernelPrimitive -- one chart lookup per distinct time and price in a repaint (report 57 W4)", () => {
  it("places a hundred boxes that share two times and two prices with two lookups each, exactly where it placed them before", () => {
    const { primitive, lookups } = countingKernel();
    for (let index = 0; index < 100; index += 1) createBox("a", { time1: 1000, price1: 5, time2: 2000, price2: 9 });
    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    expect(lookups).toEqual({ time: 2, price: 2 + PRICE_SCALE_PROBES });
    expect(primitive.renderBoxes).toHaveLength(100);
    expect(primitive.renderBoxes.every((box) => box.x1 === 1000 && box.x2 === 2000 && box.y1 === 5 && box.y2 === 9)).toBe(true);
  });
});

const PRICE_SCALE_PROBES = 2;

function countingKernel() {
  const primitive = new DrawKernelPrimitive();
  const lookups = { time: 0, price: 0 };
  const view = { from: 0, to: 100, barTimes: 1 };
  primitive.attached({
    chart: {
      timeScale: () => ({
        timeToCoordinate: (time: number) => { lookups.time += 1; return Number(time) * 1000; },
        width: () => 800,
        getVisibleRange: () => null,
        getVisibleLogicalRange: () => ({ from: view.from, to: view.to }),
        options: () => ({ barSpacing: 6 }),
      }),
    },
    series: { priceToCoordinate: (price: number) => { lookups.price += 1; return price; } },
    requestUpdate: vi.fn(),
  } as never);
  primitive.setBarTimesRevision(() => view.barTimes);
  return { primitive, lookups, view };
}

describe("DrawKernelPrimitive -- the room kept beside the axis", () => {
  it("stops boxes that extend right where the indicators drawn against the axis begin, follows that room as it changes, and keeps it inside the pane", () => {
    const primitive = new DrawKernelPrimitive();
    const requestUpdate = attach(primitive, 800);
    createBox("a", { time1: 0, price1: 5, time2: 0.1, price2: 9, extendRight: true });
    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    expect(primitive.renderBoxes[0].x2).toBe(800);
    let room = 120;
    requestUpdate.mockClear();
    primitive.setRightInset((paneWidthPx) => (paneWidthPx === 800 ? room : 0));
    expect(requestUpdate).toHaveBeenCalled();
    primitive.updateAllViews();
    expect(primitive.renderBoxes[0].x2).toBe(680);
    room = 200;
    primitive.updateAllViews();
    expect(primitive.renderBoxes[0].x2).toBe(600);
    room = 5_000;
    primitive.updateAllViews();
    expect(primitive.renderBoxes[0].x2).toBe(0);
    room = -40;
    primitive.updateAllViews();
    expect(primitive.renderBoxes[0].x2).toBe(800);
    const placed = primitive.renderBoxes;
    room = -10;
    primitive.updateAllViews();
    expect(primitive.renderBoxes).toBe(placed);
  });
});

describe("DrawKernelPrimitive -- a repaint that changes nothing reuses the placed objects (report 57 W4)", () => {
  it("places nothing again until an object, the view or the candles change", () => {
    const { primitive, lookups, view } = countingKernel();
    const box = createBox("a", { time1: 1000, price1: 5, time2: 2000, price2: 9 });
    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    const placed = primitive.renderBoxes;
    const objectLookups = () => lookups.time;

    primitive.updateAllViews();
    expect(primitive.renderBoxes).toBe(placed);
    expect(objectLookups()).toBe(2);

    box.setRightBottom(3000, 9);
    primitive.updateAllViews();
    expect(primitive.renderBoxes[0].x2).toBe(3000);
    expect(objectLookups()).toBe(4);

    view.from = 10;
    primitive.updateAllViews();
    expect(objectLookups()).toBe(6);

    view.barTimes = 2;
    primitive.updateAllViews();
    expect(objectLookups()).toBe(8);
  });
});

describe("DrawKernelPrimitive -- detached/no chart", () => {
  it("clears every render array when there is no attached chart/series", () => {
    const primitive = new DrawKernelPrimitive();
    primitive.updateAllViews();
    expect(primitive.renderLines).toEqual([]);
    expect(primitive.renderBoxes).toEqual([]);
    expect(primitive.renderLabels).toEqual([]);
    expect(primitive.renderPolylines).toEqual([]);
    expect(primitive.renderFillSegments).toEqual([]);
  });

  it("detached() clears the chart/series reference so a later updateAllViews falls back to empty", () => {
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    createLine("a", { time1: 0, price1: 0, time2: 1, price2: 1 });
    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    expect(primitive.renderLines).toHaveLength(1);

    primitive.detached();
    primitive.updateAllViews();
    expect(primitive.renderLines).toEqual([]);
  });
});

describe("DrawKernelPrimitive -- requestUpdate is forwarded", () => {
  it("setOwnerIds and setFillPoints each call the attached requestUpdate", () => {
    const primitive = new DrawKernelPrimitive();
    const requestUpdate = attach(primitive);
    primitive.setOwnerIds(["a"]);
    primitive.setFillPoints("a", []);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
  });

  it("a direct handle mutation made between bar-transitions repaints immediately, without a fresh setOwnerIds/setFillPoints call", () => {
    const primitive = new DrawKernelPrimitive();
    const requestUpdate = attach(primitive);
    const line = createLine("a", { time1: 0, price1: 0, time2: 1, price2: 1 });
    primitive.setOwnerIds(["a"]);
    requestUpdate.mockClear();

    line.setColor("#ff0000");

    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("a mutation on an owner no longer assigned to this instance does not trigger this instance's requestUpdate", () => {
    const primitive = new DrawKernelPrimitive();
    const requestUpdate = attach(primitive);
    const line = createLine("a", { time1: 0, price1: 0, time2: 1, price2: 1 });
    primitive.setOwnerIds(["a"]);
    primitive.setOwnerIds([]); // "a" reassigned away (e.g. hidden, or moved to another pane)
    requestUpdate.mockClear();

    line.setColor("#00ff00");

    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("detached() unregisters this instance's requestUpdate for every owner it held", () => {
    const primitive = new DrawKernelPrimitive();
    const requestUpdate = attach(primitive);
    const line = createLine("a", { time1: 0, price1: 0, time2: 1, price2: 1 });
    primitive.setOwnerIds(["a"]);
    primitive.detached();
    requestUpdate.mockClear();

    expect(() => line.setColor("#0000ff")).not.toThrow();
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});

describe("DrawKernelPrimitive -- box text: lines and backing", () => {
  function paintBox(options: Parameters<typeof createBox>[1]) {
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    createBox("a", options);
    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    const target = fakeCanvasTarget();
    const texts: { text: string; x: number; y: number; fill: string }[] = [];
    const rects: { x: number; y: number; w: number; h: number; fill: string }[] = [];
    const rounded: { x: number; y: number; w: number; h: number; r: number | number[]; fill: string }[] = [];
    const gradients: { x0: number; x1: number; stops: [number, string][] }[] = [];
    let pending: (typeof rounded)[number] | null = null;
    target.context.fillText = (text: string, x: number, y: number) => {
      texts.push({ text, x, y, fill: String(target.context.fillStyle) });
    };
    target.context.fillRect = (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h, fill: String(target.context.fillStyle) });
    };
    target.context.roundRect = (x: number, y: number, w: number, h: number, r: number | number[]) => {
      pending = { x, y, w, h, r, fill: "" };
    };
    // A rounded shape's colour is whatever fillStyle is when fill() runs, which is after the path is laid.
    target.context.fill = () => {
      if (pending !== null) rounded.push({ ...pending, fill: String(target.context.fillStyle) });
      pending = null;
    };
    target.context.createLinearGradient = (x0: number, _y0: number, x1: number) => {
      const gradient = { x0, x1, stops: [] as [number, string][] };
      gradients.push(gradient);
      return { addColorStop: (at: number, color: string) => { gradient.stops.push([at, color]); } };
    };
    for (const view of primitive.paneViews()) view.renderer()?.draw?.(target as never);
    return { texts, rects, rounded, gradients, font: String(target.context.font) };
  }

  /** Several boxes painted in one pass, in the order given: the last one paints on top. */
  function paintBoxes(all: Parameters<typeof createBox>[1][]) {
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    for (const options of all) createBox("a", options);
    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    const target = fakeCanvasTarget();
    const texts: { text: string; x: number; y: number }[] = [];
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    const gradients: { x0: number; x1: number; stops: [number, string][] }[] = [];
    target.context.fillText = (text: string, x: number, y: number) => { texts.push({ text, x, y }); };
    target.context.fillRect = (x: number, y: number, w: number, h: number) => { rects.push({ x, y, w, h }); };
    target.context.createLinearGradient = (x0: number, _y0: number, x1: number) => {
      const gradient = { x0, x1, stops: [] as [number, string][] };
      gradients.push(gradient);
      return { addColorStop: (at: number, color: string) => { gradient.stops.push([at, color]); } };
    };
    for (const view of primitive.paneViews()) view.renderer()?.draw?.(target as never);
    return { texts, rects, gradients };
  }

  // A card past the box begins a gap after its right edge and runs right into the margin. The box is 0..500 over rows 0..100,
  // so its card's backing starts at 506; "ab" is 12 px of text, padded 4 a side, so the backing is 506..526 and the text sits at 510.
  const CARD = { time1: 0, price1: 0, time2: 500, price2: 100, text: "ab", textAlign: "left" as const, fontSize: 10, textBackground: "#000", textAfterBox: true };

  it("lifts or drops the text by textOffsetY from the box's middle, the backing with it", () => {
    // The box runs over rows 0..100, so its text sits at 50; lifted seven it sits at 43 and its backing top moves the same seven up.
    const flat = paintBox({ ...CARD, textAfterBox: false });
    expect(flat.texts.map((t) => t.y)).toEqual([50]);
    resetDrawRegistryForTests();
    const lifted = paintBox({ ...CARD, textAfterBox: false, textOffsetY: -7 });
    expect(lifted.texts.map((t) => t.y)).toEqual([43]);
    expect(lifted.rects[1].y).toBe(flat.rects[1].y - 7);
    resetDrawRegistryForTests();
    expect(paintBox({ ...CARD, textAfterBox: false, textOffsetY: 7 }).texts.map((t) => t.y)).toEqual([57]);
  });

  it("moves a card-less label that would land on another kept-clear label, so two boxes sharing a bottom edge never print over each other", () => {
    // Both boxes end on row 100 and right-align their text there; the second label must leave the first one's line.
    const both = paintBoxes([
      { ...CARD, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom", keepTextClear: true, text: "first" },
      { ...CARD, price1: 60, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom", keepTextClear: true, text: "second" },
    ]);
    const ys = both.texts.map((t) => t.y);
    expect(ys).toHaveLength(2);
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(13);
    resetDrawRegistryForTests();
    const loose = paintBoxes([
      { ...CARD, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom", text: "first" },
      { ...CARD, price1: 60, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom", text: "second" },
    ]);
    expect(loose.texts.map((t) => t.y)).toEqual([89.5, 89.5]);
  });

  it("hides a label that would have to leave its own box to clear another, when the text must fit the box's height, instead of floating it outside", () => {
    // Two 20-row boxes share their bottom edge; the second label has no free line inside its box, so it is dropped, not moved above it.
    const thin = paintBoxes([
      { ...CARD, price1: 80, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom", keepTextClear: true, textFitsHeight: true, text: "first" },
      { ...CARD, price1: 80, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom", keepTextClear: true, textFitsHeight: true, text: "second" },
    ]);
    expect(thin.texts.map((t) => t.text)).toEqual(["second"]);
    expect(thin.texts.every((t) => t.y >= 80 && t.y <= 100)).toBe(true);
  });

  it("anchors the text to the box's bottom edge when textVAlign is bottom, one padding up, so it sits in the lower corner", () => {
    // The box runs over rows 0..100; a 10 px font has a 13 px line, so the bottom-anchored line's middle sits at 100 - 4 - 6.5 = 89.5.
    const bottom = paintBox({ ...CARD, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom" });
    expect(bottom.texts.map((t) => t.y)).toEqual([89.5]);
    resetDrawRegistryForTests();
    const lifted = paintBox({ ...CARD, textAfterBox: false, textBackground: "", textAlign: "right", textVAlign: "bottom", textOffsetY: -5 });
    expect(lifted.texts.map((t) => t.y)).toEqual([84.5]);
    resetDrawRegistryForTests();
    expect(paintBox({ ...CARD, textAfterBox: false, textBackground: "", textAlign: "right" }).texts.map((t) => t.y)).toEqual([50]);
  });

  it("puts the card past the box's right edge, running right, so the band stays uncovered", () => {
    const { texts, rects } = paintBoxes([CARD]);
    expect(texts.map((t) => t.x)).toEqual([510]);
    expect(rects.map((r) => [r.x, r.w])).toEqual([[0, 500], [506, 20]]);
  });

  it("paints every card where it is, the box painted last on top, so cards on near bands stack with the last in front", () => {
    // Two boxes on the same rows: both cards at 506, both centred on the rows at 39.5, painted in the boxes' order.
    const { texts, rects } = paintBoxes([CARD, CARD]);
    expect(rects.map((r) => [r.x, r.y])).toEqual([[0, 0], [506, 39.5], [0, 0], [506, 39.5]]);
    expect(texts.map((t) => [t.x, t.y])).toEqual([[510, 50], [510, 50]]);
  });

  function paintOrder(textOverLines: boolean | undefined): string[] {
    resetDrawRegistryForTests();
    const primitive = new DrawKernelPrimitive();
    attach(primitive);
    createBox("a", { ...CARD, textAfterBox: false, ...(textOverLines === undefined ? {} : { textOverLines }) });
    createLine("a", { time1: 0, price1: 50, time2: 500, price2: 50, color: "#123456" });
    createPolyline("a", { points: [{ time: 0, price: 10 }, { time: 500, price: 10 }], color: "#654321" });
    createLabel("a", { time: 250, price: 50, text: "dot", color: "#abcdef" });
    primitive.setOwnerIds(["a"]);
    primitive.updateAllViews();
    const target = fakeCanvasTarget();
    const order: string[] = [];
    // fillRect paints the box's shape and, then, the card's backing (the card has no corner radius here).
    target.context.fillRect = () => { order.push(order.length === 0 ? "shape" : "backing"); };
    target.context.stroke = () => { order.push("line"); };
    target.context.fillText = (text: string) => { order.push(text === "ab" ? "card" : "label"); };
    for (const view of primitive.paneViews()) view.renderer()?.draw?.(target as never);
    return order;
  }

  it("paints a box that asks for its text over the lines after the lines and polylines and before the labels, so its card stands in front of a line through it", () => {
    expect(paintOrder(true)).toEqual(["shape", "line", "line", "backing", "card", "label"]);
  });

  it("paints every other box's card with its box, before the lines, as it always has", () => {
    expect(paintOrder(undefined)).toEqual(["shape", "backing", "card", "line", "line", "label"]);
    expect(paintOrder(false)).toEqual(["shape", "backing", "card", "line", "line", "label"]);
  });

  it("measures a card past the box against the margin it has, not the box's own width", () => {
    // A box 20 px wide with 300 px of margin: its full text does not fit the box but fits the margin.
    const narrow = { ...CARD, time1: 480, text: "abcdefgh", textFallbacks: ["ab"] };
    expect(paintBoxes([narrow]).texts.map((t) => t.text)).toEqual(["abcdefgh"]);
  });

  it("reserves the gap before fitting a card against the pane edge", () => {
    const nearEdge = { ...CARD, time2: 780, text: "ab", textFallbacks: ["a"] };
    expect(paintBoxes([nearEdge]).texts.map((t) => t.text)).toEqual(["a"]);
  });


  // Text is 6 px a character in the fake and the backing pads 4 a side: "abcdefgh" needs 56 px of card, "abcd" 32, "ab" 20.
  const FITTED = { time1: 0, price1: 0, price2: 100, text: "abcdefgh\nabcdefgh", textAlign: "right" as const, fontSize: 10, textBackground: "#000", textFallbacks: ["abcd", "ab"] };

  it("takes the text itself when the box is wide enough for its card", () => {
    const { texts } = paintBox({ ...FITTED, time2: 56 });
    expect(texts.map((t) => t.text)).toEqual(["abcdefgh", "abcdefgh"]);
  });

  it("falls back to the first shorter text that fits", () => {
    expect(paintBox({ ...FITTED, time2: 55 }).texts.map((t) => t.text)).toEqual(["abcd"]);
  });

  it("tries the fallbacks in the order given, so the second is taken only once the first is too wide", () => {
    expect(paintBox({ ...FITTED, time2: 31 }).texts.map((t) => t.text)).toEqual(["ab"]);
  });

  it("leaves the box unlabelled, backing and all, when nothing fits", () => {
    const { texts, rects } = paintBox({ ...FITTED, time2: 19 });
    expect(texts).toEqual([]);
    expect(rects).toHaveLength(1);
  });

  it("paints a box with no fallbacks whatever its width, as it always did", () => {
    const { texts } = paintBox({ ...FITTED, time2: 5, textFallbacks: [] });
    expect(texts.map((t) => t.text)).toEqual(["abcdefgh", "abcdefgh"]);
  });

  it("drops a form taller than the box when its words sit inside the box, so a thin zone takes a shorter form, and none under one line", () => {
    // A line is 13 px at 10 px type: the two-line text needs 26 px of height, "abcd" 13.
    const shown = (price2: number) => {
      resetDrawRegistryForTests();
      return paintBox({ ...FITTED, time2: 56, price2, textFitsHeight: true }).texts.map((t) => t.text);
    };
    expect(shown(25)).toEqual(["abcd"]);
    expect(shown(13)).toEqual(["abcd"]);
    expect(shown(12)).toEqual([]);
  });

  it("keeps the words of a box that did not ask to fit its height, however thin, as every indicator but Order Blocks v1 relies on", () => {
    expect(paintBox({ ...FITTED, time2: 56, price2: 5 }).texts.map((t) => t.text)).toEqual(["abcdefgh", "abcdefgh"]);
    resetDrawRegistryForTests();
    const chip = { time1: 0, price1: 50, time2: 500, price2: 50, text: "ORB5.H · Absorbed", textAlign: "left" as const, fontSize: 11, textBackground: "#fff", textOffsetY: -15, textOverLines: true };
    expect(paintBox(chip).texts.map((t) => t.text)).toEqual(["ORB5.H · Absorbed"]);
  });

  it("does not hold a card past the box to the box's height", () => {
    expect(paintBoxes([{ ...CARD, price2: 5, textFallbacks: ["a"] }]).texts.map((t) => t.text)).toEqual(["ab"]);
  });

  it("writes a box's words in its dark-chart ink once told the chart is dark, and in its own ink otherwise", () => {
    const inkOn = (dark: boolean | null, options: Parameters<typeof createBox>[1]) => {
      resetDrawRegistryForTests();
      const primitive = new DrawKernelPrimitive();
      attach(primitive);
      createBox("a", options);
      primitive.setOwnerIds(["a"]);
      primitive.updateAllViews();
      if (dark !== null) {
        primitive.setDarkChart(dark);
        primitive.updateAllViews();
      }
      const target = fakeCanvasTarget();
      const inks: string[] = [];
      target.context.fillText = () => { inks.push(String(target.context.fillStyle)); };
      for (const view of primitive.paneViews()) view.renderer()?.draw?.(target as never);
      return inks;
    };
    const plain = { time1: 0, price1: 0, time2: 500, price2: 100, text: "ab", textColor: "#1e293b" };
    const both = { ...plain, textColorOnDark: "#f1f5f9" };
    expect(inkOn(true, both)).toEqual(["#f1f5f9"]);
    expect(inkOn(false, both)).toEqual(["#1e293b"]);
    expect(inkOn(null, both)).toEqual(["#1e293b"]);
    expect(inkOn(true, plain)).toEqual(["#1e293b"]);
    const primitive = new DrawKernelPrimitive();
    const requestUpdate = attach(primitive);
    primitive.setDarkChart(true);
    expect(requestUpdate).toHaveBeenCalledTimes(1);
  });

  it("judges the fit on the card, not the bare text: the backing's pad and accent count", () => {
    // "ab" is 12 px of text; with an accent bar the card is 12 + 8 + 3 = 23, so a 22 px box drops it.
    const { texts } = paintBox({ ...FITTED, time2: 22, text: "ab", textFallbacks: ["a"], textAccent: "#2dd4bf" });
    expect(texts.map((t) => t.text)).toEqual(["a"]);
  });

  it("runs no tail from a box whose words were dropped, since there is no card to reach", () => {
    const { gradients } = paintBox({ ...FITTED, time2: 19, backgroundColor: "#123", tailFade: true });
    expect(gradients).toEqual([]);
  });

  it("paints a rounded box as one path instead of the two rectangle calls, and its backing rounded to match", () => {
    const { rects, rounded } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, text: "ab", textAlign: "right", fontSize: 10, textBackground: "#000", cornerRadius: 6, backgroundColor: "#123" });
    expect(rects).toEqual([]);
    expect(rounded.map((r) => [r.x, r.y, r.w, r.h, r.r, r.fill])).toEqual([
      [0, 0, 500, 100, 6, "#123"],
      [500 - 4 - 12 - 4, 50 - 6.5 - 4, 20, 21, 6, "#000"],
    ]);
  });

  it("runs a fading tail from the box's right edge to the pane's when asked", () => {
    const { gradients, rects } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, backgroundColor: "#123", tailFade: true });
    expect(gradients).toEqual([{ x0: 500, x1: 800, stops: [[0, "#123"], [1, "rgba(17, 34, 51, 0)"]] }]);
    expect(rects[1]).toMatchObject({ x: 500, y: 0, w: 300, h: 100 });
  });

  it("ends the fade in the band's own hue at no alpha, so a light chart is not greyed on the way to nothing", () => {
    const { gradients } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, backgroundColor: "rgba(45, 212, 191, 0.55)", tailFade: true });
    expect(gradients[0].stops[1]).toEqual([1, "rgba(45, 212, 191, 0)"]);
  });

  it("falls back to transparent for a colour it cannot read", () => {
    const { gradients } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, backgroundColor: "red", tailFade: true });
    expect(gradients[0].stops[1]).toEqual([1, "transparent"]);
  });

  it("paints nothing past a box's right edge when no tail was asked for", () => {
    const { gradients, rects } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, backgroundColor: "#123" });
    expect(gradients).toEqual([]);
    expect(rects).toHaveLength(1);
  });

  it("sets the text in the family the box asks for, monospace when it does not", () => {
    expect(paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, text: "a", fontSize: 12, fontFamily: "Inter, sans-serif" }).font).toBe("12px Inter, sans-serif");
    expect(paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, text: "a", fontSize: 12 }).font).toBe("12px monospace");
  });

  it("insets the text and sizes the backing by the padding the box asks for", () => {
    const { texts, rects } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, text: "ab", textAlign: "right", fontSize: 10, textBackground: "#000", textPadding: 8 });
    expect(texts[0].x).toBe(500 - 8);
    expect(rects[1]).toEqual({ x: 500 - 8 - 12 - 8, y: 50 - 6.5 - 8, w: 28, h: 29, fill: "#000" });
  });

  it("paints an accent as a bar down the backing's left edge and the colour of the first line only", () => {
    const { texts, rects, rounded } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, text: "ab\ncd", textAlign: "right", fontSize: 10, textBackground: "#000", textColor: "#ccc", textAccent: "#2dd4bf" });
    // The backing grows by the 3 px bar, to the left of the text, and the bar takes the backing's own corners.
    expect(rects[1]).toEqual({ x: 500 - 4 - 12 - 4 - 3, y: 43.5 - 6.5 - 4, w: 23, h: 34, fill: "#000" });
    expect(rounded).toEqual([{ x: 500 - 4 - 12 - 4 - 3, y: 43.5 - 6.5 - 4, w: 3, h: 34, r: [0, 0, 0, 0], fill: "#2dd4bf" }]);
    expect(texts.map((t) => [t.text, t.fill])).toEqual([["ab", "#2dd4bf"], ["cd", "#ccc"]]);
  });

  it("moves left-aligned text past the accent bar instead of painting the bar over it", () => {
    const { texts } = paintBox({ time1: 0, price1: 0, time2: 500, price2: 100, text: "ab", textAlign: "left", fontSize: 10, textBackground: "#000", textAccent: "#2dd4bf" });
    expect(texts[0].x).toBe(0 + 4 + 3);
  });

  // Through the fake chart a box's x is its time in ms and its y its price: from (0, 0) to (1000, 100) is 1000 px wide, 100 px tall, centred at y 50.
  it("paints a single unbacked line exactly where it always did: at the aligned edge, on the box's vertical centre", () => {
    const { texts, rects } = paintBox({ time1: 0, price1: 0, time2: 1000, price2: 100, text: "one", textAlign: "right", fontSize: 10 });
    expect(rects).toHaveLength(1);
    expect(texts).toEqual([{ text: "one", x: 1000, y: 50, fill: "#787b86" }]);
  });

  it("stacks the lines of a multi-line text around the box's vertical centre", () => {
    const { texts } = paintBox({ time1: 0, price1: 0, time2: 1000, price2: 100, text: "top\nbottom", textAlign: "left", fontSize: 10 });
    expect(texts.map((t) => [t.text, t.x, t.y])).toEqual([
      ["top", 0, 43.5],
      ["bottom", 0, 56.5],
    ]);
  });

  it("paints a backing sized to the widest line behind the text, inset from the aligned edge, before the text goes on", () => {
    const { texts, rects } = paintBox({ time1: 0, price1: 0, time2: 1000, price2: 100, text: "ab\nabcdef", textAlign: "right", fontSize: 10, textBackground: "#000", textColor: "#fff" });
    expect(rects).toHaveLength(2);
    // Widest line is 6 chars at 6 px each in the fake context: 36 px. Right edge inset 4, padded 4 each side, two lines of 13 padded 4 top and bottom.
    expect(rects[1]).toEqual({ x: 1000 - 4 - 36 - 4, y: 43.5 - 6.5 - 4, w: 44, h: 34, fill: "#000" });
    expect(texts.map((t) => [t.text, t.x, t.y, t.fill])).toEqual([
      ["ab", 996, 43.5, "#fff"],
      ["abcdef", 996, 56.5, "#fff"],
    ]);
  });

  it("centres the backing under centred text", () => {
    const { rects } = paintBox({ time1: 0, price1: 0, time2: 1000, price2: 100, text: "abcd", textAlign: "center", fontSize: 10, textBackground: "#000" });
    expect(rects[1]).toEqual({ x: 500 - 12 - 4, y: 50 - 6.5 - 4, w: 32, h: 21, fill: "#000" });
  });

  it("paints no backing and no inset for an empty backing", () => {
    const { texts, rects } = paintBox({ time1: 0, price1: 0, time2: 1000, price2: 100, text: "a", textAlign: "left", fontSize: 10, textBackground: "" });
    expect(rects).toHaveLength(1);
    expect(texts[0].x).toBe(0);
  });
});
