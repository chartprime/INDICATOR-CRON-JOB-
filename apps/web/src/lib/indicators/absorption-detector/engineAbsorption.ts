import type { IndicatorL2 } from "../../chart/indicatorL2";
import type { L2TradeBucket } from "../../l2/history";
import type { LiquidityColumn } from "../passive-liquidity/liquidityGrid";
import type { LiquidityPrint } from "../../../types/frames";
import type { ColumnFeed } from "./absorptionEngine";

export type EngineAbsorptionReason = "no-l2" | "historical" | "untrusted" | null;

export const HISTORY_CHUNK_MS = 15 * 60_000;
export const MAX_PAGES_PER_CHUNK = 10;
export const MAX_CHUNK_ATTEMPTS = 5;
export const HISTORY_PACING = Object.freeze({ gapMs: 250, retryMs: 1_500 });

export type HistoryFill = "filled" | "held" | "short";

interface Flow {
  buy: Map<number, number>;
  sell: Map<number, number>;
  big?: Map<number, LiquidityPrint>;
}

const ROW_EPSILON = 1e-6;

export function tradeRow(price: number, rowWidth: number): number {
  return Math.floor(price / rowWidth + ROW_EPSILON);
}

function pairOf(segmentId: string): string {
  const parts = segmentId.split(":");
  return parts.slice(0, parts.length - 2).join(":");
}

function addTo(flow: Flow, side: "buy" | "sell", row: number, size: number): void {
  const map = flow[side];
  map.set(row, (map.get(row) ?? 0) + size);
}

function noteBig(flow: Flow, row: number, print: LiquidityPrint): void {
  const big = flow.big ?? new Map<number, LiquidityPrint>();
  const held = big.get(row);
  if (held === undefined || print.size > held.size) big.set(row, print);
  flow.big = big;
}

function mergeInto(target: Flow, source: Flow): void {
  for (const side of ["buy", "sell"] as const) for (const [row, size] of source[side]) addTo(target, side, row, size);
  if (source.big !== undefined) for (const [row, print] of source.big) noteBig(target, row, print);
}

function entries(map: Map<number, number>): [number, number][] {
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function bigPrints(flow: Flow): LiquidityPrint[] {
  return flow.big === undefined ? [] : [...flow.big.entries()].sort((a, b) => a[0] - b[0]).map(([, print]) => print);
}

function withoutFlow(column: LiquidityColumn): LiquidityColumn {
  const out: LiquidityColumn = { ...column };
  delete out.buy;
  delete out.sell;
  delete out.prints;
  delete out.printsFloor;
  return out;
}

export class EngineAbsorptionTracker {
  private readonly _bareUncovered: boolean;
  private _fine = new Map<number, Flow>();
  private _deep = new Map<number, Flow>();
  private _gaps: [number, number][] = [];
  private _seenSeq: number | undefined = undefined;
  private _lastEventTs: number | null = null;
  private _coveredFrom: number | null = null;
  private _liveFrom: number | null = null;
  private _coveredTo: number | null = null;
  private _segmentId: string | null = null;
  private _shape = "";
  private _cache = new WeakMap<LiquidityColumn, LiquidityColumn>();

  constructor(bareUncovered = false) {
    this._bareUncovered = bareUncovered;
  }

  get gaps(): readonly (readonly [number, number])[] {
    return this._gaps;
  }

  get coveredFrom(): number | null {
    return this._coveredFrom;
  }

  get liveFrom(): number | null {
    return this._liveFrom;
  }

  backfill(trades: readonly L2TradeBucket[], fromTs: number, toTs: number): number {
    if (this._shape === "" || this._coveredFrom === null) return 0;
    if (toTs < this._coveredFrom || fromTs >= this._coveredFrom) return 0;
    const [, bucketMs, deepMs] = JSON.parse(this._shape) as [number, number, number | null];
    let added = 0;
    for (const trade of trades) {
      if (trade.ts < fromTs || trade.ts >= this._coveredFrom) continue;
      const tier = trade.columnMs === bucketMs ? this._fine : trade.columnMs === deepMs ? this._deep : null;
      if (tier === null) continue;
      let flow = tier.get(trade.ts);
      if (flow === undefined) {
        flow = { buy: new Map(), sell: new Map() };
        tier.set(trade.ts, flow);
      }
      addTo(flow, trade.aggressor, trade.row, trade.size);
      added += 1;
    }
    this._coveredFrom = fromTs;
    this._cache = new WeakMap();
    return added;
  }

  tradedInto(attack: "buy" | "sell", rowLo: number, rowHi: number, from: number, to: number): number {
    if (this._shape === "") return 0;
    const [, bucketMs, deepMs] = JSON.parse(this._shape) as [number, number, number | null];
    let sum = 0;
    for (const [row, size] of this._flowFor(from, to, bucketMs, deepMs)[attack]) if (row >= rowLo && row <= rowHi) sum += size;
    return sum;
  }

  columns(l2: IndicatorL2 | undefined, feed: ColumnFeed, rowWidth: number): { feed: ColumnFeed; reason: EngineAbsorptionReason } {
    if (l2 === undefined) return { feed, reason: "no-l2" };
    if (l2.availability === "HISTORICAL_UNAVAILABLE") return { feed, reason: "historical" };
    if (!l2.trusted()) return { feed, reason: "untrusted" };
    if (l2.availability === "HISTORICAL") return { feed, reason: null };
    if (!(rowWidth > 0)) return { feed, reason: null };
    const shape = JSON.stringify([rowWidth, feed.fine.columnMs, feed.deep?.columnMs ?? null]);
    const segment = l2.segment();
    if (shape !== this._shape || (segment !== null && this._segmentId !== null
      && pairOf(segment.id) !== pairOf(this._segmentId))) this._reset();
    this._shape = shape;
    if (segment !== null) this._segmentId = segment.id;
    this._consume(l2, feed, rowWidth);
    this._prune(feed);
    return { feed: this._coveredTo === null && !this._bareUncovered ? feed : this._feedOf(feed), reason: null };
  }

  private _reset(): void {
    this._fine.clear();
    this._deep.clear();
    this._gaps = [];
    this._seenSeq = undefined;
    this._lastEventTs = null;
    this._coveredFrom = null;
    this._liveFrom = null;
    this._coveredTo = null;
    this._segmentId = null;
    this._cache = new WeakMap();
  }

  private _consume(l2: IndicatorL2, feed: ColumnFeed, rowWidth: number): void {
    const bucketMs = feed.fine.columnMs;
    const frameTs = l2.status("l2_events").lastTs;
    const slice = l2.events(this._seenSeq);
    const first = slice.events.length > 0 ? slice.events[0].ts : frameTs;
    if (!slice.complete && this._lastEventTs !== null && first !== null) this._gaps.push([this._lastEventTs, Math.max(this._lastEventTs, first)]);
    this._seenSeq = slice.seq;
    for (const event of slice.events) {
      if (event.kind !== "trade") continue;
      const bucket = Math.floor(event.ts / bucketMs) * bucketMs;
      let flow = this._fine.get(bucket);
      if (flow === undefined) {
        flow = { buy: new Map(), sell: new Map() };
        this._fine.set(bucket, flow);
      }
      const row = tradeRow(event.price, rowWidth);
      addTo(flow, event.aggressor, row, event.size);
      noteBig(flow, row, { ts: event.ts, price: event.price, size: event.size, side: event.aggressor, id: null });
      if (this._lastEventTs === null || event.ts > this._lastEventTs) this._lastEventTs = event.ts;
    }
    if (frameTs !== null) {
      if (this._coveredFrom === null) {
        this._coveredFrom = Math.floor(Math.min(frameTs, first ?? frameTs) / bucketMs) * bucketMs;
        this._liveFrom = this._coveredFrom;
      }
      if (this._coveredTo === null || frameTs > this._coveredTo) this._coveredTo = frameTs;
    }
  }

  private _prune(feed: ColumnFeed): void {
    const deepMs = feed.deep?.columnMs ?? null;
    const fineStart = feed.fine.columns[0]?.ts ?? Infinity;
    for (const [bucket, flow] of [...this._fine]) {
      if (bucket >= fineStart) continue;
      this._fine.delete(bucket);
      if (deepMs === null) continue;
      const deepBucket = Math.floor(bucket / deepMs) * deepMs;
      const target = this._deep.get(deepBucket) ?? { buy: new Map(), sell: new Map() };
      mergeInto(target, flow);
      this._deep.set(deepBucket, target);
    }
    const deepStart = feed.deep?.columns[0]?.ts ?? fineStart;
    for (const bucket of [...this._deep.keys()]) if (bucket < deepStart) this._deep.delete(bucket);
    this._gaps = this._gaps.filter(([, to]) => to >= deepStart);
  }

  private _inGap(from: number, to: number): boolean {
    return this._gaps.some(([start, end]) => start < to && end >= from);
  }

  private _flowFor(from: number, to: number, bucketMs: number, deepMs: number | null): Flow {
    const flow: Flow = { buy: new Map(), sell: new Map() };
    for (let bucket = Math.floor(from / bucketMs) * bucketMs; bucket < to; bucket += bucketMs) {
      const fine = this._fine.get(bucket);
      if (fine !== undefined) mergeInto(flow, fine);
    }
    if (deepMs !== null) {
      for (let bucket = Math.ceil(from / deepMs) * deepMs; bucket + deepMs <= to; bucket += deepMs) {
        const deep = this._deep.get(bucket);
        if (deep !== undefined) mergeInto(flow, deep);
      }
    }
    return flow;
  }

  private _column(column: LiquidityColumn, columnMs: number, bucketMs: number, deepMs: number | null): LiquidityColumn {
    const end = column.ts + columnMs;
    const settled = this._coveredTo !== null && end <= this._coveredTo;
    if (settled) {
      const cached = this._cache.get(column);
      if (cached !== undefined) return cached;
    }
    let out: LiquidityColumn;
    if (this._coveredFrom === null || end <= this._coveredFrom || this._inGap(column.ts, end)) out = this._bareUncovered ? withoutFlow(column) : column;
    else {
      const flow = this._flowFor(column.ts, end, bucketMs, deepMs);
      out = { ...column, buy: entries(flow.buy), sell: entries(flow.sell) };
      if (this._liveFrom !== null && column.ts >= this._liveFrom) {
        out.prints = bigPrints(flow);
        out.printsFloor = 0;
      } else {
        delete out.prints;
        delete out.printsFloor;
      }
    }
    if (settled) this._cache.set(column, out);
    return out;
  }

  private _feedOf(feed: ColumnFeed): ColumnFeed {
    const bucketMs = feed.fine.columnMs;
    const deepMs = feed.deep?.columnMs ?? null;
    const coveredTo = this._coveredTo ?? -Infinity;
    const fine = feed.fine.columns.filter((column) => column.ts + bucketMs <= coveredTo).map((column) => this._column(column, bucketMs, bucketMs, deepMs));
    const deepTier = feed.deep;
    const deep = deepTier === null ? null : { columns: deepTier.columns.map((column) => this._column(column, deepTier.columnMs, bucketMs, deepMs)), columnMs: deepTier.columnMs };
    return { epoch: feed.epoch, deep, fine: { columns: fine, columnMs: bucketMs } };
  }
}

export function backfillEventHistory(
  l2: Pick<IndicatorL2, "eventHistory">,
  engine: EngineAbsorptionTracker,
  fromTs: number,
  priceLo: number,
  priceHi: number,
  onChunk: () => void,
  current: () => boolean,
  pacing: { gapMs: number; retryMs: number } = HISTORY_PACING,
): Promise<HistoryFill> {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const fetchChunk = (range: { fromTs: number; toTs: number; priceLo: number; priceHi: number }, attempt: number): Promise<{ trades: L2TradeBucket[]; heldFrom: number } | null> => {
    const trades: L2TradeBucket[] = [];
    let heldFrom = range.fromTs;
    const page = (cursor: unknown, pages: number): Promise<boolean> =>
      l2.eventHistory(range, cursor).then(
        (history) => {
          if (history === null || !current()) return false;
          trades.push(...history.trades);
          heldFrom = Math.max(heldFrom, history.heldFrom);
          const next = history.next?.trades ?? null;
          if (next === null) return true;
          return pages >= MAX_PAGES_PER_CHUNK ? false : page({ trades: next, wall_trades: null }, pages + 1);
        },
        () => false,
      );
    return page(undefined, 1).then((complete) => {
      if (complete) return { trades, heldFrom };
      if (!current() || attempt >= MAX_CHUNK_ATTEMPTS) return null;
      return wait(pacing.retryMs * attempt).then(() => fetchChunk(range, attempt + 1));
    });
  };
  const chunk = (): Promise<HistoryFill> => {
    const toTs = engine.coveredFrom;
    if (!current()) return Promise.resolve("short");
    if (toTs === null || toTs <= fromTs) return Promise.resolve("filled");
    const range = { fromTs: Math.max(fromTs, toTs - HISTORY_CHUNK_MS), toTs, priceLo, priceHi };
    return fetchChunk(range, 1).then((answer) => {
      if (answer === null || !current()) return "short";
      const from = Math.min(range.toTs, Math.max(range.fromTs, answer.heldFrom));
      if (from < range.toTs) {
        engine.backfill(answer.trades, from, range.toTs);
        if (engine.coveredFrom !== from) return "short";
        onChunk();
      }
      if (from > range.fromTs) return "held";
      if (range.fromTs <= fromTs) return "filled";
      return wait(pacing.gapMs).then(chunk);
    });
  };
  return chunk();
}
