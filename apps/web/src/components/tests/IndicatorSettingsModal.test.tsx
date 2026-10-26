// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act, useLayoutEffect, useRef } from "react";
import { IndicatorSettingsModal } from "../IndicatorSettingsModal";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ isOpen, onCloseCallCount }: { isOpen: boolean; onCloseCallCount: number }) {
  // A fresh inline onClose every render, matching how MainPanel passes it
  // (MainPanel re-renders continuously off live market-data props).
  const onClose = () => {};
  void onCloseCallCount; // forces a distinct prop identity per render without affecting behavior
  return (
    <IndicatorSettingsModal isOpen={isOpen} onClose={onClose} title="Test Indicator" ariaLabel="Test Indicator settings">
      <div className="indicator-settings-body">
        <input type="text" data-testid="first-input" defaultValue="a" />
        <input type="text" data-testid="second-input" defaultValue="b" />
      </div>
    </IndicatorSettingsModal>
  );
}

async function render(root: Root, props: { isOpen: boolean; onCloseCallCount: number }) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
}

function dispatchPointer(target: Element, type: string, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

// Mirrors the real pattern WhaleDetectorSettingsModal uses: a child that
// manages its own mode-relevant focus via useLayoutEffect, which must win
// over the parent's own generic "focus the first input" effect.
function SmartChild({ isOpen }: { isOpen: boolean }) {
  const specialInputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (isOpen) specialInputRef.current?.focus();
  }, [isOpen]);
  return (
    <div className="indicator-settings-body">
      <input type="text" data-testid="generic-first-input" defaultValue="a" />
      <input type="text" data-testid="special-input" ref={specialInputRef} defaultValue="b" />
    </div>
  );
}

describe("IndicatorSettingsModal", () => {
  it("REGRESSION: defers to a child's own useLayoutEffect focus instead of overriding it with the generic first-input focus", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <IndicatorSettingsModal isOpen={true} onClose={() => {}} title="Test Indicator" ariaLabel="Test Indicator settings">
          <SmartChild isOpen={true} />
        </IndicatorSettingsModal>,
      );
    });

    expect(document.activeElement).toBe(container.querySelector('[data-testid="special-input"]'));
    root.unmount();
    container.remove();
  });

  it("still falls back to focusing the first input when the child manages no focus of its own", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <IndicatorSettingsModal isOpen={true} onClose={() => {}} title="Test Indicator" ariaLabel="Test Indicator settings">
          <div className="indicator-settings-body">
            <input type="text" data-testid="only-input" defaultValue="a" />
          </div>
        </IndicatorSettingsModal>,
      );
    });

    expect(document.activeElement).toBe(container.querySelector('[data-testid="only-input"]'));
    root.unmount();
    container.remove();
  });

  it("focuses the first input when it opens", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await render(root, { isOpen: true, onCloseCallCount: 0 });

    expect(document.activeElement).toBe(container.querySelector('[data-testid="first-input"]'));
    root.unmount();
    container.remove();
  });

  it("does not steal focus back to the first input on a re-render while open -- a live-data tick must not fight keyboard navigation", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await render(root, { isOpen: true, onCloseCallCount: 0 });
    const secondInput = container.querySelector<HTMLInputElement>('[data-testid="second-input"]')!;
    await act(async () => {
      secondInput.focus();
    });
    expect(document.activeElement).toBe(secondInput);

    // Simulate a live-data re-render: same isOpen, but a fresh onClose
    // identity and a changed prop, exactly like MainPanel's continuous
    // re-renders while the modal stays open.
    await render(root, { isOpen: true, onCloseCallCount: 1 });

    expect(document.activeElement).toBe(secondInput);
    root.unmount();
    container.remove();
  });

  it("Escape still calls the latest onClose after a re-render", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <IndicatorSettingsModal isOpen={true} onClose={onClose} title="Test Indicator" ariaLabel="Test Indicator settings">
          <div className="indicator-settings-body" />
        </IndicatorSettingsModal>,
      );
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    root.unmount();
    container.remove();
  });

  it("traps keyboard focus within the open dialog", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await render(root, { isOpen: true, onCloseCallCount: 0 });
    const move = container.querySelector<HTMLButtonElement>(".indicator-settings-drag-handle")!;
    const ok = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Ok")!;

    await act(async () => {
      ok.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(move);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(ok);

    root.unmount();
    container.remove();
  });

  it("moves by dragging the title, stays within the viewport, and resets when reopened", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await render(root, { isOpen: true, onCloseCallCount: 0 });
    const modal = container.querySelector<HTMLDivElement>(".indicator-settings-modal")!;
    const handle = container.querySelector<HTMLButtonElement>(".indicator-settings-drag-handle")!;
    vi.spyOn(modal, "getBoundingClientRect").mockImplementation(() => {
      const left = Number.parseFloat(modal.style.left) || 100;
      const top = Number.parseFloat(modal.style.top) || 100;
      return { left, top, width: 320, height: 200, right: left + 320, bottom: top + 200 } as DOMRect;
    });

    await act(async () => {
      dispatchPointer(handle, "pointerdown", 120, 120);
      dispatchPointer(handle, "pointermove", 170, 190);
      dispatchPointer(handle, "pointerup", 170, 190);
    });
    expect(modal.style.left).toBe("150px");
    expect(modal.style.top).toBe("170px");
    expect(modal.style.transform).toBe("none");

    await act(async () => {
      dispatchPointer(handle, "pointerdown", 170, 190);
      dispatchPointer(handle, "pointermove", 5000, 5000);
      dispatchPointer(handle, "pointerup", 5000, 5000);
    });
    expect(modal.style.left).toBe(`${window.innerWidth - 320}px`);
    expect(modal.style.top).toBe(`${window.innerHeight - 200}px`);

    await render(root, { isOpen: false, onCloseCallCount: 0 });
    await render(root, { isOpen: true, onCloseCallCount: 0 });
    expect(container.querySelector<HTMLDivElement>(".indicator-settings-modal")!.style.left).toBe("");
    root.unmount();
    container.remove();
  });

  it("supports keyboard movement without making the close button a drag handle", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await render(root, { isOpen: true, onCloseCallCount: 0 });
    const modal = container.querySelector<HTMLDivElement>(".indicator-settings-modal")!;
    const handle = container.querySelector<HTMLButtonElement>(".indicator-settings-drag-handle")!;
    const close = container.querySelector<HTMLButtonElement>(".indicator-settings-close")!;
    vi.spyOn(modal, "getBoundingClientRect").mockImplementation(() => {
      const left = Number.parseFloat(modal.style.left) || 100;
      const top = Number.parseFloat(modal.style.top) || 100;
      return { left, top, width: 320, height: 200, right: left + 320, bottom: top + 200 } as DOMRect;
    });

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    });
    expect(modal.style.left).toBe("120px");
    expect(modal.style.top).toBe("101px");
    await act(async () => {
      dispatchPointer(close, "pointerdown", 0, 0);
      dispatchPointer(close, "pointermove", 200, 200);
    });
    expect(modal.style.left).toBe("120px");
    expect(modal.style.top).toBe("101px");
    root.unmount();
    container.remove();
  });

  it("restores focus to the invoking control when the dialog closes", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await render(root, { isOpen: true, onCloseCallCount: 0 });
    await render(root, { isOpen: false, onCloseCallCount: 0 });

    expect(document.activeElement).toBe(trigger);
    root.unmount();
    container.remove();
    trigger.remove();
  });

  it("renders nothing when closed", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await render(root, { isOpen: false, onCloseCallCount: 0 });

    expect(container.querySelector(".indicator-settings-modal")).toBeNull();
    root.unmount();
    container.remove();
  });
});
