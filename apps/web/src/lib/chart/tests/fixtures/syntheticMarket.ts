import type { BarFrame, LiquidityFrame } from "../../../../types/frames";
import { computeKernelRender, type KernelRenderPieces } from "../../draw/kernelPrimitive";
import { handlesForOwners } from "../../draw/registry";
import { LiquidityGrid } from "../../../indicators/passive-liquidity/liquidityGrid";

export const MINUTE_MS = 60_000;
export const T0 = 1_780_000_000_000;

export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function walk(count: number, lastOpen = false): BarFrame[] {
  const random = seeded(7);
  const out: BarFrame[] = [];
  let price = 60_000;
  let drift = 0;
  for (let index = 0; index < count; index += 1) {
    if (index % 90 === 0) drift = (random() - 0.5) * 6;
    const open = price;
    const close = Math.max(1, open + drift + (random() - 0.5) * 40);
    const volume = Math.round(50 + random() * 450);
    out.push({
      type: "bar", symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL", interval_ms: MINUTE_MS,
      ts_open: T0 + index * MINUTE_MS, open, high: Math.max(open, close) + random() * 15, low: Math.min(open, close) - random() * 15,
      close, volume, buy_volume: Math.round(volume * (0.3 + random() * 0.4)), trade_count: Math.round(volume / 3),
      closed: !(lastOpen && index === count - 1),
    } as BarFrame);
    price = close;
  }
  return out;
}

export function bookFrames(bars: readonly BarFrame[]): LiquidityFrame[] {
  const random = seeded(3);
  const first = bars[Math.max(0, bars.length - 240)].ts_open;
  const columns = [];
  for (let ts = first; ts <= bars[bars.length - 1].ts_open + MINUTE_MS; ts += 10_000) {
    const mid = Math.round(bars.find((bar) => bar.ts_open + MINUTE_MS > ts)?.close ?? bars[bars.length - 1].close);
    const lo = mid - 200;
    const bid: [number, number][] = [];
    const ask: [number, number][] = [];
    for (let row = 0; row <= 400; row += 1) {
      const wall = (lo + row) % 37 === 0 ? 300 : 0;
      const size = Math.round((wall + 1 + random() * 5) * 100) / 100;
      if (lo + row < mid) bid.push([row, size]);
      else if (lo + row > mid) ask.push([row, size]);
    }
    const buy: [number, number][] = [];
    const sell: [number, number][] = [];
    for (let offset = -12; offset <= 12; offset += 3) {
      const size = Math.round((2 + random() * 12) * 100) / 100;
      (random() < 0.5 ? buy : sell).push([200 + offset, size]);
    }
    buy.sort((a, b) => a[0] - b[0]);
    sell.sort((a, b) => a[0] - b[0]);
    columns.push({ ts, lo, hi: lo + 400, bid, ask, buy, sell, prints: [], printsFloor: 1 });
  }
  const frames: LiquidityFrame[] = [];
  let seq = 0;
  for (let start = 0; start < columns.length; start += 120) {
    const chunk = columns.slice(start, start + 120);
    seq += chunk.length;
    frames.push({
      type: "liquidity", provider: "BINANCE", marketKind: "PERPETUAL", symbol: "BTC-USDT", ts: chunk[chunk.length - 1].ts, seq,
      reset: start === 0, row_width: 1, column_ms: 10_000, columns: chunk, levels: [],
    });
  }
  return frames;
}

export function book(bars: readonly BarFrame[]): LiquidityGrid {
  const grid = new LiquidityGrid();
  for (const frame of bookFrames(bars)) grid.apply(frame);
  return grid;
}

function visible(pieces: KernelRenderPieces): { boxes: unknown[]; lines: unknown[]; polylines: unknown[]; labels: unknown[] } {
  const clear = (color: string) => color === "transparent" || color === "";
  return {
    boxes: pieces.boxes.filter((box) => !(clear(box.backgroundColor) && (clear(box.borderColor) || box.borderWidth === 0) && box.text === "")),
    lines: pieces.lines.filter((line) => !clear(line.color)),
    polylines: pieces.polylines.filter((polyline) => !clear(polyline.color)),
    labels: pieces.labels.filter((label) => !(clear(label.color) && label.text === "")),
  };
}

export function drawnBy(ownerId: string): { boxes: unknown[]; lines: unknown[]; polylines: unknown[]; labels: unknown[] } {
  return visible(computeKernelRender(
    handlesForOwners([ownerId]), new Map(), new Map(),
    (time) => (time <= 0 ? null : time), (price) => price, 1e15,
  ));
}
