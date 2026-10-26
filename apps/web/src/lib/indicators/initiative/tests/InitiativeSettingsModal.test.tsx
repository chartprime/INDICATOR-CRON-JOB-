// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InitiativeSettingsModal } from "../InitiativeSettingsModal";
import { DEFAULT_BUYER_COLOR, DEFAULT_INITIATIVE_SETTINGS, DEFAULT_SELLER_COLOR, type InitiativeSettings } from "../initiativeSettings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: InitiativeSettings = DEFAULT_INITIATIVE_SETTINGS;
let shown = true;

function Harness({ start }: { start: InitiativeSettings }) {
  const [settings, setSettings] = useState(start);
  latest = settings;
  return (
    <InitiativeSettingsModal
      isOpen={true}
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      defaults={DEFAULT_INITIATIVE_SETTINGS}
      visible={shown}
      onVisibleChange={(next) => {
        shown = next;
      }}
    />
  );
}

describe("the Initiative Continuation dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = DEFAULT_INITIATIVE_SETTINGS;
    shown = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(start: InitiativeSettings = DEFAULT_INITIATIVE_SETTINGS) {
    act(() => {
      root.render(<Harness start={start} />);
    });
  }

  const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.trim() === name)!;
  const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[name="initiative-history-days"]')];
  const setValue = (input: HTMLInputElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("opens on Inputs with the score floor at 4 of 5, the leg floor at 7.5 ATR and the history reach; no switches and no explanatory text there", () => {
    render();
    expect(container.querySelector('[aria-label="Initiative Continuation settings"]')).not.toBeNull();
    expect(tab("Inputs").getAttribute("aria-selected")).toBe("true");
    expect(radios().map((input) => input.parentElement?.textContent?.trim())).toEqual(["Off", "1 day", "3 days", "5 days", "1 week"]);
    expect(radios().map((input) => input.checked)).toEqual([false, true, false, false, false]);
    expect(container.querySelectorAll(".indicator-settings-hint")).toHaveLength(0);
    const order = [...container.querySelectorAll<HTMLInputElement>("input")].map((input) => input.getAttribute("aria-label") ?? input.getAttribute("name"));
    expect(order.slice(0, 3)).toEqual(["Minimum score", "Minimum leg size", "initiative-history-days"]);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    const score = container.querySelector<HTMLInputElement>('input[aria-label="Minimum score"]')!;
    expect([score.min, score.max, score.step, score.value]).toEqual(["0", "5", "1", "4"]);
    expect(container.textContent).toContain("Score at least 4 of 5");
    setValue(score, "0");
    expect(latest.minScore).toBe(0);
    expect(container.textContent).toContain("Score at least 0 of 5");
    const leg = container.querySelector<HTMLInputElement>('input[aria-label="Minimum leg size"]')!;
    expect([leg.min, leg.max, leg.step, leg.value]).toEqual(["3", "10", "0.5", "7.5"]);
    expect(container.textContent).toContain("Leg at least 7.5 ATR");
    setValue(leg, "6.5");
    expect(latest.minLegAtr).toBe(6.5);
    expect(container.textContent).toContain("Leg at least 6.5 ATR");
    expect(container.querySelectorAll('input[type="color"]')).toHaveLength(0);
    act(() => radios()[3].click());
    expect(latest.historyDays).toBe(5);
    expect(radios().map((input) => input.checked)).toEqual([false, false, false, true, false]);
    act(() => radios()[0].click());
    expect(latest.historyDays).toBe(0);
  });

  it("the Visibility tab holds the shade and chip switches, both on, the two colours (green buyers, red sellers), the opacity and the on-chart switch, in that order", () => {
    render();
    act(() => tab("Visibility").click());
    expect(tab("Visibility").getAttribute("aria-selected")).toBe("true");
    expect(radios()).toHaveLength(0);
    const order = [...container.querySelectorAll<HTMLInputElement>("input")].map((input) => input.getAttribute("aria-label"));
    expect(order).toEqual(["Show shade", "Show chip", "Buyers colour", "Sellers colour", "Opacity", "Show on chart"]);
    const circle = container.querySelector<HTMLInputElement>('input[aria-label="Show shade"]')!;
    expect(circle.checked).toBe(true);
    act(() => circle.click());
    expect(latest.showShade).toBe(false);
    const chip = container.querySelector<HTMLInputElement>('input[aria-label="Show chip"]')!;
    expect(chip.checked).toBe(true);
    act(() => chip.click());
    expect(latest.showLabels).toBe(false);
    const colours = [...container.querySelectorAll<HTMLInputElement>('input[type="color"]')];
    expect(colours.map((input) => input.value)).toEqual([DEFAULT_BUYER_COLOR, DEFAULT_SELLER_COLOR]);
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
    render({ opacity: 0.2, buyerColor: "#123456", sellerColor: "#abcdef", historyDays: 7, minScore: 5, minLegAtr: 8, showShade: false, showLabels: false });
    expect(radios().map((input) => input.checked)).toEqual([false, false, false, false, true]);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Minimum score"]')!.value).toBe("5");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Minimum leg size"]')!.value).toBe("8");
    act(() => tab("Visibility").click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Show shade"]')!.checked).toBe(false);
    act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Reset to default")!.click());
    expect(latest).toEqual(DEFAULT_INITIATIVE_SETTINGS);
    expect(shown).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Show shade"]')!.checked).toBe(true);
  });
});
