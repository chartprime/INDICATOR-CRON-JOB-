import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../indicators/iceberg-detector/icebergSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../indicators/iceberg-detector/icebergSettings")>();
  return { ...actual, ICEBERG_MARK_SHAPES: Object.freeze([...actual.ICEBERG_MARK_SHAPES, ["square", "Square"]]) };
});

import { LIVE_INDICATOR_EXTRAS_STORAGE_KEY, defaultLiveIndicatorExtras, loadLiveIndicatorExtras } from "../liveIndicatorExtras";
import { DEFAULT_ICEBERG_SETTINGS } from "../../indicators/iceberg-detector/icebergSettings";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage());
});

describe("live indicator extras: iceberg mark shapes", () => {
  it("loads back any shape the dialog offers, so a shape added to the dialog needs no change in the loader", () => {
    localStorage.setItem(LIVE_INDICATOR_EXTRAS_STORAGE_KEY, JSON.stringify({ ...defaultLiveIndicatorExtras(), icebergByInstrument: { one: { ...DEFAULT_ICEBERG_SETTINGS, markShape: "square" } } }));
    expect(loadLiveIndicatorExtras().icebergByInstrument.one?.markShape).toBe("square");
  });
});
