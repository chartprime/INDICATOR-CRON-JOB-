import { describe, expect, it } from "vitest";
import { CARD_MARGIN_PX, CARD_POSITION_STORAGE_KEY, clampCardPosition, isCardPosition, loadCardPosition, saveCardPosition } from "../cardPosition";

function storage(initial: Record<string, string> = {}): Storage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage & { values: Map<string, string> };
}

function withLocalStorage(descriptor: PropertyDescriptor, run: () => void) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor });
  try {
    run();
  } finally {
    if (before === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", before);
  }
}

describe("clampCardPosition", () => {
  const card = { width: 236, height: 120 };
  const pane = { width: 1_000, height: 600 };

  it("keeps the card inside the pane with a margin on every side, rounded to whole pixels", () => {
    expect(clampCardPosition({ x: 300.4, y: 200.6 }, card, pane)).toEqual({ x: 300, y: 201 });
    expect(clampCardPosition({ x: -50, y: -50 }, card, pane)).toEqual({ x: CARD_MARGIN_PX, y: CARD_MARGIN_PX });
    expect(clampCardPosition({ x: 5_000, y: 5_000 }, card, pane)).toEqual({ x: 1_000 - 236 - CARD_MARGIN_PX, y: 600 - 120 - CARD_MARGIN_PX });
  });

  it("pins the card to the corner when the pane is smaller than the card", () => {
    expect(clampCardPosition({ x: 100, y: 100 }, card, { width: 200, height: 100 })).toEqual({ x: 0, y: 0 });
  });
});

describe("the saved position", () => {
  it("is kept under the Live Range Control card's own key", () => {
    expect(CARD_POSITION_STORAGE_KEY).toBe("terminal.live-range-control.card-position.v1");
  });

  it("accepts only two finite non-negative numbers", () => {
    expect([isCardPosition({ x: 1, y: 2 }), isCardPosition({ x: 0, y: 0 })]).toEqual([true, true]);
    expect([isCardPosition(null), isCardPosition({ x: -1, y: 2 }), isCardPosition({ x: "1", y: 2 }), isCardPosition({ x: Infinity, y: 2 }), isCardPosition({ x: 1 })]).toEqual([false, false, false, false, false]);
  });

  it("round-trips through storage, forgets a broken entry, and a null removes it", () => {
    const store = storage();
    expect(loadCardPosition(store)).toBeNull();
    saveCardPosition({ x: 120, y: 40 }, store);
    expect(store.values.get(CARD_POSITION_STORAGE_KEY)).toBe('{"x":120,"y":40}');
    expect(loadCardPosition(store)).toEqual({ x: 120, y: 40 });
    saveCardPosition(null, store);
    expect(loadCardPosition(store)).toBeNull();
    expect(loadCardPosition(storage({ [CARD_POSITION_STORAGE_KEY]: "{bad" }))).toBeNull();
    expect(loadCardPosition(storage({ [CARD_POSITION_STORAGE_KEY]: '{"x":-3,"y":1}' }))).toBeNull();
  });

  it("survives a storage that throws, and no storage at all", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(loadCardPosition(broken)).toBeNull();
    expect(() => saveCardPosition({ x: 1, y: 1 }, broken)).not.toThrow();
    expect(loadCardPosition(null)).toBeNull();
    expect(() => saveCardPosition({ x: 1, y: 1 }, null)).not.toThrow();
  });

  it("turns down a y that is negative or not finite, and a value that is no object, without throwing", () => {
    expect([isCardPosition({ x: 1, y: -1 }), isCardPosition({ x: 1, y: Infinity }), isCardPosition({ x: 1, y: Number.NaN }), isCardPosition(undefined), isCardPosition(7)]).toEqual([false, false, false, false, false]);
  });

  it("reads back only the x and the y of what was saved", () => {
    expect(loadCardPosition(storage({ [CARD_POSITION_STORAGE_KEY]: '{"x":5,"y":6,"z":7}' }))).toEqual({ x: 5, y: 6 });
  });

  it("given no storage, keeps the position in the browser's local storage", () => {
    const local = storage();
    withLocalStorage({ value: local }, () => {
      saveCardPosition({ x: 12, y: 34 });
      expect(local.values.get(CARD_POSITION_STORAGE_KEY)).toBe('{"x":12,"y":34}');
      expect(loadCardPosition()).toEqual({ x: 12, y: 34 });
      saveCardPosition(null);
      expect(local.values.size).toBe(0);
      expect(loadCardPosition()).toBeNull();
    });
  });

  it("given a null storage, neither reads nor writes the browser's local storage", () => {
    const local = storage({ [CARD_POSITION_STORAGE_KEY]: '{"x":5,"y":6}' });
    withLocalStorage({ value: local }, () => {
      expect(loadCardPosition(null)).toBeNull();
      saveCardPosition({ x: 1, y: 1 }, null);
      saveCardPosition(null, null);
    });
    expect(local.values.size).toBe(1);
    expect(local.values.get(CARD_POSITION_STORAGE_KEY)).toBe('{"x":5,"y":6}');
  });

  it("survives a browser that refuses to hand over its local storage", () => {
    withLocalStorage({ get: () => { throw new DOMException("The operation is insecure.", "SecurityError"); } }, () => {
      expect(loadCardPosition()).toBeNull();
      expect(() => saveCardPosition({ x: 1, y: 1 })).not.toThrow();
      expect(() => saveCardPosition(null)).not.toThrow();
    });
  });
});
