import type { IndicatorL2 } from "../chart/indicatorL2";
import type { IndicatorLiquidity } from "../chart/indicatorLiquidity";
import { LiquidityGrid, liquidityPercentile, type LiquidityColumn } from "../indicators/passive-liquidity/liquidityGrid";

/** Read-only adapter for existing renderers. Never decodes archive cells as live deltas. */
export class HistoricalLiquidityGrid extends LiquidityGrid {
  private readonly _columns: readonly LiquidityColumn[];
  private readonly input: IndicatorLiquidity;
  private readonly source: IndicatorL2;
  private readonly identity: string;
  constructor(input: IndicatorLiquidity, source: IndicatorL2, identity: string) {
    super();
    this.input = input; this.source = source; this.identity = identity;
    let reference = 0, median = 0, last = -Infinity;
    this._columns = (source.view(0)?.fine.columns ?? []).map((column) => {
      if (column.ts - last > 1000) { reference = 0; median = 0; }
      const next = column as LiquidityColumn;
      const p95 = liquidityPercentile(next, 0.95), p50 = liquidityPercentile(next, 0.5);
      if (p95 > 0) reference = reference > 0 ? reference + 0.1 * (p95 - reference) : p95;
      if (p50 > 0) median = median > 0 ? median + 0.1 * (p50 - median) : p50;
      last = column.ts;
      return { ...next, reference, median };
    });
  }
  override get columns(): readonly LiquidityColumn[] { return this._columns; }
  override get historicalFeed() { return this.input.feed; }
  override get latest(): LiquidityColumn | null { return this.source.trusted() ? this._columns[this._columns.length - 1] ?? null : null; }
  override get rowWidth(): number { return this.input.rowWidth; }
  override get columnMs(): number { return 1000; }
  override get deepColumns(): readonly LiquidityColumn[] { return []; }
  override get coarseColumns(): readonly LiquidityColumn[] { return []; }
  override get epoch(): number { return this.input.feed.epoch; }
  override get version(): number { return this.input.version; }
  override get referenceSize(): number { return this.latest?.reference ?? 0; }
  override get synced(): boolean { return this.source.trusted(); }
  override get baseAsset(): string { return this.input.baseAsset; }
  override get symbol(): string { return (JSON.parse(this.identity) as string[])[2]; }
  override get provider(): string { return "DATABENTO"; }
  override get marketKind(): string { return (JSON.parse(this.identity) as string[])[1]; }
  override clockMs(): number { return (this.source.status("l2_view").lastTs ?? -1000) + 1000; }
  override apply(): boolean { throw new Error("Historical liquidity is immutable."); }
  override applyDecoded(): boolean { throw new Error("Historical liquidity is immutable."); }
}
