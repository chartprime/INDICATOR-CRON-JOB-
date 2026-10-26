// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IndicatorSettingsModal } from "../IndicatorSettingsModal";
import {
  INDICATOR_PRESETS_STORAGE_KEY,
  createPresetStore,
  indicatorPresets,
  localStoragePresetBackend,
  type PresetParams,
  type PresetStore,
} from "../../lib/chart/indicatorPresets";
import type { SettingsFieldSchema } from "../../lib/chart/indicatorTypes";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULTS: PresetParams = { length: 14, color: "#fff" };
const SCHEMA: readonly SettingsFieldSchema<{ length: number; color: string }>[] = [
  { kind: "numeric", key: "length", label: "Length", min: 1, max: 500, step: 1, affects: "recompute" },
  { kind: "color", key: "color", label: "Colour", affects: "cosmetic" },
];

let container: HTMLDivElement;
let root: Root;
let onApply: ReturnType<typeof vi.fn<(params: PresetParams) => void>>;
let onReset: ReturnType<typeof vi.fn<() => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function mount(params: PresetParams, store: PresetStore, presetKey = "rsi", shellClass?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const modal = (
    <IndicatorSettingsModal
      isOpen
      onClose={onClose}
      title="RSI"
      ariaLabel="RSI settings"
      presets={{ presetKey, params, schema: SCHEMA, defaults: DEFAULTS, onApply, onReset, store }}
    >
      <div className="indicator-settings-body"><input type="number" aria-label="Length" /></div>
    </IndicatorSettingsModal>
  );
  act(() => root.render(shellClass === undefined ? modal : <div className={shellClass}>{modal}</div>));
}

const defaultsButton = () => document.querySelector<HTMLButtonElement>(".indicator-settings-defaults")!;
const menu = () => document.querySelector<HTMLElement>(".indicator-presets-menu");
const items = () => [...document.querySelectorAll<HTMLButtonElement>(".indicator-presets-item")];
const item = (text: string) => items().find((button) => button.textContent === text)!;
const nameInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Preset name"]');
const presetNames = () => [...document.querySelectorAll<HTMLElement>(".indicator-presets-row .indicator-presets-item")].map((row) => row.textContent);

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function openMenu() {
  await click(defaultsButton());
}

async function saveAs(name: string) {
  await click(item("Save as preset…"));
  await type(nameInput()!, name);
  await key(nameInput()!, "Enter");
}

describe("IndicatorPresetsMenu", () => {
  beforeEach(() => {
    onApply = vi.fn<(params: PresetParams) => void>();
    onReset = vi.fn<() => void>();
    onClose = vi.fn<() => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("sits beside the footer's start as a Defaults button whose menu opens below the dialog, outside it", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    expect(defaultsButton().textContent).toContain("Defaults");
    expect(defaultsButton().getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
    await openMenu();
    expect(defaultsButton().getAttribute("aria-expanded")).toBe("true");
    expect(menu()).not.toBeNull();
    expect(menu()!.closest(".indicator-settings-modal")).toBeNull();
    expect(items().map((button) => button.textContent)).toEqual(["Reset settings", "Save as preset…"]);
    expect(document.body.textContent).not.toContain("Presets");
  });

  it("Reset settings runs the dialog's reset and closes the menu", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    await openMenu();
    await click(item("Reset settings"));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves the current settings under a name, and applying the preset brings them back after a change", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    await saveAs("Scalp mode");
    expect(nameInput()).toBeNull();
    expect(presetNames()).toEqual(["Scalp mode"]);
    expect(store.list("rsi")).toEqual([{ name: "Scalp mode", params: { length: 9, color: "#fff" } }]);
    act(() => root.unmount());
    container.remove();
    mount({ length: 50, color: "#fff" }, store);
    await openMenu();
    await click(item("Scalp mode"));
    expect(onApply).toHaveBeenCalledWith({ length: 9, color: "#fff" });
    expect(menu()).toBeNull();
  });

  it("the Save button saves too, and a new name joins the list in creation order", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    await click(item("Save as preset…"));
    await type(nameInput()!, "Swing");
    await click(document.querySelector<HTMLButtonElement>(".indicator-presets-name button")!);
    await click(item("Save as preset…"));
    await type(nameInput()!, "Scalp");
    await click(document.querySelector<HTMLButtonElement>(".indicator-presets-name button")!);
    expect(presetNames()).toEqual(["Swing", "Scalp"]);
  });

  it("saving under an existing name in another letter case replaces that preset in place", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    await saveAs("Scalp mode");
    await saveAs("Swing mode");
    act(() => root.unmount());
    container.remove();
    mount({ length: 21, color: "#000" }, store);
    await openMenu();
    await saveAs("scalp MODE");
    expect(presetNames()).toEqual(["scalp MODE", "Swing mode"]);
    expect(store.list("rsi")[0]).toEqual({ name: "scalp MODE", params: { length: 21, color: "#000" } });
  });

  it("refuses an empty name with a red border and keeps the field open", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    await click(item("Save as preset…"));
    await type(nameInput()!, "   ");
    await key(nameInput()!, "Enter");
    expect(nameInput()!.classList.contains("is-invalid")).toBe(true);
    expect(nameInput()!.getAttribute("aria-invalid")).toBe("true");
    expect(store.list("rsi")).toEqual([]);
    await type(nameInput()!, "Scalp");
    expect(nameInput()!.classList.contains("is-invalid")).toBe(false);
  });

  it("Escape in the name field cancels the name, not the dialog; Escape in the menu closes only the menu", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    await openMenu();
    await click(item("Save as preset…"));
    await type(nameInput()!, "Scal");
    await key(nameInput()!, "Escape");
    expect(nameInput()).toBeNull();
    expect(menu()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await key(item("Reset settings"), "Escape");
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(defaultsButton());
    await key(document.body, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deletes only the preset whose ✕ was clicked", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    await saveAs("Scalp mode");
    await saveAs("Swing mode");
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Delete preset Scalp mode"]')!);
    expect(presetNames()).toEqual(["Swing mode"]);
    expect(store.list("rsi").map((preset) => preset.name)).toEqual(["Swing mode"]);
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Delete preset Swing mode"]')!);
    expect(document.body.textContent).not.toContain("Presets");
  });

  it("presets survive a reload: a fresh store reads them back from the browser", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    await openMenu();
    await saveAs("Scalp mode");
    act(() => root.unmount());
    container.remove();
    expect(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)).toContain("Scalp mode");
    mount({ length: 50, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    await openMenu();
    expect(presetNames()).toEqual(["Scalp mode"]);
  });

  it("shows another indicator's presets nowhere", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    store.save("macd", "Fast", { length: 3 });
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    expect(presetNames()).toEqual([]);
  });

  it("an input added after the preset was saved gets its default when the preset is applied", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    store.save("rsi", "Old", { length: 9, retired: true });
    mount({ length: 50, color: "#fff" }, store);
    await openMenu();
    await click(item("Old"));
    expect(onApply).toHaveBeenCalledWith({ length: 9, color: "#fff" });
  });

  it("says when the preset could not be written, and keeps it in the list for this session", async () => {
    const store = createPresetStore({
      load: () => ({}),
      save: () => {
        throw new Error("quota");
      },
    });
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    await saveAs("Scalp mode");
    expect(document.querySelector(".indicator-presets-error")?.textContent).toBe("Could not save the preset");
    expect(presetNames()).toEqual(["Scalp mode"]);
  });

  it("the button carries the name of the preset the current settings match, and says Defaults otherwise", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    await store.save("rsi", "Scalp mode", { length: 9, color: "#fff" });
    await store.save("rsi", "Swing mode", { length: 50, color: "#fff" });
    mount({ length: 50, color: "#fff" }, store);
    expect(defaultsButton().textContent).toContain("Swing mode");
    expect(defaultsButton().textContent).not.toContain("Defaults");
    await openMenu();
    expect(item("Swing mode").getAttribute("aria-current")).toBe("true");
    expect(item("Scalp mode").getAttribute("aria-current")).toBeNull();
    act(() => root.unmount());
    container.remove();
    mount({ length: 51, color: "#fff" }, store);
    expect(defaultsButton().textContent).toContain("Defaults");
    await openMenu();
    await saveAs("Mine");
    expect(defaultsButton().textContent).toContain("Mine");
  });

  it("a preset matches on the inputs only: a key the indicator no longer has, or a missing optional one, does not break the match", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    await store.save("rsi", "Old", { length: 50, color: "#fff", retired: true });
    mount({ length: 50 }, store);
    expect(defaultsButton().textContent).toContain("Old");
  });

  it("a click outside the menu closes it", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    await openMenu();
    await act(async () => {
      container.querySelector('input[aria-label="Length"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("after Enter saves, focus stays in the menu and Escape closes only the menu", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    await openMenu();
    await saveAs("Scalp");
    expect(menu()!.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, "Escape");
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("after a delete, Escape closes only the menu", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    await store.save("rsi", "Scalp", { length: 9 });
    mount({ length: 9, color: "#fff" }, store);
    await openMenu();
    const remove = document.querySelector<HTMLButtonElement>('button[aria-label="Delete preset Scalp"]')!;
    remove.focus();
    await click(remove);
    expect(menu()!.contains(document.activeElement)).toBe(true);
    await key(document.activeElement!, "Escape");
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape closes only the menu even when focus has left it", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    await openMenu();
    (document.activeElement as HTMLElement).blur();
    await key(document.body, "Escape");
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("is a labelled dialog of plain buttons, announced as such by the Defaults button", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    expect(defaultsButton().getAttribute("aria-haspopup")).toBe("dialog");
    await openMenu();
    expect(menu()!.getAttribute("role")).toBe("dialog");
    expect(menu()!.getAttribute("aria-label")).toBe("Defaults");
    expect(menu()!.querySelector('[role="menuitem"]')).toBeNull();
  });

  it("is drawn inside the container the dialog sits in, so it takes the same theme", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()), "rsi", "shell historical-active");
    await openMenu();
    expect(menu()!.closest(".historical-active")).not.toBeNull();
    expect(menu()!.closest(".indicator-settings-modal")).toBeNull();
  });

  it("follows the Defaults button when the window is resized", async () => {
    mount({ length: 9, color: "#fff" }, createPresetStore(localStoragePresetBackend()));
    let buttonTop = 100;
    const rect = (top: number) => ({ top, bottom: top + 20, left: 50, right: 110, width: 60, height: 20, x: 50, y: top, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("indicator-settings-defaults") ? rect(buttonTop) : rect(0);
    });
    try {
      await openMenu();
      expect(menu()!.style.top).toBe("124px");
      buttonTop = 300;
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(menu()!.style.top).toBe("324px");
    } finally {
      spy.mockRestore();
    }
  });

  it("names the preset in use on the button, in full as its tooltip", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    const long = "BTCUSDT_PERP_SCALP_1M_ASIA_OPEN_TIGHT_V2";
    await store.save("rsi", long, { length: 9, color: "#fff" });
    mount({ length: 9, color: "#fff" }, store);
    expect(defaultsButton().getAttribute("title")).toBe(long);
    expect(defaultsButton().querySelector(".indicator-settings-defaults-label")!.textContent).toBe(long);
  });

  it("shows a preset another tab saved while the menu is open", async () => {
    mount({ length: 9, color: "#fff" }, indicatorPresets);
    await openMenu();
    expect(presetNames()).toEqual([]);
    localStorage.setItem(INDICATOR_PRESETS_STORAGE_KEY, JSON.stringify({ rsi: [{ name: "From the other tab", params: { length: 3 } }] }));
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: INDICATOR_PRESETS_STORAGE_KEY }));
    });
    expect(presetNames()).toEqual(["From the other tab"]);
  });
});
