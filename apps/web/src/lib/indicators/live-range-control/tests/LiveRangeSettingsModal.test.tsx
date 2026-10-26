// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LiveRangeSettingsModal } from "../LiveRangeSettingsModal";
import {
  CRYPTO_PRINT_SCALE,
  DEFAULT_LIVE_RANGE_SETTINGS,
  EQUITY_PRINT_SCALE,
  FUTURES_PRINT_SCALE,
  LIVE_RANGE_SETTINGS_SCHEMA,
  type CardSize,
  type LiveRangeMode,
  type LiveRangeSettings,
  type PrintScale,
  type VerdictSensitivity,
} from "../liveRangeSettings";
import { WHOLE_WINDOW, WINDOW_TICK_MS, type LiveRangeWindow } from "../liveRangeWindow";
import { INDICATOR_PRESETS_STORAGE_KEY, indicatorPresets } from "../../../chart/indicatorPresets";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 9, 17, 2, 35, 20);
const SCOPE = "BINANCE:PERPETUAL:BTCUSDT";
const LIVE: LiveRangeSettings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live" };
const SELECTED: LiveRangeSettings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "selected" };
const CHANGED: LiveRangeSettings = { rangeMode: "live", bigPrint: 12.5, verdictSensitivity: "strict", zoneColor: "#123456", zoneOpacity: 25, bidColor: "#abcdef", askColor: "#fedcba", cardSize: "large", showZone: false, showVolumeRow: false, showDeltaRow: false, showPrintsRow: false, showMinutesRow: false, showImpactRow: false, showTips: false };

let latest: LiveRangeSettings = DEFAULT_LIVE_RANGE_SETTINGS;
const onClose = vi.fn<() => void>();
const onSettingsChange = vi.fn<(next: LiveRangeSettings) => void>();
const onVisibleChange = vi.fn<(next: boolean) => void>();
const onWindowChange = vi.fn<(next: LiveRangeWindow) => void>();
let latestWindow: LiveRangeWindow = WHOLE_WINDOW;

interface HarnessProps {
  isOpen?: boolean;
  start?: LiveRangeSettings;
  defaults?: LiveRangeSettings;
  visible?: boolean;
  window?: LiveRangeWindow;
  presetScope?: string;
  scale?: PrintScale;
  unit?: string;
}

function Harness({ isOpen = true, start = DEFAULT_LIVE_RANGE_SETTINGS, defaults, visible = true, window: startWindow = WHOLE_WINDOW, presetScope, scale, unit }: HarnessProps) {
  const [settings, setSettings] = useState(start);
  const [window, setWindow] = useState(startWindow);
  return (
    <LiveRangeSettingsModal
      isOpen={isOpen}
      onClose={onClose}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        onSettingsChange(next);
        setSettings(next);
      }}
      defaults={defaults}
      visible={visible}
      onVisibleChange={onVisibleChange}
      window={window}
      onWindowChange={(next) => {
        latestWindow = next;
        onWindowChange(next);
        setWindow(next);
      }}
      scale={scale}
      unit={unit}
      presetScope={presetScope}
    />
  );
}

describe("the Live Range Control settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = DEFAULT_LIVE_RANGE_SETTINGS;
    onClose.mockClear();
    onSettingsChange.mockClear();
    onVisibleChange.mockClear();
    onWindowChange.mockClear();
    latestWindow = WHOLE_WINDOW;
    localStorage.clear();
    indicatorPresets.refresh();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function render(props: HarnessProps = {}) {
    act(() => root.render(<Harness {...props} />));
  }

  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const inputs = () => [...container.querySelectorAll<HTMLInputElement>("input")].map((element) => element.getAttribute("aria-label"));
  const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!;
  const selected = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((button) => [button.textContent, button.getAttribute("aria-selected")]);
  const reset = () => container.querySelector<HTMLButtonElement>(".indicator-settings-reset")!;
  const body = () => container.querySelector<HTMLDivElement>(".indicator-settings-body")!;
  const setValue = (element: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const stored = () => JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY) ?? "{}") as Record<string, { name: string; params: Record<string, unknown> }[]>;
  const defaultsButton = () => container.querySelector<HTMLButtonElement>(".indicator-settings-defaults")!;
  const item = (text: string) => [...document.querySelectorAll<HTMLButtonElement>(".indicator-presets-item")].find((button) => button.textContent === text)!;
  const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Preset name"]')!;

  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  async function openMenu() {
    if (defaultsButton().getAttribute("aria-expanded") !== "true") await click(defaultsButton());
  }

  async function saveAs(name: string) {
    await openMenu();
    await click(item("Save as preset…"));
    setValue(nameInput(), name);
    await act(async () => {
      nameInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  async function apply(name: string) {
    await openMenu();
    await click(item(name));
  }

  it("opens on Inputs with the mode, the big print slider and the verdict sensitivity, adds the window in the zone modes, and keeps the colours, the zone opacity, the monitor size, the row ticks, the zone tick, the hover tips tick and the chart switch on Visibility, with no explanation text", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render({ unit: "BTC" });
    expect(container.querySelector('[aria-label="Live Range Control settings"]')).not.toBeNull();
    expect(container.querySelector(".indicator-settings-drag-handle")?.textContent).toBe("Live Range Control");
    expect(selected()).toEqual([["Inputs", "true"], ["Visibility", "false"]]);
    expect(inputs()).toEqual(["Mode Visible range", "Mode Selected zone", "Mode Live", "Big print from", "Verdict sensitivity High", "Verdict sensitivity Normal", "Verdict sensitivity Strict"]);
    expect(body().textContent).toBe("ModeVisible rangeSelected zoneLiveBig print from 5 BTCVerdict sensitivityHighNormalStrict");
    act(() => input("Mode Live").click());
    expect(inputs()).toEqual(["Mode Visible range", "Mode Selected zone", "Mode Live", "Big print from", "Verdict sensitivity High", "Verdict sensitivity Normal", "Verdict sensitivity Strict", "Window start"]);
    expect(body().textContent).toBe("ModeVisible rangeSelected zoneLiveBig print from 5 BTCVerdict sensitivityHighNormalStrictWindow since 10 Oct 02:35 UTC · 7 d");
    act(() => input("Mode Selected zone").click());
    expect(inputs()).toEqual(["Mode Visible range", "Mode Selected zone", "Mode Live", "Big print from", "Verdict sensitivity High", "Verdict sensitivity Normal", "Verdict sensitivity Strict", "Window start", "Window end"]);
    act(() => tab("Visibility").click());
    expect(selected()).toEqual([["Inputs", "false"], ["Visibility", "true"]]);
    expect(inputs()).toEqual(["Zone colour", "Zone opacity", "Bid colour", "Ask colour", "Monitor size Small", "Monitor size Medium", "Monitor size Large", "Show Traded volume", "Show Delta", "Show Big prints", "Show Minutes won", "Show Price impact", "Show zone", "Show hover tips", "Show on chart"]);
    expect(body().textContent).toBe("Zone colourZone opacity 10 %Bid colourAsk colourMonitor sizeSmallMediumLargeRowsTraded volumeDeltaBig printsMinutes wonPrice impactShow zoneShow hover tipsShow on chart");
    act(() => tab("Inputs").click());
    expect(selected()).toEqual([["Inputs", "true"], ["Visibility", "false"]]);
    expect(inputs()).toEqual(["Mode Visible range", "Mode Selected zone", "Mode Live", "Big print from", "Verdict sensitivity High", "Verdict sensitivity Normal", "Verdict sensitivity Strict", "Window start", "Window end"]);
  });

  it("lays out its tabs, body, fields and chart switch on the classes of the shared dialog", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render({ start: SELECTED });
    const tabs = container.querySelector('[role="tablist"]')!;
    expect(tabs.className).toBe("indicator-settings-tabs");
    expect([...tabs.children].map((button) => button.className)).toEqual(["indicator-settings-tab", "indicator-settings-tab"]);
    expect(tabs.nextElementSibling).toBe(body());
    const fields = () => [...body().children].map((field) => [field.tagName, field.className]);
    expect(fields()).toEqual([["DIV", "indicator-settings-field"], ["LABEL", "indicator-settings-field"], ["DIV", "indicator-settings-field"], ["DIV", "indicator-settings-field live-range-window-field"]]);
    expect(body().children[0].querySelector(".live-range-modes")?.children).toHaveLength(3);
    expect(body().children[2].querySelector(".live-range-modes")?.children).toHaveLength(3);
    expect([...body().querySelectorAll(".live-range-modes > label")].map((label) => label.className)).toEqual(Array(6).fill("indicator-settings-radio"));
    expect(container.querySelector('[data-testid="live-range-window"]')!.className).toBe("live-range-window");
    act(() => tab("Visibility").click());
    expect(fields()).toEqual([["LABEL", "indicator-settings-field"], ["LABEL", "indicator-settings-field"], ["LABEL", "indicator-settings-field"], ["LABEL", "indicator-settings-field"], ["DIV", "indicator-settings-field"], ["DIV", "indicator-settings-field"], ["LABEL", "indicator-settings-checkbox"], ["LABEL", "indicator-settings-checkbox"], ["LABEL", "indicator-settings-checkbox"]]);
    expect([...body().children[4].querySelectorAll(".live-range-modes > label")].map((label) => label.className)).toEqual(["indicator-settings-radio", "indicator-settings-radio", "indicator-settings-radio"]);
    expect([...body().children[5].querySelectorAll(".live-range-modes > label")].map((label) => label.className)).toEqual(Array(5).fill("indicator-settings-checkbox"));
  });

  it("opens on Inputs again whichever tab it was closed on", () => {
    render();
    act(() => tab("Visibility").click());
    render({ isOpen: false });
    render({ isOpen: true });
    expect(selected()).toEqual([["Inputs", "true"], ["Visibility", "false"]]);
  });

  it("shows the mode in one group of radios and writes it, a mode it does not know read as the visible range", () => {
    render({ start: { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "zone" as LiveRangeMode } });
    const radios = () => ["Mode Visible range", "Mode Selected zone", "Mode Live"].map((label) => input(label));
    expect(radios().map((radio) => [radio.type, radio.name, radio.checked])).toEqual([["radio", "live-range-mode", true], ["radio", "live-range-mode", false], ["radio", "live-range-mode", false]]);
    act(() => input("Mode Live").click());
    expect(latest).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "live" });
    expect(radios().map((radio) => radio.checked)).toEqual([false, false, true]);
    act(() => input("Mode Selected zone").click());
    expect(latest.rangeMode).toBe("selected");
    act(() => input("Mode Visible range").click());
    expect(latest).toEqual(DEFAULT_LIVE_RANGE_SETTINGS);
    expect(onSettingsChange).toHaveBeenCalledTimes(3);
    expect(onWindowChange).not.toHaveBeenCalled();
  });

  it("shows the monitor size in one group of three radios, Medium at first, and writes it, leaving the mode alone", () => {
    render({ start: LIVE });
    act(() => tab("Visibility").click());
    const radios = () => ["Small", "Medium", "Large"].map((label) => input(`Monitor size ${label}`));
    expect(radios().map((radio) => [radio.type, radio.name, radio.checked])).toEqual([["radio", "live-range-size", false], ["radio", "live-range-size", true], ["radio", "live-range-size", false]]);
    act(() => input("Monitor size Large").click());
    expect(latest).toEqual({ ...LIVE, cardSize: "large" });
    expect(radios().map((radio) => radio.checked)).toEqual([false, false, true]);
    act(() => input("Monitor size Small").click());
    expect(latest).toEqual({ ...LIVE, cardSize: "small" });
    act(() => input("Monitor size Medium").click());
    expect(latest).toEqual(LIVE);
    expect(onSettingsChange).toHaveBeenCalledTimes(3);
    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  it("the zone opacity slider runs from 1 to 50 percent in whole steps, names its value, writes it, and shows a tenth for a saved value it does not know", () => {
    render({ start: { ...DEFAULT_LIVE_RANGE_SETTINGS, zoneOpacity: 90 } });
    act(() => tab("Visibility").click());
    const slider = input("Zone opacity");
    expect([slider.type, slider.min, slider.max, slider.step, slider.value]).toEqual(["range", "1", "50", "1", "10"]);
    expect(body().textContent).toContain("Zone opacity 10 %");
    setValue(slider, "25");
    expect(latest).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, zoneOpacity: 25 });
    expect(body().textContent).toContain("Zone opacity 25 %");
    setValue(slider, "1");
    expect(latest.zoneOpacity).toBe(1);
    expect(onSettingsChange).toHaveBeenCalledTimes(2);
  });

  it("shows the verdict sensitivity in one group of three radios, Normal at first, and writes it, leaving the mode alone", () => {
    render({ start: LIVE });
    const radios = () => ["High", "Normal", "Strict"].map((label) => input(`Verdict sensitivity ${label}`));
    expect(radios().map((radio) => [radio.type, radio.name, radio.checked])).toEqual([["radio", "live-range-verdict", false], ["radio", "live-range-verdict", true], ["radio", "live-range-verdict", false]]);
    act(() => input("Verdict sensitivity High").click());
    expect(latest).toEqual({ ...LIVE, verdictSensitivity: "high" });
    expect(radios().map((radio) => radio.checked)).toEqual([true, false, false]);
    act(() => input("Verdict sensitivity Strict").click());
    expect(latest).toEqual({ ...LIVE, verdictSensitivity: "strict" });
    act(() => input("Verdict sensitivity Normal").click());
    expect(latest).toEqual(LIVE);
    expect(onSettingsChange).toHaveBeenCalledTimes(3);
    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  it("reads a verdict sensitivity it does not know as Normal", () => {
    render({ start: { ...DEFAULT_LIVE_RANGE_SETTINGS, verdictSensitivity: "loose" as VerdictSensitivity } });
    expect(["High", "Normal", "Strict"].map((label) => input(`Verdict sensitivity ${label}`).checked)).toEqual([false, true, false]);
  });

  it("a tick per row shows and writes whether that row is on the card, every one ticked at first, each writing only its own key, and leaves the chart switch alone", () => {
    render({ start: SELECTED });
    act(() => tab("Visibility").click());
    const ticks = () => ["Traded volume", "Delta", "Big prints", "Minutes won", "Price impact"].map((label) => input(`Show ${label}`));
    expect(ticks().map((tick) => [tick.type, tick.checked])).toEqual(Array(5).fill(["checkbox", true]));
    act(() => input("Show Delta").click());
    expect(latest).toEqual({ ...SELECTED, showDeltaRow: false });
    act(() => input("Show Price impact").click());
    expect(latest).toEqual({ ...SELECTED, showDeltaRow: false, showImpactRow: false });
    expect(ticks().map((tick) => tick.checked)).toEqual([true, false, true, true, false]);
    act(() => input("Show Traded volume").click());
    act(() => input("Show Big prints").click());
    act(() => input("Show Minutes won").click());
    expect(latest).toEqual({ ...SELECTED, showVolumeRow: false, showDeltaRow: false, showPrintsRow: false, showMinutesRow: false, showImpactRow: false });
    act(() => input("Show Delta").click());
    expect(latest).toEqual({ ...SELECTED, showVolumeRow: false, showPrintsRow: false, showMinutesRow: false, showImpactRow: false });
    expect(onSettingsChange).toHaveBeenCalledTimes(6);
    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  it("the hover tips tick shows and writes whether the price impact explains itself under the pointer, ticked at first, and leaves the chart switch alone", () => {
    render();
    act(() => tab("Visibility").click());
    const tips = input("Show hover tips");
    expect([tips.type, tips.checked]).toEqual(["checkbox", true]);
    act(() => tips.click());
    expect(latest).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, showTips: false });
    expect(input("Show hover tips").checked).toBe(false);
    act(() => input("Show hover tips").click());
    expect(latest).toEqual(DEFAULT_LIVE_RANGE_SETTINGS);
    expect(onSettingsChange).toHaveBeenCalledTimes(2);
    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  it("reads a monitor size it does not know as Medium", () => {
    render({ start: { ...DEFAULT_LIVE_RANGE_SETTINGS, cardSize: "huge" as CardSize } });
    act(() => tab("Visibility").click());
    expect(["Small", "Medium", "Large"].map((label) => input(`Monitor size ${label}`).checked)).toEqual([false, true, false]);
  });

  it("the zone tick shows and writes whether the zone is drawn on the chart, ticked at first, and leaves the chart switch alone", () => {
    render({ start: SELECTED });
    act(() => tab("Visibility").click());
    const zone = input("Show zone");
    expect([zone.type, zone.checked]).toEqual(["checkbox", true]);
    act(() => zone.click());
    expect(latest).toEqual({ ...SELECTED, showZone: false });
    expect(input("Show zone").checked).toBe(false);
    act(() => input("Show zone").click());
    expect(latest).toEqual(SELECTED);
    expect(input("Show zone").checked).toBe(true);
    expect(onSettingsChange).toHaveBeenCalledTimes(2);
    expect(onVisibleChange).not.toHaveBeenCalled();
  });

  it("runs the big print slider on the scale of the instrument and stores every value on its steps, the label naming the size it reads with in the unit of the instrument", () => {
    render({ unit: "BTC" });
    const slider = input("Big print from");
    expect([slider.type, slider.min, slider.max, slider.step, slider.value]).toEqual(["range", "0.5", "50", "0.5", "5"]);
    setValue(slider, "12.3");
    expect(latest).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 12.5 });
    expect(slider.value).toBe("12.5");
    expect(body().textContent).toContain("Big print from 12.5 BTC");
    act(() => root.unmount());
    root = createRoot(container);
    render({ scale: FUTURES_PRINT_SCALE, unit: "contracts" });
    expect([input("Big print from").min, input("Big print from").max, input("Big print from").step, input("Big print from").value]).toEqual(["1", "300", "1", "10"]);
    expect(body().textContent).toContain("Big print from 10 contracts");
    act(() => root.unmount());
    root = createRoot(container);
    render({ scale: EQUITY_PRINT_SCALE, unit: "shares", start: { ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 12_345 } });
    expect([input("Big print from").min, input("Big print from").max, input("Big print from").step, input("Big print from").value]).toEqual(["100", "50000", "100", "12300"]);
    expect(body().textContent).toContain("Big print from 12,300 shares");
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(body().textContent).toContain("Big print from 5");
    expect(body().textContent).not.toContain("Big print from 5 ");
  });

  it("in the selected zone the window is two handles over the last seven days in whole minutes, both at their ends by default", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render({ start: SELECTED });
    const [from, to] = [input("Window start"), input("Window end")];
    expect([from.type, from.min, from.max, from.step, from.value]).toEqual(["range", "0", "10081", "1", "10081"]);
    expect([to.type, to.min, to.max, to.step, to.value]).toEqual(["range", "0", "10081", "1", "10081"]);
    expect(container.textContent).toContain("Window since 10 Oct 02:35 UTC · 7 d");
    expect(onWindowChange).not.toHaveBeenCalled();
  });

  it("draws the window as two native sliders on one line: the start slider read from the right, so its fill runs from the start to the end, and the end slider cut at the middle between the handles", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render({ start: SELECTED, window: { fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: Date.UTC(2026, 9, 17, 2, 6) } });
    const box = container.querySelector<HTMLDivElement>('[data-testid="live-range-window"]')!;
    expect([...box.children].map((element) => [element.tagName, element.className, element.getAttribute("aria-label")])).toEqual([["INPUT", "live-range-window-start", "Window start"], ["INPUT", "live-range-window-end", "Window end"]]);
    expect([box.style.getPropertyValue("--from"), box.style.getPropertyValue("--to"), box.style.getPropertyValue("--cut")]).toEqual([String(10_021 / 10_081), String(10_051 / 10_081), ""]);
    act(() => input("Mode Live").click());
    expect([...box.children].map((element) => element.className)).toEqual(["live-range-window-start"]);
  });

  it("puts the cut on a whole device pixel of the measured slider, so no seam shows where the two sliders meet", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const rect = { left: 100.4, top: 0, width: 216, height: 16, right: 316.4, bottom: 16, x: 100.4, y: 0, toJSON: () => ({}) };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ ...rect }));
    vi.stubGlobal("devicePixelRatio", 2);
    try {
      render({ start: SELECTED });
      const box = container.querySelector<HTMLDivElement>('[data-testid="live-range-window"]')!;
      const cut = () => Number.parseFloat(box.style.getPropertyValue("--cut"));
      expect(cut()).toBeCloseTo(108.1, 9);
      expect(box.style.getPropertyValue("--cut").endsWith("px")).toBe(true);
      setValue(input("Window end"), String(Math.round(10_081 / 2)));
      expect(cut()).toBeCloseTo(Math.round((100.4 + 8 + (Math.round(10_081 / 2) / 10_081 / 2) * 200) * 2) / 2 - 100.4, 9);
      const moved = cut();
      rect.left = 101.1;
      act(() => { vi.advanceTimersByTime(WINDOW_TICK_MS); });
      expect(cut()).toBeCloseTo(Math.round((101.1 + 8 + (Math.round(10_081 / 2) / 10_081 / 2) * 200) * 2) / 2 - 101.1, 9);
      expect(cut()).not.toBeCloseTo(moved, 9);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moving the first handle cuts the oldest minutes and moving the second fixes the end; the handles never cross and a handle back at its end means seven days ago or now again", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render({ start: SELECTED });
    setValue(input("Window start"), String(10_081 - 10_021));
    expect(latestWindow).toEqual({ fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: null });
    expect(container.textContent).toContain("Window since 01:36 UTC · 59 min");
    setValue(input("Window end"), "10051");
    expect(latestWindow).toEqual({ fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: Date.UTC(2026, 9, 17, 2, 6) });
    expect(container.textContent).toContain("Window 01:36 → 02:06 UTC · 30 min");
    expect([input("Window start").value, input("Window end").value]).toEqual([String(10_081 - 10_021), "10051"]);
    setValue(input("Window start"), String(10_081 - 10_060));
    expect(latestWindow).toEqual({ fromMs: Date.UTC(2026, 9, 17, 2, 5), toMs: Date.UTC(2026, 9, 17, 2, 6) });
    setValue(input("Window end"), "10081");
    expect(latestWindow).toEqual({ fromMs: Date.UTC(2026, 9, 17, 2, 5), toMs: null });
    setValue(input("Window start"), "10081");
    expect(latestWindow).toEqual(WHOLE_WINDOW);
    expect(onWindowChange).toHaveBeenCalledTimes(5);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("in Live the window is one handle from there until now: a fixed end is shown as now, and the first move drops it", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render({ start: LIVE, window: { fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: Date.UTC(2026, 9, 17, 2, 6) } });
    expect(inputs()).not.toContain("Window end");
    expect([input("Window start").value, input("Window start").max]).toEqual([String(10_081 - 10_021), "10081"]);
    expect(container.textContent).toContain("Window since 01:36 UTC · 59 min");
    setValue(input("Window start"), String(10_081 - 9_961));
    expect(latestWindow).toEqual({ fromMs: Date.UTC(2026, 9, 17, 0, 36), toMs: null });
    expect(container.textContent).toContain("Window since 00:36 UTC · 119 min");
  });

  it("while open in a zone mode the window follows the clock once a second: the start keeps its clock time while the seven days move on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render({ start: LIVE, window: { fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: null } });
    expect(container.textContent).toContain("Window since 01:36 UTC · 59 min");
    act(() => { vi.advanceTimersByTime(WINDOW_TICK_MS); });
    expect(container.textContent).toContain("Window since 01:36 UTC · 59 min");
    act(() => { vi.advanceTimersByTime(WINDOW_TICK_MS * 40); });
    expect(container.textContent).toContain("Window since 01:36 UTC · 60 min");
    expect(input("Window start").value).toBe(String(10_081 - 10_020));
    expect(WINDOW_TICK_MS).toBe(1_000);
    expect(onWindowChange).not.toHaveBeenCalled();
  });

  it("keeps the big print scale of every instrument on the grid its presets are read with, and has no zone width to restore", () => {
    expect(LIVE_RANGE_SETTINGS_SCHEMA.filter((field) => field.kind === "slider").map((field) => field.key)).toEqual(["zoneOpacity"]);
    const bigPrint = LIVE_RANGE_SETTINGS_SCHEMA.find((field) => "key" in field && field.key === "bigPrint");
    if (bigPrint?.kind !== "numeric") throw new Error("big print is not numeric");
    for (const scale of [CRYPTO_PRINT_SCALE, FUTURES_PRINT_SCALE, EQUITY_PRINT_SCALE]) {
      for (const value of [scale.min, scale.min + scale.step, scale.fallback, scale.max]) {
        expect(value >= bigPrint.min && value <= bigPrint.max).toBe(true);
        const steps = (value - bigPrint.min) / bigPrint.step;
        expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      }
    }
  });

  it("each colour writes its own key, and the chart switch shows and sets whether the indicator is shown", () => {
    render();
    act(() => tab("Visibility").click());
    const colours = [...container.querySelectorAll<HTMLInputElement>('input[type="color"]')].map((element) => [element.getAttribute("aria-label"), element.value]);
    expect(colours).toEqual([["Zone colour", "#2962ff"], ["Bid colour", DEFAULT_LIVE_RANGE_SETTINGS.bidColor], ["Ask colour", DEFAULT_LIVE_RANGE_SETTINGS.askColor]]);
    setValue(input("Zone colour"), "#123456");
    expect(latest).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, zoneColor: "#123456" });
    setValue(input("Bid colour"), "#abcdef");
    expect(latest).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, zoneColor: "#123456", bidColor: "#abcdef" });
    setValue(input("Ask colour"), "#fedcba");
    expect(latest).toEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, zoneColor: "#123456", bidColor: "#abcdef", askColor: "#fedcba" });
    expect(input("Zone colour").value).toBe("#123456");
    expect(onSettingsChange).toHaveBeenCalledTimes(3);
    const onChart = input("Show on chart");
    expect([onChart.type, onChart.checked]).toEqual(["checkbox", true]);
    act(() => onChart.click());
    expect(onVisibleChange.mock.calls).toEqual([[false]]);
    render({ visible: false });
    expect(input("Show on chart").checked).toBe(false);
    act(() => input("Show on chart").click());
    expect(onVisibleChange.mock.calls).toEqual([[false], [true]]);
    expect(onSettingsChange).toHaveBeenCalledTimes(3);
  });

  it("Reset to default puts the defaults back as a copy, shows the indicator again and leaves the window alone", () => {
    render({ start: CHANGED, visible: false, window: { fromMs: NOW - 3_600_000, toMs: null } });
    expect(input("Big print from").value).toBe("12.5");
    act(() => reset().click());
    expect(onSettingsChange.mock.calls).toEqual([[DEFAULT_LIVE_RANGE_SETTINGS]]);
    expect(latest).not.toBe(DEFAULT_LIVE_RANGE_SETTINGS);
    expect(onVisibleChange.mock.calls).toEqual([[true]]);
    expect(input("Mode Visible range").checked).toBe(true);
    expect(onWindowChange).not.toHaveBeenCalled();
  });

  it("Reset to default goes back to the defaults it is given, as a copy", () => {
    const mine: LiveRangeSettings = { ...DEFAULT_LIVE_RANGE_SETTINGS, bigPrint: 7.5, zoneColor: "#654321" };
    render({ start: CHANGED, defaults: mine });
    act(() => reset().click());
    expect(latest).toEqual(mine);
    expect(latest).not.toBe(mine);
  });

  it("keeps its presets under the instrument: saving stores every setting, a preset past the end of a slider comes back at that end, a mode or a monitor size it does not know comes back as the default, and Reset settings is Reset to default", async () => {
    const key = `liveRangeControl@${SCOPE}`;
    const saved: LiveRangeSettings = { ...DEFAULT_LIVE_RANGE_SETTINGS, rangeMode: "selected", bigPrint: 2.5, verdictSensitivity: "high", askColor: "#123456", cardSize: "small", showZone: false, showMinutesRow: false, showTips: false };
    render({ start: saved, presetScope: SCOPE });
    await saveAs("Tight");
    expect(stored()).toEqual({ [key]: [{ name: "Tight", params: saved }] });
    await act(async () => {
      await indicatorPresets.save(key, "Wide", { widthPct: 9, zoneColor: "#abcdef", rangeMode: "zone", bigPrint: 80_000, verdictSensitivity: "loose", cardSize: "huge", showZone: "no", showDeltaRow: 0, showTips: "off" });
    });
    await apply("Wide");
    expect(latest).toStrictEqual({ ...DEFAULT_LIVE_RANGE_SETTINGS, zoneColor: "#abcdef", bigPrint: 50_000 });
    await apply("Tight");
    expect(latest).toEqual(saved);
    onSettingsChange.mockClear();
    await openMenu();
    await click(item("Reset settings"));
    expect(onSettingsChange.mock.calls).toEqual([[DEFAULT_LIVE_RANGE_SETTINGS]]);
    expect(onVisibleChange.mock.calls).toEqual([[true]]);
    expect(onWindowChange).not.toHaveBeenCalled();
  });

  it("keeps one preset list for every instrument when it is given no scope", async () => {
    render();
    await saveAs("Plain");
    expect(Object.keys(stored())).toEqual(["liveRangeControl"]);
  });

  it("closes through the shared dialog: the close button, Ok, Escape and the backdrop each call back once", () => {
    render();
    act(() => container.querySelector<HTMLButtonElement>(".indicator-settings-close")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => container.querySelector<HTMLButtonElement>(".indicator-settings-ok")!.click());
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(3);
    act(() => container.querySelector<HTMLDivElement>(".modal-backdrop")!.click());
    expect(onClose).toHaveBeenCalledTimes(4);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    render({ isOpen: false });
    expect(container.querySelector('[aria-label="Live Range Control settings"]')).toBeNull();
  });
});
