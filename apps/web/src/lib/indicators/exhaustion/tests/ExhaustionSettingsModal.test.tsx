// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ExhaustionSettingsModal } from "../ExhaustionSettingsModal";
import { DEFAULT_EXHAUSTION_SETTINGS, type ExhaustionSettings } from "../exhaustionSettings";
import { DEFAULT_LIQUIDITY_SETTINGS } from "../../passive-liquidity/liquiditySettings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: ExhaustionSettings = DEFAULT_EXHAUSTION_SETTINGS;
let shown = true;

function Harness({ start }: { start: ExhaustionSettings }) {
  const [settings, setSettings] = useState(start);
  latest = settings;
  return (
    <ExhaustionSettingsModal
      isOpen={true}
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      defaults={DEFAULT_EXHAUSTION_SETTINGS}
      visible={shown}
      onVisibleChange={(next) => {
        shown = next;
      }}
    />
  );
}

describe("the Exhaustion dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = DEFAULT_EXHAUSTION_SETTINGS;
    shown = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(start: ExhaustionSettings = DEFAULT_EXHAUSTION_SETTINGS) {
    act(() => {
      root.render(<Harness start={start} />);
    });
  }

  const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.trim() === name)!;
  const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[name="exhaustion-history-days"]')];
  const setValue = (input: HTMLInputElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("opens on Inputs with the history reach, the legs switch off and Hide nested legs right under it, then Show broken, no shades switch, no explanatory text and no numbers to set", () => {
    render();
    expect(container.querySelector('[aria-label="Exhaustion settings"]')).not.toBeNull();
    expect(tab("Inputs").getAttribute("aria-selected")).toBe("true");
    expect(radios().map((input) => input.parentElement?.textContent?.trim())).toEqual(["Off", "1 day", "3 days", "5 days", "1 week"]);
    expect(radios().map((input) => input.checked)).toEqual([false, true, false, false, false]);
    expect(container.textContent).toContain("Show broken");
    expect(container.querySelectorAll(".indicator-settings-hint")).toHaveLength(0);
    const order = [...container.querySelectorAll<HTMLInputElement>("input")].map((input) => input.getAttribute("aria-label") ?? input.getAttribute("name"));
    expect(order.indexOf("Hide nested legs")).toBe(order.indexOf("Show legs") + 1);
    expect(order.indexOf("Show broken")).toBe(order.indexOf("Hide nested legs") + 1);
    expect(order).not.toContain("Show shades");
    expect(order.indexOf("Show broken")).toBeLessThan(order.indexOf("exhaustion-history-days"));
    const ranges = [...container.querySelectorAll<HTMLInputElement>('input[type="range"]')];
    expect(ranges.map((input) => [input.getAttribute("aria-label"), input.value])).toEqual([["Leg size in ATR", "8"], ["Leg reversal in ATR", "3"], ["Leg straightness", "0.5"], ["Confidence score", "5"], ["Exhaustion area size", "2"]]);
    expect(container.textContent).toContain("Legs · 8 ATR at the least");
    expect(container.textContent).toContain("Exhaustion area ×2");
    setValue(ranges[4], "3.5");
    expect(latest.zoneScale).toBe(3.5);
    expect(container.textContent).toContain("Exhaustion area ×3.5");
    expect(order.indexOf("Show legs")).toBe(order.indexOf("Show exhaustion areas only") + 1);
    const areasOnly = container.querySelector<HTMLInputElement>('input[aria-label="Show exhaustion areas only"]')!;
    expect(areasOnly.checked).toBe(false);
    act(() => areasOnly.click());
    expect(latest.zonesOnly).toBe(true);
    setValue(ranges[0], "12");
    expect(latest.legAtr).toBe(12);
    setValue(ranges[1], "2");
    expect(latest.legReverseAtr).toBe(2);
    setValue(ranges[2], "0.7");
    expect(latest.legEfficiency).toBe(0.7);
    const showLegs = container.querySelector<HTMLInputElement>('input[aria-label="Show legs"]')!;
    expect(showLegs.checked).toBe(false);
    act(() => showLegs.click());
    expect(latest.showLegs).toBe(true);
    expect(container.querySelector('input[aria-label="Show shades"]')).toBeNull();
    const hideNested = container.querySelector<HTMLInputElement>('input[aria-label="Hide nested legs"]')!;
    expect(hideNested.checked).toBe(false);
    act(() => hideNested.click());
    expect(latest.hideNestedLegs).toBe(true);
    expect(container.querySelectorAll('input[type="color"]')).toHaveLength(0);
    act(() => radios()[3].click());
    expect(latest.historyDays).toBe(5);
    expect(radios().map((input) => input.checked)).toEqual([false, false, false, true, false]);
    act(() => radios()[0].click());
    expect(latest.historyDays).toBe(0);
    const broken = container.querySelector<HTMLInputElement>('input[aria-label="Show broken"]')!;
    expect(broken.checked).toBe(true);
    act(() => broken.click());
    expect(latest.showBroken).toBe(false);
    const monitor = container.querySelector<HTMLInputElement>('input[aria-label="Show monitor"]')!;
    expect(monitor.checked).toBe(true);
    expect(order.indexOf("Show monitor")).toBe(order.indexOf("Show broken") + 1);
    act(() => monitor.click());
    expect(latest.showMonitor).toBe(false);
  });

  it("the Visibility tab holds the two colours, the opacity and the on-chart switch", () => {
    render();
    act(() => tab("Visibility").click());
    expect(tab("Visibility").getAttribute("aria-selected")).toBe("true");
    expect(radios()).toHaveLength(0);
    const colours = [...container.querySelectorAll<HTMLInputElement>('input[type="color"]')];
    expect(colours.map((input) => input.getAttribute("aria-label"))).toEqual(["Buyers exhausted colour", "Sellers exhausted colour"]);
    expect(colours.map((input) => input.value)).toEqual([DEFAULT_LIQUIDITY_SETTINGS.askColor, DEFAULT_LIQUIDITY_SETTINGS.bidColor]);
    setValue(colours[0], "#123456");
    expect(latest.buyerColor).toBe("#123456");
    setValue(colours[1], "#abcdef");
    expect(latest.sellerColor).toBe("#abcdef");
    const opacity = container.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
    expect(container.textContent).toContain("Opacity 60%");
    setValue(opacity, "0.3");
    expect(latest.opacity).toBe(0.3);
    expect(container.textContent).toContain("Opacity 30%");
    const onChart = container.querySelector<HTMLInputElement>('input[aria-label="Show on chart"]')!;
    expect(onChart.checked).toBe(true);
    act(() => onChart.click());
    expect(shown).toBe(false);
  });

  it("Reset to default puts the defaults back and shows the indicator again", () => {
    shown = false;
    render({ opacity: 0.2, buyerColor: "#123456", sellerColor: "#abcdef", showBroken: false, historyDays: 7, zoneScale: 4, zonesOnly: true });
    expect(radios().map((input) => input.checked)).toEqual([false, false, false, false, true]);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Exhaustion area size"]')!.value).toBe("4");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Show exhaustion areas only"]')!.checked).toBe(true);
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Reset to default")!.click());
    expect(latest).toEqual(DEFAULT_EXHAUSTION_SETTINGS);
    expect(shown).toBe(true);
    expect(radios().map((input) => input.checked)).toEqual([false, true, false, false, false]);
  });
});
