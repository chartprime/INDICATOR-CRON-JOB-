import type { BarFrame } from "../../../types/frames";
import type {
  IndicatorBarCtx,
  LineOutputSpec,
  RuntimeIndicatorDef,
  SettingsFieldSchema,
} from "../../chart/indicatorTypes";
import {
  SESSION_VWAP_DEFAULT_BAND1_SIGMA,
  SESSION_VWAP_DEFAULT_BAND2_SIGMA,
  SESSION_VWAP_DEFAULT_SESSION_MS,
  SESSION_VWAP_HIDDEN_COLOR,
  SESSION_VWAP_JOIN_COLOR,
  SESSION_VWAP_MAX_SIGMA,
  SESSION_VWAP_MIN_SIGMA,
  SESSION_VWAP_SIGMA_STEP,
  VWAP_LOOKBACK_DEFAULT_BARS,
  addVwapSample,
  createVwapLabels,
  drawVwapFills,
  emptyVwapSums,
  lookbackWindowBegins,
  removeVwapSample,
  retainedSessionSums,
  sessionVwapBandColor,
  sessionVwapOutput,
  sessionWindowStartFor,
  updateVwapLabels,
  vwapAnchorFields,
  type SessionVwapContribution,
  type SessionVwapOutput,
  type SessionVwapSample,
  type SessionVwapSums,
  type VwapAnchorSettings,
  type VwapLabelSet,
} from "../session-vwap/sessionVwap";

import {
  sumPrintsIn,
  type IndicatorTicks,
  type TickCoverage,
} from "../../chart/indicatorTicks";

/**
 * VWAP Bands -- the volume-weighted average price of the traded volume since the
 * current session opened, with two volume-weighted deviation bands, priced by
 * this terminal's L1 tape and by nothing else.
 *
 * The source is the **print store**, never the order book: `ctx.ticks` is the
 * same `AggressiveTape` the whale detector and Aggressive Order Flow read, which
 * holds every print of the live pair from the moment it lands, plus the history
 * the server could serve for before this browser connected. Both the average and
 * Sigma are then exact to the print rather than to a price bucket or a candle.
 *
 * There is deliberately **no candle fallback**. A bar priced from its candle
 * would be an estimate the volume never traded at, which is the one thing this
 * indicator exists not to do -- Session VWAP prices every bar that way, for
 * every mode, and the two are meant to be comparable rather than identical. A
 * bar the store does not cover therefore adds nothing, and the line begins where
 * the tape begins.
 *
 * The readings of coverage are told apart rather than blurred:
 *
 * - `"prints"` -- the window is covered end to end (the live stretch, or
 *   history the server served in full), so the window's prints are the whole
 *   story of that bar, including a window that printed nothing.
 * - `"thin"` -- only the server's floor-filtered history covers the window, so
 *   the small prints are missing and the average leans towards the larger ones.
 *   Used, and named in the source, because the alternative is no tick data at
 *   all for that stretch.
 * - `"none"` -- nothing covers the window, so the bar adds nothing at all. No
 *   endpoint in this system serves "every trade between two timestamps" for a
 *   past range (`TA.03.5`), and a candle is not a substitute for the prints it
 *   cannot show.
 *
 * Neither an uncovered bar nor a covered one that printed nothing is a hole in
 * the line: the session keeps its running average, exactly as the shared kernel
 * already treats a bar of zero volume, so the average carries flat across them
 * instead of being invented or restarted.
 *
 * Which reading drew a bar is not coloured apart on the chart: a per-bar colour
 * cannot survive a cosmetic recolour (`recolor` is handed a stored string and no
 * bar), so a marking would silently flatten on the first colour change. It is
 * kept in state, named in the settings hint, and covered by tests.
 *
 * What the chart does say, beside the newest bar, is what each line is worth:
 * the average's own price and each band's sigma, drawn by the label machinery
 * shared with Session VWAP so the two label themselves identically.
 *
 * **Two anchors.** The average is measured either over the current session
 * window -- the same UTC-aligned windows Session VWAP uses, so the two line up --
 * or over a window **anchored a fixed number of bars back from the newest bar**
 * (300 by default), which needs no session concept at all.
 *
 * The lookback anchor is a *bar*, not a period, and only the series can say which
 * bar it is: the anchor is `lookbackBars` back from the newest bar of the series
 * being fed (`ctx.barIndex` / `ctx.barCount`), so it is decided when the bars are
 * replayed. It then stays put while bars arrive, and the window develops from
 * there to the newest bar -- the same shape as a session window developing from
 * its own first bar, with a bar count in place of a period. Nothing is drawn
 * before the anchor, and nothing falls out of the window: this is anchored, not
 * rolling.
 *
 * Both anchors keep the same three running sums (`addVwapSample` /
 * `removeVwapSample`, shared with the session path), so the band maths, the sigma
 * ladder and the colours are shared rather than written twice.
 *
 * A lookback window has no boundaries to join, so nothing is painted transparent
 * in lookback mode: the join rule exists to keep two *sessions* from being read as
 * one line.
 *
 * Everything else is the shared session kernel, imported rather than copied: the
 * same UTC-aligned windows and session-length list as Session VWAP and Session
 * Delta Profile, the same running sums and band maths, the same eight-session
 * accumulator bound, and the same session-join rule -- the bar walking up to a
 * session's end is painted transparent, because lightweight-charts strokes a
 * segment with the colour of the point it starts from.
 */
const VWAP_LINE_WIDTH = 2;
const BAND_LINE_WIDTH = 1;

/**
 * The colours this indicator owns: VWAP Bands is the warm one -- an orange
 * average with blue deviations -- against Session VWAP's own blue, so the two are
 * told apart at a glance when both are on the chart. The bands are a hue of
 * their own rather than a fade of the average, and each is faded down the ladder
 * `sessionVwapBandColor` applies: the shared session kernel's ladder, so the two
 * VWAPs fade identically even though they do not share a palette.
 */
const VWAP_DEFAULT_COLOR = "#f97316";
const BAND1_DEFAULT_COLOR = "#308fe8";
const BAND2_DEFAULT_COLOR = "#308fe8";

/** Which reading of the store drew a bar. */
export type VwapBandsSource = "prints" | "thin" | "none";

/** The anchor settings, shared with Session VWAP: a session window or a bar window. */
export interface VwapBandsSettings extends VwapAnchorSettings {
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

export const DEFAULT_VWAP_BANDS_SETTINGS: VwapBandsSettings = {
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

export interface VwapBandsState {
  identity: string | null;
  /** Session windows, eight of them retained (session anchor). */
  sessions: SessionVwapSums[];  /** The lookback anchor's window: the running sums of every bar from the anchor
   * to the newest one, shaped like a session's so the kernel's maths applies
   * unchanged (lookback anchor). */
  windowSums: SessionVwapSums;
  /** Whether the lookback window has begun. It begins on the anchor bar -- the
   * `lookbackBars`-th bar back from the newest one of the series being fed -- and
   * every bar before it is drawn as nothing at all. */
  windowBegun: boolean;
  /** The developing bar's own contribution, kept so a replace can take it back
   * out of the window it went into before its new numbers go in. */
  bar: SessionVwapSample | null;
  /** Whether this bar is the last one of its session, so the segment leaving it
   * joins two sessions and is painted transparent. Always false in lookback
   * mode, where there are no session boundaries. */
  endsSession: boolean;
  /** Which reading of the store drew this bar, so what the line is made of is
   * inspectable state rather than a claim in a comment. */
  source: VwapBandsSource | null;
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

const NO_CONTRIBUTION: SessionVwapContribution = Object.freeze({
  volume: 0,
  priceVolume: 0,
  priceSquaredVolume: 0,
});

export function vwapBandsIdentityOf(bar: BarFrame): string {
  const market = bar.provider === "BINANCE" ? bar.marketKind : bar.assetClass;
  return `${bar.symbol}|${bar.provider}|${market}|${bar.interval_ms}`;
}

/**
 * What one bar adds to its session, and which reading of the store said so.
 *
 * A covered window is authoritative: its prints are the bar's story, and a
 * covered window that printed nothing really did print nothing, so it adds
 * nothing rather than falling through to a candle. An uncovered window adds
 * nothing either. There is no store at all in Historical Mode and in the moments
 * before one is handed over.
 */
export function barContribution(
  bar: BarFrame,
  ticks: IndicatorTicks | undefined,
): { contribution: SessionVwapContribution; source: VwapBandsSource } {  if (ticks === undefined) return { contribution: NO_CONTRIBUTION, source: "none" };
  const toTs = bar.ts_open + bar.interval_ms;
  const coverage: TickCoverage = ticks.coverageOf(bar.ts_open, toTs);
  if (coverage === "none") return { contribution: NO_CONTRIBUTION, source: "none" };
  return {
    contribution: sumPrintsIn(ticks.prints, bar.ts_open, toTs),
    source: coverage === "all" ? "prints" : "thin",
  };
}

function lineColor(
  state: VwapBandsState,
  settings: VwapBandsSettings,
  color: string,
  isBand: boolean,
): string {
  if (state.endsSession) return SESSION_VWAP_JOIN_COLOR;
  if (isBand && !settings.showBands) return SESSION_VWAP_HIDDEN_COLOR;
  return color;
}

function recoloredLine(
  current: string | undefined,
  settings: VwapBandsSettings,
  color: string,
  isBand: boolean,
): string {
  if (current === SESSION_VWAP_JOIN_COLOR) return SESSION_VWAP_JOIN_COLOR;
  if (isBand && !settings.showBands) return SESSION_VWAP_HIDDEN_COLOR;
  return color;
}

const VWAP_BANDS_LINES: readonly LineOutputSpec<
  VwapBandsState,
  VwapBandsSettings
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

const VWAP_BANDS_SETTINGS_SCHEMA: readonly SettingsFieldSchema<VwapBandsSettings>[] =
  [
    ...vwapAnchorFields<VwapBandsSettings>(),
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
      text: "Prices the volume by this terminal's own L1 prints: every print of the live pair from the moment it lands, plus the history the server served for before the browser connected. That history keeps only the prints above a size floor, so a bar drawn from it leans towards the larger ones. There is no candle fallback: a bar the store does not cover adds nothing, so the line begins where the tape begins and the average carries flat across the stretch it cannot see. The newest bar is labelled: the average with its price, each band with its sigma. The anchor chooses what the average is measured over: the session window, or a window that starts a fixed number of bars back from the newest bar and develops from there.",
    },
  ];

export const vwapBandsIndicator: RuntimeIndicatorDef<
  VwapBandsState,
  VwapBandsSettings
> = {
  kind: "runtime",
  id: "vwapBands",
  label: "VWAP Bands",
  category: "l1",
  ticksWanted: true,
  defaultSettings: DEFAULT_VWAP_BANDS_SETTINGS,
  settingsSchema: VWAP_BANDS_SETTINGS_SCHEMA,
  lines: VWAP_BANDS_LINES,
  placement: { kind: "overlay" },
  createState: () => ({
    identity: null,
    sessions: [],
    windowSums: emptyVwapSums(0),
    windowBegun: false,
    bar: null,
    endsSession: false,
    source: null,
    labels: createVwapLabels(),
    output: NO_VWAP,
  }),
  onBar: (ctx: IndicatorBarCtx<VwapBandsState, VwapBandsSettings>) => {
    const { bar, state, settings, replace } = ctx;

    const identity = vwapBandsIdentityOf(bar);
    if (state.identity !== identity) {
      state.identity = identity;
      state.sessions = [];
      state.windowSums = emptyVwapSums(bar.ts_open);
      state.windowBegun = false;
      state.bar = null;
    }

    const lookback = settings.anchor === "lookback";
    const periodMs = Number.isFinite(settings.sessionPeriodMs)
      ? settings.sessionPeriodMs
      : SESSION_VWAP_DEFAULT_SESSION_MS;
    const sessionStartTs = sessionWindowStartFor(bar.ts_open, periodMs);

    // A lookback window has no boundaries to join, so only a session can end a
    // segment: in lookback mode nothing is ever painted transparent.
    state.endsSession =
      !lookback &&
      bar.interval_ms <= periodMs &&
      bar.ts_open + bar.interval_ms >= sessionStartTs + periodMs;

    const { contribution, source } = barContribution(bar, ctx.ticks);
    state.source = source;

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

    if (contribution.volume > 0) {
      const sample: SessionVwapSample = {
        tsOpen: bar.ts_open,
        sessionStartTs,
        ...contribution,
      };
      addVwapSample(sums, sample);
      state.bar = sample;
    }

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
