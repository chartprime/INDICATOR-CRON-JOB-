import {
  CLIENT_CAPABILITIES,
  L2_CHANNELS,
  type L2Channel,
  describeRejectedFrame,
  parseFrameIdentity,
  parseServerFrame,
  type FrameIdentity,
  type L2ViewFrame,
  type LiquidityFrame,
  type ServerFrame,
} from "../types/frames";
import { LiquidityDecoder, type DecodedLiquidity, type LiquidityColumn } from "../lib/indicators/passive-liquidity/liquidityGrid";
import { LaneDecoder, type DecodedLane } from "../lib/l2/laneGrids";
import { HISTORY_LEVELS_MS, HISTORY_ROW_FACTORS, decodeHistoryPage, historyTransferables, type DecodedHistoryPage } from "../lib/indicators/passive-liquidity/heatmapHistoryDecode";
import { decodeHostWallPage, isWallFilter, type HostWallPage } from "../lib/l2/hostWalls";
import { BROWSER_BINANCE_SOURCE, BrowserBinanceTransport, type DataSource, type TransportSocket } from "./browserBinanceTransport";

export type WorkerToMainMessage =
  | {
      kind: "frame";
      frame: ServerFrame;
      selectionTrace?: SelectionTraceTransport;
      decodedLiquidity?: DecodedLiquidity;
      decodedLane?: DecodedLane;
    }
  | { kind: "status"; status: "connecting" | "open" | "closed"; reason?: string }
  | { kind: "heatmap_history"; request_id: number; page: DecodedHistoryPage | null; failed: boolean; retry_after_ms?: number }
  | { kind: "heatmap_walls"; request_id: number; page: HostWallPage | null; failed: boolean; retry_after_ms?: number };

export type HeatmapHistoryRequest = {
  request_id: number;
  provider: "BINANCE" | "DXFEED";
  market_kind: string;
  symbol: string;
  level_ms: number;
  from_ts: number;
  to_ts: number;
  row_factor: number;
};

export type HeatmapWallsRequest = {
  request_id: number;
  provider: "BINANCE" | "DXFEED";
  market_kind: string;
  symbol: string;
  from_ts: number;
  to_ts: number;
  limit: number;
  after: { end_ts: number; id: number } | null;
  min_usd?: number;
  always_outcomes?: string[];
};

export const HEATMAP_HISTORY_TIMEOUT_MS = 30_000;
const HEATMAP_HISTORY_PATH = "/heatmap/columns";
const HEATMAP_WALLS_PATH = "/heatmap/walls";

export type SelectionTraceTransport = {
  runId: string;
  connectionId: number;
  selectionGeneration: number;
  requestedAtMs: number;
  sentAtMs: number;
  receivedAtMs: number;
  parsedAtMs: number;
  phase:
    | "selection_confirmed"
    | "recovery_confirmed"
    | "first_snapshot"
    | "backfill_status";
  backfillStatus?: "RUNNING" | "COMPLETE" | "FAILED";
  backfillReason?: string | null;
};

type SelectionTraceRequest = Pick<
  SelectionTraceTransport,
  "runId" | "selectionGeneration" | "requestedAtMs"
>;

export type ProfileConfigRequest = {
  mode: "continuous" | "per_candle" | "fixed_range";
  period_ms: number | null;
  bin_size_multiplier: number | null;
  range_start_ts: number | null;
  range_end_ts: number | null;
};

export type ProfileHistoryRange = {
  range_start_ts: number;
  range_end_ts: number;
};

export type ProfileHistoryRequest = {
  mode: "continuous" | "per_candle";
  request_id: number;
  period_ms: number;
  bin_size_multiplier: number | null;
  ranges: ProfileHistoryRange[];
};

export const MAX_HISTORY_RANGES = 64;

export type AggressiveHistoryRequest = {
  request_id: number;
  from_ts: number;
  to_ts: number;
  min_size: number;
  cursor?: string;
};

export type ExhaustionHistoryRequest = {
  from_ts: number;
};

export type InitiativeHistoryRequest = {
  from_ts: number;
};

export type DeltaProfileRequest = {
  request_id: number;
  from_ts: number;
  to_ts: number;
  row_width: number;
};

export type L2HistoryRequest = {
  request_id: number;
  from_ts: number;
  to_ts: number;
  price_lo: number;
  price_hi: number;
  cursor?: unknown;
};

export type BandHistoryRequest = {
  request_id: number;
  from_ts: number;
  to_ts: number;
  price_lo: number;
  price_hi: number;
  column_ms: number;
};

export type MainToWorkerMessage =
  | { kind: "flow_control" }
  | { kind: "ack" }
  | { kind: "start"; url: string; source?: DataSource }
  | { kind: "stop" }
  | ({
      kind: "select";
      symbol: string;
      selectionTrace?: SelectionTraceRequest;
    } & FrameIdentity)
  | ({ kind: "profile_config" } & ProfileConfigRequest)
  | ({ kind: "profile_history" } & ProfileHistoryRequest)
  | ({ kind: "aggressive_history" } & AggressiveHistoryRequest)
  | ({ kind: "exhaustion_history" } & ExhaustionHistoryRequest)
  | ({ kind: "initiative_history" } & InitiativeHistoryRequest)
  | ({ kind: "delta_profile" } & DeltaProfileRequest)
  | ({ kind: "band_history" } & BandHistoryRequest)
  | ({ kind: "wall_history" } & L2HistoryRequest)
  | ({ kind: "l2_event_history" } & L2HistoryRequest)
  | ({ kind: "heatmap_history" } & HeatmapHistoryRequest)
  | ({ kind: "heatmap_walls" } & HeatmapWallsRequest)
  | { kind: "liquidity_resync" }
  | { kind: "l2_resync"; channel: L2Channel };

type SelectionRequest = {
  symbol: string;
  selectionTrace?: SelectionTraceRequest;
} & FrameIdentity;

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MULTIPLIER = 1.7;
const BACKOFF_CAP_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_MS = 12_000;
const MAX_SERVER_MESSAGE_BYTES = 32 * 1024 * 1024;

let ws: TransportSocket | null = null;
let url = "";
let source: DataSource | undefined;
let backoffMs = BACKOFF_INITIAL_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let desiredSelection: SelectionRequest | null = null;
let selectionWasSent = false;
let awaitingSelectionConfirmation = false;
let nextConnectionId = 0;
let currentConnectionId = 0;
let selectionSentAtMs: number | null = null;
let confirmedSelectionTrace: Omit<
  SelectionTraceTransport,
  "receivedAtMs" | "parsedAtMs" | "phase"
> | null = null;
let selectionTraceHasConfirmed = false;
let snapshotTracedConnectionId = 0;
let lastBackfillTraceKey: string | null = null;
let flowControl = false;
let flowPaused = false;
const pendingDeliveryBytes: number[] = [];
let pendingBytes = 0;
const MAX_PENDING_DELIVERIES = 4_000;
const MAX_PENDING_DELIVERY_BYTES = 32 * 1024 * 1024;
const socketCleanup = new WeakMap<TransportSocket, () => void>();

/**
 * The transport seam. With no data source set, the worker speaks to the
 * runtime over a real WebSocket exactly as before; with "browser-binance" it
 * reads Binance directly from the browser through an object that offers the
 * same subset of the WebSocket interface and emits the same canonical frames.
 */
export function createTransport(socketUrl: string, dataSource: DataSource | undefined): TransportSocket {
  if (dataSource === BROWSER_BINANCE_SOURCE) return new BrowserBinanceTransport(socketUrl);
  return new WebSocket(socketUrl);
}

function traceNowMs(): number {
  return performance.timeOrigin + performance.now();
}

function releaseSocket(socket: TransportSocket | null): void {
  if (!socket) return;
  socketCleanup.get(socket)?.();
  socketCleanup.delete(socket);
}

const columnDecoders = new Map<string, { liquidity: LiquidityDecoder; lanes: LaneDecoder }>();

function columnDecodersFor(frame: LiquidityFrame | L2ViewFrame): { liquidity: LiquidityDecoder; lanes: LaneDecoder } {
  const key = `${frame.provider}:${frame.symbol}:${frame.provider === "BINANCE" ? frame.marketKind : frame.assetClass}`;
  let decoders = columnDecoders.get(key);
  if (decoders === undefined) {
    decoders = { liquidity: new LiquidityDecoder(), lanes: new LaneDecoder() };
    columnDecoders.set(key, decoders);
  }
  return decoders;
}

function transferablesOf(columns: readonly LiquidityColumn[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const column of columns) buffers.push(column.bid.buffer as ArrayBuffer, column.ask.buffer as ArrayBuffer);
  return buffers;
}

function withoutRows<F extends LiquidityFrame | L2ViewFrame>(frame: F): F {
  return { ...frame, columns: frame.columns.map((column) => ({ ...column, bid: [], ask: [] })) };
}

function decodedMessage(frame: ServerFrame): { frame: ServerFrame; decodedLiquidity?: DecodedLiquidity; decodedLane?: DecodedLane; transfer: ArrayBuffer[] } {
  if (frame.type === "liquidity") {
    const decodedLiquidity = columnDecodersFor(frame).liquidity.decode(frame);
    return { frame: withoutRows(frame), decodedLiquidity, transfer: transferablesOf(decodedLiquidity.columns) };
  }
  if (frame.type === "l2_view") {
    const decodedLane = columnDecodersFor(frame).lanes.decode(frame);
    return { frame: withoutRows(frame), decodedLane, transfer: decodedLane.decoded === null ? [] : transferablesOf(decodedLane.decoded.columns) };
  }
  return { frame, transfer: [] };
}

function heatmapHistoryUrl(socketUrl: string, pathname = HEATMAP_HISTORY_PATH): string | null {
  try {
    const parsed = new URL(socketUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = pathname;
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function parseHeatmapHistoryRequest(msg: Record<string, unknown>): HeatmapHistoryRequest | null {
  const keys = ["from_ts", "kind", "level_ms", "market_kind", "provider", "request_id", "row_factor", "symbol", "to_ts"];
  if (!hasExactKeys(msg, keys)) return null;
  const { request_id: requestId, provider, market_kind: marketKind, symbol, level_ms: levelMs, from_ts: fromTs, to_ts: toTs, row_factor: rowFactor } = msg;
  if (!isSafeIntegerValue(requestId) || requestId < 0) return null;
  if (provider !== "BINANCE" && provider !== "DXFEED") return null;
  if (typeof marketKind !== "string" || marketKind.length === 0 || marketKind.length > 32) return null;
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 64) return null;
  if (!isSafeIntegerValue(levelMs) || !HISTORY_LEVELS_MS.includes(levelMs)) return null;
  if (!isSafeIntegerValue(rowFactor) || !HISTORY_ROW_FACTORS.includes(rowFactor)) return null;
  if (!isSafeIntegerValue(fromTs) || fromTs < 0 || !isSafeIntegerValue(toTs) || toTs <= fromTs) return null;
  return { request_id: requestId, provider, market_kind: marketKind, symbol, level_ms: levelMs, from_ts: fromTs, to_ts: toTs, row_factor: rowFactor };
}

const WALL_REQUEST_KEYS = ["after", "from_ts", "kind", "limit", "market_kind", "provider", "request_id", "symbol", "to_ts"];

function parseHeatmapWallsRequest(msg: Record<string, unknown>): HeatmapWallsRequest | null {
  const present = Object.keys(msg);
  if (!WALL_REQUEST_KEYS.every((key) => present.includes(key))) return null;
  if (present.some((key) => !WALL_REQUEST_KEYS.includes(key) && key !== "min_usd" && key !== "always_outcomes")) return null;
  const { request_id: requestId, provider, market_kind: marketKind, symbol, from_ts: fromTs, to_ts: toTs, limit, after, min_usd: minUsd, always_outcomes: alwaysOutcomes } = msg;
  const filtered = minUsd !== undefined || alwaysOutcomes !== undefined;
  if (filtered) {
    if (provider !== "BINANCE") return null;
    if (!isWallFilter({ minUsd, alwaysOutcomes: alwaysOutcomes ?? [] })) return null;
  }
  if (!isSafeIntegerValue(requestId) || requestId < 0) return null;
  if (provider !== "BINANCE" && provider !== "DXFEED") return null;
  if (typeof marketKind !== "string" || marketKind.length === 0 || marketKind.length > 32) return null;
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 64) return null;
  if (!isSafeIntegerValue(fromTs) || fromTs < 0 || !isSafeIntegerValue(toTs) || toTs <= fromTs) return null;
  if (!isSafeIntegerValue(limit) || limit < 1 || limit > 400) return null;
  if (after !== null && (typeof after !== "object" || after === null || !isSafeIntegerValue((after as { end_ts: unknown }).end_ts) || !isSafeIntegerValue((after as { id: unknown }).id))) return null;
  return {
    request_id: requestId,
    provider,
    market_kind: marketKind,
    symbol,
    from_ts: fromTs,
    to_ts: toTs,
    limit,
    after: after === null ? null : { end_ts: (after as { end_ts: number }).end_ts, id: (after as { id: number }).id },
    ...(filtered ? { min_usd: minUsd as number, always_outcomes: [...((alwaysOutcomes ?? []) as string[])] } : {}),
  };
}

async function retryAfterOf(response: Response): Promise<number | undefined> {
  if (response.status !== 429) return undefined;
  try {
    const body: unknown = await response.json();
    const delay = (body as { retryAfterMs?: unknown } | null)?.retryAfterMs;
    return typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : undefined;
  } catch {
    return undefined;
  }
}

function postHeatmapWalls(requestId: number, page: HostWallPage | null, failed: boolean, retryAfterMs?: number): void {
  const message: WorkerToMainMessage = { kind: "heatmap_walls", request_id: requestId, page, failed, ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }) };
  try {
    postMessage(message);
  } catch (error) {
    console.warn("marketDataWorker: could not deliver a wall history page", error);
  }
}

async function fetchHeatmapWalls(request: HeatmapWallsRequest, endpoint: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEATMAP_HISTORY_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: request.provider,
        marketKind: request.market_kind,
        symbol: request.symbol,
        fromTs: request.from_ts,
        toTs: request.to_ts,
        limit: request.limit,
        ...(request.after === null ? {} : { after: { endTs: request.after.end_ts, id: request.after.id } }),
        ...(request.min_usd === undefined ? {} : { minUsd: request.min_usd, alwaysOutcomes: request.always_outcomes ?? [] }),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      postHeatmapWalls(request.request_id, null, true, await retryAfterOf(response));
      return;
    }
    postHeatmapWalls(request.request_id, decodeHostWallPage(await response.json()), false);
  } catch {
    postHeatmapWalls(request.request_id, null, true);
  } finally {
    clearTimeout(timer);
  }
}

function postHeatmapHistory(requestId: number, page: DecodedHistoryPage | null, failed: boolean, retryAfterMs?: number): void {
  const message: WorkerToMainMessage = { kind: "heatmap_history", request_id: requestId, page, failed, ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }) };
  try {
    postMessage(message, { transfer: page === null ? [] : historyTransferables(page) });
  } catch (error) {
    console.warn("marketDataWorker: could not deliver a heatmap history page", error);
  }
}

async function fetchHeatmapHistory(request: HeatmapHistoryRequest, endpoint: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEATMAP_HISTORY_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: request.provider,
        marketKind: request.market_kind,
        symbol: request.symbol,
        levelMs: request.level_ms,
        fromTs: request.from_ts,
        toTs: request.to_ts,
        rowFactor: request.row_factor,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      postHeatmapHistory(request.request_id, null, true, await retryAfterOf(response));
      return;
    }
    const identity = request.provider === "DXFEED" ? { assetClass: request.market_kind } : {};
    postHeatmapHistory(request.request_id, decodeHistoryPage(await response.json(), identity), false);
  } catch {
    postHeatmapHistory(request.request_id, null, true);
  } finally {
    clearTimeout(timer);
  }
}

function post(message: WorkerToMainMessage, bytes = 256, transfer: ArrayBuffer[] = []): boolean {
  if (flowControl && flowPaused) return false;
  if (
    flowControl &&
    (pendingDeliveryBytes.length >= MAX_PENDING_DELIVERIES ||
      pendingBytes + bytes > MAX_PENDING_DELIVERY_BYTES)
  ) {
    flowPaused = true;
    // One bounded terminal notice follows all previously posted messages.
    pendingDeliveryBytes.push(0);
    try {
      postMessage({ kind: "status", status: "closed", reason: `flow-paused:${pendingDeliveryBytes.length - 1}/${pendingBytes}+${bytes}:${message.kind === "frame" ? message.frame.type : message.kind}` });
    } catch {}
    return false;
  }
  try {
    if (flowControl) {
      pendingDeliveryBytes.push(bytes);
      pendingBytes += bytes;
    }
    if (transfer.length > 0) postMessage(message, { transfer });
    else postMessage(message);
    return true;
  } catch (error) {
    if (flowControl) {
      pendingDeliveryBytes.pop();
      pendingBytes -= bytes;
    }
    console.warn(
      "marketDataWorker: failed to post a message to the main thread",
      error,
    );
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSelectionRequest(value: unknown): SelectionRequest | null {
  if (!isRecord(value) || typeof value.symbol !== "string") return null;
  const identity = parseFrameIdentity(value);
  if (identity === null) return null;
  const hasTrace = Object.hasOwn(value, "selectionTrace");
  const expectedKeys =
    identity.provider === "BINANCE"
      ? [
          "kind",
          "marketKind",
          "provider",
          ...(hasTrace ? ["selectionTrace"] : []),
          "symbol",
        ]
      : [
          "assetClass",
          "kind",
          "provider",
          ...(hasTrace ? ["selectionTrace"] : []),
          "symbol",
        ];
  if (!hasExactKeys(value, expectedKeys)) return null;
  let selectionTrace: SelectionTraceRequest | undefined;
  if (hasTrace) {
    const candidate = value.selectionTrace;
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        "requestedAtMs",
        "runId",
        "selectionGeneration",
      ]) ||
      typeof candidate.runId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(candidate.runId) ||
      !Number.isSafeInteger(candidate.selectionGeneration) ||
      (candidate.selectionGeneration as number) <= 0 ||
      typeof candidate.requestedAtMs !== "number" ||
      !Number.isFinite(candidate.requestedAtMs) ||
      candidate.requestedAtMs < 0
    )
      return null;
    selectionTrace = {
      runId: candidate.runId,
      selectionGeneration: candidate.selectionGeneration as number,
      requestedAtMs: candidate.requestedAtMs,
    };
  }
  return {
    symbol: value.symbol,
    ...identity,
    ...(selectionTrace === undefined ? {} : { selectionTrace }),
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function isSafeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

const PROFILE_CONFIG_MODES = new Set([
  "continuous",
  "per_candle",
  "fixed_range",
]);

function isNullOrPositiveSafeInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  );
}

const MIN_BIN_SIZE_MULTIPLIER = 0.02;
const MAX_BIN_SIZE_MULTIPLIER = 10;

function isNullOrBinSizeMultiplier(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= MIN_BIN_SIZE_MULTIPLIER &&
      value <= MAX_BIN_SIZE_MULTIPLIER)
  );
}

function parseProfileHistoryRequest(
  value: unknown,
): ProfileHistoryRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "bin_size_multiplier",
      "kind",
      "mode",
      "period_ms",
      "ranges",
      "request_id",
    ]) ||
    (value.mode !== "continuous" && value.mode !== "per_candle") ||
    !Number.isSafeInteger(value.request_id) ||
    (value.request_id as number) <= 0 ||
    !Number.isSafeInteger(value.period_ms) ||
    (value.period_ms as number) <= 0 ||
    !isNullOrBinSizeMultiplier(value.bin_size_multiplier) ||
    !Array.isArray(value.ranges) ||
    value.ranges.length === 0 ||
    value.ranges.length > MAX_HISTORY_RANGES
  ) {
    return null;
  }
  const periodMs = value.period_ms as number;
  const ranges: ProfileHistoryRange[] = [];
  const seen = new Set<number>();
  for (const entry of value.ranges) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["range_end_ts", "range_start_ts"])
    )
      return null;
    const startTs = entry.range_start_ts;
    const endTs = entry.range_end_ts;
    if (!Number.isSafeInteger(startTs) || (startTs as number) < 0) return null;
    if (
      !Number.isSafeInteger(endTs) ||
      (endTs as number) <= (startTs as number)
    )
      return null;
    if ((endTs as number) - (startTs as number) !== periodMs) return null;
    if ((startTs as number) % periodMs !== 0) return null;
    if (seen.has(startTs as number)) return null;
    seen.add(startTs as number);
    ranges.push({
      range_start_ts: startTs as number,
      range_end_ts: endTs as number,
    });
  }
  return {
    mode: value.mode,
    request_id: value.request_id as number,
    period_ms: periodMs,
    bin_size_multiplier: value.bin_size_multiplier as number | null,
    ranges,
  };
}

function parseProfileConfigRequest(
  value: unknown,
): ProfileConfigRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "bin_size_multiplier",
      "kind",
      "mode",
      "period_ms",
      "range_end_ts",
      "range_start_ts",
    ]) ||
    typeof value.mode !== "string" ||
    !PROFILE_CONFIG_MODES.has(value.mode) ||
    !isNullOrPositiveSafeInteger(value.period_ms) ||
    !isNullOrBinSizeMultiplier(value.bin_size_multiplier) ||
    !(
      value.range_start_ts === null ||
      (Number.isSafeInteger(value.range_start_ts) &&
        (value.range_start_ts as number) >= 0)
    ) ||
    !(
      value.range_end_ts === null ||
      (Number.isSafeInteger(value.range_end_ts) &&
        (value.range_end_ts as number) >= 0)
    )
  ) {
    return null;
  }
  if (value.mode === "fixed_range") {
    if (
      !Number.isSafeInteger(value.range_start_ts) ||
      !Number.isSafeInteger(value.range_end_ts) ||
      (value.range_end_ts as number) <= (value.range_start_ts as number)
    )
      return null;
  } else if (value.range_start_ts !== null || value.range_end_ts !== null) {
    return null;
  }
  return {
    mode: value.mode as ProfileConfigRequest["mode"],
    period_ms: value.period_ms as number | null,
    bin_size_multiplier: value.bin_size_multiplier as number | null,
    range_start_ts: value.range_start_ts as number | null,
    range_end_ts: value.range_end_ts as number | null,
  };
}

function isWebSocketUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048)
    return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function isCurrentSocket(socket: TransportSocket): boolean {
  return !stopped && ws === socket;
}

export function serverMessageExceedsByteLimit(
  value: string,
  maxBytes = MAX_SERVER_MESSAGE_BYTES,
): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return true;
  if (value.length > maxBytes) return true;
  if (value.length <= Math.floor(maxBytes / 3)) return false;
  return new TextEncoder().encode(value).byteLength > maxBytes;
}

function clearConnectTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

function failCurrentSocket(socket: TransportSocket, reason: string): void {
  if (!isCurrentSocket(socket)) return;
  releaseSocket(socket);
  ws = null;
  try {
    socket.close();
  } catch {
    void 0;
  }
  post({ kind: "status", status: "closed", reason });
  scheduleReconnect();
}

function sendDesiredSelection(socket: TransportSocket): void {
  if (
    !isCurrentSocket(socket) ||
    desiredSelection === null ||
    socket.readyState !== WebSocket.OPEN
  )
    return;
  try {
    const resume = desiredSelection.provider === "DXFEED" && selectionWasSent;
    const { selectionTrace: _selectionTrace, ...wireSelection } =
      desiredSelection;
    columnDecoders.clear();
    socket.send(
      JSON.stringify({
        type: "select",
        ...wireSelection,
        ...(resume ? { resume: true } : {}),
      }),
    );
    selectionSentAtMs = traceNowMs();
    selectionWasSent = true;
  } catch (error) {
    console.warn(
      "marketDataWorker: deferred a select request until the next live socket",
      error,
    );
    failCurrentSocket(socket, "send-failed:select");
  }
}

function connect(): void {
  if (stopped || flowPaused) return;
  if (!post({ kind: "status", status: "connecting" })) return;

  let socket: TransportSocket;
  try {
    socket = createTransport(url, source);
  } catch (error) {
    console.warn("marketDataWorker: failed to construct WebSocket", error);
    post({ kind: "status", status: "closed", reason: "construct-failed" });
    scheduleReconnect();
    return;
  }
  ws = socket;
  currentConnectionId = ++nextConnectionId;
  let provedAlive = false;
  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (!isCurrentSocket(socket)) return;
    failCurrentSocket(socket, `connect-timeout:${socket.readyState}`);
  }, CONNECT_TIMEOUT_MS);
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  socketCleanup.set(socket, () => {
    clearConnectTimer(connectTimer);
    connectTimer = null;
    clearConnectTimer(stableTimer);
    stableTimer = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  });

  socket.onopen = () => {
    if (!isCurrentSocket(socket)) return;
    if (!post({ kind: "status", status: "open" })) {
      failCurrentSocket(socket, "post-failed:open");
      return;
    }
    stableTimer = setTimeout(() => {
      if (isCurrentSocket(socket)) backoffMs = BACKOFF_INITIAL_MS;
    }, STABLE_CONNECTION_MS);
    columnDecoders.clear();
    try {
      // Capability negotiation makes a host-first rolling deploy safe: a new
      // host with marker_history support remains on the legacy wire until the
      // browser explicitly opts in. Older hosts simply ignore this message.
      socket.send(
        JSON.stringify({
          type: "capabilities",
          ...Object.fromEntries(CLIENT_CAPABILITIES.map((flag) => [flag, true])),
        }),
      );
    } catch {
      failCurrentSocket(socket, "send-failed:capabilities");
      return;
    }
    sendDesiredSelection(socket);
  };

  socket.onmessage = (event: MessageEvent<string>) => {
    if (!isCurrentSocket(socket)) return;
    const receivedAtMs = traceNowMs();
    if (
      typeof event.data !== "string" ||
      serverMessageExceedsByteLimit(event.data)
    ) {
      console.warn("marketDataWorker: dropped a non-text or oversized frame");
      failCurrentSocket(socket, typeof event.data === "string" ? `oversize:${event.data.length}` : "non-text");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      console.warn("marketDataWorker: dropped malformed (non-JSON) frame");
      failCurrentSocket(socket, "malformed-json");
      return;
    }
    const frame = parseServerFrame(parsed, { nowMs: Date.now() });
    const parsedAtMs = traceNowMs();
    if (frame === null) {
      const rejection = describeRejectedFrame(parsed);
      console.warn(
        "marketDataWorker: dropped malformed or unrecognized frame",
        rejection,
      );
      failCurrentSocket(socket, `parse-rejected:${rejection}`);
      return;
    }
    let selectionTrace: SelectionTraceTransport | undefined;
    if (frame.type === "selection") {
      const matchesDesired =
        desiredSelection !== null &&
        frame.symbol === desiredSelection.symbol &&
        frame.provider === desiredSelection.provider &&
        (frame.provider === "BINANCE"
          ? frame.marketKind === desiredSelection.marketKind
          : frame.assetClass === desiredSelection.assetClass);
      // Shared changes become the reconnect target. An initial server snapshot
      // must not overwrite a deliberate selection still awaiting its reply.
      if (!awaitingSelectionConfirmation || matchesDesired) {
        if (
          matchesDesired &&
          desiredSelection?.selectionTrace !== undefined &&
          selectionSentAtMs !== null
        ) {
          confirmedSelectionTrace = {
            connectionId: currentConnectionId,
            ...desiredSelection.selectionTrace,
            sentAtMs: selectionSentAtMs,
          };
          selectionTrace = {
            ...confirmedSelectionTrace,
            receivedAtMs,
            parsedAtMs,
            phase: selectionTraceHasConfirmed
              ? "recovery_confirmed"
              : "selection_confirmed",
          };
          selectionTraceHasConfirmed = true;
        } else {
          confirmedSelectionTrace = null;
        }
        const retainedTrace = matchesDesired
          ? desiredSelection?.selectionTrace
          : undefined;
        desiredSelection =
          frame.provider === "BINANCE"
            ? {
                symbol: frame.symbol,
                provider: frame.provider,
                marketKind: frame.marketKind,
                ...(retainedTrace ? { selectionTrace: retainedTrace } : {}),
              }
            : {
                symbol: frame.symbol,
                provider: frame.provider,
                assetClass: frame.assetClass,
                ...(retainedTrace ? { selectionTrace: retainedTrace } : {}),
              };
        selectionWasSent = true;
        awaitingSelectionConfirmation = false;
      }
    }
    if (
      frame.type === "snapshot" &&
      confirmedSelectionTrace !== null &&
      snapshotTracedConnectionId !== currentConnectionId
    ) {
      selectionTrace = {
        ...confirmedSelectionTrace,
        receivedAtMs,
        parsedAtMs,
        phase: "first_snapshot",
      };
      snapshotTracedConnectionId = currentConnectionId;
    }
    if (
      frame.type === "liquidity" &&
      frame.backfill !== undefined &&
      confirmedSelectionTrace !== null
    ) {
      const backfillTraceKey = `${currentConnectionId}:${frame.backfill.status}:${frame.backfill.reason ?? ""}`;
      if (backfillTraceKey !== lastBackfillTraceKey) {
        selectionTrace = {
          ...confirmedSelectionTrace,
          receivedAtMs,
          parsedAtMs,
          phase: "backfill_status",
          backfillStatus: frame.backfill.status,
          backfillReason: frame.backfill.reason,
        };
        lastBackfillTraceKey = backfillTraceKey;
      }
    }
    if (!provedAlive) {
      provedAlive = true;
      clearConnectTimer(connectTimer);
      connectTimer = null;
    }
    const decoded = decodedMessage(frame);
    if (
      !post(
        {
          kind: "frame",
          frame: decoded.frame,
          ...(selectionTrace === undefined ? {} : { selectionTrace }),
          ...(decoded.decodedLiquidity === undefined ? {} : { decodedLiquidity: decoded.decodedLiquidity }),
          ...(decoded.decodedLane === undefined ? {} : { decodedLane: decoded.decodedLane }),
        },
        new TextEncoder().encode(event.data).byteLength,
        decoded.transfer,
      )
    )
      failCurrentSocket(socket, `post-failed:${frame.type}`);
  };

  socket.onclose = (event: CloseEvent) => {
    releaseSocket(socket);
    if (!isCurrentSocket(socket)) return;
    ws = null;
    post({ kind: "status", status: "closed", reason: `server-close:${event.code}:${event.reason.slice(0, 64)}` });
    scheduleReconnect();
  };

  socket.onerror = () => {
    failCurrentSocket(socket, "socket-error");
  };
}

function scheduleReconnect(): void {
  if (stopped || flowPaused) return;
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_CAP_MS);
}

self.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const msg: unknown = event.data;
  if (!isRecord(msg) || typeof msg.kind !== "string") {
    console.warn("marketDataWorker: dropped malformed control message");
    return;
  }
  if (msg.kind === "flow_control" && hasExactKeys(msg, ["kind"])) {
    flowControl = true;
    return;
  }
  if (msg.kind === "ack" && hasExactKeys(msg, ["kind"])) {
    pendingBytes -= pendingDeliveryBytes.shift() ?? 0;
    if (flowPaused && pendingDeliveryBytes.length === 0) {
      flowPaused = false;
      scheduleReconnect();
    }
    return;
  }
  if (msg.kind === "start") {
    const hasSource = Object.hasOwn(msg, "source");
    if (
      !hasExactKeys(msg, hasSource ? ["kind", "source", "url"] : ["kind", "url"]) ||
      !isWebSocketUrl(msg.url) ||
      (hasSource && msg.source !== BROWSER_BINANCE_SOURCE)
    ) {
      console.warn(
        "marketDataWorker: dropped start request with an invalid URL",
      );
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const previous = ws;
      releaseSocket(previous);
      ws = null;
      try {
        previous?.close();
      } catch {
        void 0;
      }
      post({ kind: "status", status: "closed", reason: "invalid-start-url" });
      return;
    }
    url = msg.url;
    source = hasSource ? BROWSER_BINANCE_SOURCE : undefined;
    stopped = false;
    backoffMs = BACKOFF_INITIAL_MS;
    desiredSelection = null;
    selectionWasSent = false;
    awaitingSelectionConfirmation = false;
    selectionSentAtMs = null;
    confirmedSelectionTrace = null;
    selectionTraceHasConfirmed = false;
    snapshotTracedConnectionId = 0;
    lastBackfillTraceKey = null;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const previous = ws;
    releaseSocket(previous);
    ws = null;
    try {
      previous?.close();
    } catch {
      void 0;
    }
    connect();
  } else if (msg.kind === "stop") {
    if (!hasExactKeys(msg, ["kind"])) {
      console.warn("marketDataWorker: dropped malformed stop request");
      return;
    }
    stopped = true;
    releaseSocket(ws);
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      ws?.close();
    } catch {
      void 0;
    }
    ws = null;
    desiredSelection = null;
    selectionWasSent = false;
    awaitingSelectionConfirmation = false;
    selectionSentAtMs = null;
    confirmedSelectionTrace = null;
    selectionTraceHasConfirmed = false;
    snapshotTracedConnectionId = 0;
    lastBackfillTraceKey = null;
  } else if (msg.kind === "select") {
    const selection = parseSelectionRequest(msg);
    if (selection === null) {
      console.warn("marketDataWorker: dropped malformed select request");
      return;
    }
    desiredSelection = selection;
    selectionWasSent = false;
    awaitingSelectionConfirmation = true;
    selectionSentAtMs = null;
    confirmedSelectionTrace = null;
    selectionTraceHasConfirmed = false;
    snapshotTracedConnectionId = 0;
    lastBackfillTraceKey = null;
    if (ws !== null) sendDesiredSelection(ws);
  } else if (msg.kind === "profile_config") {
    const config = parseProfileConfigRequest(msg);
    if (config === null) {
      console.warn(
        "marketDataWorker: dropped malformed profile_config request",
      );
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "profile_config", ...config }));
    } catch (error) {
      console.warn(
        "marketDataWorker: failed to send a profile_config request",
        error,
      );
      failCurrentSocket(ws, "send-failed:profile_config");
    }
  } else if (msg.kind === "profile_history") {
    const request = parseProfileHistoryRequest(msg);
    if (request === null) {
      console.warn(
        "marketDataWorker: dropped malformed profile_history request",
      );
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "profile_history", ...request }));
    } catch (error) {
      console.warn(
        "marketDataWorker: failed to send a profile_history request",
        error,
      );
      failCurrentSocket(ws, "send-failed:profile_history");
    }
  } else if (msg.kind === "aggressive_history") {
    const {
      request_id: requestId,
      from_ts: fromTs,
      to_ts: toTs,
      min_size: minSize,
      cursor,
    } = msg;
    const hasCursor = Object.hasOwn(msg, "cursor");
    if (
      !hasExactKeys(
        msg,
        hasCursor
          ? ["cursor", "from_ts", "kind", "min_size", "request_id", "to_ts"]
          : ["from_ts", "kind", "min_size", "request_id", "to_ts"],
      ) ||
      !isSafeIntegerValue(requestId) ||
      requestId < 0 ||
      !isSafeIntegerValue(fromTs) ||
      fromTs < 0 ||
      !isSafeIntegerValue(toTs) ||
      toTs <= fromTs ||
      typeof minSize !== "number" ||
      !Number.isFinite(minSize) ||
      minSize < 0 ||
      (hasCursor &&
        (typeof cursor !== "string" ||
          cursor.length === 0 ||
          cursor.length > 512 ||
          !/^[A-Za-z0-9_-]+$/.test(cursor)))
    ) {
      console.warn(
        "marketDataWorker: dropped malformed aggressive_history request",
      );
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          type: "aggressive_history",
          request_id: requestId,
          from_ts: fromTs,
          to_ts: toTs,
          min_size: minSize,
          ...(hasCursor ? { cursor } : {}),
        }),
      );
    } catch (error) {
      console.warn(
        "marketDataWorker: failed to send an aggressive_history request",
        error,
      );
      failCurrentSocket(ws, "send-failed:aggressive_history");
    }
  } else if (msg.kind === "delta_profile") {
    const { request_id: requestId, from_ts: fromTs, to_ts: toTs, row_width: rowWidth, piece_ms: pieceMs } = msg;
    const hasPiece = Object.hasOwn(msg, "piece_ms");
    if (
      !hasExactKeys(msg, hasPiece ? ["from_ts", "kind", "piece_ms", "request_id", "row_width", "to_ts"] : ["from_ts", "kind", "request_id", "row_width", "to_ts"]) ||
      !isSafeIntegerValue(requestId) || requestId < 0 ||
      !isSafeIntegerValue(fromTs) || fromTs < 0 ||
      !isSafeIntegerValue(toTs) || toTs <= fromTs ||
      typeof rowWidth !== "number" || !Number.isFinite(rowWidth) || rowWidth <= 0 ||
      (hasPiece && (!isSafeIntegerValue(pieceMs) || pieceMs <= 0))
    ) {
      console.warn("marketDataWorker: dropped malformed delta_profile request");
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "delta_profile", request_id: requestId, from_ts: fromTs, to_ts: toTs, row_width: rowWidth, ...(hasPiece ? { piece_ms: pieceMs } : {}) }));
    } catch (error) {
      console.warn("marketDataWorker: failed to send a delta_profile request", error);
      failCurrentSocket(ws, "send-failed:delta_profile");
    }
  } else if (msg.kind === "band_history") {
    const {
      request_id: requestId,
      from_ts: fromTs,
      to_ts: toTs,
      price_lo: priceLo,
      price_hi: priceHi,
      column_ms: columnMs,
    } = msg;
    if (
      !hasExactKeys(msg, [
        "column_ms",
        "from_ts",
        "kind",
        "price_hi",
        "price_lo",
        "request_id",
        "to_ts",
      ]) ||
      !isSafeIntegerValue(requestId) ||
      requestId < 0 ||
      !isSafeIntegerValue(fromTs) ||
      fromTs < 0 ||
      !isSafeIntegerValue(toTs) ||
      toTs <= fromTs ||
      typeof priceLo !== "number" ||
      !Number.isFinite(priceLo) ||
      priceLo <= 0 ||
      typeof priceHi !== "number" ||
      !Number.isFinite(priceHi) ||
      priceHi < priceLo ||
      !isSafeIntegerValue(columnMs) ||
      columnMs <= 0
    ) {
      console.warn("marketDataWorker: dropped malformed band_history request");
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          type: "band_history",
          request_id: requestId,
          from_ts: fromTs,
          to_ts: toTs,
          price_lo: priceLo,
          price_hi: priceHi,
          column_ms: columnMs,
        }),
      );
    } catch (error) {
      console.warn(
        "marketDataWorker: failed to send a band_history request",
        error,
      );
      failCurrentSocket(ws, "send-failed:band_history");
    }
  } else if (msg.kind === "wall_history" || msg.kind === "l2_event_history") {
    const { request_id: requestId, from_ts: fromTs, to_ts: toTs, price_lo: priceLo, price_hi: priceHi } = msg;
    const withCursor = Object.hasOwn(msg, "cursor");
    if (
      !hasExactKeys(msg, withCursor ? ["cursor", "from_ts", "kind", "price_hi", "price_lo", "request_id", "to_ts"] : ["from_ts", "kind", "price_hi", "price_lo", "request_id", "to_ts"]) ||
      !isSafeIntegerValue(requestId) || requestId < 0 ||
      !isSafeIntegerValue(fromTs) || fromTs < 0 ||
      !isSafeIntegerValue(toTs) || toTs < fromTs ||
      typeof priceLo !== "number" || !Number.isFinite(priceLo) || priceLo <= 0 ||
      typeof priceHi !== "number" || !Number.isFinite(priceHi) || priceHi < priceLo ||
      (withCursor && (typeof msg.cursor !== "object" || msg.cursor === null))
    ) {
      console.warn(`marketDataWorker: dropped malformed ${msg.kind} request`);
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: msg.kind, request_id: requestId, from_ts: fromTs, to_ts: toTs, price_lo: priceLo, price_hi: priceHi, ...(withCursor ? { cursor: msg.cursor } : {}) }));
    } catch (error) {
      console.warn(`marketDataWorker: failed to send a ${msg.kind} request`, error);
      failCurrentSocket(ws, `send-failed:${msg.kind}`);
    }
  } else if (msg.kind === "heatmap_history") {
    const request = parseHeatmapHistoryRequest(msg);
    if (request === null) {
      console.warn("marketDataWorker: dropped malformed heatmap_history request");
      return;
    }
    const endpoint = heatmapHistoryUrl(url);
    if (endpoint === null) {
      postHeatmapHistory(request.request_id, null, true);
      return;
    }
    void fetchHeatmapHistory(request, endpoint);
  } else if (msg.kind === "heatmap_walls") {
    const request = parseHeatmapWallsRequest(msg);
    if (request === null) {
      console.warn("marketDataWorker: dropped malformed heatmap_walls request");
      return;
    }
    const endpoint = heatmapHistoryUrl(url, HEATMAP_WALLS_PATH);
    if (endpoint === null) {
      postHeatmapWalls(request.request_id, null, true);
      return;
    }
    void fetchHeatmapWalls(request, endpoint);
  } else if (msg.kind === "liquidity_resync") {
    if (!hasExactKeys(msg, ["kind"])) {
      console.warn(
        "marketDataWorker: dropped malformed liquidity_resync request",
      );
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "liquidity_resync" }));
    } catch (error) {
      console.warn(
        "marketDataWorker: failed to send a liquidity_resync request",
        error,
      );
      failCurrentSocket(ws, "send-failed:liquidity_resync");
    }
  } else if (msg.kind === "exhaustion_history") {
    const { from_ts: fromTs } = msg;
    if (!hasExactKeys(msg, ["from_ts", "kind"]) || !isSafeIntegerValue(fromTs) || fromTs < 0) {
      console.warn("marketDataWorker: dropped malformed exhaustion_history request");
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "exhaustion_history", from_ts: fromTs }));
    } catch (error) {
      console.warn("marketDataWorker: failed to send an exhaustion_history request", error);
      failCurrentSocket(ws, "send-failed:exhaustion_history");
    }
  } else if (msg.kind === "initiative_history") {
    const { from_ts: fromTs } = msg;
    if (!hasExactKeys(msg, ["from_ts", "kind"]) || !isSafeIntegerValue(fromTs) || fromTs < 0) {
      console.warn("marketDataWorker: dropped malformed initiative_history request");
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "initiative_history", from_ts: fromTs }));
    } catch (error) {
      console.warn("marketDataWorker: failed to send an initiative_history request", error);
      failCurrentSocket(ws, "send-failed:initiative_history");
    }
  } else if (msg.kind === "l2_resync") {
    if (!hasExactKeys(msg, ["channel", "kind"]) || typeof msg.channel !== "string" || !(L2_CHANNELS as readonly string[]).includes(msg.channel)) {
      console.warn("marketDataWorker: dropped malformed l2_resync request");
      return;
    }
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "l2_resync", channel: msg.channel }));
    } catch (error) {
      console.warn("marketDataWorker: failed to send an l2_resync request", error);
      failCurrentSocket(ws, "send-failed:l2_resync");
    }
  } else {
    console.warn("marketDataWorker: dropped unrecognized control message");
  }
};
