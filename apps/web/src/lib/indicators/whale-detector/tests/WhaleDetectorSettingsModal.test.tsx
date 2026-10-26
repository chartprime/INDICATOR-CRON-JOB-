// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { WhaleDetectorSettingsModal } from "../WhaleDetectorSettingsModal";
import { LOG_SLIDER_STEPS, logSliderToValue } from "../../../chart/logSlider";
import {
  DEFAULT_TOP_FRACTION,
  DEFAULT_WHALE_THRESHOLD_USD,
  MAX_TOP_FRACTION,
  MAX_WHALE_THRESHOLD_USD,
  MIN_TOP_FRACTION,
  MIN_WHALE_THRESHOLD_USD,
} from "../whaleTrades";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof WhaleDetectorSettingsModal>[0];

function baseProps(): Omit<Props, "isOpen"> {
  return {
    onClose: () => {},
    mode: "topPercent",
    onModeChange: () => {},
    topFraction: DEFAULT_TOP_FRACTION,
    onTopFractionChange: () => {},
    threshold: DEFAULT_WHALE_THRESHOLD_USD,
    thresholdUnit: "USD",
    onThresholdChange: () => {},
    resolvedThreshold: null,
    truncated: false,
    clusterMode: "delta",
    onClusterModeChange: () => {},
    minDeltaPercent: 0,
    onMinDeltaPercentChange: () => {},
    visible: true,
    onVisibleChange: () => {},
  };
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

async function render(root: Root, overrides: Partial<Props> = {}) {
  await act(async () => {
    root.render(<WhaleDetectorSettingsModal {...baseProps()} isOpen {...overrides} />);
  });
}

function sliders(container: HTMLDivElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'));
}

function setRange(input: HTMLInputElement, value: number): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  nativeSetter.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function hintText(container: HTMLDivElement): string {
  return container.querySelector(".indicator-settings-hint")?.textContent ?? "";
}

describe("WhaleDetectorSettingsModal", () => {
  it("offers exactly two detection methods -- Top % and Size", async () => {
    const { container, root } = mount();
    await render(root);

    const labels = Array.from(container.querySelectorAll('input[name="whale-detection-mode"]'))
      .map((radio) => radio.nextElementSibling?.textContent);
    expect(labels).toEqual(["Top %", "Size"]);
    await act(async () => root.unmount());
    container.remove();
  });

  it("offers Delta and Buy / Sell bubbles -- the old net/gross naming is gone", async () => {
    const { container, root } = mount();
    await render(root);

    const labels = Array.from(container.querySelectorAll('input[name="whale-cluster-mode"]'))
      .map((radio) => radio.nextElementSibling?.textContent);
    expect(labels).toEqual(["Delta", "Buy / Sell"]);
    await act(async () => root.unmount());
    container.remove();
  });

  describe("top-percent slider", () => {
    it("drags right for FEWER, bigger trades -- the track is inverted so selectivity increases rightward", async () => {
      const onTopFractionChange = vi.fn();
      const { container, root } = mount();
      await render(root, { onTopFractionChange });

      setRange(sliders(container)[0], LOG_SLIDER_STEPS);
      expect(onTopFractionChange).toHaveBeenLastCalledWith(expect.closeTo(MIN_TOP_FRACTION, 10));

      setRange(sliders(container)[0], 0);
      expect(onTopFractionChange).toHaveBeenLastCalledWith(expect.closeTo(MAX_TOP_FRACTION, 10));

      await act(async () => root.unmount());
      container.remove();
    });

    it("puts the default at the centre of its own track", async () => {
      const { container, root } = mount();
      await render(root);

      expect(Number(sliders(container)[0].value)).toBe(LOG_SLIDER_STEPS / 2);
      await act(async () => root.unmount());
      container.remove();
    });

    it("reaches a far stricter setting than the old floor -- 0.00125% versus 0.02%", async () => {
      expect(MIN_TOP_FRACTION).toBeLessThan(0.0002);
      const { container, root } = mount();
      await render(root, { topFraction: MIN_TOP_FRACTION });
      expect(hintText(container)).toContain("0.001%");
      await act(async () => root.unmount());
      container.remove();
    });

    it("names the size its percentage currently resolves to, so the abstract dial is concrete", async () => {
      const { container, root } = mount();
      await render(root, { resolvedThreshold: 65_704 });

      expect(hintText(container)).toContain("$65,704 and above");
      await act(async () => root.unmount());
      container.remove();
    });

    it("says so when retention cannot fill the requested depth, rather than silently under-delivering", async () => {
      const { container, root } = mount();
      await render(root, { truncated: true, resolvedThreshold: 1_000 });

      expect(hintText(container)).toContain("showing everything available");
      await act(async () => root.unmount());
      container.remove();
    });

    it("shows no size control at all while in top-percent mode -- one dial governs, never two", async () => {
      const { container, root } = mount();
      await render(root, { clusterMode: "buySell" }); // suppress the unrelated Min delta input
      expect(sliders(container)).toHaveLength(1);
      expect(container.querySelector('input[type="number"]')).toBeNull();
      await act(async () => root.unmount());
      container.remove();
    });
  });

  describe("size mode", () => {
    it("commits the typed number and never a value outside its own bounds", async () => {
      const onThresholdChange = vi.fn();
      const { container, root } = mount();
      await render(root, { mode: "size", onThresholdChange });

      const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;

      nativeSetter.call(input, "250000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onThresholdChange).toHaveBeenLastCalledWith(250_000);

      onThresholdChange.mockClear();
      nativeSetter.call(input, "1"); // below MIN_WHALE_THRESHOLD_USD
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onThresholdChange).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      container.remove();
    });

    it("its slider spans the declared range, so the dial can never ask for less than the server keeps", async () => {
      const onThresholdChange = vi.fn();
      const { container, root } = mount();
      await render(root, { mode: "size", onThresholdChange });

      setRange(sliders(container)[0], 0);
      expect(onThresholdChange).toHaveBeenLastCalledWith(MIN_WHALE_THRESHOLD_USD);

      setRange(sliders(container)[0], LOG_SLIDER_STEPS);
      expect(onThresholdChange).toHaveBeenLastCalledWith(MAX_WHALE_THRESHOLD_USD);

      await act(async () => root.unmount());
      container.remove();
    });

    it("is log-scaled, so its midpoint is the geometric mean rather than the arithmetic one", async () => {
      const onThresholdChange = vi.fn();
      const { container, root } = mount();
      await render(root, { mode: "size", onThresholdChange });

      setRange(sliders(container)[0], LOG_SLIDER_STEPS / 2);
      const geometric = logSliderToValue(LOG_SLIDER_STEPS / 2, MIN_WHALE_THRESHOLD_USD, MAX_WHALE_THRESHOLD_USD);
      const committed = onThresholdChange.mock.calls.at(-1)![0] as number;
      expect(committed).toBeGreaterThan(geometric * 0.99);
      expect(committed).toBeLessThan(geometric * 1.01);
      // An arithmetic midpoint would be ~$25M, which is nowhere near this.
      expect(committed).toBeLessThan(5_000_000);

      await act(async () => root.unmount());
      container.remove();
    });

    it("labels contracts as contracts for futures, never a fabricated dollar figure", async () => {
      const { container, root } = mount();
      await render(root, { mode: "size", thresholdUnit: "CONTRACTS", threshold: 20 });

      const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
      expect(input.previousElementSibling?.textContent).toBe("Minimum size (contracts)");
      await act(async () => root.unmount());
      container.remove();
    });

    it("commits a whole number of contracts, never a fraction of one", async () => {
      const onThresholdChange = vi.fn();
      const { container, root } = mount();
      await render(root, { mode: "size", thresholdUnit: "CONTRACTS", threshold: 20, onThresholdChange });

      setRange(sliders(container)[0], 613);
      const committed = onThresholdChange.mock.calls.at(-1)![0] as number;
      expect(Number.isInteger(committed)).toBe(true);
      expect(committed).toBeGreaterThanOrEqual(1);

      await act(async () => root.unmount());
      container.remove();
    });
  });

  describe("min delta", () => {
    it("is offered only in Delta mode, where cancelling flow can hide activity", async () => {
      const { container, root } = mount();
      await render(root, { clusterMode: "buySell" });
      const labels = Array.from(container.querySelectorAll(".indicator-settings-field > span"))
        .map((node) => node.textContent);
      expect(labels).not.toContain("Min delta (%)");

      await render(root, { clusterMode: "delta" });
      const deltaLabels = Array.from(container.querySelectorAll(".indicator-settings-field > span"))
        .map((node) => node.textContent);
      expect(deltaLabels).toContain("Min delta (%)");

      await act(async () => root.unmount());
      container.remove();
    });

    it("refuses a percentage outside 0-100 rather than committing a meaningless share", async () => {
      const onMinDeltaPercentChange = vi.fn();
      const { container, root } = mount();
      await render(root, { onMinDeltaPercentChange });

      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="number"]'));
      const deltaInput = inputs.at(-1)!;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;

      nativeSetter.call(deltaInput, "40");
      deltaInput.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onMinDeltaPercentChange).toHaveBeenLastCalledWith(40);

      onMinDeltaPercentChange.mockClear();
      nativeSetter.call(deltaInput, "150");
      deltaInput.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onMinDeltaPercentChange).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      container.remove();
    });
  });

  it("reset restores every control, including the mode itself", async () => {
    const onModeChange = vi.fn();
    const onTopFractionChange = vi.fn();
    const onThresholdChange = vi.fn();
    const onClusterModeChange = vi.fn();
    const onMinDeltaPercentChange = vi.fn();
    const { container, root } = mount();
    await render(root, {
      mode: "size",
      onModeChange,
      onTopFractionChange,
      onThresholdChange,
      onClusterModeChange,
      onMinDeltaPercentChange,
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".indicator-settings-reset")!.click();
    });

    expect(onModeChange).toHaveBeenCalledWith("topPercent");
    expect(onTopFractionChange).toHaveBeenCalledWith(DEFAULT_TOP_FRACTION);
    expect(onThresholdChange).toHaveBeenCalledWith(DEFAULT_WHALE_THRESHOLD_USD);
    expect(onClusterModeChange).toHaveBeenCalledWith("delta");
    expect(onMinDeltaPercentChange).toHaveBeenCalledWith(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("reopening after switching to Visibility resets to Inputs -- no orphaned focus on a stale tab", async () => {
    const { container, root } = mount();
    await render(root);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!.click();
    });
    expect(container.querySelector(".indicator-settings-checkbox")).not.toBeNull();

    await render(root, { isOpen: false });
    await render(root, { isOpen: true });

    expect(container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')!.textContent).toBe("Inputs");
    await act(async () => root.unmount());
    container.remove();
  });
});
