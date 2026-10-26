// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AbsorptionSettingsModal } from "../AbsorptionSettingsModal";
import { DEFAULT_ABSORPTION_SETTINGS, type AbsorptionSettings } from "../absorptionSettings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: AbsorptionSettings = DEFAULT_ABSORPTION_SETTINGS;

function Harness({ start }: { start: AbsorptionSettings }) {
  const [settings, setSettings] = useState(start);
  latest = settings;
  return (
    <AbsorptionSettingsModal
      isOpen={true}
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      defaults={DEFAULT_ABSORPTION_SETTINGS}
      visible={true}
      onVisibleChange={() => {}}
    />
  );
}

describe("the absorption dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = DEFAULT_ABSORPTION_SETTINGS;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(start: AbsorptionSettings = DEFAULT_ABSORPTION_SETTINGS) {
    act(() => {
      root.render(<Harness start={start} />);
    });
  }

  const slider = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const setValue = (input: HTMLInputElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const range = (input: HTMLInputElement) => [input.type, input.min, input.max, input.step, input.value];
  const tab = (name: string) => act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!.click());

  it("offers no choice of source and no comparison button, whatever an old session saved", () => {
    render({ ...DEFAULT_ABSORPTION_SETTINGS, source: "both" } as unknown as AbsorptionSettings);
    expect(container.querySelectorAll('input[name="absorption-source"]')).toHaveLength(0);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Save comparison")).toBe(false);
    expect(container.textContent).not.toContain("Spheres from");
  });

  it("is titled Prime Absorption and lets the trader draw the marks as circles, triangles or squares, circles to begin with, under Visibility with the colours, the size and the opacity", () => {
    render();
    expect(container.querySelector('[aria-label="Prime Absorption settings"]')).not.toBeNull();
    expect(container.textContent).toContain("Prime Absorption");
    expect(container.textContent).not.toContain("Absorption Detector");
    // Inputs first: the rule's numbers, the broken switch and History; the drawing settings sit under Visibility like the other indicators'.
    expect([...container.querySelectorAll('[role="tab"]')].map((button) => [button.textContent, button.getAttribute("aria-selected")])).toEqual([["Inputs", "true"], ["Visibility", "false"]]);
    expect(container.querySelector('input[name="absorption-shape"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Bid wall colour"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Opacity"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Show on chart"]')).toBeNull();
    expect(container.querySelector('input[name="absorption-history-days"]')).not.toBeNull();
    tab("Visibility");
    expect(container.querySelector('input[aria-label="Absorbed share"]')).toBeNull();
    expect(container.querySelector('input[name="absorption-history-days"]')).toBeNull();
    for (const label of ["Bid wall colour", "Ask wall colour", "Bubble size", "Opacity", "Show on chart"]) expect(container.querySelector(`input[aria-label="${label}"]`)).not.toBeNull();
    const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[name="absorption-shape"]')];
    expect(radios().map((input) => input.parentElement?.textContent?.trim())).toEqual(["Circle", "Triangle", "Square"]);
    expect(radios().map((input) => input.checked)).toEqual([true, false, false]);
    act(() => radios()[1].click());
    expect(latest.shape).toBe("triangle");
    expect(radios().map((input) => input.checked)).toEqual([false, true, false]);
    act(() => radios()[2].click());
    expect(latest.shape).toBe("square");
  });

  it("offers history off, 1 day, 3 days, 5 days and 1 week, starts at 1 day, and saves the choice (PR #47 review)", () => {
    render();
    const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[name="absorption-history-days"]')];
    expect(radios().map((input) => input.parentElement?.textContent?.trim())).toEqual(["Off", "1 day", "3 days", "5 days", "1 week"]);
    expect(radios().map((input) => input.checked)).toEqual([false, true, false, false, false]);
    expect(container.querySelector('input[aria-label="History hours"]')).toBeNull();
    act(() => radios()[2].click());
    expect(latest.historyDays).toBe(3);
    expect(radios().map((input) => input.checked)).toEqual([false, false, true, false, false]);
    act(() => radios()[0].click());
    expect(latest.historyDays).toBe(0);
    expect(radios().map((input) => input.checked)).toEqual([true, false, false, false, false]);
  });

  it("says no rule paragraph, only the settings, and has no wall floor box: the walls are the heatmap's", () => {
    render();
    expect(container.textContent).not.toContain("The rule");
    expect(container.textContent).not.toContain("when an attack begins");
    expect(container.querySelector('input[aria-label="Wall floor"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Wall floor slider"]')).toBeNull();
    expect(container.textContent).not.toContain("Wall floor");
  });

  it("shows the rule's three numbers as sliders at their defaults, each with its words", () => {
    render();
    expect(range(slider("Absorbed share"))).toEqual(["range", "50", "500", "10", "200"]);
    expect(range(slider("Strong share"))).toEqual(["range", "150", "1000", "10", "300"]);
    expect(range(slider("Minimum absorbed"))).toEqual(["range", "3", "200", "1", "40"]);
    expect(container.textContent).toContain("Absorbed · 200% of the wall");
    expect(container.textContent).toContain("Strong · 300%");
    expect(container.textContent).toContain("Minimum absorbed · 40× the book's typical level");
  });

  it("stores what a slider points at, and the words follow", () => {
    render();
    setValue(slider("Absorbed share"), "250");
    expect(latest.absorbedPercent).toBe(250);
    expect(container.textContent).toContain("Absorbed · 250% of the wall");
    setValue(slider("Strong share"), "600");
    expect(latest.strongPercent).toBe(600);
    expect(container.textContent).toContain("Strong · 600%");
    setValue(slider("Minimum absorbed"), "65");
    expect(latest.absorbedMultiple).toBe(65);
    expect(container.textContent).toContain("Minimum absorbed · 65× the book's typical level");
    expect(latest).toMatchObject({ absorbedPercent: 250, strongPercent: 600, absorbedMultiple: 65 });
  });

  it("reads the strong share as never under the absorbed share, and a saved number outside its slider at the slider's end", () => {
    render({ ...DEFAULT_ABSORPTION_SETTINGS, absorbedPercent: 400, strongPercent: 300, absorbedMultiple: 900 });
    expect(container.textContent).toContain("Strong · 400%");
    expect(slider("Strong share").value).toBe("400");
    expect(slider("Minimum absorbed").value).toBe("200");
    expect(container.textContent).toContain("Minimum absorbed · 200× the book's typical level");
  });

  it("offers Show broken levels in place of the strong-only switch, on to begin with, and off hides the hollow spheres", () => {
    render();
    expect(container.textContent).not.toContain("strong absorption only");
    const box = container.querySelector<HTMLInputElement>('input[aria-label="Show broken levels"]')!;
    expect(box.checked).toBe(true);
    expect(container.textContent).toContain("untick to hide those and keep the walls that held");
    act(() => box.click());
    expect(latest.showBroken).toBe(false);
    expect(box.checked).toBe(false);
    act(() => box.click());
    expect(latest.showBroken).toBe(true);
    render({ ...DEFAULT_ABSORPTION_SETTINGS, strongOnly: true } as unknown as AbsorptionSettings);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Show broken levels"]')!.checked).toBe(true);
  });

  it("puts the three numbers back with Reset to default", () => {
    render({ ...DEFAULT_ABSORPTION_SETTINGS, absorbedPercent: 250, strongPercent: 600, absorbedMultiple: 65, showBroken: false });
    expect(slider("Absorbed share").value).toBe("250");
    const reset = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reset to default")!;
    act(() => reset.click());
    expect(latest).toEqual(DEFAULT_ABSORPTION_SETTINGS);
    expect(range(slider("Absorbed share"))).toEqual(["range", "50", "500", "10", "200"]);
    expect(slider("Minimum absorbed").value).toBe("40");
  });
});
