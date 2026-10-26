import type { BandHistoryFrame, BandHistoryReason } from "../../types/frames";
import type { LiquidityColumn } from "../indicators/passive-liquidity/liquidityGrid";
import type { ColumnFeed } from "../indicators/absorption-detector/absorptionColumns";
import type { HistoryIdentity, HistoryRequest } from "../indicators/passive-liquidity/heatmapHistory";
import { HISTORY_WINDOW_MS, type DecodedHistoryPage } from "../indicators/passive-liquidity/heatmapHistoryDecode";
import { COLUMN_HISTORY_MAX_IN_FLIGHT, InFlightPool, RequestBudget, type RequestShare } from "../indicators/passive-liquidity/requestBudget";
import { zoneRows } from "../indicators/institutional-order-blocks/institutionalRules";
import { inChartSession } from "./marketCalendar";

export const BAND_PIECE_MAX_MS = 2 * 60 * 60 * 1000;
export const BAND_MAX_CELLS = 100_000;
export const BAND_MAX_ROWS = 256;
export const BAND_COLUMN_MS = 10_000;
export const BAND_RETRY_MS = 60_000;
const BAND_RETRY_MAX_ATTEMPTS = 3;
export const BAND_GIVE_UP_MS = 10 * 60 * 1000;
export const BAND_PENDING_MS = 90_000;
export const MAX_BAND_ENTRIES = 256;
export const BAND_HOST_MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
export const BAND_HOST_LAG_MS = 15 * 60 * 1000;
export const BAND_COLUMN_ID_BASE = 2 ** 32;
export const BAND_COLUMN_ID_SPAN = 2 ** 30;
export const BAND_COLUMN_MAX_PER_MINUTE = 60;
export const BAND_COLUMN_RETRY_MS = 30_000;
export const BAND_COLUMN_MAX_ATTEMPTS = 3;
const BAND_HOST_LEVELS: readonly { upTo: number; levelMs: number }[] = [
  { upTo: 2 * 60 * 60 * 1000, levelMs: 10_000 },
  { upTo: 6 * 60 * 60 * 1000, levelMs: 30_000 },
];
const BAND_HOST_COARSEST_MS = 60_000;
export const BAND_FLOW_LEVEL_MS = 60_000;

export type BandReach = "band" | "mid" | "flow";

export interface BandHistoryWant {
  key: string;
  fromTs: number;
  toTs: number;
  priceLo: number;
  priceHi: number;
  columnMs: number;
  reach?: BandReach;
}

export interface BandHistoryRequest {
  request_id: number;
  from_ts: number;
  to_ts: number;
  price_lo: number;
  price_hi: number;
  column_ms: number;
}

export interface BandHistoryGap {
  from: number;
  to: number;
}

export interface BandColumnSource {
  request(request: HistoryRequest): void;
  identity(): HistoryIdentity | null;
}

interface Piece {
  from: number;
  to: number;
  columns: BandHistoryFrame["columns"] | null;
  answeredTo: number | null;
}

interface Pending {
  key: string;
  piece: Piece;
  from: number;
  to: number;
  sentAt: number;
}

interface HostFill {
  levelMs: number;
  first: number;
  last: number;
  answered: Set<number>;
  columns: Map<number, LiquidityColumn>;
  rowWidth: number | null;
  attempts: number;
  retryAt: number;
}

interface Asked {
  id: number;
  key: string;
  identity: HistoryIdentity;
  levelMs: number;
  from: number;
  to: number;
  sentAt: number;
}

const FINAL_REASONS: ReadonlySet<BandHistoryReason> = new Set(["BAND_TOO_WIDE", "BAD_REQUEST"]);

export interface BandHistoryEntry {
  readonly want: BandHistoryWant;
  rowWidth: number | null;
  rowLo: number | null;
  rowHi: number | null;
  columnMs: number;
  columns: LiquidityColumn[];
  gaps: BandHistoryGap[];
  complete: boolean;
  older: boolean;
  reason: BandHistoryReason | "NO_REPLY" | null;
  attempts: number;
  retryAt: number;
  pieces: Piece[];
  host: HostFill | null;
}

export function bandColumnMsFor(rows: number, pieceMs = BAND_PIECE_MAX_MS, columnMs = BAND_COLUMN_MS): number {
  const needed = Math.ceil((rows * pieceMs) / BAND_MAX_CELLS / 1000) * 1000;
  return Math.max(columnMs, needed);
}

export function bandLevelMsFor(spanMs: number): number {
  for (const { upTo, levelMs } of BAND_HOST_LEVELS) if (spanMs <= upTo) return levelMs;
  return BAND_HOST_COARSEST_MS;
}

export function bandKeyOf(fromTs: number, toTs: number, priceLo: number, priceHi: number): string {
  return `${fromTs}:${toTs}:${priceLo}:${priceHi}`;
}

export function ownsBandColumnId(requestId: number): boolean {
  return requestId >= BAND_COLUMN_ID_BASE && requestId < BAND_COLUMN_ID_BASE + BAND_COLUMN_ID_SPAN;
}

let columnIdSeq = 0;

function nextColumnId(): number {
  const id = BAND_COLUMN_ID_BASE + columnIdSeq;
  columnIdSeq = (columnIdSeq + 1) % BAND_COLUMN_ID_SPAN;
  return id;
}

function windowOf(ts: number): number {
  return Math.floor(ts / HISTORY_WINDOW_MS) * HISTORY_WINDOW_MS;
}

function reachOf(want: BandHistoryWant): BandReach {
  return want.reach ?? "band";
}

function hostFillOf(want: BandHistoryWant): HostFill {
  return {
    levelMs: reachOf(want) === "flow" ? BAND_FLOW_LEVEL_MS : bandLevelMsFor(want.toTs - want.fromTs),
    first: windowOf(want.fromTs),
    last: windowOf(want.toTs),
    answered: new Set(),
    columns: new Map(),
    rowWidth: null,
    attempts: 0,
    retryAt: 0,
  };
}

function firstMissing(fill: HostFill): number | null {
  for (let ts = fill.first; ts <= fill.last; ts += HISTORY_WINDOW_MS) if (!fill.answered.has(ts)) return ts;
  return null;
}

function piecesOf(fromTs: number, toTs: number, columnMs: number): Piece[] {
  const pieces: Piece[] = [];
  let to = toTs;
  while (to > fromTs) {
    const from = Math.max(fromTs, to - BAND_PIECE_MAX_MS);
    pieces.push({ from, to, columns: null, answeredTo: null });
    if (from === fromTs) break;
    to = from + columnMs;
  }
  return pieces;
}

export type IndicatorBandHistory = Pick<BandHistoryStore, "feedFor" | "older" | "version">;

export class BandHistoryStore {
  private readonly _columns: BandColumnSource | null;
  private _entries = new Map<string, BandHistoryEntry>();
  private _pending = new Map<number, Pending>();
  private _asked: Asked | null = null;
  private readonly _budget: RequestShare;
  private readonly _pool: InFlightPool;
  private _hostOffUntil = 0;
  private _seq = 0;
  private _version = 0;

  constructor({ columns = null, budget = new RequestBudget(BAND_COLUMN_MAX_PER_MINUTE).share(), pool = new InFlightPool(COLUMN_HISTORY_MAX_IN_FLIGHT) }: { columns?: BandColumnSource | null; budget?: RequestShare; pool?: InFlightPool } = {}) {
    this._columns = columns;
    this._budget = budget;
    this._pool = pool;
  }

  get budget(): RequestShare {
    return this._budget;
  }

  get version(): number {
    return this._version;
  }

  get size(): number {
    return this._entries.size;
  }

  want(want: BandHistoryWant): BandHistoryEntry {
    const existing = this._entries.get(want.key);
    if (existing) {
      if (existing.want.fromTs === want.fromTs && existing.want.toTs === want.toTs &&
          existing.want.priceLo === want.priceLo && existing.want.priceHi === want.priceHi &&
          existing.want.columnMs === want.columnMs && reachOf(existing.want) === reachOf(want)) return existing;
      this.forget(want.key);
    }
    if (this._entries.size >= MAX_BAND_ENTRIES) {
      const oldest = this._entries.keys().next().value as string;
      this.forget(oldest);
    }
    const older = this._columns !== null && want.toTs - want.fromTs > BAND_HOST_MAX_SPAN_MS;
    const entry: BandHistoryEntry = {
      want, rowWidth: null, rowLo: null, rowHi: null, columnMs: want.columnMs, columns: [], gaps: [], complete: false, older, reason: null, attempts: 0, retryAt: 0,
      pieces: piecesOf(want.fromTs, want.toTs, want.columnMs),
      host: this._columns === null || older ? null : hostFillOf(want),
    };
    this._entries.set(want.key, entry);
    if (older) this._version += 1;
    return entry;
  }

  keepOnly(keys: ReadonlySet<string>): void {
    for (const key of [...this._entries.keys()]) if (!keys.has(key)) this.forget(key);
  }

  forget(key: string): void {
    if (!this._entries.delete(key)) return;
    for (const [id, pending] of this._pending) if (pending.key === key) this._pending.delete(id);
    this._version += 1;
  }

  get(key: string): BandHistoryEntry | null {
    return this._entries.get(key) ?? null;
  }

  get pending(): number {
    return this._pending.size;
  }

  older(key: string): boolean {
    return this._entries.get(key)?.older === true;
  }

  nextRequest(nowMs: number): BandHistoryRequest | null {
    this._askColumns(nowMs);
    for (const [id, pending] of this._pending) {
      if (nowMs - pending.sentAt < BAND_PENDING_MS) return null;
      this._pending.delete(id);
      const entry = this._entries.get(pending.key);
      if (entry !== undefined) failed(entry, "NO_REPLY", null, nowMs);
    }
    for (const [key, entry] of this._entries) {
      if (entry.complete || entry.older || entry.host !== null || reachOf(entry.want) !== "band" || entry.retryAt > nowMs) continue;
      for (const piece of entry.pieces) {
        if (piece.columns !== null) continue;
        const to = Math.min(piece.to, nowMs);
        if (to <= piece.from) continue;
        this._seq += 1;
        this._pending.set(this._seq, { key, piece, from: piece.from, to, sentAt: nowMs });
        return { request_id: this._seq, from_ts: piece.from, to_ts: to, price_lo: entry.want.priceLo, price_hi: entry.want.priceHi, column_ms: entry.want.columnMs };
      }
    }
    return null;
  }

  dropPending(): void {
    this._pending.clear();
  }

  private _askColumns(nowMs: number): void {
    const source = this._columns;
    if (source === null) return;
    const identity = source.identity();
    if (identity === null || nowMs < this._hostOffUntil) {
      for (const entry of this._entries.values()) if (reachOf(entry.want) === "band") entry.host = null;
      return;
    }
    const asked = this._asked;
    if (asked !== null) {
      if (nowMs - asked.sentAt < BAND_PENDING_MS) return;
      this._asked = null;
      this._pool.free();
      const entry = this._entries.get(asked.key);
      if (entry !== undefined) hostFailed(entry, nowMs);
    }
    if (!this._budget.left(nowMs) || !this._pool.left()) return;
    let next: { key: string; fill: HostFill; from: number; toTs: number } | null = null;
    for (const [key, entry] of this._entries) {
      const fill = entry.host;
      if (fill === null || fill.retryAt > nowMs || (next !== null && entry.want.toTs <= next.toTs)) continue;
      const from = firstMissing(fill);
      if (from !== null) next = { key, fill, from, toTs: entry.want.toTs };
    }
    if (next === null) return;
    const { key, fill, from } = next;
    let to = from + HISTORY_WINDOW_MS;
    while (to <= fill.last && !fill.answered.has(to)) to += HISTORY_WINDOW_MS;
    const id = nextColumnId();
    this._asked = { id, key, identity, levelMs: fill.levelMs, from, to, sentAt: nowMs };
    this._budget.take(nowMs);
    this._pool.take();
    source.request({ requestId: id, identity, levelMs: fill.levelMs, rowFactor: 1, fromTs: from, toTs: to });
  }

  acceptColumns(requestId: number, page: DecodedHistoryPage | null, nowMs: number): boolean {
    const asked = this._asked;
    if (asked === null || asked.id !== requestId) return false;
    this._asked = null;
    this._pool.free();
    const before = this._version;
    const mine = this._entries.get(asked.key) ?? null;
    if (page === null) {
      if (mine !== null) hostFailed(mine, nowMs);
    } else if (!page.available) {
      this._hostOffUntil = nowMs + BAND_GIVE_UP_MS;
    } else if (page.levelMs !== asked.levelMs || page.rowFactor !== 1 ||
        (page.next !== null && (page.next <= asked.from || page.next % HISTORY_WINDOW_MS !== 0))) {
      if (mine !== null) hostFailed(mine, nowMs);
    } else {
      if (mine !== null && mine.host !== null) mine.host.attempts = 0;
      const end = page.next !== null && page.next < asked.to ? page.next : asked.to;
      const inSession = (ts: number) => inChartSession(asked.identity.provider === "DXFEED" ? { assetClass: asked.identity.marketKind } : {}, ts);
      let changed = false;
      for (const entry of this._entries.values()) {
        if (entry.host !== null && absorb(entry, page, asked.from, end, nowMs, entry === mine, inSession)) changed = true;
      }
      if (changed) this._version += 1;
    }
    this._askColumns(nowMs);
    return this._version !== before;
  }

  put(frame: BandHistoryFrame, nowMs: number): boolean {
    const pending = this._pending.get(frame.request_id);
    if (pending === undefined) return false;
    const entry = this._entries.get(pending.key);
    if (entry === undefined) return false;
    if (frame.from_ts !== pending.from || frame.to_ts !== pending.to || frame.column_ms !== entry.want.columnMs ||
        frame.price_lo !== entry.want.priceLo || frame.price_hi !== entry.want.priceHi ||
        frame.columns.some((column) => column.ts < pending.from || column.ts > pending.to || column.ts % entry.want.columnMs !== 0) ||
        (frame.complete && entry.rowWidth !== null &&
          (frame.row_width !== entry.rowWidth || frame.row_lo !== entry.rowLo || frame.row_hi !== entry.rowHi))) return false;
    this._pending.delete(frame.request_id);
    if (!frame.complete) {
      if (frame.reason === "READ_TIMEOUT" && pending.to - pending.from > Math.max(60_000, entry.want.columnMs * 2)) {
        const middle = Math.floor((pending.from + (pending.to - pending.from) / 2) / entry.want.columnMs) * entry.want.columnMs;
        const index = entry.pieces.indexOf(pending.piece);
        if (index >= 0 && middle > pending.from && middle < pending.to) {
          entry.pieces.splice(index, 1,
            { from: middle, to: pending.piece.to, columns: null, answeredTo: null },
            { from: pending.piece.from, to: middle + entry.want.columnMs, columns: null, answeredTo: null });
          entry.reason = "READ_TIMEOUT";
          entry.attempts = 0;
          entry.retryAt = nowMs + 1_000;
          return true;
        }
      }
      failed(entry, frame.reason as BandHistoryReason, frame.retry_after_ms, nowMs);
      return true;
    }
    entry.reason = null;
    entry.attempts = 0;
    entry.rowWidth = frame.row_width;
    entry.rowLo = frame.row_lo;
    entry.rowHi = frame.row_hi;
    pending.piece.columns = frame.columns;
    pending.piece.answeredTo = pending.to;
    if (entry.pieces.every((piece) => piece.columns !== null)) {
      assemble(entry);
      this._version += 1;
    }
    return true;
  }

  feedFor(key: string): { feed: ColumnFeed; rowWidth: number; gaps: readonly BandHistoryGap[] } | null {
    const entry = this._entries.get(key);
    if (entry === undefined || !entry.complete || entry.rowWidth === null) return null;
    return { feed: { epoch: this._version, deep: null, fine: { columns: entry.columns, columnMs: entry.columnMs } }, rowWidth: entry.rowWidth, gaps: entry.gaps };
  }
}

function failed(entry: BandHistoryEntry, reason: BandHistoryReason | "NO_REPLY", retryAfterMs: number | null, nowMs: number): void {
  entry.reason = reason;
  entry.attempts = reason !== "NO_REPLY" && FINAL_REASONS.has(reason) ? BAND_RETRY_MAX_ATTEMPTS : entry.attempts + 1;
  const wait = retryAfterMs ?? (entry.attempts >= BAND_RETRY_MAX_ATTEMPTS ? BAND_GIVE_UP_MS : BAND_RETRY_MS * 2 ** (entry.attempts - 1));
  entry.retryAt = nowMs + wait;
}

function fallBack(entry: BandHistoryEntry, nowMs: number): void {
  const fill = entry.host;
  if (fill === null) return;
  if (reachOf(entry.want) === "band") {
    entry.host = null;
    return;
  }
  fill.attempts = 0;
  fill.retryAt = nowMs + BAND_GIVE_UP_MS;
}

function hostFailed(entry: BandHistoryEntry, nowMs: number): void {
  const fill = entry.host;
  if (fill === null) return;
  fill.attempts += 1;
  if (fill.attempts >= BAND_COLUMN_MAX_ATTEMPTS) fallBack(entry, nowMs);
  else fill.retryAt = nowMs + BAND_COLUMN_RETRY_MS * 2 ** (fill.attempts - 1);
}

function bestRows(column: LiquidityColumn): number[] {
  const rows: number[] = [];
  for (let i = column.bid.length - 1; i >= 0; i -= 1) {
    if (column.bid[i] > 0) {
      rows.push(column.lo + i);
      break;
    }
  }
  for (let i = 0; i < column.ask.length; i += 1) {
    if (column.ask[i] > 0) {
      rows.push(column.lo + i);
      break;
    }
  }
  return rows;
}

function trim(column: LiquidityColumn, rowLo: number, rowHi: number, reach: BandReach): LiquidityColumn {
  if (reach === "flow") return { ts: column.ts, lo: rowLo, hi: rowLo, bid: new Float64Array(1), ask: new Float64Array(1), buy: column.buy ?? [], sell: column.sell ?? [] };
  const best = reach === "mid" ? bestRows(column) : [];
  const lo = Math.min(rowLo, ...best);
  const hi = Math.max(rowHi, ...best);
  const rows = hi - lo + 1;
  const bid = new Float64Array(rows);
  const ask = new Float64Array(rows);
  for (let row = Math.max(lo, column.lo); row <= Math.min(hi, column.hi); row += 1) {
    bid[row - lo] = column.bid[row - column.lo];
    ask[row - lo] = column.ask[row - column.lo];
  }
  if (reach === "mid") return { ts: column.ts, lo, hi, bid, ask, buy: column.buy ?? [], sell: column.sell ?? [] };
  const inZone = ([row]: readonly [number, number]) => row >= rowLo && row <= rowHi;
  return { ts: column.ts, lo, hi, bid, ask, buy: (column.buy ?? []).filter(inZone), sell: (column.sell ?? []).filter(inZone) };
}

function absorb(entry: BandHistoryEntry, page: DecodedHistoryPage & { available: true }, from: number, end: number, nowMs: number, asker: boolean, inSession: (ts: number) => boolean): boolean {
  let fill = entry.host as HostFill;
  const { oldest, newest } = page.span;
  if (oldest === null || newest === null) {
    fallBack(entry, nowMs);
    return false;
  }
  if (fill.first < oldest) {
    entry.older = true;
    entry.host = null;
    return true;
  }
  if (fill.levelMs !== page.levelMs) return false;
  const rows = zoneRows(entry.want.priceHi, entry.want.priceLo, page.rowWidth);
  if (rows === null) {
    fallBack(entry, nowMs);
    return false;
  }
  if (fill.rowWidth !== null && fill.rowWidth !== page.rowWidth) {
    fill = hostFillOf(entry.want);
    entry.host = fill;
  }
  fill.rowWidth = page.rowWidth;
  const windows = new Map(page.windows.map((window) => [window.ts, window]));
  for (let ts = Math.max(from, fill.first); ts < end && ts <= fill.last; ts += HISTORY_WINDOW_MS) {
    if (fill.answered.has(ts)) continue;
    const window = windows.get(ts);
    if (window === undefined && ts > newest) continue;
    for (const column of window?.columns ?? []) {
      if (column.ts >= entry.want.fromTs && column.ts <= entry.want.toTs) fill.columns.set(column.ts, trim(column, rows.rowLo, rows.rowHi, reachOf(entry.want)));
    }
    fill.answered.add(ts);
  }
  const missing = firstMissing(fill);
  if (missing === null) {
    const columns = fill.columns;
    entry.rowWidth = page.rowWidth;
    entry.rowLo = rows.rowLo;
    entry.rowHi = reachOf(entry.want) === "flow" ? rows.rowLo : rows.rowHi;
    entry.columnMs = fill.levelMs;
    entry.host = null;
    lay(entry, fill.levelMs, entry.want.toTs, (ts) => columns.get(ts), inSession);
    return true;
  }
  if (asker && missing >= from && missing < end) {
    if (missing + HISTORY_WINDOW_MS + BAND_HOST_LAG_MS < nowMs) fallBack(entry, nowMs);
    else fill.retryAt = Math.max(nowMs + BAND_RETRY_MS, fill.last + HISTORY_WINDOW_MS);
  }
  return false;
}

function lay(entry: BandHistoryEntry, columnMs: number, toTs: number, columnAt: (ts: number) => LiquidityColumn | undefined, counts: (ts: number) => boolean): void {
  const rowLo = entry.rowLo as number;
  const rowHi = entry.rowHi as number;
  const rows = rowHi - rowLo + 1;
  const columns: LiquidityColumn[] = [];
  const gaps: BandHistoryGap[] = [];
  let gapStart: number | null = null;
  for (let ts = Math.ceil(entry.want.fromTs / columnMs) * columnMs; ts <= toTs; ts += columnMs) {
    const received = columnAt(ts);
    if (received === undefined && counts(ts)) {
      if (gapStart === null) gapStart = ts - columnMs;
    } else if (gapStart !== null) {
      gaps.push({ from: gapStart, to: ts - columnMs });
      gapStart = null;
    }
    columns.push(received ?? { ts, lo: rowLo, hi: rowHi, bid: new Float64Array(rows), ask: new Float64Array(rows), buy: [], sell: [] });
  }
  if (gapStart !== null) gaps.push({ from: gapStart, to: toTs });
  entry.columns = columns;
  entry.gaps = gaps;
  entry.complete = true;
}

function assemble(entry: BandHistoryEntry): void {
  const toTs = Math.min(entry.want.toTs, Math.max(...entry.pieces.map((piece) => piece.answeredTo ?? -Infinity)));
  const rowLo = entry.rowLo as number;
  const rowHi = entry.rowHi as number;
  const rows = rowHi - rowLo + 1;
  const byTs = new Map<number, BandHistoryFrame["columns"][number]>();
  for (const piece of entry.pieces) for (const column of piece.columns ?? []) byTs.set(column.ts, column);
  lay(entry, entry.want.columnMs, toTs, (ts) => {
    const received = byTs.get(ts);
    if (received === undefined) return undefined;
    const bid = new Float64Array(rows);
    const ask = new Float64Array(rows);
    for (let i = 0; i < rows; i += 1) {
      bid[i] = received.bid[i];
      ask[i] = received.ask[i];
    }
    return {
      ts, lo: rowLo, hi: rowHi, bid, ask,
      buy: received.buy.flatMap((volume, i) => (volume > 0 ? [[rowLo + i, volume] as const] : [])),
      sell: received.sell.flatMap((volume, i) => (volume > 0 ? [[rowLo + i, volume] as const] : [])),
    };
  }, () => true);
  for (const piece of entry.pieces) piece.columns = null;
}
