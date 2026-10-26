// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LiquidityHeatmapSettingsModal } from "../LiquidityHeatmapSettingsModal";
import { DEFAULT_LIQUIDITY_SETTINGS, type LiquiditySettings } from "../liquiditySettings";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let latest: LiquiditySettings = DEFAULT_LIQUIDITY_SETTINGS;

function Harness({ initial = DEFAULT_LIQUIDITY_SETTINGS }: { initial?: LiquiditySettings }) {
  const [settings, setSettings] = useState(initial);
  return (
    <LiquidityHeatmapSettingsModal
      isOpen
      onClose={() => {}}
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      visible
      onVisibleChange={() => {}}
    />
  );
}

describe("the heatmap dialog's History row", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    latest = DEFAULT_LIQUIDITY_SETTINGS;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[name="liquidity-history-days"]')];

  it("offers 1 day, 3 days, 5 days and 1 week, starts at 1 day, and saves the choice", () => {
    act(() => root.render(<Harness />));
    const labels = radios().map((input) => input.parentElement?.textContent?.trim());
    expect(labels).toEqual(["1 day", "3 days", "5 days", "1 week"]);
    expect(radios().map((input) => input.checked)).toEqual([true, false, false, false]);
    act(() => radios()[2].click());
    expect(latest.historyDays).toBe(5);
    expect(radios().map((input) => input.checked)).toEqual([false, false, true, false]);
  });

  it("shows a saved reach the dialog does not offer as 1 day", () => {
    act(() => root.render(<Harness initial={{ ...DEFAULT_LIQUIDITY_SETTINGS, historyDays: 2 }} />));
    expect(radios().map((input) => input.checked)).toEqual([true, false, false, false]);
  });
});
