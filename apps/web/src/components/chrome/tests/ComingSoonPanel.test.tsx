// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ComingSoonPanel } from "../ComingSoonPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("ComingSoonPanel", () => {
  it("renders the given title and description", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ComingSoonPanel title="Order flow analytics" description="Not built yet." />);
    });

    expect(container.textContent).toContain("Order flow analytics");
    expect(container.textContent).toContain("Not built yet.");
    expect(container.textContent).toContain("Coming soon");
  });

  it("contains no interactive elements -- must never look functional when it isn't", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ComingSoonPanel title="Liquidity heatmap" description="Not built yet." />);
    });

    expect(container.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
  });
});
