// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, type Mock } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DrawingToolbar } from "../DrawingToolbar";
import type { DrawingToolId } from "../../../lib/chart/drawingStore";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoots: { root: Root; container: HTMLDivElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mountedRoots) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  mountedRoots = [];
});

async function render({
  activeTool = null,
  onSelectTool = vi.fn<(tool: DrawingToolId | null) => void>(),
}: {
  activeTool?: DrawingToolId | null;
  onSelectTool?: Mock<(tool: DrawingToolId | null) => void>;
} = {}): Promise<{ container: HTMLDivElement; onSelectTool: Mock<(tool: DrawingToolId | null) => void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<DrawingToolbar activeTool={activeTool} onSelectTool={onSelectTool} />);
  });
  mountedRoots.push({ root, container });
  return { container, onSelectTool };
}

function pill(container: HTMLDivElement, label: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".tf-pill")).find((b) => b.title === label)!;
}

describe("DrawingToolbar", () => {
  it("renders Cursor and Trendline pills, Cursor active by default", async () => {
    const { container } = await render();
    expect(pill(container, "Cursor").getAttribute("aria-pressed")).toBe("true");
    expect(pill(container, "Trendline").getAttribute("aria-pressed")).toBe("false");
  });

  it("reflects an externally-active tool as the pressed pill", async () => {
    const { container } = await render({ activeTool: "trendline" });
    expect(pill(container, "Cursor").getAttribute("aria-pressed")).toBe("false");
    expect(pill(container, "Trendline").getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Trendline selects it", async () => {
    const { container, onSelectTool } = await render();
    await act(async () => {
      pill(container, "Trendline").click();
    });
    expect(onSelectTool).toHaveBeenCalledWith("trendline");
  });

  it("clicking the already-active tool again deselects back to the cursor", async () => {
    const { container, onSelectTool } = await render({ activeTool: "trendline" });
    await act(async () => {
      pill(container, "Trendline").click();
    });
    expect(onSelectTool).toHaveBeenCalledWith(null);
  });

  it("clicking Cursor while a tool is active deselects it", async () => {
    const { container, onSelectTool } = await render({ activeTool: "trendline" });
    await act(async () => {
      pill(container, "Cursor").click();
    });
    expect(onSelectTool).toHaveBeenCalledWith(null);
  });

  it("renders a Fixed Range pill (P4.09) alongside Trendline and Fibonacci", async () => {
    const { container, onSelectTool } = await render();
    expect(pill(container, "Fixed Range").getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      pill(container, "Fixed Range").click();
    });
    expect(onSelectTool).toHaveBeenCalledWith("fixedRangeProfile");
  });
});
