import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
  LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
  loadHistoricalIndicatorPreferences,
  saveHistoricalIndicatorPreferences,
} from "./historicalIndicatorPreferences";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
  shippedSessionProfilePalette,
  type SessionProfileIndicatorSettings,
} from "../indicators/session-profile/sessionProfileSettings";
import { SESSION_PROFILE_INDICATOR_ID } from "../indicators/session-profile/sessionProfileIds";
import { DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS } from "../indicators/cvd-divergence/cvdDivergenceIndicator";
import {
  DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
  volumeDeltaProfileTickIndicator,
} from "../indicators/volume-delta-profile-tick/volumeDeltaProfileTick";
import { volumeDeltaProfileOhlcIndicator } from "../indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlc";
import { DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS } from "../indicators/volume-delta-profile-ohlc/volumeDeltaProfileOhlcSettings";
import { DEFAULT_SESSION_LEVELS_SETTINGS } from "../indicators/session-levels/sessionLevelsRules";
import { DEFAULT_SESSION_DELTA_PROFILE_INDICATOR_SETTINGS } from "../indicators/session-delta-profile/sessionDeltaProfileIndicator";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage());
});

describe("historical indicator preferences", () => {
  it("keeps historical settings, visibility, and killzones separate from live preferences", () => {
    saveHistoricalIndicatorPreferences({
      visibility: { sma: false },
      runtimeSettingsById: { sma: { length: 40, color: "purple" } },
      killzoneSessions: new Set(["asia", "nyam"]),
    });
    expect(loadHistoricalIndicatorPreferences()).toEqual({
      visibility: { sma: false },
      runtimeSettingsById: { sma: { length: 40, color: "purple" } },
      killzoneSessions: new Set(["asia", "nyam"]),
    });
  });

  it("keeps a checkbox-list choice held as a set, such as Session Levels' sessions, across a save and a load", () => {
    saveHistoricalIndicatorPreferences({
      visibility: {},
      runtimeSettingsById: { sessionLevels: { ...DEFAULT_SESSION_LEVELS_SETTINGS, sessions: new Set(["asia"]), windows: new Set([5]) } },
      killzoneSessions: new Set(),
    });
    const stored = JSON.parse(localStorage.getItem(HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY)!);
    expect(stored.runtimeSettingsById.sessionLevels.sessions).toEqual(["asia"]);
    expect(stored.runtimeSettingsById.sessionLevels.windows).toEqual([5]);
    const loaded = loadHistoricalIndicatorPreferences().runtimeSettingsById.sessionLevels as typeof DEFAULT_SESSION_LEVELS_SETTINGS;
    expect(loaded.sessions).toEqual(new Set(["asia"]));
    expect(loaded.windows).toEqual(new Set([5]));
  });

  it("keeps Session Delta Profile's POC and value-area settings across a save and a load", () => {
    const settings = { ...DEFAULT_SESSION_DELTA_PROFILE_INDICATOR_SETTINGS, showBuyPoc: false, sellPocStyle: "dotted", vahValColor: "#ffff00", showValueAreaLines: false };
    saveHistoricalIndicatorPreferences({ visibility: {}, runtimeSettingsById: { sessionDeltaProfile: settings }, killzoneSessions: new Set() });
    expect(loadHistoricalIndicatorPreferences().runtimeSettingsById.sessionDeltaProfile).toMatchObject({ showBuyPoc: false, sellPocStyle: "dotted", vahValColor: "#ffff00", showValueAreaLines: false });
  });

  it("rejects malformed, unknown, and out-of-range stored settings", () => {
    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        visibility: { sma: "no", unknown: false },
        runtimeSettingsById: {
          sma: { length: 501, color: 7, injected: true },
          deltaDivergence: { swingLength: 80 },
          unknown: { value: 1 },
        },
        killzoneSessions: ["asia", "unknown"],
      }),
    );
    expect(loadHistoricalIndicatorPreferences()).toEqual({
      visibility: {},
      runtimeSettingsById: {
        sma: { length: 20, color: "purple" },
        deltaDivergence: { swingLength: 3 },
      },
      killzoneSessions: new Set(["asia"]),
    });
  });

  it("reads a pre-merge workspace through to Session Volume Profile", () => {
    // Volume Profile, Net Delta Profile and Delta Profile are one indicator
    // with a view selector now, so a workspace saved before the merge keeps the
    // session config the trader chose, the delta view and palette they had
    // customized, and their hidden/shown state.
    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        visibility: { volumeProfile: true, deltaProfile: false },
        runtimeSettingsById: {
          volumeProfile: {
            mode: "per_candle",
            periodMs: 15 * 60 * 1000,
            binSizeMultiplier: 3,
          },
          deltaProfile: { buyColor: "#123456", vahValStyle: "dotted" },
        },
      }),
    );
    const restored = loadHistoricalIndicatorPreferences();
    expect(restored.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toEqual({
      ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
      ...shippedSessionProfilePalette("deltaProfile"),
      view: "deltaProfile",
      mode: "per_candle",
      periodMs: 15 * 60 * 1000,
      binSizeMultiplier: 3,
      buyColor: "#123456",
      vahValStyle: "dotted",
    });
    // Shown in one legacy entry, so shown here as well.
    expect(restored.visibility).toEqual({
      [SESSION_PROFILE_INDICATOR_ID]: true,
    });
  });

  it("carries a hidden legacy profile across even when its settings were never opened", () => {
    // Toggling an indicator records its visibility; only editing its settings
    // writes a runtimeSettingsById entry, so most workspaces have none.
    localStorage.setItem(
      LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ visibility: { volumeProfile: false }, runtimeSettingsById: {} }),
    );
    localStorage.setItem("terminal.indicators.favorites", JSON.stringify(["volumeProfile"]));
    const restored = loadHistoricalIndicatorPreferences(
      LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
      "terminal.indicators.favorites",
    );
    expect(restored.visibility).toEqual({ [SESSION_PROFILE_INDICATOR_ID]: false });
    expect(restored.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toEqual(
      DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
    );
    // Without the favourites to go by, the recorded visibility still counts.
    expect(
      loadHistoricalIndicatorPreferences(LIVE_INDICATOR_PREFERENCES_STORAGE_KEY).visibility,
    ).toEqual({ [SESSION_PROFILE_INDICATOR_ID]: false });
  });

  it("opens on the view the trader had on the chart, in that view's own colours", () => {
    // Net Delta Profile was the one added, never customized; Volume Profile's
    // session config was saved from some earlier use and must not decide the view.
    localStorage.setItem(
      LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        visibility: {},
        runtimeSettingsById: {
          volumeProfile: { mode: "continuous", periodMs: 3_600_000, binSizeMultiplier: 2 },
        },
      }),
    );
    localStorage.setItem("terminal.indicators.favorites", JSON.stringify(["netDeltaProfile"]));
    const restored = loadHistoricalIndicatorPreferences(
      LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
      "terminal.indicators.favorites",
    );
    expect(restored.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toEqual({
      ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
      ...shippedSessionProfilePalette("netDeltaProfile"),
      view: "netDeltaProfile",
      mode: "continuous",
      periodMs: 3_600_000,
      binSizeMultiplier: 2,
    });
    expect(restored.visibility).toEqual({ [SESSION_PROFILE_INDICATOR_ID]: true });
  });

  it("prefers the legacy profile that was showing over one that was hidden, and migrates with no preferences saved yet", () => {
    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ visibility: { deltaProfile: false }, runtimeSettingsById: {} }),
    );
    localStorage.setItem(
      "terminal.historical-indicators.favorites",
      JSON.stringify(["deltaProfile", "volumeProfile"]),
    );
    const restored = loadHistoricalIndicatorPreferences(
      undefined,
      "terminal.historical-indicators.favorites",
    );
    expect(restored.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toMatchObject({
      view: "volumeProfile",
    });
    expect(restored.visibility).toEqual({ [SESSION_PROFILE_INDICATOR_ID]: true });

    localStorage.removeItem(HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY);
    localStorage.setItem("terminal.historical-indicators.favorites", JSON.stringify(["deltaProfile"]));
    const fresh = loadHistoricalIndicatorPreferences(
      undefined,
      "terminal.historical-indicators.favorites",
    );
    expect(fresh.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toMatchObject({
      view: "deltaProfile",
      ...shippedSessionProfilePalette("deltaProfile"),
    });
  });

  it("brings a CVD Divergence value saved under the old wider bounds to the nearest bound, and still drops an unflagged one", () => {
    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        visibility: {},
        runtimeSettingsById: {
          cvdDivergence: {
            period: 250,
            minPivotDistance: 0,
            maxPivotDistance: 300,
            cumulativeMaxPivotDistance: 450,
            oscillatorTrendFilterSmaLength: 200,
            pivotPeriods: 25,
          },
        },
      }),
    );
    const restored = loadHistoricalIndicatorPreferences().runtimeSettingsById.cvdDivergence;
    expect(restored).toMatchObject({
      period: 200,
      minPivotDistance: 1,
      maxPivotDistance: 100,
      cumulativeMaxPivotDistance: 100,
      oscillatorTrendFilterSmaLength: 100,
      pivotPeriods: DEFAULT_CVD_DIVERGENCE_INDICATOR_SETTINGS.pivotPeriods,
    });
  });

  it("leaves a workspace that already saved Session Volume Profile alone", () => {
    const chosen: SessionProfileIndicatorSettings = {
      ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
      view: "netDeltaProfile",
      buyColor: "#abcdef",
    };
    saveHistoricalIndicatorPreferences({
      visibility: { [SESSION_PROFILE_INDICATOR_ID]: false },
      runtimeSettingsById: { [SESSION_PROFILE_INDICATOR_ID]: chosen },
      killzoneSessions: new Set(),
    });
    const restored = loadHistoricalIndicatorPreferences();
    expect(restored.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toEqual(
      chosen,
    );
    expect(restored.visibility).toEqual({
      [SESSION_PROFILE_INDICATOR_ID]: false,
    });
  });

  it("a chosen bin size and value-area line style survive a save and reload, and out-of-range values fall back", () => {
    saveHistoricalIndicatorPreferences({
      visibility: {},
      runtimeSettingsById: {
        [SESSION_PROFILE_INDICATOR_ID]: {
          mode: "continuous",
          periodMs: 60 * 60 * 1000,
          binSizeMultiplier: 0.05,
          vahValStyle: "dotted",
        },
      },
      killzoneSessions: new Set(),
    });
    const restored = loadHistoricalIndicatorPreferences();
    expect(restored.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toMatchObject({
      binSizeMultiplier: 0.05,
      vahValStyle: "dotted",
    });

    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        runtimeSettingsById: {
          [SESSION_PROFILE_INDICATOR_ID]: {
            binSizeMultiplier: 0.01,
            vahValStyle: "wavy",
            view: "sideways",
          },
        },
      }),
    );
    const rejected = loadHistoricalIndicatorPreferences();
    expect(rejected.runtimeSettingsById[SESSION_PROFILE_INDICATOR_ID]).toMatchObject({
      binSizeMultiplier: 2,
      vahValStyle: "dashed",
      view: "volumeProfile",
    });
  });

  it("keeps the merged indicator's colours and line toggles across a save and reload", () => {
    const chosen: SessionProfileIndicatorSettings = {
      ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
      buyColor: "#123456",
      sellValueAreaColor: "#654321",
      showPocLine: false,
      valueAreaPercent: 0.8,
      vahValStyle: "dotted",
    };
    saveHistoricalIndicatorPreferences({
      visibility: {},
      runtimeSettingsById: { [SESSION_PROFILE_INDICATOR_ID]: chosen },
      killzoneSessions: new Set(),
    });
    expect(
      loadHistoricalIndicatorPreferences().runtimeSettingsById[
        SESSION_PROFILE_INDICATOR_ID
      ],
    ).toEqual(chosen);

    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        runtimeSettingsById: {
          [SESSION_PROFILE_INDICATOR_ID]: {
            buyColor: "",
            showPocLine: "false",
            valueAreaPercent: 2,
            vahValStyle: "wavy",
          },
        },
      }),
    );
    expect(
      loadHistoricalIndicatorPreferences().runtimeSettingsById[
        SESSION_PROFILE_INDICATOR_ID
      ],
    ).toEqual(DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS);
  });

  it("keeps Volume Profile (Ticks) settings, which have a bespoke modal and no generated form", () => {
    expect(volumeDeltaProfileTickIndicator.settingsSchema).toHaveLength(0);
    // A setting left out of the persistence schema is silently not saved, so the
    // list has to name every one of them.
    const named = (
      volumeDeltaProfileTickIndicator.persistenceSchema ?? []
    ).map((field) => (field.kind === "staticHint" ? "" : String(field.key)));
    expect(named.slice().sort()).toEqual(
      Object.keys(DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS).sort(),
    );
    const chosen = {
      ...DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS,
      buyColor: "#123456",
      binBorderVisible: false,
      binBorderOpacity: 0.5,
      profileWidth: 640,
      binCount: 350,
      pocLineWidth: 6,
      vahValPercent: 90,
      valLineStyle: "dotted" as const,
      vahValLineWidth: 7,
    };
    saveHistoricalIndicatorPreferences({
      visibility: {},
      runtimeSettingsById: { volumeDeltaProfileTick: chosen },
      killzoneSessions: new Set(),
    });
    expect(
      loadHistoricalIndicatorPreferences().runtimeSettingsById
        .volumeDeltaProfileTick,
    ).toEqual(chosen);

    // Values no control in that modal could have produced are not preferences:
    // an empty colour, a row count past its slider, a style it does not offer.
    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        runtimeSettingsById: {
          volumeDeltaProfileTick: {
            buyColor: "",
            binCount: 1501,
            profileWidth: 5,
            pocLineStyle: "wavy",
            vahValPercent: 100,
          },
        },
      }),
    );
    expect(
      loadHistoricalIndicatorPreferences().runtimeSettingsById
        .volumeDeltaProfileTick,
    ).toEqual(DEFAULT_VOLUME_DELTA_PROFILE_TICK_SETTINGS);
  });

  it("keeps Volume Profile OHLC settings, including the VAH/VAL thickness, across a save and reload", () => {
    expect(volumeDeltaProfileOhlcIndicator.settingsSchema).toHaveLength(0);
    // Every setting its modal can change is saved; the bin border colour has no
    // control there, so it stays the default rather than being restorable.
    const named = (
      volumeDeltaProfileOhlcIndicator.persistenceSchema ?? []
    ).map((field) => (field.kind === "staticHint" ? "" : String(field.key)));
    expect(named.slice().sort()).toEqual(
      Object.keys(DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS)
        .filter((key) => key !== "borderColor")
        .sort(),
    );
    const chosen = {
      ...DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS,
      sellColor: "#654321",
      profileWidth: 250,
      binCount: 400,
      pocVisible: false,
      vahValPercent: 80,
      vahLineStyle: "dotted" as const,
      vahValLineWidth: 7,
    };
    saveHistoricalIndicatorPreferences({
      visibility: {},
      runtimeSettingsById: { volumeDeltaProfileOhlc: chosen },
      killzoneSessions: new Set(),
    });
    expect(
      loadHistoricalIndicatorPreferences().runtimeSettingsById
        .volumeDeltaProfileOhlc,
    ).toEqual(chosen);

    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        runtimeSettingsById: {
          volumeDeltaProfileOhlc: {
            profileWidth: 310,
            binCount: 501,
            vahValLineWidth: 11,
            valLineStyle: "wavy",
          },
        },
      }),
    );
    expect(
      loadHistoricalIndicatorPreferences().runtimeSettingsById
        .volumeDeltaProfileOhlc,
    ).toEqual(DEFAULT_VOLUME_DELTA_PROFILE_OHLC_SETTINGS);
  });

  it("keeps CVD Divergence's trend filters across a save and reload", () => {
    const trendFilters = {
      oscillatorTrendFilterEnabled: true,
      oscillatorTrendFilterSmaLength: 30,
      oscillatorTrendFilterInverted: true,
      cumulativeTrendFilterEnabled: true,
      cumulativeTrendFilterSmaLength: 80,
      cumulativeTrendFilterInverted: false,
    };
    saveHistoricalIndicatorPreferences({
      visibility: {},
      runtimeSettingsById: { cvdDivergence: { period: 21, ...trendFilters } },
      killzoneSessions: new Set(),
    });
    expect(loadHistoricalIndicatorPreferences().runtimeSettingsById.cvdDivergence).toMatchObject(trendFilters);
  });

  it("drops a wall size and a hit size saved for the first order-blocks indicator, so the sizes are the instrument's own on every book", () => {
    // The sizes were one number for every instrument: a wall size typed on the ETH perp read every NQ zone as no wall,
    // rejected and hidden. The trader took the two fields off the menu on 2026-09-21; what was saved falls back to 0.
    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        runtimeSettingsById: {
          institutionalOrderBlocks: {
            wallSize: 600,
            hitSize: 300,
            showWeak: true,
          },
        },
      }),
    );
    expect(
      loadHistoricalIndicatorPreferences().runtimeSettingsById
        .institutionalOrderBlocks,
    ).toMatchObject({ wallSize: 0, hitSize: 0, showWeak: true });
  });

  it("remembers live settings, visibility, and killzones across a reload under their own key, apart from Historical Mode's", () => {
    saveHistoricalIndicatorPreferences(
      {
        visibility: { sma: true },
        runtimeSettingsById: { sma: { length: 55, color: "purple" } },
        killzoneSessions: new Set(["london"]),
      },
      LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
    );
    saveHistoricalIndicatorPreferences({
      visibility: { sma: false },
      runtimeSettingsById: { sma: { length: 40, color: "purple" } },
      killzoneSessions: new Set(["asia"]),
    });
    expect(
      loadHistoricalIndicatorPreferences(
        LIVE_INDICATOR_PREFERENCES_STORAGE_KEY,
      ),
    ).toEqual({
      visibility: { sma: true },
      runtimeSettingsById: { sma: { length: 55, color: "purple" } },
      killzoneSessions: new Set(["london"]),
    });
    expect(loadHistoricalIndicatorPreferences().runtimeSettingsById).toEqual({
      sma: { length: 40, color: "purple" },
    });
    expect(LIVE_INDICATOR_PREFERENCES_STORAGE_KEY).not.toBe(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
    );
  });

  it("falls back to defaults when storage is corrupted", () => {
    localStorage.setItem(
      HISTORICAL_INDICATOR_PREFERENCES_STORAGE_KEY,
      "not-json",
    );
    expect(loadHistoricalIndicatorPreferences().runtimeSettingsById).toEqual(
      {},
    );
    expect(
      loadHistoricalIndicatorPreferences().killzoneSessions.size,
    ).toBeGreaterThan(0);
  });
});
