// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChartPanelHandle } from "../chart/ChartPanel";
import { HISTORICAL_INSTRUMENTS } from "../../lib/archive/historicalCatalog";
import { defaultLiveIndicatorExtras } from "../../lib/chart/liveIndicatorExtras";
import { HistoricalL2Settings } from "./HistoricalL2Settings";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ES = HISTORICAL_INSTRUMENTS.find((instrument) => instrument.source === "databento" && instrument.group === "Futures")!;

function chart() {
  const names = ["setLiquiditySettings", "setL2SupportResistanceSettings", "setL2BookMapSettings", "setWhaleHeatmapSettings",
    "setAggressiveSettings", "setAbsorptionSettings", "setLiveOrderBookSettings", "setAbsorptionRules"] as const;
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as unknown as ChartPanelHandle & Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
}

describe("HistoricalL2Settings: absorption rules on the historical chart", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  function mount(handle: ChartPanelHandle, props: { absorptionOn: boolean; intervalMs?: number }) {
    const chartRef = createRef<ChartPanelHandle | null>() as { current: ChartPanelHandle | null };
    chartRef.current = handle;
    const host = document.createElement("div");
    root ??= createRoot(host);
    act(() => root!.render(<HistoricalL2Settings instrument={ES} intervalMs={props.intervalMs ?? 60_000} chartRef={chartRef}
      openId={null} onClose={() => {}} extras={defaultLiveIndicatorExtras()} onChange={() => {}}
      visibility={{}} onVisibleChange={() => {}} absorptionOn={props.absorptionOn} />));
  }

  it("hands the chart the detector's rules while it is on and shown, read off this instrument's heatmap, and takes them away when it is not", () => {
    const handle = chart();
    mount(handle, { absorptionOn: true });
    const rules = handle.setAbsorptionRules.mock.calls.at(-1)?.[0];
    expect(rules).not.toBeNull();
    expect(rules).toMatchObject({ absorbedPercent: 200, absorbedMultiple: 40 });
    expect(String(rules.instrument)).toContain("DATABENTO");
    mount(handle, { absorptionOn: false });
    expect(handle.setAbsorptionRules.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it("gives no rules on a timeframe the detector does not run on, as on the live chart", () => {
    const handle = chart();
    mount(handle, { absorptionOn: true, intervalMs: 86_400_000 });
    expect(handle.setAbsorptionRules.mock.calls.at(-1)?.[0]).toBeNull();
  });
});
