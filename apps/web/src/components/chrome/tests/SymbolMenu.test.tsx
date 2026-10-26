// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { SymbolMenu } from "../SymbolMenu";
import { INSTRUMENTS } from "../../../lib/chart/instruments";
import type { FrameIdentity } from "../../../types/frames";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BTC_SPOT_IDENTITY: FrameIdentity = { provider: "BINANCE", marketKind: "SPOT" };

async function render({
  disabled = false,
  onSelect = vi.fn<(symbol: string, identity: FrameIdentity) => void>(),
}: {
  disabled?: boolean;
  onSelect?: ReturnType<typeof vi.fn<(symbol: string, identity: FrameIdentity) => void>>;
} = {}): Promise<{ container: HTMLDivElement; root: Root; onSelect: ReturnType<typeof vi.fn<(symbol: string, identity: FrameIdentity) => void>> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SymbolMenu
        instruments={INSTRUMENTS}
        activeSymbol="BTC-USDT"
        activeIdentity={BTC_SPOT_IDENTITY}
        disabled={disabled}
        onSelect={onSelect}
      />,
    );
  });
  return { container, root, onSelect };
}

async function openMenu(container: HTMLDivElement): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".symbol-menu-trigger")!.click();
  });
}

describe("SymbolMenu", () => {
  it("traps keyboard focus within the open popover -- Tab off the last option wraps to the first", async () => {
    const { container } = await render();
    await openMenu(container);
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const first = options[0];
    const last = options[options.length - 1];

    await act(async () => {
      last.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("selecting an option calls onSelect with that instrument's symbol and identity", async () => {
    const { container, onSelect } = await render();
    await openMenu(container);
    const ethOption = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (el) => el.textContent === "ETH Spot",
    )!;

    await act(async () => {
      ethOption.click();
    });

    expect(onSelect).toHaveBeenCalledWith("ETH-USDT", { provider: "BINANCE", marketKind: "SPOT" });
  });

  it("the active instrument is marked aria-selected and reflected in the trigger label", async () => {
    const { container } = await render();
    expect(container.querySelector(".symbol-menu-trigger")?.textContent).toContain("BTC Spot");
    await openMenu(container);
    const active = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (el) => el.textContent === "BTC Spot",
    )!;
    expect(active.getAttribute("aria-selected")).toBe("true");
  });

  it("does not open when disabled", async () => {
    const { container } = await render({ disabled: true });
    expect(container.querySelector<HTMLButtonElement>(".symbol-menu-trigger")!.disabled).toBe(true);
    await openMenu(container);
    expect(container.querySelector(".symbol-menu-popover")).toBeNull();
  });
});
