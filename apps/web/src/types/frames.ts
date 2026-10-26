import marketInstrumentCatalog from "../../../../config/market-instruments.json";
export type Side = "buy" | "sell";

export type MarketKind = "SPOT" | "PERPETUAL";
export type AssetClass = "FUTURE" | "EQUITY";
export type Provider = "BINANCE" | "DATABENTO" | "DXFEED";
export type VpinStatus =
  | "DISABLED"
  | "IDLE"
  | "WARMING"
  | "READY"
  | "UNAVAILABLE";

export type BinanceIdentity = {
  provider: "BINANCE";
  marketKind: MarketKind;
  assetClass?: never;
};
export type DatabentoIdentity = {
  provider: "DATABENTO";
  assetClass: AssetClass;
  marketKind?: never;
};
export type DxFeedIdentity = {
  provider: "DXFEED";
  assetClass: AssetClass;
  marketKind?: never;
};
export type FrameIdentity =
  | BinanceIdentity
  | DatabentoIdentity
  | DxFeedIdentity;

export type TradeFrame = {
  type: "trade";
  symbol: string;
  ts_exchange: number;
  price: number;
  size: number;
  side: Side;
  trade_id: string;
  auction?: true;
} & FrameIdentity;

export type MarkerFrame = {
  type: "marker";
  symbol: string;
  ts_exchange: number;
  price: number;
  size: number;
  side: Side;
  trade_id: string;
  baseline_log_median?: number;
  baseline_log_mad?: number;
} & FrameIdentity;

export type BarFrame = {
  type: "bar";
  symbol: string;
  interval_ms: number;
  calendar_interval?: "month";
  ts_open: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buy_volume?: number;
  sell_volume?: number;
  trade_count: number | null;
  closed: boolean;
  reconstructed?: boolean;
} & FrameIdentity;

export type SnapshotFrame = {
  type: "snapshot";
  symbol: string;
  bars: BarFrame[];
  trades: TradeFrame[];
  markers: MarkerFrame[];
  bar_history?: BarHistory;
  vpin_readings?: VpinReading[];
  vpin_status?: VpinStatus;
  aggressive_prints?: TradeFrame[]; // the server's pool of big prints for the pair, oldest first, complete from aggressive_prints_floor over [aggressive_prints_from, now]
  aggressive_prints_floor?: number;
  aggressive_prints_from?: number;
} & FrameIdentity;

export type BarHistory = {
  availability: "AVAILABLE" | "UNAVAILABLE";
  requestedStartTsOpen: number;
  earliestObservedTsOpen?: number;
  coverage: "START_COVERED" | "START_NOT_COVERED" | "NO_ROWS";
  interpretation: "OBSERVED_NONEMPTY_BARS_ONLY";
};

export type RecoveryState = "READY" | "RECOVERING" | "UNAVAILABLE";

export type HealthFrame = {
  type: "health";
  symbol: string;
  recoveryState: RecoveryState;
  stale: boolean;
  printsQuiet?: boolean;
  reason?: string;
  recordingStale?: boolean;
  recordingLatestTs?: number;
} & FrameIdentity;

export interface BookLevel {
  price: number;
  size: number;
}

export type BookStatus = "READY" | "UNAVAILABLE";

export type BookFrame = {
  type: "book";
  symbol: string;
  status: BookStatus;
  reason?: string;
  bids?: BookLevel[];
  asks?: BookLevel[];
  lastUpdateId?: number;
  stale?: boolean;
} & FrameIdentity;

export type SelectionFrame = {
  type: "selection";
  symbol: string;
} & FrameIdentity;

export type ProfileMode = "continuous" | "per_candle" | "fixed_range";
export type ProfileDeliveryScope = "LIVE" | "HISTORICAL" | "FIXED_RANGE";

export type ProfileBucket = {
  price: number;
  volume: number;
  buy_volume: number;
  sell_volume: number;
  single_print: boolean;
};

export type ProfileFrame = {
  type: "profile";
  symbol: string;
  mode: ProfileMode;
  delivery_scope: ProfileDeliveryScope;
  history_request_id: number | null;
  period_start_ts: number;
  period_end_ts: number | null;
  row_width: number;
  buckets: ProfileBucket[];
  poc_price: number;
  vah_price: number;
  val_price: number;
} & FrameIdentity;

export type VpinDirection = "buy" | "sell" | null;

export type VpinReading = {
  seal_ts: number;
  active: boolean;
  direction: VpinDirection;
  strength: number;
  z_vpin: number | null;
  z_velocity: number | null;
  z_acceleration: number | null;
  activated_at_ts: number | null;
};

// L2 Passive Liquidity heatmap: one column per second of resting size per
// price row. `bid`/`ask` list only the rows that changed since the previous
// column, as [offset from `lo`, size]; a frame with `reset` starts a fresh
// history whose first column is complete. `seq` counts columns ever sent
// for the pair, so a frame with N columns covers seq-N .. seq-1.
export type LiquidityEntry = [offset: number, size: number];

export type LiquidityPrint = {
  ts: number;
  price: number;
  size: number;
  side: "buy" | "sell";
  id: string | null;
};

export type LiquidityColumnFrame = {
  ts: number;
  lo: number; // first row of the window; price = row * row_width
  hi: number; // last row (inclusive)
  bid: LiquidityEntry[];
  ask: LiquidityEntry[];
  buy?: LiquidityEntry[]; // aggressive buy volume that printed per row in the second ending at ts, or in the one before it and reached the runtime late (the whole flow, no delta)
  sell?: LiquidityEntry[]; // same for aggressive sells
  prints?: LiquidityPrint[]; // complete largest-size groups from this column's covered print window, at most 64
  prints_floor?: number; // the size from which every print in that window is included; rises if the count cap excludes a size group
};

// A wall: a row that cleared the server's notional threshold, tracked until
// it fell under half of it. `ended_by` says whether price ate it (filled)
// or it was withdrawn (pulled); active walls carry null for both.
export type LiquidityLevel = {
  side: "bid" | "ask";
  row: number; // lowest row of the cluster
  span: number; // rows in the cluster, >= 1
  start_ts: number;
  end_ts: number | null;
  size: number;
  peak: number;
  // filled: most of what left it traded; partial: a meaningful share did; hit: price reached it
  // and it left mostly by cancelling; pulled: withdrawn before price got there; moved: pulled or
  // hit and re-placed within seconds
  ended_by: "filled" | "partial" | "hit" | "pulled" | "moved" | null;
  ratio: number; // peak as a multiple of the typical row near price when the wall qualified; 0 when unknown
  chain: number; // id of the first wall of the trace this wall belongs to; 0 when it never moved
  fill: number; // of the size that has left it so far, the share that traded rather than being cancelled, 0..1
  eaten: number; // of the most it ever held, the share that has traded on its rows, 0..1
  absorbing: boolean; // resting, being traded into, and still holding most of its peak
};

export type AggressiveEvent = {
  side: "buy" | "sell";
  row: number; // lowest row it printed on
  span: number; // rows, >= 1
  start_ts: number; // its first print
  end_ts: number | null; // its last print once it has gone quiet; null while printing
  volume: number; // aggressive volume printed so far
  peak: number; // the most it printed within one column; <= volume
  floor: number; // the server's floor it qualified against
};

export type LiquidityBackfillStatus = "RUNNING" | "COMPLETE" | "FAILED";

export type LiquidityBackfill = {
  status: LiquidityBackfillStatus;
  reason: string | null;
};

export type LiquidityFrame = {
  type: "liquidity";
  symbol: string;
  ts: number;
  seq: number;
  reset: boolean;
  row_width: number;
  column_ms: number;
  columns: LiquidityColumnFrame[];
  levels?: LiquidityLevel[]; // present when the wall set changed, and on a reset
  aggressive?: AggressiveEvent[]; // present when the cluster set changed, and on a reset
  backfill?: LiquidityBackfill; // history-fill progress for the pair; absent before a pass has started
} & FrameIdentity;

export const AGGRESSIVE_HISTORY_REASONS = [
  "CAP_REACHED",
  "STORAGE_UNAVAILABLE",
  "READ_FAILED",
  "CONVERSION_INCOMPLETE",
  "OVERLOADED",
] as const;
export type AggressiveHistoryReason =
  (typeof AGGRESSIVE_HISTORY_REASONS)[number];

export type AggressiveHistoryFrame = {
  type: "aggressive_history";
  symbol: string;
  request_id: number;
  from_ts: number;
  to_ts: number;
  min_size: number;
  complete: boolean;
  reason: AggressiveHistoryReason | null;
  next_cursor: string | null;
  retry_after_ms: number | null;
  trades: TradeFrame[];
} & FrameIdentity;

export const DELTA_PROFILE_REASONS = [
  "ROWS_CAPPED",
  "STORAGE_UNAVAILABLE",
  "READ_FAILED",
  "OVERLOADED",
  "BAD_REQUEST",
] as const;
export type DeltaProfileReason = (typeof DELTA_PROFILE_REASONS)[number];

/** One price row of a delta_profile piece: [price, buy, sell]. */
export type DeltaProfileRow = readonly [number, number, number];

export type DeltaProfileFrame = {
  type: "delta_profile";
  symbol: string;
  request_id: number;
  from_ts: number;
  to_ts: number;
  row_width: number;
  complete: boolean;
  reason: DeltaProfileReason | null;
  retry_after_ms: number | null;
  pending: number;
  rows: DeltaProfileRow[];
} & FrameIdentity;

export type MarkerHistoryFrame = {
  type: "marker_history";
  symbol: string;
  reset: boolean;
  seq: number;
  markers: MarkerFrame[];
} & FrameIdentity;

export type VpinFrame = {
  type: "vpin";
  symbol: string;
} & VpinReading &
  FrameIdentity;

export type AnalyticsStatusFrame = {
  type: "analytics_status";
  symbol: string;
  indicator: "PROFILE" | "VPIN";
  status: "READY" | "UNAVAILABLE" | "WARMING" | "EMPTY" | "CLOSED";
} & FrameIdentity;

export const BAND_HISTORY_REASONS = [
  "STORAGE_UNAVAILABLE",
  "READ_FAILED",
  "READ_TIMEOUT",
  "OVERLOADED",
  "GEOMETRY_UNAVAILABLE",
  "BAND_TOO_WIDE",
  "BAD_REQUEST",
] as const;
const BAND_HISTORY_ROWLESS_REASONS: ReadonlySet<unknown> = new Set([
  "GEOMETRY_UNAVAILABLE",
  "BAND_TOO_WIDE",
  "BAD_REQUEST",
]);
export type BandHistoryReason = (typeof BAND_HISTORY_REASONS)[number];
export const MAX_BAND_HISTORY_COLUMNS = 7_200;
export const MAX_BAND_HISTORY_ROWS = 256;

export type BandHistoryColumn = {
  ts: number;
  bid: number[];
  ask: number[];
  buy: number[];
  sell: number[];
};

export type BandHistoryFrame = {
  type: "band_history";
  symbol: string;
  request_id: number;
  from_ts: number;
  to_ts: number;
  price_lo: number;
  price_hi: number;
  column_ms: number;
  row_width: number | null;
  row_lo: number | null;
  row_hi: number | null;
  complete: boolean;
  reason: BandHistoryReason | null;
  retry_after_ms: number | null;
  columns: BandHistoryColumn[];
} & FrameIdentity;

export const HISTORY_REASONS = [
  "BAD_REQUEST",
  "OVERLOADED",
  "GEOMETRY_UNAVAILABLE",
  "HISTORY_UNAVAILABLE",
] as const;
export type HistoryReason = (typeof HISTORY_REASONS)[number];

export type WallHistoryDetailWire = {
  traded: number;
  absorbed: number;
  swept: number;
  hidden: number;
  cleared: number;
  cross_side: number;
  fill_ratio: number;
  first_shrink_ts: number | null;
  reached_at_first_shrink: boolean | null;
  end_distance_rows: number | null;
  cleared_by_trades: boolean;
  repeats: number;
  evidence_gap: boolean;
};

export type WallHistoryWallWire = {
  hid: number;
  side: "bid" | "ask";
  row: number;
  span: number;
  start_ts: number;
  end_ts: number;
  size: number;
  peak: number;
  ended_by: L2WallVerdict;
  ratio: number;
  chain: number;
  fill: number;
  eaten: number;
  detail: WallHistoryDetailWire | null;
};

export type WallHistoryFrame = {
  type: "wall_history";
  symbol: string;
  request_id: number;
  from_ts: number;
  to_ts: number;
  price_lo: number;
  price_hi: number;
  row_width: number | null;
  complete: boolean;
  reason: HistoryReason | null;
  retry_after_ms: number | null;
  walls: WallHistoryWallWire[];
  next: { end_ts: number; hid: number } | null;
} & FrameIdentity;

export type L2EventHistoryTradeRow = [number, number, number, "buy" | "sell", "absorbed" | "swept", number, number];
export type L2EventHistoryWallTradeRow = [number, string, "absorbed" | "swept", number, number];

export type L2EventHistoryFrame = {
  type: "l2_event_history";
  symbol: string;
  request_id: number;
  from_ts: number;
  to_ts: number;
  price_lo: number;
  price_hi: number;
  row_width: number | null;
  complete: boolean;
  reason: HistoryReason | null;
  retry_after_ms: number | null;
  trades: L2EventHistoryTradeRow[];
  wall_trades: L2EventHistoryWallTradeRow[];
  trades_held_from: number | null;
  next: {
    trades: { ts: number; row: number; aggressor: "buy" | "sell"; mode: "absorbed" | "swept" } | null;
    wall_trades: { ts: number; wall: string; mode: "absorbed" | "swept" } | null;
  } | null;
} & FrameIdentity;

export type L2Channel = "l2_view" | "l2_walls" | "l2_events" | "l2_ladder";
export type L2SegmentState = "LIVE" | "GAP";
export type L2Segment = { id: string; state: L2SegmentState };
export type L2WallVerdict = "filled" | "partial" | "hit" | "pulled" | "moved";

export type L2ViewFrame = {
  type: "l2_view";
  symbol: string;
  lane: number;
  tier: "recent" | "deep";
  ts: number;
  seq: number;
  reset: boolean;
  row_width: number;
  column_ms: number;
  columns: LiquidityColumnFrame[];
  segment: L2Segment | null;
} & FrameIdentity;

export type L2WallDetailWire = {
  life_ms: number | null;
  first_shrink_ts: number | null;
  first_shrink_exact: boolean;
  reached_at_first_shrink: boolean | null;
  traded: number;
  absorbed: number;
  swept: number;
  hidden: number;
  cleared: number;
  fill_ratio: number;
  cross_side: number;
  cross_side_share: number;
  end_distance_rows: number | null;
  end_distance_pct: number | null;
  cleared_by_trades: boolean;
  continuity: { gap_ms: number } | null;
  repeats: number;
  repeats_complete: boolean;
  evidence_gap: boolean;
};

export type L2WallWire = LiquidityLevel & { id: number; lane?: number; detail: L2WallDetailWire | null };

export type L2WallsFrame = {
  type: "l2_walls";
  symbol: string;
  ts: number;
  seq: number;
  reset: boolean;
  row_width: number;
  walls: L2WallWire[];
  removed: number[];
  segment: L2Segment | null;
} & FrameIdentity;

export type L2EventWire =
  | { event: "wall_born"; ts: number; wall: number; side: "bid" | "ask"; row: number; span: number; size: number }
  | { event: "wall_shrink"; ts: number; wall: number; exact: boolean; reached: boolean | null }
  | { event: "wall_trade"; ts: number; wall: number; mode: "absorbed" | "swept"; price: number; size: number }
  | { event: "wall_hidden"; ts: number; wall: number; volume: number }
  | { event: "wall_end"; ts: number; wall: number; ended_by: L2WallVerdict; distance_rows: number | null }
  | { event: "trade"; ts: number; side: "bid" | "ask"; aggressor: "buy" | "sell"; mode: "absorbed" | "swept"; price: number; size: number; late: boolean }
  | { event: "hidden"; ts: number; side: "bid" | "ask"; price: number; volume: number }
  | { event: "segment"; ts: number; segment: string; state: L2SegmentState; cause: string | null };

export type L2EventsFrame = {
  type: "l2_events";
  symbol: string;
  ts: number;
  seq: number;
  reset: boolean;
  missed: number;
  events: L2EventWire[];
} & FrameIdentity;

export type L2LadderFrame = {
  type: "l2_ladder";
  symbol: string;
  ts: number;
  depth: number;
  bids: [price: number, size: number][];
  asks: [price: number, size: number][];
  segment: L2Segment | null;
} & FrameIdentity;

export type IcebergKind = "native" | "probable";
export type IcebergConfidence = "certain" | "strong" | "probable" | "weak";
export type IcebergStatus = "active" | "filled" | "pulled" | "replaced" | "interrupted" | "ended";
export type IcebergOrigin = "runtime" | "host";

export type IcebergOrder = {
  id: string;
  kind: IcebergKind;
  confidence: IcebergConfidence;
  side: "bid" | "ask";
  price: number;
  display: number;
  tranches: number;
  executed: number;
  startedAt: number;
  markedAt: number;
  updatedAt: number;
  status: IcebergStatus;
  origin: IcebergOrigin;
};

export type IcebergOrdersFrame = {
  type: "iceberg_orders";
  symbol: string;
  ts: number;
  seq: number;
  reset: boolean;
  icebergs: IcebergOrder[];
  watched: ReadonlyArray<readonly [number, number]>;
  liveSince: number;
} & FrameIdentity;

export type ExhaustionCandleMs = 60000 | 120000 | 180000 | 300000 | 900000 | 1800000 | 3600000 | 14400000 | 21600000 | 43200000 | 86400000;
export type ExhaustionSide = "buyers" | "sellers";
export type ExhaustionStatus = "open" | "pending" | "held" | "broke" | "interrupted";
export type ExhaustionOrigin = "runtime" | "host" | "stored";

export type ExhaustionReadings = {
  rate: boolean;
  progress: boolean;
  delta: boolean;
  divergence: boolean;
  prints: boolean;
  book: boolean;
};

export type ExhaustionRaw = {
  own: number | null;
  other: number | null;
  legOwn: number | null;
  moved: number | null;
  legMoved: number | null;
  big: number | null;
  legBig: number | null;
  extremeOwn: number | null;
  extremeOther: number | null;
  bookNow: number | null;
  bookAt: number | null;
  bookBand: 0 | 1 | 2 | null;
};

export type ExhaustionValues = {
  rate: number | null;
  progress: number | null;
  delta: number | null;
  divergence: number | null;
  prints: number | null;
  book: number | null;
};

export type ExhaustionShade = {
  id: string;
  candleMs: ExhaustionCandleMs;
  side: ExhaustionSide;
  status: ExhaustionStatus;
  intensity: number;
  score: number;
  readings: ExhaustionReadings;
  values: ExhaustionValues;
  raw: ExhaustionRaw;
  startTs: number;
  endTs: number;
  extremeTs: number;
  extremePrice: number;
  legStartTs: number;
  legStartPrice: number;
  legSize: number;
  efficiency: number;
  atr: number;
  judgedAt: number | null;
  updatedAt: number;
  origin: ExhaustionOrigin;
};

export type ExhaustionShadesFrame = {
  type: "exhaustion_shades";
  symbol: string;
  ts: number;
  seq: number;
  reset: boolean;
  shades: ExhaustionShade[];
  liveSince: number;
  loading: number | null;
} & FrameIdentity;

export type InitiativeSide = "up" | "down";
export type InitiativeDominant = "buyers" | "sellers";
export type InitiativeOrigin = "runtime" | "host" | "stored";

export type InitiativeFacts = {
  efficiency: { yes: boolean; value: number | null };
  closes: { yes: boolean; value: number };
  burst: { yes: boolean; value: number | null };
  delta: { yes: boolean; rank: number | null; share: number | null };
  prints: { yes: boolean; rank: number | null; perCandle: number | null };
};

export type InitiativeBand = {
  id: string;
  candleMs: ExhaustionCandleMs;
  side: InitiativeSide;
  dominant: InitiativeDominant;
  dominantShare: number;
  score: number;
  facts: InitiativeFacts;
  pivotTs: number;
  pivotPrice: number;
  frozenTs: number;
  frozenPrice: number;
  windowCandles: number;
  atr: number;
  legExtremePrice: number;
  legExtremeTs: number;
  legEndTs: number | null;
  updatedAt: number;
  origin: InitiativeOrigin;
};

export type InitiativeBandsFrame = {
  type: "initiative_bands";
  symbol: string;
  ts: number;
  seq: number;
  reset: boolean;
  bands: InitiativeBand[];
  liveSince: number;
  loading: number | null;
} & FrameIdentity;

export type CandleMonitorTrade = {
  price: number;
  size: number;
};

export type CandleMonitorEntry = {
  candleMs: ExhaustionCandleMs;
  candleTs: number;
  buy: number;
  sell: number;
  biggestBuy: CandleMonitorTrade | null;
  biggestSell: CandleMonitorTrade | null;
};

export type CandleMonitorFrame = {
  type: "candle_monitor";
  symbol: string;
  ts: number;
  entries: CandleMonitorEntry[];
} & FrameIdentity;

export type ServerFrame =
  | ExhaustionShadesFrame
  | InitiativeBandsFrame
  | CandleMonitorFrame
  | IcebergOrdersFrame
  | L2ViewFrame
  | L2WallsFrame
  | L2EventsFrame
  | L2LadderFrame
  | AnalyticsStatusFrame
  | TradeFrame
  | AggressiveHistoryFrame
  | DeltaProfileFrame
  | BandHistoryFrame
  | WallHistoryFrame
  | L2EventHistoryFrame
  | MarkerHistoryFrame
  | MarkerFrame
  | BarFrame
  | SnapshotFrame
  | HealthFrame
  | BookFrame
  | SelectionFrame
  | ProfileFrame
  | VpinFrame
  | LiquidityFrame;

export function isTradeFrame(frame: ServerFrame): frame is TradeFrame {
  return frame.type === "trade";
}

export function isMarkerFrame(frame: ServerFrame): frame is MarkerFrame {
  return frame.type === "marker";
}

export function isBarFrame(frame: ServerFrame): frame is BarFrame {
  return frame.type === "bar";
}

export function isSnapshotFrame(frame: ServerFrame): frame is SnapshotFrame {
  return frame.type === "snapshot";
}

export function isHealthFrame(frame: ServerFrame): frame is HealthFrame {
  return frame.type === "health";
}

export function isBookFrame(frame: ServerFrame): frame is BookFrame {
  return frame.type === "book";
}

export function isSelectionFrame(frame: ServerFrame): frame is SelectionFrame {
  return frame.type === "selection";
}

export function isProfileFrame(frame: ServerFrame): frame is ProfileFrame {
  return frame.type === "profile";
}

export function isVpinFrame(frame: ServerFrame): frame is VpinFrame {
  return frame.type === "vpin";
}

export function isLiquidityFrame(frame: ServerFrame): frame is LiquidityFrame {
  return frame.type === "liquidity";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const MAX_VALID_EPOCH_MS = 8_640_000_000_000_000;

function isValidEpochTimestamp(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= MAX_VALID_EPOCH_MS;
}

const MAX_REASONABLE_MAGNITUDE = 10_000_000;

function isPositiveFiniteNumber(value: unknown): value is number {
  return (
    isFiniteNumber(value) && value > 0 && value <= MAX_REASONABLE_MAGNITUDE
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return (
    isFiniteNumber(value) && value >= 0 && value <= MAX_REASONABLE_MAGNITUDE
  );
}

const MAX_PROFILE_VOLUME = 1_000_000_000_000;
const MAX_BAR_VOLUME = 1_000_000_000_000;
const MAX_EQUITY_TRADE_SIZE = 1_000_000_000_000;

export function sizeCeilingFor(identity: FrameIdentity): number {
  return identity.provider === "DXFEED" && identity.assetClass === "EQUITY"
    ? MAX_EQUITY_TRADE_SIZE
    : MAX_REASONABLE_MAGNITUDE;
}

function isSizeWithin(value: unknown, ceiling: number): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= ceiling;
}

function isPrintsFloorWithin(value: unknown, ceiling: number): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= ceiling + Number.EPSILON * Math.max(1, ceiling);
}

function isTradeSize(value: unknown, identity: FrameIdentity): value is number {
  return isFiniteNumber(value) && value > 0 && value <= sizeCeilingFor(identity);
}

function isProfileVolume(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_PROFILE_VOLUME;
}

function isBarVolume(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_BAR_VOLUME;
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function isValidTradeId(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.length > MAX_TRADE_ID_LENGTH)
    return false;
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function isMarketKind(value: unknown): value is MarketKind {
  return value === "SPOT" || value === "PERPETUAL";
}

function isAssetClass(value: unknown): value is AssetClass {
  return value === "FUTURE" || value === "EQUITY";
}

const DXFEED_FUTURES_SYMBOL_PATTERN =
  /^(\/[A-Z]{2,3})[FGHJKMNQUVXZ]\d{2}:[A-Z]+$/;

const DXFEED_CATALOG = marketInstrumentCatalog.dxfeed as ReadonlyArray<{
  readonly symbol: string;
  readonly assetClass: string;
}>;

const ALLOWED_SYMBOLS = new Set(
  (
    marketInstrumentCatalog.binance as ReadonlyArray<{
      readonly symbol: string;
    }>
  ).map((entry) => entry.symbol),
);
const DXFEED_EQUITY_SYMBOLS = new Set(
  DXFEED_CATALOG.filter((entry) => entry.assetClass === "EQUITY").map(
    (entry) => entry.symbol,
  ),
);
const DXFEED_FUTURES_ROOTS = new Set(
  DXFEED_CATALOG.filter((entry) => entry.assetClass === "FUTURE")
    .map((entry) => entry.symbol.match(DXFEED_FUTURES_SYMBOL_PATTERN)?.[1])
    .filter((root): root is string => typeof root === "string"),
);
const BASE_BAR_INTERVAL_MS = 60_000;
const MAX_SNAPSHOT_BARS = 10_080;
const MAX_SNAPSHOT_TRADES = 100;
const MAX_SNAPSHOT_MARKERS = 5_000;
const MAX_MARKER_HISTORY_ROWS = 5_000;
export const CLIENT_CAPABILITIES: readonly string[] = Object.freeze(["marker_history", "l2_view", "l2_walls", "l2_walls_lanes", "l2_events", "l2_ladder", "iceberg_orders", "exhaustion_shades", "initiative_bands"]);
const MAX_ICEBERG_ORDERS = 500;
const MAX_ICEBERG_ID_LENGTH = 96;
const MAX_WATCHED_SPANS = 64;
const MAX_EXHAUSTION_SHADES = 500;
const MAX_CANDLE_MONITOR_ENTRIES = 11;
const MAX_CANDLE_MONITOR_AMOUNT = 1_000_000_000;
const CANDLE_MONITOR_ENTRY_KEYS = 6;
const MAX_EXHAUSTION_ID_LENGTH = 96;
const MAX_EXHAUSTION_INTENSITY = 3;
const MAX_EXHAUSTION_SCORE = 6;
const MAX_EXHAUSTION_VALUE = 1_000_000;
const MAX_EXHAUSTION_RAW = 1_000_000_000;
const EXHAUSTION_RAW_KEYS: readonly string[] = Object.freeze(["own", "other", "legOwn", "moved", "legMoved", "big", "legBig", "extremeOwn", "extremeOther", "bookNow", "bookAt", "bookBand"]);
const EXHAUSTION_CANDLE_MS: ReadonlySet<number> = new Set([60000, 120000, 180000, 300000, 900000, 1800000, 3600000, 14400000, 21600000, 43200000, 86400000]);
const EXHAUSTION_SIDES: ReadonlySet<string> = new Set(["buyers", "sellers"]);
const EXHAUSTION_STATUSES: ReadonlySet<string> = new Set(["open", "pending", "held", "broke", "interrupted"]);
const EXHAUSTION_ORIGINS: ReadonlySet<string> = new Set(["runtime", "host", "stored"]);
const EXHAUSTION_READINGS: readonly string[] = Object.freeze(["rate", "progress", "delta", "divergence", "prints", "book"]);
const EXHAUSTION_FINAL_STATUSES: ReadonlySet<string> = new Set(["held", "broke", "interrupted"]);
const MAX_INITIATIVE_BANDS = 500;
const MAX_INITIATIVE_ID_LENGTH = 96;
const MAX_INITIATIVE_SCORE = 5;
const MAX_INITIATIVE_VALUE = 1_000_000;
const MAX_INITIATIVE_WINDOW = 1_000;
const INITIATIVE_BAND_KEYS = 18;
const INITIATIVE_CANDLE_MS: ReadonlySet<number> = new Set([60000, 120000, 180000, 300000, 900000, 1800000, 3600000, 14400000, 21600000, 43200000, 86400000]);
const INITIATIVE_SIDES: ReadonlySet<string> = new Set(["up", "down"]);
const INITIATIVE_DOMINANTS: ReadonlySet<string> = new Set(["buyers", "sellers"]);
const INITIATIVE_ORIGINS: ReadonlySet<string> = new Set(["runtime", "host", "stored"]);
const INITIATIVE_FACTS: readonly string[] = Object.freeze(["efficiency", "closes", "burst", "delta", "prints"]);
const INITIATIVE_FACT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  efficiency: Object.freeze(["yes", "value"]),
  closes: Object.freeze(["yes", "value"]),
  burst: Object.freeze(["yes", "value"]),
  delta: Object.freeze(["yes", "rank", "share"]),
  prints: Object.freeze(["yes", "rank", "perCandle"]),
});
const ICEBERG_KINDS: ReadonlySet<string> = new Set(["native", "probable"]);
const ICEBERG_CONFIDENCES: ReadonlySet<string> = new Set(["certain", "strong", "probable", "weak"]);
const ICEBERG_STATUSES: ReadonlySet<string> = new Set(["active", "filled", "pulled", "replaced", "interrupted", "ended"]);
const ICEBERG_ORIGINS: ReadonlySet<string> = new Set(["runtime", "host"]);
export const L2_CHANNELS: readonly L2Channel[] = Object.freeze(["l2_view", "l2_walls", "l2_events", "l2_ladder"]);
const MAX_L2_LANE = 6;
const MAX_L2_WALLS = 1_000;
const MAX_L2_REMOVED = 1_000;
const MAX_L2_EVENTS = 500;
const MAX_L2_LADDER_LEVELS = 50;
const MAX_L2_SEGMENT_ID_LENGTH = 160;
const MAX_BOOK_LEVELS = 20;
const MAX_REASON_LENGTH = 256;
const MAX_TRADE_ID_LENGTH = 128;
export const MAX_LIVE_FRAME_FUTURE_SKEW_MS = 120_000;
export const MAX_LIVE_FRAME_AGE_MS = 8 * 24 * 60 * 60 * 1_000;

type FrameParseContext = { nowMs?: number };

function timestampWithinLiveWindow(
  timestamp: number,
  context: FrameParseContext,
): boolean {
  if (context.nowMs === undefined) return true;
  if (!isNonNegativeSafeInteger(context.nowMs)) return false;
  return (
    timestamp <= context.nowMs + MAX_LIVE_FRAME_FUTURE_SKEW_MS &&
    timestamp >= context.nowMs - MAX_LIVE_FRAME_AGE_MS
  );
}

function timestampNotTooFarInFuture(
  timestamp: number,
  context: FrameParseContext,
): boolean {
  if (context.nowMs === undefined) return true;
  if (!isNonNegativeSafeInteger(context.nowMs)) return false;
  return timestamp <= context.nowMs + MAX_LIVE_FRAME_FUTURE_SKEW_MS;
}

export function isAllowedSymbol(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_SYMBOLS.has(value);
}

function dxfeedFuturesRootOf(symbol: string): string | null {
  const match = symbol.match(DXFEED_FUTURES_SYMBOL_PATTERN);
  return match ? match[1] : null;
}

function isAllowedDxFeedSymbol(
  symbol: unknown,
  assetClass: unknown,
): symbol is string {
  if (typeof symbol !== "string") return false;
  if (assetClass === "EQUITY") return DXFEED_EQUITY_SYMBOLS.has(symbol);
  if (assetClass === "FUTURE") {
    const root = dxfeedFuturesRootOf(symbol);
    return root !== null && DXFEED_FUTURES_ROOTS.has(root);
  }
  return false;
}

function isValidReason(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= MAX_REASON_LENGTH;
}

function hasExactKeys(
  raw: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(raw);
  if (
    keys.length < required.length ||
    keys.length > required.length + optional.length
  )
    return false;
  return (
    required.every((key) => Object.hasOwn(raw, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function hasExactFrameKeys(
  raw: Record<string, unknown>,
  identity: FrameIdentity,
  fields: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const identityField =
    identity.provider === "BINANCE" ? "marketKind" : "assetClass";
  const keys = Object.keys(raw);
  const requiredLength = 4 + fields.length;
  if (
    keys.length < requiredLength ||
    keys.length > requiredLength + optional.length
  )
    return false;
  if (
    !Object.hasOwn(raw, "type") ||
    !Object.hasOwn(raw, "provider") ||
    !Object.hasOwn(raw, "symbol") ||
    !Object.hasOwn(raw, identityField) ||
    !fields.every((key) => Object.hasOwn(raw, key))
  )
    return false;
  return keys.every(
    (key) =>
      key === "type" ||
      key === "provider" ||
      key === "symbol" ||
      key === identityField ||
      fields.includes(key) ||
      optional.includes(key),
  );
}

const TRADE_FRAME_FIELDS = [
  "ts_exchange",
  "price",
  "size",
  "side",
  "trade_id",
] as const;
const MARKER_FRAME_OPTIONAL_FIELDS = [
  "baseline_log_median",
  "baseline_log_mad",
] as const;
const BAR_FRAME_FIELDS = [
  "interval_ms",
  "ts_open",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "trade_count",
  "closed",
] as const;
const BINANCE_BAR_OPTIONAL_FIELDS = [
  "buy_volume",
  "sell_volume",
  "reconstructed",
] as const;
const DXFEED_BAR_OPTIONAL_FIELDS = ["buy_volume", "sell_volume"] as const;
const SNAPSHOT_FRAME_FIELDS = ["bars", "trades", "markers"] as const;
const AGGRESSIVE_HISTORY_FRAME_FIELDS = [
  "request_id",
  "from_ts",
  "to_ts",
  "min_size",
  "complete",
  "reason",
  "next_cursor",
  "retry_after_ms",
  "trades",
] as const;
const MAX_AGGRESSIVE_HISTORY_TRADES = 10_000;
const DELTA_PROFILE_FRAME_FIELDS = [
  "request_id",
  "from_ts",
  "to_ts",
  "row_width",
  "complete",
  "reason",
  "retry_after_ms",
  "pending",
  "rows",
] as const;
export const MAX_DELTA_PROFILE_ROWS = 8_192;
const MAX_AGGRESSIVE_POOL_PRINTS = 20_000;
const SNAPSHOT_POOL_FIELDS = [
  "aggressive_prints",
  "aggressive_prints_floor",
  "aggressive_prints_from",
] as const;
const SNAPSHOT_FRAME_OPTIONAL_FIELDS_BINANCE = [
  "vpin_readings",
  "vpin_status",
  ...SNAPSHOT_POOL_FIELDS,
] as const;
const SNAPSHOT_FRAME_OPTIONAL_FIELDS_DXFEED = [
  "bar_history",
  "vpin_readings",
  "vpin_status",
  ...SNAPSHOT_POOL_FIELDS,
] as const;
const HEALTH_FRAME_FIELDS = ["recoveryState", "stale"] as const;
const BINANCE_HEALTH_OPTIONAL_FIELDS = [
  "reason",
  "recordingStale",
  "recordingLatestTs",
] as const;
const DXFEED_HEALTH_OPTIONAL_FIELDS = ["printsQuiet", "reason"] as const;
const PROFILE_FRAME_FIELDS = [
  "mode",
  "delivery_scope",
  "history_request_id",
  "period_start_ts",
  "period_end_ts",
  "row_width",
  "buckets",
  "poc_price",
  "vah_price",
  "val_price",
] as const;
const VPIN_READING_FIELDS = [
  "seal_ts",
  "active",
  "direction",
  "strength",
  "z_vpin",
  "z_velocity",
  "z_acceleration",
  "activated_at_ts",
] as const;
const MAX_SNAPSHOT_VPIN_READINGS = 5_000;

export function parseFrameIdentity(
  raw: Record<string, unknown>,
): FrameIdentity | null {
  if (raw.provider === "BINANCE") {
    if (
      Object.hasOwn(raw, "assetClass") ||
      !isAllowedSymbol(raw.symbol) ||
      !isMarketKind(raw.marketKind)
    )
      return null;
    return { provider: "BINANCE", marketKind: raw.marketKind };
  }
  if (raw.provider === "DXFEED") {
    if (
      Object.hasOwn(raw, "marketKind") ||
      !isAssetClass(raw.assetClass) ||
      !isAllowedDxFeedSymbol(raw.symbol, raw.assetClass)
    )
      return null;
    return { provider: "DXFEED", assetClass: raw.assetClass };
  }
  return null;
}

export function identitiesMatch(a: FrameIdentity, b: FrameIdentity): boolean {
  if (a.provider !== b.provider) return false;
  if (a.provider === "BINANCE" && b.provider === "BINANCE")
    return a.marketKind === b.marketKind;
  if (a.provider === "DATABENTO" && b.provider === "DATABENTO")
    return a.assetClass === b.assetClass;
  if (a.provider === "DXFEED" && b.provider === "DXFEED")
    return a.assetClass === b.assetClass;
  return false;
}

function parseTradeFrame(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): TradeFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(
      raw,
      identity,
      TRADE_FRAME_FIELDS,
      identity.provider === "DXFEED" ? ["auction"] : [],
    ) ||
    (raw.auction !== undefined && raw.auction !== true) ||
    !isValidEpochTimestamp(raw.ts_exchange) ||
    !timestampWithinLiveWindow(raw.ts_exchange, context) ||
    !isPositiveFiniteNumber(raw.price) ||
    !isTradeSize(raw.size, identity) ||
    (raw.side !== "buy" && raw.side !== "sell") ||
    !isValidTradeId(raw.trade_id)
  ) {
    return null;
  }
  return {
    type: "trade",
    symbol: raw.symbol as string,
    ...identity,
    ts_exchange: raw.ts_exchange,
    price: raw.price,
    size: raw.size,
    side: raw.side,
    trade_id: raw.trade_id,
    ...(raw.auction === true ? { auction: true as const } : {}),
  };
}

function parseAggressiveHistoryFrame(
  raw: Record<string, unknown>,
): AggressiveHistoryFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, AGGRESSIVE_HISTORY_FRAME_FIELDS) ||
    !isNonNegativeSafeInteger(raw.request_id) ||
    !isValidEpochTimestamp(raw.from_ts) ||
    !isValidEpochTimestamp(raw.to_ts) ||
    (raw.to_ts as number) <= (raw.from_ts as number) ||
    typeof raw.min_size !== "number" ||
    !Number.isFinite(raw.min_size) ||
    raw.min_size < 0 ||
    typeof raw.complete !== "boolean" ||
    !validAggressiveHistoryReason(raw.complete, raw.reason) ||
    !validAggressiveHistoryCursor(raw.reason, raw.next_cursor) ||
    !validAggressiveHistoryRetryAfter(raw.reason, raw.retry_after_ms) ||
    !Array.isArray(raw.trades) ||
    raw.trades.length > MAX_AGGRESSIVE_HISTORY_TRADES
  ) {
    return null;
  }
  const trades: TradeFrame[] = [];
  let previousTs = -1;
  for (const entry of raw.trades) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as Record<string, unknown>).type !== "trade"
    )
      return null;
    const trade = parseTradeFrame(entry as Record<string, unknown>, {});
    if (
      !trade ||
      trade.symbol !== raw.symbol ||
      !identitiesMatch(trade, identity) ||
      trade.ts_exchange < previousTs
    )
      return null;
    previousTs = trade.ts_exchange;
    trades.push(trade);
  }
  return {
    type: "aggressive_history",
    symbol: raw.symbol as string,
    ...identity,
    request_id: raw.request_id as number,
    from_ts: raw.from_ts as number,
    to_ts: raw.to_ts as number,
    min_size: raw.min_size as number,
    complete: raw.complete as boolean,
    reason: raw.reason as AggressiveHistoryReason | null,
    next_cursor: raw.next_cursor as string | null,
    retry_after_ms: raw.retry_after_ms as number | null,
    trades,
  };
}

function validDeltaProfileReason(complete: boolean, reason: unknown): boolean {
  if (complete) return reason === null;
  return typeof reason === "string" && (DELTA_PROFILE_REASONS as readonly string[]).includes(reason);
}

function parseDeltaProfileRows(raw: unknown, complete: boolean): DeltaProfileRow[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_DELTA_PROFILE_ROWS || (!complete && raw.length > 0)) return null;
  const rows: DeltaProfileRow[] = [];
  let previousPrice = 0;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [price, buy, sell] = entry as unknown[];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= previousPrice) return null;
    for (const volume of [buy, sell]) {
      if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > MAX_PROFILE_VOLUME) return null;
    }
    previousPrice = price;
    rows.push([price, buy as number, sell as number]);
  }
  return rows;
}

function parseDeltaProfileFrame(raw: Record<string, unknown>): DeltaProfileFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, DELTA_PROFILE_FRAME_FIELDS) ||
    !isNonNegativeSafeInteger(raw.request_id) ||
    !isValidEpochTimestamp(raw.from_ts) ||
    !isValidEpochTimestamp(raw.to_ts) ||
    (raw.to_ts as number) <= (raw.from_ts as number) ||
    typeof raw.row_width !== "number" || !Number.isFinite(raw.row_width) || raw.row_width <= 0 ||
    typeof raw.complete !== "boolean" ||
    !validDeltaProfileReason(raw.complete, raw.reason) ||
    !validAggressiveHistoryRetryAfter(raw.reason, raw.retry_after_ms) ||
    !isNonNegativeSafeInteger(raw.pending)
  ) {
    return null;
  }
  const rows = parseDeltaProfileRows(raw.rows, raw.complete);
  if (rows === null) return null;
  return {
    type: "delta_profile",
    symbol: raw.symbol as string,
    ...identity,
    request_id: raw.request_id as number,
    from_ts: raw.from_ts as number,
    to_ts: raw.to_ts as number,
    row_width: raw.row_width,
    complete: raw.complete,
    reason: raw.reason as DeltaProfileReason | null,
    retry_after_ms: raw.retry_after_ms as number | null,
    pending: raw.pending as number,
    rows,
  };
}

const BAND_HISTORY_FRAME_FIELDS = [
  "request_id",
  "from_ts",
  "to_ts",
  "price_lo",
  "price_hi",
  "column_ms",
  "row_width",
  "row_lo",
  "row_hi",
  "complete",
  "reason",
  "retry_after_ms",
  "columns",
] as const;

function validBandHistoryValues(
  values: unknown,
  rows: number,
  sizeCeiling: number,
): values is number[] {
  return (
    Array.isArray(values) &&
    values.length === rows &&
    values.every((value) => isSizeWithin(value, sizeCeiling))
  );
}

const HISTORY_ROWLESS_REASONS: ReadonlySet<unknown> = new Set(["BAD_REQUEST", "GEOMETRY_UNAVAILABLE", "HISTORY_UNAVAILABLE"]);
const WALL_HISTORY_FRAME_FIELDS = ["request_id", "from_ts", "to_ts", "price_lo", "price_hi", "row_width", "complete", "reason", "retry_after_ms", "walls", "next"] as const;
const L2_EVENT_HISTORY_FRAME_FIELDS = ["request_id", "from_ts", "to_ts", "price_lo", "price_hi", "row_width", "complete", "reason", "retry_after_ms", "trades", "wall_trades", "trades_held_from", "next"] as const;
const MAX_HISTORY_WALLS = 400;
const MAX_HISTORY_EVENTS = 2_000;
const HISTORY_WALL_VERDICTS: ReadonlySet<unknown> = new Set(["filled", "partial", "hit", "pulled", "moved"]);
const HISTORY_AGGRESSORS: ReadonlySet<unknown> = new Set(["buy", "sell"]);
const HISTORY_MODES: ReadonlySet<unknown> = new Set(["absorbed", "swept"]);

function isHistoryAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHistoryShare(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validHistoryHead(raw: Record<string, unknown>, identity: FrameIdentity, fields: readonly string[]): boolean {
  if (
    !hasExactFrameKeys(raw, identity, fields) ||
    !isNonNegativeSafeInteger(raw.request_id) ||
    !isValidEpochTimestamp(raw.from_ts) ||
    !isValidEpochTimestamp(raw.to_ts) ||
    (raw.to_ts as number) < (raw.from_ts as number) ||
    typeof raw.price_lo !== "number" || !Number.isFinite(raw.price_lo) || raw.price_lo <= 0 ||
    typeof raw.price_hi !== "number" || !Number.isFinite(raw.price_hi) || raw.price_hi < raw.price_lo ||
    typeof raw.complete !== "boolean" ||
    (raw.complete ? raw.reason !== null : typeof raw.reason !== "string" || !(HISTORY_REASONS as readonly string[]).includes(raw.reason)) ||
    !validAggressiveHistoryRetryAfter(raw.reason, raw.retry_after_ms)
  ) return false;
  const geometryKnown = !HISTORY_ROWLESS_REASONS.has(raw.reason);
  if (geometryKnown) return typeof raw.row_width === "number" && Number.isFinite(raw.row_width) && raw.row_width > 0;
  return raw.row_width === null;
}

function historyHead(raw: Record<string, unknown>) {
  return {
    symbol: raw.symbol as string,
    request_id: raw.request_id as number,
    from_ts: raw.from_ts as number,
    to_ts: raw.to_ts as number,
    price_lo: raw.price_lo as number,
    price_hi: raw.price_hi as number,
    row_width: raw.row_width as number | null,
    complete: raw.complete as boolean,
    reason: raw.reason as HistoryReason | null,
    retry_after_ms: raw.retry_after_ms as number | null,
  };
}

function parseWallHistoryDetail(raw: unknown): WallHistoryDetailWire | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const detail = raw as Record<string, unknown>;
  for (const field of ["traded", "absorbed", "swept", "hidden", "cleared", "cross_side"]) if (!isHistoryAmount(detail[field])) return undefined;
  if (
    !isHistoryShare(detail.fill_ratio) ||
    (detail.first_shrink_ts !== null && !isValidEpochTimestamp(detail.first_shrink_ts)) ||
    (detail.reached_at_first_shrink !== null && typeof detail.reached_at_first_shrink !== "boolean") ||
    (detail.end_distance_rows !== null && !isHistoryAmount(detail.end_distance_rows)) ||
    typeof detail.cleared_by_trades !== "boolean" ||
    !Number.isSafeInteger(detail.repeats) || (detail.repeats as number) < 1 ||
    typeof detail.evidence_gap !== "boolean"
  ) return undefined;
  return {
    traded: detail.traded as number,
    absorbed: detail.absorbed as number,
    swept: detail.swept as number,
    hidden: detail.hidden as number,
    cleared: detail.cleared as number,
    cross_side: detail.cross_side as number,
    fill_ratio: detail.fill_ratio as number,
    first_shrink_ts: detail.first_shrink_ts as number | null,
    reached_at_first_shrink: detail.reached_at_first_shrink as boolean | null,
    end_distance_rows: detail.end_distance_rows as number | null,
    cleared_by_trades: detail.cleared_by_trades as boolean,
    repeats: detail.repeats as number,
    evidence_gap: detail.evidence_gap as boolean,
  };
}

function parseWallHistoryWall(raw: unknown): WallHistoryWallWire | null {
  if (typeof raw !== "object" || raw === null) return null;
  const wall = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(wall.hid) || (wall.hid as number) < 1 ||
    (wall.side !== "bid" && wall.side !== "ask") ||
    !isNonNegativeSafeInteger(wall.row) ||
    !Number.isSafeInteger(wall.span) || (wall.span as number) < 1 ||
    !isValidEpochTimestamp(wall.start_ts) ||
    !isValidEpochTimestamp(wall.end_ts) ||
    (wall.end_ts as number) < (wall.start_ts as number) ||
    !isHistoryAmount(wall.size) || !isHistoryAmount(wall.peak) || (wall.peak as number) < (wall.size as number) ||
    !HISTORY_WALL_VERDICTS.has(wall.ended_by) ||
    !isHistoryAmount(wall.ratio) ||
    !isNonNegativeSafeInteger(wall.chain) ||
    !isHistoryShare(wall.fill) || !isHistoryShare(wall.eaten)
  ) return null;
  const detail = parseWallHistoryDetail(wall.detail);
  if (detail === undefined) return null;
  return {
    hid: wall.hid as number,
    side: wall.side,
    row: wall.row as number,
    span: wall.span as number,
    start_ts: wall.start_ts as number,
    end_ts: wall.end_ts as number,
    size: wall.size as number,
    peak: wall.peak as number,
    ended_by: wall.ended_by as L2WallVerdict,
    ratio: wall.ratio as number,
    chain: wall.chain as number,
    fill: wall.fill as number,
    eaten: wall.eaten as number,
    detail,
  };
}

function parseWallHistoryFrame(raw: Record<string, unknown>): WallHistoryFrame | null {
  const identity = parseFrameIdentity(raw);
  if (!identity || !validHistoryHead(raw, identity, WALL_HISTORY_FRAME_FIELDS)) return null;
  if (!Array.isArray(raw.walls) || raw.walls.length > MAX_HISTORY_WALLS || (!raw.complete && raw.walls.length > 0)) return null;
  const walls: WallHistoryWallWire[] = [];
  const seen = new Set<number>();
  let previous: WallHistoryWallWire | null = null;
  for (const entry of raw.walls) {
    const wall = parseWallHistoryWall(entry);
    if (wall === null || seen.has(wall.hid)) return null;
    if (previous !== null && (wall.end_ts < previous.end_ts || (wall.end_ts === previous.end_ts && wall.hid <= previous.hid))) return null;
    seen.add(wall.hid);
    previous = wall;
    walls.push(wall);
  }
  let next: WallHistoryFrame["next"] = null;
  if (raw.next !== null) {
    if (typeof raw.next !== "object" || raw.next === null || !raw.complete) return null;
    const cursor = raw.next as Record<string, unknown>;
    if (Object.keys(cursor).length !== 2 || !isValidEpochTimestamp(cursor.end_ts) || !Number.isSafeInteger(cursor.hid) || (cursor.hid as number) < 1) return null;
    next = { end_ts: cursor.end_ts as number, hid: cursor.hid as number };
  }
  return { type: "wall_history", ...identity, ...historyHead(raw), walls, next };
}

function parseL2EventHistoryTradeRow(raw: unknown): L2EventHistoryTradeRow | null {
  if (!Array.isArray(raw) || raw.length !== 7) return null;
  const [ts, columnMs, row, aggressor, mode, size, count] = raw;
  if (
    !isValidEpochTimestamp(ts) || !Number.isSafeInteger(columnMs) || (columnMs as number) <= 0 || !isNonNegativeSafeInteger(row) ||
    !HISTORY_AGGRESSORS.has(aggressor) || !HISTORY_MODES.has(mode) || !isHistoryAmount(size) || (size as number) <= 0 || !Number.isSafeInteger(count) || (count as number) < 1
  ) return null;
  return [ts as number, columnMs as number, row as number, aggressor as "buy" | "sell", mode as "absorbed" | "swept", size as number, count as number];
}

function parseL2EventHistoryWallTradeRow(raw: unknown): L2EventHistoryWallTradeRow | null {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const [ts, wall, mode, size, count] = raw;
  if (
    !isValidEpochTimestamp(ts) || typeof wall !== "string" || wall.length === 0 || wall.length > 80 ||
    !HISTORY_MODES.has(mode) || !isHistoryAmount(size) || (size as number) <= 0 || !Number.isSafeInteger(count) || (count as number) < 1
  ) return null;
  return [ts as number, wall, mode as "absorbed" | "swept", size as number, count as number];
}

function parseL2EventHistoryFrame(raw: Record<string, unknown>): L2EventHistoryFrame | null {
  const identity = parseFrameIdentity(raw);
  if (!identity || !validHistoryHead(raw, identity, L2_EVENT_HISTORY_FRAME_FIELDS)) return null;
  if (!Array.isArray(raw.trades) || raw.trades.length > MAX_HISTORY_EVENTS || !Array.isArray(raw.wall_trades) || raw.wall_trades.length > MAX_HISTORY_EVENTS) return null;
  if (!raw.complete && (raw.trades.length > 0 || raw.wall_trades.length > 0)) return null;
  const heldFrom = raw.trades_held_from;
  if (raw.complete ? !isValidEpochTimestamp(heldFrom) || heldFrom < (raw.from_ts as number) || heldFrom > (raw.to_ts as number) : heldFrom !== null) return null;
  const trades: L2EventHistoryTradeRow[] = [];
  for (const entry of raw.trades) {
    const row = parseL2EventHistoryTradeRow(entry);
    if (row === null || (trades.length > 0 && row[0] < trades[trades.length - 1][0])) return null;
    trades.push(row);
  }
  const wallTrades: L2EventHistoryWallTradeRow[] = [];
  for (const entry of raw.wall_trades) {
    const row = parseL2EventHistoryWallTradeRow(entry);
    if (row === null || (wallTrades.length > 0 && row[0] < wallTrades[wallTrades.length - 1][0])) return null;
    wallTrades.push(row);
  }
  let next: L2EventHistoryFrame["next"] = null;
  if (raw.next !== null) {
    if (typeof raw.next !== "object" || raw.next === null || !raw.complete) return null;
    const cursors = raw.next as Record<string, unknown>;
    if (Object.keys(cursors).length !== 2 || !Object.hasOwn(cursors, "trades") || !Object.hasOwn(cursors, "wall_trades")) return null;
    let tradeCursor: NonNullable<L2EventHistoryFrame["next"]>["trades"] = null;
    if (cursors.trades !== null) {
      if (typeof cursors.trades !== "object") return null;
      const cursor = cursors.trades as Record<string, unknown>;
      if (Object.keys(cursor).length !== 4 || !isValidEpochTimestamp(cursor.ts) || !isNonNegativeSafeInteger(cursor.row) || !HISTORY_AGGRESSORS.has(cursor.aggressor) || !HISTORY_MODES.has(cursor.mode)) return null;
      tradeCursor = { ts: cursor.ts as number, row: cursor.row as number, aggressor: cursor.aggressor as "buy" | "sell", mode: cursor.mode as "absorbed" | "swept" };
    }
    let wallTradeCursor: NonNullable<L2EventHistoryFrame["next"]>["wall_trades"] = null;
    if (cursors.wall_trades !== null) {
      if (typeof cursors.wall_trades !== "object") return null;
      const cursor = cursors.wall_trades as Record<string, unknown>;
      if (Object.keys(cursor).length !== 3 || !isValidEpochTimestamp(cursor.ts) || typeof cursor.wall !== "string" || cursor.wall.length === 0 || !HISTORY_MODES.has(cursor.mode)) return null;
      wallTradeCursor = { ts: cursor.ts as number, wall: cursor.wall, mode: cursor.mode as "absorbed" | "swept" };
    }
    next = { trades: tradeCursor, wall_trades: wallTradeCursor };
  }
  return { type: "l2_event_history", ...identity, ...historyHead(raw), trades, wall_trades: wallTrades, trades_held_from: heldFrom as number | null, next };
}

function parseBandHistoryFrame(
  raw: Record<string, unknown>,
): BandHistoryFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, BAND_HISTORY_FRAME_FIELDS) ||
    !isNonNegativeSafeInteger(raw.request_id) ||
    !isValidEpochTimestamp(raw.from_ts) ||
    !isValidEpochTimestamp(raw.to_ts) ||
    (raw.to_ts as number) <= (raw.from_ts as number) ||
    typeof raw.price_lo !== "number" ||
    !Number.isFinite(raw.price_lo) ||
    raw.price_lo <= 0 ||
    typeof raw.price_hi !== "number" ||
    !Number.isFinite(raw.price_hi) ||
    raw.price_hi < raw.price_lo ||
    !Number.isSafeInteger(raw.column_ms) ||
    (raw.column_ms as number) <= 0 ||
    typeof raw.complete !== "boolean" ||
    (raw.complete
      ? raw.reason !== null
      : typeof raw.reason !== "string" ||
        !(BAND_HISTORY_REASONS as readonly string[]).includes(raw.reason)) ||
    !validAggressiveHistoryRetryAfter(raw.reason, raw.retry_after_ms) ||
    !Array.isArray(raw.columns) ||
    raw.columns.length > MAX_BAND_HISTORY_COLUMNS ||
    (!raw.complete && raw.columns.length > 0)
  ) {
    return null;
  }
  const geometryKnown = !BAND_HISTORY_ROWLESS_REASONS.has(raw.reason);
  if (geometryKnown) {
    if (
      typeof raw.row_width !== "number" ||
      !Number.isFinite(raw.row_width) ||
      raw.row_width <= 0 ||
      !Number.isSafeInteger(raw.row_lo) ||
      !Number.isSafeInteger(raw.row_hi) ||
      (raw.row_hi as number) < (raw.row_lo as number) ||
      (raw.row_hi as number) - (raw.row_lo as number) + 1 >
        MAX_BAND_HISTORY_ROWS
    )
      return null;
  } else if (
    raw.row_width !== null ||
    raw.row_lo !== null ||
    raw.row_hi !== null
  ) {
    return null;
  }
  const rows = geometryKnown
    ? (raw.row_hi as number) - (raw.row_lo as number) + 1
    : 0;
  const sizeCeiling = sizeCeilingFor(identity);
  const columns: BandHistoryColumn[] = [];
  let previousTs = -1;
  for (const entry of raw.columns) {
    if (typeof entry !== "object" || entry === null) return null;
    const column = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(column.ts) || (column.ts as number) <= previousTs)
      return null;
    if (
      !validBandHistoryValues(column.bid, rows, sizeCeiling) ||
      !validBandHistoryValues(column.ask, rows, sizeCeiling) ||
      !validBandHistoryValues(column.buy, rows, sizeCeiling) ||
      !validBandHistoryValues(column.sell, rows, sizeCeiling)
    )
      return null;
    previousTs = column.ts as number;
    columns.push({
      ts: column.ts as number,
      bid: [...column.bid],
      ask: [...column.ask],
      buy: [...column.buy],
      sell: [...column.sell],
    });
  }
  return {
    type: "band_history",
    symbol: raw.symbol as string,
    ...identity,
    request_id: raw.request_id as number,
    from_ts: raw.from_ts as number,
    to_ts: raw.to_ts as number,
    price_lo: raw.price_lo as number,
    price_hi: raw.price_hi as number,
    column_ms: raw.column_ms as number,
    row_width: geometryKnown ? (raw.row_width as number) : null,
    row_lo: geometryKnown ? (raw.row_lo as number) : null,
    row_hi: geometryKnown ? (raw.row_hi as number) : null,
    complete: raw.complete as boolean,
    reason: raw.reason as BandHistoryReason | null,
    retry_after_ms: raw.retry_after_ms as number | null,
    columns,
  };
}

function validAggressiveHistoryReason(
  complete: boolean,
  reason: unknown,
): boolean {
  if (complete) return reason === null;
  return (
    typeof reason === "string" &&
    (AGGRESSIVE_HISTORY_REASONS as readonly string[]).includes(reason)
  );
}

function validAggressiveHistoryCursor(
  reason: unknown,
  cursor: unknown,
): boolean {
  if (reason === "CAP_REACHED") {
    return (
      typeof cursor === "string" &&
      cursor.length > 0 &&
      cursor.length <= 512 &&
      /^[A-Za-z0-9_-]+$/.test(cursor)
    );
  }
  return cursor === null;
}

function validAggressiveHistoryRetryAfter(
  reason: unknown,
  retryAfterMs: unknown,
): boolean {
  if (reason === "OVERLOADED") {
    return (
      retryAfterMs === null ||
      (typeof retryAfterMs === "number" &&
        Number.isSafeInteger(retryAfterMs) &&
        retryAfterMs > 0 &&
        retryAfterMs <= 24 * 60 * 60 * 1000)
    );
  }
  return retryAfterMs === null;
}

function parseMarkerFrame(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): MarkerFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(
      raw,
      identity,
      TRADE_FRAME_FIELDS,
      MARKER_FRAME_OPTIONAL_FIELDS,
    ) ||
    !isValidEpochTimestamp(raw.ts_exchange) ||
    !timestampNotTooFarInFuture(raw.ts_exchange, context) ||
    !isPositiveFiniteNumber(raw.price) ||
    !isTradeSize(raw.size, identity) ||
    (raw.side !== "buy" && raw.side !== "sell") ||
    !isValidTradeId(raw.trade_id) ||
    !(
      raw.baseline_log_median === undefined ||
      isFiniteNumber(raw.baseline_log_median)
    ) ||
    !(
      raw.baseline_log_mad === undefined ||
      isNonNegativeFiniteNumber(raw.baseline_log_mad)
    ) ||
    (raw.baseline_log_median === undefined) !==
      (raw.baseline_log_mad === undefined)
  ) {
    return null;
  }
  return {
    type: "marker",
    symbol: raw.symbol as string,
    ...identity,
    ts_exchange: raw.ts_exchange,
    price: raw.price,
    size: raw.size,
    side: raw.side,
    trade_id: raw.trade_id,
    ...(raw.baseline_log_median !== undefined
      ? { baseline_log_median: raw.baseline_log_median }
      : {}),
    ...(raw.baseline_log_mad !== undefined
      ? { baseline_log_mad: raw.baseline_log_mad }
      : {}),
  };
}

function parseBarFrame(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): BarFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(
      raw,
      identity,
      BAR_FRAME_FIELDS,
      identity.provider === "BINANCE"
        ? BINANCE_BAR_OPTIONAL_FIELDS
        : DXFEED_BAR_OPTIONAL_FIELDS,
    ) ||
    raw.interval_ms !== BASE_BAR_INTERVAL_MS ||
    !isValidEpochTimestamp(raw.ts_open) ||
    !timestampWithinLiveWindow(raw.ts_open, context) ||
    raw.ts_open % BASE_BAR_INTERVAL_MS !== 0 ||
    !isPositiveFiniteNumber(raw.open) ||
    !isPositiveFiniteNumber(raw.high) ||
    !isPositiveFiniteNumber(raw.low) ||
    !isPositiveFiniteNumber(raw.close) ||
    raw.low > Math.min(raw.open, raw.close) ||
    raw.high < Math.max(raw.open, raw.close) ||
    raw.low > raw.high ||
    !isBarVolume(raw.volume) ||
    !(
      raw.buy_volume === undefined ||
      (isBarVolume(raw.buy_volume) && raw.buy_volume <= raw.volume)
    ) ||
    !(
      raw.sell_volume === undefined ||
      (isBarVolume(raw.sell_volume) &&
        raw.buy_volume !== undefined &&
        raw.sell_volume + raw.buy_volume <= raw.volume + 1e-6)
    ) ||
    !isNonNegativeSafeInteger(raw.trade_count) ||
    typeof raw.closed !== "boolean" ||
    !(raw.reconstructed === undefined || typeof raw.reconstructed === "boolean")
  ) {
    return null;
  }
  return {
    type: "bar",
    symbol: raw.symbol as string,
    ...identity,
    interval_ms: raw.interval_ms,
    ts_open: raw.ts_open,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: raw.volume,
    ...(raw.buy_volume !== undefined ? { buy_volume: raw.buy_volume } : {}),
    ...(raw.sell_volume !== undefined ? { sell_volume: raw.sell_volume } : {}),
    trade_count: raw.trade_count,
    closed: raw.closed,
    ...(raw.reconstructed !== undefined
      ? { reconstructed: raw.reconstructed }
      : {}),
  };
}

function parseSnapshotFrame(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): SnapshotFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(
      raw,
      identity,
      SNAPSHOT_FRAME_FIELDS,
      identity.provider === "DXFEED"
        ? SNAPSHOT_FRAME_OPTIONAL_FIELDS_DXFEED
        : SNAPSHOT_FRAME_OPTIONAL_FIELDS_BINANCE,
    ) ||
    !Array.isArray(raw.bars) ||
    raw.bars.length > MAX_SNAPSHOT_BARS ||
    !Array.isArray(raw.trades) ||
    raw.trades.length > MAX_SNAPSHOT_TRADES ||
    !Array.isArray(raw.markers) ||
    raw.markers.length > MAX_SNAPSHOT_MARKERS
  ) {
    return null;
  }
  const barHistory = raw.bar_history;
  if (barHistory !== undefined) {
    if (typeof barHistory !== "object" || barHistory === null) return null;
    const history = barHistory as Record<string, unknown>;
    const hasEarliest = history.earliestObservedTsOpen !== undefined;
    if (
      !hasExactKeys(
        history,
        ["availability", "requestedStartTsOpen", "coverage", "interpretation"],
        ["earliestObservedTsOpen"],
      ) ||
      (history.availability !== "AVAILABLE" &&
        history.availability !== "UNAVAILABLE") ||
      !isNonNegativeSafeInteger(history.requestedStartTsOpen) ||
      history.requestedStartTsOpen % BASE_BAR_INTERVAL_MS !== 0 ||
      !(
        history.earliestObservedTsOpen === undefined ||
        isNonNegativeSafeInteger(history.earliestObservedTsOpen)
      ) ||
      (hasEarliest &&
        (history.earliestObservedTsOpen as number) % BASE_BAR_INTERVAL_MS !==
          0) ||
      (history.coverage !== "START_COVERED" &&
        history.coverage !== "START_NOT_COVERED" &&
        history.coverage !== "NO_ROWS") ||
      history.interpretation !== "OBSERVED_NONEMPTY_BARS_ONLY" ||
      (hasEarliest &&
        (history.earliestObservedTsOpen as number) <
          history.requestedStartTsOpen) ||
      (history.coverage === "NO_ROWS" ? hasEarliest : !hasEarliest) ||
      (history.availability === "UNAVAILABLE" &&
        history.coverage !== "NO_ROWS") ||
      (history.coverage === "START_COVERED" &&
        (history.earliestObservedTsOpen as number) -
          history.requestedStartTsOpen >=
          BASE_BAR_INTERVAL_MS) ||
      (history.coverage === "START_NOT_COVERED" &&
        (history.earliestObservedTsOpen as number) -
          history.requestedStartTsOpen <
          BASE_BAR_INTERVAL_MS)
    )
      return null;
  }
  let aggressivePrints: TradeFrame[] | undefined;
  const poolPresent = SNAPSHOT_POOL_FIELDS.filter(
    (field) => raw[field] !== undefined,
  ).length;
  if (poolPresent > 0) {
    if (
      poolPresent !== SNAPSHOT_POOL_FIELDS.length ||
      !Array.isArray(raw.aggressive_prints) ||
      raw.aggressive_prints.length > MAX_AGGRESSIVE_POOL_PRINTS ||
      !isPrintsFloorWithin(raw.aggressive_prints_floor, sizeCeilingFor(identity)) ||
      !isValidEpochTimestamp(raw.aggressive_prints_from)
    ) {
      return null;
    }
    aggressivePrints = [];
    const poolIds = new Set<string>();
    let previousTs = -1;
    for (const print of raw.aggressive_prints) {
      if (
        typeof print !== "object" ||
        print === null ||
        (print as Record<string, unknown>).type !== "trade"
      )
        return null;
      const parsed = parseTradeFrame(print as Record<string, unknown>, {});
      if (
        !parsed ||
        parsed.symbol !== raw.symbol ||
        !identitiesMatch(parsed, identity) ||
        poolIds.has(parsed.trade_id) ||
        parsed.ts_exchange < previousTs
      )
        return null;
      poolIds.add(parsed.trade_id);
      previousTs = parsed.ts_exchange;
      aggressivePrints.push(parsed);
    }
  }
  let vpinReadings: VpinReading[] | undefined;
  if (raw.vpin_readings !== undefined) {
    if (
      !Array.isArray(raw.vpin_readings) ||
      raw.vpin_readings.length > MAX_SNAPSHOT_VPIN_READINGS
    ) {
      return null;
    }
    const readings: VpinReading[] = [];
    let previousSealTs = -1;
    for (const rawReading of raw.vpin_readings) {
      const reading = parseVpinReading(rawReading, context);
      if (!reading || reading.seal_ts < previousSealTs) return null;
      previousSealTs = reading.seal_ts;
      readings.push(reading);
    }
    vpinReadings = readings;
  }
  const vpinStatus = raw.vpin_status;
  if (
    vpinStatus !== undefined &&
    vpinStatus !== "DISABLED" &&
    vpinStatus !== "IDLE" &&
    vpinStatus !== "WARMING" &&
    vpinStatus !== "READY" &&
    vpinStatus !== "UNAVAILABLE"
  )
    return null;
  const bars: BarFrame[] = [];
  let previousOpenTime = -1;
  for (const bar of raw.bars) {
    if (
      typeof bar !== "object" ||
      bar === null ||
      (bar as Record<string, unknown>).type !== "bar"
    ) {
      return null;
    }
    const parsed = parseBarFrame(bar as Record<string, unknown>, context);
    if (
      !parsed ||
      parsed.closed !== true ||
      parsed.symbol !== raw.symbol ||
      !identitiesMatch(parsed, identity) ||
      parsed.ts_open <= previousOpenTime
    ) {
      return null;
    }
    previousOpenTime = parsed.ts_open;
    bars.push(parsed);
  }
  const trades: TradeFrame[] = [];
  const tradeIds = new Set<string>();
  for (const trade of raw.trades) {
    if (
      typeof trade !== "object" ||
      trade === null ||
      (trade as Record<string, unknown>).type !== "trade"
    ) {
      return null;
    }
    const parsed = parseTradeFrame(trade as Record<string, unknown>, context);
    if (
      !parsed ||
      parsed.symbol !== raw.symbol ||
      !identitiesMatch(parsed, identity) ||
      tradeIds.has(parsed.trade_id)
    ) {
      return null;
    }
    tradeIds.add(parsed.trade_id);
    trades.push(parsed);
  }
  const markers: MarkerFrame[] = [];
  const markerTradeIds = new Set<string>();
  for (const marker of raw.markers) {
    if (
      typeof marker !== "object" ||
      marker === null ||
      (marker as Record<string, unknown>).type !== "marker"
    ) {
      return null;
    }
    const parsed = parseMarkerFrame(marker as Record<string, unknown>, context);
    if (
      !parsed ||
      parsed.symbol !== raw.symbol ||
      !identitiesMatch(parsed, identity) ||
      markerTradeIds.has(parsed.trade_id)
    ) {
      return null;
    }
    markerTradeIds.add(parsed.trade_id);
    markers.push(parsed);
  }
  return {
    type: "snapshot",
    symbol: raw.symbol as string,
    ...identity,
    bars,
    trades,
    markers,
    ...(barHistory !== undefined
      ? { bar_history: barHistory as SnapshotFrame["bar_history"] }
      : {}),
    ...(vpinReadings !== undefined ? { vpin_readings: vpinReadings } : {}),
    ...(aggressivePrints !== undefined
      ? {
          aggressive_prints: aggressivePrints,
          aggressive_prints_floor: raw.aggressive_prints_floor as number,
          aggressive_prints_from: raw.aggressive_prints_from as number,
        }
      : {}),
    ...(vpinStatus !== undefined
      ? { vpin_status: vpinStatus as VpinStatus }
      : {}),
  };
}

function parseHealthFrame(raw: Record<string, unknown>): HealthFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(
      raw,
      identity,
      HEALTH_FRAME_FIELDS,
      identity.provider === "DXFEED"
        ? DXFEED_HEALTH_OPTIONAL_FIELDS
        : BINANCE_HEALTH_OPTIONAL_FIELDS,
    ) ||
    (raw.recoveryState !== "READY" &&
      raw.recoveryState !== "RECOVERING" &&
      raw.recoveryState !== "UNAVAILABLE") ||
    typeof raw.stale !== "boolean"
  ) {
    return null;
  }
  if (raw.recoveryState !== "READY" && raw.stale !== true) {
    return null;
  }
  if (raw.printsQuiet !== undefined && typeof raw.printsQuiet !== "boolean") {
    return null;
  }
  if (raw.reason !== undefined && !isValidReason(raw.reason)) {
    return null;
  }
  if (
    raw.recordingStale !== undefined &&
    typeof raw.recordingStale !== "boolean"
  ) {
    return null;
  }
  if (
    raw.recordingLatestTs !== undefined &&
    (typeof raw.recordingLatestTs !== "number" ||
      !Number.isSafeInteger(raw.recordingLatestTs) ||
      raw.recordingLatestTs < 0 ||
      raw.recordingStale === undefined)
  ) {
    return null;
  }
  return {
    type: "health",
    symbol: raw.symbol as string,
    ...identity,
    recoveryState: raw.recoveryState,
    stale: raw.stale,
    ...(raw.printsQuiet !== undefined ? { printsQuiet: raw.printsQuiet } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    ...(raw.recordingStale !== undefined
      ? { recordingStale: raw.recordingStale }
      : {}),
    ...(raw.recordingLatestTs !== undefined
      ? { recordingLatestTs: raw.recordingLatestTs }
      : {}),
  };
}

function parseBookLevels(
  raw: unknown,
  direction: "ascending" | "descending",
  sizeCeiling: number,
): BookLevel[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_BOOK_LEVELS) {
    return null;
  }
  const levels: BookLevel[] = [];
  let previousPrice: number | undefined;
  for (const level of raw) {
    if (typeof level !== "object" || level === null) {
      return null;
    }
    const record = level as Record<string, unknown>;
    if (!hasExactKeys(record, ["price", "size"])) return null;
    const { price, size } = record;
    if (!isPositiveFiniteNumber(price) || !isSizeWithin(size, sizeCeiling) || size === 0) {
      return null;
    }
    if (
      previousPrice !== undefined &&
      (direction === "ascending"
        ? price <= previousPrice
        : price >= previousPrice)
    ) {
      return null;
    }
    levels.push({ price, size });
    previousPrice = price;
  }
  return levels;
}

function parseBookFrame(raw: Record<string, unknown>): BookFrame | null {
  const identity = parseFrameIdentity(raw);
  if (!identity || (raw.status !== "READY" && raw.status !== "UNAVAILABLE")) {
    return null;
  }
  if (raw.status === "UNAVAILABLE") {
    if (
      !hasExactFrameKeys(raw, identity, ["status", "reason"]) ||
      !isValidReason(raw.reason)
    ) {
      return null;
    }
    return {
      type: "book",
      symbol: raw.symbol as string,
      ...identity,
      status: "UNAVAILABLE",
      reason: raw.reason,
    };
  }
  const bids = parseBookLevels(raw.bids, "descending", sizeCeilingFor(identity));
  const asks = parseBookLevels(raw.asks, "ascending", sizeCeilingFor(identity));
  if (
    !hasExactFrameKeys(raw, identity, [
      "status",
      "bids",
      "asks",
      "lastUpdateId",
      "stale",
    ]) ||
    !bids ||
    !asks ||
    (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price) ||
    !isNonNegativeSafeInteger(raw.lastUpdateId) ||
    typeof raw.stale !== "boolean"
  ) {
    return null;
  }
  return {
    type: "book",
    symbol: raw.symbol as string,
    ...identity,
    status: "READY",
    bids,
    asks,
    lastUpdateId: raw.lastUpdateId,
    stale: raw.stale,
  };
}

const PROFILE_MODES = new Set(["continuous", "per_candle", "fixed_range"]);
const MAX_PROFILE_BUCKETS = 4000;

function parseProfileBucket(raw: unknown): ProfileBucket | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "price",
      "volume",
      "buy_volume",
      "sell_volume",
      "single_print",
    ])
  )
    return null;
  const {
    price,
    volume,
    buy_volume: buyVolume,
    sell_volume: sellVolume,
    single_print: singlePrint,
  } = record;
  if (
    !isPositiveFiniteNumber(price) ||
    !isProfileVolume(volume) ||
    !isProfileVolume(buyVolume) ||
    !isProfileVolume(sellVolume) ||
    buyVolume + sellVolume > volume + 1e-6 ||
    typeof singlePrint !== "boolean"
  ) {
    return null;
  }
  return {
    price,
    volume,
    buy_volume: buyVolume,
    sell_volume: sellVolume,
    single_print: singlePrint,
  };
}

function parseProfileFrame(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): ProfileFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, PROFILE_FRAME_FIELDS) ||
    !PROFILE_MODES.has(raw.mode as string) ||
    !(
      raw.delivery_scope === "LIVE" ||
      raw.delivery_scope === "HISTORICAL" ||
      raw.delivery_scope === "FIXED_RANGE"
    ) ||
    (raw.delivery_scope === "HISTORICAL"
      ? !Number.isSafeInteger(raw.history_request_id) ||
        (raw.history_request_id as number) <= 0
      : raw.history_request_id !== null) ||
    !isValidEpochTimestamp(raw.period_start_ts) ||
    !timestampNotTooFarInFuture(raw.period_start_ts, context) ||
    !(
      raw.period_end_ts === null ||
      (isValidEpochTimestamp(raw.period_end_ts) &&
        timestampNotTooFarInFuture(raw.period_end_ts, context))
    ) ||
    (raw.period_end_ts !== null &&
      (raw.period_end_ts as number) < raw.period_start_ts) ||
    !isPositiveFiniteNumber(raw.row_width) ||
    !Array.isArray(raw.buckets) ||
    raw.buckets.length === 0 ||
    raw.buckets.length > MAX_PROFILE_BUCKETS ||
    !isPositiveFiniteNumber(raw.poc_price) ||
    !isPositiveFiniteNumber(raw.vah_price) ||
    !isPositiveFiniteNumber(raw.val_price) ||
    raw.val_price > raw.poc_price ||
    raw.poc_price > raw.vah_price
  ) {
    return null;
  }
  const buckets: ProfileBucket[] = [];
  let previousPrice = -Infinity;
  let pocPriceFound = false;
  let vahPriceFound = false;
  let valPriceFound = false;
  for (const rawBucket of raw.buckets) {
    const bucket = parseProfileBucket(rawBucket);
    if (!bucket || bucket.price <= previousPrice) {
      return null;
    }
    previousPrice = bucket.price;
    if (bucket.price === raw.poc_price) pocPriceFound = true;
    if (bucket.price === raw.vah_price) vahPriceFound = true;
    if (bucket.price === raw.val_price) valPriceFound = true;
    buckets.push(bucket);
  }
  if (!pocPriceFound || !vahPriceFound || !valPriceFound) {
    return null;
  }
  return {
    type: "profile",
    symbol: raw.symbol as string,
    ...identity,
    mode: raw.mode as ProfileMode,
    delivery_scope: raw.delivery_scope as ProfileDeliveryScope,
    history_request_id: raw.history_request_id as number | null,
    period_start_ts: raw.period_start_ts,
    period_end_ts: raw.period_end_ts as number | null,
    row_width: raw.row_width,
    buckets,
    poc_price: raw.poc_price,
    vah_price: raw.vah_price,
    val_price: raw.val_price,
  };
}

function isValidVpinReadingShape(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): boolean {
  const {
    seal_ts: sealTs,
    active,
    direction,
    strength,
    z_vpin: zVpin,
    z_velocity: zVelocity,
    z_acceleration: zAcceleration,
    activated_at_ts: activatedAtTs,
  } = raw;
  if (
    !isValidEpochTimestamp(sealTs) ||
    !timestampNotTooFarInFuture(sealTs as number, context)
  )
    return false;
  if (typeof active !== "boolean") return false;
  if (direction !== "buy" && direction !== "sell" && direction !== null)
    return false;
  if (active && direction === null) return false;
  if (!active && direction !== null) return false;
  if (!isFiniteNumber(strength) || strength < 0 || strength > 1) return false;
  if (active && strength === 0) return false;
  if (!active && strength !== 0) return false;
  for (const value of [zVpin, zVelocity, zAcceleration]) {
    if (value !== null && !isFiniteNumber(value)) return false;
  }
  if (activatedAtTs !== null) {
    if (
      !isValidEpochTimestamp(activatedAtTs) ||
      !timestampNotTooFarInFuture(activatedAtTs as number, context)
    )
      return false;
    if ((activatedAtTs as number) > (sealTs as number)) return false;
  }
  if (active && activatedAtTs === null) return false;
  if (!active && activatedAtTs !== null) return false;
  return true;
}

function parseVpinReading(
  raw: unknown,
  context: FrameParseContext,
): VpinReading | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (
    !hasExactKeys(record, VPIN_READING_FIELDS) ||
    !isValidVpinReadingShape(record, context)
  ) {
    return null;
  }
  return {
    seal_ts: record.seal_ts as number,
    active: record.active as boolean,
    direction: record.direction as VpinDirection,
    strength: record.strength as number,
    z_vpin: record.z_vpin as number | null,
    z_velocity: record.z_velocity as number | null,
    z_acceleration: record.z_acceleration as number | null,
    activated_at_ts: record.activated_at_ts as number | null,
  };
}

const MAX_LIQUIDITY_COLUMNS = 120;
const MAX_LIQUIDITY_ROWS = 2048;
const MAX_LIQUIDITY_LEVELS = 400;
const MAX_AGGRESSIVE_EVENTS = 200;
const MAX_LIQUIDITY_PRINTS = 64;
export const PRINT_WINDOW_COLUMNS = 2;
const LIQUIDITY_COLUMN_KEYS = [
  "ts",
  "lo",
  "hi",
  "bid",
  "ask",
  "buy",
  "sell",
  "prints",
  "prints_floor",
] as const;
const LIQUIDITY_FRAME_FIELDS = [
  "ts",
  "seq",
  "reset",
  "row_width",
  "column_ms",
  "columns",
] as const;
const LIQUIDITY_FRAME_OPTIONAL_FIELDS = [
  "levels",
  "aggressive",
  "backfill",
] as const;
const LIQUIDITY_BACKFILL_STATUSES: ReadonlySet<string> = new Set([
  "RUNNING",
  "COMPLETE",
  "FAILED",
]);

function parseLiquidityBackfill(raw: unknown): LiquidityBackfill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const backfill = raw as Record<string, unknown>;
  if (
    !hasExactKeys(backfill, ["status", "reason"]) ||
    typeof backfill.status !== "string" ||
    !LIQUIDITY_BACKFILL_STATUSES.has(backfill.status) ||
    (backfill.reason !== null && typeof backfill.reason !== "string")
  ) {
    return null;
  }
  return {
    status: backfill.status as LiquidityBackfillStatus,
    reason: backfill.reason as string | null,
  };
}

function parseAggressiveEvent(
  raw: unknown,
  frameTs: number,
  sizeCeiling: number,
): AggressiveEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as Record<string, unknown>;
  if (
    !hasExactKeys(event, [
      "side",
      "row",
      "span",
      "start_ts",
      "end_ts",
      "volume",
      "peak",
      "floor",
    ]) ||
    (event.side !== "buy" && event.side !== "sell") ||
    !isNonNegativeSafeInteger(event.row) ||
    !isNonNegativeSafeInteger(event.span) ||
    event.span < 1 ||
    !isValidEpochTimestamp(event.start_ts) ||
    event.start_ts > frameTs ||
    !(
      event.end_ts === null ||
      (isValidEpochTimestamp(event.end_ts) &&
        event.end_ts >= event.start_ts &&
        event.end_ts <= frameTs)
    ) ||
    !isSizeWithin(event.volume, sizeCeiling) ||
    !isSizeWithin(event.peak, sizeCeiling) ||
    event.peak > event.volume ||
    !isSizeWithin(event.floor, sizeCeiling)
  ) {
    return null;
  }
  return {
    side: event.side,
    row: event.row,
    span: event.span,
    start_ts: event.start_ts,
    end_ts: event.end_ts as number | null,
    volume: event.volume,
    peak: event.peak,
    floor: event.floor,
  };
}

const LIQUIDITY_LEVEL_VERDICTS: ReadonlySet<string> = new Set([
  "filled",
  "partial",
  "hit",
  "pulled",
  "moved",
]);

function parseLiquidityLevel(
  raw: unknown,
  frameTs: number,
  sizeCeiling: number,
): LiquidityLevel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const level = raw as Record<string, unknown>;
  if (
    !hasExactKeys(level, [
      "side",
      "row",
      "span",
      "start_ts",
      "end_ts",
      "size",
      "peak",
      "ended_by",
      "ratio",
      "chain",
      "fill",
      "eaten",
      "absorbing",
    ]) ||
    !isNonNegativeFiniteNumber(level.ratio) ||
    !isNonNegativeSafeInteger(level.chain) ||
    !isNonNegativeFiniteNumber(level.fill) ||
    level.fill > 1 ||
    !isNonNegativeFiniteNumber(level.eaten) ||
    level.eaten > 1 ||
    typeof level.absorbing !== "boolean" ||
    (level.absorbing && level.end_ts !== null) ||
    (level.side !== "bid" && level.side !== "ask") ||
    !isNonNegativeSafeInteger(level.row) ||
    !isNonNegativeSafeInteger(level.span) ||
    level.span < 1 ||
    !isValidEpochTimestamp(level.start_ts) ||
    level.start_ts > frameTs ||
    !(
      level.end_ts === null ||
      (isValidEpochTimestamp(level.end_ts) &&
        level.end_ts >= level.start_ts &&
        level.end_ts <= frameTs)
    ) ||
    !isSizeWithin(level.size, sizeCeiling) ||
    !isSizeWithin(level.peak, sizeCeiling) ||
    level.peak < level.size ||
    (level.ended_by !== null &&
      !LIQUIDITY_LEVEL_VERDICTS.has(level.ended_by as string)) ||
    (level.end_ts === null) !== (level.ended_by === null)
  ) {
    return null;
  }
  return {
    side: level.side,
    row: level.row,
    span: level.span,
    start_ts: level.start_ts,
    end_ts: level.end_ts as number | null,
    size: level.size,
    peak: level.peak,
    ended_by: level.ended_by as LiquidityLevel["ended_by"],
    ratio: level.ratio,
    chain: level.chain,
    fill: level.fill,
    eaten: level.eaten,
    absorbing: level.absorbing,
  };
}

function parseLiquidityEntries(
  raw: unknown,
  span: number,
  sizeCeiling: number,
): LiquidityEntry[] | null {
  if (!Array.isArray(raw) || raw.length > span) return null;
  const entries: LiquidityEntry[] = [];
  let previousOffset = -1;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [offset, size] = entry as unknown[];
    if (
      !isNonNegativeSafeInteger(offset) ||
      offset >= span ||
      offset <= previousOffset ||
      !isSizeWithin(size, sizeCeiling)
    )
      return null;
    previousOffset = offset;
    entries.push([offset, size]);
  }
  return entries;
}

function parseLiquidityPrint(
  raw: unknown,
  columnTs: number,
  columnMs: number,
  previousTs: number,
  sizeCeiling: number,
): LiquidityPrint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const print = raw as Record<string, unknown>;
  if (
    !hasExactKeys(print, ["ts", "price", "size", "side", "id"]) ||
    !isNonNegativeSafeInteger(print.ts) ||
    print.ts < columnTs - PRINT_WINDOW_COLUMNS * columnMs ||
    print.ts > columnTs + columnMs ||
    print.ts < previousTs ||
    !isPositiveFiniteNumber(print.price) ||
    !isSizeWithin(print.size, sizeCeiling) ||
    print.size === 0 ||
    (print.side !== "buy" && print.side !== "sell") ||
    (print.id !== null && !isValidTradeId(print.id))
  ) {
    return null;
  }
  return {
    ts: print.ts,
    price: print.price,
    size: print.size,
    side: print.side,
    id: print.id,
  };
}

function parseLiquidityPrints(
  raw: unknown,
  columnTs: number,
  columnMs: number,
  sizeCeiling: number,
): LiquidityPrint[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_LIQUIDITY_PRINTS) return null;
  const prints: LiquidityPrint[] = [];
  let previousTs = -1;
  for (const entry of raw) {
    const print = parseLiquidityPrint(entry, columnTs, columnMs, previousTs, sizeCeiling);
    if (!print) return null;
    previousTs = print.ts;
    prints.push(print);
  }
  return prints;
}

function parseLiquidityColumn(
  raw: unknown,
  frameTs: number,
  columnMs: number,
  previousTs: number,
  sizeCeiling: number,
): LiquidityColumnFrame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const column = raw as Record<string, unknown>;
  if (
    !hasExactKeys(
      column,
      LIQUIDITY_COLUMN_KEYS.slice(0, 5),
      LIQUIDITY_COLUMN_KEYS.slice(5),
    ) ||
    !isValidEpochTimestamp(column.ts) ||
    column.ts > frameTs ||
    column.ts <= previousTs ||
    !isNonNegativeSafeInteger(column.lo) ||
    !isNonNegativeSafeInteger(column.hi) ||
    column.hi < column.lo ||
    column.hi - column.lo + 1 > MAX_LIQUIDITY_ROWS
  ) {
    return null;
  }
  const span = column.hi - column.lo + 1;
  const bid = parseLiquidityEntries(column.bid, span, sizeCeiling);
  const ask = parseLiquidityEntries(column.ask, span, sizeCeiling);
  if (!bid || !ask) return null;
  const parsed: LiquidityColumnFrame = {
    ts: column.ts,
    lo: column.lo,
    hi: column.hi,
    bid,
    ask,
  };
  if (column.buy !== undefined) {
    const buy = parseLiquidityEntries(column.buy, span, sizeCeiling);
    if (!buy) return null;
    parsed.buy = buy;
  }
  if (column.sell !== undefined) {
    const sell = parseLiquidityEntries(column.sell, span, sizeCeiling);
    if (!sell) return null;
    parsed.sell = sell;
  }
  if (column.prints !== undefined) {
    const prints = parseLiquidityPrints(column.prints, column.ts, columnMs, sizeCeiling);
    if (!prints) return null;
    parsed.prints = prints;
  }
  if (column.prints_floor !== undefined) {
    if (!isPrintsFloorWithin(column.prints_floor, sizeCeiling)) return null;
    parsed.prints_floor = column.prints_floor;
  }
  return parsed;
}

function parseLiquidityFrame(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): LiquidityFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(
      raw,
      identity,
      LIQUIDITY_FRAME_FIELDS,
      LIQUIDITY_FRAME_OPTIONAL_FIELDS,
    ) ||
    !isValidEpochTimestamp(raw.ts) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isNonNegativeSafeInteger(raw.seq) ||
    typeof raw.reset !== "boolean" ||
    !isPositiveFiniteNumber(raw.row_width) ||
    !isNonNegativeSafeInteger(raw.column_ms) ||
    raw.column_ms === 0 ||
    !Array.isArray(raw.columns) ||
    raw.columns.length > MAX_LIQUIDITY_COLUMNS ||
    (!raw.reset && raw.columns.length === 0) ||
    raw.seq < raw.columns.length
  ) {
    return null;
  }
  const sizeCeiling = sizeCeilingFor(identity);
  const columns: LiquidityColumnFrame[] = [];
  let previousTs = -1;
  for (const entry of raw.columns) {
    const parsed = parseLiquidityColumn(
      entry,
      raw.ts,
      raw.column_ms,
      previousTs,
      sizeCeiling,
    );
    if (!parsed) return null;
    previousTs = parsed.ts;
    columns.push(parsed);
  }
  let levels: LiquidityLevel[] | undefined;
  if (Object.hasOwn(raw, "levels")) {
    if (!Array.isArray(raw.levels) || raw.levels.length > MAX_LIQUIDITY_LEVELS)
      return null;
    levels = [];
    for (const entry of raw.levels) {
      const parsed = parseLiquidityLevel(entry, raw.ts, sizeCeiling);
      if (!parsed) return null;
      levels.push(parsed);
    }
  }
  let aggressive: AggressiveEvent[] | undefined;
  if (Object.hasOwn(raw, "aggressive")) {
    if (
      !Array.isArray(raw.aggressive) ||
      raw.aggressive.length > MAX_AGGRESSIVE_EVENTS
    )
      return null;
    aggressive = [];
    for (const entry of raw.aggressive) {
      const parsed = parseAggressiveEvent(entry, raw.ts, sizeCeiling);
      if (!parsed) return null;
      aggressive.push(parsed);
    }
  }
  let backfill: LiquidityBackfill | undefined;
  if (Object.hasOwn(raw, "backfill")) {
    const parsed = parseLiquidityBackfill(raw.backfill);
    if (!parsed) return null;
    backfill = parsed;
  }
  return {
    type: "liquidity",
    symbol: raw.symbol as string,
    ...identity,
    ts: raw.ts,
    seq: raw.seq,
    reset: raw.reset,
    row_width: raw.row_width,
    column_ms: raw.column_ms,
    columns,
    ...(levels === undefined ? {} : { levels }),
    ...(aggressive === undefined ? {} : { aggressive }),
    ...(backfill === undefined ? {} : { backfill }),
  };
}

function parseVpinFrame(
  raw: Record<string, unknown>,
  context: FrameParseContext,
): VpinFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, VPIN_READING_FIELDS) ||
    !isValidVpinReadingShape(raw, context)
  ) {
    return null;
  }
  return {
    type: "vpin",
    symbol: raw.symbol as string,
    ...identity,
    seal_ts: raw.seal_ts as number,
    active: raw.active as boolean,
    direction: raw.direction as VpinDirection,
    strength: raw.strength as number,
    z_vpin: raw.z_vpin as number | null,
    z_velocity: raw.z_velocity as number | null,
    z_acceleration: raw.z_acceleration as number | null,
    activated_at_ts: raw.activated_at_ts as number | null,
  };
}

function parseSelectionFrame(
  raw: Record<string, unknown>,
): SelectionFrame | null {
  const identity = parseFrameIdentity(raw);
  if (!identity || !hasExactFrameKeys(raw, identity, [])) {
    return null;
  }
  return { type: "selection", symbol: raw.symbol as string, ...identity };
}

function parseIcebergOrder(raw: unknown, sizeCeiling: number): IcebergOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.length !== 13) return null;
  if (
    typeof entry.id !== "string" ||
    entry.id.length === 0 ||
    entry.id.length > MAX_ICEBERG_ID_LENGTH ||
    typeof entry.kind !== "string" ||
    !ICEBERG_KINDS.has(entry.kind) ||
    typeof entry.confidence !== "string" ||
    !ICEBERG_CONFIDENCES.has(entry.confidence) ||
    (entry.side !== "bid" && entry.side !== "ask") ||
    !isPositiveFiniteNumber(entry.price) ||
    !isSizeWithin(entry.display, sizeCeiling) ||
    !isNonNegativeSafeInteger(entry.tranches) ||
    entry.tranches < 1 ||
    !isSizeWithin(entry.executed, sizeCeiling) ||
    !isValidEpochTimestamp(entry.startedAt) ||
    !isValidEpochTimestamp(entry.markedAt) ||
    !isValidEpochTimestamp(entry.updatedAt) ||
    entry.markedAt < entry.startedAt ||
    entry.updatedAt < entry.markedAt ||
    typeof entry.status !== "string" ||
    !ICEBERG_STATUSES.has(entry.status) ||
    typeof entry.origin !== "string" ||
    !ICEBERG_ORIGINS.has(entry.origin)
  ) {
    return null;
  }
  return {
    id: entry.id,
    kind: entry.kind as IcebergKind,
    confidence: entry.confidence as IcebergConfidence,
    side: entry.side,
    price: entry.price,
    display: entry.display,
    tranches: entry.tranches,
    executed: entry.executed,
    startedAt: entry.startedAt,
    markedAt: entry.markedAt,
    updatedAt: entry.updatedAt,
    status: entry.status as IcebergStatus,
    origin: entry.origin as IcebergOrigin,
  };
}

function parseWatchedSpans(raw: unknown): ReadonlyArray<readonly [number, number]> | null {
  if (!Array.isArray(raw) || raw.length > MAX_WATCHED_SPANS) return null;
  const spans: Array<readonly [number, number]> = [];
  let last = -1;
  for (const span of raw) {
    if (!Array.isArray(span) || span.length !== 2) return null;
    const [from, to] = span as unknown[];
    if (!isValidEpochTimestamp(from) || !isValidEpochTimestamp(to) || from >= to || from < last) return null;
    last = to;
    spans.push([from, to]);
  }
  return spans;
}

function parseIcebergOrdersFrame(raw: Record<string, unknown>, context: FrameParseContext): IcebergOrdersFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["ts", "seq", "reset", "icebergs", "watched", "liveSince"]) ||
    !isValidEpochTimestamp(raw.ts) ||
    !isValidEpochTimestamp(raw.liveSince) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isNonNegativeSafeInteger(raw.seq) ||
    typeof raw.reset !== "boolean" ||
    !Array.isArray(raw.icebergs) ||
    raw.icebergs.length > MAX_ICEBERG_ORDERS ||
    (!raw.reset && raw.icebergs.length === 0)
  ) {
    return null;
  }
  const watched = parseWatchedSpans(raw.watched);
  if (watched === null) return null;
  const sizeCeiling = sizeCeilingFor(identity);
  const icebergs: IcebergOrder[] = [];
  const ids = new Set<string>();
  let previousMark = -1;
  for (const entry of raw.icebergs) {
    const iceberg = parseIcebergOrder(entry, sizeCeiling);
    if (!iceberg || ids.has(iceberg.id) || iceberg.markedAt < previousMark) return null;
    ids.add(iceberg.id);
    previousMark = iceberg.markedAt;
    icebergs.push(iceberg);
  }
  return { type: "iceberg_orders", symbol: raw.symbol as string, ...identity, ts: raw.ts, seq: raw.seq, reset: raw.reset, icebergs, watched, liveSince: raw.liveSince };
}

function parseExhaustionReadings(raw: unknown): ExhaustionReadings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.length !== EXHAUSTION_READINGS.length || EXHAUSTION_READINGS.some((key) => typeof entry[key] !== "boolean")) return null;
  return { rate: entry.rate as boolean, progress: entry.progress as boolean, delta: entry.delta as boolean, divergence: entry.divergence as boolean, prints: entry.prints as boolean, book: entry.book as boolean };
}

function parseExhaustionValues(raw: unknown): ExhaustionValues | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (Object.keys(entry).length !== EXHAUSTION_READINGS.length) return null;
  for (const key of EXHAUSTION_READINGS) {
    const value = entry[key];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_EXHAUSTION_VALUE)) return null;
  }
  const read = (key: string) => entry[key] as number | null;
  return { rate: read("rate"), progress: read("progress"), delta: read("delta"), divergence: read("divergence"), prints: read("prints"), book: read("book") };
}

function parseExhaustionRaw(raw: unknown): ExhaustionRaw | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (Object.keys(entry).length !== EXHAUSTION_RAW_KEYS.length) return null;
  for (const key of EXHAUSTION_RAW_KEYS) {
    const value = entry[key];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_EXHAUSTION_RAW)) return null;
  }
  if (entry.bookBand !== null && entry.bookBand !== 0 && entry.bookBand !== 1 && entry.bookBand !== 2) return null;
  const read = (key: string) => entry[key] as number | null;
  return { own: read("own"), other: read("other"), legOwn: read("legOwn"), moved: read("moved"), legMoved: read("legMoved"), big: read("big"), legBig: read("legBig"), extremeOwn: read("extremeOwn"), extremeOther: read("extremeOther"), bookNow: read("bookNow"), bookAt: read("bookAt"), bookBand: entry.bookBand as 0 | 1 | 2 | null };
}

function parseExhaustionShade(raw: unknown): ExhaustionShade | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (Object.keys(entry).length !== 21) return null;
  const readings = parseExhaustionReadings(entry.readings);
  const values = parseExhaustionValues(entry.values);
  const rawSums = parseExhaustionRaw(entry.raw);
  if (
    readings === null ||
    values === null ||
    rawSums === null ||
    typeof entry.id !== "string" ||
    entry.id.length === 0 ||
    entry.id.length > MAX_EXHAUSTION_ID_LENGTH ||
    typeof entry.candleMs !== "number" ||
    !EXHAUSTION_CANDLE_MS.has(entry.candleMs) ||
    typeof entry.side !== "string" ||
    !EXHAUSTION_SIDES.has(entry.side) ||
    typeof entry.status !== "string" ||
    !EXHAUSTION_STATUSES.has(entry.status) ||
    !isNonNegativeSafeInteger(entry.intensity) ||
    entry.intensity < 1 ||
    entry.intensity > MAX_EXHAUSTION_INTENSITY ||
    !isNonNegativeSafeInteger(entry.score) ||
    entry.score > MAX_EXHAUSTION_SCORE ||
    !isValidEpochTimestamp(entry.startTs) ||
    !isValidEpochTimestamp(entry.endTs) ||
    !isValidEpochTimestamp(entry.extremeTs) ||
    !isValidEpochTimestamp(entry.legStartTs) ||
    !isValidEpochTimestamp(entry.updatedAt) ||
    entry.endTs <= entry.startTs ||
    entry.legStartTs > entry.extremeTs ||
    entry.extremeTs >= entry.endTs ||
    entry.updatedAt < entry.startTs ||
    !isPositiveFiniteNumber(entry.extremePrice) ||
    !isPositiveFiniteNumber(entry.legStartPrice) ||
    !isPositiveFiniteNumber(entry.legSize) ||
    !isPositiveFiniteNumber(entry.efficiency) ||
    entry.efficiency > 1 ||
    !isPositiveFiniteNumber(entry.atr) ||
    typeof entry.origin !== "string" ||
    !EXHAUSTION_ORIGINS.has(entry.origin)
  ) {
    return null;
  }
  const final = EXHAUSTION_FINAL_STATUSES.has(entry.status);
  if (final ? !isValidEpochTimestamp(entry.judgedAt) || entry.judgedAt < entry.endTs : entry.judgedAt !== null) return null;
  return {
    id: entry.id,
    candleMs: entry.candleMs as ExhaustionCandleMs,
    side: entry.side as ExhaustionSide,
    status: entry.status as ExhaustionStatus,
    intensity: entry.intensity,
    score: entry.score,
    readings,
    values,
    raw: rawSums,
    startTs: entry.startTs,
    endTs: entry.endTs,
    extremeTs: entry.extremeTs,
    extremePrice: entry.extremePrice,
    legStartTs: entry.legStartTs,
    legStartPrice: entry.legStartPrice,
    legSize: entry.legSize,
    efficiency: entry.efficiency,
    atr: entry.atr,
    judgedAt: final ? (entry.judgedAt as number) : null,
    updatedAt: entry.updatedAt,
    origin: entry.origin as ExhaustionOrigin,
  };
}

function exhaustionShadeBefore(a: ExhaustionShade, b: ExhaustionShade): boolean {
  return a.startTs < b.startTs || (a.startTs === b.startTs && a.id < b.id);
}

function parseExhaustionShadesFrame(raw: Record<string, unknown>, context: FrameParseContext): ExhaustionShadesFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["ts", "seq", "reset", "shades", "liveSince", "loading"]) ||
    !isValidEpochTimestamp(raw.ts) ||
    !isValidEpochTimestamp(raw.liveSince) ||
    (raw.loading !== null && !isValidEpochTimestamp(raw.loading)) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isNonNegativeSafeInteger(raw.seq) ||
    typeof raw.reset !== "boolean" ||
    !Array.isArray(raw.shades) ||
    raw.shades.length > MAX_EXHAUSTION_SHADES ||
    (!raw.reset && raw.shades.length === 0)
  ) {
    return null;
  }
  const shades: ExhaustionShade[] = [];
  const ids = new Set<string>();
  for (const entry of raw.shades) {
    const shade = parseExhaustionShade(entry);
    if (!shade || ids.has(shade.id) || (shades.length > 0 && exhaustionShadeBefore(shade, shades[shades.length - 1]))) return null;
    ids.add(shade.id);
    shades.push(shade);
  }
  return { type: "exhaustion_shades", symbol: raw.symbol as string, ...identity, ts: raw.ts, seq: raw.seq, reset: raw.reset, shades, liveSince: raw.liveSince, loading: raw.loading as number | null };
}

function isInitiativeUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isInitiativeUnitOrNull(value: unknown): value is number | null {
  return value === null || isInitiativeUnit(value);
}

function isInitiativeAmountOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_INITIATIVE_VALUE);
}

function initiativeFactWithKeys(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const own = Object.keys(entry);
  if (own.length !== keys.length || keys.some((key) => !(key in entry)) || typeof entry.yes !== "boolean") return null;
  return entry;
}

function parseInitiativeFacts(raw: unknown, windowCandles: number): InitiativeFacts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const own = Object.keys(entry);
  if (own.length !== INITIATIVE_FACTS.length || INITIATIVE_FACTS.some((key) => !(key in entry))) return null;
  const efficiency = initiativeFactWithKeys(entry.efficiency, INITIATIVE_FACT_KEYS.efficiency);
  const closes = initiativeFactWithKeys(entry.closes, INITIATIVE_FACT_KEYS.closes);
  const burst = initiativeFactWithKeys(entry.burst, INITIATIVE_FACT_KEYS.burst);
  const delta = initiativeFactWithKeys(entry.delta, INITIATIVE_FACT_KEYS.delta);
  const prints = initiativeFactWithKeys(entry.prints, INITIATIVE_FACT_KEYS.prints);
  if (
    efficiency === null ||
    closes === null ||
    burst === null ||
    delta === null ||
    prints === null ||
    !isInitiativeUnitOrNull(efficiency.value) ||
    !isNonNegativeSafeInteger(closes.value) ||
    closes.value > MAX_INITIATIVE_WINDOW ||
    closes.value > windowCandles ||
    !isInitiativeAmountOrNull(burst.value) ||
    !isInitiativeUnitOrNull(delta.rank) ||
    !isInitiativeUnitOrNull(delta.share) ||
    !isInitiativeUnitOrNull(prints.rank) ||
    !isInitiativeAmountOrNull(prints.perCandle)
  ) {
    return null;
  }
  return {
    efficiency: { yes: efficiency.yes as boolean, value: efficiency.value },
    closes: { yes: closes.yes as boolean, value: closes.value },
    burst: { yes: burst.yes as boolean, value: burst.value },
    delta: { yes: delta.yes as boolean, rank: delta.rank, share: delta.share },
    prints: { yes: prints.yes as boolean, rank: prints.rank, perCandle: prints.perCandle },
  };
}

function parseInitiativeBand(raw: unknown): InitiativeBand | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (Object.keys(entry).length !== INITIATIVE_BAND_KEYS) return null;
  if (
    typeof entry.id !== "string" ||
    entry.id.length === 0 ||
    entry.id.length > MAX_INITIATIVE_ID_LENGTH ||
    typeof entry.candleMs !== "number" ||
    !INITIATIVE_CANDLE_MS.has(entry.candleMs) ||
    typeof entry.side !== "string" ||
    !INITIATIVE_SIDES.has(entry.side) ||
    typeof entry.dominant !== "string" ||
    !INITIATIVE_DOMINANTS.has(entry.dominant) ||
    !isInitiativeUnit(entry.dominantShare) ||
    !isNonNegativeSafeInteger(entry.score) ||
    entry.score > MAX_INITIATIVE_SCORE ||
    !isNonNegativeSafeInteger(entry.windowCandles) ||
    entry.windowCandles < 1 ||
    entry.windowCandles > MAX_INITIATIVE_WINDOW ||
    !isValidEpochTimestamp(entry.pivotTs) ||
    !isValidEpochTimestamp(entry.frozenTs) ||
    !isValidEpochTimestamp(entry.legExtremeTs) ||
    !isValidEpochTimestamp(entry.updatedAt) ||
    (entry.legEndTs !== null && !isValidEpochTimestamp(entry.legEndTs)) ||
    entry.frozenTs <= entry.pivotTs ||
    entry.legExtremeTs < entry.frozenTs ||
    (entry.legEndTs !== null && (entry.legEndTs as number) < entry.frozenTs) ||
    entry.updatedAt < entry.frozenTs ||
    !isPositiveFiniteNumber(entry.pivotPrice) ||
    !isPositiveFiniteNumber(entry.frozenPrice) ||
    !isPositiveFiniteNumber(entry.legExtremePrice) ||
    !isPositiveFiniteNumber(entry.atr) ||
    typeof entry.origin !== "string" ||
    !INITIATIVE_ORIGINS.has(entry.origin)
  ) {
    return null;
  }
  const facts = parseInitiativeFacts(entry.facts, entry.windowCandles);
  if (facts === null) return null;
  return {
    id: entry.id,
    candleMs: entry.candleMs as ExhaustionCandleMs,
    side: entry.side as InitiativeSide,
    dominant: entry.dominant as InitiativeDominant,
    dominantShare: entry.dominantShare,
    score: entry.score,
    facts,
    pivotTs: entry.pivotTs,
    pivotPrice: entry.pivotPrice,
    frozenTs: entry.frozenTs,
    frozenPrice: entry.frozenPrice,
    windowCandles: entry.windowCandles,
    atr: entry.atr,
    legExtremePrice: entry.legExtremePrice,
    legExtremeTs: entry.legExtremeTs,
    legEndTs: entry.legEndTs as number | null,
    updatedAt: entry.updatedAt,
    origin: entry.origin as InitiativeOrigin,
  };
}

function initiativeBandBefore(a: InitiativeBand, b: InitiativeBand): boolean {
  return a.pivotTs < b.pivotTs || (a.pivotTs === b.pivotTs && a.id < b.id);
}

function parseInitiativeBandsFrame(raw: Record<string, unknown>, context: FrameParseContext): InitiativeBandsFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["ts", "seq", "reset", "bands", "liveSince", "loading"]) ||
    !isValidEpochTimestamp(raw.ts) ||
    !isValidEpochTimestamp(raw.liveSince) ||
    (raw.loading !== null && !isValidEpochTimestamp(raw.loading)) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isNonNegativeSafeInteger(raw.seq) ||
    typeof raw.reset !== "boolean" ||
    !Array.isArray(raw.bands) ||
    raw.bands.length > MAX_INITIATIVE_BANDS ||
    (!raw.reset && raw.bands.length === 0)
  ) {
    return null;
  }
  const bands: InitiativeBand[] = [];
  const ids = new Set<string>();
  for (const entry of raw.bands) {
    const band = parseInitiativeBand(entry);
    if (!band || ids.has(band.id) || (bands.length > 0 && initiativeBandBefore(band, bands[bands.length - 1]))) return null;
    ids.add(band.id);
    bands.push(band);
  }
  return { type: "initiative_bands", symbol: raw.symbol as string, ...identity, ts: raw.ts, seq: raw.seq, reset: raw.reset, bands, liveSince: raw.liveSince, loading: raw.loading as number | null };
}

function parseCandleMonitorTrade(raw: unknown): CandleMonitorTrade | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const trade = raw as Record<string, unknown>;
  if (Object.keys(trade).length !== 2 || !isPositiveFiniteNumber(trade.price) || !isCandleMonitorAmount(trade.size) || trade.size <= 0) return undefined;
  return { price: trade.price, size: trade.size };
}

function isCandleMonitorAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_CANDLE_MONITOR_AMOUNT;
}

function parseCandleMonitorEntry(raw: unknown): CandleMonitorEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (Object.keys(entry).length !== CANDLE_MONITOR_ENTRY_KEYS) return null;
  const biggestBuy = parseCandleMonitorTrade(entry.biggestBuy);
  const biggestSell = parseCandleMonitorTrade(entry.biggestSell);
  if (
    biggestBuy === undefined ||
    biggestSell === undefined ||
    typeof entry.candleMs !== "number" ||
    !EXHAUSTION_CANDLE_MS.has(entry.candleMs) ||
    !isValidEpochTimestamp(entry.candleTs) ||
    entry.candleTs % entry.candleMs !== 0 ||
    !isCandleMonitorAmount(entry.buy) ||
    !isCandleMonitorAmount(entry.sell)
  ) {
    return null;
  }
  return {
    candleMs: entry.candleMs as ExhaustionCandleMs,
    candleTs: entry.candleTs,
    buy: entry.buy,
    sell: entry.sell,
    biggestBuy,
    biggestSell,
  };
}

function parseCandleMonitorFrame(raw: Record<string, unknown>, context: FrameParseContext): CandleMonitorFrame | null {
  const identity = parseFrameIdentity(raw);
  if (!identity || !hasExactFrameKeys(raw, identity, ["ts", "entries"]) || !isValidEpochTimestamp(raw.ts) || !timestampNotTooFarInFuture(raw.ts, context) || !Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > MAX_CANDLE_MONITOR_ENTRIES) {
    return null;
  }
  const entries: CandleMonitorEntry[] = [];
  let previous = -1;
  for (const item of raw.entries) {
    const entry = parseCandleMonitorEntry(item);
    if (!entry || entry.candleMs <= previous) return null;
    previous = entry.candleMs;
    entries.push(entry);
  }
  return { type: "candle_monitor", symbol: raw.symbol as string, ...identity, ts: raw.ts, entries };
}

function parseMarkerHistoryFrame(
  raw: Record<string, unknown>,
): MarkerHistoryFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["reset", "seq", "rows"]) ||
    typeof raw.reset !== "boolean" ||
    !Number.isSafeInteger(raw.seq) ||
    (raw.seq as number) < 0 ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > MAX_MARKER_HISTORY_ROWS
  ) {
    return null;
  }
  const markers: MarkerFrame[] = [];
  const ids = new Set<string>();
  let previousTs = -1;
  for (const row of raw.rows) {
    if (!Array.isArray(row) || row.length !== 5) return null;
    const [tsExchange, price, size, side, tradeId] = row as unknown[];
    if (
      !isValidEpochTimestamp(tsExchange) ||
      tsExchange < previousTs ||
      !isPositiveFiniteNumber(price) ||
      !isTradeSize(size, identity) ||
      (side !== "b" && side !== "s") ||
      !isValidTradeId(tradeId) ||
      ids.has(tradeId)
    ) {
      return null;
    }
    ids.add(tradeId);
    previousTs = tsExchange;
    markers.push({
      type: "marker",
      symbol: raw.symbol as string,
      ...identity,
      ts_exchange: tsExchange,
      price,
      size,
      side: side === "b" ? "buy" : "sell",
      trade_id: tradeId,
    });
  }
  return {
    type: "marker_history",
    symbol: raw.symbol as string,
    ...identity,
    reset: raw.reset,
    seq: raw.seq as number,
    markers,
  };
}

const L2_WALL_VERDICTS: ReadonlySet<string> = LIQUIDITY_LEVEL_VERDICTS;
const L2_WALL_DETAIL_FIELDS = [
  "life_ms", "first_shrink_ts", "first_shrink_exact", "reached_at_first_shrink", "traded", "absorbed", "swept", "hidden",
  "cleared", "fill_ratio", "cross_side", "cross_side_share", "end_distance_rows", "end_distance_pct", "cleared_by_trades",
  "continuity", "repeats", "repeats_complete", "evidence_gap",
] as const;
const L2_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  wall_born: ["event", "ts", "wall", "side", "row", "span", "size"],
  wall_shrink: ["event", "ts", "wall", "exact", "reached"],
  wall_trade: ["event", "ts", "wall", "mode", "price", "size"],
  wall_hidden: ["event", "ts", "wall", "volume"],
  wall_end: ["event", "ts", "wall", "ended_by", "distance_rows"],
  trade: ["event", "ts", "side", "aggressor", "mode", "price", "size", "late"],
  hidden: ["event", "ts", "side", "price", "volume"],
  segment: ["event", "ts", "segment", "state", "cause"],
});

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value >= 1;
}

function isNullableNonNegative(value: unknown): value is number | null {
  return value === null || isNonNegativeFiniteNumber(value);
}

function isL2SegmentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_L2_SEGMENT_ID_LENGTH;
}

function parseL2Segment(raw: unknown): L2Segment | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const segment = raw as Record<string, unknown>;
  if (!hasExactKeys(segment, ["id", "state"]) || !isL2SegmentId(segment.id) || (segment.state !== "LIVE" && segment.state !== "GAP")) {
    return undefined;
  }
  return { id: segment.id, state: segment.state };
}

function parseL2ViewFrame(raw: Record<string, unknown>, context: FrameParseContext): L2ViewFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["lane", "tier", ...LIQUIDITY_FRAME_FIELDS, "segment"]) ||
    !isPositiveSafeInteger(raw.lane) ||
    raw.lane > MAX_L2_LANE ||
    (raw.tier !== "recent" && raw.tier !== "deep") ||
    !isValidEpochTimestamp(raw.ts) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isNonNegativeSafeInteger(raw.seq) ||
    typeof raw.reset !== "boolean" ||
    !isPositiveFiniteNumber(raw.row_width) ||
    !isPositiveSafeInteger(raw.column_ms) ||
    !Array.isArray(raw.columns) ||
    raw.columns.length > MAX_LIQUIDITY_COLUMNS ||
    (!raw.reset && raw.columns.length === 0) ||
    raw.seq < raw.columns.length
  ) {
    return null;
  }
  const segment = parseL2Segment(raw.segment);
  if (segment === undefined) return null;
  const sizeCeiling = sizeCeilingFor(identity);
  const columns: LiquidityColumnFrame[] = [];
  let previousTs = -1;
  for (const entry of raw.columns) {
    const parsed = parseLiquidityColumn(entry, raw.ts, raw.column_ms, previousTs, sizeCeiling);
    if (!parsed || parsed.prints !== undefined || parsed.prints_floor !== undefined) return null;
    previousTs = parsed.ts;
    columns.push(parsed);
  }
  return {
    type: "l2_view",
    symbol: raw.symbol as string,
    ...identity,
    lane: raw.lane,
    tier: raw.tier,
    ts: raw.ts,
    seq: raw.seq,
    reset: raw.reset,
    row_width: raw.row_width,
    column_ms: raw.column_ms,
    columns,
    segment,
  };
}

function parseL2WallDetail(raw: unknown, ended: boolean, sizeCeiling: number): L2WallDetailWire | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object") return undefined;
  const detail = raw as Record<string, unknown>;
  const continuity = detail.continuity as Record<string, unknown> | null;
  if (
    !hasExactKeys(detail, L2_WALL_DETAIL_FIELDS) ||
    !(ended ? isNonNegativeSafeInteger(detail.life_ms) : detail.life_ms === null) ||
    !(detail.first_shrink_ts === null || isValidEpochTimestamp(detail.first_shrink_ts)) ||
    typeof detail.first_shrink_exact !== "boolean" ||
    !(detail.reached_at_first_shrink === null || typeof detail.reached_at_first_shrink === "boolean") ||
    !isSizeWithin(detail.traded, sizeCeiling) ||
    !isSizeWithin(detail.absorbed, sizeCeiling) ||
    !isSizeWithin(detail.swept, sizeCeiling) ||
    !isSizeWithin(detail.hidden, sizeCeiling) ||
    !isSizeWithin(detail.cleared, sizeCeiling) ||
    !isFiniteNumber(detail.fill_ratio) ||
    detail.fill_ratio < 0 ||
    detail.fill_ratio > 1 ||
    !isSizeWithin(detail.cross_side, sizeCeiling) ||
    !isNonNegativeFiniteNumber(detail.cross_side_share) ||
    !isNullableNonNegative(detail.end_distance_rows) ||
    !isNullableNonNegative(detail.end_distance_pct) ||
    typeof detail.cleared_by_trades !== "boolean" ||
    !(continuity === null || (typeof continuity === "object" && hasExactKeys(continuity, ["gap_ms"]) && isNonNegativeSafeInteger(continuity.gap_ms))) ||
    !isPositiveSafeInteger(detail.repeats) ||
    typeof detail.repeats_complete !== "boolean" ||
    typeof detail.evidence_gap !== "boolean"
  ) {
    return undefined;
  }
  return {
    life_ms: detail.life_ms as number | null,
    first_shrink_ts: detail.first_shrink_ts as number | null,
    first_shrink_exact: detail.first_shrink_exact,
    reached_at_first_shrink: detail.reached_at_first_shrink as boolean | null,
    traded: detail.traded,
    absorbed: detail.absorbed,
    swept: detail.swept,
    hidden: detail.hidden,
    cleared: detail.cleared,
    fill_ratio: detail.fill_ratio,
    cross_side: detail.cross_side,
    cross_side_share: detail.cross_side_share,
    end_distance_rows: detail.end_distance_rows as number | null,
    end_distance_pct: detail.end_distance_pct as number | null,
    cleared_by_trades: detail.cleared_by_trades,
    continuity: continuity === null ? null : { gap_ms: continuity.gap_ms as number },
    repeats: detail.repeats,
    repeats_complete: detail.repeats_complete,
    evidence_gap: detail.evidence_gap,
  };
}

function parseL2Wall(raw: unknown, frameTs: number, sizeCeiling: number): L2WallWire | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, lane = 0, detail, ...rest } = raw as Record<string, unknown>;
  if (!Object.hasOwn(raw, "id") || !Object.hasOwn(raw, "detail") || !isPositiveSafeInteger(id)) return null;
  if (!isNonNegativeSafeInteger(lane) || lane > MAX_L2_LANE) return null;
  const level = parseLiquidityLevel(rest, frameTs, sizeCeiling);
  if (!level) return null;
  const parsedDetail = parseL2WallDetail(detail, level.end_ts !== null, sizeCeiling);
  if (parsedDetail === undefined) return null;
  return { id, ...(Object.hasOwn(raw, "lane") ? { lane } : {}), ...level, detail: parsedDetail };
}

function parseL2WallsFrame(raw: Record<string, unknown>, context: FrameParseContext): L2WallsFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["ts", "seq", "reset", "row_width", "walls", "removed", "segment"]) ||
    !isValidEpochTimestamp(raw.ts) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isNonNegativeSafeInteger(raw.seq) ||
    typeof raw.reset !== "boolean" ||
    !isPositiveFiniteNumber(raw.row_width) ||
    !Array.isArray(raw.walls) ||
    raw.walls.length > MAX_L2_WALLS ||
    !Array.isArray(raw.removed) ||
    raw.removed.length > MAX_L2_REMOVED ||
    (raw.reset && raw.removed.length > 0) ||
    (!raw.reset && raw.walls.length === 0 && raw.removed.length === 0)
  ) {
    return null;
  }
  const segment = parseL2Segment(raw.segment);
  if (segment === undefined) return null;
  const sizeCeiling = sizeCeilingFor(identity);
  const seen = new Set<number>();
  const walls: L2WallWire[] = [];
  for (const entry of raw.walls) {
    const wall = parseL2Wall(entry, raw.ts, sizeCeiling);
    if (!wall || seen.has(wall.id)) return null;
    seen.add(wall.id);
    walls.push(wall);
  }
  const removed: number[] = [];
  for (const id of raw.removed) {
    if (!isPositiveSafeInteger(id) || seen.has(id)) return null;
    seen.add(id);
    removed.push(id);
  }
  return { type: "l2_walls", symbol: raw.symbol as string, ...identity, ts: raw.ts, seq: raw.seq, reset: raw.reset, row_width: raw.row_width, walls, removed, segment };
}

function parseL2Event(raw: unknown, frameTs: number, sizeCeiling: number): L2EventWire | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as Record<string, unknown>;
  const fields = typeof event.event === "string" && Object.hasOwn(L2_EVENT_FIELDS, event.event) ? L2_EVENT_FIELDS[event.event] : null;
  if (fields === null || !hasExactKeys(event, fields) || !isValidEpochTimestamp(event.ts) || event.ts > frameTs) return null;
  const ts = event.ts;
  const isSide = (value: unknown): value is "bid" | "ask" => value === "bid" || value === "ask";
  const isMode = (value: unknown): value is "absorbed" | "swept" => value === "absorbed" || value === "swept";
  switch (event.event) {
    case "wall_born":
      if (!isPositiveSafeInteger(event.wall) || !isSide(event.side) || !isNonNegativeSafeInteger(event.row) || !isPositiveSafeInteger(event.span) || !isSizeWithin(event.size, sizeCeiling)) return null;
      return { event: "wall_born", ts, wall: event.wall, side: event.side, row: event.row, span: event.span, size: event.size };
    case "wall_shrink":
      if (!isPositiveSafeInteger(event.wall) || typeof event.exact !== "boolean" || !(event.reached === null || typeof event.reached === "boolean")) return null;
      return { event: "wall_shrink", ts, wall: event.wall, exact: event.exact, reached: event.reached as boolean | null };
    case "wall_trade":
      if (!isPositiveSafeInteger(event.wall) || !isMode(event.mode) || !isPositiveFiniteNumber(event.price) || !isSizeWithin(event.size, sizeCeiling)) return null;
      return { event: "wall_trade", ts, wall: event.wall, mode: event.mode, price: event.price, size: event.size };
    case "wall_hidden":
      if (!isPositiveSafeInteger(event.wall) || !isSizeWithin(event.volume, sizeCeiling)) return null;
      return { event: "wall_hidden", ts, wall: event.wall, volume: event.volume };
    case "wall_end":
      if (!isPositiveSafeInteger(event.wall) || typeof event.ended_by !== "string" || !L2_WALL_VERDICTS.has(event.ended_by) || !isNullableNonNegative(event.distance_rows)) return null;
      return { event: "wall_end", ts, wall: event.wall, ended_by: event.ended_by as L2WallVerdict, distance_rows: event.distance_rows };
    case "trade":
      if (!isSide(event.side) || (event.aggressor !== "buy" && event.aggressor !== "sell") || !isMode(event.mode) || !isPositiveFiniteNumber(event.price) || !isSizeWithin(event.size, sizeCeiling) || typeof event.late !== "boolean") return null;
      return { event: "trade", ts, side: event.side, aggressor: event.aggressor, mode: event.mode, price: event.price, size: event.size, late: event.late };
    case "hidden":
      if (!isSide(event.side) || !isPositiveFiniteNumber(event.price) || !isSizeWithin(event.volume, sizeCeiling)) return null;
      return { event: "hidden", ts, side: event.side, price: event.price, volume: event.volume };
    default:
      if (!isL2SegmentId(event.segment) || (event.state !== "LIVE" && event.state !== "GAP") || !(event.cause === null || (typeof event.cause === "string" && event.cause.length <= MAX_L2_SEGMENT_ID_LENGTH))) return null;
      return { event: "segment", ts, segment: event.segment, state: event.state, cause: event.cause as string | null };
  }
}

function parseL2EventsFrame(raw: Record<string, unknown>, context: FrameParseContext): L2EventsFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["ts", "seq", "reset", "missed", "events"]) ||
    !isValidEpochTimestamp(raw.ts) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isNonNegativeSafeInteger(raw.seq) ||
    typeof raw.reset !== "boolean" ||
    !isNonNegativeSafeInteger(raw.missed) ||
    !Array.isArray(raw.events) ||
    raw.events.length > MAX_L2_EVENTS ||
    raw.seq < raw.events.length ||
    (!raw.reset && raw.events.length === 0 && raw.missed === 0)
  ) {
    return null;
  }
  const sizeCeiling = sizeCeilingFor(identity);
  const events: L2EventWire[] = [];
  let previousTs = -1;
  for (const entry of raw.events) {
    const event = parseL2Event(entry, raw.ts, sizeCeiling);
    if (!event || event.ts < previousTs) return null;
    previousTs = event.ts;
    events.push(event);
  }
  return { type: "l2_events", symbol: raw.symbol as string, ...identity, ts: raw.ts, seq: raw.seq, reset: raw.reset, missed: raw.missed, events };
}

function parseL2LadderSide(raw: unknown, descending: boolean, sizeCeiling: number): [number, number][] | null {
  if (!Array.isArray(raw) || raw.length > MAX_L2_LADDER_LEVELS) return null;
  const levels: [number, number][] = [];
  let previous: number | null = null;
  for (const level of raw) {
    if (!Array.isArray(level) || level.length !== 2) return null;
    const [price, size] = level as unknown[];
    if (!isPositiveFiniteNumber(price) || !isSizeWithin(size, sizeCeiling) || size === 0) return null;
    if (previous !== null && (descending ? price >= previous : price <= previous)) return null;
    previous = price;
    levels.push([price, size]);
  }
  return levels;
}

function parseL2LadderFrame(raw: Record<string, unknown>, context: FrameParseContext): L2LadderFrame | null {
  const identity = parseFrameIdentity(raw);
  if (
    !identity ||
    !hasExactFrameKeys(raw, identity, ["ts", "depth", "bids", "asks", "segment"]) ||
    !isValidEpochTimestamp(raw.ts) ||
    !timestampNotTooFarInFuture(raw.ts, context) ||
    !isPositiveSafeInteger(raw.depth) ||
    raw.depth > MAX_L2_LADDER_LEVELS
  ) {
    return null;
  }
  const bids = parseL2LadderSide(raw.bids, true, sizeCeilingFor(identity));
  const asks = parseL2LadderSide(raw.asks, false, sizeCeilingFor(identity));
  const segment = parseL2Segment(raw.segment);
  if (!bids || !asks || segment === undefined || bids.length > raw.depth || asks.length > raw.depth) return null;
  if (bids.length > 0 && asks.length > 0 && bids[0][0] >= asks[0][0]) return null;
  return { type: "l2_ladder", symbol: raw.symbol as string, ...identity, ts: raw.ts, depth: raw.depth, bids, asks, segment };
}

export function parseServerFrame(
  raw: unknown,
  context: FrameParseContext = {},
): ServerFrame | null {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.type === "analytics_status") {
    const identity = parseFrameIdentity(record);
    if (
      !identity ||
      !hasExactFrameKeys(record, identity, ["indicator", "status"]) ||
      (record.indicator !== "PROFILE" && record.indicator !== "VPIN") ||
      (record.status !== "READY" &&
        record.status !== "UNAVAILABLE" &&
        record.status !== "WARMING" &&
        record.status !== "EMPTY" &&
        record.status !== "CLOSED")
    )
      return null;
    return {
      type: "analytics_status",
      symbol: record.symbol as string,
      ...identity,
      indicator: record.indicator,
      status: record.status,
    };
  }
  if (record.type === "trade") {
    return parseTradeFrame(record, context);
  }
  if (record.type === "marker") {
    return parseMarkerFrame(record, context);
  }
  if (record.type === "bar") {
    return parseBarFrame(record, context);
  }
  if (record.type === "snapshot") {
    return parseSnapshotFrame(record, context);
  }
  if (record.type === "health") {
    return parseHealthFrame(record);
  }
  if (record.type === "book") {
    return parseBookFrame(record);
  }
  if (record.type === "selection") {
    return parseSelectionFrame(record);
  }
  if (record.type === "profile") {
    return parseProfileFrame(record, context);
  }
  if (record.type === "vpin") {
    return parseVpinFrame(record, context);
  }
  if (record.type === "liquidity") {
    return parseLiquidityFrame(record, context);
  }
  if (record.type === "aggressive_history") {
    return parseAggressiveHistoryFrame(record);
  }
  if (record.type === "delta_profile") {
    return parseDeltaProfileFrame(record);
  }
  if (record.type === "band_history") {
    return parseBandHistoryFrame(record);
  }
  if (record.type === "wall_history") {
    return parseWallHistoryFrame(record);
  }
  if (record.type === "l2_event_history") {
    return parseL2EventHistoryFrame(record);
  }
  if (record.type === "marker_history") {
    return parseMarkerHistoryFrame(record);
  }
  if (record.type === "iceberg_orders") {
    return parseIcebergOrdersFrame(record, context);
  }
  if (record.type === "exhaustion_shades") {
    return parseExhaustionShadesFrame(record, context);
  }
  if (record.type === "initiative_bands") {
    return parseInitiativeBandsFrame(record, context);
  }
  if (record.type === "candle_monitor") {
    return parseCandleMonitorFrame(record, context);
  }
  if (record.type === "l2_view") {
    return parseL2ViewFrame(record, context);
  }
  if (record.type === "l2_walls") {
    return parseL2WallsFrame(record, context);
  }
  if (record.type === "l2_events") {
    return parseL2EventsFrame(record, context);
  }
  if (record.type === "l2_ladder") {
    return parseL2LadderFrame(record, context);
  }
  return null;
}

const REJECTION_SCAN_NODE_LIMIT = 200_000;
const TIME_LIKE_KEY = /^(ts|id|seq)$|_ts$|Ts$|_ms$|Ms$|[Tt]ime|[Ss]eq[A-Z_]|_id$|Id$/;

function rejectionLabel(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 32) : "?";
}

export function describeRejectedFrame(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "not-an-object";
  const record = raw as Record<string, unknown>;
  const identity = record.provider === "BINANCE" ? record.marketKind : record.assetClass;
  const head = `${rejectionLabel(record.type)}:${rejectionLabel(record.symbol)}:${rejectionLabel(identity)}`;
  const stack: Array<[unknown, string, string]> = [[raw, "", ""]];
  let visited = 0;
  let largestPath = "";
  let largestValue = -Infinity;
  let negativePath = "";
  while (stack.length > 0 && visited < REJECTION_SCAN_NODE_LIMIT) {
    const [node, path, key] = stack.pop() as [unknown, string, string];
    visited += 1;
    if (typeof node === "number") {
      if (TIME_LIKE_KEY.test(key)) continue;
      if (node < 0 && negativePath === "") negativePath = `${path}=${node}`;
      if (node > largestValue) {
        largestValue = node;
        largestPath = path;
      }
      continue;
    }
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) stack.push([node[index], `${path}[${index}]`, key]);
      continue;
    }
    if (typeof node === "object" && node !== null) {
      for (const [childKey, child] of Object.entries(node)) stack.push([child, path === "" ? childKey : `${path}.${childKey}`, childKey]);
    }
  }
  const largest = largestValue === -Infinity ? "none" : `${largestPath}=${largestValue}`;
  const overCeiling = largestValue > MAX_REASONABLE_MAGNITUDE ? `>${MAX_REASONABLE_MAGNITUDE}` : "within-ceiling";
  const negative = negativePath === "" ? "" : ` negative ${negativePath}`;
  const truncated = stack.length > 0 ? " scan-truncated" : "";
  return `${head} largest ${largest} ${overCeiling}${negative}${truncated}`;
}
