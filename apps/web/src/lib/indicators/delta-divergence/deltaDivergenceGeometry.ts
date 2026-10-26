import type { Divergence, DivergenceType } from "./deltaDivergence";

export const DIVERGENCE_LINE_WIDTH_PX = 1.6;
const BULLISH_LINE_COLOR = "#16a34a";
const BEARISH_LINE_COLOR = "#dc2626";
const BULLISH_FILL_COLOR = "rgba(22, 163, 74, 0.10)";
const BEARISH_FILL_COLOR = "rgba(220, 38, 38, 0.10)";

export interface DivergenceLinePalette {
  bullish: string;
  bearish: string;
}

export type DivergenceValueKind = "price" | "cvd";

export interface DivergenceRenderLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

export interface DivergenceRenderBand {
  x1: number;
  x2: number;
  color: string;
}

export function divergenceLineColor(
  type: DivergenceType,
  palette?: DivergenceLinePalette,
): string {
  if (palette) return type === "bullish" ? palette.bullish : palette.bearish;
  return type === "bullish" ? BULLISH_LINE_COLOR : BEARISH_LINE_COLOR;
}

export function divergenceFillColor(type: DivergenceType): string {
  return type === "bullish" ? BULLISH_FILL_COLOR : BEARISH_FILL_COLOR;
}

export function isDivergenceVisible(
  divergence: Divergence,
  visibleFromSec: number,
  visibleToSec: number,
): boolean {
  return (
    divergence.priceTo.ts_open / 1000 >= visibleFromSec &&
    divergence.priceFrom.ts_open / 1000 <= visibleToSec
  );
}

function divergenceValue(
  divergence: Divergence,
  point: "from" | "to",
  valueKind: DivergenceValueKind,
): number {
  if (valueKind === "price")
    return point === "from"
      ? divergence.priceFrom.price
      : divergence.priceTo.price;
  return point === "from" ? divergence.cvdFrom.value : divergence.cvdTo.value;
}

function divergenceTimestamp(
  divergence: Divergence,
  point: "from" | "to",
  valueKind: DivergenceValueKind,
): number {
  if (valueKind === "price")
    return point === "from"
      ? divergence.priceFrom.ts_open
      : divergence.priceTo.ts_open;
  return point === "from"
    ? divergence.cvdFrom.ts_open
    : divergence.cvdTo.ts_open;
}

export function buildDivergenceRenderLines(
  divergences: readonly Divergence[],
  valueKind: DivergenceValueKind,
  timeToCoordinate: (tsMs: number) => number | null,
  valueToCoordinate: (value: number) => number | null,
  palette?: DivergenceLinePalette,
): DivergenceRenderLine[] {
  const lines: DivergenceRenderLine[] = [];
  for (const divergence of divergences) {
    const x1 = timeToCoordinate(
      divergenceTimestamp(divergence, "from", valueKind),
    );
    const x2 = timeToCoordinate(
      divergenceTimestamp(divergence, "to", valueKind),
    );
    const y1 = valueToCoordinate(
      divergenceValue(divergence, "from", valueKind),
    );
    const y2 = valueToCoordinate(divergenceValue(divergence, "to", valueKind));
    if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
    lines.push({
      x1,
      y1,
      x2,
      y2,
      color: divergenceLineColor(divergence.type, palette),
    });
  }
  return lines;
}

export function buildDivergenceRenderBands(
  divergences: readonly Divergence[],
  timeToCoordinate: (tsMs: number) => number | null,
): DivergenceRenderBand[] {
  const bands: DivergenceRenderBand[] = [];
  for (const divergence of divergences) {
    const x1 = timeToCoordinate(divergence.priceFrom.ts_open);
    const x2 = timeToCoordinate(divergence.priceTo.ts_open);
    if (x1 === null || x2 === null) continue;
    bands.push({ x1, x2, color: divergenceFillColor(divergence.type) });
  }
  return bands;
}
