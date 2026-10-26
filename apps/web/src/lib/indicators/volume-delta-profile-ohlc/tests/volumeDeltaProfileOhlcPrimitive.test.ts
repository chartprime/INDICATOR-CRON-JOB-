import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import { VolumeDeltaProfileOhlcPrimitive } from "../volumeDeltaProfileOhlcPrimitive";
import {
  DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  type VolumeDeltaProfileOhlcSettings,
} from "../volumeDeltaProfileOhlcSettings";

/** One stroked line segment, with the stroke state it was drawn under. */
interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeStyle: string;
  lineWidth: number;
}

/**
 * A hand-rolled `CanvasRenderingTarget2D` that records the level lines: the
 * renderer's only strokes are the POC, VAH and VAL, so the bin fills and box
 * outlines are not worth keeping.
 */
function fakeCanvasTarget(width: number) {
  const segments: Segment[] = [];
  let cursor = { x: 0, y: 0 };

  const context = {
    save: () => {},
    restore: () => {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    fillRect: () => {},
    strokeRect: () => {},
    setLineDash: () => {},
    beginPath: () => {
      cursor = { x: 0, y: 0 };
    },
    moveTo: (x: number, y: number) => {
      cursor = { x, y };
    },
    lineTo: (x: number, y: number) => {
      segments.push({
        x1: cursor.x,
        y1: cursor.y,
        x2: x,
        y2: y,
        strokeStyle: context.strokeStyle,
        lineWidth: context.lineWidth,
      });
    },
    stroke: () => {},
  };

  return {
    segments,
    context,
    useMediaCoordinateSpace: (
      callback: (scope: {
        context: typeof context;
        mediaSize: { width: number; height: number };
      }) => void,
    ) => callback({ context, mediaSize: { width, height: 400 } }),
  };
}

const SETTINGS: VolumeDeltaProfileOhlcSettings = {
  ...DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
  binCount: 10,
};

function bar(): BarFrame {
  return {
    type: "bar",
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTC-USDT",
    interval_ms: 60_000,
    ts_open: 60_000,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1_000,
    buy_volume: 600,
    trade_count: 10,
    closed: true,
  } as unknown as BarFrame;
}

function render(width: number, settings = SETTINGS) {
  const primitive = new VolumeDeltaProfileOhlcPrimitive();
  primitive.attached({
    chart: {
      timeScale: () => ({ getVisibleRange: () => ({ from: 0, to: 120 }) }),
    },
    // Y-inverted, the way a real chart is: a higher price sits higher up.
    series: { priceToCoordinate: (price: number) => (110 - price) * 10 },
    requestUpdate: vi.fn(),
  } as never);

  primitive.update([bar()]);
  primitive.updateSettings(settings);

  const target = fakeCanvasTarget(width);
  for (const view of primitive.paneViews()) {
    view.renderer()?.draw?.(target as never);
  }
  return target;
}

function linesOfColor(segments: readonly Segment[], color: string) {
  return segments.filter((segment) => segment.strokeStyle === color);
}

describe("VolumeDeltaProfileOhlcPrimitive level lines", () => {
  it("runs VAH and VAL to the pane's right edge, unlike the POC line", () => {
    const width = 800;
    const { segments } = render(width);

    for (const color of [SETTINGS.vahColor, SETTINGS.valColor]) {
      const [line] = linesOfColor(segments, color);
      expect(line.x1).toBe(0);
      expect(line.x2).toBe(width);
    }
    // The POC keeps stopping where the profile starts, at the pane's right edge
    // less the profile's own width.
    const [poc] = linesOfColor(segments, SETTINGS.pocColor);
    expect(poc.x1).toBe(0);
    expect(poc.x2).toBe(width - SETTINGS.profileWidth);
  });

  it("strokes VAH and VAL at the thickness the trader picked", () => {
    const { segments } = render(800, { ...SETTINGS, vahValLineWidth: 5 });

    for (const color of [SETTINGS.vahColor, SETTINGS.valColor]) {
      const [line] = linesOfColor(segments, color);
      expect(line.lineWidth).toBe(5);
    }
    // The POC has its own width, which must not follow the VAH/VAL one.
    const [poc] = linesOfColor(segments, SETTINGS.pocColor);
    expect(poc.lineWidth).toBe(2);
  });
});
