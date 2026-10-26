import type { BarFrame } from "../../../types/frames";
import type {
  DrawNamespace,
  IndicatorBarCtx,
  LineOutputSpec,
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import { draw } from "../../chart/draw";
import type { LabelHandle } from "../../chart/draw/label";
import { withOpacity } from "../volume-profile/profilePeriodGeometry";
import { formatLabelPrice } from "../volume-profile/profileLevelLabels";

/**
 * Session VWAP (P4.14) -- the volume-weighted average price of the volume traded
 * since the current session opened, with volume-weighted deviation bands, drawn
 * as one line segment per session window. It describes where volume has traded;
 * it is not a signal, an entry level or a forecast.
 *
 * Sessions are the same UTC-aligned fixed windows Session Delta Profile uses
 * (`floor(ts_open / sessionPeriodMs) * sessionPeriodMs`, ChartPanel.tsx's
 * `applySessionDeltaProfileVisibility`) over the same session-length list, so a
 * VWAP segment lines up with the session profile zone drawn beside it.
 *
 * One source only: each bar contributes its own traded volume at its typical
 * price `(high + low + close) / 3`. That volume is the venue's own -- exact, in
 * every mode, on every instrument, on every timeframe, with no tick or
 * order-book dependency -- and only the price inside the bar is an estimate. The
 * deviation bands therefore read narrow, because a candle cannot show the
 * dispersion inside itself; a tick-derived source would price the volume where
 * it actually printed, and this indicator deliberately does not carry one.
 *
 * **Two anchors**, the same choice VWAP Bands offers: the current session window
 * (the default), or a window anchored a fixed number of bars back from the newest
 * bar. This file owns that choice -- the options, the bounds, the settings fields
 * and `lookbackWindowBegins` -- so both indicators mean the same thing by
 * "lookback". A lookback window is anchored, not rolling: it starts
 * `lookbackBars` back from the newest bar of the series being fed, then develops
 * from there to the newest bar, and never drops its oldest bar.
 *
 * A `REPLACED_EDGE` re-delivers the developing bar with its updated numbers, so
 * the bar's earlier contribution is taken back out before the new one is
 * measured. A session keeps its own sums, so a bar belongs to exactly one
 * segment and volume from before the session opened can never leak into it.
 *
 * The bar that walks up to a session's end is painted fully transparent, so the
 * segment that would otherwise join one session's average to the next's steep
 * move never appears. That bar is the one to hide because lightweight-charts
 * paints each segment with the colour of the point it *starts* from
 * (`PaneRendererLine._internal__strokeStyle` + `walkLine`'s `changeStyle`, which
 * runs after the segment is stroked): a transparent point after the join would
 * hide the wrong segment. Every value is still plotted -- only the colour of that
 * one bar changes -- and a session therefore starts on its own first bar rather
 * than one bar late.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Session lengths offered, matching Session Delta Profile's own list. */
export const SESSION_VWAP_SESSION_OPTIONS: readonly {
  readonly value: number;
  readonly label: string;
}[] = [
  { value: HOUR_MS, label: "1 Hour" },
  { value: 2 * HOUR_MS, label: "2 Hours" },
  { value: 3 * HOUR_MS, label: "3 Hours" },
  { value: 4 * HOUR_MS, label: "4 Hours" },
  { value: 6 * HOUR_MS, label: "6 Hours" },
  { value: 12 * HOUR_MS, label: "12 Hours" },
  { value: 24 * HOUR_MS, label: "1 Day" },
  { value: 2 * 24 * HOUR_MS, label: "2 Days" },
  { value: 3 * 24 * HOUR_MS, label: "3 Days" },
  { value: 7 * 24 * HOUR_MS, label: "1 Week" },
];

export const SESSION_VWAP_DEFAULT_SESSION_MS = 4 * HOUR_MS;
export const SESSION_VWAP_DEFAULT_BAND1_SIGMA = 1;
export const SESSION_VWAP_DEFAULT_BAND2_SIGMA = 2;
export const SESSION_VWAP_MIN_SIGMA = 0.5;
export const SESSION_VWAP_MAX_SIGMA = 4;
export const SESSION_VWAP_SIGMA_STEP = 0.5;

/**
 * How many session accumulators are kept. A session's bars are all processed
 * while it is the newest window, so nothing older can ever lose a value it would
 * otherwise have had: this only bounds the memory a terminal left running for
 * months holds. There is deliberately no setting for how many sessions are
 * *shown*: the SDK's numeric line channel emits one point per bar and cannot
 * retract a point it has already emitted, so a segment already drawn stays on
 * the chart whatever a "sessions shown" control said.
 */
export const SESSION_VWAP_RETAINED_SESSIONS = 8;

/**
 * The two invisible colours a point can be painted. They are kept apart on
 * purpose: a band switched off is a setting, while a session join is history, and
 * `recolor` is handed a stored string and no bar, so it must be able to tell them
 * apart -- otherwise toggling a band would resurrect every hidden join.
 */
export const SESSION_VWAP_HIDDEN_COLOR = "rgba(0, 0, 0, 0)";
export const SESSION_VWAP_JOIN_COLOR = "rgba(1, 1, 1, 0)";

const VWAP_LINE_WIDTH = 2;
const BAND_LINE_WIDTH = 1;

/**
 * The colour this indicator owns: Session VWAP is the blue one, and the print-
 * priced VWAP Bands is the orange one, so the two are told apart at a glance
 * when both are on the chart.
 */
const VWAP_DEFAULT_COLOR = "#3b82f6";
const BAND1_DEFAULT_COLOR = VWAP_DEFAULT_COLOR;
const BAND2_DEFAULT_COLOR = VWAP_DEFAULT_COLOR;

/**
 * The opacity ladder that tells the three lines apart. Both bands start on the
 * average's own colour and are faded, the outer one faintest, so a session VWAP
 * reads as one object: the solid line is the average and the faint lines are its
 * deviations. The ladder is applied when the colour is painted rather than stored,
 * because the colour pickers are plain `<input type="color">` fields, which hold
 * `#rrggbb` and cannot carry an alpha -- and because a recolour then re-derives
 * both bands from whatever hue was chosen instead of keeping a stale fade.
 */
export const SESSION_VWAP_BAND1_OPACITY = 1;
export const SESSION_VWAP_BAND2_OPACITY = 0.8;

/** The band's own colour at its rung of the opacity ladder. */
export function sessionVwapBandColor(color: string, band: 1 | 2): string {
  return withOpacity(
    color,
    band === 1 ? SESSION_VWAP_BAND1_OPACITY : SESSION_VWAP_BAND2_OPACITY,
  );
}

/**
 * How solid the two fills are. They can afford to be strong: the kernel paints
 * fills in its bottom view, under the candles and under both VWAPs' own lines,
 * so the tape stays readable through them. The ring is faded further than the
 * inner band, so the pair reads as nested rather than as one shape.
 */
export const SESSION_VWAP_FILL_OPACITY = 0.35;
export const SESSION_VWAP_RING_FILL_OPACITY = 0.15;

/** The inner band's fill: its own hue, at the inner fill's opacity. */
export function sessionVwapFillColor(color: string): string {
  return withOpacity(color, SESSION_VWAP_FILL_OPACITY);
}

/** The ring between the two bands: its own hue, faded further. */
export function sessionVwapRingFillColor(color: string): string {
  return withOpacity(color, SESSION_VWAP_RING_FILL_OPACITY);
}

/**
 * The three regions both VWAPs fill. Each is a named band of the point channel,
 * because the channel keeps one point per bar per name -- and all three are
 * declared on every bar, nulls included, so none can slide out of step with the
 * bars.
 */
export const VWAP_FILL_INNER = "vwapInner";
export const VWAP_FILL_UPPER_RING = "vwapUpperRing";
export const VWAP_FILL_LOWER_RING = "vwapLowerRing";

/** The settings the fills read: whether each region is drawn, and its hue. */
export interface VwapFillSettings {
  showBands: boolean;
  showFill: boolean;
  fillColor: string;
  showRingFill: boolean;
  ringFillColor: string;
}

/**
 * The band fills of one bar: the inner deviation pair, and the two rings
 * between the inner and outer bands. Each region is its own toggle, and every
 * band is declared on every bar whichever way its toggle sits -- a band with
 * nothing to fill pushes a null, so the bands that follow stay aligned.
 */
export function drawVwapFills(
  draw: DrawNamespace,
  output: SessionVwapOutput,
  settings: VwapFillSettings,
): void {
  const bands = settings.showBands;
  const inner = bands && settings.showFill;
  const ring = bands && settings.showRingFill;
  const innerColor = sessionVwapFillColor(settings.fillColor);
  const ringColor = sessionVwapRingFillColor(settings.ringFillColor);
  draw.fill(
    inner ? output.upper1 : null,
    inner ? output.lower1 : null,
    { colorAbove: innerColor, colorBelow: innerColor },
    VWAP_FILL_INNER,
  );
  draw.fill(
    ring ? output.upper1 : null,
    ring ? output.upper2 : null,
    { colorAbove: ringColor, colorBelow: ringColor },
    VWAP_FILL_UPPER_RING,
  );
  draw.fill(
    ring ? output.lower1 : null,
    ring ? output.lower2 : null,
    { colorAbove: ringColor, colorBelow: ringColor },
    VWAP_FILL_LOWER_RING,
  );
}

/**
 * The anchor: what a VWAP is measured over. A session window is a *period*; a
 * lookback window is a *bar* -- the `lookbackBars`-th bar back from the newest
 * bar of the series being fed. Both VWAPs offer the same choice and mean the same
 * thing by it, so the options, the bounds, the settings fields and the rule that
 * finds the anchor are defined here once rather than twice.
 */
export type VwapAnchor = "session" | "lookback";

export const VWAP_ANCHOR_OPTIONS: readonly {
  readonly value: VwapAnchor;
  readonly label: string;
}[] = [
  { value: "session", label: "Session VWAP" },
  { value: "lookback", label: "Lookback VWAP" },
];

/** The lookback window's default and its bounds, in bars. */
export const VWAP_LOOKBACK_DEFAULT_BARS = 300;
export const VWAP_LOOKBACK_MIN_BARS = 10;
export const VWAP_LOOKBACK_MAX_BARS = 500;

/** The lookback rounded to whole bars and clamped to what the slider offers. */
export function normalizedLookbackBars(value: number): number {
  if (!Number.isFinite(value)) return VWAP_LOOKBACK_DEFAULT_BARS;
  return Math.min(
    Math.max(Math.round(value), VWAP_LOOKBACK_MIN_BARS),
    VWAP_LOOKBACK_MAX_BARS,
  );
}

/** The settings both VWAPs share, whatever else each of them carries. */
export interface VwapAnchorSettings {
  anchor: VwapAnchor;
  sessionPeriodMs: number;
  lookbackBars: number;
}

/**
 * The Inputs fields for the anchor, shared by both VWAPs: the dropdown, the
 * session length it belongs to and the lookback slider it belongs to, each of
 * those two hidden while the other anchor is selected rather than left inert.
 */
export function vwapAnchorFields<T extends VwapAnchorSettings>(): readonly SettingsFieldSchema<T>[] {
  return [
    {
      kind: "select",
      key: "anchor",
      label: "Anchor",
      tab: "inputs",
      affects: "recompute",
      options: VWAP_ANCHOR_OPTIONS,
    },
    {
      kind: "select",
      key: "sessionPeriodMs",
      label: "Session length",
      tab: "inputs",
      affects: "recompute",
      options: SESSION_VWAP_SESSION_OPTIONS,
      visibleIf: (settings) => settings.anchor !== "lookback",
    },
    {
      kind: "slider",
      key: "lookbackBars",
      label: "Lookback (bars)",
      tab: "inputs",
      affects: "recompute",
      min: VWAP_LOOKBACK_MIN_BARS,
      max: VWAP_LOOKBACK_MAX_BARS,
      step: 1,
      visibleIf: (settings) => settings.anchor === "lookback",
    },
  ];
}

/**
 * Whether the anchored lookback window has begun by this bar. The anchor is a bar,
 * not a period: `lookbackBars` back from the newest bar of the series being fed,
 * which only the series itself can say, so it is decided on the replay that
 * establishes the window. `begun` is the caller's own flag: once true it stays
 * true, because the anchor is frozen while the bars after it arrive.
 */
export function lookbackWindowBegins(
  ctx: Pick<
    IndicatorBarCtx<unknown, unknown>,
    "barIndex" | "barCount" | "replaying"
  >,
  lookbackBars: number,
  begun: boolean,
): boolean {
  if (begun) return true;
  const anchorIndex = Math.max(
    0,
    (ctx.barCount ?? 0) - normalizedLookbackBars(lookbackBars),
  );
  return !ctx.replaying || (ctx.barIndex ?? 0) >= anchorIndex;
}

export interface SessionVwapSettings {
  anchor: VwapAnchor;
  sessionPeriodMs: number;
  lookbackBars: number;
  band1Sigma: number;
  band2Sigma: number;
  showBands: boolean;
  vwapColor: string;
  band1Color: string;
  band2Color: string;
  showFill: boolean;
  fillColor: string;
  showRingFill: boolean;
  ringFillColor: string;
}

export const DEFAULT_SESSION_VWAP_SETTINGS: SessionVwapSettings = {
  anchor: "session",
  sessionPeriodMs: SESSION_VWAP_DEFAULT_SESSION_MS,
  lookbackBars: VWAP_LOOKBACK_DEFAULT_BARS,
  band1Sigma: SESSION_VWAP_DEFAULT_BAND1_SIGMA,
  band2Sigma: SESSION_VWAP_DEFAULT_BAND2_SIGMA,
  showBands: true,
  vwapColor: VWAP_DEFAULT_COLOR,
  band1Color: BAND1_DEFAULT_COLOR,
  band2Color: BAND2_DEFAULT_COLOR,
  showFill: true,
  fillColor: BAND1_DEFAULT_COLOR,
  showRingFill: true,
  ringFillColor: BAND1_DEFAULT_COLOR,
};

/** The volume-weighted sums one bar contributes. */
export interface SessionVwapContribution {
  volume: number;
  priceVolume: number;
  priceSquaredVolume: number;
}

/** The volume-weighted sums of one session window. */
export interface SessionVwapSums extends SessionVwapContribution {
  sessionStartTs: number;
}

/** This bar's own contribution, kept so a replace can take it back out. */
export interface SessionVwapSample extends SessionVwapContribution {
  tsOpen: number;
  sessionStartTs: number;
}

export interface SessionVwapOutput {
  vwap: number | null;
  upper1: number | null;
  lower1: number | null;
  upper2: number | null;
  lower2: number | null;
}

export interface SessionVwapState {
  identity: string | null;
  /** Session windows, eight of them retained (session anchor). */
  sessions: SessionVwapSums[];
  /** The lookback anchor's window: the running sums of every bar from the anchor
   * to the newest one, shaped like a session's so the maths is the same
   * (lookback anchor). */
  windowSums: SessionVwapSums;
  /** Whether the lookback window has begun. It begins on the anchor bar -- the
   * `lookbackBars`-th bar back from the newest one of the series being fed -- and
   * every bar before it is drawn as nothing at all. */
  windowBegun: boolean;
  /** This bar's own contribution, kept so a replace can take it back out. */
  bar: SessionVwapSample | null;
  /** Whether this bar is the last one of its session, so the segment leaving it
   * joins two sessions and is painted transparent. Always false in lookback
   * mode, where there are no session boundaries. */
  endsSession: boolean;
  /** The average's price and each band's sigma, drawn at the newest bar. */
  labels: VwapLabelSet;
  output: SessionVwapOutput;
}

const NO_VWAP: SessionVwapOutput = Object.freeze({
  vwap: null,
  upper1: null,
  lower1: null,
  upper2: null,
  lower2: null,
});

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** The UTC-aligned window `tsOpen` falls in -- the session profile's own rule. */
export function sessionWindowStartFor(
  tsOpen: number,
  sessionPeriodMs: number,
): number {
  const period = finiteOr(sessionPeriodMs, SESSION_VWAP_DEFAULT_SESSION_MS);
  if (!Number.isFinite(tsOpen) || period <= 0) return tsOpen;
  return Math.floor(tsOpen / period) * period;
}

export function clampSessionCount(maxDisplaySessions: number): number {
  const value = Math.round(
    finiteOr(maxDisplaySessions, SESSION_VWAP_RETAINED_SESSIONS),
  );
  return Math.max(value, 1);
}

/**
 * The band sigmas, ordered and clamped. Two number inputs can be transiently
 * contradictory mid-edit, and crossed bands would mean the "upper" line sits
 * under the "lower" one, so the inner band is always the smaller setting -- the
 * same normalization `normalizedPivotDistance` does for CVD Divergence.
 */
export function normalizedBandSigmas(
  settings: Pick<SessionVwapSettings, "band1Sigma" | "band2Sigma">,
): { inner: number; outer: number } {
  const clamp = (value: number, fallback: number) =>
    Math.min(
      Math.max(finiteOr(value, fallback), SESSION_VWAP_MIN_SIGMA),
      SESSION_VWAP_MAX_SIGMA,
    );
  const first = clamp(settings.band1Sigma, SESSION_VWAP_DEFAULT_BAND1_SIGMA);
  const second = clamp(settings.band2Sigma, SESSION_VWAP_DEFAULT_BAND2_SIGMA);
  return { inner: Math.min(first, second), outer: Math.max(first, second) };
}

/** The bar's typical price, the standard stand-in for a candle's own average. */
export function typicalPriceOf(bar: BarFrame): number {
  return (bar.high + bar.low + bar.close) / 3;
}

/**
 * One bar's contribution: the volume the venue itself reports for that candle,
 * at its typical price. A bar with no volume (or an unusable price) contributes
 * nothing rather than a zero-price unit.
 */
export function measureBar(bar: BarFrame): SessionVwapContribution {
  const volume = bar.volume;
  const price = typicalPriceOf(bar);
  if (
    !Number.isFinite(volume) ||
    volume <= 0 ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return { volume: 0, priceVolume: 0, priceSquaredVolume: 0 };
  }
  return {
    volume,
    priceVolume: price * volume,
    priceSquaredVolume: price * price * volume,
  };
}

export function sessionVwapOf(sums: SessionVwapSums): number | null {
  return sums.volume > 0 ? sums.priceVolume / sums.volume : null;
}

/**
 * The volume-weighted standard deviation, `sqrt(Σv(p − vwap)² / Σv)`, computed
 * from the running sums as `sqrt(Σvp²/Σv − vwap²)` so no price history has to be
 * retained. Negative rounding noise clamps to zero.
 */
export function sessionDeviationOf(sums: SessionVwapSums): number {
  if (sums.volume <= 0) return 0;
  const mean = sums.priceVolume / sums.volume;
  const variance = sums.priceSquaredVolume / sums.volume - mean * mean;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

export function sessionVwapOutput(
  sums: SessionVwapSums,
  band1Sigma: number,
  band2Sigma: number,
): SessionVwapOutput {
  const vwap = sessionVwapOf(sums);
  if (vwap === null) return NO_VWAP;
  const deviation = sessionDeviationOf(sums);
  const { inner, outer } = normalizedBandSigmas({ band1Sigma, band2Sigma });
  const innerOffset = inner * deviation;
  const outerOffset = outer * deviation;
  return {
    vwap,
    upper1: vwap + innerOffset,
    lower1: vwap - innerOffset,
    upper2: vwap + outerOffset,
    lower2: vwap - outerOffset,
  };
}

/**
 * The sessions still kept once `latestSessionStartTs` opens: the newest
 * `SESSION_VWAP_RETAINED_SESSIONS` windows. Dropping a window only forgets its
 * accumulator -- its bars were already measured while it was the newest, and the
 * segment drawn for it stays on the chart.
 */
export function retainedSessionSums(
  sessions: readonly SessionVwapSums[],
  latestSessionStartTs: number,
  sessionPeriodMs: number,
): SessionVwapSums[] {
  const period = finiteOr(sessionPeriodMs, SESSION_VWAP_DEFAULT_SESSION_MS);
  const oldestKept =
    latestSessionStartTs - (clampSessionCount(SESSION_VWAP_RETAINED_SESSIONS) - 1) * period;
  return sessions.filter(
    (session) =>
      session.sessionStartTs >= oldestKept &&
      session.sessionStartTs <= latestSessionStartTs,
  );
}

export function sessionVwapIdentityOf(bar: BarFrame): string {
  const market = bar.provider === "BINANCE" ? bar.marketKind : bar.assetClass;
  return `${bar.symbol}|${bar.provider}|${market}|${bar.interval_ms}`;
}

/** Fresh, empty running sums for a session window or a lookback one. */
export function emptyVwapSums(sessionStartTs: number): SessionVwapSums {
  return { sessionStartTs, volume: 0, priceVolume: 0, priceSquaredVolume: 0 };
}

/**
 * Adds one bar's contribution to a running sum, or takes it back out again -- for
 * a bar re-delivered while it is still developing, or one leaving a rolling
 * window. Shared rather than private because a lookback VWAP accumulates exactly
 * the same three numbers a session does, over a different set of bars.
 */
export function addVwapSample(
  sums: SessionVwapSums,
  sample: SessionVwapContribution,
): void {
  sums.volume += sample.volume;
  sums.priceVolume += sample.priceVolume;
  sums.priceSquaredVolume += sample.priceSquaredVolume;
}

export function removeVwapSample(
  sums: SessionVwapSums,
  sample: SessionVwapContribution,
): void {
  sums.volume -= sample.volume;
  sums.priceVolume -= sample.priceVolume;
  sums.priceSquaredVolume -= sample.priceSquaredVolume;
}

function lineColor(
  state: SessionVwapState,
  settings: SessionVwapSettings,
  color: string,
  isBand: boolean,
): string {
  if (state.endsSession) return SESSION_VWAP_JOIN_COLOR;
  if (isBand && !settings.showBands) return SESSION_VWAP_HIDDEN_COLOR;
  return color;
}

/**
 * The same decision for a stored colour. A join stays hidden through any cosmetic
 * edit; a band's own hidden colour does not, so switching the bands back on
 * restores them.
 */
function recoloredLine(
  current: string | undefined,
  settings: SessionVwapSettings,
  color: string,
  isBand: boolean,
): string {
  if (current === SESSION_VWAP_JOIN_COLOR) return SESSION_VWAP_JOIN_COLOR;
  if (isBand && !settings.showBands) return SESSION_VWAP_HIDDEN_COLOR;
  return color;
}

/**
 * The text both VWAPs carry beside their lines: the average names its own price
 * and each band names its sigma -- `+1` / `-1` on the inner pair, `+2` / `-2`
 * on the outer -- so a line says what it is and what it is worth without a
 * hover.
 *
 * These are `draw.label` handles rather than price-scale labels because neither
 * VWAP owns a pane: both are overlays on the candles, and a scale row would be
 * shared by every other overlay on that pane. They are made once, in
 * `createState`, and moved to the newest bar by every bar.
 *
 * A band's sigma is the sigma the band was *plotted* at -- `normalizedBandSigmas`'
 * inner/outer, not whichever box the two sliders happen to write -- so crossed
 * sliders can never leave a label claiming a band that is not where it says.
 */
export const VWAP_LABEL_TEXT_SIZE = 11;
/**
 * The labels point left: the text is anchored on its LEFT edge at the newest
 * bar, so it starts at the line's end and reads away to the right.
 */
export const VWAP_LABEL_TEXT_ALIGN: CanvasTextAlign = "left";
export const VWAP_LABEL_OFFSET_X = 0;
/**
 * The labels ride one bar into the future -- one bar's width past the newest
 * bar, into the empty space beside the last candle. A bar that has not
 * happened yet has no time to convert, so the offset is counted in bars and the
 * kernel turns it into pixels with the time scale's own bar width: the label
 * follows a zoom rather than freezing at one spacing.
 */
export const VWAP_LABEL_BAR_OFFSET = 1;

export interface VwapLabelSet {
  vwap: LabelHandle;
  upper1: LabelHandle;
  lower1: LabelHandle;
  upper2: LabelHandle;
  lower2: LabelHandle;
}

/**
 * Five text-only labels -- the dot the label primitive would otherwise paint is
 * given a zero radius and an invisible colour, so only the text shows. Every
 * label starts hidden and is placed by `updateVwapLabels` on the first bar.
 */
export function createVwapLabels(): VwapLabelSet {
  const text = (): LabelHandle =>
    draw.label({
      time: 0,
      price: 0,
      text: "",
      color: SESSION_VWAP_HIDDEN_COLOR,
      textColor: SESSION_VWAP_HIDDEN_COLOR,
      size: 0,
      textSize: VWAP_LABEL_TEXT_SIZE,
      textAlign: VWAP_LABEL_TEXT_ALIGN,
      offsetX: VWAP_LABEL_OFFSET_X,
      barOffset: VWAP_LABEL_BAR_OFFSET,
    });
  return {
    vwap: text(),
    upper1: text(),
    lower1: text(),
    upper2: text(),
    lower2: text(),
  };
}

/** The settings a label reads: the two sigmas and every colour it names. */
export interface VwapLabelSettings {
  band1Sigma: number;
  band2Sigma: number;
  showBands: boolean;
  vwapColor: string;
  band1Color: string;
  band2Color: string;
}

/** A sigma as a label shows it: `1`, `1.5` -- no trailing zeros. */
function formatSigma(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function placeVwapLabel(
  label: LabelHandle,
  time: number,
  price: number | null,
  text: string,
  color: string,
): void {
  if (price === null || text.length === 0) {
    label.setColor(SESSION_VWAP_HIDDEN_COLOR);
    label.setTextColor(SESSION_VWAP_HIDDEN_COLOR);
    label.setText("");
    return;
  }
  label.setXY(time, price);
  label.setColor(SESSION_VWAP_HIDDEN_COLOR);
  label.setTextColor(color);
  label.setText(text);
}

/**
 * Places every label on `time` -- the newest bar: the average's price, and each
 * band's sigma. A band switched off, or a window that has not produced a value
 * yet, leaves its label empty rather than stale.
 */
export function updateVwapLabels(
  labels: VwapLabelSet,
  time: number,
  output: SessionVwapOutput,
  settings: VwapLabelSettings,
): void {
  placeVwapLabel(
    labels.vwap,
    time,
    output.vwap,
    output.vwap === null ? "" : `VWAP: ${formatLabelPrice(output.vwap)}`,
    settings.vwapColor,
  );
  const { inner, outer } = normalizedBandSigmas(settings);
  const bands = settings.showBands;
  const innerColor = sessionVwapBandColor(settings.band1Color, 1);
  const outerColor = sessionVwapBandColor(settings.band2Color, 2);
  placeVwapLabel(labels.upper1, time, bands ? output.upper1 : null, `+${formatSigma(inner)}`, innerColor);
  placeVwapLabel(labels.lower1, time, bands ? output.lower1 : null, `-${formatSigma(inner)}`, innerColor);
  placeVwapLabel(labels.upper2, time, bands ? output.upper2 : null, `+${formatSigma(outer)}`, outerColor);
  placeVwapLabel(labels.lower2, time, bands ? output.lower2 : null, `-${formatSigma(outer)}`, outerColor);
}

const SESSION_VWAP_LINES: readonly LineOutputSpec<
  SessionVwapState,
  SessionVwapSettings
>[] = [
  {
    key: "vwap",
    lineWidth: VWAP_LINE_WIDTH,
    color: (state, settings) => lineColor(state, settings, settings.vwapColor, false),
    recolor: (current, settings) => recoloredLine(current, settings, settings.vwapColor, false),
  },
  {
    key: "upper1",
    lineWidth: BAND_LINE_WIDTH,
    color: (state, settings) => lineColor(state, settings, sessionVwapBandColor(settings.band1Color, 1), true),
    recolor: (current, settings) => recoloredLine(current, settings, sessionVwapBandColor(settings.band1Color, 1), true),
  },
  {
    key: "lower1",
    lineWidth: BAND_LINE_WIDTH,
    color: (state, settings) => lineColor(state, settings, sessionVwapBandColor(settings.band1Color, 1), true),
    recolor: (current, settings) => recoloredLine(current, settings, sessionVwapBandColor(settings.band1Color, 1), true),
  },
  {
    key: "upper2",
    lineWidth: BAND_LINE_WIDTH,
    color: (state, settings) => lineColor(state, settings, sessionVwapBandColor(settings.band2Color, 2), true),
    recolor: (current, settings) => recoloredLine(current, settings, sessionVwapBandColor(settings.band2Color, 2), true),
  },
  {
    key: "lower2",
    lineWidth: BAND_LINE_WIDTH,
    color: (state, settings) => lineColor(state, settings, sessionVwapBandColor(settings.band2Color, 2), true),
    recolor: (current, settings) => recoloredLine(current, settings, sessionVwapBandColor(settings.band2Color, 2), true),
  },
];

const SESSION_VWAP_SETTINGS_SCHEMA: readonly SettingsFieldSchema<SessionVwapSettings>[] =
  [
    ...vwapAnchorFields<SessionVwapSettings>(),
    {
      kind: "slider",
      key: "band1Sigma",
      label: "Inner band (σ)",
      tab: "inputs",
      affects: "recompute",
      min: SESSION_VWAP_MIN_SIGMA,
      max: SESSION_VWAP_MAX_SIGMA,
      step: SESSION_VWAP_SIGMA_STEP,
    },
    {
      kind: "slider",
      key: "band2Sigma",
      label: "Outer band (σ)",
      tab: "inputs",
      affects: "recompute",
      min: SESSION_VWAP_MIN_SIGMA,
      max: SESSION_VWAP_MAX_SIGMA,
      step: SESSION_VWAP_SIGMA_STEP,
    },
    {
      kind: "boolean",
      key: "showBands",
      label: "Show deviation bands",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "vwapColor",
      label: "VWAP color",
      tab: "visibility",
      affects: "cosmetic",
    },
    {
      kind: "color",
      key: "band1Color",
      label: "Inner band color",
      tab: "visibility",
      affects: "cosmetic",
      visibleIf: (settings) => settings.showBands,
    },
    {
      kind: "color",
      key: "band2Color",
      label: "Outer band color",
      tab: "visibility",
      affects: "cosmetic",
      visibleIf: (settings) => settings.showBands,
    },
    {
      kind: "boolean",
      key: "showFill",
      label: "Inner band fill",
      tab: "visibility",
      affects: "recompute",
      visibleIf: (settings) => settings.showBands,
    },
    {
      kind: "color",
      key: "fillColor",
      label: "Inner fill color",
      tab: "visibility",
      affects: "recompute",
      visibleIf: (settings) => settings.showBands && settings.showFill,
    },
    {
      kind: "boolean",
      key: "showRingFill",
      label: "Band gap fill",
      tab: "visibility",
      affects: "recompute",
      visibleIf: (settings) => settings.showBands,
    },
    {
      kind: "color",
      key: "ringFillColor",
      label: "Gap fill color",
      tab: "visibility",
      affects: "recompute",
      visibleIf: (settings) => settings.showBands && settings.showRingFill,
    },
    {
      kind: "staticHint",
      text: "Each bar contributes the venue's own traded volume at its typical price, (high + low + close) / 3, so the session average is exact in volume and estimated in price, and it draws in every mode and timeframe with no tick data needed. That estimate also means the deviation bands read narrow: a candle cannot say where inside itself the volume traded. The last bar of each session is painted transparent, so one session is not joined to the next session's average by a segment that never traded. The newest bar is labelled: the average with its price, each band with its sigma. The anchor chooses what the average is measured over: the session window, or a window that starts a fixed number of bars back from the newest bar and develops from there. Changing the anchor, the session length or a band width replays every bar.",
    },
  ];

export const sessionVwapIndicator: RuntimeIndicatorDef<
  SessionVwapState,
  SessionVwapSettings
> = {
  kind: "runtime",
  id: "sessionVwap",
  label: "Session VWAP",
  category: "technical",
  defaultSettings: DEFAULT_SESSION_VWAP_SETTINGS,
  settingsSchema: SESSION_VWAP_SETTINGS_SCHEMA,
  lines: SESSION_VWAP_LINES,
  placement: { kind: "overlay" },
  createState: () => ({
    identity: null,
    sessions: [],
    windowSums: emptyVwapSums(0),
    windowBegun: false,
    bar: null,
    endsSession: false,
    labels: createVwapLabels(),
    output: NO_VWAP,
  }),
  onBar: (ctx) => {
    const { bar, state, settings, replace } = ctx;

    const identity = sessionVwapIdentityOf(bar);
    if (state.identity !== identity) {
      state.identity = identity;
      state.sessions = [];
      state.windowSums = emptyVwapSums(bar.ts_open);
      state.windowBegun = false;
      state.bar = null;
    }

    const lookback = settings.anchor === "lookback";
    const periodMs = finiteOr(
      settings.sessionPeriodMs,
      SESSION_VWAP_DEFAULT_SESSION_MS,
    );
    const sessionStartTs = sessionWindowStartFor(bar.ts_open, periodMs);

    // The last bar of a session: it is the bar that walks up to the window's end,
    // so the segment leaving it is the one that would join two sessions. A bar
    // longer than the session itself cannot resolve a boundary, so it is left
    // alone rather than blanking the whole line. A lookback window has no
    // boundaries to join, so nothing is hidden in that mode.
    state.endsSession =
      !lookback &&
      bar.interval_ms <= periodMs &&
      bar.ts_open + bar.interval_ms >= sessionStartTs + periodMs;

    let sums: SessionVwapSums;
    if (lookback) {
      if (!lookbackWindowBegins(ctx, settings.lookbackBars, state.windowBegun)) {
        state.output = NO_VWAP;
        updateVwapLabels(state.labels, bar.ts_open, state.output, settings);
        drawVwapFills(ctx.draw, state.output, settings);
        return;
      }
      if (!state.windowBegun) {
        // The anchor bar opens the window; the bars before it never counted.
        state.windowBegun = true;
        state.windowSums = emptyVwapSums(bar.ts_open);
      }
      sums = state.windowSums;
    } else {
      state.sessions = retainedSessionSums(
        state.sessions,
        sessionStartTs,
        periodMs,
      );
      let session = state.sessions.find(
        (candidate) => candidate.sessionStartTs === sessionStartTs,
      );
      if (session === undefined) {
        session = emptyVwapSums(sessionStartTs);
        state.sessions.push(session);
      }
      sums = session;
    }

    // The developing bar is re-delivered as it trades, so this bar's earlier
    // contribution comes back out of its own window before the new numbers go in.
    if (replace && state.bar !== null) {
      if (state.bar.tsOpen === bar.ts_open) removeVwapSample(sums, state.bar);
      state.bar = null;
    }

    const measured = measureBar(bar);
    if (measured.volume > 0) {
      const sample: SessionVwapSample = {
        tsOpen: bar.ts_open,
        sessionStartTs,
        ...measured,
      };
      addVwapSample(sums, sample);
      state.bar = sample;
    }

    // A bar that traded nothing adds nothing, so the window keeps its running
    // average -- a flat step rather than a hole in the line.
    state.output = sessionVwapOutput(
      sums,
      settings.band1Sigma,
      settings.band2Sigma,
    );
    updateVwapLabels(state.labels, bar.ts_open, state.output, settings);
    drawVwapFills(ctx.draw, state.output, settings);
  },
  readOutput: (state) => ({ ...state.output }),
};
