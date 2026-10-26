import { describe, expect, it, vi } from "vitest";
import {
  buildSeriesMarker,
  DEFAULT_MARKER_COLOR,
  DEFAULT_MARKER_POSITION,
  MarkerSeriesController,
  overwriteBarMarkerCalls,
  plotCharCall,
  plotShapeCall,
  pushMarkerCalls,
  resetMarkerCalls,
  type MarkerCall,
} from "../markers";

describe("plotShapeCall / plotCharCall", () => {
  it("plotShapeCall applies default position and color when omitted", () => {
    expect(plotShapeCall(1000, { shape: "circle" })).toEqual({
      time: 1000,
      shape: "circle",
      position: DEFAULT_MARKER_POSITION,
      color: DEFAULT_MARKER_COLOR,
      text: undefined,
      size: undefined,
      price: undefined,
    });
  });

  it("plotShapeCall carries through explicit overrides", () => {
    expect(
      plotShapeCall(1000, {
        shape: "arrowUp",
        position: "belowBar",
        color: "#00ff00",
        text: "BUY",
        size: 2,
      }),
    ).toEqual({
      time: 1000,
      shape: "arrowUp",
      position: "belowBar",
      color: "#00ff00",
      text: "BUY",
      size: 2,
      price: undefined,
    });
  });

  it("uses an explicit timestamp when a marker is confirmed after its bar", () => {
    expect(plotShapeCall(3000, { time: 1000, shape: "arrowDown" }).time).toBe(
      1000,
    );
  });

  it("plotCharCall maps its char into the text field against a neutral circle shape", () => {
    expect(plotCharCall(2000, { char: "!" })).toEqual({
      time: 2000,
      shape: "circle",
      position: DEFAULT_MARKER_POSITION,
      color: DEFAULT_MARKER_COLOR,
      text: "!",
      size: undefined,
      price: undefined,
    });
  });
});

describe("buildSeriesMarker", () => {
  it("builds a bar-relative marker, converting time from ms to seconds", () => {
    const call: MarkerCall = {
      time: 5000,
      shape: "circle",
      position: "aboveBar",
      color: "#fff",
    };
    expect(buildSeriesMarker(call)).toEqual({
      time: 5,
      position: "aboveBar",
      shape: "circle",
      color: "#fff",
      text: undefined,
      size: undefined,
    });
  });

  it("builds a price-anchored marker including its price field, defaulting to 0 if omitted", () => {
    const call: MarkerCall = {
      time: 5000,
      shape: "square",
      position: "atPriceTop",
      color: "#fff",
    };
    expect(buildSeriesMarker(call)).toMatchObject({
      position: "atPriceTop",
      price: 0,
    });
  });

  it("carries an explicit price through for a price-anchored marker", () => {
    const call: MarkerCall = {
      time: 0,
      shape: "square",
      position: "atPriceBottom",
      color: "#fff",
      price: 42,
    };
    expect(buildSeriesMarker(call)).toMatchObject({
      position: "atPriceBottom",
      price: 42,
    });
  });
});

describe("pushMarkerCalls / overwriteBarMarkerCalls / resetMarkerCalls", () => {
  it("pushMarkerCalls appends without touching earlier entries", () => {
    const buffer: MarkerCall[] = [];
    pushMarkerCalls(buffer, [plotShapeCall(0, { shape: "circle" })]);
    pushMarkerCalls(buffer, [plotShapeCall(1000, { shape: "square" })]);
    expect(buffer.map((call) => call.time)).toEqual([0, 1000]);
  });

  it("overwriteBarMarkerCalls drops every call at the given bar time before re-adding the fresh ones", () => {
    const buffer: MarkerCall[] = [
      plotShapeCall(0, { shape: "circle" }),
      plotShapeCall(1000, { shape: "circle" }),
      plotShapeCall(1000, { shape: "square" }),
    ];
    overwriteBarMarkerCalls(buffer, 1000, [
      plotShapeCall(1000, { shape: "arrowUp" }),
    ]);
    expect(buffer).toEqual([
      plotShapeCall(0, { shape: "circle" }),
      plotShapeCall(1000, { shape: "arrowUp" }),
    ]);
  });

  it("overwriteBarMarkerCalls with zero fresh calls leaves the bar with no markers at all", () => {
    const buffer: MarkerCall[] = [plotShapeCall(1000, { shape: "circle" })];
    overwriteBarMarkerCalls(buffer, 1000, []);
    expect(buffer).toEqual([]);
  });

  it("resetMarkerCalls empties the buffer in place", () => {
    const buffer: MarkerCall[] = [plotShapeCall(0, { shape: "circle" })];
    resetMarkerCalls(buffer);
    expect(buffer).toEqual([]);
  });
});

describe("MarkerSeriesController -- batches once per flush, not once per buffered call", () => {
  it("calling setMarkers once after buffering three plotshape calls invokes the real plugin's setMarkers exactly once", () => {
    const setMarkers = vi.fn();
    const controller = new MarkerSeriesController(() => ({ setMarkers }));
    controller.attach({});

    const buffer: MarkerCall[] = [];
    pushMarkerCalls(buffer, [plotShapeCall(0, { shape: "circle" })]);
    pushMarkerCalls(buffer, [plotShapeCall(0, { shape: "square" })]);
    pushMarkerCalls(buffer, [plotShapeCall(0, { shape: "arrowUp" })]);
    controller.setMarkers(buffer);

    expect(setMarkers).toHaveBeenCalledTimes(1);
    expect(setMarkers.mock.calls[0][0]).toHaveLength(3);
  });

  it("sorts calls into ascending time order before forwarding to the real plugin, even when merged across owners out of order", () => {
    const setMarkers = vi.fn();
    const controller = new MarkerSeriesController(() => ({ setMarkers }));
    controller.attach({});

    // Two owners' chronological runs interleaved out of global order, the
    // real shape flushDrawState produces when concatenating per-owner markers.
    controller.setMarkers([
      plotShapeCall(2000, { shape: "circle" }),
      plotShapeCall(3000, { shape: "circle" }),
      plotShapeCall(1000, { shape: "square" }),
      plotShapeCall(2500, { shape: "square" }),
    ]);

    const forwarded = setMarkers.mock.calls[0][0] as { time: number }[];
    expect(forwarded.map((marker) => marker.time)).toEqual([1, 2, 2.5, 3]);
  });

  it("setMarkers before attach is a silent no-op", () => {
    const controller = new MarkerSeriesController(() => ({
      setMarkers: vi.fn(),
    }));
    expect(() =>
      controller.setMarkers([plotShapeCall(0, { shape: "circle" })]),
    ).not.toThrow();
  });

  it("detach calls the plugin's own detach and stops forwarding further setMarkers calls", () => {
    const setMarkers = vi.fn();
    const detach = vi.fn();
    const controller = new MarkerSeriesController(() => ({
      setMarkers,
      detach,
    }));
    controller.attach({});
    controller.detach();
    expect(detach).toHaveBeenCalledTimes(1);

    controller.setMarkers([plotShapeCall(0, { shape: "circle" })]);
    expect(setMarkers).not.toHaveBeenCalled();
  });

  it("detach tolerates a plugin with no detach method of its own", () => {
    const controller = new MarkerSeriesController(() => ({
      setMarkers: vi.fn(),
    }));
    controller.attach({});
    expect(() => controller.detach()).not.toThrow();
  });
});
