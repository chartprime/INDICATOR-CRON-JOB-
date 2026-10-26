import type { AggressiveHistoryReason } from "../../../types/frames";
import { nextAggressiveHistoryRequestId } from "../aggressive-orders/aggressiveTape";

export const RANGE_ASK_MAX_MS = 6 * 60 * 60 * 1000;
export const RANGE_ASK_DELAY_MS = 5_000;
export const RANGE_PENDING_MS = 30_000;
export const RANGE_RETRY_MS = 10_000;
export const RANGE_RETRY_MAX_ATTEMPTS = 3;
export const RANGE_GIVE_UP_MS = 10 * 60 * 1000;
export const RANGE_POLL_MS = 1_000;
export const RANGE_WARM_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PAGES_PER_ASK = 20;
export const MAX_RECORDED_PRINTS = 1_000_000;
export const MAX_LIVE_PRINTS = 200_000;
export const RANGE_ASK_BUDGET = 40;
export const RANGE_ASK_BUDGET_MS = 60_000;

export interface RangePrintRequest {
  request_id: number;
  from_ts: number;
  to_ts: number;
  min_size: number;
  cursor?: string;
}

export interface RangePrintReply {
  request_id: number;
  from_ts: number;
  to_ts: number;
  min_size: number;
  reason: AggressiveHistoryReason | null;
  next_cursor: string | null;
  retry_after_ms: number | null;
}

export interface RangePrint {
  ts_exchange: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}

export interface LivePrint {
  ts: number;
  size: number;
  buy: boolean;
}

export interface Interval {
  from: number;
  to: number;
}

export interface RangePrintTally {
  buyCount: number;
  buyVolume: number;
  sellCount: number;
  sellVolume: number;
}

export interface RangePrintsRead extends RangePrintTally {
  gaps: Interval[];
  loading: boolean;
}

export type RangePrintCoverage = Pick<RangePrintsRead, "gaps" | "loading">;

export interface CandleSlot {
  ts_open: number;
  interval_ms: number;
}

export interface RangePrintCandlesRead extends RangePrintsRead {
  candles: Map<number, RangePrintTally>;
}

export interface RangePrintLimits {
  maxRecorded?: number;
  maxLive?: number;
}

interface Piece extends RangePrintTally, Interval {
  ts: Float64Array;
  size: Float64Array;
  buy: Uint8Array;
}

interface Pending extends Interval {
  requestId: number;
  cursor: string | null;
  pages: RangePrint[][];
  sent: boolean;
  sentAt: number;
}

interface GivenUp extends Interval {
  until: number;
}

export function gapsOf(covered: readonly Interval[], from: number, to: number): Interval[] {
  const gaps: Interval[] = [];
  let cursor = from;
  for (const span of [...covered].sort((a, b) => a.from - b.from)) {
    if (span.to <= cursor) continue;
    if (span.from >= to) break;
    if (span.from > cursor) gaps.push({ from: cursor, to: span.from });
    cursor = span.to;
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

export function nextAsk(open: readonly Interval[], focus: Interval | null): Interval | null {
  const newestOf = (spans: readonly Interval[]): Interval | null => {
    const span = spans[spans.length - 1];
    return span === undefined ? null : { from: Math.max(span.from, span.to - RANGE_ASK_MAX_MS), to: span.to };
  };
  if (focus === null) return newestOf(open);
  const inside = open.map((span) => ({ from: Math.max(span.from, focus.from), to: Math.min(span.to, focus.to) })).filter((span) => span.to > span.from);
  if (inside.length > 0) return newestOf(inside);
  const after = open.map((span) => ({ from: Math.max(span.from, focus.to), to: span.to })).filter((span) => span.to > span.from);
  if (after.length > 0) return { from: after[0].from, to: Math.min(after[0].to, after[0].from + RANGE_ASK_MAX_MS) };
  return newestOf(open);
}

function emptyTally(): RangePrintTally {
  return { buyCount: 0, buyVolume: 0, sellCount: 0, sellVolume: 0 };
}

function firstAtOrAfter(ts: Float64Array, value: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function addPrint(tally: RangePrintTally, buy: boolean, size: number): void {
  if (buy) {
    tally.buyCount += 1;
    tally.buyVolume += size;
  } else {
    tally.sellCount += 1;
    tally.sellVolume += size;
  }
}

function addPiece(tally: RangePrintTally, piece: Piece, from: number, to: number, floor: number, whole: boolean): void {
  if (piece.to <= from || piece.from >= to) return;
  if (whole && piece.from >= from && piece.to <= to) {
    tally.buyCount += piece.buyCount;
    tally.buyVolume += piece.buyVolume;
    tally.sellCount += piece.sellCount;
    tally.sellVolume += piece.sellVolume;
    return;
  }
  const end = firstAtOrAfter(piece.ts, to);
  for (let i = firstAtOrAfter(piece.ts, from); i < end; i += 1) {
    if (piece.size[i] >= floor) addPrint(tally, piece.buy[i] === 1, piece.size[i]);
  }
}

function slotAtOrBefore(slots: readonly CandleSlot[], ts: number): number {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (slots[mid].ts_open <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function candleAt(slots: readonly CandleSlot[], ts: number): number | null {
  const index = slotAtOrBefore(slots, ts);
  if (index < 0) return null;
  const slot = slots[index];
  return ts < slot.ts_open + slot.interval_ms ? slot.ts_open : null;
}

export function addCandlePrint(candles: Map<number, RangePrintTally>, tsOpen: number, buy: boolean, size: number): void {
  let tally = candles.get(tsOpen);
  if (tally === undefined) {
    tally = emptyTally();
    candles.set(tsOpen, tally);
  }
  addPrint(tally, buy, size);
}

function addPieceCandles(candles: Map<number, RangePrintTally>, piece: Piece, from: number, to: number, floor: number, slots: readonly CandleSlot[]): void {
  if (piece.to <= from || piece.from >= to) return;
  const start = firstAtOrAfter(piece.ts, from);
  const end = firstAtOrAfter(piece.ts, to);
  if (start >= end) return;
  let index = slotAtOrBefore(slots, piece.ts[start]);
  for (let i = start; i < end; i += 1) {
    const ts = piece.ts[i];
    while (index + 1 < slots.length && slots[index + 1].ts_open <= ts) index += 1;
    if (index < 0) continue;
    const slot = slots[index];
    if (ts >= slot.ts_open + slot.interval_ms || piece.size[i] < floor) continue;
    addCandlePrint(candles, slot.ts_open, piece.buy[i] === 1, piece.size[i]);
  }
}

function pieceOf(pending: Pending): Piece {
  const prints = pending.pages.flat().sort((a, b) => a.ts_exchange - b.ts_exchange);
  const piece: Piece = {
    from: pending.from,
    to: pending.to,
    ts: Float64Array.from(prints, (print) => print.ts_exchange),
    size: Float64Array.from(prints, (print) => print.size),
    buy: Uint8Array.from(prints, (print) => (print.side === "buy" ? 1 : 0)),
    ...emptyTally(),
  };
  for (const print of prints) addPrint(piece, print.side === "buy", print.size);
  return piece;
}

export class RangePrintStore {
  private readonly _maxRecorded: number;
  private readonly _maxLive: number;
  private _floor: number | null = null;
  private _window: Interval | null = null;
  private _focus: Interval | null = null;
  private _pieces: Piece[] = [];
  private _liveTs: number[] = [];
  private _liveSize: number[] = [];
  private _liveBuy: boolean[] = [];
  private _liveFrom: number | null = null;
  private _clockCut = false;
  private _cutSetAt = 0;
  private _sentAt: number[] = [];
  private _lastSeen: number | null = null;
  private _pending: Pending | null = null;
  private _failures = 0;
  private _retryAt = 0;
  private _givenUp: GivenUp[] = [];
  private _full = false;
  private _issue: AggressiveHistoryReason | null = null;
  private _version = 0;
  private readonly _listeners = new Set<() => void>();
  private readonly _liveListeners = new Set<(print: LivePrint) => void>();

  constructor({ maxRecorded = MAX_RECORDED_PRINTS, maxLive = MAX_LIVE_PRINTS }: RangePrintLimits = {}) {
    this._maxRecorded = maxRecorded;
    this._maxLive = maxLive;
  }

  get version(): number {
    return this._version;
  }

  get floor(): number | null {
    return this._floor;
  }

  get liveFrom(): number | null {
    return this._liveFrom;
  }

  get issue(): AggressiveHistoryReason | null {
    return this._issue;
  }

  get pending(): boolean {
    return this._pending !== null && this._pending.sent;
  }

  get recordedCount(): number {
    let count = 0;
    for (const piece of this._pieces) count += piece.ts.length;
    return count;
  }

  get liveCount(): number {
    return this._liveTs.length;
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  subscribeLive(listener: (print: LivePrint) => void): () => void {
    this._liveListeners.add(listener);
    return () => {
      this._liveListeners.delete(listener);
    };
  }

  owns(requestId: number): boolean {
    return this._pending !== null && this._pending.sent && this._pending.requestId === requestId;
  }

  markSeen(ts: number): void {
    if (Number.isFinite(ts)) this._lastSeen = this._lastSeen === null ? ts : Math.max(this._lastSeen, ts);
  }

  setWant(want: { from: number; to: number; floor: number; focus?: Interval }, nowMs: number): void {
    const from = Math.floor(want.from);
    const to = Math.ceil(want.to);
    if (!(want.floor > 0) || !Number.isFinite(want.floor) || !(to > from)) return;
    const focus = want.focus === undefined ? null : { from: Math.floor(want.focus.from), to: Math.ceil(want.focus.to) };
    this._focus = focus !== null && focus.to > focus.from ? focus : null;
    let changed = false;
    if (this._floor === null) this._floor = want.floor;
    if (this._liveFrom === null) {
      this._liveFrom = this._lastSeen === null ? nowMs : this._lastSeen + 1;
      this._clockCut = this._lastSeen === null;
      this._cutSetAt = nowMs;
      changed = true;
    }
    if (this._window === null || this._window.from !== from || this._window.to !== to) {
      this._window = { from, to };
      this._full = false;
      this._evict();
    }
    if (changed) this._changed();
  }

  dropWant(): void {
    this._window = null;
  }

  addTrade(trade: RangePrint): boolean {
    this.markSeen(trade.ts_exchange);
    const floor = this._floor;
    if (floor === null || this._liveFrom === null || trade.ts_exchange < this._liveFrom || !(trade.size >= floor)) return false;
    this._liveTs.push(trade.ts_exchange);
    this._liveSize.push(trade.size);
    this._liveBuy.push(trade.side === "buy");
    if (this._liveTs.length > this._maxLive) this._handOverOldest();
    const print = { ts: trade.ts_exchange, size: trade.size, buy: trade.side === "buy" };
    for (const listener of this._liveListeners) listener(print);
    return true;
  }

  reanchor(): void {
    this._clearLive();
    this._liveFrom = null;
    this._lastSeen = null;
    this._pending = null;
    this._failures = 0;
    this._retryAt = 0;
    this._changed();
  }

  lost(requestId: number): void {
    if (this.owns(requestId)) (this._pending as Pending).sent = false;
  }

  gaps(): Interval[] {
    const window = this._window;
    if (window === null || this._liveFrom === null) return [];
    const to = Math.min(window.to, this._liveFrom);
    return to > window.from ? gapsOf(this._pieces, window.from, to) : [];
  }

  nextRequest(nowMs: number): RangePrintRequest | null {
    const floor = this._floor;
    if (floor === null || this._window === null || this._liveFrom === null) return null;
    const pending = this._pending;
    if (pending !== null && pending.sent) {
      if (nowMs - pending.sentAt <= RANGE_PENDING_MS) return null;
      this._fail(pending, nowMs, "READ_FAILED", null);
      return null;
    }
    if (nowMs < this._retryAt || nowMs < this._cutSetAt + RANGE_ASK_DELAY_MS) return null;
    if (this._clockCut && this._lastSeen !== null && this._lastSeen < this._liveFrom) return null;
    this._sentAt = this._sentAt.filter((at) => nowMs - at < RANGE_ASK_BUDGET_MS);
    if (this._sentAt.length >= RANGE_ASK_BUDGET) return null;
    if (pending !== null) return this._send(pending, floor, nowMs);
    if (this._full) return null;
    const blocked = this._blocked(nowMs);
    const ask = nextAsk(this.gaps().flatMap((gap) => gapsOf(blocked, gap.from, gap.to)), this._focus);
    if (ask === null) return null;
    const next: Pending = { from: ask.from, to: ask.to, requestId: 0, cursor: null, pages: [], sent: false, sentAt: 0 };
    this._pending = next;
    return this._send(next, floor, nowMs);
  }

  put(reply: RangePrintReply, trades: readonly RangePrint[], nowMs: number): boolean {
    const pending = this._pending;
    if (pending === null || !this.owns(reply.request_id)) return false;
    if (reply.from_ts !== pending.from || reply.to_ts !== pending.to || reply.min_size !== this._floor) return false;
    if (reply.reason === "OVERLOADED" && reply.retry_after_ms !== null) {
      pending.sent = false;
      this._retryAt = nowMs + reply.retry_after_ms;
      return true;
    }
    if (reply.reason === "STORAGE_UNAVAILABLE" || reply.reason === "READ_FAILED" || reply.reason === "OVERLOADED") {
      this._fail(pending, nowMs, reply.reason, reply.retry_after_ms);
      return true;
    }
    if (reply.reason === "CONVERSION_INCOMPLETE" || (reply.reason === "CAP_REACHED" && reply.next_cursor === null)) {
      this._giveUp(pending, nowMs, "CONVERSION_INCOMPLETE");
      return true;
    }
    const floor = this._floor as number;
    pending.pages.push(trades.filter((trade) => trade.size >= floor && trade.ts_exchange >= pending.from && trade.ts_exchange < pending.to));
    if (reply.reason === "CAP_REACHED") {
      if (pending.pages.length >= MAX_PAGES_PER_ASK) {
        this._giveUp(pending, nowMs, "CAP_REACHED");
        return true;
      }
      pending.cursor = reply.next_cursor;
      pending.sent = false;
      this._failures = 0;
      return true;
    }
    const piece = pieceOf(pending);
    this._pieces = [...this._pieces, piece].sort((a, b) => a.from - b.from);
    this._pending = null;
    this._failures = 0;
    this._retryAt = 0;
    this._issue = null;
    this._evict();
    this._changed();
    return true;
  }

  coverage(from: number, to: number, floor: number, nowMs: number): RangePrintCoverage | null {
    if (!(to > from)) return null;
    const fetched = this._floor;
    if (fetched === null || floor < fetched) return { gaps: [{ from, to }], loading: true };
    const covered = this._liveFrom === null ? this._pieces : [...this._pieces, { from: this._liveFrom, to: Infinity }];
    const gaps = gapsOf(covered, from, to);
    const blocked = this._blocked(nowMs);
    const loading = !this._full && gaps.some((gap) => gapsOf(blocked, gap.from, gap.to).length > 0);
    return { gaps, loading };
  }

  read(from: number, to: number, floor: number, nowMs: number): RangePrintsRead | null {
    const coverage = this.coverage(from, to, floor, nowMs);
    if (coverage === null) return null;
    const tally = emptyTally();
    const fetched = this._floor;
    if (fetched === null || floor < fetched) return { ...tally, ...coverage };
    for (const piece of this._pieces) addPiece(tally, piece, from, to, floor, floor === fetched);
    if (this._liveFrom !== null) {
      for (let i = 0; i < this._liveTs.length; i += 1) {
        const ts = this._liveTs[i];
        if (ts >= from && ts < to && this._liveSize[i] >= floor) addPrint(tally, this._liveBuy[i], this._liveSize[i]);
      }
    }
    return { ...tally, ...coverage };
  }

  readCandles(from: number, to: number, floor: number, slots: readonly CandleSlot[], nowMs: number): RangePrintCandlesRead | null {
    const read = this.read(from, to, floor, nowMs);
    if (read === null) return null;
    const candles = new Map<number, RangePrintTally>();
    if (this._floor === null || floor < this._floor) return { ...read, candles };
    for (const piece of this._pieces) addPieceCandles(candles, piece, from, to, floor, slots);
    if (this._liveFrom !== null) {
      for (let i = 0; i < this._liveTs.length; i += 1) {
        const ts = this._liveTs[i];
        if (ts < from || ts >= to || this._liveSize[i] < floor) continue;
        const tsOpen = candleAt(slots, ts);
        if (tsOpen !== null) addCandlePrint(candles, tsOpen, this._liveBuy[i], this._liveSize[i]);
      }
    }
    return { ...read, candles };
  }

  private _send(pending: Pending, floor: number, nowMs: number): RangePrintRequest {
    pending.requestId = nextAggressiveHistoryRequestId();
    pending.sent = true;
    pending.sentAt = nowMs;
    this._sentAt.push(nowMs);
    return { request_id: pending.requestId, from_ts: pending.from, to_ts: pending.to, min_size: floor, ...(pending.cursor === null ? {} : { cursor: pending.cursor }) };
  }

  private _blocked(nowMs: number): GivenUp[] {
    this._givenUp = this._givenUp.filter((stretch) => stretch.until > nowMs);
    return this._givenUp;
  }

  private _fail(pending: Pending, nowMs: number, reason: AggressiveHistoryReason, retryAfterMs: number | null): void {
    this._failures += 1;
    if (this._failures >= RANGE_RETRY_MAX_ATTEMPTS) {
      this._giveUp(pending, nowMs, reason);
      return;
    }
    pending.sent = false;
    this._retryAt = nowMs + (retryAfterMs ?? RANGE_RETRY_MS * this._failures);
  }

  private _giveUp(pending: Pending, nowMs: number, reason: AggressiveHistoryReason): void {
    this._givenUp.push({ from: pending.from, to: pending.to, until: nowMs + RANGE_GIVE_UP_MS });
    this._pending = null;
    this._failures = 0;
    this._retryAt = 0;
    this._issue = reason;
    this._changed();
  }

  private _evict(): void {
    let count = this.recordedCount;
    if (count <= this._maxRecorded) return;
    const window = this._window;
    const away = (piece: Piece): number => {
      if (window === null) return 0;
      if (piece.to <= window.from) return window.from - piece.to;
      if (piece.from >= window.to) return piece.from - window.to;
      return -1;
    };
    const outside = this._pieces.filter((piece) => away(piece) >= 0).sort((a, b) => away(b) - away(a));
    const gone = new Set<Piece>();
    for (const piece of outside) {
      if (count <= this._maxRecorded) break;
      gone.add(piece);
      count -= piece.ts.length;
    }
    this._pieces = this._pieces.filter((piece) => !gone.has(piece));
    if (count > this._maxRecorded) this._full = true;
  }

  private _handOverOldest(): void {
    const sorted = [...this._liveTs].sort((a, b) => a - b);
    const cut = Math.max(sorted[Math.floor(sorted.length / 2)], (this._liveFrom ?? -Infinity) + 1);
    const ts: number[] = [];
    const size: number[] = [];
    const buy: boolean[] = [];
    for (let i = 0; i < this._liveTs.length; i += 1) {
      if (this._liveTs[i] < cut) continue;
      ts.push(this._liveTs[i]);
      size.push(this._liveSize[i]);
      buy.push(this._liveBuy[i]);
    }
    this._liveTs = ts;
    this._liveSize = size;
    this._liveBuy = buy;
    this._liveFrom = cut;
    this._changed();
  }

  private _clearLive(): void {
    this._liveTs = [];
    this._liveSize = [];
    this._liveBuy = [];
  }

  private _changed(): void {
    this._version += 1;
    for (const listener of this._listeners) listener();
  }
}
