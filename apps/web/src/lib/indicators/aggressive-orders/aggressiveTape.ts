import type { TradeFrame } from "../../../types/frames";

export type PrintSide = "buy" | "sell";

export interface AggressivePrint {
  id: string;
  history: boolean;
  ts: number;
  price: number;
  size: number;
  side: PrintSide;
  seq: number;
}

export interface OrderCluster {
  side: PrintSide;
  ts: number;
  lastTs: number;
  fedAt: number;
  price: number;
  lastPrice: number;
  minPrice: number;
  maxPrice: number;
  vwap: number;
  volume: number;
  count: number;
}

export interface ClusterRules {
  minVolume: number;
  width: number;
  gapMs: number;
  maxMs: number;
  bucketMs: number;
}

export const MAX_TAPE_PRINTS = 250_000;
export const TRIM_SLACK_PRINTS = 25_000;

let historyRequestSeq = 0;
export function nextAggressiveHistoryRequestId(): number {
  historyRequestSeq += 1;
  return historyRequestSeq;
}
export const HISTORY_SETTLE_MS = 400;
export const HISTORY_GAP_MIN_MS = 1_000;
export const HISTORY_ASK_MAX_MS = 6 * 60 * 60 * 1000;
export const HISTORY_GIVE_UP_MS = 10 * 60 * 1000;
const HISTORY_THIN_BUCKET_MS = 60_000;
export const HISTORY_THIN_PER_MINUTE_SIDE = 4;

export interface HistoryInterval {
  from: number;
  to: number;
}
interface HistoryCoverage extends HistoryInterval {
  floor: number;
}
export const MAX_COVERAGE_ENTRIES = 512;
export const MAX_TALLY_CLUSTERS = 20_000;
/** Closed live stretches kept for coverage, newest last; older ones fall away. */
export const MAX_LIVE_SPANS = 64;
export const AUTO_SHARE = 0.02;
export const AUTO_FLOOR_REFRESH_MS = 1_000;
export const AUTO_FLOOR_MIN_PRINTS = 50;
const LIVE_LOOKBACK = 32;

export class AggressiveTape {
  private _prints: AggressivePrint[] = [];
  private readonly _ids = new Set<string>();
  private _liveCount = 0;
  private _lastTs = 0;
  private readonly _listeners = new Set<() => void>();
  private _autoFloor = 0;
  private _autoFloorAt = -Infinity;
  private _autoFloorCount = -1;
  private _tallyKey = "";
  private _rules: ClusterRules = { minVolume: 0, width: 0, gapMs: 0, maxMs: 0, bucketMs: 0 };
  private _floorInForce = 0;
  private _clusters: OrderCluster[] = [];
  private _tallyDirty = false;
  private _now: () => number;
  private _seq = 0;
  private _generation = 0;
  private _settleUntil = -Infinity;
  private _coverage: HistoryCoverage[] = [];
  private _historyWantedFrom: number | null = null;
  private _heldFrom = -Infinity;
  private _liveSince: number | null = null;
  // Where the live recording is actually complete. A reconnect starts a new live stretch (`_liveSince`), so the stretch
  // before it is kept here, closed at its last live print; and a live print the size cap drops leaves every window up to
  // it short, so `_liveDroppedThrough` is the newest such print. Indicators that price volume by print read both.
  private _liveSpans: { from: number; to: number }[] = [];
  private _lastLiveTs = -Infinity;
  private _liveDroppedThrough = -Infinity;
  private _historyVersion = 0;
  private _lastAsk: { minSize: number; ask: HistoryInterval; at: number } | null = null;
  private _givenUp: { from: number; to: number; until: number }[] = [];

  constructor(now: () => number = () => Date.now()) {
    this._now = now;
  }

  clockMs(): number { return this._now(); }
  readonly historical: boolean = false;

  get prints(): readonly AggressivePrint[] {
    return this._prints;
  }

  get lastTs(): number {
    return this._lastTs;
  }

  get liveCount(): number {
    return this._liveCount;
  }

  get generation(): number {
    return this._generation;
  }

  settling(nowMs: number): boolean {
    return nowMs < this._settleUntil;
  }

  get full(): boolean {
    return this._prints.length >= MAX_TAPE_PRINTS;
  }

  historyIntervalsAt(minSize: number): HistoryInterval[] {
    const merged: HistoryInterval[] = [];
    for (const entry of this._coverage) {
      if (entry.floor > minSize) continue;
      let span: HistoryInterval = { from: entry.from, to: entry.to };
      const apart: HistoryInterval[] = [];
      for (const interval of merged) {
        if (interval.to < span.from || interval.from > span.to) apart.push(interval);
        else span = { from: Math.min(span.from, interval.from), to: Math.max(span.to, interval.to) };
      }
      apart.push(span);
      merged.splice(0, merged.length, ...apart);
    }
    return merged.sort((a, b) => a.from - b.from);
  }

  historyCoveredTo(minSize: number): number | null {
    const intervals = this.historyIntervalsAt(minSize);
    return intervals.length === 0 ? null : intervals[intervals.length - 1].to;
  }

  get historyFrom(): number | null {
    const intervals = this.historyIntervalsAt(Infinity);
    return intervals.length === 0 ? null : intervals[intervals.length - 1].from;
  }

  get historyIntervals(): readonly HistoryInterval[] {
    return this.historyIntervalsAt(Infinity);
  }

  nextHistoryGap(minSize = Infinity): HistoryInterval | null {
    const wanted = this._historyWantedFrom;
    const intervals = this.historyIntervalsAt(minSize);
    const count = intervals.length;
    if (wanted === null || count === 0) return null;
    const newest = intervals[count - 1];
    if (newest.from <= wanted + HISTORY_GAP_MIN_MS) return null;
    const older = count >= 2 ? intervals[count - 2] : null;
    const from = older ? Math.max(wanted, older.to) : wanted;
    return this.askable({ from, to: newest.from }, this._now());
  }

  giveUpHistory(fromMs: number, toMs: number, untilMs: number): void {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || !Number.isFinite(untilMs)) return;
    this._givenUp.push({ from: fromMs, to: toMs, until: untilMs });
  }

  askable(ask: HistoryInterval, nowMs: number): HistoryInterval | null {
    this._givenUp = this._givenUp.filter((stretch) => stretch.until > nowMs);
    let to = ask.to;
    for (const stretch of this._givenUp) {
      if (stretch.from < to && stretch.to > ask.from) to = Math.min(to, stretch.from);
    }
    const from = Math.max(ask.from, to - HISTORY_ASK_MAX_MS);
    return to - from < HISTORY_GAP_MIN_MS ? null : { from, to };
  }

  get historyWantedFrom(): number | null {
    return this._historyWantedFrom;
  }

  /** Earlier live stretches, each complete from `from` to its last live print `to`. */
  get liveSpans(): readonly { readonly from: number; readonly to: number }[] {
    return this._liveSpans;
  }

  /** The newest live print the store has dropped, or -Infinity: windows up to it are no longer complete. */
  get liveDroppedThrough(): number {
    return this._liveDroppedThrough;
  }

  /** Moves whenever history prints or history coverage change, never for a live print. */
  get historyVersion(): number {
    return this._historyVersion;
  }

  get liveSince(): number | null {
    return this._liveSince;
  }

  lastHistoryAsk(minSize: number): { ask: HistoryInterval; at: number } | null {
    const last = this._lastAsk;
    return last !== null && last.minSize === minSize ? { ask: last.ask, at: last.at } : null;
  }

  noteHistoryAsk(ask: HistoryInterval, minSize: number, atMs: number): void {
    this._lastAsk = { minSize, ask: { from: ask.from, to: ask.to }, at: atMs };
  }

  wantHistoryFrom(fromMs: number): void {
    if (Number.isFinite(fromMs)) this._historyWantedFrom = Math.max(fromMs, this._heldFrom);
  }

  coverHistory(fromMs: number, toMs: number, minSize: number): void {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || !Number.isFinite(minSize)) return;
    let span: HistoryCoverage = { from: fromMs, to: toMs, floor: minSize };
    const apart: HistoryCoverage[] = [];
    for (const entry of this._coverage) {
      if (entry.floor !== minSize || entry.to < span.from || entry.from > span.to) apart.push(entry);
      else span = { from: Math.min(span.from, entry.from), to: Math.max(span.to, entry.to), floor: minSize };
    }
    apart.push(span);
    apart.sort((a, b) => a.from - b.from || a.floor - b.floor);
    if (apart.length > MAX_COVERAGE_ENTRIES) apart.splice(0, apart.length - MAX_COVERAGE_ENTRIES);
    this._coverage = apart;
    this._historyVersion += 1;
    this._notify();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _notify(): void {
    for (const listener of this._listeners) listener();
  }

  reset(trades: readonly TradeFrame[] = []): void {
    this._prints = [];
    this._ids.clear();
    this._liveCount = 0;
    this._lastTs = 0;
    this._autoFloorCount = -1;
    this._tallyKey = "";
    this._clusters = [];
    this._tallyDirty = false;
    this._generation += 1;
    this._coverage = [];
    this._historyWantedFrom = null;
    this._heldFrom = -Infinity;
    this._liveSince = null;
    this._liveSpans = [];
    this._lastLiveTs = -Infinity;
    this._liveDroppedThrough = -Infinity;
    this._historyVersion += 1;
    this._lastAsk = null;
    this._givenUp = [];
    for (const trade of trades) this._push(toPrint(trade), false);
    this._prints.sort(comparePrints);
    this._trim();
    this._notify();
  }

  /**
   * The feed is gone (the worker reported its socket closed): the live
   * stretch ends at its last print and nothing is live until the next print
   * or snapshot starts a new stretch, so a window that spans the outage
   * never reads as complete, not even before the reconnect's snapshot.
   */
  endLive(): void {
    if (this._liveSince === null) return;
    if (this._lastLiveTs > this._liveSince) {
      this._liveSpans.push({ from: this._liveSince, to: this._lastLiveTs });
      if (this._liveSpans.length > MAX_LIVE_SPANS) this._liveSpans.splice(0, this._liveSpans.length - MAX_LIVE_SPANS);
    }
    this._liveSince = null;
    this._notify();
  }

  absorb(trades: readonly TradeFrame[]): void {
    // A (re)connect: the stretch recorded so far stays complete up to its last live print.
    if (this._liveSince !== null && this._lastLiveTs > this._liveSince) {
      this._liveSpans.push({ from: this._liveSince, to: this._lastLiveTs });
      if (this._liveSpans.length > MAX_LIVE_SPANS) this._liveSpans.splice(0, this._liveSpans.length - MAX_LIVE_SPANS);
    }
    this._liveSince = this._now();
    let taken = 0;
    for (const trade of trades) {
      if (this._ids.has(trade.trade_id)) continue;
      const print = toPrint(trade);
      this._push(print);
      this._fold(print);
      taken += 1;
    }
    this._trim();
    if (taken > 0 || this._prints.length === 0) this._notify();
  }

  add(trade: TradeFrame): void {
    if (this._liveSince === null) this._liveSince = this._now();
    if (this._ids.has(trade.trade_id)) return;
    const print = toPrint(trade);
    this._push(print);
    this._fold(print);
    this._trim();
    this._notify();
  }

  addHistory(trades: readonly TradeFrame[], thinBeforeMs = -Infinity): number {
    let taken = 0;
    for (const trade of trades) {
      if (this._ids.has(trade.trade_id)) continue;
      this._push(toPrint(trade, true), false);
      taken += 1;
    }
    if (taken === 0) return 0;
    this._prints.sort(comparePrints);
    if (thinBeforeMs > -Infinity) this._thin(thinBeforeMs);
    this._trim();
    this._autoFloorCount = -1;
    this._generation += 1;
    this._historyVersion += 1;
    this._tallyDirty = true;
    this._settleUntil = this._now() + HISTORY_SETTLE_MS;
    this._notify();
    return taken;
  }

  private _push(print: AggressivePrint, insertLate = true): void {
    print.seq = this._seq;
    this._seq += 1;
    if (insertLate && print.ts < this._lastTs) {
      let lo = 0;
      let hi = this._prints.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this._prints[mid].ts <= print.ts) lo = mid + 1;
        else hi = mid;
      }
      this._prints.splice(lo, 0, print);
      // The incremental cluster and absorption trackers have already seen a
      // later print, so they must derive their state from the ordered tape.
      this._generation += 1;
      this._tallyDirty = true;
    } else {
      this._prints.push(print);
    }
    this._ids.add(print.id);
    if (!print.history) this._liveCount += 1;
    if (!print.history && print.ts > this._lastLiveTs) this._lastLiveTs = print.ts;
    if (print.ts > this._lastTs) this._lastTs = print.ts;
  }

  private _drop(print: AggressivePrint): void {
    this._ids.delete(print.id);
    if (!print.history) this._liveCount -= 1;
    if (!print.history && print.ts > this._liveDroppedThrough) this._liveDroppedThrough = print.ts;
  }

  private _thin(beforeMs: number): void {
    const buckets = new Map<string, AggressivePrint[]>();
    for (const print of this._prints) {
      if (print.ts >= beforeMs) break;
      const key = `${Math.floor(print.ts / HISTORY_THIN_BUCKET_MS)}:${print.side}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(print);
      else buckets.set(key, [print]);
    }
    const gone = new Set<AggressivePrint>();
    for (const bucket of buckets.values()) {
      if (bucket.length <= HISTORY_THIN_PER_MINUTE_SIDE) continue;
      bucket.sort((a, b) => b.size - a.size || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const print of bucket.slice(HISTORY_THIN_PER_MINUTE_SIDE)) gone.add(print);
    }
    if (gone.size === 0) return;
    for (const print of gone) this._drop(print);
    this._prints = this._prints.filter((print) => !gone.has(print));
  }

  private _trim(): void {
    if (this._prints.length < MAX_TAPE_PRINTS + TRIM_SLACK_PRINTS) return;
    let excess = this._prints.length - MAX_TAPE_PRINTS;
    const keepFrom = this._coverage.length === 0 ? 0 : Math.min(...this._coverage.map((entry) => entry.floor));
    const kept: AggressivePrint[] = [];
    for (const print of this._prints) {
      if (excess > 0 && (keepFrom <= 0 || print.size < keepFrom)) {
        this._drop(print);
        excess -= 1;
      } else {
        kept.push(print);
      }
    }
    if (excess > 0) for (const dropped of kept.splice(0, excess)) this._drop(dropped);
    this._prints = kept;
    this._uncoverBefore(kept.length === 0 ? Infinity : kept[0].ts);
  }

  private _uncoverBefore(ts: number): void {
    const clipped: HistoryCoverage[] = [];
    for (const entry of this._coverage) {
      if (entry.to <= ts) continue;
      clipped.push(entry.from < ts ? { from: ts, to: entry.to, floor: entry.floor } : entry);
    }
    this._coverage = clipped;
    if (Number.isFinite(ts)) this._heldFrom = Math.max(this._heldFrom, ts);
    if (this._historyWantedFrom !== null && this._historyWantedFrom < ts) this._historyWantedFrom = ts;
  }

  autoFloor(nowMs: number): number {
    const count = this._liveCount;
    if (count < AUTO_FLOOR_MIN_PRINTS) return 0;
    if (count === this._autoFloorCount || nowMs - this._autoFloorAt < AUTO_FLOOR_REFRESH_MS) return this._autoFloor;
    const sizes = new Float64Array(count);
    let n = 0;
    for (const print of this._prints) if (!print.history) sizes[n++] = print.size;
    const live = sizes.subarray(0, n).sort();
    const index = Math.min(n - 1, Math.max(0, Math.floor((1 - AUTO_SHARE) * (n - 1))));
    this._autoFloor = live[index];
    this._autoFloorAt = nowMs;
    this._autoFloorCount = count;
    return this._autoFloor;
  }

  floor(minVolume: number, nowMs: number): number {
    return minVolume > 0 ? minVolume : this.autoFloor(nowMs);
  }

  private _fold(print: AggressivePrint): void {
    if (this._tallyKey === "" || print.size < this._floorInForce) return;
    foldPrint(this._clusters, print, this._rules, this._now());
    if (this._clusters.length > MAX_TALLY_CLUSTERS) this._clusters.splice(0, this._clusters.length - MAX_TALLY_CLUSTERS);
  }

  clusters(rules: ClusterRules, nowMs: number): readonly OrderCluster[] {
    const floor = this.floor(rules.minVolume, nowMs);
    const key = `${floor}:${rules.width}:${rules.gapMs}:${rules.maxMs}:${rules.bucketMs}`;
    if (key !== this._tallyKey || (this._tallyDirty && !this.settling(nowMs))) {
      this._tallyKey = key;
      this._tallyDirty = false;
      this._rules = { ...rules };
      this._floorInForce = floor;
      this._clusters = [];
      for (const print of this._prints) {
        if (print.size >= floor) foldPrint(this._clusters, print, this._rules, -Infinity);
      }
      if (this._clusters.length > MAX_TALLY_CLUSTERS) this._clusters.splice(0, this._clusters.length - MAX_TALLY_CLUSTERS);
    }
    return this._clusters;
  }

  bubbles(rules: ClusterRules, nowMs: number, fromMs: number, toMs: number): OrderCluster[] {
    const all = this.clusters(rules, nowMs);
    const found: OrderCluster[] = [];
    const cutoff = fromMs - rules.maxMs - 60_000;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const cluster = all[i];
      if (cluster.ts < cutoff) break;
      if (cluster.ts < fromMs || cluster.ts > toMs) continue;
      found.push(cluster);
    }
    return found.reverse();
  }
}

export function toPrint(trade: TradeFrame, history = false): AggressivePrint {
  return { id: trade.trade_id, history, ts: trade.ts_exchange, price: trade.price, size: trade.size, side: trade.side, seq: 0 };
}

function comparePrints(a: AggressivePrint, b: AggressivePrint): number {
  return a.ts - b.ts || a.seq - b.seq;
}

export function foldPrint(clusters: OrderCluster[], print: AggressivePrint, rules: ClusterRules, fedAt: number): OrderCluster {
  const first = Math.max(0, clusters.length - LIVE_LOOKBACK);
  let sweep: OrderCluster | null = null;
  let run: OrderCluster | null = null;
  for (let i = clusters.length - 1; i >= first; i -= 1) {
    const cluster = clusters[i];
    if (cluster.side !== print.side) continue;
    if (cluster.lastTs === print.ts && sweep === null) sweep = cluster;
    if (
      run === null &&
      rules.width > 0 &&
      print.ts - cluster.lastTs <= rules.gapMs &&
      print.ts - cluster.ts <= rules.maxMs &&
      Math.abs(print.price - cluster.lastPrice) <= rules.width &&
      (rules.bucketMs <= 0 || Math.floor(print.ts / rules.bucketMs) === Math.floor(cluster.ts / rules.bucketMs))
    ) {
      run = cluster;
    }
  }
  const target = sweep ?? run;
  if (target) {
    target.volume += print.size;
    target.vwap = (target.vwap * (target.volume - print.size) + print.price * print.size) / target.volume;
    target.count += 1;
    if (print.ts >= target.lastTs) {
      target.lastTs = print.ts;
      target.lastPrice = print.price;
    }
    if (print.price < target.minPrice) target.minPrice = print.price;
    if (print.price > target.maxPrice) target.maxPrice = print.price;
    target.fedAt = fedAt;
    return target;
  }
  const opened: OrderCluster = {
    side: print.side, ts: print.ts, lastTs: print.ts, fedAt, price: print.price, lastPrice: print.price, minPrice: print.price, maxPrice: print.price,
    vwap: print.price, volume: print.size, count: 1,
  };
  clusters.push(opened);
  return opened;
}
