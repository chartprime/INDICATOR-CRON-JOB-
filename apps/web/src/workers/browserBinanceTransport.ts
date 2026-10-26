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
import marketInstrumentCatalog from "../../../../config/market-instruments.json";
import type { FrameIdentity, MarketKind } from "../types/frames";

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

export const HEALTH_REASON_READY = "BROWSER_DIRECT";
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
  /** A degraded health frame went out; the next open stream owes a READY (after a REST gap fill). */
  degraded: boolean;
  streamFailures: number;
  backoffMs: number;
  lastClosedOpen: number;
  abort: AbortController | null;
  timer: unknown;
  closed: boolean;
};

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
      case "aggressive_history": {
        const fields = echo(["request_id", "from_ts", "to_ts", "min_size"]);
        if (fields === null) return null;
        return { type: "aggressive_history", ...identity, ...fields, complete: false, reason: "STORAGE_UNAVAILABLE", next_cursor: null, retry_after_ms: null, trades: [] };
      }
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
    this.closeStream(session);
  }

  private closeStream(session: Session): void {
    if (session.connectTimer !== null) {
      this.clearTimer(session.connectTimer);
      session.connectTimer = null;
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
      degraded: false,
      streamFailures: 0,
      backoffMs: STREAM_BACKOFF_INITIAL_MS,
      lastClosedOpen: -1,
      abort: null,
      timer: null,
      closed: false,
    };
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

  private restFailureReason(session: Session): string {
    return session.selection.provider === "BINANCE" && session.selection.marketKind === "PERPETUAL"
      ? HEALTH_REASON_PERPETUAL_UNREACHABLE
      : HEALTH_REASON_REST_FAILED;
  }

  private async bootstrap(session: Session): Promise<void> {
    let rows: KlineRow[];
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
    const closedRows = rows.filter((row) => row.closeTime < now).slice(-SNAPSHOT_BARS);
    const forming = rows.find((row) => row.closeTime >= now && row.openTime <= now);
    const identity = identityFields(session.selection);
    this.deliver({
      type: "snapshot",
      ...identity,
      bars: closedRows.map((row) => barFrame(session.selection, row, true, true)),
      trades: [],
      markers: [],
      vpin_status: "DISABLED",
    });
    if (closedRows.length > 0) session.lastClosedOpen = closedRows[closedRows.length - 1].openTime;
    this.deliverHealth(session, "READY", HEALTH_REASON_READY);
    this.deliver({ type: "book", ...identity, status: "UNAVAILABLE", reason: BOOK_REASON_STREAM_CONNECTING });
    if (forming !== undefined) this.deliver(barFrame(session.selection, forming, false, false));
    session.backoffMs = STREAM_BACKOFF_INITIAL_MS;
    this.openStream(session);
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
      if (session.degraded) {
        session.degraded = false;
        void this.recoverAfterGap(session);
      }
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
      this.closeStream(session);
      this.streamLost(session);
    };
    stream.onerror = () => {
      // The browser follows every error with a close event; that path reports it.
    };
  }

  private streamLost(session: Session): void {
    if (!this.isCurrent(session)) return;
    session.streamFailures += 1;
    session.degraded = true;
    if (session.streamFailures >= STREAM_FAILURES_BEFORE_UNAVAILABLE) {
      this.deliverHealth(session, "UNAVAILABLE", HEALTH_REASON_STREAM_UNAVAILABLE);
    } else {
      this.deliverHealth(session, "RECOVERING", HEALTH_REASON_STREAM_CLOSED);
    }
    this.scheduleRetry(session, () => this.openStream(session));
  }

  /** After a stream reconnect: closed bars the stream missed come from REST, marked reconstructed as the runtime marks its backfill. */
  private async recoverAfterGap(session: Session): Promise<void> {
    let rows: KlineRow[] = [];
    try {
      rows = await this.fetchKlines(session, session.lastClosedOpen >= 0 ? { startTime: session.lastClosedOpen + BAR_INTERVAL_MS, limit: 1000 } : { limit: SNAPSHOT_BARS + 1 });
    } catch (error) {
      console.warn("browserBinanceTransport: kline gap fill failed", error);
    }
    if (!this.isCurrent(session)) return;
    const now = this.now();
    for (const row of rows) {
      if (row.closeTime < now && row.openTime > session.lastClosedOpen) {
        this.deliver(barFrame(session.selection, row, true, true));
        session.lastClosedOpen = row.openTime;
      }
    }
    this.deliverHealth(session, "READY", HEALTH_REASON_READY);
  }

  private routeStreamMessage(session: Session, parsed: unknown): void {
    if (!isRecord(parsed)) return;
    const payload = isRecord(parsed.data) && typeof parsed.stream === "string" ? parsed.data : parsed;
    if (payload.e === "kline") {
      const bar = parseKlineEvent(payload.k);
      if (bar === null) return;
      if (bar.closed && bar.openTime <= session.lastClosedOpen) return;
      this.deliver(barFrame(session.selection, bar, bar.closed, false));
      if (bar.closed) session.lastClosedOpen = bar.openTime;
      return;
    }
    if (payload.e === "trade") {
      const price = finiteNumber(payload.p);
      const size = finiteNumber(payload.q);
      if (price === undefined || size === undefined || price <= 0 || size <= 0) return;
      if (!Number.isSafeInteger(payload.T) || !Number.isSafeInteger(payload.t) || typeof payload.m !== "boolean") return;
      this.deliver({
        type: "trade",
        ...identityFields(session.selection),
        ts_exchange: payload.T,
        price,
        size,
        side: payload.m ? "sell" : "buy",
        trade_id: String(payload.t),
      });
      return;
    }
    const isSpotPartial = Array.isArray(payload.bids) && Array.isArray(payload.asks) && Number.isSafeInteger(payload.lastUpdateId);
    const isFuturesPartial = payload.e === "depthUpdate" && Array.isArray(payload.b) && Array.isArray(payload.a) && Number.isSafeInteger(payload.u);
    if (!isSpotPartial && !isFuturesPartial) return;
    const bids = bookLevels(isSpotPartial ? payload.bids : payload.b);
    const asks = bookLevels(isSpotPartial ? payload.asks : payload.a);
    if (bids === null || asks === null) return;
    if (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price) return;
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
}
