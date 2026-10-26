import type { LiquidityColumn } from "../indicators/passive-liquidity/liquidityGrid";
import type { HistoricalL2Row } from "./historicalL2Client";

export type HistoricalBookSecond = Readonly<{ openNs: string; closeNs: string; knownNs: string;
  knownKey: readonly string[] | null; segmentId: string | null; complete: boolean; trusted: boolean;
  reason: string; flow: Readonly<{ BUY: number; SELL: number; UNKNOWN: number; count: number }>;
  column: LiquidityColumn | null }>;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const decimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const range = (v: unknown): v is readonly [number, number] | null => v === null || Array.isArray(v) && v.length === 2 && natural(v[0]) && natural(v[1]) && v[0] <= v[1];
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

/** Fold one page at a time. Retained data contains display cells, not raw JSON rows. */
export class HistoricalL2States {
  private readonly seconds: HistoricalBookSecond[] = [];
  private pending: { row: HistoricalL2Row; levels: Record<string, unknown>[] } | null = null;
  private lastPosition = -1n;
  private closed = false;
  private cells = 0;
  private rows = 0;
  readonly instrumentId: string;
  readonly derivationId: string;
  readonly tickSize: string;

  constructor(instrumentId: string, derivationId: string, tickSize: string) {
    if (!sha(derivationId) || !["0.25", "0.01"].includes(tickSize)) throw new Error("invalid historical book geometry");
    this.instrumentId = instrumentId;
    this.derivationId = derivationId;
    this.tickSize = tickSize;
  }

  push(rows: readonly HistoricalL2Row[]): void {
    if (this.closed) throw new Error("historical book stream already sealed");
    for (const row of rows) {
      this.rows += 1;
      if (this.rows > 100000 || row.schema !== "historical-l2-second/1" || row.instrument_id !== this.instrumentId
          || row.derivation_id !== this.derivationId || !decimal(row.append_position)
          || BigInt(row.append_position) <= this.lastPosition || !decimal(row.known_ns)) throw new Error("historical book identity/order admission failed");
      this.lastPosition = BigInt(row.append_position);
      if (row.family === "l2_book_segment") { this.flush(); continue; }
      if (row.family !== "l2_level_state_1s") throw new Error("unexpected historical book family");
      if (row.payload.row_kind === "coverage") {
        this.flush();
        this.pending = { row, levels: [] };
      } else if (row.payload.row_kind === "level") {
        if (this.pending === null || row.known_ns !== this.pending.row.known_ns
            || JSON.stringify(row.known_key) !== JSON.stringify(this.pending.row.known_key)
            || row.payload.open_ns !== this.pending.row.payload.open_ns || row.payload.close_ns !== this.pending.row.payload.close_ns) {
          throw new Error("historical book level has no matching coverage header");
        }
        if (this.pending.levels.length >= 4096) throw new Error("historical book level count exceeds admission");
        this.pending.levels.push(row.payload as Record<string, unknown>);
      } else throw new Error("unexpected historical book row kind");
    }
  }

  finish(): readonly HistoricalBookSecond[] {
    if (!this.closed) { this.flush(); this.closed = true; }
    return Object.freeze(this.seconds.slice());
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return;
    const { row, levels } = pending;
    const p = row.payload;
    if (!decimal(p.open_ns) || !decimal(p.close_ns) || !decimal(p.covered_from_ns) || BigInt(p.open_ns) % 1000000000n !== 0n
        || BigInt(p.close_ns) < BigInt(p.open_ns) || BigInt(p.close_ns) > BigInt(p.open_ns) + 1000000000n
        || BigInt(p.covered_from_ns) < BigInt(p.open_ns) || BigInt(p.covered_from_ns) > BigInt(p.close_ns)
        || BigInt(row.known_ns) < BigInt(p.close_ns) || typeof p.complete !== "boolean" || typeof p.trusted !== "boolean"
        || typeof p.point_prefix !== "boolean" || p.point_prefix !== (p.covered_from_ns === p.close_ns)
        || p.complete !== (BigInt(p.covered_from_ns) === BigInt(p.open_ns) && BigInt(p.close_ns) === BigInt(p.open_ns) + 1000000000n)
        || p.trusted !== (p.segment_id !== null) || p.segment_id !== null && !sha(p.segment_id)
        || typeof p.reason !== "string" || p.reason.length < 1 || p.reason.length > 128 || p.tick_size !== this.tickSize
        || p.depth_limit !== 10 || !range(p.bid_range) || !range(p.ask_range) || !record(p.flow)) throw new Error("invalid historical book coverage");
    const flow = p.flow as Record<string, number>;
    if (!["BUY", "SELL", "UNKNOWN", "count"].every((key) => natural(flow[key]))) throw new Error("invalid historical book flow");
    const volume = flow.BUY + flow.SELL + flow.UNKNOWN;
    if (!Number.isSafeInteger(volume) || volume < flow.count || (volume === 0) !== (flow.count === 0)) throw new Error("historical flow volume/count differs");
    if (this.seconds.length >= 7200) throw new Error("historical book interval count exceeds admission");
    let column: LiquidityColumn | null = null;
    if (p.complete && p.trusted && p.bid_range !== null && p.ask_range !== null) {
      const lo = Math.min(p.bid_range[0], p.ask_range[0]), hi = Math.max(p.bid_range[1], p.ask_range[1]);
      const length = hi - lo + 1;
      if (length > 2048 || this.cells + length * 2 > 1_000_000) throw new Error("historical book cells exceed admission");
      this.cells += length * 2;
      const bid = new Float64Array(length).fill(NaN), ask = new Float64Array(length).fill(NaN);
      bid.fill(0, p.bid_range[0] - lo, p.bid_range[1] - lo + 1);
      ask.fill(0, p.ask_range[0] - lo, p.ask_range[1] - lo + 1);
      const buy: Array<readonly [number, number]> = [], sell: Array<readonly [number, number]> = [];
      const seen = new Set<number>();
      for (const level of levels) {
        if (!natural(level.price_key) || seen.has(level.price_key) || !natural(level.buy_volume) || !natural(level.sell_volume)) throw new Error("invalid historical book level");
        seen.add(level.price_key);
        for (const [side, data, bounds] of [["bid", bid, p.bid_range], ["ask", ask, p.ask_range]] as const) {
          const size = level[`${side}_size`], inside = level.price_key >= bounds[0] && level.price_key <= bounds[1];
          if (inside ? !natural(size) : size !== null) throw new Error("historical book unknown/zero semantics differ");
          if (inside) data[level.price_key - lo] = size as number;
        }
        if (level.buy_volume > 0) buy.push([level.price_key, level.buy_volume]);
        if (level.sell_volume > 0) sell.push([level.price_key, level.sell_volume]);
      }
      column = { ts: Number(BigInt(p.open_ns) / 1000000n), lo, hi, bid, ask, buy, sell };
    }
    this.seconds.push(Object.freeze({ openNs: p.open_ns, closeNs: p.close_ns, knownNs: row.known_ns,
      knownKey: row.known_key, segmentId: p.segment_id as string | null, complete: p.complete, trusted: p.trusted,
      reason: p.reason, flow: Object.freeze({ ...p.flow }) as HistoricalBookSecond["flow"], column }));
  }
}

export function historicalSecondsAt(seconds: readonly HistoricalBookSecond[], knownNs: string, sourceKey?: readonly string[]): readonly HistoricalBookSecond[] {
  if (!decimal(knownNs) || sourceKey !== undefined && (sourceKey.length !== 4 || !sourceKey.every(decimal))) throw new Error("invalid historical book time cut");
  return seconds.filter((second) => {
    if (BigInt(second.knownNs) > BigInt(knownNs)) return false;
    if (sourceKey === undefined || second.knownKey === null) return true;
    for (let index = 0; index < 4; index += 1) {
      if (BigInt(second.knownKey[index]) > BigInt(sourceKey[index])) return false;
      if (BigInt(second.knownKey[index]) < BigInt(sourceKey[index])) return true;
    }
    return true;
  });
}
