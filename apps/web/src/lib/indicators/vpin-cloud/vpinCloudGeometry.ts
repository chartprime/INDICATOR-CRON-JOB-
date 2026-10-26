import type { IChartApiBase, ISeriesApi, SeriesType, Time } from "lightweight-charts";
import type { BarFrame, VpinReading } from "../../../types/frames";

export type VpinCloudPoint = {
  x: number;
  lowY: number;
  highY: number;
  buyStr: number;
  sellStr: number;
};

export const CLOUD_LAYERS: readonly [number, number][] = [
  [1.00, 0.10],
  [0.70, 0.19],
  [0.42, 0.32],
  [0.18, 0.52],
];

export const CLOUD_BUY_RGB = "16,220,128";
export const CLOUD_SELL_RGB = "255,64,64";

const GAP_PX = 4;

export const STALENESS_CADENCE_MULTIPLE = 4;

function medianSealIntervalMs(readings: readonly VpinReading[]): number | null {
  if (readings.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < readings.length; i += 1) {
    const gap = readings[i].seal_ts - readings[i - 1].seal_ts;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

export type VpinCloudRow = {
  time: Time;
  low: number;
  high: number;
  buyStr: number;
  sellStr: number;
};

export function mapReadingsToBars(readings: readonly VpinReading[], bars: readonly BarFrame[]): VpinCloudRow[] {
  if (readings.length === 0 || bars.length === 0) return [];
  const rows: VpinCloudRow[] = [];
  const cadenceMs = medianSealIntervalMs(readings);
  const maxStalenessMs = cadenceMs === null ? null : cadenceMs * STALENESS_CADENCE_MULTIPLE;
  let readingIndex = -1;
  for (const bar of bars) {
    const barCloseTs = bar.ts_open + bar.interval_ms;
    while (readingIndex + 1 < readings.length && readings[readingIndex + 1].seal_ts <= barCloseTs) {
      readingIndex += 1;
    }
    if (readingIndex < 0) continue;
    const reading = readings[readingIndex];
    if (maxStalenessMs !== null && barCloseTs - reading.seal_ts > maxStalenessMs) continue;
    const buyStr = reading.active && reading.direction === "buy" ? reading.strength : 0;
    const sellStr = reading.active && reading.direction === "sell" ? reading.strength : 0;
    if (buyStr === 0 && sellStr === 0) continue;
    rows.push({ time: (bar.ts_open / 1000) as Time, low: bar.low, high: bar.high, buyStr, sellStr });
  }
  return rows;
}

export function buildCloudPoints(
  chart: IChartApiBase<Time>,
  series: ISeriesApi<SeriesType, Time>,
  chartWidth: number,
  rows: readonly VpinCloudRow[],
): VpinCloudPoint[] {
  const timeScale = chart.timeScale();
  const out: VpinCloudPoint[] = [];
  for (const row of rows) {
    if (row.buyStr === 0 && row.sellStr === 0) continue;
    const x = timeScale.timeToCoordinate(row.time);
    if (x === null || !Number.isFinite(x) || x < -100 || x > chartWidth + 100) continue;
    const lowY = series.priceToCoordinate(row.low);
    const highY = series.priceToCoordinate(row.high);
    if (lowY === null || highY === null || !Number.isFinite(lowY) || !Number.isFinite(highY)) continue;
    out.push({ x, lowY, highY, buyStr: row.buyStr, sellStr: row.sellStr });
  }
  return out;
}

export function splitCloudRuns(points: readonly VpinCloudPoint[], maxGap: number): VpinCloudPoint[][] {
  if (points.length === 0) return [];
  const runs: VpinCloudPoint[][] = [];
  let current: VpinCloudPoint[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].x - points[i - 1].x > maxGap) {
      runs.push(current);
      current = [points[i]];
    } else {
      current.push(points[i]);
    }
  }
  runs.push(current);
  return runs;
}

export function estimateBarDx(points: readonly { x: number }[], fallback = 6): number {
  let barDx = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const d = points[i].x - points[i - 1].x;
    if (d > 0.5 && d < barDx) barDx = d;
  }
  return Number.isFinite(barDx) ? barDx : fallback;
}

function anchorY(point: VpinCloudPoint, isBuy: boolean): number {
  return isBuy ? point.lowY + GAP_PX : point.highY - GAP_PX;
}

function edgeY(point: VpinCloudPoint, maxHeightPx: number, heightFrac: number, isBuy: boolean): number {
  const strength = isBuy ? point.buyStr : point.sellStr;
  const anchor = anchorY(point, isBuy);
  return isBuy ? anchor + strength * maxHeightPx * heightFrac : anchor - strength * maxHeightPx * heightFrac;
}

export type PolygonPoint = { x: number; y: number };

export function buildCloudPolygon(
  points: readonly VpinCloudPoint[],
  maxHeightPx: number,
  heightFrac: number,
  isBuy: boolean,
): PolygonPoint[] {
  if (points.length < 2) return [];
  const forward = points.map((p) => ({ x: p.x, y: anchorY(p, isBuy) }));
  const reverse = [...points].reverse().map((p) => ({ x: p.x, y: edgeY(p, maxHeightPx, heightFrac, isBuy) }));
  return [...forward, ...reverse];
}
