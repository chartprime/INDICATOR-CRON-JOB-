import type { DeltaProfileFrame, DeltaProfileReason, FrameIdentity } from "../../../types/frames";

export interface DeltaProfileRequest {
  request_id: number;
  from_ts: number;
  to_ts: number;
  row_width: number;
  piece_ms?: number;
}

export interface DeltaProfileRow {
  price: number;
  buy: number;
  sell: number;
}

export interface DeltaProfilePiece {
  from: number;
  to: number;
  volume: number;
}

export interface ProfileWindowBounds {
  from: number;
  to: number | null;
  pieceMs: number;
}

export interface Gap {
  from: number;
  to: number;
}

interface PrintLike {
  ts_exchange: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}

interface Tally {
  buy: number;
  sell: number;
}

interface HostPiece extends DeltaProfilePiece {
  rows: Map<number, Tally>;
}

export const DELTA_ASK_DELAY_MS = 5_000;
export const DELTA_RETRY_MS = 30_000;
export const DELTA_RETRY_MAX_ATTEMPTS = 3;
export const DELTA_GIVE_UP_MS = 10 * 60 * 1000;
export const DELTA_PENDING_MS = 90_000;
export const RECENT_TRADES_KEPT = 64;
export const RUNTIME_PIECE_MS = 2 * 60 * 60 * 1000;
export const LIVE_SLICE_MS = 60_000;
export const MAX_PIECES = 1_024;
export const MAX_LIVE_SLICES = 2_880;
/**
 * Where a store that is not the first on the chart starts numbering its requests.
 *
 * Two profiles read this store's data at once -- the net delta one and Volume
 * Profile (Ticks), which keep their own windows and so their own stores -- and
 * both ask the host over the one request channel. A reply is matched to the
 * request that asked for it by id alone, so the stores must not both count from
 * 1: the second one starts a stride up, inside the safe integers the wire allows.
 */
export const DELTA_REQUEST_ID_STRIDE = 1_000_000;

/**
 * Whether a store may ask the host now, given the other stores on the same
 * connection (null for one whose indicator is off).
 *
 * The host serves one delta_profile job per connection: a newer request
 * cancels the older one and sends nothing for it (delta-profile.js, "only the
 * newest request per client is served"). Two stores asking freely would cancel
 * each other's jobs, each then sitting on its request for DELTA_PENDING_MS.
 * So a store asks only while no other has a request out, and the host never
 * has two jobs from this connection to choose between.
 */
export function deltaChannelFree(others: readonly (DeltaProfileStore | null)[]): boolean {
  return others.every((store) => store === null || !store.pending);
}
const SUBUNITS = 100_000_000;
const FINAL_REASONS: ReadonlySet<DeltaProfileReason> = new Set(["ROWS_CAPPED"]);

/** The fine row the profile is kept in, per instrument; the chart merges rows up from here. */
export function baseRowWidthFor(identity: FrameIdentity, symbol: string): number {
  if (identity.provider === "BINANCE") {
    if (/^BTC/.test(symbol)) return 1;
    if (/^ETH/.test(symbol)) return 0.1;
    return 0.01;
  }
  return identity.assetClass === "FUTURE" ? 0.25 : 0.01;
}

export function rowIndexOf(price: number, rowWidth: number): number {
  return Math.floor(Math.round(price * SUBUNITS) / Math.round(rowWidth * SUBUNITS));
}

export interface RecentTrade {
  index: number;
  at: number;
}

function addTo(rows: Map<number, Tally>, index: number, buy: number, sell: number): void {
  const row = rows.get(index);
  if (row) {
    row.buy += buy;
    row.sell += sell;
  } else {
    rows.set(index, { buy, sell });
  }
}

/** The parts of [from, to) that no piece covers, newest first. */
export function gapsIn(pieces: readonly DeltaProfilePiece[], from: number, to: number): Gap[] {
  const gaps: Gap[] = [];
  let cursor = to;
  for (const piece of [...pieces].sort((a, b) => b.from - a.from)) {
    if (piece.to <= from) continue;
    if (piece.to < cursor) gaps.push({ from: piece.to, to: cursor });
    cursor = Math.min(cursor, piece.from);
    if (cursor <= from) break;
  }
  if (cursor > from) gaps.push({ from, to: cursor });
  return gaps;
}

/**
 * Net buys and sells per price row over the window the chart is in. The past
 * comes from the runtime in pieces (`put`), everything from the cut (`liveFrom`)
 * on from the live trades (`addTrade`), so no print is counted twice. The cut
 * sits just after the newest print the store has been shown, on the exchange's
 * clock. The host is asked only for the parts of [windowFrom, cut) no piece
 * covers yet, and only once the recorder has had DELTA_ASK_DELAY_MS since the
 * cut was set to write up to it. Pieces
 * and minute slices of live prints keep their own rows and outlive the window,
 * so a window that moves (a new day, a sliding hour, a pan) reads what it
 * already has and asks for the rest.
 */
export class DeltaProfileStore {
  readonly rowWidth: number;
  private _pieces = new Map<number, HostPiece>();
  private _live = new Map<number, Map<number, Tally>>();
  private _window: ProfileWindowBounds | null = null;
  private _liveFrom: number | null = null;
  private _cutSetAt = 0;
  private _lastSeen: number | null = null;
  private _pending: { requestId: number; from: number; nextTo: number; sentAt: number } | null = null;
  private _failures = 0;
  private _retryAt = 0;
  private _issue: DeltaProfileReason | null = null;
  private _seq = 0;
  private _version = 0;
  private _recent: RecentTrade[] = [];
  private _lastIndex: number | null = null;

  constructor(rowWidth: number, firstRequestId = 0) {
    if (!Number.isFinite(rowWidth) || rowWidth <= 0) throw new Error("DeltaProfileStore: rowWidth must be a positive finite number");
    this.rowWidth = rowWidth;
    this._seq = firstRequestId;
  }

  get version(): number {
    return this._version;
  }

  get windowFrom(): number | null {
    return this._window?.from ?? null;
  }

  get windowTo(): number | null {
    return this._window?.to ?? null;
  }

  get liveFrom(): number | null {
    return this._liveFrom;
  }

  get issue(): DeltaProfileReason | null {
    return this._issue;
  }

  get pending(): boolean {
    return this._pending !== null;
  }

  /** The pieces inside the window, for the hole check. */
  get pieces(): DeltaProfilePiece[] {
    return this._inWindow().map(({ from, to, volume }) => ({ from, to, volume }));
  }

  /** The row of the last live print, on the store's own row grid. */
  get lastIndex(): number | null {
    return this._lastIndex;
  }

  /** The rows that printed lately, newest last, with the wall-clock moment each landed. */
  get recent(): readonly RecentTrade[] {
    return this._recent;
  }

  /** What the host still has to answer for the window, newest first. */
  get gaps(): Gap[] {
    const window = this._window;
    if (window === null || this._liveFrom === null) return [];
    const cut = window.to === null ? this._liveFrom : Math.min(this._liveFrom, window.to);
    return gapsIn(this._inWindow(), window.from, cut);
  }

  /** The past is in when no gap is left in the window. */
  get complete(): boolean {
    return this._window !== null && this._liveFrom !== null && this.gaps.length === 0;
  }

  /**
   * The window to cover. Pieces and slices already held stay; a piece cut by
   * the new edge is dropped and asked again, and the request in flight is
   * dropped so the next ask is for what this window still misses.
   */
  setWindow(window: ProfileWindowBounds, nowMs: number): void {
    if (this._liveFrom === null) {
      this._liveFrom = this._lastSeen === null ? nowMs : this._lastSeen + 1;
      this._cutSetAt = nowMs;
    }
    const current = this._window;
    if (current && current.from === window.from && current.to === window.to && current.pieceMs === window.pieceMs) return;
    this._window = { ...window };
    if (this._issue !== null && FINAL_REASONS.has(this._issue)) {
      this._failures = 0;
      this._retryAt = 0;
    }
    this._issue = null;
    for (const [from, piece] of this._pieces) {
      const cutByFrom = piece.from < window.from && piece.to > window.from;
      const cutByTo = window.to !== null && piece.from < window.to && piece.to > window.to;
      if (cutByFrom || cutByTo) this._pieces.delete(from);
    }
    this._pending = null;
    this._version += 1;
  }

  /** The live stream broke (a reconnect): the next window sets the cut again, after the newest print shown since. */
  reanchor(): void {
    this._pieces.clear();
    this._live.clear();
    this._liveFrom = null;
    this._lastSeen = null;
    this._pending = null;
    this._failures = 0;
    this._retryAt = 0;
    this._issue = null;
    this._version += 1;
  }

  /** A print that reached the browser without going through `addTrade` (a snapshot's trades). */
  markSeen(tsExchange: number): void {
    this._lastSeen = Math.max(this._lastSeen ?? tsExchange, tsExchange);
  }

  addTrade(trade: PrintLike, nowMs: number = Date.now()): boolean {
    this.markSeen(trade.ts_exchange);
    if (this._liveFrom === null || trade.ts_exchange < this._liveFrom || !(trade.size > 0)) return false;
    const sliceFrom = Math.floor(trade.ts_exchange / LIVE_SLICE_MS) * LIVE_SLICE_MS;
    let slice = this._live.get(sliceFrom);
    if (!slice) {
      slice = new Map();
      this._live.set(sliceFrom, slice);
      if (this._live.size > MAX_LIVE_SLICES) this._handOverOldest();
    }
    const index = rowIndexOf(trade.price, this.rowWidth);
    addTo(slice, index, trade.side === "buy" ? trade.size : 0, trade.side === "sell" ? trade.size : 0);
    this._lastIndex = index;
    this._recent.push({ index, at: nowMs });
    if (this._recent.length > RECENT_TRADES_KEPT) this._recent.splice(0, this._recent.length - RECENT_TRADES_KEPT);
    this._version += 1;
    return true;
  }

  nextRequest(nowMs: number): DeltaProfileRequest | null {
    const window = this._window;
    if (window === null || this._liveFrom === null) return null;
    if (this._pending !== null) {
      if (nowMs - this._pending.sentAt <= DELTA_PENDING_MS) return null;
      this._pending = null;
      this._failures += 1;
      this._retryAt = nowMs + this._backoff();
    }
    if (nowMs < this._retryAt || nowMs < this._cutSetAt + DELTA_ASK_DELAY_MS) return null;
    if (this._issue !== null && FINAL_REASONS.has(this._issue)) return null;
    const gap = this.gaps[0];
    if (gap === undefined) return null;
    this._seq += 1;
    this._pending = { requestId: this._seq, from: gap.from, nextTo: gap.to, sentAt: nowMs };
    return {
      request_id: this._seq,
      from_ts: gap.from,
      to_ts: gap.to,
      row_width: this.rowWidth,
      ...(window.pieceMs === RUNTIME_PIECE_MS ? {} : { piece_ms: window.pieceMs }),
    };
  }

  /** Lays a piece in; true when something changed (rows, coverage or the issue). */
  put(frame: DeltaProfileFrame, nowMs: number): boolean {
    const pending = this._pending;
    if (pending === null || frame.request_id !== pending.requestId || frame.row_width !== this.rowWidth) return false;
    if (!frame.complete) {
      this._pending = null;
      this._issue = frame.reason;
      this._failures += 1;
      this._retryAt = nowMs + (frame.retry_after_ms ?? this._backoff());
      this._version += 1;
      return true;
    }
    if (frame.to_ts !== pending.nextTo || frame.from_ts >= frame.to_ts || frame.from_ts < pending.from) return false;
    const rows = new Map<number, Tally>();
    let volume = 0;
    for (const [price, buy, sell] of frame.rows) {
      addTo(rows, rowIndexOf(price, this.rowWidth), buy, sell);
      volume += buy + sell;
    }
    this._pieces.set(frame.from_ts, { from: frame.from_ts, to: frame.to_ts, volume, rows });
    while (this._pieces.size > MAX_PIECES) this._pieces.delete(this._farthestPiece());
    pending.nextTo = frame.from_ts;
    this._issue = null;
    this._failures = 0;
    this._retryAt = 0;
    if (frame.pending === 0 || this.complete) this._pending = null;
    else pending.sentAt = nowMs;
    this._version += 1;
    return true;
  }

  /** Every row that traded inside the window, ascending by price. */
  rows(): DeltaProfileRow[] {
    const window = this._window;
    const total = new Map<number, Tally>();
    if (window !== null) {
      for (const piece of this._inWindow()) for (const [index, row] of piece.rows) addTo(total, index, row.buy, row.sell);
      for (const [from, slice] of this._live) {
        if (from < window.from || (window.to !== null && from >= window.to)) continue;
        for (const [index, row] of slice) addTo(total, index, row.buy, row.sell);
      }
    }
    const out: DeltaProfileRow[] = [];
    for (const [index, row] of total) out.push({ price: Number((index * this.rowWidth).toPrecision(12)), buy: row.buy, sell: row.sell });
    return out.sort((a, b) => a.price - b.price);
  }

  private _inWindow(): HostPiece[] {
    const window = this._window;
    if (window === null) return [];
    const out: HostPiece[] = [];
    for (const piece of this._pieces.values()) {
      if (piece.from >= window.from && (window.to === null || piece.to <= window.to)) out.push(piece);
    }
    return out;
  }

  private _handOverOldest(): void {
    const cut = (Math.floor(Math.min(...this._live.keys()) / RUNTIME_PIECE_MS) + 1) * RUNTIME_PIECE_MS;
    for (const from of this._live.keys()) if (from < cut) this._live.delete(from);
    this._liveFrom = cut;
  }

  private _farthestPiece(): number {
    const window = this._window;
    let farthest = Infinity;
    let distance = -2;
    for (const piece of this._pieces.values()) {
      let away = -1;
      if (window !== null) {
        if (piece.to <= window.from) away = window.from - piece.to;
        else if (window.to !== null && piece.from >= window.to) away = piece.from - window.to;
      }
      if (away > distance || (away === distance && piece.from < farthest)) {
        distance = away;
        farthest = piece.from;
      }
    }
    return farthest;
  }

  private _backoff(): number {
    return this._failures >= DELTA_RETRY_MAX_ATTEMPTS ? DELTA_GIVE_UP_MS : DELTA_RETRY_MS * this._failures;
  }
}
