// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { GenericIndicatorSettingsModal } from "../GenericIndicatorSettingsModal";
import { smaIndicator, type SmaSettings } from "../../lib/indicators/sma/sma";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
} from "../../lib/indicators/session-profile/sessionProfileSettings";
import {
  sessionProfileIndicator,
} from "../../lib/indicators/session-profile/sessionProfileIndicator";
import {
  DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS,
  deltaDivergenceIndicator,
} from "../../lib/indicators/delta-divergence/deltaDivergenceIndicator";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function render(isOpen: boolean, settings: SmaSettings, onChange: (next: SmaSettings) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <GenericIndicatorSettingsModal
        isOpen={isOpen}
        onClose={onClose}
        title={smaIndicator.label}
        schema={smaIndicator.settingsSchema!}
        settings={settings}
        onChange={onChange}
      />,
    );
  });
  return { container, root, onClose };
}

describe("GenericIndicatorSettingsModal", () => {
  it("renders nothing when closed", async () => {
    const { container } = await render(false, smaIndicator.defaultSettings, vi.fn());
    expect(container.textContent).toBe("");
  });

  it("renders the indicator's real schema (length + color) when open, using its own label as the title", async () => {
    const { container } = await render(true, smaIndicator.defaultSettings, vi.fn());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("SMA");
    expect(container.querySelector('input[type="number"]')).not.toBeNull();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });

  it("changing the length field calls onChange with only length updated", async () => {
    const onChange = vi.fn();
    const { container } = await render(true, smaIndicator.defaultSettings, onChange);
    const numberInput = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(numberInput, "50");
      numberInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...smaIndicator.defaultSettings, length: 50 });
  });

  it("renders no reset button when defaultSettings is omitted", async () => {
    const { container } = await render(true, smaIndicator.defaultSettings, vi.fn());
    expect(container.querySelector(".indicator-settings-reset")).toBeNull();
  });

  it("TA.04: a 'Reset to default' button calls onChange with defaultSettings when provided -- the same affordance every prior bespoke settings modal (Volume Profile, Delta Profile, ...) already had", async () => {
    const onChange = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <GenericIndicatorSettingsModal
          isOpen
          onClose={vi.fn()}
          title={smaIndicator.label}
          schema={smaIndicator.settingsSchema!}
          settings={{ ...smaIndicator.defaultSettings, length: 99 }}
          defaultSettings={smaIndicator.defaultSettings}
          onChange={onChange}
        />,
      );
    });
    const resetButton = container.querySelector<HTMLButtonElement>(".indicator-settings-reset")!;
    expect(resetButton).not.toBeNull();
    await act(async () => {
      resetButton.click();
    });
    expect(onChange).toHaveBeenCalledWith(smaIndicator.defaultSettings);
  });

  it("preserves an opt-in indicator's established Show on chart control and restores it on reset", async () => {
    const onChange = vi.fn();
    const onVisibleChange = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <GenericIndicatorSettingsModal
          isOpen
          onClose={vi.fn()}
          title={sessionProfileIndicator.label}
          schema={sessionProfileIndicator.settingsSchema!}
          settings={DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS}
          defaultSettings={DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS}
          onChange={onChange}
          visible={false}
          onVisibleChange={onVisibleChange}
          defaultVisible={false}
        />,
      );
    });

    const visibilityTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".indicator-settings-tab"))
      .find((tab) => tab.textContent === "Visibility")!;
    await act(async () => {
      visibilityTab.click();
    });
    const showOnChart = Array.from(container.querySelectorAll<HTMLInputElement>(".indicator-settings-checkbox input"))
      .find((input) => input.nextElementSibling?.textContent === "Show on chart")!;
    expect(showOnChart.checked).toBe(false);
    await act(async () => {
      showOnChart.click();
    });
    // Toggled to true, deliberately the *opposite* of defaultVisible (false)
    // below -- reset must observably restore it, not just leave whatever
    // the checkbox click already produced.
    expect(onVisibleChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".indicator-settings-reset")!.click();
    });
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS);
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);
    root.unmount();
    container.remove();
  });

  it("TA.04: shows the visibility control inline (no tabs) for a schema with no tab on any field, e.g. Delta Divergence's -- proves the checkbox isn't trapped inside tabbed layouts only", async () => {
    const onChange = vi.fn();
    const onVisibleChange = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        <GenericIndicatorSettingsModal
          isOpen
          onClose={vi.fn()}
          title={deltaDivergenceIndicator.label}
          schema={deltaDivergenceIndicator.settingsSchema!}
          settings={DEFAULT_DELTA_DIVERGENCE_INDICATOR_SETTINGS}
          onChange={onChange}
          visible={true}
          onVisibleChange={onVisibleChange}
          defaultVisible={true}
        />,
      );
    });

    expect(container.querySelector('[role="tablist"]')).toBeNull();
    const showOnChart = Array.from(container.querySelectorAll<HTMLInputElement>(".indicator-settings-checkbox input"))
      .find((input) => input.nextElementSibling?.textContent === "Show on chart")!;
    expect(showOnChart).toBeDefined();
    expect(showOnChart.checked).toBe(true);
    await act(async () => {
      showOnChart.click();
    });
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);
    root.unmount();
    container.remove();
  });

  it("closing via the close button invokes onClose", async () => {
    const { container, onClose } = await render(true, smaIndicator.defaultSettings, vi.fn());
    const closeButton = container.querySelector<HTMLButtonElement>(".indicator-settings-close")!;
    await act(async () => {
      closeButton.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
