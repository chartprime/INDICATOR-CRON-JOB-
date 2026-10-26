import type { IPrimitivePaneRenderer } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { OrderCluster } from "./aggressiveTape";
import { bubbleRadius, type AggressiveOrdersSettings } from "./aggressiveOrdersSettings";

export interface AggressiveBubble {
  x: number;
  y: number;
  bottom: number;
  r: number;
  side: "buy" | "sell";
  pulse: number;
  volume: number;
  price: number;
  ts: number;
  count: number;
}

export interface BubbleGeometry {
  /** The x of a moment on the chart, null for one the chart has no candle for. */
  xOf: (ms: number) => number | null;
  yOf: (price: number) => number | null;
  width: number;
  height: number;
  link?: { bucketMs: number; offsetPx: number } | null;
}

export interface BubblePalette {
  buy: string;
  sell: string;
  stroke: string;
}

export const MAX_DRAWN_BUBBLES = 3_000;
export const PULSE_MS = 350;
export const PULSE_GROWTH = 0.3;
export const HOVER_CORE_SHARE = 0.35;
export const HOVER_CORE_MIN_PX = 3;

export function layoutBubbles(orders: readonly OrderCluster[], reference: number, settings: AggressiveOrdersSettings, geometry: BubbleGeometry, nowMs: number = -Infinity): AggressiveBubble[] {
  const placed: AggressiveBubble[] = [];
  for (const order of orders) {
    const top = geometry.yOf(order.maxPrice);
    const bottom = geometry.yOf(order.minPrice);
    if (top === null || bottom === null) continue;
    const link = geometry.link ?? null;
    const moment = link && link.bucketMs > 0 ? Math.floor(order.ts / link.bucketMs) * link.bucketMs + link.bucketMs / 2 : order.ts;
    const at = geometry.xOf(moment);
    if (at === null) continue;
    const x = at + (link ? (order.side === "buy" ? link.offsetPx : -link.offsetPx) : 0);
    const pulse = Number.isFinite(nowMs) && Number.isFinite(order.fedAt) ? Math.max(0, Math.min(1, 1 - (nowMs - order.fedAt) / PULSE_MS)) : 0;
    const r = bubbleRadius(order.volume, reference, settings.bubbleScale) * (1 + PULSE_GROWTH * pulse);
    const y = Math.min(top, bottom);
    const low = Math.max(top, bottom);
    if (x + r < 0 || x - r > geometry.width || low + r < 0 || y - r > geometry.height) continue;
    placed.push({ x, y, bottom: low, r, side: order.side, pulse, volume: order.volume, price: order.vwap, ts: order.ts, count: order.count });
  }
  placed.sort((a, b) => a.r - b.r);
  return placed.length > MAX_DRAWN_BUBBLES ? placed.slice(placed.length - MAX_DRAWN_BUBBLES) : placed;
}

export function bubbleAt(bubbles: readonly AggressiveBubble[], x: number, y: number): AggressiveBubble | null {
  for (let i = bubbles.length - 1; i >= 0; i -= 1) {
    const bubble = bubbles[i];
    const core = Math.min(bubble.r, Math.max(HOVER_CORE_MIN_PX, bubble.r * HOVER_CORE_SHARE));
    const dx = x - bubble.x;
    const dy = y < bubble.y ? y - bubble.y : y > bubble.bottom ? y - bubble.bottom : 0;
    if (dx * dx + dy * dy <= core * core) return bubble;
  }
  return null;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string, fallback: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback);
  const value = parseInt(match![1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function shade(rgb: Rgb, amount: number): Rgb {
  const target = amount >= 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  return {
    r: Math.round(rgb.r + (target - rgb.r) * t),
    g: Math.round(rgb.g + (target - rgb.g) * t),
    b: Math.round(rgb.b + (target - rgb.b) * t),
  };
}

export function css(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(3)})`;
}

export function sphereTones(body: Rgb): { highlight: Rgb; body: Rgb; rim: Rgb } {
  const luminance = (0.2126 * body.r + 0.7152 * body.g + 0.0722 * body.b) / 255;
  const light = luminance > 0.5;
  return {
    highlight: shade(body, light ? 0.6 : 0.45),
    body,
    rim: shade(body, light ? -0.45 : -0.6),
  };
}

export interface AggressiveOrdersHost {
  readonly bubbles: readonly AggressiveBubble[];
  readonly settings: AggressiveOrdersSettings;
  readonly palette: BubblePalette;
}

export class AggressiveOrdersRenderer implements IPrimitivePaneRenderer {
  private readonly _host: AggressiveOrdersHost;

  constructor(host: AggressiveOrdersHost) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const { bubbles, settings, palette } = this._host;
    if (bubbles.length === 0) return;
    const tones = {
      buy: sphereTones(parseHex(palette.buy, "#f8f8f5")),
      sell: sphereTones(parseHex(palette.sell, "#111111")),
    };
    const alpha = Math.min(1, Math.max(0, settings.opacity));
    target.useMediaCoordinateSpace(({ context }) => {
      context.save();
      try {
        for (const bubble of bubbles) {
          const tone = tones[bubble.side];
          context.beginPath();
          if (bubble.bottom - bubble.y < 1) {
            const gradient = context.createRadialGradient(bubble.x - bubble.r * 0.35, bubble.y - bubble.r * 0.35, bubble.r * 0.05, bubble.x, bubble.y, bubble.r);
            gradient.addColorStop(0, css(tone.highlight, alpha));
            gradient.addColorStop(0.55, css(tone.body, alpha));
            gradient.addColorStop(1, css(tone.rim, alpha));
            context.arc(bubble.x, bubble.y, bubble.r, 0, Math.PI * 2);
            context.fillStyle = gradient;
          } else {
            const gradient = context.createLinearGradient(bubble.x - bubble.r, 0, bubble.x + bubble.r, 0);
            gradient.addColorStop(0, css(tone.rim, alpha));
            gradient.addColorStop(0.3, css(tone.highlight, alpha));
            gradient.addColorStop(0.6, css(tone.body, alpha));
            gradient.addColorStop(1, css(tone.rim, alpha));
            context.arc(bubble.x, bubble.y, bubble.r, Math.PI, 0);
            context.lineTo(bubble.x + bubble.r, bubble.bottom);
            context.arc(bubble.x, bubble.bottom, bubble.r, 0, Math.PI);
            context.closePath();
            context.fillStyle = gradient;
          }
          context.fill();
        }
      } finally {
        context.restore();
      }
    });
  }
}
