import { describe, expect, it } from "vitest";
import { shownTooltips, type TooltipPresence } from "../tooltipPriority";

const KINDS = ["whale", "absorption", "iceberg", "exhaustion", "initiative", "bubble", "wall", "bookMap", "whaleHeatmap", "pivot", "fvg", "sessionLevel"] as const;

function every(): TooltipPresence[] {
  return Array.from({ length: 1 << KINDS.length }, (_, mask) =>
    Object.fromEntries(KINDS.map((kind, bit) => [kind, (mask & (1 << bit)) !== 0])) as unknown as TooltipPresence,
  );
}

function only(over: Partial<TooltipPresence>): TooltipPresence {
  return { whale: false, absorption: false, iceberg: false, exhaustion: false, initiative: false, bubble: false, wall: false, bookMap: false, whaleHeatmap: false, pivot: false, fvg: false, sessionLevel: false, ...over };
}

describe("shownTooltips", () => {
  it("shows an exhaustion box's card under a whale or an absorption sphere, and changes no other card's rule", () => {
    expect(shownTooltips(only({ exhaustion: true }))).toMatchObject({ exhaustion: true });
    expect(shownTooltips(only({ exhaustion: true, whale: true }))).toMatchObject({ exhaustion: false, whale: true });
    expect(shownTooltips(only({ exhaustion: true, absorption: true }))).toMatchObject({ exhaustion: false, absorption: true });
    for (const present of every()) {
      const shown = shownTooltips(present);
      expect(shown.exhaustion).toBe(present.exhaustion && !present.whale && !present.absorption);
      const without = shownTooltips({ ...present, exhaustion: false });
      for (const kind of KINDS) if (kind !== "exhaustion") expect(shown[kind]).toBe(without[kind]);
    }
  });

  it("shows an initiative band's card under a whale or an absorption sphere, and changes no other card's rule", () => {
    expect(shownTooltips(only({ initiative: true }))).toMatchObject({ initiative: true });
    expect(shownTooltips(only({ initiative: true, whale: true }))).toMatchObject({ initiative: false, whale: true });
    expect(shownTooltips(only({ initiative: true, absorption: true }))).toMatchObject({ initiative: false, absorption: true });
    for (const present of every()) {
      const shown = shownTooltips(present);
      expect(shown.initiative).toBe(present.initiative && !present.whale && !present.absorption);
      const without = shownTooltips({ ...present, initiative: false });
      for (const kind of KINDS) if (kind !== "initiative") expect(shown[kind]).toBe(without[kind]);
    }
  });

  it("shows an iceberg's card under a whale or an absorption sphere, and changes no other card's rule", () => {
    expect(shownTooltips(only({ iceberg: true }))).toMatchObject({ iceberg: true });
    expect(shownTooltips(only({ iceberg: true, whale: true }))).toMatchObject({ iceberg: false, whale: true });
    expect(shownTooltips(only({ iceberg: true, absorption: true }))).toMatchObject({ iceberg: false, absorption: true });
    for (const present of every()) {
      const shown = shownTooltips(present);
      expect(shown.iceberg).toBe(present.iceberg && !present.whale && !present.absorption);
      const without = shownTooltips({ ...present, iceberg: false });
      for (const kind of KINDS) if (kind !== "iceberg") expect(shown[kind]).toBe(without[kind]);
    }
  });

  it("lets an FVG zone or a pivot under the cursor win over the Book Map cell behind it, so two cards never stack", () => {
    expect(shownTooltips(only({ bookMap: true, fvg: true }))).toMatchObject({ bookMap: false, fvg: true });
    expect(shownTooltips(only({ bookMap: true, pivot: true }))).toMatchObject({ bookMap: false, pivot: true });
    expect(shownTooltips(only({ bookMap: true })).bookMap).toBe(true);
    for (const present of every()) {
      const shown = shownTooltips(present);
      expect(shown.bookMap && (shown.fvg || shown.pivot || shown.sessionLevel)).toBe(false);
    }
  });

  it("shows a session level's card like an FVG's: over the Book Map, under a whale, a wall, an absorption sphere, a bubble or an FVG zone", () => {
    expect(shownTooltips(only({ bookMap: true, sessionLevel: true }))).toMatchObject({ bookMap: false, sessionLevel: true });
    for (const present of every()) {
      const shown = shownTooltips(present);
      expect(shown.sessionLevel).toBe(present.sessionLevel && !present.whale && !present.wall && !present.absorption && !present.bubble && !present.fvg);
    }
  });

  it("shows a whale heatmap wall's card like the Book Map's, and over the Book Map cell behind it, so the two never stack", () => {
    expect(shownTooltips(only({ whaleHeatmap: true }))).toMatchObject({ whaleHeatmap: true });
    expect(shownTooltips(only({ whaleHeatmap: true, bookMap: true }))).toMatchObject({ whaleHeatmap: true, bookMap: false });
    expect(shownTooltips(only({ whaleHeatmap: true, wall: true }))).toMatchObject({ whaleHeatmap: false, wall: true });
    expect(shownTooltips(only({ whaleHeatmap: true, pivot: true }))).toMatchObject({ whaleHeatmap: false, pivot: true });
    expect(shownTooltips(only({ whaleHeatmap: true, fvg: true }))).toMatchObject({ whaleHeatmap: false, fvg: true });
    expect(shownTooltips(only({ whaleHeatmap: true, sessionLevel: true }))).toMatchObject({ whaleHeatmap: false, sessionLevel: true });
    for (const present of every()) {
      const shown = shownTooltips(present);
      expect(shown.whaleHeatmap).toBe(present.whaleHeatmap && !present.wall && !present.fvg && !present.pivot && !present.sessionLevel);
      expect(shown.whaleHeatmap && shown.bookMap).toBe(false);
    }
  });

  it("keeps every other rule the chart already had", () => {
    for (const present of every()) {
      const shown = shownTooltips(present);
      expect(shown.whale).toBe(present.whale);
      expect(shown.absorption).toBe(present.absorption);
      expect(shown.bubble).toBe(present.bubble);
      expect(shown.wall).toBe(present.wall);
      expect(shown.pivot).toBe(present.pivot && !present.whale);
      expect(shown.fvg).toBe(present.fvg && !present.whale && !present.wall && !present.absorption);
      if (!present.fvg && !present.pivot && !present.sessionLevel && !present.whaleHeatmap) expect(shown.bookMap).toBe(present.bookMap && !present.wall);
    }
  });
});
