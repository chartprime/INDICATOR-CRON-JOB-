import { draw } from "../../chart/draw";
import type { BoxHandle } from "../../chart/draw/box";
import type { TableHandle } from "../../chart/draw/table";
import type { IndicatorBarCtx, LineOutputSpec, RuntimeIndicatorDef, SettingsFieldSchema } from "../../chart/indicatorTypes";
import {
  MAX_HELD_RANGES,
  RANGE_LIFETIME,
  createCompressionBreakoutEngine,
  type CompressionBreakoutEngine,
  type HeldRange,
  type Reading,
} from "./compressionBreakoutMath";

/**
 * Compression Breakout (20): a committed 20-bar high/low range that is
 * narrower than twice the mean true range of the 20 bars before it, drawn as
 * a neutral purple box with frozen edges; a break is a close outside it after
 * six bars inside, graded by the break bar's true range and volume against the
 * preceding 20 bars (arrow solid when both pass, faded when one does); a close
 * back inside within five bars is a failed break (circle); otherwise the break
 * is "held outside 5 bars". Trend (MA 50/200) colours the border and one table
 * row only. Candle-only, `OHLCV_POLICY`.
 */

export interface CompressionBreakoutSettings {
  rangeLength: number;
  minCompressionBars: number;
  confirmMultiple: number;
  widthMultiple: number;
  failBars: number;
  holdBars: number;
  trendFast: number;
  trendSlow: number;
  showMarkers: boolean;
  showRanges: boolean;
}

export const COMPRESSION_BREAKOUT_DEFAULT_SETTINGS: CompressionBreakoutSettings = Object.freeze({
  rangeLength: 20,
  minCompressionBars: 6,
  confirmMultiple: 1.5,
  widthMultiple: 2,
  failBars: 5,
  holdBars: 40,
  trendFast: 50,
  trendSlow: 200,
  showMarkers: true,
  showRanges: true,
});

/** Fixed for this version: a colour picker would force a replay over the retained bars. */
export const CB_RANGE_COLOR = "#8672b3";
export const CB_BULL_COLOR = "#26a69a";
export const CB_BEAR_COLOR = "#ef5350";
export const CB_WARN_COLOR = "#b07a1e";
export const CB_TABLE_TEXT_COLOR = "#d1d4dc";
export const CB_UNAVAILABLE = "—";
export const CB_PROVISIONAL_ALPHA = 0.5;
export const CB_FILL_ESTABLISHED_ALPHA = 0.12;
export const CB_FILL_FORMING_ALPHA = 0.06;
export const CB_FILL_HELD_ALPHA = 0.06;
export const CB_BOX_POOL = 1 + MAX_HELD_RANGES;
export const CB_TABLE_MAX_CHARS = 30;
const TRANSPARENT = "rgba(0,0,0,0)";

export interface CompressionBreakoutState {
  engine: CompressionBreakoutEngine;
  table: TableHandle;
  /** Handle 0 is the active range; 1..7 the held ranges, oldest first. */
  boxes: BoxHandle[];
  reading: Reading | null;
}

/** `#rgb` or `#rrggbb` with an alpha; any other colour string is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex === null) return color;
  let digits = hex[1];
  if (digits.length === 3) digits = digits.split("").map((d) => d + d).join("");
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function trendColor(trend: -1 | 0 | 1 | null): string {
  if (trend === 1) return CB_BULL_COLOR;
  if (trend === -1) return CB_BEAR_COLOR;
  return CB_RANGE_COLOR;
}

/** Decimal places a price carries, from its shortest round-trip text; at most eight. */
export function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(value);
  const exponent = text.indexOf("e");
  if (exponent !== -1) return Math.min(8, Math.max(0, -Number.parseInt(text.slice(exponent + 1), 10)));
  const point = text.indexOf(".");
  return point === -1 ? 0 : Math.min(8, text.length - point - 1);
}

function formatAt(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/** Six significant digits with trailing zeros removed, for a row that would not fit. */
function formatSignificant(value: number): string {
  const text = Number(value.toPrecision(6)).toString();
  return text.includes("e") ? value.toPrecision(6) : text;
}

/**
 * `Range hi–lo` at the instrument's precision with no thousands separators; if
 * the row would exceed 30 characters, both edges round to six significant
 * digits (brief ruling 8).
 */
export function rangeRowText(hi: number, lo: number): string {
  const decimals = Math.max(decimalsOf(hi), decimalsOf(lo));
  const exact = `Range ${formatAt(hi, decimals)}–${formatAt(lo, decimals)}`;
  if (exact.length <= CB_TABLE_MAX_CHARS) return exact;
  return `Range ${formatSignificant(hi)}–${formatSignificant(lo)}`;
}

function arrow(dir: number): string {
  return dir > 0 ? "↑" : "↓";
}

/** The test-basis wording of a break: what passed, and what could not be tested. */
export function breakBasisText(grade: number, basis: number): string {
  const rangeTestable = (basis & 1) === 1;
  const volumeTestable = (basis & 2) === 2;
  const rangePassed = grade === 1 || grade === 3;
  const volumePassed = grade === 2 || grade === 3;
  if (rangeTestable && volumeTestable) {
    if (rangePassed && volumePassed) return "range+vol";
    if (rangePassed) return "range only";
    if (volumePassed) return "vol only";
    return "unconfirmed";
  }
  if (rangeTestable) return rangePassed ? "range · vol n/a" : "vol n/a";
  if (volumeTestable) return volumePassed ? "vol · range n/a" : "range n/a";
  return "no baseline";
}

function timeText(tsOpen: number, intervalMs: number): string {
  const date = new Date(tsOpen);
  if (intervalMs >= 86_400_000) return `${date.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]}`;
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export interface TableRow {
  text: string;
  color: string;
}

/** Row 3 of the table: the state, first match wins (brief rule 12 and amendments 1, 5 and 7). */
export function stateText(reading: Reading, settings: CompressionBreakoutSettings): string {
  const d = reading.decision;
  if (d.kind === "invalidPrice") return "No usable price";
  if (reading.gap) return "Gap · range reset";
  if (d.kind === "failed") return "Failed break";
  if (d.kind === "heldOutside") return `Held outside · ${settings.failBars} bars`;
  if (d.kind === "expired") return `Range expired · ${RANGE_LIFETIME} bars`;
  if (d.kind === "break") return `Break ${arrow(d.dir)} · ${breakBasisText(d.grade, d.basis)}`;
  const active = reading.active;
  if (d.kind === "pending") return `Pending · ${Math.min(settings.failBars, reading.pendingBars)} of ${settings.failBars} bars`;
  if (active !== null) {
    if (active.age >= settings.minCompressionBars) {
      const ratio = active.widthRatio === null ? "" : ` · ${active.widthRatio.toFixed(1)}×`;
      return `Range · ${active.age} bars${ratio}`;
    }
    return `Range forming · ${active.age} of ${settings.minCompressionBars}`;
  }
  return "No range";
}

export function trendText(reading: Reading, settings: CompressionBreakoutSettings): string {
  const pair = `MA ${settings.trendFast}/${settings.trendSlow}`;
  if (reading.trendStatus === "fastGeSlow") return "Trend · fast ≥ slow";
  if (reading.trendStatus === "warming") return `Trend · warming ${reading.closesCount}/${settings.trendSlow + 5}`;
  if (reading.trend === 1) return `Trend ↑ · ${pair}`;
  if (reading.trend === -1) return `Trend ↓ · ${pair}`;
  return `Trend flat · ${pair}`;
}

export function lastEventText(reading: Reading): string {
  const event = reading.lastEvent;
  if (event === null) return CB_UNAVAILABLE;
  const when = timeText(event.tsOpen, reading.intervalMs);
  switch (event.kind) {
    case "break":
      return `Last · ${arrow(event.dir)} ${when} · ${breakBasisText(event.grade, event.basis)}`;
    case "failed":
      return `Last · failed ${arrow(event.dir)} ${when}`;
    case "heldOutside":
      return `Last · held ${arrow(event.dir)} ${when}`;
    default:
      return `Last · expired ${when}`;
  }
}

/** The four rows; during warm-up only the first row carries text (UX standard 2.6, amendment 7). */
export function tableRows(reading: Reading | null, settings: CompressionBreakoutSettings): TableRow[] {
  const neutral = CB_TABLE_TEXT_COLOR;
  if (reading === null) return [{ text: `Warming up · 0 of ${2 * settings.rangeLength} bars`, color: neutral }, { text: "", color: neutral }, { text: "", color: neutral }, { text: "", color: neutral }];
  if (!reading.rangeReady) {
    return [
      { text: `Warming up · ${reading.warmupCount} of ${reading.warmupNeeded} bars`, color: neutral },
      { text: "", color: neutral },
      { text: "", color: neutral },
      { text: "", color: neutral },
    ];
  }
  const provisional = !reading.confirmed;
  const colorOf = (base: string): string => (provisional ? withAlpha(base, CB_PROVISIONAL_ALPHA) : base);
  const row1 = reading.active !== null ? rangeRowText(reading.active.hi, reading.active.lo) : "No range";
  const d = reading.decision;
  const stateColor =
    d.kind === "break" ? (d.dir > 0 ? CB_BULL_COLOR : CB_BEAR_COLOR) : d.kind === "failed" ? CB_WARN_COLOR : neutral;
  return [
    { text: row1, color: colorOf(neutral) },
    { text: trendText(reading, settings), color: colorOf(trendColor(reading.trend)) },
    { text: stateText(reading, settings), color: colorOf(stateColor) },
    { text: lastEventText(reading), color: colorOf(neutral) },
  ];
}

function hideBox(box: BoxHandle): void {
  box.setBackgroundColor(TRANSPARENT);
  box.setBorderColor(TRANSPARENT);
}

function drawActive(box: BoxHandle, reading: Reading, settings: CompressionBreakoutSettings): void {
  const active = reading.active;
  if (active === null) {
    hideBox(box);
    return;
  }
  const established = active.age >= settings.minCompressionBars;
  const alpha = (established ? CB_FILL_ESTABLISHED_ALPHA : CB_FILL_FORMING_ALPHA) * (reading.confirmed ? 1 : CB_PROVISIONAL_ALPHA);
  box.setLeftTop(active.openedTs, active.hi);
  box.setRightBottom(reading.tsOpen, active.lo);
  box.setBackgroundColor(withAlpha(CB_RANGE_COLOR, alpha));
  box.setBorderColor(established ? trendColor(reading.trend) : TRANSPARENT);
  box.setBorderWidth(1);
}

function drawHeld(box: BoxHandle, held: HeldRange | undefined, tsOpen: number): void {
  // A range retired on this very bar is still shown through the active snapshot; it joins the held drawing from the next bar.
  if (held === undefined || held.closedTs >= tsOpen) {
    hideBox(box);
    return;
  }
  box.setLeftTop(held.openedTs, held.hi);
  box.setRightBottom(held.closedTs, held.lo);
  box.setBackgroundColor(withAlpha(CB_RANGE_COLOR, CB_FILL_HELD_ALPHA));
  box.setBorderColor(held.outcome === "failed" ? CB_WARN_COLOR : CB_RANGE_COLOR);
  box.setBorderWidth(1);
}

function plotMarkers(ctx: IndicatorBarCtx<CompressionBreakoutState, CompressionBreakoutSettings>, reading: Reading): void {
  const d = reading.decision;
  if (d.kind === "break" && d.grade >= 1) {
    const base = d.dir > 0 ? CB_BULL_COLOR : CB_BEAR_COLOR;
    const alpha = (d.grade === 3 ? 1 : CB_PROVISIONAL_ALPHA) * (reading.confirmed ? 1 : CB_PROVISIONAL_ALPHA);
    ctx.markers.plotshape({
      shape: d.dir > 0 ? "arrowUp" : "arrowDown",
      position: d.dir > 0 ? "belowBar" : "aboveBar",
      color: alpha === 1 ? base : withAlpha(base, alpha),
      size: 1,
    });
  } else if (d.kind === "failed" && d.grade >= 1) {
    ctx.markers.plotshape({
      shape: "circle",
      position: "inBar",
      color: reading.confirmed ? CB_WARN_COLOR : withAlpha(CB_WARN_COLOR, CB_PROVISIONAL_ALPHA),
      size: 1,
    });
  }
}

const LINES: readonly LineOutputSpec<CompressionBreakoutState>[] = [
  { key: "rangeHigh", lineWidth: 1, color: () => CB_RANGE_COLOR },
  { key: "rangeLow", lineWidth: 1, color: () => CB_RANGE_COLOR },
];

const SCHEMA: readonly SettingsFieldSchema<CompressionBreakoutSettings>[] = [
  { kind: "numeric", key: "rangeLength", label: "Range length (bars)", min: 10, max: 50, step: 1, affects: "recompute" },
  { kind: "staticHint", text: "The range needs twice this many bars before it can qualify. Replays every bar." },
  { kind: "numeric", key: "minCompressionBars", label: "Minimum compression (bars)", min: 2, max: 30, step: 1, affects: "recompute" },
  { kind: "numeric", key: "confirmMultiple", label: "Activity threshold (×)", min: 1, max: 3, step: 0.1, affects: "recompute" },
  { kind: "staticHint", text: "Break-bar range and volume against the last 20 bars: one passing draws a faded arrow, both a solid one." },
  { kind: "numeric", key: "widthMultiple", label: "Width limit (× bar range)", min: 1, max: 4, step: 0.5, affects: "recompute", tab: "advanced" },
  { kind: "numeric", key: "failBars", label: "Failure window (bars)", min: 1, max: 20, step: 1, affects: "recompute", tab: "advanced" },
  { kind: "numeric", key: "holdBars", label: "Keep retired range (bars)", min: 0, max: 200, step: 1, affects: "recompute", tab: "advanced" },
  { kind: "numeric", key: "trendFast", label: "Trend fast MA (bars)", min: 10, max: 199, step: 1, affects: "recompute", tab: "advanced" },
  { kind: "numeric", key: "trendSlow", label: "Trend slow MA (bars)", min: 20, max: 400, step: 1, affects: "recompute", tab: "advanced" },
  { kind: "boolean", key: "showMarkers", label: "Show break markers", affects: "recompute", tab: "visibility" },
  { kind: "boolean", key: "showRanges", label: "Show ranges", affects: "recompute", tab: "visibility" },
];

export const compressionBreakoutIndicator: RuntimeIndicatorDef<CompressionBreakoutState, CompressionBreakoutSettings> = {
  kind: "runtime",
  id: "compressionBreakout",
  label: "Compression Breakout (20)",
  category: "technical",
  defaultSettings: COMPRESSION_BREAKOUT_DEFAULT_SETTINGS,
  settingsSchema: SCHEMA,
  lines: LINES,
  placement: { kind: "overlay" },
  maxReplayBars: 10_080,
  createState: (settings) => ({
    engine: createCompressionBreakoutEngine(settings),
    table: draw.table(),
    boxes: Array.from({ length: CB_BOX_POOL }, () =>
      draw.box({ time1: 0, price1: 0, time2: 0, price2: 0, borderColor: TRANSPARENT, backgroundColor: TRANSPARENT, borderWidth: 1 }),
    ),
    reading: null,
  }),
  onBar: (ctx) => {
    const { bar, state, settings } = ctx;
    const reading = state.engine.onBar(bar);
    state.reading = reading;
    if (settings.showMarkers) plotMarkers(ctx, reading);
    if (ctx.drawNow === false) return;
    if (settings.showRanges) {
      drawActive(state.boxes[0], reading, settings);
      for (let slot = 0; slot < MAX_HELD_RANGES; slot += 1) drawHeld(state.boxes[slot + 1], reading.held[slot], reading.tsOpen);
    } else {
      for (const box of state.boxes) hideBox(box);
    }
    const rows = tableRows(reading, settings);
    for (let row = 0; row < rows.length; row += 1) state.table.cell(row, 0, { text: rows[row].text, textColor: rows[row].color });
  },
  readOutput: (state) => {
    const reading = state.reading;
    if (reading === null) {
      return { rangeHigh: null, rangeLow: null, widthRatio: null, qualified: null, trend: null, rangeAge: null, pending: 0, breakDir: 0, breakGrade: 0, gradeBasis: 0, failed: 0, heldOutside: 0, expired: 0 };
    }
    const d = reading.decision;
    const isBreak = d.kind === "break";
    return {
      rangeHigh: reading.rangeHigh,
      rangeLow: reading.rangeLow,
      widthRatio: reading.widthRatio,
      qualified: reading.qualified === null ? null : reading.qualified ? 1 : 0,
      trend: reading.trend,
      rangeAge: reading.rangeAge,
      pending: reading.pending,
      breakDir: isBreak ? d.dir : 0,
      breakGrade: isBreak ? d.grade : 0,
      gradeBasis: isBreak ? d.basis : 0,
      failed: d.kind === "failed" ? 1 : 0,
      heldOutside: d.kind === "heldOutside" ? 1 : 0,
      expired: d.kind === "expired" ? 1 : 0,
    };
  },
};
