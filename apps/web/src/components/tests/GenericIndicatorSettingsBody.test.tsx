// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { GenericIndicatorSettingsBody } from "../GenericIndicatorSettingsBody";
import type { SettingsFieldSchema } from "../../lib/chart/indicatorTypes";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  return act(async () => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

interface TestSettings {
  visible: boolean;
  sessions: ReadonlySet<string>;
  mode: "a" | "b";
  length: number;
  color: string;
}

const DEFAULT_SETTINGS: TestSettings = {
  visible: true,
  sessions: new Set(["london"]),
  mode: "a",
  length: 14,
  color: "red",
};

async function render(
  schema: readonly SettingsFieldSchema<TestSettings>[],
  settings: TestSettings = DEFAULT_SETTINGS,
): Promise<{ container: HTMLDivElement; root: Root; onChange: ReturnType<typeof vi.fn<(next: TestSettings) => void>> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onChange = vi.fn<(next: TestSettings) => void>();
  await act(async () => {
    root.render(<GenericIndicatorSettingsBody schema={schema} settings={settings} onChange={onChange} />);
  });
  return { container, root, onChange };
}

describe("GenericIndicatorSettingsBody", () => {
  it("boolean field reflects settings and toggling calls onChange with only that key updated", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "boolean", key: "visible", label: "Show on chart", affects: "cosmetic" },
    ];
    const { container, onChange } = await render(schema);
    const checkbox = container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(checkbox.checked).toBe(true);

    await act(async () => {
      checkbox.click();
    });

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, visible: false });
  });

  it("checkboxList reflects Set membership per option and toggles independently", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      {
        kind: "checkboxList", key: "sessions", label: "Sessions", affects: "cosmetic",
        options: [{ value: "london", label: "London" }, { value: "ny", label: "New York" }],
      },
    ];
    const { container, onChange } = await render(schema);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);

    await act(async () => {
      boxes[1].click();
    });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, sessions: new Set(["london", "ny"]) });

    onChange.mockClear();
    await act(async () => {
      boxes[0].click();
    });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, sessions: new Set() });
  });

  it("radioGroup reflects the current value and selecting a different option calls onChange", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      {
        kind: "radioGroup", key: "mode", label: "Mode", affects: "recompute",
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      },
    ];
    const { container, onChange } = await render(schema);
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);

    await act(async () => {
      radios[1].click();
    });

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, mode: "b" });
  });

  it("numeric field commits a valid value and does not clobber the displayed input on an invalid one", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "numeric", key: "length", label: "Length", min: 1, max: 100, step: 1, affects: "recompute" },
    ];
    const { container, onChange } = await render(schema);
    const input = container.querySelector<HTMLInputElement>("input[type=number]")!;
    expect(input.value).toBe("14");

    await setInputValue(input, "50");
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, length: 50 });

    onChange.mockClear();
    await setInputValue(input, "500");
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("500");
  });

  it("numeric field rejects a value that is inside the range but off the declared step", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "numeric", key: "length", label: "Length", min: 2, max: 100, step: 1, affects: "recompute" },
    ];
    const { container, onChange } = await render(schema);
    const input = container.querySelector<HTMLInputElement>("input[type=number]")!;

    await setInputValue(input, "2.5");

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("2.5");
  });

  it("slider field renders a range input, commits what it lands on, and reads whole steps as integers", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "slider", key: "length", label: "Length", min: 1, max: 100, step: 1, affects: "recompute" },
    ];
    const { container, onChange } = await render(schema);
    const input = container.querySelector<HTMLInputElement>("input[type=range]")!;
    expect([input.min, input.max, input.step, input.value]).toEqual(["1", "100", "1", "14"]);
    expect(container.querySelector(".indicator-settings-field span")?.textContent).toBe("Length 14");

    await setInputValue(input, "50");
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, length: 50 });
  });

  it("slider field keeps the decimals on a fractional step", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "slider", key: "length", label: "Length", min: 0, max: 1, step: 0.05, affects: "cosmetic" },
    ];
    const { container } = await render(schema, { ...DEFAULT_SETTINGS, length: 0.5 });
    expect(container.querySelector(".indicator-settings-field span")?.textContent).toBe("Length 0.50");
  });

  it("staticHint renders its text verbatim", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [{ kind: "staticHint", text: "A plain hint." }];
    const { container } = await render(schema);
    expect(container.querySelector(".indicator-settings-hint")?.textContent).toBe("A plain hint.");
  });

  it("custom field receives the live settings and onChange", async () => {
    const customRender = vi.fn(() => null);
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "custom", affects: "cosmetic", render: customRender },
    ];
    await render(schema);
    expect(customRender).toHaveBeenCalledWith(DEFAULT_SETTINGS, expect.any(Function));
  });

  it("visibleIf hides a field when it returns false, and shows it when the condition is met", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "boolean", key: "visible", label: "Only in mode b", affects: "cosmetic", visibleIf: (s) => s.mode === "b" },
    ];
    const { container: hiddenContainer } = await render(schema, DEFAULT_SETTINGS);
    expect(hiddenContainer.querySelector("input[type=checkbox]")).toBeNull();

    const { container: shownContainer } = await render(schema, { ...DEFAULT_SETTINGS, mode: "b" });
    expect(shownContainer.querySelector("input[type=checkbox]")).not.toBeNull();
  });

  it("renders no tab UI and shows every field flat when no field declares a tab", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "boolean", key: "visible", label: "Visible", affects: "cosmetic" },
      { kind: "numeric", key: "length", label: "Length", min: 1, max: 100, step: 1, affects: "recompute" },
    ];
    const { container } = await render(schema);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
    expect(container.querySelector("input[type=number]")).not.toBeNull();
  });

  it("groups fields by tab and shows only the active tab's fields", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "numeric", key: "length", label: "Length", min: 1, max: 100, step: 1, affects: "recompute", tab: "inputs" },
      { kind: "boolean", key: "visible", label: "Visible", affects: "cosmetic", tab: "visibility" },
    ];
    const { container } = await render(schema);
    expect(container.querySelector("input[type=number]")).not.toBeNull();
    expect(container.querySelector("input[type=checkbox]")).toBeNull();

    const visibilityTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (tab) => tab.textContent === "Visibility",
    )!;
    await act(async () => {
      visibilityTab.click();
    });

    expect(container.querySelector("input[type=number]")).toBeNull();
    expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
  });

  it("puts advanced fields in a collapsed Advanced group after the primary inputs, without adding tabs", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "numeric", key: "length", label: "Length", min: 1, max: 100, step: 1, affects: "recompute" },
      { kind: "boolean", key: "visible", label: "Deeper toggle", affects: "cosmetic", tab: "advanced" },
    ];
    const { container, onChange } = await render(schema);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    const group = container.querySelector<HTMLDetailsElement>("details.indicator-settings-advanced")!;
    expect(group.open).toBe(false);
    expect(group.querySelector("summary")?.textContent).toBe("Advanced");
    expect(group.querySelector("input[type=checkbox]")).not.toBeNull();
    expect(container.querySelector("input[type=number]")?.closest("details")).toBeNull();

    await act(async () => {
      group.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
    });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, visible: false });
  });

  it("keeps advanced fields on the Inputs tab when the schema also has a Visibility tab", async () => {
    const schema: SettingsFieldSchema<TestSettings>[] = [
      { kind: "numeric", key: "length", label: "Length", min: 1, max: 100, step: 1, affects: "recompute", tab: "inputs" },
      { kind: "radioGroup", key: "mode", label: "Mode", affects: "recompute", tab: "advanced", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { kind: "boolean", key: "visible", label: "Visible", affects: "cosmetic", tab: "visibility" },
    ];
    const { container } = await render(schema);
    expect(container.querySelector("details.indicator-settings-advanced input[type=radio]")).not.toBeNull();

    const visibilityTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (tab) => tab.textContent === "Visibility",
    )!;
    await act(async () => {
      visibilityTab.click();
    });
    expect(container.querySelector("details.indicator-settings-advanced")).toBeNull();
    expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
  });
});
