import { bandMaxSizes, bandSizes, type LiquidityColumn } from "./liquidityGrid";

/** One side of a band straight from the column, without the pair the style builds; the known styles only. */
function sideOf(bandSizesOf: BandSizesOf, column: LiquidityColumn, bandIndex: number, rows: number, side: "bid" | "ask"): number {
  if (bandSizesOf !== bandSizes && bandSizesOf !== bandMaxSizes) return bandSizesOf(column, bandIndex, rows)[side];
  const values = side === "bid" ? column.bid : column.ask;
  const from = Math.max(column.lo, bandIndex * rows);
  const to = Math.min(column.hi, (bandIndex + 1) * rows - 1);
  let size = 0;
  if (bandSizesOf === bandSizes) {
    for (let row = from; row <= to; row += 1) size += values[row - column.lo];
  } else {
    for (let row = from; row <= to; row += 1) if (values[row - column.lo] > size) size = values[row - column.lo];
  }
  return size;
}

export type BandSizesOf = (column: LiquidityColumn, bandIndex: number, clusterRows: number) => { bid: number; ask: number };

export interface BandSizeReader {
  both(column: LiquidityColumn, bandIndex: number): { bid: number; ask: number };
  side(column: LiquidityColumn, bandIndex: number, side: "bid" | "ask"): number;
}

export interface BandSizeCache {
  reader(bandSizesOf: BandSizesOf, clusterRows: number): BandSizeReader;
  readonly heldBytes: number;
}

interface BandSizeTable {
  readonly of: BandSizesOf;
  readonly rows: number;
  readonly first: number;
  readonly last: number;
  readonly sizes: Float64Array;
}

const BYTES_PER_BAND = 16;

export const DEFAULT_BAND_SIZE_CACHE_BYTES = 64 * 1024 * 1024;

type SizedColumn = LiquidityColumn & { bandTable?: BandSizeTable };

export function createBandSizeCache(capBytes: number = DEFAULT_BAND_SIZE_CACHE_BYTES): BandSizeCache {
  let held = 0;
  const registry = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<number>((bytes) => {
      held -= bytes;
    })
    : null;

  return {
    get heldBytes(): number {
      return held;
    },
    reader(bandSizesOf: BandSizesOf, clusterRows: number): BandSizeReader {
      const rows = Math.max(1, Math.floor(clusterRows));

      const tableOf = (column: SizedColumn): BandSizeTable | null => {
        const stored = column.bandTable;
        if (stored !== undefined && stored.of === bandSizesOf && stored.rows === rows) return stored;
        if (registry === null || !Object.isExtensible(column)) return null;
        const first = Math.floor(column.lo / rows);
        const last = Math.floor(column.hi / rows);
        const bytes = (last - first + 1) * BYTES_PER_BAND;
        if (!(bytes > 0) || held + bytes > capBytes) return null;
        const sizes = new Float64Array((last - first + 1) * 2);
        for (let band = first; band <= last; band += 1) {
          const read = bandSizesOf(column, band, rows);
          sizes[(band - first) * 2] = read.bid;
          sizes[(band - first) * 2 + 1] = read.ask;
        }
        const table: BandSizeTable = { of: bandSizesOf, rows, first, last, sizes };
        column.bandTable = table;
        held += bytes;
        registry.register(column, bytes);
        return table;
      };

      return {
        both(column, bandIndex) {
          const table = tableOf(column);
          if (table === null || bandIndex < table.first || bandIndex > table.last) return bandSizesOf(column, bandIndex, rows);
          const at = (bandIndex - table.first) * 2;
          return { bid: table.sizes[at], ask: table.sizes[at + 1] };
        },
        side(column, bandIndex, side) {
          const table = tableOf(column);
          if (table === null || bandIndex < table.first || bandIndex > table.last) return sideOf(bandSizesOf, column, bandIndex, rows, side);
          return table.sizes[(bandIndex - table.first) * 2 + (side === "bid" ? 0 : 1)];
        },
      };
    },
  };
}

export const bandSizeCache: BandSizeCache = createBandSizeCache();
