import type { LiquidityColumn } from "../../passive-liquidity/liquidityGrid";

export interface StoreColumnWire {
  ts: number;
  lo: number;
  hi: number;
  bid: readonly (readonly [number, number])[];
  ask: readonly (readonly [number, number])[];
  buy?: readonly (readonly [number, number])[];
  sell?: readonly (readonly [number, number])[];
}

export interface LiquidityStore {
  geometry: { rowWidth: number; deepColumnMs: number };
  deep: readonly StoreColumnWire[];
}

export interface StoreColumns {
  columns: LiquidityColumn[];
  rowWidth: number;
  columnMs: number;
}

export function decodeStoreColumns(store: LiquidityStore): StoreColumns {
  const columns: LiquidityColumn[] = [];
  let previous: LiquidityColumn | null = null;
  for (const wire of store.deep) {
    const span = wire.hi - wire.lo + 1;
    const bid = new Float64Array(span);
    const ask = new Float64Array(span);
    if (previous !== null) {
      for (let row = Math.max(wire.lo, previous.lo); row <= Math.min(wire.hi, previous.hi); row += 1) {
        bid[row - wire.lo] = previous.bid[row - previous.lo];
        ask[row - wire.lo] = previous.ask[row - previous.lo];
      }
    }
    for (const [offset, size] of wire.bid) bid[offset] = size;
    for (const [offset, size] of wire.ask) ask[offset] = size;
    const column: LiquidityColumn = {
      ts: wire.ts,
      lo: wire.lo,
      hi: wire.hi,
      bid,
      ask,
      buy: (wire.buy ?? []).map(([offset, size]) => [wire.lo + offset, size]),
      sell: (wire.sell ?? []).map(([offset, size]) => [wire.lo + offset, size]),
    };
    columns.push(column);
    previous = column;
  }
  return { columns, rowWidth: store.geometry.rowWidth, columnMs: store.geometry.deepColumnMs };
}
