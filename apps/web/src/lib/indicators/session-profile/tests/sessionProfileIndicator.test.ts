import { describe, expect, it } from "vitest";
import { createIndicatorRuntime } from "../../../chart/indicatorRuntime";
import type { RuntimeIndicatorDef } from "../../../chart/indicatorTypes";
import { sessionProfileIndicator } from "../sessionProfileIndicator";
import {
  DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
  migrateLegacySessionProfileSettings,
  sessionProfileDeltaSettings,
  sessionProfileNetDeltaSettings,
  sessionProfileVolumeSettings,
  shippedSessionProfilePalette,
} from "../sessionProfileSettings";
import {
  MAX_BIN_SIZE_MULTIPLIER,
  MIN_BIN_SIZE_MULTIPLIER,
} from "../../volume-profile/profileSessionConfig";
import { SESSION_PROFILE_INDICATOR_ID } from "../sessionProfileIds";

describe("sessionProfileIndicator -- one indicator, three profile views", () => {
  it("registers under its own id, label and category", () => {
    expect(sessionProfileIndicator.kind).toBe("runtime");
    expect(sessionProfileIndicator.id).toBe(SESSION_PROFILE_INDICATOR_ID);
    expect(sessionProfileIndicator.label).toBe(
      "Session Volume Profile (Volume / Net Delta / Delta)",
    );
    expect(sessionProfileIndicator.category).toBe("l1");
  });

  it("offers the view as a dropdown of the three renderings", () => {
    const viewField = sessionProfileIndicator.settingsSchema!.find(
      (field) => field.kind === "select" && field.key === "view",
    ) as Extract<
      NonNullable<typeof sessionProfileIndicator.settingsSchema>[number],
      { kind: "select" }
    >;
    expect(viewField).toBeDefined();
    expect(viewField.label).toBe("View");
    expect(viewField.options.map((option) => option.value)).toEqual([
      "volumeProfile",
      "netDeltaProfile",
      "deltaProfile",
    ]);
  });

  it("keeps the session config, the shared palette and the level toggles in one schema", () => {
    const keys = sessionProfileIndicator
      .settingsSchema!.filter((field) => field.kind !== "staticHint")
      .map((field) => String(field.key))
      .sort();
    expect(keys).toEqual(
      Object.keys(DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS).sort(),
    );
  });

  it("only shows the value-area percent for the views that derive their own levels", () => {
    const field = sessionProfileIndicator.settingsSchema!.find(
      (item) => item.kind === "slider" && item.key === "valueAreaPercent",
    ) as Extract<
      NonNullable<typeof sessionProfileIndicator.settingsSchema>[number],
      { kind: "slider" }
    >;
    expect(field.visibleIf!({ ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS })).toBe(false);
    expect(
      field.visibleIf!({
        ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
        view: "netDeltaProfile",
      }),
    ).toBe(true);
    expect(
      field.visibleIf!({
        ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
        view: "deltaProfile",
      }),
    ).toBe(true);
  });

  it("offers the bin size as a slider spanning the range the session config allows", () => {
    const field = sessionProfileIndicator.settingsSchema!.find(
      (item) => item.kind === "slider" && item.key === "binSizeMultiplier",
    ) as Extract<
      NonNullable<typeof sessionProfileIndicator.settingsSchema>[number],
      { kind: "slider" }
    >;
    expect(field.label).toBe("Bin size");
    expect([field.min, field.max, field.step]).toEqual([
      MIN_BIN_SIZE_MULTIPLIER,
      MAX_BIN_SIZE_MULTIPLIER,
      0.01,
    ]);
    expect(field.affects).toBe("recompute");
  });

  it("defaults to the base view with Volume Profile's own palette, so the base view is unchanged", () => {
    expect(DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS).toMatchObject({
      view: "volumeProfile",
      mode: "continuous",
      periodMs: 4 * 60 * 60 * 1000,
      binSizeMultiplier: 2,
      buyColor: "#2acccc",
      buyValueAreaColor: "#28aadd",
      sellColor: "#ff5050",
      sellValueAreaColor: "#ff5050",
      pocColor: "#ff5050",
      vahValColor: "#0a0a0a",
      vahValStyle: "dashed",
      showPocLine: true,
      showValueAreaLines: true,
    });
  });

  it("is inert on bars -- the frame comes from the server, never from ctx.bar", () => {
    const state = sessionProfileIndicator.createState(
      DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
    );
    expect(state).toEqual({});
    sessionProfileIndicator.onBar({
      state,
      settings: DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
    } as unknown as Parameters<typeof sessionProfileIndicator.onBar>[0]);
    expect(sessionProfileIndicator.readOutput(state)).toEqual({});
    expect(sessionProfileIndicator.lines).toEqual([]);
    expect(sessionProfileIndicator.placement).toEqual({ kind: "overlay" });
  });

  it("passes the indicator runtime's own definition validation", () => {
    expect(() =>
      createIndicatorRuntime([
        sessionProfileIndicator as RuntimeIndicatorDef<unknown, unknown>,
      ]),
    ).not.toThrow();
  });
});

describe("session profile primitive settings", () => {
  const settings = {
    ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
    buyColor: "#111111",
    buyValueAreaColor: "#222222",
    sellColor: "#333333",
    sellValueAreaColor: "#444444",
    pocColor: "#555555",
    vahValColor: "#666666",
    valueAreaPercent: 0.6,
    vahValStyle: "dotted" as const,
    showPocLine: false,
    showValueAreaLines: false,
  };

  it("hands the volume view the palette's buy side as its bar colours", () => {
    expect(sessionProfileVolumeSettings(settings)).toMatchObject({
      outsideValueAreaColor: "#111111",
      valueAreaColor: "#222222",
      sellColor: "#333333",
      sellValueAreaColor: "#444444",
      pocColor: "#555555",
      vahValColor: "#666666",
      vahValStyle: "dotted",
      showPocLine: false,
      showValueAreaLines: false,
    });
  });

  it("hands both delta views the same palette and the value area percent", () => {
    for (const mapped of [
      sessionProfileNetDeltaSettings(settings),
      sessionProfileDeltaSettings(settings),
    ]) {
      expect(mapped).toMatchObject({
        buyColor: "#111111",
        buyValueAreaColor: "#222222",
        sellColor: "#333333",
        sellValueAreaColor: "#444444",
        pocColor: "#555555",
        vahValColor: "#666666",
        valueAreaPercent: 0.6,
        vahValStyle: "dotted",
        showPocLine: false,
        showValueAreaLines: false,
      });
    }
  });
});

describe("legacy profile migration", () => {
  it("maps the legacy Volume Profile session config and keeps the base view", () => {
    expect(
      migrateLegacySessionProfileSettings({
        volumeProfile: {
          mode: "per_candle",
          periodMs: 900_000,
          binSizeMultiplier: 4,
        },
      }),
    ).toEqual({
      ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
      mode: "per_candle",
      periodMs: 900_000,
      binSizeMultiplier: 4,
    });
  });

  it("takes the view and palette from the legacy entry that had one", () => {
    const migrated = migrateLegacySessionProfileSettings({
      volumeProfile: { mode: "continuous", periodMs: 3_600_000, binSizeMultiplier: 2 },
      deltaProfile: {
        buyColor: "#123456",
        sellValueAreaColor: "#654321",
        valueAreaPercent: 0.8,
        vahValStyle: "dotted",
        showPocLine: false,
      },
    });
    expect(migrated).toMatchObject({
      view: "deltaProfile",
      mode: "continuous",
      periodMs: 3_600_000,
      binSizeMultiplier: 2,
      buyColor: "#123456",
      sellValueAreaColor: "#654321",
      valueAreaPercent: 0.8,
      vahValStyle: "dotted",
      showPocLine: false,
    });
  });

  it("prefers Delta Profile over Net Delta Profile when both were customized", () => {
    expect(
      migrateLegacySessionProfileSettings({
        netDeltaProfile: { buyColor: "#111111" },
        deltaProfile: { buyColor: "#222222" },
      }).buyColor,
    ).toBe("#222222");
  });

  it("drops out-of-range legacy values instead of carrying them over", () => {
    const migrated = migrateLegacySessionProfileSettings({
      volumeProfile: { mode: "sideways", periodMs: 1, binSizeMultiplier: 99 },
      netDeltaProfile: {
        buyColor: "",
        showPocLine: "yes",
        valueAreaPercent: 4,
        vahValStyle: "wavy",
      },
    });
    expect(migrated).toEqual({
      ...DEFAULT_SESSION_PROFILE_INDICATOR_SETTINGS,
      ...shippedSessionProfilePalette("netDeltaProfile"),
      view: "netDeltaProfile",
    });
  });
});
