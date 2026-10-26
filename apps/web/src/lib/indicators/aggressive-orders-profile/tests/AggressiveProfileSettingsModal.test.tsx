// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AggressiveProfileSettingsModal } from "../AggressiveProfileSettingsModal";
import type { FrameIdentity } from "../../../../types/frames";
import { DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floorPosition, floorScaleFor, floorStops, type AggressiveProfileSettings } from "../aggressiveProfileSettings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: AggressiveProfileSettings = DEFAULT_AGGRESSIVE_PROFILE_SETTINGS;
const onVisibleChange = vi.fn();
const BTC_PERP = { symbol: "BTC-USDT", provider: "BINANCE", marketKind: "PERPETUAL" } as const;

function Harness({ typicalFloor = 8.2, sizeUnit = "BTC", instrument = BTC_PERP, initial = DEFAULT_AGGRESSIVE_PROFILE_SETTINGS }: { typicalFloor?: number; sizeUnit?: string; instrument?: ({ symbol: string } & FrameIdentity) | null; initial?: AggressiveProfileSettings }) {
  const [settings, setSettings] = useState(initial);
  return (
    <AggressiveProfileSettingsModal
      isOpen={true}
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      visible={true}
      onVisibleChange={onVisibleChange}
      typicalFloor={typicalFloor}
      instrument={instrument ?? undefined}
      sizeUnit={sizeUnit}
      presetScope="BINANCE:PERPETUAL:BTC-USDT"
    />
  );
}

describe("the Aggressive Orders Profile settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = DEFAULT_AGGRESSIVE_PROFILE_SETTINGS;
    onVisibleChange.mockClear();
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const slide = (element: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const choose = (element: HTMLSelectElement, value: string) => {
    act(() => {
      element.value = value;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!;

  it("names the floor, the view and the highlight in a few plain words on the Inputs tab, with two lines under the floor slider, and the look on the Visibility tab", () => {
    expect(container.querySelector('[aria-label="Aggressive Orders Profile settings"]')).not.toBeNull();
    expect([...container.querySelectorAll(".indicator-settings-hint")].map((hint) => hint.textContent)).toEqual([
      "Starts at the heatmap's floor, 8.2 BTC.",
      "Aggressive Orders draws its bubbles from another threshold; set the same floor to make each bar the sum of its candle's bubbles over the last 4 hours (older minutes keep only its 4 biggest prints a side).",
    ]);
    const text = container.textContent ?? "";
    for (const name of ["Big print floor auto (the heatmap's, 8.2 BTC now)", "Show as", "Highlight bars over 2× the average"]) expect(text).toContain(name);
    expect([...select("Show as").options].map((option) => [option.value, option.textContent])).toEqual([["delta", "Net delta"], ["sides", "Buys and sells"]]);
    for (const gone of ["Running total", "Bar width", "Profile width", "Show sizes", "Near price", "Buys color"]) expect(text).not.toContain(gone);
    act(() => tab("Visibility").click());
    const look = container.textContent ?? "";
    for (const name of ["Buys color", "Sells color", "Show on chart"]) expect(look).toContain(name);
    for (const gone of ["Big print floor", "Show as", "Highlight bars", "Bar opacity"]) expect(look).not.toContain(gone);
  });

  it("the floor slider starts at the heatmap's floor and climbs through stops spaced by ratio up to the instrument's top, in the book's units", () => {
    const stops = floorStops(floorScaleFor(BTC_PERP, 8.2), 8.2);
    expect(stops).toEqual([10, 12, 15, 20, 25, 30, 40, 50]);
    const floor = input("Big print floor");
    expect(floor.dataset.freeRange).toBe("true");
    expect([floor.min, floor.max, floor.step, floor.value]).toEqual(["0", "8", "1", "0"]);
    slide(floor, String(floorPosition(stops, 12)));
    expect(latest.floor).toBe(12);
    expect(input("Big print floor").value).toBe("2");
    expect(container.textContent).toContain("Big print floor 12 BTC");
    slide(input("Big print floor"), "8");
    expect(latest.floor).toBe(50);
    slide(input("Big print floor"), "0");
    expect(latest.floor).toBe(0);
    act(() => root.render(<Harness typicalFloor={0.2} />));
    expect(container.textContent).toContain("Big print floor auto (the heatmap's, 0.2 BTC now)");
    expect(container.textContent).toContain("Starts at the heatmap's floor, 0.2 BTC.");
    const fine = floorStops(floorScaleFor(BTC_PERP, 0.2), 0.2);
    expect(fine.slice(0, 2)).toEqual([0.25, 0.3]);
    expect(input("Big print floor").max).toBe(String(fine.length));
    slide(input("Big print floor"), String(floorPosition(fine, 0.3)));
    expect(latest.floor).toBe(0.3);
    expect(container.textContent).toContain("Big print floor 0.3 BTC");
  });

  it("reads a floor at or under the heatmap's as auto, and tops the slider per instrument, at a hundred times the heatmap's floor without one", () => {
    act(() => root.render(<Harness key="saved" initial={{ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 5 }} />));
    expect(container.textContent).toContain("Big print floor auto (the heatmap's, 8.2 BTC now)");
    expect(input("Big print floor").value).toBe("0");
    act(() => root.render(<Harness key="equal" initial={{ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 8.2 }} />));
    expect(container.textContent).toContain("Big print floor auto (the heatmap's, 8.2 BTC now)");
    expect(input("Big print floor").value).toBe("0");
    act(() => root.render(<Harness key="saved" initial={{ ...DEFAULT_AGGRESSIVE_PROFILE_SETTINGS, floor: 5 }} typicalFloor={2} />));
    expect(container.textContent).toContain("Big print floor 5 BTC");
    expect(input("Big print floor").value).toBe(String(floorPosition(floorStops(floorScaleFor(BTC_PERP, 2), 2), 5)));
    act(() => root.render(<Harness key="bare" typicalFloor={8.2} instrument={null} />));
    expect(input("Big print floor").max).toBe(String(floorStops({ max: 1_000, whole: false }, 8.2).length));
    slide(input("Big print floor"), input("Big print floor").max);
    expect(latest.floor).toBe(1_000);
    act(() => root.render(<Harness key="nq" typicalFloor={2} instrument={{ symbol: "/NQZ26:XCME", provider: "DXFEED", assetClass: "FUTURE" }} sizeUnit="contracts" />));
    expect(input("Big print floor").max).toBe("16");
    expect(container.textContent).toContain("Starts at the heatmap's floor, 2 contracts.");
    act(() => root.render(<Harness key="stocks" typicalFloor={1_500} instrument={{ symbol: "AAPL", provider: "DXFEED", assetClass: "EQUITY" }} sizeUnit="shares" />));
    expect(container.textContent).toContain("Starts at the heatmap's floor, 1.5k shares.");
    expect(input("Big print floor").max).toBe("1");
    act(() => root.render(<Harness key="top" typicalFloor={2_000} instrument={{ symbol: "TSLA", provider: "DXFEED", assetClass: "EQUITY" }} sizeUnit="shares" />));
    expect(input("Big print floor").max).toBe("10");
    slide(input("Big print floor"), "10");
    expect(latest.floor).toBe(20_000);
    act(() => root.render(<Harness key="none" typicalFloor={0} />));
    expect(container.textContent).toContain("Starts at the heatmap's floor.");
    expect(input("Big print floor").max).toBe("31");
  });

  it("the view and the highlight change the settings, and the highlight slider reads off at zero", () => {
    choose(select("Show as"), "sides");
    expect(latest.profileView).toBe("sides");
    expect(select("Show as").value).toBe("sides");
    const highlight = input("Highlight bars");
    expect([highlight.min, highlight.max, highlight.step, highlight.value]).toEqual(["0", "5", "0.5", "2"]);
    slide(highlight, "3.5");
    expect(latest.outlierFrom).toBe(3.5);
    expect(container.textContent).toContain("Highlight bars over 3.5× the average");
    slide(highlight, "0");
    expect(latest.outlierFrom).toBe(0);
    expect(container.textContent).toContain("Highlight bars off");
  });

  it("the Visibility tab changes the colours and the chart", () => {
    act(() => tab("Visibility").click());
    slide(input("Buys color"), "#123456");
    expect(latest.buyColor).toBe("#123456");
    slide(input("Sells color"), "#654321");
    expect(latest.sellColor).toBe("#654321");
    act(() => input("Show on chart").click());
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);
  });

  it("reset puts every setting back and shows the indicator again", () => {
    slide(input("Big print floor"), "15");
    choose(select("Show as"), "sides");
    slide(input("Highlight bars"), "0");
    act(() => tab("Visibility").click());
    slide(input("Sells color"), "#654321");
    expect(latest).not.toEqual(DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
    act(() => container.querySelector<HTMLButtonElement>(".indicator-settings-reset")!.click());
    expect(latest).toEqual(DEFAULT_AGGRESSIVE_PROFILE_SETTINGS);
    expect(onVisibleChange).toHaveBeenLastCalledWith(true);
  });
});
