// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { VolumeDeltaProfileTickSettingsModal } from "../VolumeDeltaProfileTickSettingsModal";
import {
  DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  type VolumeDeltaProfileTickSettings,
} from "../volumeDeltaProfileTickSettings";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The field row whose label starts with `label`, as rendered in the modal. */
function field(container: HTMLElement, label: string): HTMLLabelElement | null {
  const rows = Array.from(
    container.querySelectorAll<HTMLLabelElement>(
      "label.indicator-settings-field",
    ),
  );
  return (
    rows.find((row) =>
      row.querySelector("span")?.textContent?.startsWith(label),
    ) ?? null
  );
}

function rangeInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = field(container, label)?.querySelector<HTMLInputElement>(
    'input[type="range"]',
  );
  if (!input) throw new Error(`no range field labelled "${label}"`);
  return input;
}

async function setRangeValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The inline toggle whose words are `text`, with the label it is drawn in. */
function checkboxFor(
  container: HTMLElement,
  text: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = Array.from(
    container.querySelectorAll<HTMLLabelElement>(
      "label.indicator-settings-checkbox",
    ),
  ).find((row) => row.querySelector("span")?.textContent === text);
  const input = label?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!label || !input) throw new Error(`no toggle labelled "${text}"`);
  return { label, input };
}

async function openInputsTab(container: HTMLElement) {
  await act(async () => {
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    (
      Array.from(tabs).find(
        (tab) => tab.textContent === "Inputs",
      ) as HTMLButtonElement
    ).click();
  });
}

/** Opens the modal on the Visibility tab, the tab this indicator's colours live in. */
async function mount(
  options: {
    settings?: VolumeDeltaProfileTickSettings;
    onSettingsChange?: (next: VolumeDeltaProfileTickSettings) => void;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <VolumeDeltaProfileTickSettingsModal
        isOpen
        onClose={() => {}}
        settings={
          options.settings ?? DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS
        }
        onSettingsChange={options.onSettingsChange ?? (() => {})}
        visible
        onVisibleChange={() => {}}
      />,
    );
  });
  await act(async () => {
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    (
      Array.from(tabs).find(
        (tab) => tab.textContent === "Visibility",
      ) as HTMLButtonElement
    ).click();
  });

  return { container, root };
}

function close(container: HTMLDivElement, root: Root) {
  root.unmount();
  container.remove();
}

describe("VolumeDeltaProfileTickSettingsModal", () => {
  it("offers a VAH/VAL thickness control on the Visibility tab", async () => {
    const { container, root } = await mount();

    const input = rangeInput(container, "VAH / VAL Thickness");
    expect(field(container, "VAH / VAL Thickness")?.textContent).toContain(
      "1px",
    );
    expect(input.value).toBe("1");

    close(container, root);
  });

  it("reports the chosen thickness back, leaving the rest of the settings alone", async () => {
    const onSettingsChange = vi.fn();
    const { container, root } = await mount({ onSettingsChange });

    await setRangeValue(rangeInput(container, "VAH / VAL Thickness"), "4");

    expect(onSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
      vahValLineWidth: 4,
    });

    close(container, root);
  });

  it("never lets the minimum opacity pass the maximum, or the maximum drop below the minimum", async () => {
    const onSettingsChange = vi.fn();
    const settings = {
      ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
      minOpacity: 0.4,
      maxOpacity: 0.7,
    };
    const { container, root } = await mount({ settings, onSettingsChange });
    await act(async () => {
      const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      (
        Array.from(tabs).find((tab) => tab.textContent === "Inputs") as HTMLButtonElement
      ).click();
    });

    await setRangeValue(rangeInput(container, "Min Opacity"), "0.9");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, minOpacity: 0.7 });
    await setRangeValue(rangeInput(container, "Max Opacity"), "0.2");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...settings, maxOpacity: 0.4 });

    close(container, root);
  });

  it("puts the fixed-row toggle inline, directly under the Rows control, and reports it back", async () => {
    const onSettingsChange = vi.fn();
    const { container, root } = await mount({ onSettingsChange });
    await openInputsTab(container);

    const rows = Array.from(
      container.querySelectorAll("label.indicator-settings-field"),
    );
    const rowsField = rows.find((row) =>
      row.querySelector("span")?.textContent?.startsWith("Rows"),
    );
    const toggle = checkboxFor(container, "Fixed amount of rows");
    // Inline, so box and words share the row: that is what the class draws, and
    // what the field class it must not use would stack.
    expect(toggle.label.classList.contains("indicator-settings-checkbox")).toBe(
      true,
    );
    expect(rowsField?.nextElementSibling).toBe(toggle.label);
    expect(toggle.input.checked).toBe(false);

    await act(async () => {
      toggle.input.click();
    });
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
      fixedRowCount: true,
    });

    close(container, root);
  });

  it("shows the fixed-row toggle on when the setting is saved on", async () => {
    const { container, root } = await mount({
      settings: {
        ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
        fixedRowCount: true,
      },
    });
    await openInputsTab(container);

    expect(checkboxFor(container, "Fixed amount of rows").input.checked).toBe(
      true,
    );

    close(container, root);
  });

  it("puts the bin volume toggle inline, and reports it back", async () => {
    const onSettingsChange = vi.fn();
    const { container, root } = await mount({ onSettingsChange });

    const toggle = checkboxFor(container, "Bin Volume Text");
    expect(toggle.label.classList.contains("indicator-settings-checkbox")).toBe(
      true,
    );

    await act(async () => {
      toggle.input.click();
    });
    expect(onSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
      binVolumeVisible: false,
    });

    close(container, root);
  });

  it("hides the thickness control with the levels it belongs to", async () => {
    const { container, root } = await mount({
      settings: {
        ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
        vahValVisible: false,
      },
    });

    expect(field(container, "VAH / VAL Thickness")).toBeNull();

    close(container, root);
  });

  it("offers a POC thickness control while the POC line is on", async () => {
    const { container, root } = await mount();

    expect(rangeInput(container, "POC Thickness").value).toBe("2");
    expect(field(container, "POC Thickness")?.textContent).toContain("2px");

    close(container, root);
  });

  it("reports the chosen POC thickness back, leaving the rest of the settings alone", async () => {
    const onSettingsChange = vi.fn();
    const { container, root } = await mount({ onSettingsChange });

    await setRangeValue(rangeInput(container, "POC Thickness"), "6");

    expect(onSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
      pocLineWidth: 6,
    });

    close(container, root);
  });

  it("hides the POC thickness control when the POC line is off", async () => {
    const { container, root } = await mount({
      settings: {
        ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
        pocVisible: false,
      },
    });

    expect(field(container, "POC Thickness")).toBeNull();

    close(container, root);
  });
});
