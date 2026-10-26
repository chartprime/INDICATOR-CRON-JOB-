import { describe, expect, it, beforeEach, vi } from "vitest";
import { FAVORITES_STORAGE_KEY, loadIndicatorFavorites, saveIndicatorFavorites } from "../indicatorFavorites";

// Same Node-native-localStorage workaround as other component tests in this
// tree -- this environment's own global localStorage is present but
// non-functional, shadowing jsdom's real one.
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

describe("loadIndicatorFavorites / saveIndicatorFavorites", () => {
  it("round-trips a saved set through localStorage", () => {
    saveIndicatorFavorites(new Set(["rsi", "killzones"]));
    expect(loadIndicatorFavorites()).toEqual(new Set(["rsi", "killzones"]));
  });

  it("keeps Historical Mode favorites separate from the live workspace", () => {
    saveIndicatorFavorites(new Set(["rsi"]));
    saveIndicatorFavorites(new Set(["ema"]), "terminal.historical-indicators.favorites");
    expect(loadIndicatorFavorites()).toEqual(new Set(["rsi"]));
    expect(loadIndicatorFavorites("terminal.historical-indicators.favorites")).toEqual(new Set(["ema"]));
  });

  it("returns an empty set when nothing has been saved yet", () => {
    expect(loadIndicatorFavorites()).toEqual(new Set());
  });

  it("falls back to an empty set instead of throwing on corrupted JSON", () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, "not valid json{{{");
    expect(() => loadIndicatorFavorites()).not.toThrow();
    expect(loadIndicatorFavorites()).toEqual(new Set());
  });

  it("filters out ids that are no longer valid indicators", () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(["rsi", "some-removed-indicator"]));
    expect(loadIndicatorFavorites()).toEqual(new Set(["rsi"]));
  });

  it("returns an empty set when the stored value isn't an array", () => {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify({ rsi: true }));
    expect(loadIndicatorFavorites()).toEqual(new Set());
  });
});
