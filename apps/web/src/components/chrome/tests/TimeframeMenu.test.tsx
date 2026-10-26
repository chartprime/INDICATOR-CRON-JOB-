// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { TimeframeMenu } from "../TimeframeMenu";
import { TIMEFRAMES } from "../../../lib/chart/resampleBars";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoots: { root: Root; container: HTMLDivElement }[] = [];

// Node's own experimental native localStorage global is present in
// this test environment but non-functional without a --localstorage-
// file flag (confirmed directly: typeof localStorage.clear ===
// "undefined", and it shadows jsdom's own working implementation).
// Real browser usage is unaffected -- this is a test-environment-only
// gap, worked around with an actual in-memory Storage stub per test.
function createFakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createFakeLocalStorage());
});

afterEach(async () => {
  for (const { root, container } of mountedRoots) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  mountedRoots = [];
  vi.unstubAllGlobals();
});

async function render(intervalMs: number, onTimeframeSelect = vi.fn()): Promise<{ container: HTMLDivElement; onTimeframeSelect: ReturnType<typeof vi.fn> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const selectedId = TIMEFRAMES.find((timeframe) => timeframe.intervalMs === intervalMs)?.label;
  if (selectedId === undefined) throw new Error(`missing live timeframe: ${intervalMs}`);
  await act(async () => {
    root.render(
      <TimeframeMenu
        selectedId={selectedId}
        onTimeframeSelect={(id) => {
          const timeframe = TIMEFRAMES.find((candidate) => candidate.label === id);
          if (timeframe !== undefined) onTimeframeSelect(timeframe.intervalMs);
        }}
      />,
    );
  });
  mountedRoots.push({ root, container });
  return { container, onTimeframeSelect };
}

async function openDropdown(container: HTMLDivElement): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!.click();
  });
}

describe("TimeframeMenu", () => {
  it("shows the default favorited timeframes as quick-access pills on first use", async () => {
    const { container } = await render(60_000);
    const labels = Array.from(container.querySelectorAll(".tf-pill")).map((el) => el.textContent);
    expect(labels).toEqual(["1m", "5m", "15m", "1h", "4h", "1D"]);
  });

  it("clicking a quick-access pill calls onTimeframeSelect with that interval", async () => {
    const { container, onTimeframeSelect } = await render(60_000);
    const fiveMin = Array.from(container.querySelectorAll<HTMLButtonElement>(".tf-pill")).find((b) => b.textContent === "5m")!;
    await act(async () => {
      fiveMin.click();
    });
    expect(onTimeframeSelect).toHaveBeenCalledWith(5 * 60_000);
  });

  it("the active timeframe shows in the quick row even when it isn't one of the defaults -- never lose sight of what's on screen", async () => {
    const { container } = await render(3 * 60_000); // "3m" is not in the default favorites
    const labels = Array.from(container.querySelectorAll(".tf-pill")).map((el) => el.textContent);
    expect(labels).toContain("3m");
    const threeMinPill = Array.from(container.querySelectorAll(".tf-pill")).find((el) => el.textContent === "3m")!;
    expect(threeMinPill.className).toContain("active");
  });

  it("the dropdown lists every timeframe, not just the favorited ones", async () => {
    const { container } = await render(60_000);
    await openDropdown(container);
    const rows = Array.from(container.querySelectorAll(".tf-menu-row-select")).map((el) => el.textContent);
    expect(rows).toEqual(["1m", "2m", "3m", "5m", "15m", "30m", "1h", "4h", "6h", "12h", "1D"]);
  });

  it("exposes dialog semantics and moves focus into the dropdown when opened", async () => {
    const { container } = await render(60_000);
    const trigger = container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!;
    await openDropdown(container);

    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(container.querySelector(".tf-menu-popover")?.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(container.querySelector<HTMLButtonElement>(".tf-menu-row-select"));
  });

  it("clicking a row's label selects that timeframe and closes the dropdown", async () => {
    const { container, onTimeframeSelect } = await render(60_000);
    await openDropdown(container);
    const twoMinRow = Array.from(container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select")).find((b) => b.textContent === "2m")!;
    await act(async () => {
      twoMinRow.click();
    });
    expect(onTimeframeSelect).toHaveBeenCalledWith(2 * 60_000);
    expect(container.querySelector(".tf-menu-popover")).toBeNull();
  });

  it("ArrowDown/ArrowUp and Home/End move focus between rows, wrapping at the ends", async () => {
    const { container } = await render(60_000);
    await openDropdown(container);
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"));
    const first = rows[0];
    const second = rows[1];
    const last = rows[rows.length - 1];

    expect(document.activeElement).toBe(first);

    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(second);

    await act(async () => {
      second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(last);

    await act(async () => {
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);

    // Wraps past the last row back to the first, same as SymbolMenu's own row navigation.
    await act(async () => {
      last.focus();
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(first);
  });

  it("clicking a star toggles that timeframe into the quick-access row without needing a reload", async () => {
    const { container } = await render(60_000);
    await openDropdown(container);
    const twoMinStar = container.querySelectorAll(".tf-menu-row")[1].querySelector<HTMLButtonElement>(".tf-menu-star")!;

    await act(async () => {
      twoMinStar.click();
    });

    expect(Array.from(container.querySelectorAll(".tf-pill")).map((el) => el.textContent)).toContain("2m");
    expect(twoMinStar.getAttribute("aria-pressed")).toBe("true");
  });

  it("unfavoriting removes it from the quick row (when it isn't the active timeframe)", async () => {
    const { container } = await render(60_000);
    await openDropdown(container);
    const fiveMinStar = Array.from(container.querySelectorAll(".tf-menu-row")).find(
      (row) => row.querySelector(".tf-menu-row-select")?.textContent === "5m",
    )!.querySelector<HTMLButtonElement>(".tf-menu-star")!;

    await act(async () => {
      fiveMinStar.click();
    });

    expect(Array.from(container.querySelectorAll(".tf-pill")).map((el) => el.textContent)).not.toContain("5m");
  });

  it("clicking the backdrop closes the dropdown without selecting anything", async () => {
    const { container, onTimeframeSelect } = await render(60_000);
    await openDropdown(container);
    expect(container.querySelector(".tf-menu-popover")).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLDivElement>(".menu-backdrop")!.click();
    });

    expect(container.querySelector(".tf-menu-popover")).toBeNull();
    expect(onTimeframeSelect).not.toHaveBeenCalled();
  });

  it("Escape closes the dropdown and restores focus to its trigger", async () => {
    const { container } = await render(60_000);
    const trigger = container.querySelector<HTMLButtonElement>(".tf-menu-trigger")!;
    await openDropdown(container);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelector(".tf-menu-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("favorites persist across a remount (localStorage), not just within the current session", async () => {
    const { container: first } = await render(60_000);
    await openDropdown(first);
    const twoMinStar = first.querySelectorAll(".tf-menu-row")[1].querySelector<HTMLButtonElement>(".tf-menu-star")!;
    await act(async () => {
      twoMinStar.click();
    });

    const { container: second } = await render(60_000);
    expect(Array.from(second.querySelectorAll(".tf-pill")).map((el) => el.textContent)).toContain("2m");
  });

  it("cannot unfavorite the last remaining favorite -- the quick row never goes empty from starring alone", async () => {
    const { container } = await render(60_000);
    await openDropdown(container);

    // Unfavorite every default favorite one by one.
    for (const label of ["1m", "5m", "15m", "1h", "4h", "1D"]) {
      const row = Array.from(container.querySelectorAll(".tf-menu-row")).find(
        (r) => r.querySelector(".tf-menu-row-select")?.textContent === label,
      )!;
      const star = row.querySelector<HTMLButtonElement>(".tf-menu-star")!;
      if (star.getAttribute("aria-pressed") === "true") {
        await act(async () => {
          star.click();
        });
      }
    }

    // At least one favorite must have survived the guard.
    const stillFavorited = Array.from(container.querySelectorAll(".tf-menu-star")).filter(
      (el) => el.getAttribute("aria-pressed") === "true",
    );
    expect(stillFavorited.length).toBeGreaterThanOrEqual(1);
  });

  it("a corrupted localStorage value falls back to the defaults instead of throwing", async () => {
    localStorage.setItem("terminal.timeframe.favorites", "not valid json{{{");
    await expect(render(60_000)).resolves.not.toThrow();
  });

  it("uses a separate option set and favorites key without changing the live menu", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onTimeframeSelect = vi.fn();
    await act(async () => {
      root.render(
        <TimeframeMenu
          selectedId="1M"
          onTimeframeSelect={onTimeframeSelect}
          options={[
            { id: "1D", label: "1D" },
            { id: "1W", label: "1W" },
            { id: "1M", label: "1M" },
          ]}
          favoriteStorageKey="terminal.historical-timeframe.favorites"
          defaultFavoriteIds={["1D", "1M"]}
        />,
      );
    });
    mountedRoots.push({ root, container });
    await openDropdown(container);
    expect(Array.from(container.querySelectorAll(".tf-menu-row-select")).map((row) => row.textContent))
      .toEqual(["1D", "1W", "1M"]);
    const monthly = Array.from(container.querySelectorAll<HTMLButtonElement>(".tf-menu-row-select"))
      .find((button) => button.textContent === "1M")!;
    await act(async () => monthly.click());
    expect(onTimeframeSelect).toHaveBeenCalledWith("1M");
    expect(localStorage.getItem("terminal.timeframe.favorites")).toBeNull();
    expect(localStorage.getItem("terminal.historical-timeframe.favorites")).toBe(JSON.stringify(["1D", "1M"]));
  });
});
