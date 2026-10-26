// Browser-direct data mode: the market-data worker talks to Binance itself
// instead of to the runtime's WebSocket server, and turns Binance's REST and
// stream payloads into the canonical frames of apps/web/src/types/frames.ts.
// It presents the subset of the WebSocket interface the worker uses, so the
// worker is unchanged apart from the factory that picks the transport. Every
// frame leaves here as a JSON string, so the worker's parser stays the
// contract gate in production exactly as it is with the runtime.
//
// Opt-in only (VITE_DATA_SOURCE=browser-binance or ?source=browser-binance).
// Spot pairs use Binance's public mirror (CORS-enabled REST and streams);
// perpetual pairs are attempted on the futures endpoints and fail honestly
// when the browser cannot reach them; dxFeed instruments are unavailable.
//
// Tape-derived frames (L1 parity): the worker also runs the runtime's own
// large-trade retention and aggressive-print pool over the live tape and over
// a bounded REST bootstrap of recent aggregate trades, so `marker`, the
// snapshot's `markers` and `aggressive_prints*`, `marker_history` and
// `aggressive_history` are produced here as the runtime would produce them
// (lib/tape mirrors the runtime modules; workers/tests/tapeParity.test.ts
// proves them equal).
import marketInstrumentCatalog from "../../../../config/market-instruments.json";
import type { FrameIdentity, MarketKind, MarkerFrame, TradeFrame } from "../types/frames";
import { createTimeCoveredMarkerRetentionBuffer, type MarkerRetentionBuffer } from "../lib/chart/markerRetention";
import { createAggressivePool, DEFAULT_CALIBRATION_MS, DEFAULT_WINDOW_MS as POOL_WINDOW_MS, type AggressivePool } from "../lib/tape/aggressivePool";
import { MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE } from "../lib/tape/largeTradeDetection";

export const BROWSER_BINANCE_SOURCE = "browser-binance";
export type DataSource = typeof BROWSER_BINANCE_SOURCE;

export const DATA_SOURCE_QUERY_KEY = "source";

/**
 * The data source for this page: the `?source=` query wins (so a deployed
 * bundle can be switched either way), then the build-time VITE_DATA_SOURCE.
 * Anything but "browser-binance" means the runtime WebSocket, as today.
 */
export function resolveDataSource(envValue: unknown, search: string | undefined): DataSource | undefined {
  let fromQuery: string | null = null;
  if (typeof search === "string" && search.length > 0) {
    try {
      fromQuery = new URLSearchParams(search).get(DATA_SOURCE_QUERY_KEY);
    } catch {
      fromQuery = null;
    }
  }
  if (fromQuery !== null) return fromQuery === BROWSER_BINANCE_SOURCE ? BROWSER_BINANCE_SOURCE : undefined;
  return envValue === BROWSER_BINANCE_SOURCE ? BROWSER_BINANCE_SOURCE : undefined;
}

/** The part of the WebSocket interface marketDataWorker.ts uses. A real WebSocket satisfies it. */
export interface TransportSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

/** What this transport needs from the upstream (Binance) WebSocket. */
export interface UpstreamSocket {
  readyState: number;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type BrowserBinanceEndpoints = {
  spotRestBase: string;
  spotStreamBase: string;
  perpetualRestBase: string;
  perpetualStreamBase: string;
};

export const DEFAULT_ENDPOINTS: Readonly<BrowserBinanceEndpoints> = Object.freeze({
  spotRestBase: "https://data-api.binance.vision",
  spotStreamBase: "wss://data-stream.binance.vision:9443",
  perpetualRestBase: "https://fapi.binance.com",
  perpetualStreamBase: "wss://fstream.binance.com",
});

export type BrowserBinanceTransportOptions = {
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => UpstreamSocket;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  endpoints?: Partial<BrowserBinanceEndpoints>;
};

export const SNAPSHOT_BARS = 900;
export const BAR_INTERVAL_MS = 60_000;
export const REST_TIMEOUT_MS = 10_000;
export const STREAM_BACKOFF_INITIAL_MS = 1_000;
export const STREAM_BACKOFF_CAP_MS = 30_000;
export const STREAM_FAILURES_BEFORE_UNAVAILABLE = 5;
/** A browser WebSocket has no connect timeout of its own; a proxy that swallows the upgrade would otherwise leave the book "connecting" for good. */
export const STREAM_CONNECT_TIMEOUT_MS = 15_000;
/** Klines per REST page while filling a gap; Binance's maximum. */
export const GAP_FILL_PAGE = 1_000;
/** Pages a gap fill may walk before the history is simply re-read as a fresh snapshot (11,000 minutes covers the 10,080 bars the browser keeps and stays inside the parser's eight-day live window). */
export const MAX_GAP_FILL_PAGES = 11;
export const MAX_GAP_FILL_MS = MAX_GAP_FILL_PAGES * GAP_FILL_PAGE * BAR_INTERVAL_MS;
/** Closed bars held back while a gap fill is pending; older ones are dropped and come back through the paginated REST read instead. */
export const MAX_HELD_CLOSED_BARS = 120;
/**
 * A REST row is taken as final only when its minute closed this long before
 * the request went out: a row served while its minute was still open is
 * partial, and the browser's clock may lead the exchange's by a little.
 */
export const CLOSE_CONFIRMATION_MARGIN_MS = 5_000;
/** Consecutive fills that found the same minute missing before the history is re-read as a snapshot that carries the gap as a gap. */
export const MAX_HOLE_RETRIES = 3;

/** Aggregate trades per REST page while bootstrapping the tape; Binance's maximum. */
export const TAPE_BOOTSTRAP_PAGE = 1_000;
/** Pages the bootstrap walks back from now (weight 4 each: 120 of the 6,000 per minute budget). On BTC-USDT this is minutes of tape, on a quiet pair hours. */
export const MAX_TAPE_BOOTSTRAP_PAGES = 30;
/** Failed attempts (no page read at all) before the READY health frame says the tape history is missing; retries continue. */
export const TAPE_BOOTSTRAP_FAILURES_BEFORE_DEGRADED = 3;
/** Pages a seam fill (the tape between two observed stretches) may walk before the gap is left open. */
export const MAX_SEAM_FILL_PAGES = 10;
/** Failed reads of one seam before its gap is left open. */
export const SEAM_FILL_FAILURES_BEFORE_GIVING_UP = 3;
/** With a stream open but silent when the bootstrap pages are all read, how long they wait for a first trade before committing without one. */
export const BOOTSTRAP_COMMIT_GRACE_MS = 2_000;
/** Bounds on the coverage bookkeeping, beyond the retention pruning. */
export const MAX_COVERAGE_ENTRIES = 128;
export const MAX_UNVERIFIED_MS = 1_024;
/** Pairs whose tape state (markers, pool, coverage) is kept across transport instances, so a reconnect does not bootstrap again. */
export const MAX_TAPE_STATES = 4;
/** How far back a marker is kept, as the runtime's large-trade history window (BACKFILL_DAYS). */
export const MARKER_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The runtime's history buffer caps (history.js DEFAULT_MAX_MARKERS, DEFAULT_MAX_TRADES) and the wire's snapshot caps (frames.js). */
export const MAX_RETAINED_MARKERS = 100_000;
export const SNAPSHOT_RECENT_TRADES = 100;
export const MAX_SNAPSHOT_MARKERS = 5_000;
export const MAX_MARKER_HISTORY_ROWS = 5_000;
export const MAX_SNAPSHOT_CLOSED_BARS = 10_080;
/** aggressive_history contract limits (frames.js MAX_AGGRESSIVE_HISTORY_TRADES, aggressive-history.js). */
export const MAX_AGGRESSIVE_HISTORY_TRADES = 10_000;
export const MAX_AGGRESSIVE_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AGGRESSIVE_HISTORY_FUTURE_SKEW_MS = 60_000;
const MAX_HISTORY_CURSOR_LENGTH = 512;
const HISTORY_CURSOR_VERSION = 1;

export const HEALTH_REASON_READY = "BROWSER_DIRECT";
/** READY, but the REST bootstrap of recent trades failed: markers and the print pool start at connect. */
export const HEALTH_REASON_NO_TAPE_HISTORY = "BROWSER_DIRECT_NO_TAPE_HISTORY";
export const HEALTH_REASON_STREAM_CLOSED = "BROWSER_DIRECT_STREAM_CLOSED";
export const HEALTH_REASON_STREAM_UNAVAILABLE = "BROWSER_DIRECT_STREAM_UNAVAILABLE";
export const HEALTH_REASON_REST_FAILED = "BROWSER_DIRECT_REST_FAILED";
export const HEALTH_REASON_PERPETUAL_UNREACHABLE = "BROWSER_DIRECT_PERPETUAL_UNREACHABLE";
export const HEALTH_REASON_NO_DXFEED = "BROWSER_DIRECT_NO_DXFEED";
export const BOOK_REASON_STREAM_CONNECTING = "BROWSER_DIRECT_STREAM_CONNECTING";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

type Selection = { symbol: string } & FrameIdentity;

type Session = {
  readonly selection: Selection;
  readonly binanceSymbol: string;
  readonly restBase: string;
  readonly streamBase: string;
  stream: UpstreamSocket | null;
  connectTimer: unknown;
  /** Counts stream sockets; a recovery belongs to the generation whose open started it. */
  streamGeneration: number;
  /** A degraded health frame went out; the next open stream owes a READY, after a successful REST gap fill. */
  degraded: boolean;
  /** A gap fill is pending: live kline events wait in the buffer so closed bars reach the main thread in order, without gaps. */
  recovering: boolean;
  heldClosedBars: Map<number, KlineRow>;
  heldFormingBar: KlineRow | null;
  /** A READY book went out since the stream last opened; it is withdrawn when the stream is lost. */
  bookLive: boolean;
  /** A REST read is in flight for the recovery. */
  fillInFlight: boolean;
  /** The minute after the boundary closed on the clock but is not yet confirmable from REST; the stream's own close for it ends the recovery. */
  awaitingBoundary: number | null;
  holeRetries: number;
  streamFailures: number;
  backoffMs: number;
  lastClosedOpen: number;
  abort: AbortController | null;
  timer: unknown;
  closed: boolean;
  /** Every closed bar delivered so far, by open time, for the snapshot re-broadcasts; bounded like the runtime's history buffer. */
  closedBars: Map<number, ClosedBar>;
  /** The newest forming bar delivered, re-sent after a snapshot re-broadcast so the chart keeps its forming minute. */
  lastFormingBar: KlineRow | null;
  /** The newest live trades, as the runtime's snapshot carries its last 100. */
  recentTrades: TradeFrame[];
  /** The runtime's large-trade retention: four prints of largest notional per minute and side. */
  markers: MarkerRetentionBuffer;
  /** The runtime's aggressive-print pool over the bootstrap and the live tape. */
  pool: AggressivePool<TradeFrame>;
  /**
   * The stretches of tape observed in full, oldest first, merged when they
   * touch: the bootstrap's id-contiguous pages, seam fills, and every closed
   * stream span (first to last live trade). Coverage is claimed only inside
   * one of them, or the open stream span.
   */
  observed: TapeInterval[];
  /** Every closed stream span with its first and last trade ids: REST rows inside one are tape the stream delivered. */
  liveSpans: LiveSpan[];
  /** The open stream span (`to` Infinity): its first and last live trade so far; null while no stream delivers. */
  live: (LiveSpan & { last: number }) | null;
  /** Gaps between observed stretches that a seam fill could not close; they stay open. */
  unfillable: TapeInterval[];
  /** Boundary milliseconds whose aggregate trades straddle a live span's first or last trade and cannot be split by id: outside every claim. */
  unverified: number[];
  /** The bootstrap's calibration window start: rows from it calibrate the pool's floor, as the runtime's newest warm-up chunk does. */
  calibrationFrom: number;
  tape: TapeBootstrap;
  seam: SeamFill;
  markerHistorySeq: number;
};

/** A closed, inclusive stretch of exchange time, with the trade or aggregate id its ends were observed at, when known. */
type TapeInterval = { from: number; to: number; startTradeId?: number; endTradeId?: number; endAggId?: number };

/** A stream span: exchange time and trade id of its first and last trade (`to`/`lastId` Infinity while open). */
type LiveSpan = { from: number; to: number; firstId: number; lastId: number };

/** The tape state of a pair, kept across transport instances (a lost stream closes the transport, as a lost runtime socket would). */
type TapeState = {
  markers: MarkerRetentionBuffer;
  pool: AggressivePool<TradeFrame>;
  observed: TapeInterval[];
  liveSpans: LiveSpan[];
  unfillable: TapeInterval[];
  unverified: number[];
  calibrationFrom: number;
  recentTrades: TradeFrame[];
  done: boolean;
};

const tapeStates = new Map<string, TapeState>();

function tapeStateKey(selection: Selection): string {
  return selection.provider === "BINANCE" ? `BINANCE:${selection.symbol}:${selection.marketKind}` : `${selection.provider}:${selection.symbol}:${selection.assetClass}`;
}

/** Forgets every pair's kept tape state (tests). */
export function clearBrowserTapeStates(): void {
  tapeStates.clear();
}

type SeamFill = {
  inFlight: boolean;
  /** The gap being filled: the tape strictly between two observed stretches. */
  gap: TapeInterval | null;
  failures: number;
  backoffMs: number;
  abort: AbortController | null;
  timer: unknown;
  /** The bootstrap finished (or a seam closed) and the snapshot waits for the remaining seams to settle. */
  publishWhenSettled: boolean;
};

type TapeBootstrap = {
  started: boolean;
  inFlight: boolean;
  done: boolean;
  /** Attempts that read nothing at all. */
  attempts: number;
  /** The READY health frame carries HEALTH_REASON_NO_TAPE_HISTORY. */
  unavailable: boolean;
  backoffMs: number;
  abort: AbortController | null;
  timer: unknown;
  /** Validated pages read and not yet reconciled against the live tape, newest page first. */
  staged: AggTradeRow[][];
  graceTimer: unknown;
  /** The walk reached the exchange's first aggregate trade, so the oldest row's millisecond holds no unread aggregate. */
  startVerified: boolean;
};

type ClosedBar = KlineRow & { reconstructed: boolean };

/** One REST aggregate trade: [a] id, [p] price, [q] summed quantity, [f]/[l] first and last fill (trade) id, [T] time, [m] buyer is maker. */
type AggTradeRow = { a: number; p: number; q: number; f: number; l: number; T: number; m: boolean };

type AggressiveHistoryRequest = { requestId: number; fromMs: number; toMs: number; minSize: number; cursor: string | null };

type KlineRow = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number | undefined;
  tradeCount: number;
};

function defaultSelection(): Selection {
  const first = (marketInstrumentCatalog.binance as ReadonlyArray<{ symbol: string; marketKind: string }>)
    .find((entry) => entry.marketKind === "SPOT") ?? marketInstrumentCatalog.binance[0];
  return { symbol: first.symbol, provider: "BINANCE", marketKind: first.marketKind as MarketKind };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function identityFields(selection: Selection): Record<string, unknown> {
  return selection.provider === "BINANCE"
    ? { provider: "BINANCE", symbol: selection.symbol, marketKind: selection.marketKind }
    : { provider: selection.provider, symbol: selection.symbol, assetClass: selection.assetClass };
}

function parseSelectRequest(msg: Record<string, unknown>): Selection | null {
  if (typeof msg.symbol !== "string" || msg.symbol.length === 0) return null;
  if (msg.provider === "BINANCE") {
    if (msg.marketKind !== "SPOT" && msg.marketKind !== "PERPETUAL") return null;
    return { symbol: msg.symbol, provider: "BINANCE", marketKind: msg.marketKind };
  }
  if (msg.provider === "DXFEED") {
    if (msg.assetClass !== "FUTURE" && msg.assetClass !== "EQUITY") return null;
    return { symbol: msg.symbol, provider: "DXFEED", assetClass: msg.assetClass };
  }
  return null;
}

/** Parses one REST kline row: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]. */
export function parseKlineRow(row: unknown): KlineRow | null {
  if (!Array.isArray(row) || row.length < 11) return null;
  const openTime = row[0];
  const closeTime = row[6];
  const tradeCount = row[8];
  if (!Number.isSafeInteger(openTime) || (openTime as number) % BAR_INTERVAL_MS !== 0) return null;
  if (!Number.isSafeInteger(closeTime) || (closeTime as number) !== (openTime as number) + BAR_INTERVAL_MS - 1) return null;
  if (!Number.isSafeInteger(tradeCount) || (tradeCount as number) < 0) return null;
  return assembleBar({
    openTime: openTime as number,
    closeTime: closeTime as number,
    open: finiteNumber(row[1]),
    high: finiteNumber(row[2]),
    low: finiteNumber(row[3]),
    close: finiteNumber(row[4]),
    volume: finiteNumber(row[5]),
    buyVolume: finiteNumber(row[9]),
    tradeCount: tradeCount as number,
  });
}

function assembleBar(parts: {
  openTime: number;
  closeTime: number;
  open: number | undefined;
  high: number | undefined;
  low: number | undefined;
  close: number | undefined;
  volume: number | undefined;
  buyVolume: number | undefined;
  tradeCount: number;
}): KlineRow | null {
  const { open, high, low, close, volume } = parts;
  if (open === undefined || high === undefined || low === undefined || close === undefined || volume === undefined) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) return null;
  const buyVolume = parts.buyVolume !== undefined && parts.buyVolume >= 0 && parts.buyVolume <= volume ? parts.buyVolume : undefined;
  return { openTime: parts.openTime, closeTime: parts.closeTime, open, high, low, close, volume, buyVolume, tradeCount: parts.tradeCount };
}

/** Parses the `k` object of a kline stream event. */
export function parseKlineEvent(k: unknown): (KlineRow & { closed: boolean }) | null {
  if (!isRecord(k) || typeof k.x !== "boolean") return null;
  if (!Number.isSafeInteger(k.t) || (k.t as number) % BAR_INTERVAL_MS !== 0) return null;
  if (!Number.isSafeInteger(k.n) || (k.n as number) < 0) return null;
  const closeTime = Number.isSafeInteger(k.T) ? (k.T as number) : (k.t as number) + BAR_INTERVAL_MS - 1;
  const bar = assembleBar({
    openTime: k.t as number,
    closeTime,
    open: finiteNumber(k.o),
    high: finiteNumber(k.h),
    low: finiteNumber(k.l),
    close: finiteNumber(k.c),
    volume: finiteNumber(k.v),
    buyVolume: finiteNumber(k.V),
    tradeCount: k.n as number,
  });
  return bar === null ? null : { ...bar, closed: k.x };
}

function barFrame(selection: Selection, bar: KlineRow, closed: boolean, reconstructed: boolean): Record<string, unknown> {
  return {
    type: "bar",
    ...identityFields(selection),
    interval_ms: BAR_INTERVAL_MS,
    ts_open: bar.openTime,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    trade_count: bar.tradeCount,
    closed,
    ...(reconstructed ? { reconstructed: true } : {}),
    ...(bar.buyVolume !== undefined ? { buy_volume: bar.buyVolume } : {}),
  };
}

/** Parses one REST aggTrades row: { a, p, q, f, l, T, m, M }. */
export function parseAggTradeRow(raw: unknown): AggTradeRow | null {
  if (!isRecord(raw)) return null;
  const price = finiteNumber(raw.p);
  const size = finiteNumber(raw.q);
  if (price === undefined || size === undefined || price <= 0 || size <= 0) return null;
  if (!Number.isSafeInteger(raw.a) || (raw.a as number) < 0 || !Number.isSafeInteger(raw.T) || (raw.T as number) < 0 || typeof raw.m !== "boolean") return null;
  if (!Number.isSafeInteger(raw.f) || !Number.isSafeInteger(raw.l) || (raw.f as number) < 0 || (raw.l as number) < (raw.f as number)) return null;
  return { a: raw.a as number, p: price, q: size, f: raw.f as number, l: raw.l as number, T: raw.T as number, m: raw.m };
}

/**
 * One REST page, validated as a whole: every row well formed, no more rows
 * than asked, ids consecutive (Binance numbers aggregate trades without gaps
 * per symbol) and, for a page asked by `fromId`, starting at it. A page that
 * fails any of this is a failed read, never a shorter page: a dropped row
 * would otherwise end the walk early and leave a hole inside claimed coverage.
 */
export function parseAggTradesPage(body: unknown, fromId: number | null): AggTradeRow[] {
  if (!Array.isArray(body)) throw new Error("aggTrades: body is not an array");
  if (body.length > TAPE_BOOTSTRAP_PAGE) throw new Error("aggTrades: more rows than asked");
  const rows: AggTradeRow[] = [];
  for (const raw of body) {
    const row = parseAggTradeRow(raw);
    if (row === null) throw new Error("aggTrades: malformed row");
    rows.push(row);
  }
  rows.sort((a, b) => a.a - b.a);
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].a !== rows[i - 1].a + 1) throw new Error("aggTrades: page is not id-contiguous");
    if (rows[i].T < rows[i - 1].T) throw new Error("aggTrades: page is not in time order");
  }
  if (fromId !== null && rows.length > 0 && rows[0].a !== fromId) throw new Error("aggTrades: page does not start at fromId");
  return rows;
}

/** Merges a closed stretch into the list, joining stretches that overlap or touch (adjacent milliseconds); the ends keep the ids of whichever stretch reaches furthest. */
function addInterval(intervals: TapeInterval[], added: TapeInterval): void {
  if (!(added.to >= added.from)) return;
  let merged: TapeInterval = { ...added };
  const apart: TapeInterval[] = [];
  for (const interval of intervals) {
    if (interval.to + 1 < merged.from || interval.from > merged.to + 1) {
      apart.push(interval);
      continue;
    }
    const start = interval.from < merged.from || (interval.from === merged.from && merged.startTradeId === undefined) ? interval : merged;
    const end = interval.to > merged.to || (interval.to === merged.to && merged.endTradeId === undefined && merged.endAggId === undefined) ? interval : merged;
    merged = { from: start.from, to: end.to, startTradeId: start.startTradeId, endTradeId: end.endTradeId, endAggId: end.endAggId };
  }
  apart.push(merged);
  apart.sort((a, b) => a.from - b.from);
  intervals.splice(0, intervals.length, ...apart);
}

/** The stretches with the given milliseconds cut out (an unverified boundary millisecond splits the stretch around it). */
function subtractMilliseconds(intervals: TapeInterval[], milliseconds: readonly number[]): TapeInterval[] {
  let result = intervals;
  for (const ms of milliseconds) {
    const next: TapeInterval[] = [];
    for (const interval of result) {
      if (ms < interval.from || ms > interval.to) {
        next.push(interval);
        continue;
      }
      if (ms > interval.from) next.push({ from: interval.from, to: ms - 1, startTradeId: interval.startTradeId });
      if (ms < interval.to) next.push({ from: ms + 1, to: interval.to, endTradeId: interval.endTradeId, endAggId: interval.endAggId });
    }
    result = next;
  }
  return result;
}

/**
 * A bootstrap print as a trade frame. Aggregate trade ids are a separate
 * sequence from the stream's trade ids, so they carry an `a` prefix: the two
 * can never be mistaken for one another, and nothing is counted twice.
 */
function aggTradeFrame(selection: Selection, row: AggTradeRow): TradeFrame {
  return { type: "trade", ...selection, ts_exchange: row.T, price: row.p, size: row.q, side: row.m ? "sell" : "buy", trade_id: `a${row.a}` };
}

function markerOf(trade: TradeFrame): MarkerFrame {
  return { ...trade, type: "marker" };
}

function markerHistoryRow(marker: MarkerFrame): [number, number, number, "b" | "s", string] {
  return [marker.ts_exchange, marker.price, marker.size, marker.side === "buy" ? "b" : "s", marker.trade_id];
}

function tradeOrder(a: { ts_exchange: number; trade_id: string }, b: { ts_exchange: number; trade_id: string }): number {
  return a.ts_exchange - b.ts_exchange || (a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : 0);
}

/** The runtime's request validation (aggressive-history.js parseAggressiveHistoryRequest), minus the exact-key check the worker already applies. */
export function parseAggressiveHistoryRequest(msg: Record<string, unknown>, nowMs: number): AggressiveHistoryRequest | null {
  const { request_id: requestId, from_ts: fromMs, to_ts: toMs, min_size: minSize, cursor } = msg;
  if (!Number.isSafeInteger(requestId) || (requestId as number) < 0) return null;
  if (!Number.isSafeInteger(fromMs) || (fromMs as number) < 0) return null;
  if (!Number.isSafeInteger(toMs) || (toMs as number) <= (fromMs as number)) return null;
  if ((toMs as number) > nowMs + AGGRESSIVE_HISTORY_FUTURE_SKEW_MS) return null;
  if ((toMs as number) - (fromMs as number) > MAX_AGGRESSIVE_HISTORY_WINDOW_MS) return null;
  if (typeof minSize !== "number" || !Number.isFinite(minSize) || minSize < 0) return null;
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_HISTORY_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor))) return null;
  return { requestId: requestId as number, fromMs: fromMs as number, toMs: toMs as number, minSize, cursor: typeof cursor === "string" ? cursor : null };
}

function base64UrlEncode(text: string): string | null {
  try {
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

function base64UrlDecode(token: string): string | null {
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (token.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

/** A page cursor bound to its request (as the runtime's: version, instrument, window, floor, position), so a stale or foreign one is refused. */
export function encodeHistoryCursor(selection: Selection, request: AggressiveHistoryRequest, last: { ts_exchange: number; trade_id: string }): string | null {
  const scope = selection.provider === "BINANCE" ? selection.marketKind : selection.assetClass;
  const token = base64UrlEncode(JSON.stringify({
    v: HISTORY_CURSOR_VERSION, s: selection.symbol, k: scope, f: request.fromMs, t: request.toMs, m: request.minSize, x: last.ts_exchange, i: last.trade_id,
  }));
  return token !== null && token.length <= MAX_HISTORY_CURSOR_LENGTH ? token : null;
}

export function decodeHistoryCursor(token: string, selection: Selection, request: AggressiveHistoryRequest): { ts_exchange: number; trade_id: string } | null {
  const text = base64UrlDecode(token);
  if (text === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const scope = selection.provider === "BINANCE" ? selection.marketKind : selection.assetClass;
  if (
    decoded.v !== HISTORY_CURSOR_VERSION || decoded.s !== selection.symbol || decoded.k !== scope ||
    decoded.f !== request.fromMs || decoded.t !== request.toMs || decoded.m !== request.minSize ||
    !Number.isSafeInteger(decoded.x) || (decoded.x as number) < request.fromMs || (decoded.x as number) >= request.toMs ||
    typeof decoded.i !== "string" || decoded.i.length === 0
  ) {
    return null;
  }
  return { ts_exchange: decoded.x as number, trade_id: decoded.i };
}

function bookLevels(raw: unknown): Array<{ price: number; size: number }> | null {
  if (!Array.isArray(raw)) return null;
  const levels: Array<{ price: number; size: number }> = [];
  for (const level of raw) {
    if (!Array.isArray(level) || level.length < 2) return null;
    const price = finiteNumber(level[0]);
    const size = finiteNumber(level[1]);
    if (price === undefined || size === undefined || price <= 0 || size < 0) return null;
    if (size === 0) continue;
    levels.push({ price, size });
  }
  return levels;
}

export class BrowserBinanceTransport implements TransportSocket {
  readyState = CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: new (url: string) => UpstreamSocket;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly endpoints: BrowserBinanceEndpoints;
  private session: Session | null = null;
  private openTimer: unknown = null;
  /** The worker opted in to marker_history frames (its `capabilities` message), as the runtime remembers per client. */
  private markerHistoryOptIn = false;

  constructor(url: string, options: BrowserBinanceTransportOptions = {}) {
    this.url = url;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.WebSocketImpl = options.WebSocket ?? (WebSocket as unknown as new (url: string) => UpstreamSocket);
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(options.endpoints ?? {}) };
    // A WebSocket opens asynchronously; so does this, so the worker installs
    // its handlers before anything fires.
    this.openTimer = this.setTimer(() => {
      this.openTimer = null;
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.(new Event("open"));
      // The runtime pushes its current pair on connect; with no selection
      // from the worker we do the same with the catalog's first spot pair.
      if (this.session === null && this.readyState === OPEN) this.select(defaultSelection());
    }, 0);
  }

  /** Closed bars held back while a gap fill is pending (diagnostics and tests). */
  get heldClosedBarCount(): number {
    return this.session?.heldClosedBars.size ?? 0;
  }

  /** Sizes of the tape coverage bookkeeping (diagnostics and tests). */
  get tapeCoverage(): { observed: number; liveSpans: number; unfillable: number; unverified: number; staged: number } {
    const session = this.session;
    if (session === null) return { observed: 0, liveSpans: 0, unfillable: 0, unverified: 0, staged: 0 };
    return { observed: session.observed.length, liveSpans: session.liveSpans.length, unfillable: session.unfillable.length, unverified: session.unverified.length, staged: session.tape.staged.length };
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new DOMException("transport is not open", "InvalidStateError");
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(msg) || typeof msg.type !== "string") return;
    if (msg.type === "select") {
      const selection = parseSelectRequest(msg);
      if (selection !== null) this.select(selection);
      return;
    }
    if (msg.type === "capabilities") {
      // As the runtime: opting in gets the current marker set at once (nothing
      // when there is none yet; the bootstrap sends it when it completes).
      const optIn = msg.marker_history === true;
      const session = this.session;
      this.markerHistoryOptIn = optIn;
      if (optIn && session !== null) this.setTimer(() => this.deliverMarkerHistory(session), 0);
      return;
    }
    const reply = this.replyFor(msg);
    if (reply !== null) this.setTimer(() => this.deliver(reply), 0);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (this.openTimer !== null) {
      this.clearTimer(this.openTimer);
      this.openTimer = null;
    }
    this.endSession();
  }

  /** The contract's own "not available" answer for a request this transport cannot serve; null when the contract defines none. */
  private replyFor(msg: Record<string, unknown>): Record<string, unknown> | null {
    const session = this.session;
    if (session === null) return null;
    const identity = identityFields(session.selection);
    const echo = (keys: readonly string[]): Record<string, unknown> | null => {
      const fields: Record<string, unknown> = {};
      for (const key of keys) {
        if (msg[key] === undefined) return null;
        fields[key] = msg[key];
      }
      return fields;
    };
    switch (msg.type) {
      case "aggressive_history":
        return this.aggressiveHistoryReply(session, msg);
      case "delta_profile": {
        const fields = echo(["request_id", "from_ts", "to_ts", "row_width"]);
        if (fields === null) return null;
        return { type: "delta_profile", ...identity, ...fields, complete: false, reason: "STORAGE_UNAVAILABLE", retry_after_ms: null, pending: 0, rows: [] };
      }
      case "band_history": {
        const fields = echo(["request_id", "from_ts", "to_ts", "price_lo", "price_hi", "column_ms"]);
        if (fields === null) return null;
        return { type: "band_history", ...identity, ...fields, row_width: null, row_lo: null, row_hi: null, complete: false, reason: "GEOMETRY_UNAVAILABLE", retry_after_ms: null, columns: [] };
      }
      case "wall_history": {
        const fields = echo(["request_id", "from_ts", "to_ts", "price_lo", "price_hi"]);
        if (fields === null) return null;
        return { type: "wall_history", ...identity, ...fields, row_width: null, complete: false, reason: "HISTORY_UNAVAILABLE", retry_after_ms: null, walls: [], next: null };
      }
      case "l2_event_history": {
        const fields = echo(["request_id", "from_ts", "to_ts", "price_lo", "price_hi"]);
        if (fields === null) return null;
        return { type: "l2_event_history", ...identity, ...fields, row_width: null, complete: false, reason: "HISTORY_UNAVAILABLE", retry_after_ms: null, trades: [], wall_trades: [], trades_held_from: null, next: null };
      }
      case "profile_config":
      case "profile_history":
        return { type: "analytics_status", ...identity, indicator: "PROFILE", status: "UNAVAILABLE" };
      default:
        // capabilities, liquidity_resync, l2_resync, exhaustion_history,
        // initiative_history: the contract defines no reply shape, so the
        // indicators keep their own "no frame yet" state.
        return null;
    }
  }

  private deliver(frame: Record<string, unknown>): void {
    if (this.readyState !== OPEN) return;
    const data = JSON.stringify(frame);
    const event = typeof MessageEvent === "function"
      ? new MessageEvent("message", { data })
      : ({ data } as unknown as MessageEvent);
    this.onmessage?.(event);
  }

  private endSession(): void {
    const session = this.session;
    if (session === null) return;
    this.session = null;
    session.closed = true;
    session.abort?.abort();
    session.abort = null;
    if (session.timer !== null) {
      this.clearTimer(session.timer);
      session.timer = null;
    }
    session.tape.abort?.abort();
    session.tape.abort = null;
    if (session.tape.timer !== null) {
      this.clearTimer(session.tape.timer);
      session.tape.timer = null;
    }
    session.seam.abort?.abort();
    session.seam.abort = null;
    if (session.seam.timer !== null) {
      this.clearTimer(session.seam.timer);
      session.seam.timer = null;
    }
    if (session.tape.graceTimer !== null) {
      this.clearTimer(session.tape.graceTimer);
      session.tape.graceTimer = null;
    }
    this.closeStream(session);
    this.keepTapeState(session);
  }

  /** Keeps the pair's tape state for the next instance or the next selection of the pair; the oldest pair goes when too many are kept. */
  private keepTapeState(session: Session): void {
    if (session.selection.provider !== "BINANCE") return;
    const key = tapeStateKey(session.selection);
    tapeStates.delete(key);
    tapeStates.set(key, {
      markers: session.markers,
      pool: session.pool,
      observed: session.observed,
      liveSpans: session.liveSpans,
      unfillable: session.unfillable,
      unverified: session.unverified,
      calibrationFrom: session.calibrationFrom,
      recentTrades: session.recentTrades,
      done: session.tape.done,
    });
    while (tapeStates.size > MAX_TAPE_STATES) {
      const oldest = tapeStates.keys().next().value;
      if (oldest === undefined) break;
      tapeStates.delete(oldest);
    }
  }

  /**
   * The upstream stream was lost after delivering trades: the tick store on
   * the main thread has a live span open that must end where the trades
   * stopped. A lost runtime socket does exactly that through the worker's
   * close and reconnect, so this transport closes the same way; the pair's
   * tape state is kept for the instance the worker creates next, which
   * reconciles the hole from REST or leaves it outside every claim.
   */
  private lostUpstream(session: Session): void {
    if (!this.isCurrent(session)) return;
    console.warn("browserBinanceTransport: the stream was lost after delivering trades; closing so the worker reconnects");
    this.close();
    const event = typeof CloseEvent === "function"
      ? new CloseEvent("close", { code: 1006, reason: "upstream stream lost" })
      : ({ code: 1006, reason: "upstream stream lost" } as unknown as CloseEvent);
    this.onclose?.(event);
  }

  private closeStream(session: Session): void {
    if (session.connectTimer !== null) {
      this.clearTimer(session.connectTimer);
      session.connectTimer = null;
    }
    // The tape this stream delivered is observed up to its last live trade;
    // the prints between that and the next stream's first trade are a hole,
    // which a seam fill closes from REST or which stays open.
    const live = session.live;
    if (live !== null) {
      session.liveSpans.push({ from: live.from, to: live.last, firstId: live.firstId, lastId: live.lastId });
      addInterval(session.observed, { from: live.from, to: live.last, startTradeId: live.firstId, endTradeId: live.lastId });
      session.live = null;
    }
    const stream = session.stream;
    session.stream = null;
    if (stream === null) return;
    stream.onopen = null;
    stream.onmessage = null;
    stream.onclose = null;
    stream.onerror = null;
    try {
      stream.close();
    } catch {
      void 0;
    }
  }

  private isCurrent(session: Session): boolean {
    return this.readyState === OPEN && this.session === session && !session.closed;
  }

  private select(selection: Selection): void {
    this.endSession();
    const perpetual = selection.provider === "BINANCE" && selection.marketKind === "PERPETUAL";
    const session: Session = {
      selection,
      binanceSymbol: selection.symbol.replace("-", ""),
      restBase: perpetual ? this.endpoints.perpetualRestBase : this.endpoints.spotRestBase,
      streamBase: perpetual ? this.endpoints.perpetualStreamBase : this.endpoints.spotStreamBase,
      stream: null,
      connectTimer: null,
      streamGeneration: 0,
      degraded: false,
      recovering: false,
      heldClosedBars: new Map(),
      heldFormingBar: null,
      bookLive: false,
      fillInFlight: false,
      awaitingBoundary: null,
      holeRetries: 0,
      streamFailures: 0,
      backoffMs: STREAM_BACKOFF_INITIAL_MS,
      lastClosedOpen: -1,
      abort: null,
      timer: null,
      closed: false,
      closedBars: new Map(),
      lastFormingBar: null,
      recentTrades: [],
      markers: createTimeCoveredMarkerRetentionBuffer(MAX_RETAINED_MARKERS, MARKER_BUCKET_MS, MARKERS_PER_BUCKET_SIDE),
      pool: createAggressivePool<TradeFrame>({ now: this.now }),
      observed: [],
      liveSpans: [],
      live: null,
      unfillable: [],
      unverified: [],
      calibrationFrom: this.now() - DEFAULT_CALIBRATION_MS,
      tape: { started: false, inFlight: false, done: false, attempts: 0, unavailable: false, backoffMs: STREAM_BACKOFF_INITIAL_MS, abort: null, timer: null, staged: [], graceTimer: null, startVerified: false },
      seam: { inFlight: false, gap: null, failures: 0, backoffMs: STREAM_BACKOFF_INITIAL_MS, abort: null, timer: null, publishWhenSettled: false },
      markerHistorySeq: 0,
    };
    const kept = selection.provider === "BINANCE" ? tapeStates.get(tapeStateKey(selection)) : undefined;
    if (kept !== undefined) {
      // The pair was streamed before (by this instance or the one before it):
      // its markers, pool and coverage carry on; a bootstrap that had not
      // finished starts over, its pages deduplicated by id.
      session.markers = kept.markers;
      session.pool = kept.pool;
      session.observed = kept.observed;
      session.liveSpans = kept.liveSpans;
      session.unfillable = kept.unfillable;
      session.unverified = kept.unverified;
      session.recentTrades = kept.recentTrades;
      if (kept.done) {
        session.calibrationFrom = kept.calibrationFrom;
        session.tape.started = true;
        session.tape.done = true;
      }
    }
    this.session = session;
    this.deliver({ type: "selection", ...identityFields(selection) });
    if (selection.provider !== "BINANCE") {
      this.deliver({ type: "snapshot", ...identityFields(selection), bars: [], trades: [], markers: [] });
      this.deliverHealth(session, "UNAVAILABLE", HEALTH_REASON_NO_DXFEED);
      return;
    }
    void this.bootstrap(session);
  }

  private deliverHealth(session: Session, recoveryState: "READY" | "RECOVERING" | "UNAVAILABLE", reason: string): void {
    this.deliver({
      type: "health",
      ...identityFields(session.selection),
      recoveryState,
      stale: recoveryState !== "READY",
      reason,
    });
  }

  private klinesUrl(session: Session, query: Record<string, string | number>): string {
    const path = session.selection.provider === "BINANCE" && session.selection.marketKind === "PERPETUAL" ? "/fapi/v1/klines" : "/api/v3/klines";
    const params = new URLSearchParams({ symbol: session.binanceSymbol, interval: "1m" });
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    return `${session.restBase}${path}?${params.toString()}`;
  }

  private async fetchKlines(session: Session, query: Record<string, string | number>): Promise<KlineRow[]> {
    const controller = new AbortController();
    session.abort = controller;
    const timer = this.setTimer(() => controller.abort(), REST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.klinesUrl(session, query), { signal: controller.signal });
      if (!response.ok) throw new Error(`klines: HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error("klines: body is not an array");
      const rows: KlineRow[] = [];
      for (const raw of body) {
        const row = parseKlineRow(raw);
        if (row !== null) rows.push(row);
      }
      rows.sort((a, b) => a.openTime - b.openTime);
      return rows;
    } finally {
      this.clearTimer(timer);
      if (session.abort === controller) session.abort = null;
    }
  }

  private scheduleRetry(session: Session, action: () => void): void {
    if (!this.isCurrent(session)) return;
    if (session.timer !== null) this.clearTimer(session.timer);
    const delay = session.backoffMs;
    session.backoffMs = Math.min(session.backoffMs * 2, STREAM_BACKOFF_CAP_MS);
    session.timer = this.setTimer(() => {
      session.timer = null;
      if (this.isCurrent(session)) action();
    }, delay);
  }

  private scheduleRetryAt(session: Session, delayMs: number, action: () => void): void {
    if (!this.isCurrent(session)) return;
    if (session.timer !== null) this.clearTimer(session.timer);
    session.timer = this.setTimer(() => {
      session.timer = null;
      if (this.isCurrent(session)) action();
    }, delayMs);
  }

  private restFailureReason(session: Session): string {
    return session.selection.provider === "BINANCE" && session.selection.marketKind === "PERPETUAL"
      ? HEALTH_REASON_PERPETUAL_UNREACHABLE
      : HEALTH_REASON_REST_FAILED;
  }

  private async bootstrap(session: Session): Promise<void> {
    let rows: KlineRow[];
    const confirmedBefore = this.now() - CLOSE_CONFIRMATION_MARGIN_MS;
    try {
      rows = await this.fetchKlines(session, { limit: SNAPSHOT_BARS + 1 });
    } catch (error) {
      if (!this.isCurrent(session)) return;
      console.warn("browserBinanceTransport: kline history request failed", error);
      this.deliverHealth(session, "UNAVAILABLE", this.restFailureReason(session));
      this.scheduleRetry(session, () => void this.bootstrap(session));
      return;
    }
    if (!this.isCurrent(session)) return;
    const now = this.now();
    // Only minutes that had closed before the request went out are final; the
    // minute at the edge may have been served partial and is shown forming
    // until the stream's reconcile confirms it.
    const closedRows = rows.filter((row) => row.closeTime < confirmedBefore).slice(-SNAPSHOT_BARS);
    const forming = rows.find((row) => row.closeTime >= confirmedBefore && row.openTime <= now);
    const identity = identityFields(session.selection);
    session.lastClosedOpen = closedRows.length > 0 ? closedRows[closedRows.length - 1].openTime : -1;
    session.closedBars = new Map(closedRows.map((row) => [row.openTime, { ...row, reconstructed: true }]));
    // The connect snapshot: the closed bars, and the pair's markers, recent
    // trades and pool when its tape state was kept from an earlier instance
    // (as the runtime's connect snapshot carries what its buffers hold).
    this.deliver(this.snapshotFrame(session));
    session.lastFormingBar = null;
    session.heldClosedBars.clear();
    session.heldFormingBar = null;
    session.recovering = false;
    session.fillInFlight = false;
    session.awaitingBoundary = null;
    session.holeRetries = 0;
    session.degraded = false;
    session.bookLive = false;
    this.deliverHealth(session, "READY", this.readyReason(session));
    this.deliver({ type: "book", ...identity, status: "UNAVAILABLE", reason: BOOK_REASON_STREAM_CONNECTING });
    if (forming !== undefined) this.deliverFormingBar(session, forming);
    // A kept tape state has its markers already: a client that opted in gets them now, as on the runtime's connect.
    if (session.tape.done) this.deliverMarkerHistory(session);
    session.backoffMs = STREAM_BACKOFF_INITIAL_MS;
    this.openStream(session);
    this.startTapeBootstrap(session);
  }

  /** The READY reason: plain, or saying that the tape bootstrap failed and markers start at connect. */
  private readyReason(session: Session): string {
    return session.tape.unavailable ? HEALTH_REASON_NO_TAPE_HISTORY : HEALTH_REASON_READY;
  }

  private deliverFormingBar(session: Session, bar: KlineRow): void {
    session.lastFormingBar = bar;
    this.deliver(barFrame(session.selection, bar, false, false));
  }

  private streamUrl(session: Session): string {
    const symbol = session.binanceSymbol.toLowerCase();
    return `${session.streamBase}/stream?streams=${symbol}@kline_1m/${symbol}@trade/${symbol}@depth20@100ms`;
  }

  private openStream(session: Session): void {
    if (!this.isCurrent(session)) return;
    let stream: UpstreamSocket;
    try {
      stream = new this.WebSocketImpl(this.streamUrl(session));
    } catch (error) {
      console.warn("browserBinanceTransport: could not construct the stream socket", error);
      this.streamLost(session);
      return;
    }
    session.stream = stream;
    session.streamGeneration += 1;
    const generation = session.streamGeneration;
    session.connectTimer = this.setTimer(() => {
      session.connectTimer = null;
      if (!this.isCurrent(session) || session.stream !== stream) return;
      console.warn("browserBinanceTransport: the stream did not open in time");
      this.closeStream(session);
      this.streamLost(session);
    }, STREAM_CONNECT_TIMEOUT_MS);
    stream.onopen = () => {
      if (!this.isCurrent(session) || session.stream !== stream) return;
      if (session.connectTimer !== null) {
        this.clearTimer(session.connectTimer);
        session.connectTimer = null;
      }
      session.streamFailures = 0;
      session.backoffMs = STREAM_BACKOFF_INITIAL_MS;
      // Every open reconciles from the last confirmed close: the first one
      // too, since the minute the snapshot left forming may have closed while
      // the socket was connecting, and the stream only reports the minute now.
      session.recovering = true;
      void this.recoverAfterGap(session, generation);
    };
    stream.onmessage = (event: MessageEvent) => {
      if (!this.isCurrent(session) || session.stream !== stream) return;
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      this.routeStreamMessage(session, parsed);
    };
    stream.onclose = () => {
      if (!this.isCurrent(session) || session.stream !== stream) return;
      const deliveredTrades = session.live !== null;
      this.closeStream(session);
      // A gap fill in flight belongs to the stream that just died: abandon it.
      session.abort?.abort();
      session.awaitingBoundary = null;
      if (deliveredTrades) {
        this.lostUpstream(session);
        return;
      }
      this.streamLost(session);
    };
    stream.onerror = () => {
      // The browser follows every error with a close event; that path reports it.
    };
  }

  private streamLost(session: Session): void {
    if (!this.isCurrent(session)) return;
    if (session.timer !== null) {
      this.clearTimer(session.timer);
      session.timer = null;
    }
    session.streamFailures += 1;
    session.degraded = true;
    if (session.bookLive) {
      // The last READY book is the dead stream's; consumers read the book's own status.
      session.bookLive = false;
      this.deliver({ type: "book", ...identityFields(session.selection), status: "UNAVAILABLE", reason: HEALTH_REASON_STREAM_CLOSED });
    }
    if (session.selection.provider === "BINANCE" && session.selection.marketKind === "PERPETUAL") {
      // No mirror exists for the futures stream: say so at once, then keep trying.
      this.deliverHealth(session, "UNAVAILABLE", HEALTH_REASON_PERPETUAL_UNREACHABLE);
    } else if (session.streamFailures >= STREAM_FAILURES_BEFORE_UNAVAILABLE) {
      this.deliverHealth(session, "UNAVAILABLE", HEALTH_REASON_STREAM_UNAVAILABLE);
    } else {
      this.deliverHealth(session, "RECOVERING", HEALTH_REASON_STREAM_CLOSED);
    }
    this.scheduleRetry(session, () => this.openStream(session));
  }

  private recoveryIsLive(session: Session, generation: number): boolean {
    return this.isCurrent(session) && session.streamGeneration === generation && session.stream !== null && session.recovering;
  }

  private earliestHeldClose(session: Session): number | undefined {
    let earliest: number | undefined;
    for (const openTime of session.heldClosedBars.keys()) {
      if (earliest === undefined || openTime < earliest) earliest = openTime;
    }
    return earliest;
  }

  /**
   * Whenever a stream opens: the closed bars between the last confirmed close
   * and the live stream come from REST, marked reconstructed as the runtime
   * marks its backfill. Pages of 1,000 minutes are walked from that boundary;
   * every row must be the next consecutive minute, and a row counts as final
   * only when its minute closed before the request went out (a margin covers
   * clock skew), or when the stream itself closed that minute meanwhile (its
   * close wins). Closes the new stream reports during the fill wait in the
   * buffer so the main thread sees closed bars in order and never a hole. The
   * fill ends at the minute now forming, or at a minute that closed on the
   * clock but is not yet confirmable, which the stream's own close or a later
   * re-read settles. A missing, short or failed page keeps the feed RECOVERING
   * and is retried from the first missing minute; a gap longer than the pages
   * allowed, or a minute the exchange keeps omitting, is re-read as a fresh
   * snapshot instead. READY follows only a continuous fill for the stream
   * that is still open.
   */
  private async recoverAfterGap(session: Session, generation: number): Promise<void> {
    session.awaitingBoundary = null;
    try {
      for (let page = 1; ; page += 1) {
        if (page > MAX_GAP_FILL_PAGES || (session.lastClosedOpen >= 0 && this.now() - session.lastClosedOpen > MAX_GAP_FILL_MS)) {
          this.restartFromSnapshot(session);
          return;
        }
        const paged = session.lastClosedOpen >= 0;
        const confirmedBefore = this.now() - CLOSE_CONFIRMATION_MARGIN_MS;
        session.fillInFlight = true;
        let rows: KlineRow[];
        try {
          rows = await this.fetchKlines(session, paged ? { startTime: session.lastClosedOpen + BAR_INTERVAL_MS, limit: GAP_FILL_PAGE } : { limit: SNAPSHOT_BARS + 1 });
        } finally {
          session.fillInFlight = false;
        }
        if (!this.recoveryIsLive(session, generation)) return;
        const now = this.now();
        let expected = paged ? session.lastClosedOpen + BAR_INTERVAL_MS : rows.length > 0 ? rows[0].openTime : -1;
        let outcome: "continuous" | "hole" | "forming" | "boundary" = "continuous";
        for (const row of rows) {
          if (row.openTime < expected) continue;
          if (row.openTime > expected) {
            outcome = "hole";
            break;
          }
          const held = session.heldClosedBars.get(row.openTime);
          if (held !== undefined) {
            // The stream closed this minute itself: its close is authoritative.
            this.deliverClosedBar(session, held, false);
          } else if (row.closeTime < confirmedBefore) {
            this.deliverClosedBar(session, row, true);
          } else {
            outcome = row.closeTime < now ? "boundary" : "forming";
            break;
          }
          expected = row.openTime + BAR_INTERVAL_MS;
        }
        if (outcome === "hole") {
          session.holeRetries += 1;
          if (session.holeRetries > MAX_HOLE_RETRIES) {
            // The exchange keeps omitting this minute: a real gap, carried as a gap.
            this.restartFromSnapshot(session);
            return;
          }
          throw new Error(`gap fill: the exchange skipped the minute at ${expected}`);
        }
        session.holeRetries = 0;
        if (outcome === "boundary") {
          // The minute just closed on the clock but the row may be partial.
          // The stream's own close for it ends the recovery as soon as it
          // arrives; failing that, it is re-read once it is confirmable.
          session.awaitingBoundary = expected;
          const retryAt = expected + BAR_INTERVAL_MS + CLOSE_CONFIRMATION_MARGIN_MS;
          this.scheduleRetryAt(session, Math.max(retryAt - now, STREAM_BACKOFF_INITIAL_MS), () => {
            if (this.recoveryIsLive(session, generation)) void this.recoverAfterGap(session, generation);
          });
          return;
        }
        if (outcome === "forming") break;
        if (paged && rows.length >= GAP_FILL_PAGE) continue;
        const earliestHeld = this.earliestHeldClose(session);
        if (!paged || earliestHeld === expected) break;
        throw new Error("gap fill: the exchange returned fewer rows than the gap spans");
      }
    } catch (error) {
      if (!this.recoveryIsLive(session, generation)) return;
      console.warn("browserBinanceTransport: kline gap fill failed", error);
      session.degraded = true;
      this.deliverHealth(session, "RECOVERING", HEALTH_REASON_REST_FAILED);
      this.scheduleRetry(session, () => {
        if (this.recoveryIsLive(session, generation)) void this.recoverAfterGap(session, generation);
      });
      return;
    }
    if (!this.finishRecovery(session)) {
      // Held closes are not consecutive with the boundary: the minutes between
      // are read next, from the first missing one.
      session.degraded = true;
      this.deliverHealth(session, "RECOVERING", HEALTH_REASON_REST_FAILED);
      this.scheduleRetry(session, () => {
        if (this.recoveryIsLive(session, generation)) void this.recoverAfterGap(session, generation);
      });
    }
  }

  /** Releases held closes while each is the next minute, then the latest held forming bar; true when the recovery is complete. */
  private finishRecovery(session: Session): boolean {
    for (const row of [...session.heldClosedBars.values()].sort((a, b) => a.openTime - b.openTime)) {
      if (row.openTime <= session.lastClosedOpen) {
        session.heldClosedBars.delete(row.openTime);
        continue;
      }
      if (row.openTime !== session.lastClosedOpen + BAR_INTERVAL_MS) return false;
      this.deliverClosedBar(session, row, false);
      session.heldClosedBars.delete(row.openTime);
    }
    const forming = session.heldFormingBar;
    session.heldFormingBar = null;
    if (forming !== null && forming.openTime > session.lastClosedOpen) this.deliverFormingBar(session, forming);
    session.recovering = false;
    session.awaitingBoundary = null;
    session.backoffMs = STREAM_BACKOFF_INITIAL_MS;
    if (session.degraded) {
      session.degraded = false;
      this.deliverHealth(session, "READY", this.readyReason(session));
    }
    return true;
  }

  /** A gap too long to page through: close the stream and read the history afresh, as a new selection would. */
  private restartFromSnapshot(session: Session): void {
    console.warn("browserBinanceTransport: the gap exceeds what a fill can page through; re-reading the history");
    this.closeStream(session);
    session.recovering = false;
    session.awaitingBoundary = null;
    session.holeRetries = 0;
    session.heldClosedBars.clear();
    session.heldFormingBar = null;
    void this.bootstrap(session);
  }

  private deliverClosedBar(session: Session, bar: KlineRow, reconstructed: boolean): void {
    this.deliver(barFrame(session.selection, bar, true, reconstructed));
    session.lastClosedOpen = bar.openTime;
    session.closedBars.set(bar.openTime, { ...bar, reconstructed });
    while (session.closedBars.size > MAX_SNAPSHOT_CLOSED_BARS) {
      let oldest: number | undefined;
      for (const openTime of session.closedBars.keys()) if (oldest === undefined || openTime < oldest) oldest = openTime;
      if (oldest === undefined) break;
      session.closedBars.delete(oldest);
    }
  }

  private routeStreamMessage(session: Session, parsed: unknown): void {
    if (!isRecord(parsed)) return;
    const payload = isRecord(parsed.data) && typeof parsed.stream === "string" ? parsed.data : parsed;
    if (payload.e === "kline") {
      const bar = parseKlineEvent(payload.k);
      if (bar === null) return;
      if (bar.closed && bar.openTime <= session.lastClosedOpen) return;
      if (session.recovering) {
        if (bar.closed && !session.fillInFlight && session.awaitingBoundary === bar.openTime && bar.openTime === session.lastClosedOpen + BAR_INTERVAL_MS) {
          // The minute the fill could not yet confirm: the stream's close is final.
          if (session.timer !== null) {
            this.clearTimer(session.timer);
            session.timer = null;
          }
          this.deliverClosedBar(session, bar, false);
          if (!this.finishRecovery(session)) {
            session.degraded = true;
            this.deliverHealth(session, "RECOVERING", HEALTH_REASON_REST_FAILED);
            this.scheduleRetry(session, () => {
              if (this.recoveryIsLive(session, session.streamGeneration)) void this.recoverAfterGap(session, session.streamGeneration);
            });
          }
          return;
        }
        if (bar.closed) {
          session.heldClosedBars.set(bar.openTime, bar);
          // Bounded: a dropped old close is still a closed minute on the
          // exchange, and the paginated REST read walks up to the earliest
          // retained one, so nothing is lost.
          if (session.heldClosedBars.size > MAX_HELD_CLOSED_BARS) {
            const earliest = this.earliestHeldClose(session);
            if (earliest !== undefined) session.heldClosedBars.delete(earliest);
          }
        } else session.heldFormingBar = bar;
        return;
      }
      if (bar.closed) this.deliverClosedBar(session, bar, false);
      else this.deliverFormingBar(session, bar);
      return;
    }
    if (payload.e === "trade") {
      const price = finiteNumber(payload.p);
      const size = finiteNumber(payload.q);
      if (price === undefined || size === undefined || price <= 0 || size <= 0) return;
      if (!Number.isSafeInteger(payload.T) || !Number.isSafeInteger(payload.t) || typeof payload.m !== "boolean") return;
      const trade: TradeFrame = {
        type: "trade",
        ...session.selection,
        ts_exchange: payload.T as number,
        price,
        size,
        side: payload.m ? "sell" : "buy",
        trade_id: String(payload.t),
      };
      const opensSpan = session.live === null;
      if (session.live === null) session.live = { from: trade.ts_exchange, to: Infinity, last: trade.ts_exchange, firstId: payload.t as number, lastId: payload.t as number };
      else {
        session.live.last = Math.max(session.live.last, trade.ts_exchange);
        session.live.lastId = Math.max(session.live.lastId, payload.t as number);
      }
      session.recentTrades.push(trade);
      if (session.recentTrades.length > SNAPSHOT_RECENT_TRADES) session.recentTrades.shift();
      this.deliver(trade);
      // As the runtime's handleEnvelope: the pool records every new trade, and
      // a print the retention admits goes out as a marker right behind it.
      session.pool.record(trade);
      this.offerMarker(session, trade, true);
      // A new stream span: staged pages can be reconciled against it, and
      // the hole before it is filled from REST or left open.
      if (opensSpan) {
        this.commitStagedWhenSafe(session);
        this.fillNextSeam(session);
      }
      return;
    }
    const isSpotPartial = Array.isArray(payload.bids) && Array.isArray(payload.asks) && Number.isSafeInteger(payload.lastUpdateId);
    const isFuturesPartial = payload.e === "depthUpdate" && Array.isArray(payload.b) && Array.isArray(payload.a) && Number.isSafeInteger(payload.u);
    if (!isSpotPartial && !isFuturesPartial) return;
    const bids = bookLevels(isSpotPartial ? payload.bids : payload.b);
    const asks = bookLevels(isSpotPartial ? payload.asks : payload.a);
    if (bids === null || asks === null) return;
    if (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price) return;
    session.bookLive = true;
    this.deliver({
      type: "book",
      ...identityFields(session.selection),
      status: "READY",
      bids: bids.slice(0, 20),
      asks: asks.slice(0, 20),
      lastUpdateId: (isSpotPartial ? payload.lastUpdateId : payload.u) as number,
      stale: false,
    });
  }

  // ---- Tape-derived frames: markers, the aggressive pool, their history ----

  /** Offers a print to the runtime's large-trade retention; an admitted one is broadcast as a `marker` when asked. */
  private offerMarker(session: Session, trade: TradeFrame, broadcast: boolean): void {
    const marker = markerOf(trade);
    if (session.markers.insertAll([marker]) && broadcast) this.deliver(marker);
  }

  /** The newest markers the runtime would still hold: within its seven-day window, oldest first, the newest 5,000 for a snapshot. */
  private retainedMarkers(session: Session): MarkerFrame[] {
    const oldestKept = this.now() - MARKER_HISTORY_WINDOW_MS;
    return session.markers.snapshot().filter((marker) => marker.ts_exchange >= oldestKept);
  }

  /**
   * Forgets coverage older than the pool's retention (nothing older can be
   * claimed: the pool has no print for it) and bounds every list, so
   * reconnects over a long session cannot grow them without end. The gap a
   * seam fill is working on, and the stretches beside it, are kept.
   */
  private pruneCoverage(session: Session): void {
    const cutoff = this.now() - POOL_WINDOW_MS;
    const active = session.seam.gap;
    const keepsActive = (interval: TapeInterval): boolean =>
      active !== null && (interval.to === active.from || interval.from === active.to || (interval.from === active.from && interval.to === active.to));
    const clip = (interval: TapeInterval): TapeInterval =>
      interval.from >= cutoff ? interval : { from: cutoff, to: interval.to, endTradeId: interval.endTradeId, endAggId: interval.endAggId };
    session.observed = session.observed.filter((interval) => interval.to >= cutoff || keepsActive(interval)).map(clip);
    session.liveSpans = session.liveSpans.filter((span) => span.to >= cutoff);
    session.unfillable = session.unfillable.filter((gap) => gap.to >= cutoff || keepsActive(gap));
    session.unverified = session.unverified.filter((ms) => ms >= cutoff);
    if (session.observed.length > MAX_COVERAGE_ENTRIES) session.observed.splice(0, session.observed.length - MAX_COVERAGE_ENTRIES);
    if (session.liveSpans.length > MAX_COVERAGE_ENTRIES) session.liveSpans.splice(0, session.liveSpans.length - MAX_COVERAGE_ENTRIES);
    if (session.unfillable.length > MAX_COVERAGE_ENTRIES) session.unfillable.splice(0, session.unfillable.length - MAX_COVERAGE_ENTRIES);
    if (session.unverified.length > MAX_UNVERIFIED_MS) session.unverified.splice(0, session.unverified.length - MAX_UNVERIFIED_MS);
  }

  /**
   * Every stretch of tape observed in full: the closed ones, plus the open
   * stream span up to its last trade (a trade in flight may still arrive, so
   * the observed tape ends at the last print seen, never in the future),
   * merged where they touch, with every unverified boundary millisecond cut
   * out.
   */
  private coverageIntervals(session: Session): TapeInterval[] {
    this.pruneCoverage(session);
    const intervals = session.observed.map((interval) => ({ ...interval }));
    if (session.live !== null) addInterval(intervals, { from: session.live.from, to: session.live.last, startTradeId: session.live.firstId, endTradeId: session.live.lastId });
    return subtractMilliseconds(intervals, session.unverified);
  }

  /** Where the stretch of complete tape that reaches the stream's last trade begins, or null while no stream delivers. */
  private coverageNowFrom(session: Session): number | null {
    const live = session.live;
    if (live === null) return null;
    const open = this.coverageIntervals(session).find((interval) => interval.from <= live.last && interval.to >= live.last);
    return open === undefined ? null : open.from;
  }

  /**
   * What the snapshot may claim: the pool's prints, its floor, and coverage
   * from the start of the continuous observed stretch that reaches now (never
   * before the pool's own window), or from now itself, an empty claim, while
   * no stream delivers or a hole separates the stream from what was read.
   */
  private poolCoverage(session: Session): { prints: readonly TradeFrame[]; floor: number; from: number } {
    const snapshot = session.pool.snapshot();
    const nowMs = this.now();
    const from = this.coverageNowFrom(session);
    return { prints: snapshot.prints, floor: snapshot.floor, from: from === null ? nowMs : Math.min(nowMs, Math.max(snapshot.from, from)) };
  }

  /** The runtime's snapshot for the pair as this transport knows it: every closed bar, the last 100 live trades, the newest markers, the print pool. */
  private snapshotFrame(session: Session): Record<string, unknown> {
    const bars = [...session.closedBars.values()].sort((a, b) => a.openTime - b.openTime);
    const markers = this.retainedMarkers(session);
    const pool = this.poolCoverage(session);
    return {
      type: "snapshot",
      ...identityFields(session.selection),
      bars: bars.map((row) => barFrame(session.selection, row, true, row.reconstructed)),
      trades: [...session.recentTrades],
      markers: markers.slice(-MAX_SNAPSHOT_MARKERS),
      vpin_status: "DISABLED",
      ...(session.tape.done || session.observed.length > 0 || session.live !== null
        ? { aggressive_prints: [...pool.prints], aggressive_prints_floor: pool.floor, aggressive_prints_from: pool.from }
        : {}),
    };
  }

  /** The full marker set as marker_history frames, 5,000 rows each, `reset` on the first, as the runtime's markerHistoryFrames. */
  private deliverMarkerHistory(session: Session): void {
    if (!this.isCurrent(session) || !this.markerHistoryOptIn) return;
    const markers = this.retainedMarkers(session);
    if (markers.length === 0) return;
    session.markerHistorySeq = 0;
    for (let start = 0; start < markers.length; start += MAX_MARKER_HISTORY_ROWS) {
      this.deliver({
        type: "marker_history",
        ...identityFields(session.selection),
        reset: start === 0,
        seq: session.markerHistorySeq,
        rows: markers.slice(start, start + MAX_MARKER_HISTORY_ROWS).map(markerHistoryRow),
      });
      session.markerHistorySeq += 1;
    }
  }

  /** After the bootstrap or a seam fill: the snapshot again (as the runtime re-broadcasts it after a warm-up chunk), the forming bar, and the marker history for a client that opted in. */
  private publishTapeState(session: Session): void {
    if (!this.isCurrent(session)) return;
    session.seam.publishWhenSettled = false;
    this.deliver(this.snapshotFrame(session));
    const forming = session.lastFormingBar;
    if (!session.recovering && forming !== null && forming.openTime > session.lastClosedOpen) this.deliver(barFrame(session.selection, forming, false, false));
    this.deliverMarkerHistory(session);
  }

  /**
   * The runtime answers from storage; this answers from the pool, and only
   * claims completeness for a window that lies inside one observed stretch
   * of tape (the bootstrap, a seam fill, a stream span), within the pool's
   * window, at or above the pool's floor. Anything else, a hole between the
   * REST pages and the stream or between two streams included, is honestly
   * STORAGE_UNAVAILABLE, which the client retries three times and then rests.
   * Pages of 10,000 with a cursor bound to the request, as the contract has it.
   */
  private aggressiveHistoryReply(session: Session, msg: Record<string, unknown>): Record<string, unknown> | null {
    const request = parseAggressiveHistoryRequest(msg, this.now());
    if (request === null) return null;
    const after = request.cursor === null ? null : decodeHistoryCursor(request.cursor, session.selection, request);
    if (request.cursor !== null && after === null) {
      console.warn("browserBinanceTransport: dropped aggressive_history request: cursor does not match the selected history window");
      return null;
    }
    const reply = {
      type: "aggressive_history",
      ...identityFields(session.selection),
      request_id: request.requestId,
      from_ts: request.fromMs,
      to_ts: request.toMs,
      min_size: request.minSize,
      retry_after_ms: null,
    };
    const pool = session.pool.snapshot();
    const inside = this.coverageIntervals(session).some((interval) => interval.from <= request.fromMs && interval.to >= request.toMs - 1);
    const covered = inside && request.fromMs >= pool.from && request.minSize >= pool.floor;
    if (!covered) return { ...reply, complete: false, reason: "STORAGE_UNAVAILABLE", next_cursor: null, trades: [] };
    const matching = pool.prints
      .filter((print) =>
        print.ts_exchange >= request.fromMs && print.ts_exchange < request.toMs && print.size >= request.minSize &&
        (after === null || tradeOrder(print, after) > 0))
      .sort(tradeOrder);
    const capped = matching.length > MAX_AGGRESSIVE_HISTORY_TRADES;
    const page = capped ? matching.slice(0, MAX_AGGRESSIVE_HISTORY_TRADES) : matching;
    const nextCursor = capped ? encodeHistoryCursor(session.selection, request, page[page.length - 1]) : null;
    if (capped && nextCursor === null) return { ...reply, complete: false, reason: "CONVERSION_INCOMPLETE", next_cursor: null, trades: page };
    return { ...reply, complete: !capped, reason: capped ? "CAP_REACHED" : null, next_cursor: nextCursor, trades: page };
  }

  private aggTradesUrl(session: Session, query: { fromId?: number; startTime?: number }): string {
    const path = session.selection.provider === "BINANCE" && session.selection.marketKind === "PERPETUAL" ? "/fapi/v1/aggTrades" : "/api/v3/aggTrades";
    const params = new URLSearchParams({ symbol: session.binanceSymbol, limit: String(TAPE_BOOTSTRAP_PAGE) });
    if (query.fromId !== undefined) params.set("fromId", String(query.fromId));
    if (query.startTime !== undefined) params.set("startTime", String(query.startTime));
    return `${session.restBase}${path}?${params.toString()}`;
  }

  /** One validated page of aggregate trades, oldest first: the newest page, the page from `fromId`, or the page from `startTime` on. */
  private async fetchAggTrades(session: Session, query: { fromId?: number; startTime?: number }, owner: { abort: AbortController | null }): Promise<AggTradeRow[]> {
    const controller = new AbortController();
    owner.abort = controller;
    const timer = this.setTimer(() => controller.abort(), REST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(this.aggTradesUrl(session, query), { signal: controller.signal });
      if (!response.ok) throw new Error(`aggTrades: HTTP ${response.status}`);
      return parseAggTradesPage(await response.json(), query.fromId ?? null);
    } finally {
      this.clearTimer(timer);
      if (owner.abort === controller) owner.abort = null;
    }
  }

  private startTapeBootstrap(session: Session): void {
    if (session.tape.started) return;
    session.tape.started = true;
    void this.bootstrapTape(session);
  }

  /**
   * The runtime seeds markers and the pool from storage; the browser reads
   * recent aggregate trades from the mirror, newest page first by id, within a
   * bounded page budget. The pages are staged, not seeded, until the stream's
   * first trade is known (or no stream can deliver one that overlaps them):
   * every row is then reconciled against the live tape by trade id before it
   * is fed through the same retention and pool. The pages read are one
   * id-contiguous stretch, recorded as observed; a page that fails validation
   * or transport after others succeeded ends the walk with what was read; a
   * first page that fails is retried with backoff, and after three such
   * failures the READY health frame says the tape history is missing.
   */
  private async bootstrapTape(session: Session): Promise<void> {
    const tape = session.tape;
    tape.inFlight = true;
    const oldestWanted = this.now() - MARKER_HISTORY_WINDOW_MS;
    let fromId: number | null = null;
    let pages = 0;
    try {
      while (pages < MAX_TAPE_BOOTSTRAP_PAGES) {
        let rows: AggTradeRow[];
        try {
          rows = await this.fetchAggTrades(session, fromId === null ? {} : { fromId }, tape);
        } catch (error) {
          if (!this.isCurrent(session)) return;
          if (pages === 0) throw error;
          console.warn("browserBinanceTransport: a trade history page failed; keeping what was read", error);
          break;
        }
        if (!this.isCurrent(session)) return;
        pages += 1;
        if (rows.length < TAPE_BOOTSTRAP_PAGE || (rows.length > 0 && rows[0].a === 0)) {
          // A short or empty page: nothing older exists on the exchange (ids
          // are consecutive), so the oldest row's millisecond is whole.
          tape.startVerified = true;
        }
        if (rows.length === 0) break;
        tape.staged.push(rows);
        const oldest = rows[0];
        if (tape.startVerified) break;
        if (oldest.T < oldestWanted) break;
        fromId = Math.max(0, oldest.a - TAPE_BOOTSTRAP_PAGE);
      }
    } catch (error) {
      if (!this.isCurrent(session)) return;
      tape.inFlight = false;
      tape.attempts += 1;
      console.warn("browserBinanceTransport: trade history request failed", error);
      if (tape.attempts >= TAPE_BOOTSTRAP_FAILURES_BEFORE_DEGRADED && !tape.unavailable) {
        tape.unavailable = true;
        if (!session.degraded && !session.recovering) this.deliverHealth(session, "READY", this.readyReason(session));
      }
      this.scheduleTapeRetry(session);
      return;
    }
    tape.inFlight = false;
    tape.done = true;
    const wasUnavailable = tape.unavailable;
    tape.unavailable = false;
    if (wasUnavailable && !session.degraded && !session.recovering) this.deliverHealth(session, "READY", HEALTH_REASON_READY);
    this.commitStagedWhenSafe(session);
  }

  /**
   * The staged pages can be reconciled against the live tape only once its
   * first trade is known. With a stream delivering, or none that could ever
   * deliver a trade older than the pages (no stream connecting or open), they
   * commit at once; with a stream connecting or open but silent, a short
   * grace keeps a first trade that is still in flight from overlapping
   * already committed rows.
   */
  private commitStagedWhenSafe(session: Session): void {
    const tape = session.tape;
    if (!tape.done || tape.staged.length === 0) return;
    const streamPending = session.stream !== null && session.stream.readyState <= OPEN;
    if (session.live === null && session.liveSpans.length === 0 && streamPending) {
      if (tape.graceTimer !== null) return;
      tape.graceTimer = this.setTimer(() => {
        tape.graceTimer = null;
        if (this.isCurrent(session)) this.commitStaged(session);
      }, BOOTSTRAP_COMMIT_GRACE_MS);
      return;
    }
    if (tape.graceTimer !== null) {
      this.clearTimer(tape.graceTimer);
      tape.graceTimer = null;
    }
    this.commitStaged(session);
  }

  private commitStaged(session: Session): void {
    const tape = session.tape;
    const staged = tape.staged;
    tape.staged = [];
    let kept = 0;
    let from = Infinity;
    let to = -Infinity;
    let endAggId: number | undefined;
    for (const page of staged) {
      kept += this.seedTape(session, page);
      for (const row of page) {
        if (row.T < from) from = row.T;
        if (row.T > to) to = row.T;
        if (endAggId === undefined || row.a > endAggId) endAggId = row.a;
      }
    }
    // A walk stopped by its budget, a failed page or the seven-day bound may
    // have cut through aggregates sharing the oldest millisecond, whose rest
    // sits in the page never read: that millisecond is claimed only when the
    // walk reached the exchange's first aggregate trade.
    const claimFrom = tape.startVerified ? from : from + 1;
    if (claimFrom <= to) addInterval(session.observed, { from: claimFrom, to, endAggId });
    if (kept > 0 || from <= to) {
      session.seam.publishWhenSettled = true;
      this.fillNextSeam(session);
    }
  }

  private scheduleTapeRetry(session: Session): void {
    if (!this.isCurrent(session)) return;
    const tape = session.tape;
    if (tape.timer !== null) this.clearTimer(tape.timer);
    const delay = tape.backoffMs;
    tape.backoffMs = Math.min(tape.backoffMs * 2, STREAM_BACKOFF_CAP_MS);
    tape.timer = this.setTimer(() => {
      tape.timer = null;
      if (this.isCurrent(session)) void this.bootstrapTape(session);
    }, delay);
  }

  /**
   * Whether a REST row is tape the stream already delivered. Inside a live
   * span (open or closed) it is; at a span's first or last millisecond the
   * aggregate's fill ids decide: wholly before the first live trade or wholly
   * after the last one it is missing tape and is kept, wholly within it is
   * dropped, and an aggregate straddling the boundary cannot be told apart,
   * so it is dropped and that millisecond is marked unverified: no coverage
   * claim includes it.
   */
  private admitRestRow(session: Session, row: AggTradeRow): boolean {
    const spans: readonly LiveSpan[] = session.live === null
      ? session.liveSpans
      : [...session.liveSpans, { from: session.live.from, to: Infinity, firstId: session.live.firstId, lastId: Infinity }];
    for (const span of spans) {
      if (row.T > span.from && row.T < span.to) return false;
      if (row.T !== span.from && row.T !== span.to) continue;
      // At a boundary millisecond, the fill ids place the aggregate: wholly
      // before the span's first trade (only at its first millisecond) or
      // wholly after its last (only at its last) is missing tape; wholly
      // between the two is the stream's; anything else straddles. A span of
      // one millisecond is both boundaries at once.
      const before = row.T === span.from && row.l < span.firstId;
      const after = row.T === span.to && row.f > span.lastId;
      if (before || after) continue;
      const within = row.f >= span.firstId && row.l <= span.lastId;
      if (within) return false;
      this.markUnverified(session, row.T);
      return false;
    }
    return true;
  }

  private markUnverified(session: Session, ms: number): void {
    if (!session.unverified.includes(ms)) session.unverified.push(ms);
  }

  /**
   * One validated page into the retention and the pool, as the runtime's
   * warm-up seeds a storage chunk: rows from the calibration window (the
   * newest fifteen minutes at the bootstrap's start) calibrate the floor
   * (`calibrate: true`, every size counted), older rows are admitted at the
   * floor; rows the stream already delivered are left out. Returns the rows kept.
   */
  private seedTape(session: Session, rows: readonly AggTradeRow[]): number {
    const calibration: TradeFrame[] = [];
    const older: TradeFrame[] = [];
    let oldestTs = Infinity;
    for (const row of rows) {
      if (!this.admitRestRow(session, row)) continue;
      const trade = aggTradeFrame(session.selection, row);
      if (row.T < oldestTs) oldestTs = row.T;
      (row.T >= session.calibrationFrom ? calibration : older).push(trade);
      this.offerMarker(session, trade, false);
    }
    if (oldestTs === Infinity) return 0;
    if (calibration.length > 0) session.pool.seed(calibration, { fromMs: oldestTs, calibrate: true });
    if (older.length > 0) session.pool.seed(older, { fromMs: oldestTs });
    return calibration.length + older.length;
  }

  /** The newest hole between two observed stretches (the open stream span counts) that is neither given up on nor made only of unverified milliseconds. */
  private nextSeamGap(session: Session): TapeInterval | null {
    const intervals = this.coverageIntervals(session);
    for (let i = intervals.length - 1; i >= 1; i -= 1) {
      const gap: TapeInterval = { from: intervals[i - 1].to, to: intervals[i].from, endAggId: intervals[i - 1].endAggId, endTradeId: intervals[i - 1].endTradeId };
      if (session.unfillable.some((open) => open.from === gap.from && open.to === gap.to)) continue;
      const interior = gap.to - gap.from - 1;
      const unverifiedInside = session.unverified.filter((ms) => ms > gap.from && ms < gap.to).length;
      if (interior <= unverifiedInside) continue;
      return gap;
    }
    return null;
  }

  /**
   * Closes the holes the tape has: between the bootstrap's newest row and the
   * stream's first trade, or between one stream's last trade and the next
   * stream's first. Kline recovery repairs bars, not trades, so the prints of
   * such a hole are read from REST within a bounded budget: by id from the
   * row after the last REST row when the hole follows one, else by time from
   * the hole's first millisecond, every row reconciled against the live tape
   * by fill id. A hole that cannot be closed stays a hole and is never inside
   * a completeness claim. One fill runs at a time; when nothing is left to
   * fill and a snapshot is waiting, it goes out.
   */
  private fillNextSeam(session: Session): void {
    if (!this.isCurrent(session) || session.seam.inFlight || session.seam.timer !== null) return;
    const gap = this.nextSeamGap(session);
    if (gap === null) {
      if (session.seam.publishWhenSettled) this.publishTapeState(session);
      return;
    }
    void this.fillSeam(session, gap);
  }

  private async fillSeam(session: Session, gap: TapeInterval): Promise<void> {
    const seam = session.seam;
    seam.inFlight = true;
    seam.gap = gap;
    let closed = false;
    let endAggId = gap.endAggId;
    try {
      let fromId: number | null = gap.endAggId === undefined ? null : gap.endAggId + 1;
      for (let pages = 0; pages < MAX_SEAM_FILL_PAGES; pages += 1) {
        const rows = await this.fetchAggTrades(session, fromId === null ? { startTime: gap.from } : { fromId }, seam);
        if (!this.isCurrent(session)) return;
        const inside = rows.filter((row) => row.T <= gap.to);
        if (inside.length > 0) {
          this.seedTape(session, inside);
          endAggId = inside[inside.length - 1].a;
        }
        // The hole is closed when a row past its end was read, or the page
        // was short (nothing newer existed on the exchange at the read).
        if (inside.length < rows.length || rows.length < TAPE_BOOTSTRAP_PAGE) {
          closed = true;
          break;
        }
        fromId = rows[rows.length - 1].a + 1;
      }
    } catch (error) {
      if (!this.isCurrent(session)) return;
      seam.inFlight = false;
      seam.gap = null;
      seam.failures += 1;
      console.warn("browserBinanceTransport: a tape seam fill failed", error);
      if (seam.failures < SEAM_FILL_FAILURES_BEFORE_GIVING_UP) {
        const delay = seam.backoffMs;
        seam.backoffMs = Math.min(seam.backoffMs * 2, STREAM_BACKOFF_CAP_MS);
        seam.timer = this.setTimer(() => {
          seam.timer = null;
          this.fillNextSeam(session);
        }, delay);
        return;
      }
      seam.failures = 0;
      seam.backoffMs = STREAM_BACKOFF_INITIAL_MS;
      session.unfillable.push({ from: gap.from, to: gap.to });
      this.fillNextSeam(session);
      return;
    }
    seam.inFlight = false;
    seam.gap = null;
    seam.failures = 0;
    seam.backoffMs = STREAM_BACKOFF_INITIAL_MS;
    if (closed) {
      addInterval(session.observed, { from: gap.from, to: gap.to, endAggId });
      // Coverage grew: the snapshot says so.
      session.seam.publishWhenSettled = true;
    } else {
      console.warn("browserBinanceTransport: a tape seam is wider than a fill may walk; it stays open");
      session.unfillable.push({ from: gap.from, to: gap.to });
    }
    this.fillNextSeam(session);
  }
}
