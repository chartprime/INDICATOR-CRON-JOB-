import type { SessionLevelHover } from "../../lib/indicators/session-levels/sessionLevelsHover";

export const SESSION_LEVEL_HIT_PX = 8;

export function sessionLevelHoversFromUnknown(value: unknown): readonly SessionLevelHover[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SessionLevelHover =>
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.title === "string" &&
      Array.isArray(entry.lines) &&
      entry.lines.every((line: unknown) => typeof line === "string") &&
      typeof entry.price === "number" &&
      Number.isFinite(entry.price) &&
      typeof entry.fromMs === "number" &&
      Number.isFinite(entry.fromMs) &&
      typeof entry.toMs === "number" &&
      Number.isFinite(entry.toMs) &&
      entry.toMs >= entry.fromMs,
  );
}

interface SessionLevelHitInput {
  crosshairTimeMs: number;
  cursorY: number;
  intervalMs: number;
  priceToCoordinate: (price: number) => number | null;
}

export function hitSessionLevelHover(
  hover: SessionLevelHover,
  input: SessionLevelHitInput,
): { distance: number; y: number } | null {
  if (input.crosshairTimeMs < hover.fromMs || input.crosshairTimeMs >= hover.toMs + input.intervalMs) return null;
  const levelY = input.priceToCoordinate(hover.price);
  if (levelY === null) return null;
  const distance = Math.abs(levelY - input.cursorY);
  return distance <= SESSION_LEVEL_HIT_PX ? { distance, y: levelY } : null;
}
