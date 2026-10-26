// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LiquidityHeatmapSettingsModal, SLIDER_COMMIT_MS } from "../LiquidityHeatmapSettingsModal";
import { aaplLiquidityStyle } from "../aaplLiquidityStyle";
import { btcLiquidityStyle } from "../btcLiquidityStyle";
import { nqLiquidityStyle } from "../nqLiquidityStyle";
import type { LiquiditySettings } from "../liquiditySettings";
import type { LiquidityMarket } from "../liquidityStyle";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NQ = nqLiquidityStyle.defaultSettings;
const BTC = btcLiquidityStyle.defaultSettings;
let latest: LiquiditySettings = NQ;
let changes = 0;
let lanes: string[] = [];

function Harness({ initial = NQ, defaults = NQ, market = "index", unit = "contracts", typicalSize, intervalMs }: { initial?: LiquiditySettings; defaults?: LiquiditySettings; market?: LiquidityMarket; unit?: string; typicalSize?: number; intervalMs?: number }) {
  const [settings, setSettings] = useState(initial);
  return (
    <LiquidityHeatmapSettingsModal
      isOpen
      onClose={() => {}}
      market={market}
      unit={unit}
      typicalSize={typicalSize}
      intervalMs={intervalMs}
      settings={settings}
      defaults={defaults}
      onSettingsChange={(next) => {
        latest = next;
        changes += 1;
        setSettings(next);
      }}
      visible
      onVisibleChange={() => {}}
      onLaneChange={(lane) => lanes.push(lane)}
    />
  );
}

function slider(name: string): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${name}"]`);
  if (found === null) throw new Error(`no ${name} slider`);
  return found;
}

function labelOf(name: string): string {
  return slider(name).closest("label")?.querySelector("span")?.textContent ?? "";
}

function hintOf(name: string): string {
  return slider(name).closest("label")?.querySelector(".indicator-settings-hint")?.textContent ?? "";
}

/** Drag the thumb to a position without letting it go. */
function drag(name: string, value: number): void {
  const input = slider(name);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Drag the thumb to a position and let it go. */
function slide(name: string, value: number): void {
  drag(name, value);
  act(() => {
    slider(name).dispatchEvent(new Event("pointerup", { bubbles: true }));
  });
}

describe("the heatmap dialog's sliders", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    latest = NQ;
    changes = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("offers level width, quiet zone and sensitivity as sliders, and no number box", () => {
    act(() => root.render(<Harness />));
    expect(slider("Level width")).toBeDefined();
    expect(slider("Quiet zone around price")).toBeDefined();
    expect(slider("Sensitivity")).toBeDefined();
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
  });

  it("moves the level width in whole ticks from 1 to 50, and names them", () => {
    act(() => root.render(<Harness />));
    expect([slider("Level width").min, slider("Level width").max, slider("Level width").step]).toEqual(["1", "50", "1"]);
    expect(labelOf("Level width")).toBe("Level width 12 ticks");
    slide("Level width", 8);
    expect(latest.clusterRows).toBe(8);
    expect(labelOf("Level width")).toBe("Level width 8 ticks");
    slide("Level width", 1);
    expect(labelOf("Level width")).toBe("Level width 1 tick");
  });

  it("calls a crypto level's width rows", () => {
    act(() => root.render(<Harness market="crypto" unit="BTC" initial={BTC} defaults={BTC} />));
    expect(labelOf("Level width")).toBe("Level width 3 rows");
  });

  it("runs the quiet zone from off to 100 bands, or twice the market's own when that is more, whatever is saved", () => {
    act(() => root.render(<Harness initial={{ ...NQ, quietBands: 80 }} />));
    expect([slider("Quiet zone around price").min, slider("Quiet zone around price").max]).toEqual(["0", "100"]);
    expect(labelOf("Quiet zone around price")).toBe("Quiet zone around price 80 bands");
    slide("Quiet zone around price", 90);
    expect(slider("Quiet zone around price").max).toBe("100");
    slide("Quiet zone around price", 10);
    expect(latest.quietBands).toBe(10);
    expect(labelOf("Quiet zone around price")).toBe("Quiet zone around price 10 bands");
    slide("Quiet zone around price", 0);
    expect(latest.quietBands).toBe(0);
    expect(labelOf("Quiet zone around price")).toBe("Quiet zone around price off");
    act(() => root.render(<Harness key="btc" market="crypto" unit="BTC" initial={BTC} defaults={BTC} />));
    expect(slider("Quiet zone around price").max).toBe("200");
  });

  it("hides less as sensitivity moves right, from fifty times the market's minimum down to a quarter of it, then no minimum", () => {
    act(() => root.render(<Harness />));
    expect(labelOf("Sensitivity")).toBe("Sensitivity · hides levels under 20 contracts");
    const at = Number(slider("Sensitivity").value);
    const last = Number(slider("Sensitivity").max);
    slide("Sensitivity", 0);
    expect(latest.minBandSize).toBe(1_000);
    slide("Sensitivity", at + 2);
    expect(latest.minBandSize).toBeLessThan(20);
    slide("Sensitivity", at - 2);
    expect(latest.minBandSize).toBeGreaterThan(20);
    slide("Sensitivity", last - 1);
    expect(latest.minBandSize).toBe(5);
    slide("Sensitivity", last);
    expect(latest.minBandSize).toBe(0);
    expect(labelOf("Sensitivity")).toBe("Sensitivity · no minimum");
    expect(hintOf("Sensitivity")).toContain("own floor and the quiet zone still apply");
  });

  it("steps one contract at a time through the two-digit sizes on an index, whole sizes of two significant digits elsewhere, and reaches no minimum", () => {
    act(() => root.render(<Harness />));
    const seen: number[] = [];
    for (let position = 0; position <= Number(slider("Sensitivity").max); position += 1) {
      slide("Sensitivity", position);
      seen.push(latest.minBandSize);
      expect(Number.isInteger(latest.minBandSize)).toBe(true);
      expect(Number(latest.minBandSize.toPrecision(2))).toBe(latest.minBandSize);
    }
    for (let size = 10; size <= 99; size += 1) expect(seen).toContain(size);
    expect(seen.indexOf(30) - seen.indexOf(31)).toBe(1);
    expect(seen).toContain(20);
    expect(seen[seen.length - 1]).toBe(0);
  });

  it("keeps the round sizes on crypto's sensitivity", () => {
    act(() => root.render(<Harness key="btc" market="crypto" unit="BTC" initial={BTC} defaults={BTC} />));
    const seen = new Set<number>();
    for (let position = 0; position <= Number(slider("Sensitivity").max); position += 1) {
      slide("Sensitivity", position);
      seen.add(latest.minBandSize);
    }
    expect(seen.has(25)).toBe(true);
    expect(seen.has(31)).toBe(false);
  });

  it("keeps a saved size the slider cannot reach, and names it, until the slider is moved", () => {
    act(() => root.render(<Harness initial={{ ...NQ, minBandSize: 5_000 }} />));
    expect(labelOf("Sensitivity")).toBe("Sensitivity · hides levels under 5,000 contracts");
    expect(slider("Sensitivity").value).toBe("0");
    expect(changes).toBe(0);
  });

  it("offers the size that saturates as a slider of round sizes when the colour scale is fixed, per row on crypto", () => {
    act(() => root.render(<Harness initial={{ ...NQ, scaleMode: "fixed", scaleSize: 40 }} />));
    expect(labelOf("Size that saturates")).toBe("Size that saturates 40 contracts");
    const at = Number(slider("Size that saturates").value);
    slide("Size that saturates", at + 1);
    expect(latest.scaleSize).toBe(50);
    slide("Size that saturates", at - 1);
    expect(latest.scaleSize).toBe(30);
    expect(labelOf("Size that saturates")).toBe("Size that saturates 30 contracts");
    act(() => root.render(<Harness key="auto" />));
    expect(document.querySelector('input[type="range"][aria-label="Size that saturates"]')).toBeNull();
    act(() => root.render(<Harness key="btc" market="crypto" unit="BTC" initial={{ ...BTC, scaleMode: "fixed", scaleSize: 10 }} defaults={BTC} />));
    expect(labelOf("Size that saturates")).toBe("Size that saturates 10 BTC per row");
    expect(hintOf("Sensitivity")).toContain("On the 1m chart");
    const AAPL = aaplLiquidityStyle.defaultSettings;
    act(() => root.render(<Harness key="aapl" unit="shares" initial={{ ...AAPL, scaleMode: "fixed", scaleSize: 400 }} defaults={AAPL} />));
    slide("Size that saturates", 0);
    expect(latest.scaleSize).toBe(AAPL.scaleSize);
  });

  it("follows the thumb at once but hands the setting over only once the thumb has rested, or is let go", () => {
    vi.useFakeTimers();
    act(() => root.render(<Harness />));
    drag("Level width", 30);
    expect(labelOf("Level width")).toBe("Level width 30 ticks");
    drag("Level width", 31);
    act(() => vi.advanceTimersByTime(SLIDER_COMMIT_MS - 1));
    expect(changes).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(changes).toBe(1);
    expect(latest.clusterRows).toBe(31);
    drag("Level width", 9);
    act(() => {
      slider("Level width").dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(changes).toBe(2);
    expect(latest.clusterRows).toBe(9);
    act(() => vi.advanceTimersByTime(SLIDER_COMMIT_MS));
    expect(changes).toBe(2);
  });

  it("builds a market without a minimum of its own around the book's typical row when the dialog opens, keeps it while open, and around a thousand shares before the book has said", () => {
    const plain = { ...NQ, minBandSize: 0 };
    act(() => root.render(<Harness unit="shares" initial={plain} defaults={plain} typicalSize={480} />));
    slide("Sensitivity", 0);
    expect(latest.minBandSize).toBe(25_000);
    act(() => root.render(<Harness unit="shares" initial={plain} defaults={plain} typicalSize={4_800} />));
    slide("Sensitivity", 1);
    slide("Sensitivity", 0);
    expect(latest.minBandSize).toBe(25_000);
    act(() => root.render(<Harness key="unknown" unit="shares" initial={plain} defaults={plain} typicalSize={0} />));
    slide("Sensitivity", 0);
    expect(latest.minBandSize).toBe(50_000);
  });

  it("sets how much the higher timeframes widen the levels, around auto, and shows what that gives on the chart on screen", () => {
    act(() => root.render(<Harness intervalMs={60 * 60_000} />));
    expect([slider("Higher timeframes").min, slider("Higher timeframes").max, slider("Higher timeframes").value]).toEqual(["-7", "3", "0"]);
    expect(labelOf("Higher timeframes")).toBe("Higher timeframes auto · x8 on this 1h chart: 96 ticks");
    expect(hintOf("Higher timeframes")).toContain("x3 on 15m, x8 on 1h, x30 on 4h, x80 on 1D");
    slide("Higher timeframes", -2);
    expect(latest.timeframeWidening).toBe(0.25);
    expect(latest.clusterRows).toBe(NQ.clusterRows);
    expect(labelOf("Higher timeframes")).toBe("Higher timeframes -2 · x2 on this 1h chart: 24 ticks");
    expect(hintOf("Higher timeframes")).toContain("x1 on 15m, x2 on 1h, x7.5 on 4h, x20 on 1D");
    slide("Higher timeframes", 1);
    expect(latest.timeframeWidening).toBe(2);
    expect(labelOf("Higher timeframes")).toBe("Higher timeframes +1 · x16 on this 1h chart: 192 ticks");
  });

  it("names only the setting on a chart under 15m, which keeps its own width", () => {
    act(() => root.render(<Harness intervalMs={60_000} />));
    expect(labelOf("Higher timeframes")).toBe("Higher timeframes auto");
    expect(hintOf("Level width")).toContain("higher timeframes widen it as set below");
  });

  it("puts every slider back with Reset to default", () => {
    act(() => root.render(<Harness />));
    const home = slider("Sensitivity").value;
    slide("Level width", 30);
    slide("Quiet zone around price", 3);
    slide("Sensitivity", 0);
    slide("Higher timeframes", -3);
    const reset = [...document.querySelectorAll("button")].find((button) => button.textContent === "Reset to default");
    act(() => reset?.click());
    expect([latest.clusterRows, latest.quietBands, latest.minBandSize, latest.timeframeWidening]).toEqual([NQ.clusterRows, NQ.quietBands, NQ.minBandSize, 1]);
    expect(slider("Higher timeframes").value).toBe("0");
    expect([slider("Level width").value, slider("Quiet zone around price").value, slider("Sensitivity").value]).toEqual(["12", "16", home]);
    expect(labelOf("Level width")).toBe("Level width 12 ticks");
    expect(labelOf("Sensitivity")).toBe("Sensitivity · hides levels under 20 contracts");
  });

  it("starts the price zoom on the finest rows and puts it back there with Reset to default", () => {
    lanes = [];
    act(() => root.render(<Harness />));
    const choices = [...document.querySelectorAll<HTMLInputElement>('input[name="liquidity-lane"]')];
    expect(choices.map((input) => input.parentElement?.textContent?.trim())).toEqual(["Auto", "Finest rows", "Rows x2", "Rows x4"]);
    expect(choices.map((input) => input.checked)).toEqual([false, true, false, false]);
    const reset = [...document.querySelectorAll("button")].find((button) => button.textContent === "Reset to default");
    act(() => reset?.click());
    expect(lanes).toEqual(["0"]);
  });
});
