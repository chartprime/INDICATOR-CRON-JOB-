import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_WINDOW_MS,
  WHOLE_WINDOW,
  WINDOW_SPAN_MS,
  WINDOW_STORAGE_KEY,
  WINDOW_THUMB_PX,
  WINDOW_TICK_MS,
  isWindow,
  loadWindow,
  originOf,
  saveWindow,
  windowBounds,
  windowCut,
  windowFor,
  windowFromMinutes,
  windowToMinutes,
} from "../liveRangeWindow";

const START = Date.UTC(2026, 9, 16, 2, 35, 20);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function memoryStorage(seed: Record<string, string> = {}): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the live range window", () => {
  it("is whole by default: from seven days ago, as far as the host keeps its columns, to now, following the clock", () => {
    expect(WHOLE_WINDOW).toEqual({ fromMs: null, toMs: null });
    expect(Object.isFrozen(WHOLE_WINDOW)).toBe(true);
    expect(MIN_WINDOW_MS).toBe(MINUTE);
    expect(WINDOW_TICK_MS).toBe(1_000);
    expect(WINDOW_SPAN_MS).toBe(7 * 24 * HOUR);
  });

  it("bounds the whole window at the start with no end, and keeps two chosen handles as they are", () => {
    const now = START + 30 * MINUTE;
    expect(windowBounds(START, WHOLE_WINDOW, now)).toEqual({ fromMs: START, toMs: null });
    expect(windowBounds(START, { fromMs: START + 5 * MINUTE, toMs: START + 10 * MINUTE }, now)).toEqual({ fromMs: START + 5 * MINUTE, toMs: START + 10 * MINUTE });
    expect(windowBounds(START, { fromMs: START + 5 * MINUTE, toMs: null }, now)).toEqual({ fromMs: START + 5 * MINUTE, toMs: null });
  });

  it("never reaches before the start, never past now, and always keeps at least a minute between the handles", () => {
    const now = START + 30 * MINUTE;
    expect(windowBounds(START, { fromMs: START - MINUTE, toMs: null }, now)).toEqual({ fromMs: START, toMs: null });
    expect(windowBounds(START, { fromMs: null, toMs: now + MINUTE }, now)).toEqual({ fromMs: START, toMs: now });
    expect(windowBounds(START, { fromMs: START + 10 * MINUTE, toMs: START + 10 * MINUTE + 30_000 }, now)).toEqual({ fromMs: START + 9 * MINUTE + 30_000, toMs: START + 10 * MINUTE + 30_000 });
    expect(windowBounds(START, { fromMs: START + 20_000, toMs: START + 30_000 }, now)).toEqual({ fromMs: START, toMs: START + MINUTE });
    expect(windowBounds(START, { fromMs: now - 20_000, toMs: null }, now)).toEqual({ fromMs: now - MINUTE, toMs: null });
    expect(windowBounds(START, { fromMs: START + 20_000, toMs: null }, START + 30_000)).toEqual({ fromMs: START, toMs: null });
  });

  it("maps the window onto whole minutes since the start for a slider whose far end is now", () => {
    const now = START + 22 * MINUTE + 40_000;
    expect(windowToMinutes(START, WHOLE_WINDOW, now)).toEqual({ from: 0, to: 23, max: 23 });
    expect(windowToMinutes(START, { fromMs: START + 5 * MINUTE + 20_000, toMs: START + 10 * MINUTE + 40_000 }, now)).toEqual({ from: 5, to: 11, max: 23 });
    expect(windowToMinutes(START, { fromMs: START + 5 * MINUTE, toMs: null }, now)).toEqual({ from: 5, to: 23, max: 23 });
    expect(windowToMinutes(START, WHOLE_WINDOW, START + 10_000)).toEqual({ from: 0, to: 1, max: 1 });
    expect(windowToMinutes(START, WHOLE_WINDOW, START)).toEqual({ from: 0, to: 1, max: 1 });
    expect(windowToMinutes(START, WHOLE_WINDOW, START - 30_000)).toEqual({ from: 0, to: 1, max: 1 });
    expect(windowToMinutes(START, { fromMs: START + 40 * MINUTE, toMs: START + 50 * MINUTE }, now)).toEqual({ from: 22, to: 23, max: 23 });
  });

  it("reads the slider back: minute 0 is the start, the far end is now following the clock, and the handles stay a minute apart", () => {
    expect(windowFromMinutes(START, 0, 23, 23)).toEqual(WHOLE_WINDOW);
    expect(windowFromMinutes(START, 5, 11, 23)).toEqual({ fromMs: START + 5 * MINUTE, toMs: START + 11 * MINUTE });
    expect(windowFromMinutes(START, 5, 23, 23)).toEqual({ fromMs: START + 5 * MINUTE, toMs: null });
    expect(windowFromMinutes(START, 0, 11, 23)).toEqual({ fromMs: null, toMs: START + 11 * MINUTE });
    expect(windowFromMinutes(START, 11, 11, 23)).toEqual({ fromMs: START + 10 * MINUTE, toMs: START + 11 * MINUTE });
    expect(windowFromMinutes(START, 23, 23, 23)).toEqual({ fromMs: START + 22 * MINUTE, toMs: null });
    expect(windowFromMinutes(START, -3, 40, 23)).toEqual(WHOLE_WINDOW);
    expect(windowFromMinutes(START, 0, 0, 23)).toEqual({ fromMs: null, toMs: START + MINUTE });
  });
});

describe("the slider's seven days", () => {
  it("starts the slider seven days before now, on the whole minute", () => {
    expect(originOf(Date.UTC(2026, 9, 17, 2, 35, 20))).toBe(Date.UTC(2026, 9, 10, 2, 35));
    expect(originOf(Date.UTC(2026, 9, 17, 2, 35))).toBe(Date.UTC(2026, 9, 10, 2, 35));
    expect(originOf(Date.UTC(2026, 9, 17, 2, 35, 59, 999))).toBe(Date.UTC(2026, 9, 10, 2, 35));
    expect(originOf(Date.UTC(2026, 9, 17, 2, 36))).toBe(Date.UTC(2026, 9, 10, 2, 36));
  });

  it("spans the last seven days in minutes: minute 0 is seven days ago and the far end is now", () => {
    const now = Date.UTC(2026, 9, 17, 2, 35, 20);
    const origin = originOf(now);
    expect(windowToMinutes(origin, WHOLE_WINDOW, now)).toEqual({ from: 0, to: 10_081, max: 10_081 });
    const onMinute = Date.UTC(2026, 9, 17, 2, 35);
    expect(windowToMinutes(originOf(onMinute), WHOLE_WINDOW, onMinute)).toEqual({ from: 0, to: 10_080, max: 10_080 });
    expect(windowFromMinutes(origin, 10_021, 10_081, 10_081)).toEqual({ fromMs: Date.UTC(2026, 9, 17, 1, 36), toMs: null });
    expect(windowBounds(origin, WHOLE_WINDOW, now)).toEqual({ fromMs: Date.UTC(2026, 9, 10, 2, 35), toMs: null });
  });

  it("keeps a chosen start at the same clock time while the seven days move on, and holds it at their edge once it falls out", () => {
    const now = Date.UTC(2026, 9, 17, 2, 35, 20);
    const start = Date.UTC(2026, 9, 16, 14, 0);
    const window = { fromMs: start, toMs: null };
    expect(windowBounds(originOf(now), window, now)).toEqual({ fromMs: start, toMs: null });
    const later = now + 6 * HOUR;
    expect(windowBounds(originOf(later), window, later)).toEqual({ fromMs: start, toMs: null });
    expect(windowToMinutes(originOf(later), window, later).from).toBe(6 * 1_440 + 325);
    const tooLate = Date.UTC(2026, 9, 23, 15, 0, 20);
    expect(windowBounds(originOf(tooLate), window, tooLate)).toEqual({ fromMs: Date.UTC(2026, 9, 16, 15, 0), toMs: null });
  });

  it("in Live drops a chosen end, so the window runs from its start until now, while the other modes keep both handles", () => {
    const fixed = { fromMs: 1_000_000, toMs: 2_000_000 };
    expect(windowFor("live", fixed)).toEqual({ fromMs: 1_000_000, toMs: null });
    expect(fixed).toEqual({ fromMs: 1_000_000, toMs: 2_000_000 });
    expect(windowFor("selected", fixed)).toBe(fixed);
    expect(windowFor("visible", fixed)).toBe(fixed);
    const open = { fromMs: 1_000_000, toMs: null };
    expect(windowFor("live", open)).toBe(open);
    expect(windowFor("live", WHOLE_WINDOW)).toBe(WHOLE_WINDOW);
  });
});

describe("the window kept across reloads", () => {
  it("knows a window: two moments or nulls, whole milliseconds above zero, the start before the end", () => {
    expect(isWindow({ fromMs: null, toMs: null })).toBe(true);
    expect(isWindow({ fromMs: 5, toMs: null })).toBe(true);
    expect(isWindow({ fromMs: null, toMs: 5 })).toBe(true);
    expect(isWindow({ fromMs: 5, toMs: 6 })).toBe(true);
    expect(isWindow({ fromMs: 1, toMs: null })).toBe(true);
    expect(isWindow({ fromMs: 6, toMs: 6 })).toBe(false);
    expect(isWindow({ fromMs: 7, toMs: 6 })).toBe(false);
    expect(isWindow({ fromMs: 0, toMs: null })).toBe(false);
    expect(isWindow({ fromMs: null, toMs: 0 })).toBe(false);
    expect(isWindow({ fromMs: -5, toMs: null })).toBe(false);
    expect(isWindow({ fromMs: 5.5, toMs: null })).toBe(false);
    expect(isWindow({ fromMs: null, toMs: 5.5 })).toBe(false);
    expect(isWindow({ fromMs: Number.NaN, toMs: null })).toBe(false);
    expect(isWindow({ fromMs: 2 ** 60, toMs: null })).toBe(false);
    expect(isWindow({ fromMs: "5", toMs: null })).toBe(false);
    expect(isWindow({ fromMs: null })).toBe(false);
    expect(isWindow({ toMs: null })).toBe(false);
    expect(isWindow({})).toBe(false);
    expect(isWindow(null)).toBe(false);
    expect(isWindow(undefined)).toBe(false);
    expect(isWindow("window")).toBe(false);
    expect(isWindow(5)).toBe(false);
  });

  it("keeps one window for every instrument under one key, and forgets it when the window is whole again", () => {
    expect(WINDOW_STORAGE_KEY).toBe("terminal.live-range-control.window.v1");
    const storage = memoryStorage();
    saveWindow({ fromMs: 1_000_000, toMs: null }, storage);
    expect([...storage.data.entries()]).toEqual([[WINDOW_STORAGE_KEY, JSON.stringify({ fromMs: 1_000_000, toMs: null })]]);
    expect(loadWindow(storage)).toStrictEqual({ fromMs: 1_000_000, toMs: null });
    saveWindow({ fromMs: null, toMs: 2_000_000 }, storage);
    expect(loadWindow(storage)).toStrictEqual({ fromMs: null, toMs: 2_000_000 });
    saveWindow({ fromMs: 1_000_000, toMs: 2_000_000 }, storage);
    expect(loadWindow(storage)).toStrictEqual({ fromMs: 1_000_000, toMs: 2_000_000 });
    saveWindow(WHOLE_WINDOW, storage);
    expect(storage.data.size).toBe(0);
    expect(loadWindow(storage)).toBe(WHOLE_WINDOW);
  });

  it("reads the whole window from nothing stored, a broken entry, a wrong shape or a storage that throws, and only the two moments of a good entry", () => {
    const stored = (text: string) => memoryStorage({ [WINDOW_STORAGE_KEY]: text });
    expect(loadWindow(memoryStorage())).toBe(WHOLE_WINDOW);
    expect(loadWindow(stored("{"))).toBe(WHOLE_WINDOW);
    expect(loadWindow(stored(JSON.stringify({ fromMs: 5, toMs: 4 })))).toBe(WHOLE_WINDOW);
    expect(loadWindow(stored("null"))).toBe(WHOLE_WINDOW);
    expect(loadWindow(stored(JSON.stringify({ fromMs: 5, toMs: null, extra: 1 })))).toStrictEqual({ fromMs: 5, toMs: null });
    const throwing: Storage = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadWindow(throwing)).toBe(WHOLE_WINDOW);
    expect(loadWindow(null)).toBe(WHOLE_WINDOW);
  });

  it("never throws when the storage refuses a write, and does nothing without a storage", () => {
    const refusing: Storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveWindow({ fromMs: 5, toMs: null }, refusing)).not.toThrow();
    expect(() => saveWindow(WHOLE_WINDOW, refusing)).not.toThrow();
    expect(() => saveWindow({ fromMs: 5, toMs: null }, null)).not.toThrow();
  });

  it("uses the browser storage when it is given none", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    saveWindow({ fromMs: 5, toMs: null });
    expect(storage.data.get(WINDOW_STORAGE_KEY)).toBe(JSON.stringify({ fromMs: 5, toMs: null }));
    expect(loadWindow()).toStrictEqual({ fromMs: 5, toMs: null });
  });

  it("reads the whole window and writes nothing where the browser has no storage or will not let it be reached", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadWindow()).toBe(WHOLE_WINDOW);
    expect(() => saveWindow({ fromMs: 5, toMs: null })).not.toThrow();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(loadWindow()).toBe(WHOLE_WINDOW);
      expect(() => saveWindow({ fromMs: 5, toMs: null })).not.toThrow();
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("the cut between the two layered handles", () => {
  it("cuts the end handle at the middle between the two thumbs, moved onto the nearest whole device pixel", () => {
    expect(WINDOW_THUMB_PX).toBe(8);
    expect(windowCut({ left: 100, width: 216 }, 0.2, 0.7, 1)).toBe(98);
    expect(windowCut({ left: 100.4, width: 216 }, 0.2, 0.7, 1)).toBeCloseTo(97.6, 9);
    expect(windowCut({ left: 100.4, width: 216 }, 0.2, 0.7, 2)).toBeCloseTo(98.1, 9);
    expect(windowCut({ left: 100.4, width: 216 }, 0.2, 0.7, 1.5)).toBeCloseTo(298 / 1.5 - 100.4, 9);
    expect(windowCut({ left: 0, width: 216 }, 0.5, 0.5, 1)).toBe(108);
    expect(windowCut({ left: 0, width: 216 }, 0, 1, 1)).toBe(108);
    expect(windowCut({ left: 0, width: 216 }, 0.9, 1, 1)).toBe(198);
  });

  it("reads a missing or broken pixel ratio as one", () => {
    expect(windowCut({ left: 100.4, width: 216 }, 0.2, 0.7, 0)).toBeCloseTo(97.6, 9);
    expect(windowCut({ left: 100.4, width: 216 }, 0.2, 0.7, Number.NaN)).toBeCloseTo(97.6, 9);
    expect(windowCut({ left: 100.4, width: 216 }, 0.2, 0.7, -2)).toBeCloseTo(97.6, 9);
  });

  it("has no cut while the slider has no width to measure, so the stylesheet places it", () => {
    expect(windowCut({ left: 0, width: 0 }, 0.2, 0.7, 1)).toBeNull();
    expect(windowCut({ left: 0, width: 16 }, 0.2, 0.7, 1)).toBeNull();
    expect(windowCut({ left: 0, width: 17 }, 0.2, 0.7, 1)).toBe(8);
  });
});
