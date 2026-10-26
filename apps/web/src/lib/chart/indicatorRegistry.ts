import type { IndicatorDef, RuntimeIndicatorDef } from "./indicatorTypes";
import { rsiIndicator } from "../indicators/rsi/rsi";
import { emaIndicator } from "../indicators/ema/ema";
import { bollingerIndicator } from "../indicators/bollinger/bollinger";
import { smaIndicator } from "../indicators/sma/sma";
import { largeTradeBubblesIndicator } from "../indicators/large-trade-bubbles/largeTradeBubbles";
import { killzonesIndicator } from "../indicators/killzones/killzonesIndicator";
import { sessionProfileIndicator } from "../indicators/session-profile/sessionProfileIndicator";
import { sessionDeltaProfileIndicator } from "../indicators/session-delta-profile/sessionDeltaProfileIndicator";
import { sessionVwapIndicator } from "../indicators/session-vwap/sessionVwap";
import { vwapBandsIndicator } from "../indicators/vwap-bands/vwapBands";
import { vpinCloudIndicator } from "../indicators/vpin-cloud/vpinCloudIndicator";
import { whaleDetectorIndicator } from "../indicators/whale-detector/whaleDetectorIndicator";
import { orderFlowIndicator } from "../indicators/order-flow/orderFlowIndicator";
import { deltaDivergenceIndicator } from "../indicators/delta-divergence/deltaDivergenceIndicator";
import { cvdDivergenceIndicator } from "../indicators/cvd-divergence/cvdDivergenceIndicator";
import { volumeDeltaProfileOhlcIndicator } from "../indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlc";
import { volumeDeltaProfileTickIndicator } from "../indicators/volume-delta-profile-tick/volumeDeltaProfileTick";
import { pivotPointsIndicator } from "../indicators/pivot-points/pivotPoints";
import { pivotSupportResistanceIndicator } from "../indicators/pivot-support-resistance/pivotSupportResistance";
import { passiveLiquidityIndicator } from "../indicators/passive-liquidity/passiveLiquidityIndicator";
import { marketStructureIndicator } from "../indicators/market-structure/marketStructure";
import { swingAlphabetProfileIndicator } from "../indicators/swing-alphabet-profile/swingAlphabetProfile";
import { aggressiveOrdersIndicator } from "../indicators/aggressive-orders/aggressiveOrdersIndicator";
import { liveDeltaProfileIndicator } from "../indicators/live-delta-profile/liveDeltaProfileIndicator";
import { liveOrderBookProfileIndicator } from "../indicators/live-order-book-profile/liveOrderBookProfileIndicator";
import { aggressiveOrdersProfileIndicator } from "../indicators/aggressive-orders-profile/aggressiveOrdersProfileIndicator";
import { absorptionIndicator } from "../indicators/absorption-detector/absorptionIndicator";
import { fvgBoxesIndicator } from "../indicators/fvg-boxes/fvgBoxes";
import { l2SupportResistanceIndicator } from "../indicators/l2-support-resistance/l2SupportResistanceIndicator";
import { l2BookMapIndicator } from "../indicators/l2-book-map/l2BookMapIndicator";
import { fvgDeltaIndicator } from "../indicators/fvg-delta/fvgDelta";
import { classicOrderBlocksIndicator } from "../indicators/classic-order-blocks/classicOrderBlocks";
import { institutionalOrderBlocksIndicator } from "../indicators/institutional-order-blocks/institutionalOrderBlocks";
import { institutionalOrderBlocksV2Indicator } from "../indicators/institutional-order-blocks-v2/institutionalOrderBlocksV2";
import { l1OrderBlocksIndicator } from "../indicators/l1-order-blocks/l1OrderBlocks";
import { sessionLevelsIndicator } from "../indicators/session-levels/sessionLevelsIndicator";
import { liquidityVoidsIndicator } from "../indicators/liquidity-voids/liquidityVoidsIndicator";
import { emptyOrderbookIndicator } from "../indicators/empty-orderbook/emptyOrderbookIndicator";
import { l2FeedStatusIndicator } from "../indicators/l2-feed-status/l2FeedStatus";
import { whaleLimitOrderHeatmapIndicator } from "../indicators/whale-limit-order-heatmap/whaleLimitOrderHeatmapIndicator";
import { icebergIndicator } from "../indicators/iceberg-detector/icebergIndicator";
import { exhaustionIndicator } from "../indicators/exhaustion/exhaustionIndicator";
import { initiativeIndicator } from "../indicators/initiative/initiativeIndicator";
import { liveRangeControlIndicator } from "../indicators/live-range-control/liveRangeControlIndicator";
import type { HistoricalIndicatorCapability } from "../archive/historicalIndicatorSeries";
import type { BarFrame } from "../../types/frames";

export const INDICATOR_REGISTRY = [
  rsiIndicator,
  emaIndicator,
  bollingerIndicator,
  smaIndicator,
  largeTradeBubblesIndicator,
  killzonesIndicator,
  orderFlowIndicator,
  whaleDetectorIndicator,
  deltaDivergenceIndicator,
  cvdDivergenceIndicator,
  sessionProfileIndicator,
  sessionDeltaProfileIndicator,
  sessionVwapIndicator,
  vwapBandsIndicator,
  vpinCloudIndicator,
  volumeDeltaProfileOhlcIndicator,
  volumeDeltaProfileTickIndicator,
  pivotPointsIndicator,
  pivotSupportResistanceIndicator,
  passiveLiquidityIndicator,
  marketStructureIndicator,
  swingAlphabetProfileIndicator,
  aggressiveOrdersIndicator,
  liveDeltaProfileIndicator,
  liveOrderBookProfileIndicator,
  aggressiveOrdersProfileIndicator,
  absorptionIndicator,
  fvgBoxesIndicator,
  l2SupportResistanceIndicator,
  l2BookMapIndicator,
  fvgDeltaIndicator,
  classicOrderBlocksIndicator,
  institutionalOrderBlocksIndicator,
  institutionalOrderBlocksV2Indicator,
  l1OrderBlocksIndicator,
  sessionLevelsIndicator,
  liquidityVoidsIndicator,
  emptyOrderbookIndicator,
  l2FeedStatusIndicator,
  whaleLimitOrderHeatmapIndicator,
  icebergIndicator,
  exhaustionIndicator,
  initiativeIndicator,
  liveRangeControlIndicator,
] as const satisfies readonly IndicatorDef[];

if (
  new Set(INDICATOR_REGISTRY.map((def) => def.id)).size !==
  INDICATOR_REGISTRY.length
) {
  throw new Error("indicator registry: duplicate indicator id");
}

export type IndicatorId = (typeof INDICATOR_REGISTRY)[number]["id"];

type HistoricalIndicatorPolicy = Readonly<{
  requiredCapabilities?: readonly HistoricalIndicatorCapability[];
  requiresBinanceCandleFlow?: boolean;
  unavailableReason?: string;
}>;

export type HistoricalIndicatorAvailability = Readonly<{
  available: boolean;
  reason: string | null;
}>;

const OHLCV_POLICY: HistoricalIndicatorPolicy = Object.freeze({
  requiredCapabilities: ["ohlcv"] as const,
});
const CANDLE_FLOW_POLICY: HistoricalIndicatorPolicy = Object.freeze({
  requiredCapabilities: ["ohlcv", "buy_volume"] as const,
});
const TRADE_FAMILY_POLICY: HistoricalIndicatorPolicy = Object.freeze({
  requiredCapabilities: ["ohlcv", "trade_families"] as const,
});

export const HISTORICAL_INDICATOR_POLICIES: Readonly<
  Record<IndicatorId, HistoricalIndicatorPolicy>
> = Object.freeze({
  rsi: OHLCV_POLICY,
  ema: OHLCV_POLICY,
  bollinger: OHLCV_POLICY,
  sma: OHLCV_POLICY,
  largeTradeBubbles: {
    unavailableReason:
      "Needs every trade in each bar; the archive keeps only the largest prints of each minute.",
  },
  killzones: OHLCV_POLICY,
  orderFlow: CANDLE_FLOW_POLICY,
  largeTradeDetector: TRADE_FAMILY_POLICY,
  deltaDivergence: CANDLE_FLOW_POLICY,
  cvdDivergence: CANDLE_FLOW_POLICY,
  sessionVolumeProfile: TRADE_FAMILY_POLICY,
  sessionDeltaProfile: CANDLE_FLOW_POLICY,
  sessionVwap: OHLCV_POLICY,
  vwapBands: {
    unavailableReason:
      "Prices every bar by the terminal's own prints, with no candle fallback; a Historical Mode replay carries no trades.",
  },
  vpinCloud: TRADE_FAMILY_POLICY,
  volumeDeltaProfileOhlc: CANDLE_FLOW_POLICY,
  volumeDeltaProfileTick: CANDLE_FLOW_POLICY,
  pivotPoints: OHLCV_POLICY,
  pivotSupportResistance: OHLCV_POLICY,
  passiveLiquidity: {
    requiredCapabilities: ["ohlcv", "l2_states"],
  },
  marketStructure: OHLCV_POLICY,
  swingAlphabetProfile: OHLCV_POLICY,
  aggressiveOrders: {
    requiredCapabilities: ["ohlcv", "l2_prints"],
  },
  liveDeltaProfile: CANDLE_FLOW_POLICY,
  liveOrderBookProfile: {
    requiredCapabilities: ["ohlcv", "l2_states"],
  },
  aggressiveOrdersProfile: {
    unavailableReason:
      "Requires the live heatmap's columns, which candle archives do not contain.",
  },
  absorptionDetector: {
    requiredCapabilities: ["ohlcv", "l2_states", "l2_prints"],
  },
  icebergDetector: {
    unavailableReason:
      "Requires the live order stream and the runtime's iceberg history, which candle archives do not contain.",
  },
  exhaustion: {
    unavailableReason:
      "Requires the runtime's live exhaustion engine and its shade history, which candle archives do not contain.",
  },
  initiative: {
    unavailableReason:
      "Requires the runtime's live Initiative Continuation engine and its band history, which candle archives do not contain.",
  },
  fvgBoxes: CANDLE_FLOW_POLICY,
  l2SupportResistance: {
    requiredCapabilities: ["ohlcv", "l2_states", "l2_walls"],
  },
  l2BookMap: {
    requiredCapabilities: ["ohlcv", "l2_states"],
  },
  fvgDelta: CANDLE_FLOW_POLICY,
  classicOrderBlocks: OHLCV_POLICY,
  institutionalOrderBlocks: {
    requiredCapabilities: ["ohlcv", "l2_states"],
  },
  institutionalOrderBlocksV2: {
    requiredCapabilities: ["ohlcv", "l2_states", "l2_walls"],
  },
  l1OrderBlocks: OHLCV_POLICY,
  sessionLevels: OHLCV_POLICY,
  liquidityVoids: {
    requiredCapabilities: ["ohlcv", "l2_states"],
  },
  emptyOrderbook: {
    requiredCapabilities: ["ohlcv", "l2_states"],
  },
  l2FeedStatus: {
    requiredCapabilities: ["ohlcv", "l2_states"],
  },
  whaleLimitOrderHeatmap: {
    requiredCapabilities: ["ohlcv", "l2_states", "l2_walls"],
  },
  liveRangeControl: {
    unavailableReason: "Requires the live heatmap's columns, which candle archives do not contain.",
  },
});

export const CANDLE_FLOW_INDICATOR_IDS: readonly IndicatorId[] = Object.freeze(
  (
    Object.entries(HISTORICAL_INDICATOR_POLICIES) as [
      IndicatorId,
      HistoricalIndicatorPolicy,
    ][]
  )
    .filter(
      ([, policy]) =>
        policy.requiredCapabilities?.includes("buy_volume") === true,
    )
    .map(([id]) => id),
);

export function historicalIndicatorAvailability(
  id: IndicatorId,
  capabilities: ReadonlySet<HistoricalIndicatorCapability>,
  provider: BarFrame["provider"] | null = null,
): HistoricalIndicatorAvailability {
  const policy = HISTORICAL_INDICATOR_POLICIES[id];
  if (policy.unavailableReason !== undefined) {
    return Object.freeze({
      available: false,
      reason: policy.unavailableReason,
    });
  }
  if (policy.requiresBinanceCandleFlow === true && provider !== "BINANCE") {
    return Object.freeze({
      available: false,
      reason:
        "Historical candle-flow studies are available only for Binance spot and perpetual archives.",
    });
  }
  const missing = policy.requiredCapabilities?.find(
    (capability) => !capabilities.has(capability),
  );
  if (missing === undefined)
    return Object.freeze({ available: true, reason: null });
  if (missing === "trade_families") {
    return Object.freeze({
      available: false,
      reason:
        "Needs archived trade summaries verified for this instrument and catalog snapshot.",
    });
  }
  if (missing === "l2_states") return Object.freeze({ available: false,
    reason: "Needs published, verified historical L2 states for this instrument. Zoom to an available August 2026 hour." });
  if (missing === "l2_walls") return Object.freeze({ available: false,
    reason: "Needs qualified historical wall history for this instrument and date." });
  if (missing === "l2_prints") return Object.freeze({ available: false,
    reason: "Needs qualified individual historical trades for this instrument and date." });
  return Object.freeze({
    available: false,
    reason: `Requires ${missing.replaceAll("_", " ")} from every candle in the selected range.`,
  });
}

export function isRuntimeIndicatorDef(
  def: IndicatorDef,
): def is RuntimeIndicatorDef<unknown, unknown> {
  return def.kind === "runtime";
}

export const RUNTIME_INDICATOR_DEFS: readonly RuntimeIndicatorDef<
  unknown,
  unknown
>[] = (INDICATOR_REGISTRY as readonly IndicatorDef[]).filter(
  isRuntimeIndicatorDef,
);
