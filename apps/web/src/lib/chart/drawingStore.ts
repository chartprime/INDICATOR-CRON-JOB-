import { parseFrameIdentity, type FrameIdentity } from "../../types/frames";

export type DrawingToolId = "trendline" | "fibonacci" | "fixedRangeProfile";

export interface DrawingPoint {
  time: number;
  price: number;
}

export type TrendlineDrawing = {
  id: string;
  type: "trendline";
  points: [DrawingPoint, DrawingPoint];
} & FrameIdentity & { symbol: string };

export type FibonacciDrawing = {
  id: string;
  type: "fibonacci";
  points: [DrawingPoint, DrawingPoint];
} & FrameIdentity & { symbol: string };

export type DrawnObject = TrendlineDrawing | FibonacciDrawing;

export const DRAWINGS_STORAGE_KEY = "terminal.drawings.v1";
export const MAX_DRAWINGS_PER_INSTRUMENT = 200;

const MAX_VALID_TIME_SECONDS = 8_640_000_000_000;
const MAX_REASONABLE_PRICE = 10_000_000;
const MAX_ID_LENGTH = 128;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidTimeSeconds(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value <= MAX_VALID_TIME_SECONDS;
}

function isValidPrice(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value <= MAX_REASONABLE_PRICE;
}

function isValidPoint(value: unknown): value is DrawingPoint {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return isValidTimeSeconds(point.time) && isValidPrice(point.price);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export function instrumentKey(identity: FrameIdentity & { symbol: string }): string {
  const marketPart = identity.provider === "BINANCE" ? identity.marketKind : identity.assetClass;
  return `${identity.provider}:${marketPart}:${identity.symbol}`;
}

function parseDrawnObject(raw: unknown): DrawnObject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.type !== "trendline" && record.type !== "fibonacci") return null;
  if (!isNonEmptyString(record.id)) return null;
  if (!Array.isArray(record.points) || record.points.length !== 2) return null;
  const [a, b] = record.points;
  if (!isValidPoint(a) || !isValidPoint(b)) return null;
  const identity = parseFrameIdentity(record);
  if (!identity) return null;
  return { id: record.id, type: record.type, points: [a, b], ...identity, symbol: record.symbol as string };
}

export function loadDrawings(): DrawnObject[] {
  try {
    const raw = localStorage.getItem(DRAWINGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: DrawnObject[] = [];
    const perInstrumentCount = new Map<string, number>();
    for (const entry of parsed) {
      const drawing = parseDrawnObject(entry);
      if (!drawing) continue;
      const key = instrumentKey(drawing);
      const count = perInstrumentCount.get(key) ?? 0;
      if (count >= MAX_DRAWINGS_PER_INSTRUMENT) continue;
      perInstrumentCount.set(key, count + 1);
      valid.push(drawing);
    }
    return valid;
  } catch {
    return [];
  }
}

export function saveDrawings(drawings: readonly DrawnObject[]): void {
  try {
    localStorage.setItem(DRAWINGS_STORAGE_KEY, JSON.stringify(drawings));
  } catch {
  }
}

export function drawingsForInstrument(
  all: readonly DrawnObject[],
  identity: FrameIdentity & { symbol: string },
): DrawnObject[] {
  const key = instrumentKey(identity);
  return all.filter((drawing) => instrumentKey(drawing) === key);
}

export function addDrawing(
  all: readonly DrawnObject[],
  drawing: DrawnObject,
): { drawings: DrawnObject[]; added: boolean } {
  const key = instrumentKey(drawing);
  const countForInstrument = all.reduce((count, existing) => count + (instrumentKey(existing) === key ? 1 : 0), 0);
  if (countForInstrument >= MAX_DRAWINGS_PER_INSTRUMENT) {
    return { drawings: [...all], added: false };
  }
  return { drawings: [...all, drawing], added: true };
}

export function removeDrawing(all: readonly DrawnObject[], id: string): DrawnObject[] {
  return all.filter((drawing) => drawing.id !== id);
}

export function createDrawingId(): string {
  return crypto.randomUUID();
}
