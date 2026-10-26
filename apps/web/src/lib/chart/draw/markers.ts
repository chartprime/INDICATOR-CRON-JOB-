import type { SeriesMarker, Time } from "lightweight-charts";

export type MarkerShapeKind = "circle" | "square" | "arrowUp" | "arrowDown";
export type MarkerPositionKind =
  | "aboveBar"
  | "belowBar"
  | "inBar"
  | "atPriceTop"
  | "atPriceBottom"
  | "atPriceMiddle";

export interface PlotShapeOptions {
  shape: MarkerShapeKind;
  time?: number;
  position?: MarkerPositionKind;
  color?: string;
  text?: string;
  size?: number;
  price?: number;
}

// The library's real marker vocabulary has no arbitrary-glyph shape -- a
// plotchar's character is carried in `text` (a real, rendered field) against
// a neutral default marker rather than pretending an unsupported glyph icon
// exists.
export interface PlotCharOptions {
  char: string;
  time?: number;
  position?: MarkerPositionKind;
  color?: string;
  size?: number;
  price?: number;
}

export interface MarkerCall {
  time: number;
  shape: MarkerShapeKind;
  position: MarkerPositionKind;
  color: string;
  text?: string;
  size?: number;
  price?: number;
}

export const DEFAULT_MARKER_COLOR = "#787b86";
export const DEFAULT_MARKER_POSITION: MarkerPositionKind = "aboveBar";
const PRICE_ANCHORED_POSITIONS: readonly MarkerPositionKind[] = [
  "atPriceTop",
  "atPriceBottom",
  "atPriceMiddle",
];

export function plotShapeCall(
  time: number,
  options: PlotShapeOptions,
): MarkerCall {
  return {
    time: options.time ?? time,
    shape: options.shape,
    position: options.position ?? DEFAULT_MARKER_POSITION,
    color: options.color ?? DEFAULT_MARKER_COLOR,
    text: options.text,
    size: options.size,
    price: options.price,
  };
}

export function plotCharCall(
  time: number,
  options: PlotCharOptions,
): MarkerCall {
  return {
    time: options.time ?? time,
    shape: "circle",
    position: options.position ?? DEFAULT_MARKER_POSITION,
    color: options.color ?? DEFAULT_MARKER_COLOR,
    text: options.char,
    size: options.size,
    price: options.price,
  };
}

export function buildSeriesMarker(call: MarkerCall): SeriesMarker<Time> {
  const time = (call.time / 1000) as Time;
  if (PRICE_ANCHORED_POSITIONS.includes(call.position)) {
    return {
      time,
      position: call.position as
        | "atPriceTop"
        | "atPriceBottom"
        | "atPriceMiddle",
      shape: call.shape,
      color: call.color,
      text: call.text,
      size: call.size,
      price: call.price ?? 0,
    };
  }
  return {
    time,
    position: call.position as "aboveBar" | "belowBar" | "inBar",
    shape: call.shape,
    color: call.color,
    text: call.text,
    size: call.size,
  };
}

export function pushMarkerCalls(
  buffer: MarkerCall[],
  newCalls: readonly MarkerCall[],
): void {
  buffer.push(...newCalls);
}

/**
 * Drops every previously-buffered call whose time equals the current bar,
 * then appends the freshly-produced calls for that same bar -- a
 * `replace:true` re-execution of one still-open bar's onBar must not
 * accumulate duplicate markers alongside the ones from its earlier pass.
 */
export function overwriteBarMarkerCalls(
  buffer: MarkerCall[],
  barTime: number,
  newCalls: readonly MarkerCall[],
): void {
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    if (buffer[index].time === barTime) buffer.splice(index, 1);
  }
  buffer.push(...newCalls);
}

export function resetMarkerCalls(buffer: MarkerCall[]): void {
  buffer.length = 0;
}

export interface SeriesMarkersPlugin {
  setMarkers(markers: SeriesMarker<Time>[]): void;
  detach?: () => void;
}

export type SeriesMarkersFactory = (series: unknown) => SeriesMarkersPlugin;

/**
 * The only thing that ever calls the real createSeriesMarkers() plugin's own
 * setMarkers() -- one call per bar-transition flush, never one per buffered
 * plotshape/plotchar call, matching whale markers' own applyMarkerSnapshot
 * discipline.
 */
export class MarkerSeriesController {
  private readonly _createSeriesMarkers: SeriesMarkersFactory;
  private _plugin: SeriesMarkersPlugin | null = null;

  constructor(createSeriesMarkers: SeriesMarkersFactory) {
    this._createSeriesMarkers = createSeriesMarkers;
  }

  attach(series: unknown): void {
    this._plugin = this._createSeriesMarkers(series);
  }

  detach(): void {
    this._plugin?.detach?.();
    this._plugin = null;
  }

  setMarkers(calls: readonly MarkerCall[]): void {
    // The real plugin requires ascending time order, the same constraint
    // series.setData() has -- calls arriving here are per-owner chronological
    // but this controller can be shared by multiple owners on one pane, so
    // the merged array is not guaranteed sorted without this.
    const sorted = [...calls].sort((a, b) => a.time - b.time);
    this._plugin?.setMarkers(sorted.map(buildSeriesMarker));
  }
}
