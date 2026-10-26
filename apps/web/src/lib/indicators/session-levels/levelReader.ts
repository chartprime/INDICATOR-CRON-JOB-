import type { BarFrame } from "../../../types/frames";
import type { LevelSide } from "./sessionLevelsRules";

export const EATEN_SHARE = 0.5;

export interface LevelRules {
  bandRows: number;
  floor: number;
  share: number;
}

export function wallRows(price: number, side: LevelSide, rowWidth: number, bandRows: number): [number, number] {
  const row = Math.floor(price / rowWidth);
  return side === "high" ? [row, row + bandRows - 1] : [row - bandRows + 1, row];
}

export function touches(bar: Pick<BarFrame, "high" | "low">, price: number, side: LevelSide): boolean {
  return side === "high" ? bar.high >= price : bar.low <= price;
}
