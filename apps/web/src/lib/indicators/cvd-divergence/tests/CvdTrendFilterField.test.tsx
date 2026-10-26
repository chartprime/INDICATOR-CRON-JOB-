// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { CvdTrendFilterField } from "../CvdTrendFilterField";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function render(props: {
  enabled?: boolean;
  smaLength?: number;
  inverted?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onEnabledChange = vi.fn();
  const onSmaLengthChange = vi.fn();
  const onInvertedChange = vi.fn();
  await act(async () => {
    root.render(
      <CvdTrendFilterField
        label="Filter cumulative"
        enabled={props.enabled ?? true}
        smaLength={props.smaLength ?? 50}
        inverted={props.inverted ?? false}
        onEnabledChange={onEnabledChange}
        onSmaLengthChange={onSmaLengthChange}
        onInvertedChange={onInvertedChange}
      />,
    );
  });
  return {
    container,
    root,
    onEnabledChange,
    onSmaLengthChange,
    onInvertedChange,
  };
}

function checkbox(container: HTMLDivElement, ariaLabel: string) {
  return container.querySelector<HTMLInputElement>(
    `input[aria-label="${ariaLabel}"]`,
  )!;
}

function setRangeValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  return act(async () => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CvdTrendFilterField", () => {
  it("renders the filter toggle, the length and the Inverse switch on one row", async () => {
    const { container } = await render({});
    const row = container.querySelector(".indicator-settings-inline-row")!;
    // One row, not three: the three controls are one decision.
    expect(
      container.querySelectorAll(".indicator-settings-inline-row"),
    ).toHaveLength(1);
    expect(row.querySelectorAll("input")).toHaveLength(3);
    expect(row.textContent).toContain("Filter cumulative");
    expect(row.textContent).toContain("Inverse");
    // The length is dragged, not typed.
    expect(row.querySelector('input[type="number"]')).toBeNull();
  });

  it("carries the average length on a slider that reads out the value it points at", async () => {
    const { container, onSmaLengthChange } = await render({ smaLength: 50 });
    const length = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter cumulative SMA length"]',
    )!;
    expect([length.type, length.min, length.max, length.step, length.value]).toEqual(
      ["range", "2", "100", "1", "50"],
    );
    expect(
      container.querySelector(".indicator-settings-inline-slider-value")
        ?.textContent,
    ).toBe("50");

    await setRangeValue(length, "80");
    expect(onSmaLengthChange).toHaveBeenCalledWith(80);
  });

  it("disables the length slider, but never the Inverse switch, while the filter is off", async () => {
    const { container } = await render({ enabled: false });
    const length = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter cumulative SMA length"]',
    )!;
    expect(length.disabled).toBe(true);
    expect(checkbox(container, "Filter cumulative inverse").disabled).toBe(false);
  });

  it("reflects and reports the Inverse switch independently of the filter toggle", async () => {
    const { container, onInvertedChange, onEnabledChange } = await render({
      inverted: true,
    });
    const inverse = checkbox(container, "Filter cumulative inverse");
    expect(inverse.checked).toBe(true);

    await act(async () => {
      inverse.click();
    });
    expect(onInvertedChange).toHaveBeenCalledWith(false);
    // Flipping the direction must not touch the filter's own on/off state.
    expect(onEnabledChange).not.toHaveBeenCalled();
  });

  it("keeps the Inverse switch reachable while the filter itself is off", async () => {
    // The switch is only READ while the filter is enabled, but hiding or
    // disabling it would make the setting unreachable exactly when someone
    // wants to prepare it before switching the filter on.
    const { container, onInvertedChange } = await render({ enabled: false });
    const inverse = checkbox(container, "Filter cumulative inverse");
    expect(inverse.disabled).toBe(false);

    await act(async () => {
      inverse.click();
    });
    expect(onInvertedChange).toHaveBeenCalledWith(true);
  });
});
