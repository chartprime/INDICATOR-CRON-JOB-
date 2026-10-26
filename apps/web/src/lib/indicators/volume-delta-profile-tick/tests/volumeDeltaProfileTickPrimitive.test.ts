import { describe, expect, it, vi } from "vitest";
import type { BarFrame } from "../../../../types/frames";
import type { DeltaSource } from "../../live-delta-profile/candleDeltaSource";
import type { DeltaProfileRow } from "../../live-delta-profile/deltaProfileStore";
import {
  TICK_PROFILE_ESTIMATE_BADGE,
  TICK_PROFILE_LIVE_REBUILD_MS,
  VolumeDeltaProfileTickPrimitive,
} from "../volumeDeltaProfileTickPrimitive";
import {
  DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  type VolumeDeltaProfileTickSettings,
} from "../volumeDeltaProfileTickSettings";

// Building the profile is the expensive half of a draw, so the tests count it.
vi.mock("../volumeDeltaProfileTickSource", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../volumeDeltaProfileTickSource")>();
  return { ...actual, collectTickFlow: vi.fn(actual.collectTickFlow) };
});

/** One stroked line segment, with the stroke state it was drawn under. */
interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeStyle: string;
  lineWidth: number;
  dash: number[];
}

/**
 * A hand-rolled `CanvasRenderingTarget2D`: the renderer's only canvas needs are
 * fills, box outlines and level lines, so this records those and nothing else.
 * `mediaSize` is what the level lines are measured against, so it is a
 * parameter rather than a constant.
 */
function fakeCanvasTarget(width: number) {
  const fillRectCalls: Array<{ x: number; y: number; w: number; h: number }> =
    [];
  const strokeRectCalls: Array<{ x: number; y: number; w: number; h: number }> =
    [];
  const segments: Segment[] = [];
  /** Every paint in the order it reached the canvas: a bin fill or a level line. */
  const order: Array<"fill" | "line"> = [];
  const texts: Array<{ text: string; x: number; y: number }> = [];
  let dash: number[] = [];
  let cursor: { x: number; y: number } | null = null;

  const context = {
    save: () => {},
    restore: () => {},
    font: "",
    textAlign: "",
    textBaseline: "",
    measureText: (text: string) => ({ width: text.length }),
    fillText: (text: string, x: number, y: number) =>
      texts.push({ text, x, y }),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    fillRect: (x: number, y: number, w: number, h: number) => {
      fillRectCalls.push({ x, y, w, h });
      order.push("fill");
    },
    strokeRect: (x: number, y: number, w: number, h: number) =>
      strokeRectCalls.push({ x, y, w, h }),
    setLineDash: (next: number[]) => {
      dash = [...next];
    },
    beginPath: () => {
      cursor = null;
    },
    moveTo: (x: number, y: number) => {
      cursor = { x, y };
    },
    lineTo: (x: number, y: number) => {
      if (cursor !== null) {
        order.push("line");
        segments.push({
          x1: cursor.x,
          y1: cursor.y,
          x2: x,
          y2: y,
          strokeStyle: context.strokeStyle,
          lineWidth: context.lineWidth,
          dash: [...dash],
        });
      }
      cursor = { x, y };
    },
    stroke: () => {},
  };

  return {
    fillRectCalls,
    strokeRectCalls,
    segments,
    texts,
    order,
    context,
    useMediaCoordinateSpace: (
      callback: (scope: {
        context: typeof context;
        mediaSize: { width: number; height: number };
      }) => void,
    ) => callback({ context, mediaSize: { width, height: 400 } }),
  };
}

const ROW_WIDTH = 1;
const PRICE_LOW = 100;
const PRICE_HIGH = 110;
/** The bar and its column share a second, so the tick flow covers the domain. */
const BAR_TS_SEC = 1_000;
const VISIBLE_FROM_SEC = 999;
const VISIBLE_TO_SEC = 1_000;

function bar(): BarFrame {
  return {
    type: "bar",
    provider: "BINANCE",
    marketKind: "SPOT",
    symbol: "BTC-USDT",
    interval_ms: 60_000,
    ts_open: BAR_TS_SEC * 1000,
    open: 105,
    high: PRICE_HIGH,
    low: PRICE_LOW,
    close: 105,
    volume: 0,
    trade_count: 0,
    closed: true,
  };
}

/**
 * A source whose rows cover every price of the domain, with a lopsided lump on
 * row 105 so the POC and the value area are unambiguous.
 */
function deltaSource(overrides: Partial<DeltaSource> = {}): DeltaSource {
  const rows: DeltaProfileRow[] = [];
  for (let row = PRICE_LOW; row < PRICE_HIGH; row += 1) {
    rows.push({
      price: row * ROW_WIDTH,
      buy: row === 105 ? 110 : 10,
      sell: 10,
    });
  }
  return {
    rowWidth: ROW_WIDTH,
    version: 1,
    lastIndex: null,
    recent: [],
    issue: null,
    complete: true,
    pieces: [],
    rows: () => rows,
    ...overrides,
  };
}

/** The same rows, but the host has only answered a piece of the window so far. */
function partialSource(fromMs: number): DeltaSource {
  return deltaSource({
    complete: false,
    pieces: [{ from: fromMs, to: fromMs + 60_000, volume: 0 }],
  });
}

/** The buckets are one row tall, so `calculateTickDeltaProfileBins` lands each row in exactly one bucket. */
const SETTINGS: VolumeDeltaProfileTickSettings = {
  ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  binCount: PRICE_HIGH - PRICE_LOW,
};

/** A primitive on a chart whose visible range and bars do not change, at `pxPerPrice` chart px to the price unit. */
function mount(
  width: number,
  settings = SETTINGS,
  source: DeltaSource | null = deltaSource(),
  pxPerPrice = 10,
) {
  const primitive = new VolumeDeltaProfileTickPrimitive();
  primitive.attached({
    chart: {
      timeScale: () => ({
        getVisibleRange: () => ({
          from: VISIBLE_FROM_SEC,
          to: VISIBLE_TO_SEC,
        }),
      }),
    },
    // Y-inverted, the way a real chart is: a higher price sits higher up.
    series: {
      priceToCoordinate: (price: number) => (PRICE_HIGH - price) * pxPerPrice,
    },
    requestUpdate: vi.fn(),
  } as never);

  primitive.update([bar()], source);
  primitive.updateSettings(settings);

  const target = fakeCanvasTarget(width);
  const draw = () => {
    for (const view of primitive.paneViews()) {
      view.renderer()?.draw?.(target as never);
    }
  };
  return { primitive, source, target, draw };
}

function render(
  width: number,
  settings = SETTINGS,
  source: DeltaSource | null = deltaSource(),
  pxPerPrice = 10,
) {
  const { target, draw } = mount(width, settings, source, pxPerPrice);
  draw();
  return target;
}

function segmentsOfColor(segments: readonly Segment[], color: string) {
  return segments.filter((segment) => segment.strokeStyle === color);
}

/** Where each stroked line landed among the pane's paints, bin fills included. */
function linePositions(order: readonly ("fill" | "line")[]): number[] {
  return order.flatMap((kind, index) => (kind === "line" ? [index] : []));
}

describe("VolumeDeltaProfileTickPrimitive bin volume text", () => {
  it("writes each bin's total volume inside its bar", () => {
    // Two rows per bin, so every bar is tall enough to carry its text.
    const { texts } = render(800, { ...SETTINGS, binCount: 5 });

    // The bar widths are drawn from the smoothed bins, so the text matches them.
    expect(texts.map((entry) => entry.text).sort()).toEqual(
      ["40", "40", "65", "65", "90"],
    );
  });

  it("skips bins too short to hold legible text", () => {
    // Zoomed right out: a whole $1 row is one pixel tall, so no bar can carry a
    // number. The rows are the source's own here, whatever count is asked for.
    const { texts } = render(
      800,
      { ...SETTINGS, binCount: 20 },
      deltaSource(),
      1,
    );

    expect(texts).toHaveLength(0);
  });

  it("writes nothing when bin volume text is off", () => {
    const { texts } = render(800, {
      ...SETTINGS,
      binCount: 5,
      binVolumeVisible: false,
    });

    expect(texts).toHaveLength(0);
  });
});

describe("VolumeDeltaProfileTickPrimitive level lines", () => {
  it("draws the POC, VAH and VAL lines, nothing else", () => {
    const { segments } = render(800);

    expect(segments).toHaveLength(3);
    expect(segmentsOfColor(segments, SETTINGS.pocColor)).toHaveLength(1);
    expect(segmentsOfColor(segments, SETTINGS.vahColor)).toHaveLength(1);
    expect(segmentsOfColor(segments, SETTINGS.valColor)).toHaveLength(1);
  });

  it("runs VAH and VAL across the profile to the pane's right edge, unlike the POC line", () => {
    const width = 800;
    const { segments } = render(width);

    const [vah] = segmentsOfColor(segments, SETTINGS.vahColor);
    const [val] = segmentsOfColor(segments, SETTINGS.valColor);
    const [poc] = segmentsOfColor(segments, SETTINGS.pocColor);

    for (const line of [vah, val]) {
      expect(line.x1).toBe(0);
      expect(line.x2).toBe(width);
    }
    // POC keeps stopping where the profile starts, at the pane's right edge
    // less the profile's own width.
    expect(poc.x1).toBe(0);
    expect(poc.x2).toBe(width - SETTINGS.profileWidth);
  });

  it("tracks the pane width, so VAH/VAL reach the right edge at any size", () => {
    for (const width of [320, 1_440]) {
      const { segments } = render(width);
      for (const color of [SETTINGS.vahColor, SETTINGS.valColor]) {
        const [line] = segmentsOfColor(segments, color);
        expect(line.x2).toBe(width);
      }
    }
  });

  it("keeps the lines' own styles: solid POC, dashed thin VAH/VAL", () => {
    const { segments } = render(800);

    const [poc] = segmentsOfColor(segments, SETTINGS.pocColor);
    expect(poc.dash).toEqual([]);
    expect(poc.lineWidth).toBe(SETTINGS.pocLineWidth);

    for (const color of [SETTINGS.vahColor, SETTINGS.valColor]) {
      const [line] = segmentsOfColor(segments, color);
      expect(line.dash).toEqual([8, 4]);
      expect(line.lineWidth).toBe(SETTINGS.vahValLineWidth);
    }
  });

  it("paints VAH and VAL under the bins, and the POC over them", () => {
    const { segments, order } = render(800);
    const positions = linePositions(order);
    const paintPosition = (color: string) =>
      positions[segments.findIndex((segment) => segment.strokeStyle === color)];

    const firstBin = order.indexOf("fill");
    const lastBin = order.lastIndexOf("fill");
    expect(firstBin).toBeGreaterThan(-1);

    for (const color of [SETTINGS.vahColor, SETTINGS.valColor]) {
      expect(paintPosition(color)).toBeLessThan(firstBin);
    }
    // The POC is the last thing on the canvas, so it reads over the profile.
    expect(paintPosition(SETTINGS.pocColor)).toBeGreaterThan(lastBin);
  });

  it("strokes VAH and VAL at the thickness the trader picked", () => {
    const { segments } = render(800, { ...SETTINGS, vahValLineWidth: 4 });

    for (const color of [SETTINGS.vahColor, SETTINGS.valColor]) {
      const [line] = segmentsOfColor(segments, color);
      expect(line.lineWidth).toBe(4);
    }
    // The POC has its own setting, which must not follow the VAH/VAL one.
    const [poc] = segmentsOfColor(segments, SETTINGS.pocColor);
    expect(poc.lineWidth).toBe(SETTINGS.pocLineWidth);
  });

  it("follows the source's own prints, whatever landed in the bar's opening second", () => {
    // The bar and the source are different things: the profile is the trades the
    // source holds for the window, so a print that reached it moves the POC even
    // though nothing about the bar changed.
    const LUMP = 400;
    const pocYOf = (source: DeltaSource) =>
      segmentsOfColor(render(800, SETTINGS, source).segments, SETTINGS.pocColor)[0]
        .y1;

    const quiet = pocYOf(deltaSource());
    const loud = pocYOf(
      deltaSource({
        rows: () => [
          ...deltaSource().rows().filter((row) => row.price !== 104),
          { price: 104 * ROW_WIDTH, buy: LUMP, sell: 0 },
        ],
        version: 2,
      }),
    );

    expect(loud).not.toBe(quiet);
  });

  it("draws nothing at all while the source holds no rows", () => {
    // The host answers newest first, so a wide window has a stretch where the
    // profile has nothing to draw: no bars, no levels, no POC.
    const { segments, fillRectCalls } = render(
      800,
      SETTINGS,
      deltaSource({ rows: () => [] }),
    );

    expect(segments).toEqual([]);
    expect(fillRectCalls).toEqual([]);
  });

  it("builds the profile once for paints that change nothing it is made of", async () => {
    const { collectTickFlow } = await import("../volumeDeltaProfileTickSource");
    const builds = vi.mocked(collectTickFlow);
    const { primitive, draw } = mount(800);
    builds.mockClear();

    // A repaint: the chart asking again for the same picture. The profile is not
    // rebuilt, however many times the canvas is painted.
    draw();
    draw();
    draw();
    expect(builds).toHaveBeenCalledTimes(1);

    // A print lands in the source: the same bars, but new trades behind them.
    primitive.update([bar()], deltaSource({ version: 2 }));
    draw();
    expect(builds).toHaveBeenCalledTimes(2);

    // The trader picks another row count.
    primitive.updateSettings({ ...SETTINGS, binCount: 5 });
    draw();
    expect(builds).toHaveBeenCalledTimes(3);
  });

  it("rebuilds for streaming trades at most once per interval, and repaints once it is up", async () => {
    const { collectTickFlow } = await import("../volumeDeltaProfileTickSource");
    const builds = vi.mocked(collectTickFlow);
    vi.useFakeTimers();
    try {
      // One live store, mutated in place: every print moves its version.
      let version = 1;
      const live = deltaSource();
      Object.defineProperty(live, "version", { get: () => version });
      const { primitive, draw } = mount(800, SETTINGS, live);
      const requestUpdate = vi.fn();
      primitive.attached({
        chart: { timeScale: () => ({ getVisibleRange: () => ({ from: VISIBLE_FROM_SEC, to: VISIBLE_TO_SEC }) }) },
        series: { priceToCoordinate: (price: number) => (PRICE_HIGH - price) * 10 },
        requestUpdate,
      } as never);
      builds.mockClear();
      draw();
      expect(builds).toHaveBeenCalledTimes(1);

      // Prints stream in and the chart repaints on each: the frame is kept.
      for (let i = 0; i < 5; i += 1) {
        version += 1;
        vi.advanceTimersByTime(10);
        draw();
      }
      expect(builds).toHaveBeenCalledTimes(1);

      // Once the interval is up the owed repaint is asked for, and it rebuilds.
      requestUpdate.mockClear();
      vi.advanceTimersByTime(TICK_PROFILE_LIVE_REBUILD_MS);
      expect(requestUpdate).toHaveBeenCalledTimes(1);
      draw();
      expect(builds).toHaveBeenCalledTimes(2);

      // A change of shape (here the settings) never waits for the interval.
      primitive.updateSettings({ ...SETTINGS, binCount: 5 });
      draw();
      expect(builds).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("badges a profile estimated from candles, and only that one", () => {
    const traded = render(800);
    expect(traded.texts.map((t) => t.text)).not.toContain(TICK_PROFILE_ESTIMATE_BADGE);
    const estimated = render(800, SETTINGS, deltaSource({ estimated: true }));
    expect(estimated.texts.map((t) => t.text)).toContain(TICK_PROFILE_ESTIMATE_BADGE);
  });

  it("tells the panel where the profile's flow starts, once per change", () => {
    const onTruncatedFromChange = vi.fn();
    const { primitive, draw } = mount(
      800,
      SETTINGS,
      partialSource(BAR_TS_SEC * 1000),
    );
    primitive.onTruncatedFromChange = onTruncatedFromChange;

    draw();
    draw();
    // The host has only answered a piece that opens a second after the visible
    // range does, so the profile covers all but that second and says where it
    // starts.
    expect(onTruncatedFromChange.mock.calls).toEqual([[BAR_TS_SEC * 1000]]);

    // A source holding the whole window has nothing to qualify.
    primitive.update([bar()], deltaSource());
    draw();
    expect(onTruncatedFromChange).toHaveBeenLastCalledWith(null);

    // Hidden: there is no profile to qualify.
    primitive.update([], null);
    expect(onTruncatedFromChange).toHaveBeenLastCalledWith(null);
  });

  it("strokes the POC at the thickness the trader picked", () => {
    const { segments } = render(800, { ...SETTINGS, pocLineWidth: 5 });

    const [poc] = segmentsOfColor(segments, SETTINGS.pocColor);
    expect(poc.lineWidth).toBe(5);
  });
});

describe("VolumeDeltaProfileTickPrimitive beside the price axis", () => {
  it("sits left of whatever holds the axis: bars, VAH/VAL and the POC all stop at the inset", () => {
    const width = 800;
    const inset = 68;
    const { primitive, target, draw } = mount(width);
    primitive.setRightInset(() => inset);
    draw();

    const rightEdges = target.fillRectCalls.map((call) => call.x + call.w);
    expect(Math.max(...rightEdges)).toBeCloseTo(width - inset, 10);
    for (const color of [SETTINGS.vahColor, SETTINGS.valColor]) {
      const [line] = segmentsOfColor(target.segments, color);
      expect(line.x2).toBe(width - inset);
    }
    const [poc] = segmentsOfColor(target.segments, SETTINGS.pocColor);
    expect(poc.x2).toBe(width - inset - SETTINGS.profileWidth);
  });

  it("uses the whole pane when nothing holds the axis", () => {
    const width = 800;
    const { primitive, target, draw } = mount(width);
    primitive.setRightInset(() => 0);
    draw();

    const rightEdges = target.fillRectCalls.map((call) => call.x + call.w);
    expect(Math.max(...rightEdges)).toBeCloseTo(width, 10);
  });
});

describe("VolumeDeltaProfileTickPrimitive POC and value area", () => {
  /** Four one-price rows of raw volume 5 / 9 / 10 / 1, rows 100..103. */
  function lopsided(): DeltaSource {
    const volumes = [5, 9, 10, 1];
    return {
      rowWidth: 1,
      version: 1,
      lastIndex: null,
      recent: [],
      issue: null,
      complete: true,
      pieces: [],
      rows: () =>
        volumes.map((volume, index) => ({
          price: 100 + index,
          buy: volume,
          sell: 0,
        })),
    };
  }

  function drawLopsided() {
    const primitive = new VolumeDeltaProfileTickPrimitive();
    primitive.attached({
      chart: {
        timeScale: () => ({
          getVisibleRange: () => ({ from: VISIBLE_FROM_SEC, to: VISIBLE_TO_SEC }),
        }),
      },
      series: { priceToCoordinate: (price: number) => (PRICE_HIGH - price) * 10 },
      requestUpdate: vi.fn(),
    } as never);
    primitive.update([{ ...bar(), low: 100, high: 104 }], lopsided());
    primitive.updateSettings({ ...SETTINGS, binCount: 4 });
    const target = fakeCanvasTarget(800);
    for (const view of primitive.paneViews()) view.renderer()?.draw?.(target as never);
    return target;
  }

  it("puts the POC on the tallest bar, not on the row that traded most before the blend", () => {
    const target = drawLopsided();
    const [poc] = segmentsOfColor(target.segments, SETTINGS.pocColor);

    // The raw rows are 5 / 9 / 10 / 1, so the spike at 102.5 holds the most, but
    // the blend spreads it into its neighbours (6 / 8.25 / 7.5 / 3.25) and the
    // tallest bar becomes the 9 row at 101.5. The line names the bar on screen.
    expect(poc.y1).toBeCloseTo((PRICE_HIGH - 101.5) * 10, 10);

    // Which is the longest bar there is: the line lands inside it.
    const longest = target.fillRectCalls.reduce((max, call) =>
      call.w > max.w ? call : max,
    );
    expect(longest.y).toBeLessThanOrEqual(poc.y1);
    expect(longest.y + longest.h).toBeGreaterThan(poc.y1);
  });

  it("takes the value area from the same bars, so it brackets the POC it names", () => {
    const { segments } = drawLopsided();
    const [vah] = segmentsOfColor(segments, SETTINGS.vahColor);
    const [val] = segmentsOfColor(segments, SETTINGS.valColor);
    // Blended rows of 6 / 8.25 / 7.5 / 3.25: the POC's 8.25 at 101.5, then the
    // 7.5 at 102.5 (15.75 of 25), then the 6 at 100.5 reaches 21.75 (>= 68%), so
    // the area covers rows 100.5 to 102.5 and its edges are VAL 100, VAH 103.
    // Off the raw rows it would have stopped at the 9 row, VAL 101.
    expect(val.y1).toBeCloseTo((PRICE_HIGH - 100) * 10, 10);
    expect(vah.y1).toBeCloseTo((PRICE_HIGH - 103) * 10, 10);
  });
});
