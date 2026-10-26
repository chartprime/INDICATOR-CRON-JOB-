import { useEffect, useMemo, type RefObject, type Dispatch, type SetStateAction } from "react";
import type { ChartPanelHandle } from "../chart/ChartPanel";
import type { HistoricalInstrument } from "../../lib/archive/historicalCatalog";
import type { IndicatorId } from "../../lib/chart/indicatorRegistry";
import type { LiveIndicatorExtras } from "../../lib/chart/liveIndicatorExtras";
import { LiquidityHeatmapSettingsModal } from "../../lib/indicators/passive-liquidity/LiquidityHeatmapSettingsModal";
import { historicalLiquidityDefaults } from "../../lib/archive/historicalL2Settings";
import { L2SupportResistanceSettingsModal } from "../../lib/indicators/l2-support-resistance/L2SupportResistanceSettingsModal";
import { L2BookMapSettingsModal } from "../../lib/indicators/l2-book-map/l2BookMapSettings";
import { WhaleHeatmapSettingsModal } from "../../lib/indicators/whale-limit-order-heatmap/WhaleHeatmapSettingsModal";
import { LiveOrderBookProfileSettingsModal } from "../../lib/indicators/live-order-book-profile/LiveOrderBookProfileSettingsModal";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS } from "../../lib/indicators/live-order-book-profile/liveOrderBookProfileSettings";
import { AggressiveOrdersSettingsModal } from "../../lib/indicators/aggressive-orders/AggressiveOrdersSettingsModal";
import { defaultAggressiveOrdersSettingsFor, suggestedMinVolumeFor } from "../../lib/indicators/aggressive-orders/aggressiveOrdersSettings";
import { AbsorptionSettingsModal } from "../../lib/indicators/absorption-detector/AbsorptionSettingsModal";
import { DEFAULT_ABSORPTION_SETTINGS, absorptionRulesFor } from "../../lib/indicators/absorption-detector/absorptionSettings";
import { isAggressiveTimeframeSupported } from "../../lib/indicators/aggressive-orders/aggressiveOrdersSettings";
import { HISTORICAL_PRESET_SCOPE, historicalPresetScope } from "../../lib/chart/indicatorPresets";

export function HistoricalL2Settings({ instrument, intervalMs, chartRef, openId, onClose, extras, onChange, visibility, onVisibleChange, absorptionOn = false }: {
  instrument: HistoricalInstrument; intervalMs: number; chartRef: RefObject<ChartPanelHandle | null>;
  openId: IndicatorId | null; onClose: () => void; extras: LiveIndicatorExtras;
  onChange: Dispatch<SetStateAction<LiveIndicatorExtras>>;
  visibility: Partial<Record<IndicatorId, boolean>>; onVisibleChange: (id: IndicatorId, visible: boolean) => void;
  /** Absorption Detector is on the chart and shown: only then does it get rules, as on the live chart. */
  absorptionOn?: boolean;
}) {
  const identity = useMemo(() => ({ ...instrument.chartIdentity,
    symbol: instrument.group === "Futures" ? `/${instrument.symbol}` : instrument.symbol }), [instrument]);
  const defaults = useMemo(() => historicalLiquidityDefaults(instrument), [instrument]);
  const key = instrument.id;
  const presetScope = historicalPresetScope(key);
  const liquidity = extras.liquidityByStyle[key] ?? defaults;
  const aggressiveDefaults = useMemo(() => defaultAggressiveOrdersSettingsFor(identity), [identity]);
  const aggressive = extras.aggressiveByInstrument[key] ?? aggressiveDefaults;
  const absorption = extras.absorptionByInstrument[key] ?? DEFAULT_ABSORPTION_SETTINGS;
  const book = extras.liveOrderBookByInstrument[key] ?? DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS;
  const unit = instrument.group === "Futures" ? "contracts" : "shares";
  // The detector draws nothing without rules: the walls are this chart's heatmap walls, read with its settings.
  const absorptionRules = useMemo(
    () => (absorptionOn && isAggressiveTimeframeSupported(intervalMs) ? absorptionRulesFor(identity, absorption, intervalMs, liquidity) : null),
    [absorptionOn, identity, absorption, intervalMs, liquidity],
  );
  useEffect(() => {
    chartRef.current?.setAbsorptionRules(absorptionRules);
  }, [chartRef, absorptionRules]);
  useEffect(() => {
    const chart = chartRef.current;
    chart?.setLiquiditySettings(liquidity);
    chart?.setL2SupportResistanceSettings(extras.l2SupportResistance);
    chart?.setL2BookMapSettings(extras.l2BookMap);
    chart?.setWhaleHeatmapSettings(extras.whaleHeatmap);
    chart?.setAggressiveSettings(aggressive);
    chart?.setAbsorptionSettings(absorption);
    chart?.setLiveOrderBookSettings(book);
  }, [chartRef, liquidity, extras.l2SupportResistance, extras.l2BookMap, extras.whaleHeatmap, aggressive, absorption, book]);
  const common = (id: IndicatorId) => ({ isOpen: openId === id, onClose,
    visible: visibility[id] !== false, onVisibleChange: (value: boolean) => onVisibleChange(id, value) });
  return <>
    <LiquidityHeatmapSettingsModal {...common("passiveLiquidity")} market="index" unit={unit} intervalMs={intervalMs}
      settings={liquidity} defaults={defaults} historical presetScope={presetScope}
      onSettingsChange={(next) => onChange((current) => ({ ...current, liquidityByStyle: { ...current.liquidityByStyle, [key]: next } }))} />
    <L2SupportResistanceSettingsModal {...common("l2SupportResistance")} unit={unit} settings={extras.l2SupportResistance} presetScope={HISTORICAL_PRESET_SCOPE}
      onSettingsChange={(next) => onChange((current) => ({ ...current, l2SupportResistance: next }))} />
    <L2BookMapSettingsModal {...common("l2BookMap")} settings={extras.l2BookMap} intervalMs={intervalMs} presetScope={HISTORICAL_PRESET_SCOPE}
      onSettingsChange={(next) => onChange((current) => ({ ...current, l2BookMap: next }))} />
    <WhaleHeatmapSettingsModal {...common("whaleLimitOrderHeatmap")} settings={extras.whaleHeatmap} presetScope={HISTORICAL_PRESET_SCOPE}
      onSettingsChange={(next) => onChange((current) => ({ ...current, whaleHeatmap: next }))} />
    <LiveOrderBookProfileSettingsModal {...common("liveOrderBookProfile")} settings={book} heatmapSettings={liquidity}
      rowWidth={instrument.group === "Futures" ? 0.25 : 0.01} intervalMs={intervalMs} typicalSize={0} sizeUnit={unit} presetScope={presetScope}
      onSettingsChange={(next) => onChange((current) => ({ ...current, liveOrderBookByInstrument: { ...current.liveOrderBookByInstrument, [key]: next } }))} />
    <AggressiveOrdersSettingsModal {...common("aggressiveOrders")} settings={aggressive} defaults={aggressiveDefaults}
      identity={identity} intervalMs={intervalMs} unit={unit} suggestion={suggestedMinVolumeFor(identity)} presetScope={presetScope}
      onSettingsChange={(next) => onChange((current) => ({ ...current, aggressiveByInstrument: { ...current.aggressiveByInstrument, [key]: next } }))} />
    <AbsorptionSettingsModal {...common("absorptionDetector")} settings={absorption} defaults={DEFAULT_ABSORPTION_SETTINGS}
      presetScope={presetScope}
      onSettingsChange={(next) => onChange((current) => ({ ...current, absorptionByInstrument: { ...current.absorptionByInstrument, [key]: next } }))} />
  </>;
}
