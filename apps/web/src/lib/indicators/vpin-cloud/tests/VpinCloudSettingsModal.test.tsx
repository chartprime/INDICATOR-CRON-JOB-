// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { VpinCloudSettingsModal } from "../VpinCloudSettingsModal";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function baseProps() {
  return {
    onClose: () => {},
    sensitivity: 1,
    defaultSensitivity: 1,
    onSensitivityChange: () => {},
    visible: true,
    onVisibleChange: () => {},
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  return act(async () => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function renderIn(root: Root, extra: Partial<ReturnType<typeof baseProps>> = {}) {
  await act(async () => {
    root.render(<VpinCloudSettingsModal {...baseProps()} isOpen={true} {...extra} />);
  });
}

async function switchToVisibilityTab(container: HTMLDivElement) {
  await act(async () => {
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    (Array.from(tabs).find((tab) => tab.textContent === "Visibility") as HTMLButtonElement).click();
  });
}

describe("VpinCloudSettingsModal", () => {
  it("offers exactly one numerical behavioural control: Sensitivity", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await renderIn(root);

    const inputs = container.querySelectorAll<HTMLInputElement>('.indicator-settings-field input[type="number"]');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].previousElementSibling?.textContent).toBe("Sensitivity");
    root.unmount();
    container.remove();
  });

  it("passes a valid sensitivity through and names the data-derived default in the hint", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSensitivityChange = vi.fn();
    await renderIn(root, { onSensitivityChange, defaultSensitivity: 1.42 });

    const input = container.querySelector<HTMLInputElement>('.indicator-settings-field input[type="number"]')!;
    await setInputValue(input, "1.5");

    expect(onSensitivityChange).toHaveBeenCalledWith(1.5);
    expect(container.textContent).toContain("1.42");
    root.unmount();
    container.remove();
  });

  it("rejects a sensitivity outside [MIN_VPIN_SENSITIVITY, MAX_VPIN_SENSITIVITY]", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSensitivityChange = vi.fn();
    await renderIn(root, { onSensitivityChange });
    const input = container.querySelector<HTMLInputElement>('.indicator-settings-field input[type="number"]')!;

    await setInputValue(input, "0.1");
    await setInputValue(input, "5");
    expect(onSensitivityChange).not.toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  it("keeps a cleared field editable across a live re-render", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await renderIn(root);
    const input = container.querySelector<HTMLInputElement>('.indicator-settings-field input[type="number"]')!;

    await setInputValue(input, "");
    await renderIn(root);
    expect(input.value).toBe("");
    root.unmount();
    container.remove();
  });

  it("shows the visibility checkbox only on the Visibility tab, and it reflects the current value", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await renderIn(root, { visible: false });

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await switchToVisibilityTab(container);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    root.unmount();
    container.remove();
  });

  it("resets sensitivity to the instrument-derived default and visibility to true, without closing the modal", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSensitivityChange = vi.fn();
    const onVisibleChange = vi.fn();
    const onClose = vi.fn();
    await renderIn(root, {
      sensitivity: 3, defaultSensitivity: 1.2, visible: false, onSensitivityChange, onVisibleChange, onClose,
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".indicator-settings-reset")!.click();
    });

    expect(onSensitivityChange).toHaveBeenCalledWith(1.2);
    expect(onVisibleChange).toHaveBeenCalledWith(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('.indicator-settings-field input[type="number"]')?.value).toBe("1.2");
    root.unmount();
    container.remove();
  });
});
