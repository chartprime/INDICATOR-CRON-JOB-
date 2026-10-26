// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WhaleHeatmapSettingsModal } from "../WhaleHeatmapSettingsModal";
import { DEFAULT_WHALE_SETTINGS, type WhaleSettings } from "../whaleSettings";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: WhaleSettings = DEFAULT_WHALE_SETTINGS;
let visibleCalls: boolean[] = [];

function Harness({ initial = DEFAULT_WHALE_SETTINGS }: { initial?: WhaleSettings }) {
  const [settings, setSettings] = useState(initial);
  return (
    <WhaleHeatmapSettingsModal
      isOpen
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      visible
      onVisibleChange={(value) => visibleCalls.push(value)}
    />
  );
}

describe("whale heatmap settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(initial?: WhaleSettings) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness initial={initial} />));
  }

  beforeEach(() => {
    latest = DEFAULT_WHALE_SETTINGS;
    visibleCalls = [];
    mount();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const text = () => document.body.textContent ?? "";
  const field = (label: string) => [...document.querySelectorAll<HTMLElement>("label.indicator-settings-field")].find((item) => item.textContent?.startsWith(label))!;
  const select = (label: string) => field(label).querySelector("select")!;
  const range = (label: string) => field(label).querySelector("input")!;
  const check = (label: string) => [...document.querySelectorAll<HTMLElement>("label.indicator-settings-checkbox")].find((item) => item.textContent === label)!.querySelector("input")!;
  const choose = (element: HTMLSelectElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const slide = (element: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const open = (tab: string) => act(() => [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((item) => item.textContent === tab)!.click());

  it("opens on the inputs with the defaults: 48 hours, dollar cut at the top 10%, filled and partial always shown, both sides", () => {
    expect(select("History").value).toBe("48");
    expect(select("Cut walls by").value).toBe("usd");
    expect(text()).toContain("Show walls in the top 10% by size");
    expect(select("Side").value).toBe("both");
    expect(check("Always show filled and partial walls").checked).toBe(true);
    expect(text()).toContain("Thickness: 3 px");
    expect([...select("History").options].map((option) => option.textContent)).toEqual(["12 hours", "24 hours", "48 hours", "7 days"]);
  });

  it("changes the history, the side and the thickness, and keeps every other choice", () => {
    choose(select("History"), "168");
    expect(latest).toEqual({ ...DEFAULT_WHALE_SETTINGS, hours: 168 });
    choose(select("Side"), "ask");
    expect(latest.sideFilter).toBe("ask");
    choose(select("Side"), "bid");
    expect(latest.sideFilter).toBe("bid");
    choose(select("Side"), "both");
    expect(latest.sideFilter).toBe("both");
    slide(range("Thickness"), "6");
    expect(latest).toEqual({ ...DEFAULT_WHALE_SETTINGS, hours: 168, thickness: 6 });
    slide(range("Thickness"), "99");
    expect(latest.thickness).toBe(8);
  });

  it("moves the dollar cut by preset, and swaps it for an importance cut when the basis changes", () => {
    slide(range("Show walls in the"), "4");
    expect(latest.cutPreset).toBe(4);
    expect(text()).toContain("Show walls in the top 1% by size");
    choose(select("Cut walls by"), "ratio");
    expect(latest.cutBasis).toBe("ratio");
    expect(text()).not.toContain("by size");
    expect(text()).toContain("Importance at least 5x the usual wall");
    slide(range("Importance at least"), "12");
    expect(latest.ratioMin).toBe(12);
    expect(text()).toContain("Importance at least 12x the usual wall");
    choose(select("Cut walls by"), "usd");
    expect(latest.cutBasis).toBe("usd");
  });

  it("switches the always-show-fills choice", () => {
    act(() => check("Always show filled and partial walls").click());
    expect(latest.fills).toBe(false);
  });

  it("turns each outcome on or off by its own bit, from the visibility tab", () => {
    open("Visibility");
    expect(["filled", "partial", "touched", "pulled", "moved"].map((name) => check(`Show ${name} walls`).checked)).toEqual([true, true, true, true, false]);
    act(() => check("Show moved walls").click());
    expect(latest.outcomeMask).toBe(0b11111);
    act(() => check("Show filled walls").click());
    expect(latest.outcomeMask).toBe(0b11110);
    act(() => check("Show touched walls").click());
    expect(latest.outcomeMask).toBe(0b11010);
  });

  it("offers the live book choices and the label switch, and reports the show-on-chart choice", () => {
    open("Visibility");
    expect([...select("Live book").options].map((option) => option.value)).toEqual(["ladder", "rays", "both", "off"]);
    choose(select("Live book"), "rays");
    expect(latest.liveView).toBe("rays");
    choose(select("Live book"), "bogus");
    expect(latest.liveView).toBe("ladder");
    act(() => check("Label live walls with size and age").click());
    expect(latest.labels).toBe(false);
    act(() => check("Show on chart").click());
    expect(visibleCalls).toEqual([false]);
  });

  it("puts every choice back to its default on reset", () => {
    choose(select("History"), "12");
    slide(range("Thickness"), "7");
    act(() => document.querySelector<HTMLButtonElement>(".indicator-settings-reset")!.click());
    expect(latest).toEqual(DEFAULT_WHALE_SETTINGS);
    expect(select("History").value).toBe("48");
  });
});
