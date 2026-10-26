import type { LiquidityFrame, L2ViewFrame } from "../../types/frames";
import type { ColumnFeed } from "../indicators/absorption-detector/absorptionColumns";
import { DEFAULT_LIQUIDITY_CAPACITY, DEFAULT_LIQUIDITY_DEEP_CAPACITY, LiquidityDecoder, LiquidityGrid, type DecodedLiquidity } from "../indicators/passive-liquidity/liquidityGrid";
import { laneFoldFor } from "../indicators/passive-liquidity/liquidityStyle";

/** Lane 0's yardstick at a time, on the fine or the deep tier, for a lane judged by it. */
export type LaneYardstick = (ts: number, deep: boolean) => { reference: number; median: number; ceiling: number } | null;
import type { ApplyOutcome, L2LaneInfo } from "./types";


function liquidityFrameOf(frame: L2ViewFrame): LiquidityFrame {
  const body = { type: "liquidity" as const, symbol: frame.symbol, ts: frame.ts, seq: frame.seq, reset: frame.reset, row_width: frame.row_width, column_ms: frame.column_ms, columns: frame.columns };
  return frame.provider === "BINANCE"
    ? { ...body, provider: "BINANCE", marketKind: frame.marketKind }
    : { ...body, provider: frame.provider, assetClass: frame.assetClass } as LiquidityFrame;
}

function chainKey(frame: L2ViewFrame): string {
  return `${frame.lane}:${frame.column_ms}`;
}

export interface DecodedLane {
  readonly outcome: ApplyOutcome;
  readonly decoded: DecodedLiquidity | null;
}

export class LaneDecoder {
  private _decoders = new Map<number, LiquidityDecoder>();
  private _seqs = new Map<string, number>();
  private _untrusted = new Set<string>();

  decode(frame: L2ViewFrame): DecodedLane {
    const key = chainKey(frame);
    const last = this._seqs.get(key);
    if (!frame.reset && last !== undefined && !this._untrusted.has(key) && frame.seq <= last) return Object.freeze({ outcome: "duplicate", decoded: null });
    let decoder = this._decoders.get(frame.lane);
    if (decoder === undefined) {
      decoder = new LiquidityDecoder();
      this._decoders.set(frame.lane, decoder);
    }
    const decoded = decoder.decode(liquidityFrameOf(frame));
    if (!decoded.accepted) {
      this._untrusted.add(key);
      return Object.freeze({ outcome: "gap", decoded });
    }
    if (frame.reset) this._untrusted.delete(key);
    this._seqs.set(key, frame.seq);
    return Object.freeze({ outcome: "applied", decoded });
  }

  markUntrusted(): void {
    for (const key of this._seqs.keys()) this._untrusted.add(key);
  }

  clear(): void {
    this._decoders = new Map();
    this._seqs = new Map();
    this._untrusted = new Set();
  }
}

export class LaneGrids {
  private _grids = new Map<number, LiquidityGrid>();
  private _seqs = new Map<string, number>();
  private _untrusted = new Set<string>();
  private _lastTs: number | null = null;
  private readonly _decoder = new LaneDecoder();
  private readonly _yardstick: LaneYardstick | null;

  constructor({ yardstick = null }: { yardstick?: LaneYardstick | null } = {}) {
    this._yardstick = yardstick;
  }

  get lastTs(): number | null {
    return this._lastTs;
  }

  get synced(): boolean {
    if (this._grids.size === 0) return false;
    for (const lane of this._grids.keys()) if (!this.laneSynced(lane)) return false;
    return true;
  }

  get seq(): number | null {
    let latest: number | null = null;
    for (const seq of this._seqs.values()) latest = latest === null ? seq : Math.max(latest, seq);
    return latest;
  }

  apply(frame: L2ViewFrame): ApplyOutcome {
    return this.applyDecoded(frame, this._decoder.decode(frame));
  }

  applyDecoded(frame: L2ViewFrame, result: DecodedLane): ApplyOutcome {
    if (result.outcome === "duplicate" || result.decoded === null) return "duplicate";
    const key = chainKey(frame);
    // On a market read by the biggest tick the lane's columns carry lane 0's yardstick, so a wall is judged the same at every zoom.
    const yardstick = this._yardstick;
    if (yardstick !== null && laneFoldFor(frame.provider, frame.symbol, "marketKind" in frame ? frame.marketKind : frame.assetClass) === "max") {
      for (const column of result.decoded.columns) {
        const own = yardstick(column.ts, frame.tier === "deep");
        if (own === null) continue;
        column.reference = own.reference;
        column.median = own.median;
        column.ceiling = own.ceiling;
      }
    }
    let grid = this._grids.get(frame.lane);
    if (grid === undefined) {
      // A lane's columns are a factor wider than lane 0's, so this many of them span the same time lane 0 can hold: a zoom never shows a shorter past.
      const factor = 2 ** frame.lane;
      grid = new LiquidityGrid(Math.ceil(DEFAULT_LIQUIDITY_CAPACITY / factor), Math.ceil(DEFAULT_LIQUIDITY_DEEP_CAPACITY / factor));
      this._grids.set(frame.lane, grid);
    }
    if (!grid.applyDecoded(liquidityFrameOf(frame), result.decoded) || result.outcome === "gap") {
      this._untrusted.add(key);
      return "gap";
    }
    if (frame.reset) this._untrusted.delete(key);
    this._seqs.set(key, frame.seq);
    this._lastTs = Math.max(this._lastTs ?? frame.ts, frame.ts);
    return "applied";
  }

  lanes(): readonly L2LaneInfo[] {
    const out: L2LaneInfo[] = [];
    for (const [lane, grid] of [...this._grids].sort(([a], [b]) => a - b)) {
      const last = grid.columns[grid.columns.length - 1];
      if (last === undefined) continue;
      out.push(Object.freeze({
        lane,
        rowWidth: grid.rowWidth,
        columnMs: grid.columnMs,
        deepColumnMs: grid.deepColumnMs,
        priceLo: last.lo * grid.rowWidth,
        priceHi: (last.hi + 1) * grid.rowWidth,
      }));
    }
    return Object.freeze(out);
  }

  grid(lane: number): LiquidityGrid | null {
    return this._grids.get(lane) ?? null;
  }

  view(lane: number): ColumnFeed | null {
    const grid = this._grids.get(lane);
    if (grid === undefined || grid.columns.length === 0) return null;
    return {
      epoch: grid.epoch,
      deep: grid.deepColumns.length > 0 ? { columns: grid.deepColumns, columnMs: grid.deepColumnMs } : null,
      fine: { columns: grid.columns, columnMs: grid.columnMs },
    };
  }

  laneSynced(lane: number): boolean {
    const grid = this._grids.get(lane);
    if (grid === undefined || !grid.synced) return false;
    for (const key of this._untrusted) if (key.startsWith(`${lane}:`)) return false;
    return true;
  }

  markUntrusted(): void {
    for (const key of this._seqs.keys()) this._untrusted.add(key);
    this._decoder.markUntrusted();
  }

  clear(): void {
    this._grids = new Map();
    this._seqs = new Map();
    this._untrusted = new Set();
    this._lastTs = null;
    this._decoder.clear();
  }
}
