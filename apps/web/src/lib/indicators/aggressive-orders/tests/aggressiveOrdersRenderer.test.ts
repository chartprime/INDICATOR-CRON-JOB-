import { describe, expect, it, vi } from "vitest";
import type { OrderCluster } from "../aggressiveTape";
import { AggressiveOrdersRenderer, HOVER_CORE_MIN_PX, HOVER_CORE_SHARE, MAX_DRAWN_BUBBLES, PULSE_GROWTH, PULSE_MS, bubbleAt, layoutBubbles, parseHex, shade, sphereTones, type BubbleGeometry } from "../aggressiveOrdersRenderer";
import { BUBBLE_MAX_RADIUS_PX, BUBBLE_MIN_RADIUS_PX, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS } from "../aggressiveOrdersSettings";

const T = 1_700_000_000_000;
const order = (over: Partial<OrderCluster> = {}): OrderCluster => ({ ts: T, lastTs: T, fedAt: -Infinity, price: 200, lastPrice: 200, minPrice: 200, maxPrice: 200, vwap: 200, volume: 10, count: 1, side: "buy", ...over });
// Time 1 px per second, price 1 px per unit from the bottom, a 1000 x 500 pane.
const geometry: BubbleGeometry = {
  xOf: (ms) => (ms - T) / 1000,
  yOf: (price) => (price > 1000 ? null : 500 - price),
  width: 1000,
  height: 500,
};

describe("aggressiveOrdersRenderer", () => {
  it("places each order at its own moment and price, smallest first", () => {
    const small = order({ volume: 10 });
    const big = order({ side: "sell", ts: T + 5_000, volume: 40, price: 220, lastPrice: 220, minPrice: 220, maxPrice: 220, vwap: 220 });
    expect(layoutBubbles([big, small], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry)).toEqual([
      { x: 0, y: 500 - 200, bottom: 500 - 200, r: BUBBLE_MIN_RADIUS_PX, side: "buy", pulse: 0, volume: 10, price: 200, ts: T, count: 1 },
      { x: 5, y: 500 - 220, bottom: 500 - 220, r: BUBBLE_MIN_RADIUS_PX * 2, side: "sell", pulse: 0, volume: 40, price: 220, ts: T + 5_000, count: 1 },
    ]);
  });

  it("answers a hover at a bubble's core only, the one on top first, and along the spine of a capsule", () => {
    const small = order({ volume: 10, vwap: 200.5, count: 3 });
    const big = order({ side: "sell", ts: T + 40_000, volume: 1000, price: 220, lastPrice: 220, minPrice: 220, maxPrice: 220, vwap: 220 });
    const bubbles = layoutBubbles([small, big], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry);
    const [smallBubble, bigBubble] = bubbles;
    expect(bigBubble.r).toBe(BUBBLE_MAX_RADIUS_PX);
    const core = Math.min(bigBubble.r, Math.max(HOVER_CORE_MIN_PX, bigBubble.r * HOVER_CORE_SHARE));
    expect(bubbleAt(bubbles, bigBubble.x, bigBubble.y)).toMatchObject({ side: "sell", volume: 1000, price: 220, ts: T + 40_000, count: 1 });
    expect(bubbleAt(bubbles, bigBubble.x + core - 0.5, bigBubble.y)).toBe(bigBubble);
    // Inside the sphere but outside its core: nothing, the trader asked for the centre only.
    expect(bubbleAt(bubbles, bigBubble.x + core + 0.5, bigBubble.y)).toBeNull();
    expect(bubbleAt(bubbles, bigBubble.x, bigBubble.y - bigBubble.r + 1)).toBeNull();
    // A small bubble keeps a core big enough to hit.
    expect(smallBubble.r).toBe(BUBBLE_MIN_RADIUS_PX);
    expect(smallBubble.price).toBe(200.5);
    expect(bubbleAt(bubbles, smallBubble.x + HOVER_CORE_MIN_PX - 0.5, smallBubble.y)).toBe(smallBubble);
    expect(bubbleAt(bubbles, smallBubble.x + HOVER_CORE_MIN_PX + 0.5, smallBubble.y)).toBeNull();
    // Overlapping cores: the bubble drawn last (the bigger) answers.
    const twin = order({ side: "sell", volume: 1000, price: 200, lastPrice: 200, minPrice: 200, maxPrice: 200 });
    const stacked = layoutBubbles([small, twin], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry);
    expect(bubbleAt(stacked, 0, 500 - 200)?.volume).toBe(1000);
    // A capsule answers along its spine, from its top centre to its bottom centre.
    const sweep = order({ side: "sell", volume: 1000, price: 210, lastPrice: 190, minPrice: 190, maxPrice: 210 });
    const [capsule] = layoutBubbles([sweep], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry);
    expect(bubbleAt([capsule], capsule.x, (capsule.y + capsule.bottom) / 2)).toBe(capsule);
    expect(bubbleAt([capsule], capsule.x, capsule.bottom + core - 0.5)).toBe(capsule);
    expect(bubbleAt([capsule], capsule.x, capsule.bottom + core + 0.5)).toBeNull();
    expect(bubbleAt([], 0, 0)).toBeNull();
  });

  it("draws a linked bubble on the middle of its candle, buyers right of centre and sellers left", () => {
    const candle = 900_000; // 15 minutes
    const open = Math.ceil(T / candle) * candle; // a candle boundary inside the pane
    const geometryWithLink: BubbleGeometry = { ...geometry, link: { bucketMs: candle, offsetPx: 6 } };
    const buy = order({ ts: open + 60_000 });
    const sell = order({ ts: open + 800_000, side: "sell" });
    const placed = layoutBubbles([buy, sell], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometryWithLink);
    const middle = geometry.xOf(open + candle / 2) as number;
    // Both land on the same candle whatever their own moment, split by side.
    expect(placed.map((bubble) => bubble.x).sort((a, b) => a - b)).toEqual([middle - 6, middle + 6]);
    expect(placed.find((bubble) => bubble.side === "buy")?.x).toBe(middle + 6);
    // Without a link they keep their own moments.
    const free = layoutBubbles([buy, sell], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry);
    expect(free.map((bubble) => bubble.x)).toEqual([geometry.xOf(buy.ts), geometry.xOf(sell.ts)]);
  });

  it("stretches a run that walked the book into a capsule from its highest print to its lowest", () => {
    const sweep = order({ side: "sell", price: 210, lastPrice: 190, minPrice: 190, maxPrice: 210 });
    expect(layoutBubbles([sweep], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry)[0]).toMatchObject({ y: 500 - 210, bottom: 500 - 190 });
  });

  it("swells a bubble that was just fed and lets the pulse fade", () => {
    const fed = order({ fedAt: 1_000 });
    expect(layoutBubbles([fed], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry, 1_000)[0]).toMatchObject({ r: BUBBLE_MIN_RADIUS_PX * (1 + PULSE_GROWTH), pulse: 1 });
    expect(layoutBubbles([fed], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry, 1_000 + PULSE_MS / 2)[0].pulse).toBeCloseTo(0.5);
    expect(layoutBubbles([fed], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry, 1_000 + PULSE_MS)[0]).toMatchObject({ r: BUBBLE_MIN_RADIUS_PX, pulse: 0 });
  });

  it("leaves out orders wholly off the pane and prices the scale cannot place, and keeps only the biggest past the cap", () => {
    const offRight = order({ ts: T + 2_000_000 });
    const noPrice = order({ price: 5000, lastPrice: 5000, minPrice: 5000, maxPrice: 5000 });
    expect(layoutBubbles([offRight, noPrice, order()], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry)).toHaveLength(1);
    const many = Array.from({ length: MAX_DRAWN_BUBBLES + 5 }, (_, i) => order({ ts: T + (i % 900) * 1000, volume: 10 + i }));
    const drawn = layoutBubbles(many, 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, geometry);
    expect(drawn).toHaveLength(MAX_DRAWN_BUBBLES);
    expect(drawn[0].r).toBeGreaterThan(BUBBLE_MIN_RADIUS_PX); // the five smallest were dropped
  });

  it("parses colours, shades them toward white or black, and gives a sphere a highlight and a rim", () => {
    expect(parseHex("#f8f8f5", "#000000")).toEqual({ r: 248, g: 248, b: 245 });
    expect(parseHex("nope", "#111111")).toEqual({ r: 17, g: 17, b: 17 });
    expect(shade({ r: 100, g: 100, b: 100 }, 0.5)).toEqual({ r: 178, g: 178, b: 178 });
    expect(shade({ r: 100, g: 100, b: 100 }, -0.5)).toEqual({ r: 50, g: 50, b: 50 });
    const light = sphereTones({ r: 248, g: 248, b: 245 });
    expect(light.rim.r).toBeLessThan(light.body.r);
    expect(light.highlight.r).toBeGreaterThanOrEqual(light.body.r);
    const dark = sphereTones({ r: 17, g: 17, b: 17 });
    expect(dark.highlight.r).toBeGreaterThan(dark.body.r);
    expect(dark.rim.r).toBeLessThanOrEqual(dark.body.r);
  });

  it("paints every bubble in order as a shaded sphere in its side's colour", () => {
    const calls: string[] = [];
    const stops: string[] = [];
    const gradient = { addColorStop: vi.fn((offset: number, colour: string) => stops.push(`${offset} ${colour}`)) };
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      createRadialGradient: vi.fn((x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) => {
        calls.push(`gradient ${x0},${y0},${r0} -> ${x1},${y1},${r1}`);
        return gradient;
      }),
      beginPath: vi.fn(() => calls.push("begin")),
      arc: vi.fn((_x: number, _y: number, r: number) => calls.push(`arc ${r}`)),
      fill: vi.fn(() => calls.push(`fill ${context.fillStyle === gradient ? "gradient" : "?"}`)),
      fillStyle: null as unknown,
    };
    const target = { useMediaCoordinateSpace: (draw: (scope: { context: typeof context }) => void) => draw({ context }) };
    new AggressiveOrdersRenderer({
      bubbles: [
        { x: 10, y: 10, bottom: 10, r: 4, side: "buy", pulse: 0, volume: 1, price: 100, ts: 0, count: 1 },
        { x: 20, y: 20, bottom: 20, r: 8, side: "sell", pulse: 0, volume: 2, price: 101, ts: 0, count: 1 },
      ],
      settings: { ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, opacity: 1 },
      palette: { buy: "#f8f8f5", sell: "#111111", stroke: "#111111" },
    }).draw(target as never);
    expect(calls).toEqual([
      "begin", "gradient 8.6,8.6,0.2 -> 10,10,4", "arc 4", "fill gradient",
      "begin", "gradient 17.2,17.2,0.4 -> 20,20,8", "arc 8", "fill gradient",
    ]);
    expect(stops).toHaveLength(6);
    expect(stops[1]).toBe("0.55 rgba(248, 248, 245, 1.000)"); // the buyer's body is the bullish candle colour
    expect(stops[4]).toBe("0.55 rgba(17, 17, 17, 1.000)"); // the seller's the bearish one
    expect(context.restore).toHaveBeenCalled();
  });

  it("paints a capsule for a bubble with a price spread: two half-circles joined, lit from the left", () => {
    const calls: string[] = [];
    const gradient = { addColorStop: vi.fn() };
    const context = {
      save: vi.fn(), restore: vi.fn(),
      createRadialGradient: vi.fn(() => { calls.push("radial"); return gradient; }),
      createLinearGradient: vi.fn((x0: number, _y0: number, x1: number) => { calls.push(`linear ${x0}..${x1}`); return gradient; }),
      beginPath: vi.fn(() => calls.push("begin")),
      arc: vi.fn((x: number, y: number, r: number, a0: number, a1: number) => calls.push(`arc ${x},${y},${r} ${a0.toFixed(2)}..${a1.toFixed(2)}`)),
      lineTo: vi.fn((x: number, y: number) => calls.push(`line ${x},${y}`)),
      closePath: vi.fn(() => calls.push("close")),
      fill: vi.fn(() => calls.push("fill")),
      fillStyle: null as unknown,
    };
    const target = { useMediaCoordinateSpace: (draw: (scope: { context: typeof context }) => void) => draw({ context }) };
    new AggressiveOrdersRenderer({
      bubbles: [{ x: 10, y: 10, bottom: 40, r: 4, side: "sell", pulse: 0, volume: 1, price: 100, ts: 0, count: 1 }],
      settings: DEFAULT_AGGRESSIVE_ORDERS_SETTINGS,
      palette: { buy: "#f8f8f5", sell: "#111111", stroke: "#111111" },
    }).draw(target as never);
    expect(calls).toEqual(["begin", "linear 6..14", "arc 10,10,4 3.14..0.00", "line 14,40", "arc 10,40,4 0.00..3.14", "close", "fill"]);
    expect(gradient.addColorStop).toHaveBeenCalledTimes(4);
  });

  it("draws no bubble for a print the chart has no candle for: the geometry answers null and the order is left out, the others placed", () => {
    // A print from before the chart's first candle has nowhere to sit; it is not pinned to the pane's edge.
    const placed = order({ ts: T + 5_000 });
    const homeless = order({ ts: T - 5_000, side: "sell" });
    const partial: BubbleGeometry = { ...geometry, xOf: (ms) => (ms < T ? null : (ms - T) / 1000) };
    expect(layoutBubbles([homeless, placed], 10, DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, partial).map((bubble) => [bubble.side, bubble.x])).toEqual([["buy", 5]]);
  });

  it("draws nothing when there are no bubbles", () => {
    const useMediaCoordinateSpace = vi.fn();
    new AggressiveOrdersRenderer({ bubbles: [], settings: DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, palette: { buy: "#fff", sell: "#000", stroke: "#000" } }).draw({ useMediaCoordinateSpace } as never);
    expect(useMediaCoordinateSpace).not.toHaveBeenCalled();
  });
});
