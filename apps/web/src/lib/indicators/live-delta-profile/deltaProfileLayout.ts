import type { BarFrame, DeltaProfileReason } from "../../../types/frames";
import type { DeltaProfilePiece, DeltaProfileRow } from "./deltaProfileStore";

const SUBUNITS = 100_000_000;
export const HOLE_SHARE = 0.5;

export interface MergedRow {
  index: number;
  price: number;
  priceTo: number;
  buy: number;
  sell: number;
}

export interface DeltaBar extends MergedRow {
  yTop: number;
  yBottom: number;
  net: number;
  share: number;
}

/** Sums the store's fine rows into rows `factor` times wider, on the same absolute grid, in the order the rows come. */
export function mergeRows(rows: readonly DeltaProfileRow[], rowWidth: number, factor: number): MergedRow[] {
  const stepSub = Math.round(rowWidth * SUBUNITS) * Math.max(1, Math.floor(factor));
  const merged = new Map<number, MergedRow>();
  for (const row of rows) {
    const index = Math.floor(Math.round(row.price * SUBUNITS) / stepSub);
    const entry = merged.get(index);
    if (entry) {
      entry.buy += row.buy;
      entry.sell += row.sell;
    } else {
      const price = Number(((index * stepSub) / SUBUNITS).toPrecision(12));
      merged.set(index, { index, price, priceTo: Number((((index + 1) * stepSub) / SUBUNITS).toPrecision(12)), buy: row.buy, sell: row.sell });
    }
  }
  return [...merged.values()];
}

/** Places the rows in view; each bar's share is its net against the biggest net in view. */
export function layoutDelta(rows: readonly MergedRow[], yOf: (price: number) => number | null, height: number): DeltaBar[] {
  const bars: DeltaBar[] = [];
  let maxAbs = 0;
  for (const row of rows) {
    const top = yOf(row.priceTo);
    const bottom = yOf(row.price);
    if (top === null || bottom === null) continue;
    const yTop = Math.min(top, bottom);
    const yBottom = Math.max(top, bottom);
    if (yBottom < 0 || yTop > height) continue;
    const net = row.buy - row.sell;
    maxAbs = Math.max(maxAbs, Math.abs(net));
    bars.push({ ...row, yTop, yBottom, net, share: 0 });
  }
  if (maxAbs > 0) for (const bar of bars) bar.share = Math.abs(bar.net) / maxAbs;
  return bars;
}

/** Pieces whose classified trade volume is far under comparable candle volume. */
export function holesIn(pieces: readonly DeltaProfilePiece[], bars: readonly BarFrame[], holeShare: number = HOLE_SHARE): DeltaProfilePiece[] {
  const holes: DeltaProfilePiece[] = [];
  for (const piece of pieces) {
    let candles = 0;
    for (const bar of bars) {
      if (bar.ts_open < piece.from || bar.ts_open >= piece.to || bar.interval_ms > piece.to - piece.from) continue;
      if (bar.provider === "DXFEED") {
        if (bar.buy_volume === undefined || bar.sell_volume === undefined) continue;
        candles += bar.buy_volume + bar.sell_volume;
      } else {
        candles += bar.volume;
      }
    }
    if (piece.volume < holeShare * candles) holes.push(piece);
  }
  return holes.sort((a, b) => a.from - b.from);
}

/** "14:00–20:00" in the viewer's clock, for the log. */
export function spanWords(from: number, to: number): string {
  const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${clock(from)}–${clock(to)}`;
}


interface LabelRow {
  yTop: number;
  yBottom: number;
  share: number;
}

export const LABEL_CHAR_EM = 0.62;
export const LABEL_PAD_PX = 8;
export const INSIDE_MARGIN_PX = 4;

/**
 * A bar's length (media px): its share of the room, but never shorter than
 * its own number without the sign (the trader's rule: 10 and up fits two
 * digits, under 10 fits one; the colour carries the side), and never longer
 * than the room. A balanced row has no bar.
 */
export function barPx(share: number, roomPx: number, text: string, fontPx: number): number {
  if (share <= 0) return 0;
  const fitsText = Math.ceil(text.replace("-", "").length * LABEL_CHAR_EM * fontPx + LABEL_PAD_PX);
  return Math.min(roomPx, Math.max(share * roomPx, fitsText));
}

/** Whether a number this wide (px) sits inside a bar this long, clear of both ends. */
export function fitsInside(barWidth: number, textWidth: number): boolean {
  return barWidth >= textWidth + INSIDE_MARGIN_PX;
}

/** The bars that get a number, biggest first: every bar with a net, unless its number would sit on one already placed. */
export function placeLabels<T extends LabelRow>(bars: readonly T[], fontPx: number): T[] {
  const placed: T[] = [];
  const taken: number[] = [];
  for (const bar of [...bars].sort((a, b) => b.share - a.share)) {
    if (bar.share === 0) continue;
    const mid = (bar.yTop + bar.yBottom) / 2;
    if (taken.some((other) => Math.abs(other - mid) < fontPx)) continue;
    placed.push(bar);
    taken.push(mid);
  }
  return placed;
}

export { HANDLE_GRAB_PX, LABEL_FONT_PX, MIN_LABEL_FONT_PX, labelFontPx, neighbourWidthAt, onBaseHandle, onReachHandle, reachShareAt, withAlpha } from "../axis-profile/axisProfileLayout";

export interface ProfileStatus {
  level: "info" | "warn";
  text: string;
}

interface StatusSource {
  issue: DeltaProfileReason | null;
  complete: boolean;
  pieces: readonly DeltaProfilePiece[];
}

/** Why the profile is not the whole story right now, for the log; null when it is. */
export function profileStatus(store: StatusSource, bars: readonly BarFrame[]): ProfileStatus | null {
  if (store.issue === "ROWS_CAPPED") return { level: "warn", text: "history refused: rows too fine for this instrument" };
  if (store.issue === "OVERLOADED") return { level: "warn", text: "history busy, retrying" };
  if (store.issue !== null) return { level: "warn", text: `history unavailable (${store.issue})` };
  if (!store.complete) return { level: "info", text: "loading history" };
  const holes = holesIn(store.pieces, bars);
  if (holes.length === 0) return null;
  return { level: "warn", text: `partial, the recording is missing ${holes.map((hole) => spanWords(hole.from, hole.to)).join(", ")}` };
}

type StatusLogger = (level: ProfileStatus["level"], message: string) => void;

const consoleLogger: StatusLogger = (level, message) => {
  if (level === "warn") console.warn(message);
  else console.info(message);
};

/** Writes the profile's status to the log once each time it changes, never to the chart. */
export class StatusLog {
  private _last: string | null = null;
  private readonly _log: StatusLogger;

  constructor(log: StatusLogger = consoleLogger) {
    this._log = log;
  }

  report(status: ProfileStatus | null): void {
    const text = status?.text ?? null;
    if (text === this._last) return;
    if (status !== null) this._log(status.level, `Live Delta Profile: ${status.text}`);
    else this._log("info", "Live Delta Profile: history complete");
    this._last = text;
  }

  reset(): void {
    this._last = null;
  }
}
