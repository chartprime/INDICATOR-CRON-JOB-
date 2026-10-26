import type { HistoricalInstrument } from "./historicalCatalog";
import type { IndicatorId } from "../chart/indicatorRegistry";
import { liquidityStyleFor } from "../indicators/passive-liquidity/liquidityStyle";

export const HISTORICAL_L2_SETTINGS_IDS: ReadonlySet<IndicatorId> = new Set([
  "passiveLiquidity", "l2SupportResistance", "l2BookMap", "whaleLimitOrderHeatmap",
  "liveOrderBookProfile", "aggressiveOrders", "absorptionDetector",
]);

export function historicalLiquidityDefaults(instrument: HistoricalInstrument) {
  const symbol = instrument.group === "Futures" ? `/${instrument.symbol}` : instrument.symbol;
  const style = liquidityStyleFor(instrument.chartIdentity.provider, symbol, instrument.chartIdentity.marketKind);
  return { ...style.defaultSettings, clusterRows: 1, quietBands: 0, minBandSize: 0 };
}

