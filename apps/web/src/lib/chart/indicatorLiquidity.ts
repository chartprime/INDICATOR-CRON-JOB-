import type { ColumnFeed } from "../indicators/absorption-detector/absorptionColumns";
import type { ColumnHistoryStream } from "../indicators/passive-liquidity/columnHistoryStream";
import type { LiquidityGrid } from "../indicators/passive-liquidity/liquidityGrid";

export interface IndicatorLiquidity {
  readonly feed: ColumnFeed;
  readonly rowWidth: number;
  readonly baseAsset: string;
  readonly version: number;
  readonly history?: ColumnHistoryStream | null;
  readonly heatmapClusterRows?: number | null;
  /** Historical input is bounded by knowledge time at the current bar's close. */
  readonly atTime?: (timeMs: number) => IndicatorLiquidity | null;
}

export function indicatorLiquidityOf(
  grid: LiquidityGrid | null,
  history: ColumnHistoryStream | null = null,
  heatmapClusterRows: () => number | null = () => null,
): IndicatorLiquidity | null {
  if (!grid) return null;
  return {
    get feed(): ColumnFeed {
      return {
        epoch: grid.epoch,
        deep:
          grid.deepColumns.length > 0
            ? { columns: grid.deepColumns, columnMs: grid.deepColumnMs }
            : null,
        fine: { columns: grid.columns, columnMs: grid.columnMs },
      };
    },
    get rowWidth(): number {
      return grid.rowWidth;
    },
    get baseAsset(): string {
      return grid.baseAsset;
    },
    get version(): number {
      return grid.version;
    },
    get heatmapClusterRows(): number | null {
      return heatmapClusterRows();
    },
    history,
  };
}
