// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LiveOrderBookProfileSettingsModal } from "../LiveOrderBookProfileSettingsModal";
import { DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS, MAX_RESTING_SHARE, MAX_RESTING_STAND_S, MIN_RESTING_SHARE, MIN_RESTING_STAND_S, type LiveOrderBookProfileSettings } from "../liveOrderBookProfileSettings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: LiveOrderBookProfileSettings = DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS;

function Harness() {
  const [settings, setSettings] = useState(DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS);
  return (
    <LiveOrderBookProfileSettingsModal
      isOpen={true}
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      visible={true}
      onVisibleChange={() => {}}
      heatmapSettings={{ clusterRows: 3 }}
      rowWidth={4}
      intervalMs={60_000}
      typicalSize={9.4}
      sizeUnit="contracts"
    />
  );
}

describe("the book profile's resting-order settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = DEFAULT_LIVE_ORDER_BOOK_PROFILE_SETTINGS;
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const slide = (element: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("names every setting in a few plain words, with no explanation text under them", () => {
    expect(container.querySelectorAll(".indicator-settings-hint")).toHaveLength(0);
    const text = container.textContent ?? "";
    for (const name of ["Row size", "Profile width 12%", "Show sizes", "Bigger order S/R zones", "Min size auto (28 contracts now)", "Show after 30 s", "Bar length 20%"]) expect(text).toContain(name);
    expect(text).not.toContain("Show big orders");
  });

  it("switches the zones on and off with two circles under their own heading, like the row size", () => {
    const group = container.querySelector("[role=radiogroup][aria-label=\"Bigger order S/R zones\"]")!;
    const circles = Array.from(group.querySelectorAll<HTMLInputElement>("input[type=radio][name=live-order-book-zones]"));
    expect(circles.map((circle) => [circle.nextElementSibling?.textContent, circle.checked])).toEqual([["On", true], ["Off", false]]);
    act(() => circles[1].click());
    expect(latest.showResting).toBe(false);
    expect(circles[1].checked).toBe(true);
    expect(container.querySelector('input[aria-label="Min size"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Big order reach"]')).toBeNull();
    act(() => circles[0].click());
    expect(latest.showResting).toBe(true);
    expect(container.querySelector('input[aria-label="Min size"]')).not.toBeNull();
  });

  it("sets the minimum size in the book's own units on a scale from the book's typical row, auto at zero, and how far the biggest bar reaches, inside their bounds", () => {
    const size = input("Min size");
    expect([size.min, size.max, size.step, size.value]).toEqual(["0", "200", "1", "0"]);
    slide(size, "50");
    expect(latest.restingMinSize).toBe(50);
    expect(container.textContent).toContain("Min size 50 contracts");
    slide(size, "0");
    expect(latest.restingMinSize).toBe(0);
    expect(container.textContent).toContain("Min size auto (28 contracts now)");
    const wait = input("Big order wait");
    expect([wait.min, wait.max, wait.step, wait.value]).toEqual([String(MIN_RESTING_STAND_S), String(MAX_RESTING_STAND_S), "1", "30"]);
    slide(wait, "60");
    expect(latest.restingStandS).toBe(60);
    expect(container.textContent).toContain("Show after 60 s");
    const reach = input("Big order reach");
    expect([reach.min, reach.max, reach.step, reach.value]).toEqual([String(MIN_RESTING_SHARE), String(MAX_RESTING_SHARE), "0.01", "0.2"]);
    slide(reach, "0.45");
    expect(latest.restingShare).toBe(0.45);
    expect(container.textContent).toContain("Bar length 45%");
  });
});
