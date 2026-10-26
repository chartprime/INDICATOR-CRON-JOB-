// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GenericIndicatorSettingsModal } from "../GenericIndicatorSettingsModal";
import { sessionLevelsIndicator } from "../../lib/indicators/session-levels/sessionLevelsIndicator";
import { DEFAULT_SESSION_LEVELS_SETTINGS, type SessionLevelsSettings } from "../../lib/indicators/session-levels/sessionLevelsRules";
import { AggressiveOrdersSettingsModal } from "../../lib/indicators/aggressive-orders/AggressiveOrdersSettingsModal";
import { DEFAULT_AGGRESSIVE_ORDERS_SETTINGS } from "../../lib/indicators/aggressive-orders/aggressiveOrdersSettings";
import { KillzonesSettingsModal } from "../../lib/indicators/killzones/KillzonesSettingsModal";
import { WhaleDetectorSettingsModal } from "../../lib/indicators/whale-detector/WhaleDetectorSettingsModal";
import { INDICATOR_PRESETS_STORAGE_KEY, indicatorPresets } from "../../lib/chart/indicatorPresets";
import { settingsSchemaFor } from "../../lib/chart/settingsSchemaFor";
import { institutionalOrderBlocksV2Indicator } from "../../lib/indicators/institutional-order-blocks-v2/institutionalOrderBlocksV2";
import { DEFAULT_INSTITUTIONAL_V2_SETTINGS, type InstitutionalV2Settings } from "../../lib/indicators/institutional-order-blocks-v2/institutionalV2Rules";
import { sessionDeltaProfileIndicator, DEFAULT_SESSION_DELTA_PROFILE_INDICATOR_SETTINGS, type SessionDeltaProfileIndicatorSettings } from "../../lib/indicators/session-delta-profile/sessionDeltaProfileIndicator";
import { LiquidityHeatmapSettingsModal } from "../../lib/indicators/passive-liquidity/LiquidityHeatmapSettingsModal";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../lib/indicators/passive-liquidity/liquiditySettings";
import { AbsorptionSettingsModal } from "../../lib/indicators/absorption-detector/AbsorptionSettingsModal";
import { ABSORBED_MULTIPLE_SLIDER, ABSORBED_PERCENT_SLIDER, DEFAULT_ABSORBED_MULTIPLE, DEFAULT_ABSORBED_PERCENT, DEFAULT_ABSORPTION_SETTINGS, DEFAULT_STRONG_PERCENT, STRONG_PERCENT_SLIDER, type AbsorptionSettings } from "../../lib/indicators/absorption-detector/absorptionSettings";
import { IcebergSettingsModal } from "../../lib/indicators/iceberg-detector/IcebergSettingsModal";
import { DEFAULT_ICEBERG_SETTINGS, ICEBERG_MAX_TRANCHES, ICEBERG_SETTINGS_SCHEMA } from "../../lib/indicators/iceberg-detector/icebergSettings";
import { ExhaustionSettingsModal } from "../../lib/indicators/exhaustion/ExhaustionSettingsModal";
import { DEFAULT_EXHAUSTION_SETTINGS, EXHAUSTION_SETTINGS_SCHEMA, LEG_ATR_RANGE, ZONE_SCALE_RANGE } from "../../lib/indicators/exhaustion/exhaustionSettings";
import { InitiativeSettingsModal } from "../../lib/indicators/initiative/InitiativeSettingsModal";
import { DEFAULT_INITIATIVE_SETTINGS, INITIATIVE_SETTINGS_SCHEMA, SCORE_RANGE as INITIATIVE_SCORE_RANGE } from "../../lib/indicators/initiative/initiativeSettings";
import { AggressiveProfileSettingsModal } from "../../lib/indicators/aggressive-orders-profile/AggressiveProfileSettingsModal";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS } from "../../lib/indicators/aggressive-orders-profile/aggressiveProfileSettings";
import { LiveRangeSettingsModal } from "../../lib/indicators/live-range-control/LiveRangeSettingsModal";
import { DEFAULT_LIVE_RANGE_SETTINGS, LIVE_RANGE_SETTINGS_SCHEMA } from "../../lib/indicators/live-range-control/liveRangeSettings";
import type { SettingsFieldSchema } from "../../lib/chart/indicatorTypes";
import { useState } from "react";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NQ = { provider: "DXFEED", assetClass: "FUTURE", symbol: "/NQZ26:XCME" } as const;

let container: HTMLDivElement;
let root: Root;

function mount(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(element));
}

const defaultsButton = () => document.querySelector<HTMLButtonElement>(".indicator-settings-defaults");
const item = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".indicator-presets-item")].find((button) => button.textContent === text)!;
const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Preset name"]')!;
const stored = () => JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY) ?? "{}") as Record<string, { name: string; params: Record<string, unknown> }[]>;

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openMenu() {
  if (defaultsButton()!.getAttribute("aria-expanded") !== "true") await click(defaultsButton()!);
}

async function saveAs(name: string) {
  await openMenu();
  await click(item("Save as preset…"));
  await type(nameInput(), name);
  await act(async () => {
    nameInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

async function apply(name: string) {
  await openMenu();
  await click(item(name));
}

describe("presets on the settings dialogs", () => {
  beforeEach(() => {
    indicatorPresets.refresh();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a schema dialog stores its lists as arrays and gives them back as sets, filling an input the preset lacks with its default", async () => {
    const onChange = vi.fn<(next: SessionLevelsSettings) => void>();
    const settings: SessionLevelsSettings = { ...DEFAULT_SESSION_LEVELS_SETTINGS, sessions: new Set(["asia"]), showSwept: !DEFAULT_SESSION_LEVELS_SETTINGS.showSwept };
    mount(
      <GenericIndicatorSettingsModal
        isOpen
        onClose={() => {}}
        title="Session Levels"
        schema={sessionLevelsIndicator.settingsSchema!}
        settings={settings}
        defaultSettings={DEFAULT_SESSION_LEVELS_SETTINGS}
        presetKey="sessionLevels"
        onChange={onChange}
      />,
    );
    await saveAs("Asia only");
    expect(stored().sessionLevels[0].params.sessions).toEqual(["asia"]);
    expect(stored().sessionLevels[0].params.showSwept).toBe(!DEFAULT_SESSION_LEVELS_SETTINGS.showSwept);
    await act(async () => { await indicatorPresets.save("sessionLevels", "Older", { sessions: ["london"] }); });
    await apply("Older");
    const applied = onChange.mock.calls[0][0];
    expect(applied.sessions).toEqual(new Set(["london"]));
    expect(applied.showSwept).toBe(DEFAULT_SESSION_LEVELS_SETTINGS.showSwept);
    expect(applied.windows).toEqual(DEFAULT_SESSION_LEVELS_SETTINGS.windows);
  });

  it("a schema dialog without defaults has no Defaults menu", async () => {
    mount(
      <GenericIndicatorSettingsModal
        isOpen
        onClose={() => {}}
        title="Session Levels"
        schema={sessionLevelsIndicator.settingsSchema!}
        settings={DEFAULT_SESSION_LEVELS_SETTINGS}
        presetKey="sessionLevels"
        onChange={() => {}}
      />,
    );
    expect(defaultsButton()).toBeNull();
  });

  it("a per-instrument dialog keeps its presets under the instrument, and applying one updates its typed field too", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <AggressiveOrdersSettingsModal
        isOpen
        onClose={() => {}}
        settings={{ ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: 5 }}
        onSettingsChange={onSettingsChange}
        defaults={DEFAULT_AGGRESSIVE_ORDERS_SETTINGS}
        visible
        onVisibleChange={() => {}}
        identity={NQ}
        presetScope="DXFEED:FUTURE:/NQZ26:XCME"
      />,
    );
    await saveAs("Quiet");
    expect(Object.keys(stored())).toEqual(["aggressiveOrders@DXFEED:FUTURE:/NQZ26:XCME"]);
    await act(async () => { await indicatorPresets.save("aggressiveOrders@DXFEED:FUTURE:/NQZ26:XCME", "Loud", { minVolume: 40 }); });
    await apply("Loud");
    expect(onSettingsChange).toHaveBeenCalledWith({ ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, minVolume: 40 });
    expect(container.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("40");
  });

  it("a hand-built dialog applies a preset through its declared ranges: a number past a slider's end is brought to that end, a choice the dialog no longer offers goes to the default", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <AggressiveOrdersSettingsModal
        isOpen
        onClose={() => {}}
        settings={DEFAULT_AGGRESSIVE_ORDERS_SETTINGS}
        onSettingsChange={onSettingsChange}
        defaults={DEFAULT_AGGRESSIVE_ORDERS_SETTINGS}
        visible
        onVisibleChange={() => {}}
        identity={NQ}
        presetScope="DXFEED:FUTURE:/NQZ26:XCME"
      />,
    );
    await act(async () => { await indicatorPresets.save("aggressiveOrders@DXFEED:FUTURE:/NQZ26:XCME", "Wild", { bubbleScale: 9, opacity: "dark", minVolume: 120 }); });
    await apply("Wild");
    expect(onSettingsChange).toHaveBeenCalledWith({ ...DEFAULT_AGGRESSIVE_ORDERS_SETTINGS, bubbleScale: 2.5, minVolume: 120 });
  });

  it("the killzones dialog saves the ticked sessions and applies a preset session by session; Reset settings returns the default ones", async () => {
    const onSessionChange = vi.fn();
    const onVisibleChange = vi.fn();
    mount(
      <KillzonesSettingsModal
        isOpen
        onClose={() => {}}
        visible
        onVisibleChange={onVisibleChange}
        selectedSessions={new Set(["london", "rth"])}
        onSessionChange={onSessionChange}
      />,
    );
    await saveAs("London");
    expect(stored().killzones[0].params).toEqual({ sessions: ["london", "rth"] });
    await apply("London");
    expect(onSessionChange.mock.calls).toEqual([
      ["asia", false], ["london", true], ["nyam", false], ["nylunch", false], ["nypm", false], ["rth", true],
    ]);
    onSessionChange.mockClear();
    await openMenu();
    await click(item("Reset settings"));
    expect(onSessionChange.mock.calls).toEqual([
      ["asia", true], ["london", true], ["nyam", true], ["nylunch", false], ["nypm", true], ["rth", false],
    ]);
    expect(onVisibleChange).toHaveBeenCalledWith(true);
  });

  it("the large trade detector keeps one preset list per size unit and applies a whole number of contracts", async () => {
    const onThresholdChange = vi.fn();
    const onModeChange = vi.fn();
    mount(
      <WhaleDetectorSettingsModal
        isOpen
        onClose={() => {}}
        mode="size"
        onModeChange={onModeChange}
        topFraction={0.01}
        onTopFractionChange={() => {}}
        threshold={25}
        thresholdUnit="CONTRACTS"
        onThresholdChange={onThresholdChange}
        resolvedThreshold={null}
        truncated={false}
        clusterMode="delta"
        onClusterModeChange={() => {}}
        minDeltaPercent={0}
        onMinDeltaPercentChange={() => {}}
        visible
        onVisibleChange={() => {}}
      />,
    );
    await saveAs("Big");
    expect(stored()["largeTradeDetector@CONTRACTS"][0].params).toEqual({ mode: "size", topFraction: 0.01, threshold: 25, clusterMode: "delta", minDeltaPercent: 0 });
    await act(async () => { await indicatorPresets.save("largeTradeDetector@CONTRACTS", "Odd", { mode: "size", threshold: 12.6 }); });
    await apply("Odd");
    expect(onThresholdChange).toHaveBeenCalledWith(13);
    expect(onModeChange).toHaveBeenCalledWith("size");
  });

  it("IOB v2 keeps its presets per instrument and touches only the min size of the instrument on screen", async () => {
    const nqKey = "DXFEED:FUTURE:/NQZ26:XCME";
    const btcKey = "BINANCE:PERPETUAL:BTC-USDT";
    const onChange = vi.fn<(next: InstitutionalV2Settings) => void>();
    const view = (settings: InstitutionalV2Settings, instrumentKey?: string) => (
      <GenericIndicatorSettingsModal
        isOpen
        onClose={() => {}}
        title="IOB v2"
        schema={settingsSchemaFor(institutionalOrderBlocksV2Indicator, NQ)}
        settings={settings}
        defaultSettings={DEFAULT_INSTITUTIONAL_V2_SETTINGS}
        presetKey="institutionalOrderBlocksV2"
        instrumentKey={instrumentKey}
        onChange={onChange}
      />
    );
    mount(view({ ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [nqKey]: 50, [btcKey]: 200 } }, nqKey));
    await saveAs("Tight");
    expect(stored()[`institutionalOrderBlocksV2@${nqKey}`][0].params.minSizeByInstrument).toEqual({ [nqKey]: 50 });
    expect(stored().institutionalOrderBlocksV2).toBeUndefined();
    act(() => root.render(view({ ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [nqKey]: 70, [btcKey]: 300 } }, nqKey)));
    await apply("Tight");
    expect(onChange.mock.calls.at(-1)![0].minSizeByInstrument).toEqual({ [nqKey]: 50, [btcKey]: 300 });
  });

  it("without an instrument, as in Historical mode, IOB v2 presets leave every per-instrument min size alone", async () => {
    const nqKey = "DXFEED:FUTURE:/NQZ26:XCME";
    const onChange = vi.fn<(next: InstitutionalV2Settings) => void>();
    mount(
      <GenericIndicatorSettingsModal
        isOpen
        onClose={() => {}}
        title="IOB v2"
        schema={institutionalOrderBlocksV2Indicator.settingsSchema!}
        settings={{ ...DEFAULT_INSTITUTIONAL_V2_SETTINGS, minSizeByInstrument: { [nqKey]: 70 } }}
        defaultSettings={DEFAULT_INSTITUTIONAL_V2_SETTINGS}
        presetKey="institutionalOrderBlocksV2@historical"
        onChange={onChange}
      />,
    );
    await saveAs("Plain");
    expect(stored()["institutionalOrderBlocksV2@historical"][0].params).not.toHaveProperty("minSizeByInstrument");
    await apply("Plain");
    expect(onChange.mock.calls.at(-1)![0].minSizeByInstrument).toEqual({ [nqKey]: 70 });
  });

  it("Session Delta Profile presets hold its POC and value-area settings", async () => {
    const onChange = vi.fn<(next: SessionDeltaProfileIndicatorSettings) => void>();
    const view = (settings: SessionDeltaProfileIndicatorSettings) => (
      <GenericIndicatorSettingsModal
        isOpen
        onClose={() => {}}
        title="Session Delta Profile"
        schema={sessionDeltaProfileIndicator.settingsSchema!}
        settings={settings}
        defaultSettings={DEFAULT_SESSION_DELTA_PROFILE_INDICATOR_SETTINGS}
        presetKey="sessionDeltaProfile"
        onChange={onChange}
      />
    );
    const clean = { ...DEFAULT_SESSION_DELTA_PROFILE_INDICATOR_SETTINGS, showBuyPoc: false, sellPocStyle: "dotted" as const, vahValColor: "#ffff00" };
    mount(view(clean));
    await saveAs("Clean");
    expect(stored().sessionDeltaProfile[0].params).toMatchObject({ showBuyPoc: false, sellPocStyle: "dotted", vahValColor: "#ffff00" });
    act(() => root.render(view({ ...clean, showBuyPoc: true, sellPocStyle: "solid", vahValColor: "#000000" })));
    expect(defaultsButton()!.textContent).toContain("Defaults");
    await apply("Clean");
    expect(onChange.mock.calls.at(-1)![0]).toMatchObject({ showBuyPoc: false, sellPocStyle: "dotted", vahValColor: "#ffff00" });
  });

  it("the live heatmap preset holds Price zoom; the Historical one, which has no Price zoom, does not", async () => {
    const onLaneChange = vi.fn();
    const onSettingsChange = vi.fn();
    const view = (lane: "auto" | "0" | "1" | "2") => (
      <LiquidityHeatmapSettingsModal
        isOpen
        onClose={() => {}}
        settings={DEFAULT_LIQUIDITY_SETTINGS}
        onSettingsChange={onSettingsChange}
        lane={lane}
        onLaneChange={onLaneChange}
        visible
        onVisibleChange={() => {}}
        presetScope="crypto"
      />
    );
    mount(view("2"));
    await saveAs("Zoomed");
    expect(stored()["passiveLiquidity@crypto"][0].params.lane).toBe("2");
    act(() => root.render(view("0")));
    await apply("Zoomed");
    expect(onLaneChange).toHaveBeenLastCalledWith("2");
    act(() => root.unmount());
    container.remove();
    mount(
      <LiquidityHeatmapSettingsModal
        isOpen
        onClose={() => {}}
        settings={DEFAULT_LIQUIDITY_SETTINGS}
        onSettingsChange={onSettingsChange}
        historical
        visible
        onVisibleChange={() => {}}
        presetScope="historical:aapl"
      />,
    );
    await saveAs("Past");
    expect(stored()["passiveLiquidity@historical:aapl"][0].params).not.toHaveProperty("lane");
  });

  it("the size-only Historical Large Trade Detector keeps its own list and holds no mode or top share", async () => {
    await act(async () => { await indicatorPresets.save("largeTradeDetector@USD", "Live top", { mode: "topPercent", topFraction: 0.002, threshold: 75000, clusterMode: "delta", minDeltaPercent: 0 }); });
    mount(
      <WhaleDetectorSettingsModal
        isOpen
        onClose={() => {}}
        mode="size"
        onModeChange={() => {}}
        topFraction={0.0005}
        onTopFractionChange={() => {}}
        threshold={500000}
        thresholdUnit="USD"
        onThresholdChange={() => {}}
        resolvedThreshold={null}
        truncated={false}
        clusterMode="delta"
        onClusterModeChange={() => {}}
        minDeltaPercent={0}
        onMinDeltaPercentChange={() => {}}
        visible
        onVisibleChange={() => {}}
        sizeOnlyNote="Size only"
        presetScope="historical"
      />,
    );
    await openMenu();
    expect([...document.querySelectorAll(".indicator-presets-row .indicator-presets-item")].map((row) => row.textContent)).toEqual([]);
    await saveAs("Big prints");
    expect(stored()["largeTradeDetector@historical:USD"][0].params).toEqual({ threshold: 500000, clusterMode: "delta", minDeltaPercent: 0 });
  });

  it("Prime Absorption keeps its presets per instrument with the three sliders and Show broken: a value past a slider's end comes back at that end, and a preset saved before them, with floors and Strong walls only, keeps its other settings and gives the sliders their defaults", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <AbsorptionSettingsModal
        isOpen
        onClose={() => {}}
        settings={{ ...DEFAULT_ABSORPTION_SETTINGS, absorbedPercent: 120, strongPercent: 400, absorbedMultiple: 25, showBroken: false }}
        onSettingsChange={onSettingsChange}
        defaults={DEFAULT_ABSORPTION_SETTINGS}
        visible
        onVisibleChange={() => {}}
        presetScope="DXFEED:FUTURE:/NQZ26:XCME"
      />,
    );
    const key = "absorptionDetector@DXFEED:FUTURE:/NQZ26:XCME";
    await saveAs("Tight");
    expect(Object.keys(stored())).toEqual([key]);
    expect(stored()[key][0].params).toMatchObject({ absorbedPercent: 120, strongPercent: 400, absorbedMultiple: 25, showBroken: false });
    await act(async () => { await indicatorPresets.save(key, "Wide", { absorbedPercent: 9_000, strongPercent: 10, absorbedMultiple: 500, showBroken: true }); });
    await apply("Wide");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_ABSORPTION_SETTINGS, absorbedPercent: ABSORBED_PERCENT_SLIDER.max, strongPercent: STRONG_PERCENT_SLIDER.min, absorbedMultiple: ABSORBED_MULTIPLE_SLIDER.max, showBroken: true });
    await act(async () => { await indicatorPresets.save(key, "Before the sliders", { floors: { x3: 100 }, strongOnly: true, opacity: 0.4 }); });
    await apply("Before the sliders");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_ABSORPTION_SETTINGS, absorbedPercent: DEFAULT_ABSORBED_PERCENT, strongPercent: DEFAULT_STRONG_PERCENT, absorbedMultiple: DEFAULT_ABSORBED_MULTIPLE, opacity: 0.4 });
  });

  it("Prime Absorption names the preset in use after saving it and after applying it", async () => {
    function Harness() {
      const [settings, setSettings] = useState<AbsorptionSettings>({ ...DEFAULT_ABSORPTION_SETTINGS, absorbedPercent: 150 });
      return (
        <AbsorptionSettingsModal
          isOpen
          onClose={() => {}}
          settings={settings}
          onSettingsChange={setSettings}
          defaults={DEFAULT_ABSORPTION_SETTINGS}
          visible
          onVisibleChange={() => {}}
          presetScope="DXFEED:FUTURE:/NQZ26:XCME"
        />
      );
    }
    mount(<Harness />);
    await saveAs("Clean");
    expect(defaultsButton()!.textContent).toContain("Clean");
    await apply("Clean");
    expect(defaultsButton()!.textContent).toContain("Clean");
  });

  it("the Iceberg Detector keeps its presets per instrument: a slider past its end comes back at that end, a shape it does not offer goes to the default, and applying keeps the settings revision", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <IcebergSettingsModal
        isOpen
        onClose={() => {}}
        settings={{ ...DEFAULT_ICEBERG_SETTINGS, minTranches: 4, placement: "candle", revision: 7 }}
        onSettingsChange={onSettingsChange}
        defaults={DEFAULT_ICEBERG_SETTINGS}
        visible
        onVisibleChange={() => {}}
        identity={NQ}
        presetScope="DXFEED:FUTURE:/NQZ26:XCME"
      />,
    );
    const key = "icebergDetector@DXFEED:FUTURE:/NQZ26:XCME";
    await saveAs("Refills");
    expect(Object.keys(stored())).toEqual([key]);
    expect(stored()[key][0].params).toMatchObject({ minTranches: 4, placement: "candle" });
    expect(stored()[key][0].params).not.toHaveProperty("revision");
    await act(async () => { await indicatorPresets.save(key, "Wild", { minTranches: 99, sizeTopPercent: 0, markScale: 9, markShape: "hexagon", placement: "price", revision: 1 }); });
    await apply("Wild");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_ICEBERG_SETTINGS, minTranches: ICEBERG_MAX_TRANCHES, sizeTopPercent: 1, markScale: 2.5, markShape: "auto", placement: "price", revision: 7 });
  });

  it("Exhaustion keeps its presets per instrument: a slider past its end comes back at that end, and the switches, the history and the colours come with the preset", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <ExhaustionSettingsModal
        isOpen
        onClose={() => {}}
        settings={{ ...DEFAULT_EXHAUSTION_SETTINGS, legAtr: 12, zonesOnly: true }}
        onSettingsChange={onSettingsChange}
        defaults={DEFAULT_EXHAUSTION_SETTINGS}
        visible
        onVisibleChange={() => {}}
        presetScope="BINANCE:PERPETUAL:BTCUSDT"
      />,
    );
    const key = "exhaustion@BINANCE:PERPETUAL:BTCUSDT";
    await saveAs("Big legs");
    expect(Object.keys(stored())).toEqual([key]);
    expect(stored()[key][0].params).toMatchObject({ legAtr: 12, zonesOnly: true });
    await act(async () => { await indicatorPresets.save(key, "Wild", { legAtr: 100, zoneScale: 0.2, showMonitor: false, historyDays: 7, buyerColor: "#123456" }); });
    await apply("Wild");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_EXHAUSTION_SETTINGS, legAtr: LEG_ATR_RANGE[1], zoneScale: ZONE_SCALE_RANGE[0], showMonitor: false, historyDays: 7, buyerColor: "#123456" });
  });

  it("Initiative Continuation keeps its presets per instrument: a score past the ladder comes back at its top, and the switches, the history and the colours come with the preset", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <InitiativeSettingsModal
        isOpen
        onClose={() => {}}
        settings={{ ...DEFAULT_INITIATIVE_SETTINGS, minScore: 4, showShade: false }}
        onSettingsChange={onSettingsChange}
        defaults={DEFAULT_INITIATIVE_SETTINGS}
        visible
        onVisibleChange={() => {}}
        presetScope="BINANCE:PERPETUAL:BTCUSDT"
      />,
    );
    const key = "initiative@BINANCE:PERPETUAL:BTCUSDT";
    await saveAs("Strong starts");
    expect(Object.keys(stored())).toEqual([key]);
    expect(stored()[key][0].params).toMatchObject({ minScore: 4, showShade: false });
    await act(async () => { await indicatorPresets.save(key, "Wild", { minScore: 9, showLabels: false, historyDays: 7, sellerColor: "#123456" }); });
    await apply("Wild");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_INITIATIVE_SETTINGS, minScore: INITIATIVE_SCORE_RANGE[1], showLabels: false, historyDays: 7, sellerColor: "#123456" });
  });

  it("Aggressive Orders Profile keeps its presets per instrument: the floor and the colours come with the preset", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <AggressiveProfileSettingsModal
        isOpen
        onClose={() => {}}
        settings={{ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 12 }}
        onSettingsChange={onSettingsChange}
        visible
        onVisibleChange={() => {}}
        presetScope="BINANCE:PERPETUAL:BTCUSDT"
      />,
    );
    const key = "aggressiveOrdersProfile@BINANCE:PERPETUAL:BTCUSDT";
    await saveAs("Floor 12");
    expect(Object.keys(stored())).toEqual([key]);
    expect(stored()[key][0].params).toMatchObject({ floor: 12 });
    await act(async () => { await indicatorPresets.save(key, "Wild", { floor: 3, buyColor: "#654321", sellColor: "#123456" }); });
    await apply("Wild");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 3, buyColor: "#654321", sellColor: "#123456" });
  });

  it("Live Range Control keeps its presets per instrument: a width past the slider's end comes back at that end, and the colours come with the preset", async () => {
    const onSettingsChange = vi.fn();
    mount(
      <LiveRangeSettingsModal
        isOpen
        onClose={() => {}}
        settings={{ ...DEFAULT_LIVE_RANGE_SETTINGS, askColor: "#445566" }}
        onSettingsChange={onSettingsChange}
        defaults={DEFAULT_LIVE_RANGE_SETTINGS}
        visible
        onVisibleChange={() => {}}
        presetScope="BINANCE:PERPETUAL:BTCUSDT"
      />,
    );
    const key = "liveRangeControl@BINANCE:PERPETUAL:BTCUSDT";
    await saveAs("Tight");
    expect(Object.keys(stored())).toEqual([key]);
    expect(stored()[key][0].params).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, askColor: "#445566" });
    await act(async () => { await indicatorPresets.save(key, "Wild", { bidColor: "#123456" }); });
    await apply("Wild");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_LIVE_RANGE_SETTINGS, bidColor: "#123456" });
  });

  it("the Iceberg and Exhaustion dialogs' sliders run over the same ranges and steps as their presets read them, on every tab", async () => {
    const sliders = (schema: readonly SettingsFieldSchema<any>[]) => schema.flatMap((field) => (field.kind === "slider" ? [[field.min, field.max, field.step]] : [])).map(String).sort();
    const shown = async () => {
      const ranges: string[] = [];
      for (const tab of [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]) {
        await click(tab);
        for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
          if (input.closest(".live-range-window") !== null || input.getAttribute("aria-label") === "Big print from") continue;
          ranges.push(String([Number(input.min), Number(input.max), Number(input.step)]));
        }
      }
      return ranges.sort();
    };
    mount(<IcebergSettingsModal isOpen onClose={() => {}} settings={DEFAULT_ICEBERG_SETTINGS} onSettingsChange={() => {}} defaults={DEFAULT_ICEBERG_SETTINGS} visible onVisibleChange={() => {}} identity={NQ} presetScope="x" />);
    expect(await shown()).toEqual(sliders(ICEBERG_SETTINGS_SCHEMA));
    act(() => root.unmount());
    container.remove();
    mount(<ExhaustionSettingsModal isOpen onClose={() => {}} settings={DEFAULT_EXHAUSTION_SETTINGS} onSettingsChange={() => {}} defaults={DEFAULT_EXHAUSTION_SETTINGS} visible onVisibleChange={() => {}} presetScope="x" />);
    expect(await shown()).toEqual(sliders(EXHAUSTION_SETTINGS_SCHEMA));
    act(() => root.unmount());
    container.remove();
    mount(<InitiativeSettingsModal isOpen onClose={() => {}} settings={DEFAULT_INITIATIVE_SETTINGS} onSettingsChange={() => {}} defaults={DEFAULT_INITIATIVE_SETTINGS} visible onVisibleChange={() => {}} presetScope="x" />);
    expect(await shown()).toEqual(sliders(INITIATIVE_SETTINGS_SCHEMA));
    act(() => root.unmount());
    container.remove();
    mount(<LiveRangeSettingsModal isOpen onClose={() => {}} settings={{ ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live" }} onSettingsChange={() => {}} defaults={DEFAULT_LIVE_RANGE_SETTINGS} visible onVisibleChange={() => {}} presetScope="x" />);
    expect(await shown()).toEqual(sliders(LIVE_RANGE_SETTINGS_SCHEMA));
  });
});
