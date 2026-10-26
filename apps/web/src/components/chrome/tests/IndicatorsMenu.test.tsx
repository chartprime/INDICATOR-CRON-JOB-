// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IndicatorsMenu } from "../IndicatorsMenu";
import { INDICATOR_REGISTRY, type IndicatorId } from "../../../lib/chart/indicatorRegistry";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLDivElement }[] = [];
afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  localStorage.clear();
});

async function setup(active: ReadonlySet<IndicatorId> = new Set()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const toggle = vi.fn<(id: IndicatorId) => void>();
  await act(async () => root.render(<IndicatorsMenu active={active} onToggleActive={toggle} />));
  mounted.push({ root, container });
  await act(async () => container.querySelector<HTMLButtonElement>(".indicators-trigger")!.click());
  return { container, toggle };
}

async function type(container: HTMLElement, text: string) {
  const input = container.querySelector<HTMLInputElement>(".indicators-dialog-search input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".indicators-row-label")].map((label) => label.textContent ?? "");
}

async function select(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".indicators-dialog-nav button")].find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe("IndicatorsMenu", () => {
  it("shows every registered indicator in the complete library", async () => {
    const { container } = await setup();
    await select(container, "All indicators");
    expect(container.querySelectorAll(".indicators-result")).toHaveLength(INDICATOR_REGISTRY.length);
    expect(document.activeElement).toBe(container.querySelector(".indicators-dialog-search input"));
  });

  it("separates candle, print and book indicators by input family", async () => {
    const { container } = await setup();
    await select(container, "Basic · OHLCV");
    expect(container.textContent).toContain("EMA (12 / 21)");
    expect(container.textContent).not.toContain("Large Trade Detector");
    await select(container, "Orderflow · L1");
    expect(container.textContent).toContain("Large Trade Detector");
    expect(container.textContent).toContain("Session Delta Profile");
    expect(container.textContent).not.toContain("EMA (12 / 21)");
    await select(container, "Orderbook · L2");
    expect(container.textContent).toContain("Passive Liquidity");
    expect(container.textContent).not.toContain("Session Delta Profile");
  });

  it("keeps chart activation distinct from starred shortcuts", async () => {
    const { container, toggle } = await setup(new Set(["ema"]));
    const ema = [...container.querySelectorAll(".indicators-result")].find((item) => item.textContent?.includes("EMA (12 / 21)"))!;
    expect(ema.querySelector(".indicators-row")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => (ema.querySelector(".indicators-star") as HTMLButtonElement).click());
    expect(toggle).not.toHaveBeenCalled();
    await select(container, "Favorites");
    expect(container.querySelectorAll(".indicators-result")).toHaveLength(1);
    await select(container, "On chart");
    expect(container.querySelectorAll(".indicators-result")).toHaveLength(1);
    await act(async () => (container.querySelector(".indicators-row") as HTMLButtonElement).click());
    expect(toggle).toHaveBeenCalledWith("ema");
  });

  it("filters by search and restores focus when Escape closes the dialog", async () => {
    const { container } = await setup();
    await select(container, "All indicators");
    const input = container.querySelector<HTMLInputElement>(".indicators-dialog-search input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "vpin");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll(".indicators-result")).toHaveLength(1);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".indicators-popover")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".indicators-trigger"));
  });

  it("searches every indicator whichever group is selected, and a group click or closing clears the search (PR #33 review)", async () => {
    const { container } = await setup();
    expect(container.querySelector(".indicators-results-heading")?.textContent).toContain("Basic · OHLCV");
    await type(container, "vwap bands");
    expect(labels(container)).toEqual(["VWAP Bands"]);
    expect(container.querySelector(".indicators-results-heading")?.textContent).toContain("Search · all indicators");
    expect(container.querySelector(".indicators-dialog-nav button.active")).toBeNull();
    await select(container, "Orderbook · L2");
    expect(container.querySelector<HTMLInputElement>(".indicators-dialog-search input")!.value).toBe("");
    expect(labels(container)).toContain("Passive Liquidity Heatmap");
    await type(container, "ema");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => container.querySelector<HTMLButtonElement>(".indicators-trigger")!.click());
    expect(container.querySelector<HTMLInputElement>(".indicators-dialog-search input")!.value).toBe("");
  });

  it("keeps stars across a reload, drops a starred id the registry no longer has, and survives storage that is not a list", async () => {
    localStorage.setItem("terminal.indicators.starred.v1", JSON.stringify(["ema", "noSuchIndicator"]));
    const { container } = await setup();
    await select(container, "Favorites");
    expect(labels(container)).toEqual(["EMA (12 / 21)"]);
    await act(async () => container.querySelector<HTMLButtonElement>(".indicators-star")!.click());
    expect(JSON.parse(localStorage.getItem("terminal.indicators.starred.v1")!)).toEqual([]);
    localStorage.setItem("terminal.indicators.starred.v1", "{not json");
    const second = await setup();
    await select(second.container, "Favorites");
    expect(labels(second.container)).toEqual([]);
  });

  it("closes on the backdrop without toggling anything, and traps Tab inside the dialog", async () => {
    const { container, toggle } = await setup();
    const dialog = container.querySelector<HTMLElement>(".indicators-popover")!;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    focusable.at(-1)!.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(focusable[0]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(focusable.at(-1));
    await act(async () => container.querySelector<HTMLElement>(".menu-backdrop")!.click());
    expect(container.querySelector(".indicators-popover")).toBeNull();
    expect(toggle).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelector(".indicators-trigger"));
  });
});

