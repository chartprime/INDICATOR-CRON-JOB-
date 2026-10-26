// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { IndicatorLegendRow } from "../IndicatorLegendRow";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, root };
}

describe("IndicatorLegendRow", () => {
  it("renders the label and detail, with all three action icons when onOpenSettings is provided", async () => {
    const { container } = await render(
      <IndicatorLegendRow
        label="Large Trade Detector"
        detail="≥ $50.0k"
        visible={true}
        onToggleVisible={vi.fn()}
        onOpenSettings={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(container.querySelector(".indicator-legend-label")?.textContent).toBe("Large Trade Detector");
    expect(container.querySelector(".indicator-legend-detail")?.textContent).toBe("≥ $50.0k");
    expect(container.querySelectorAll(".indicator-legend-icon")).toHaveLength(3);
  });

  it("omits the detail span entirely when no detail is given -- most indicators have nothing to show there", async () => {
    const { container } = await render(
      <IndicatorLegendRow label="RSI (14)" visible={true} onToggleVisible={vi.fn()} onRemove={vi.fn()} />,
    );

    expect(container.querySelector(".indicator-legend-detail")).toBeNull();
  });

  it("omits the gear icon when onOpenSettings is not provided -- nothing to configure", async () => {
    const { container } = await render(
      <IndicatorLegendRow label="RSI (14)" visible={true} onToggleVisible={vi.fn()} onRemove={vi.fn()} />,
    );

    expect(container.querySelector('[aria-label="Indicator settings"]')).toBeNull();
    expect(container.querySelectorAll(".indicator-legend-icon")).toHaveLength(2);
  });

  it("applies the hidden modifier class and dims when not visible", async () => {
    const { container } = await render(
      <IndicatorLegendRow label="RSI (14)" visible={false} onToggleVisible={vi.fn()} onRemove={vi.fn()} />,
    );

    expect(container.querySelector(".indicator-legend-row-hidden")).not.toBeNull();
    expect(container.querySelector('[aria-label="Show indicator"]')).not.toBeNull();
  });

  it("fires onToggleVisible, onOpenSettings, and onRemove from their respective icons", async () => {
    const onToggleVisible = vi.fn();
    const onOpenSettings = vi.fn();
    const onRemove = vi.fn();
    const { container } = await render(
      <IndicatorLegendRow
        label="ICT Killzones"
        visible={true}
        onToggleVisible={onToggleVisible}
        onOpenSettings={onOpenSettings}
        onRemove={onRemove}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Hide indicator"]')!.click();
    });
    expect(onToggleVisible).toHaveBeenCalledTimes(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Indicator settings"]')!.click();
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Remove indicator"]')!.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
