// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FrameIdentity } from "../../../../types/frames";
import { IcebergSettingsModal } from "../IcebergSettingsModal";
import { DEFAULT_ICEBERG_SETTINGS, type IcebergSettings } from "../icebergSettings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Identity = { symbol: string } & FrameIdentity;

const btcPerp: Identity = { provider: "BINANCE", symbol: "BTC-USDT", marketKind: "PERPETUAL" };
const nq: Identity = { provider: "DXFEED", symbol: "/NQZ26:XCME", assetClass: "FUTURE" };

let latest: IcebergSettings = DEFAULT_ICEBERG_SETTINGS;
let shown = true;

function Harness({ identity, start }: { identity: Identity; start: IcebergSettings }) {
  const [settings, setSettings] = useState(start);
  latest = settings;
  return (
    <IcebergSettingsModal
      isOpen={true}
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      defaults={DEFAULT_ICEBERG_SETTINGS}
      visible={shown}
      onVisibleChange={(next) => {
        shown = next;
      }}
      identity={identity}
    />
  );
}

describe("the Iceberg Detector dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = DEFAULT_ICEBERG_SETTINGS;
    shown = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(identity: Identity, start: IcebergSettings = DEFAULT_ICEBERG_SETTINGS) {
    act(() => {
      root.render(<Harness identity={identity} start={start} />);
    });
  }

  const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.trim() === name)!;
  const sliders = () => [...container.querySelectorAll<HTMLInputElement>('input[type="range"]')];
  const hintUnder = (title: string) => [...container.querySelectorAll<HTMLElement>(".indicator-settings-field")].find((field) => field.querySelector("span")?.textContent?.startsWith(title))!.querySelector(".indicator-settings-hint")!.textContent!;
  const setValue = (input: HTMLInputElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("opens on Inputs with history, the size slider, the refills slider and the pulled switch at the standard values, and no weak switch on either venue", () => {
    render(btcPerp);
    expect(container.querySelector('[aria-label="Iceberg Detector settings"]')).not.toBeNull();
    expect(tab("Inputs").getAttribute("aria-selected")).toBe("true");
    expect([...container.querySelectorAll<HTMLInputElement>('input[name="iceberg-history-days"]')].map((input) => input.checked)).toEqual([true, false, false, false]);
    expect(container.textContent).toContain("Size: biggest 20%");
    expect(container.textContent).toContain("Refills: at least ×2");
    expect(container.textContent).toContain("Show pulled icebergs");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    expect(container.textContent).not.toContain("Show weak marks");
    expect(container.textContent).not.toContain("Labels");
    expect(container.textContent).not.toContain("BUY");
    expect(container.textContent).not.toContain("SELL");
    render(nq);
    expect(container.textContent).not.toContain("Show weak marks");
    expect(container.textContent).toContain("Refills: at least ×2");
  });

  it("the size slider is a whole percentage that is saved as sizeTopPercent and read back clamped", () => {
    render(btcPerp, { ...DEFAULT_ICEBERG_SETTINGS, sizeTopPercent: 250 });
    expect(container.textContent).toContain("Size: biggest 100%");
    const [size] = sliders();
    expect([size.min, size.max, size.step]).toEqual(["1", "100", "1"]);
    setValue(size, "25");
    expect(latest.sizeTopPercent).toBe(25);
    expect(container.textContent).toContain("Size: biggest 25%");
    expect(latest.markScale).toBe(1);
  });

  it("the size hint says each rule once: below the hour a history span only adds, from 1h up a span can replace a smaller live mark in its candle", () => {
    render(btcPerp);
    const sentences = hintUnder("Size:").split(/(?<=\.) /);
    expect(new Set(sentences).size).toBe(sentences.length);
    expect(sentences).toContain("The live window and the older history are ranked apart, so below the hour a history span only adds.");
    expect(sentences).toContain("From 1h up a candle keeps only its biggest mark, so a span can replace a smaller live one in the same candle.");
  });

  it("the history hint names the heatmap's live window and no fixed hours, since the runtime sets that reach", () => {
    render(btcPerp);
    const history = hintUnder("History");
    expect(history).toContain("Off is live like absorption: what this runtime saw inside the heatmap's live window.");
    expect(history).not.toMatch(/hour/);
  });

  it("the refills hint says the slider compares the ×N printed on the card", () => {
    render(nq);
    const refills = hintUnder("Refills:");
    expect(refills).toContain("Compares the ×N printed on the card, the 80 in 160 (2 × 80)");
    expect(refills).not.toContain("how many times the order showed itself");
  });

  it("the Visibility tab offers dot, triangle or circle, starting from the instrument's own: a dot on CME, a circle on Binance", () => {
    const shapes = () => [...container.querySelectorAll<HTMLInputElement>('input[name="iceberg-mark-shape"]')];
    render(nq);
    act(() => tab("Visibility").click());
    expect(shapes().map((input) => input.parentElement?.textContent?.trim())).toEqual(["Dot", "Triangle", "Circle"]);
    expect(shapes().map((input) => input.checked)).toEqual([true, false, false]);
    act(() => shapes()[1].click());
    expect(latest.markShape).toBe("triangle");
    expect(shapes().map((input) => input.checked)).toEqual([false, true, false]);
    render(btcPerp);
    act(() => root.unmount());
    root = createRoot(container);
    render(btcPerp);
    act(() => tab("Visibility").click());
    expect(shapes().map((input) => input.checked)).toEqual([false, false, true]);
    act(() => tab("Inputs").click());
    expect(shapes()).toHaveLength(0);
  });

  it("the Visibility tab offers the mark's placement, where it appeared by default or the candle's high and low, and says the card goes above a sell and below a buy", () => {
    const placements = () => [...container.querySelectorAll<HTMLInputElement>('input[name="iceberg-placement"]')];
    render(btcPerp);
    act(() => tab("Visibility").click());
    expect(placements().map((input) => input.parentElement?.textContent?.trim())).toEqual(["Where it appeared", "Candle high / low"]);
    expect(placements().map((input) => input.checked)).toEqual([true, false]);
    expect(hintUnder("Mark placement")).toContain("the candle's high for a sell and its low for a buy");
    expect(container.textContent).toContain("above a sell iceberg and below a buy");
    act(() => placements()[1].click());
    expect(latest.placement).toBe("candle");
    expect(placements().map((input) => input.checked)).toEqual([false, true]);
    act(() => placements()[0].click());
    expect(latest.placement).toBe("price");
    act(() => tab("Inputs").click());
    expect(placements()).toHaveLength(0);
  });

  it("the Visibility tab holds the labels switch, the two colours, the mark size and the on-chart switch", () => {
    render(btcPerp);
    act(() => tab("Visibility").click());
    expect(tab("Visibility").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Labels");
    expect(container.textContent).toContain("Show on chart");
    expect(container.querySelectorAll('input[type="color"]')).toHaveLength(2);
    expect(container.textContent).not.toContain("Size: biggest");
    const labels = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(labels).toHaveLength(2);
    act(() => labels[0].click());
    expect(latest.labels).toBe(false);
    const [scale] = sliders();
    setValue(scale, "2");
    expect(latest.markScale).toBe(2);
    act(() => labels[1].click());
    expect(shown).toBe(false);
  });
});
