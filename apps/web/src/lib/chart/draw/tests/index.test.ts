import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draw } from "../index";
import { resetDrawOwnerScopeForTests, withDrawOwnerScope } from "../creationScope";
import { resetStreamCreationGuardForTests } from "../../ta/creationGuard";
import { handlesForOwners, resetDrawRegistryForTests } from "../registry";

beforeEach(() => {
  resetStreamCreationGuardForTests();
});

afterEach(() => {
  resetDrawOwnerScopeForTests();
  resetDrawRegistryForTests();
});

describe("draw -- registers a real object when called inside a legitimate owner scope", () => {
  it("draw.line registers under the current owner id", () => {
    withDrawOwnerScope("rsi", () => {
      draw.line({ time1: 0, price1: 0, time2: 1, price2: 1 });
    });
    expect(handlesForOwners(["rsi"])).toHaveLength(1);
  });

  it("draw.box, draw.label, draw.polyline, draw.table each register under the current owner id", () => {
    withDrawOwnerScope("rsi", () => {
      draw.box({ time1: 0, price1: 0, time2: 1, price2: 1 });
      draw.label({ time: 0, price: 0 });
      draw.polyline({ points: [{ time: 0, price: 0 }, { time: 1, price: 1 }] });
      draw.table();
    });
    const kinds = handlesForOwners(["rsi"]).map((record) => record.kind).sort();
    expect(kinds).toEqual(["box", "label", "polyline", "table"]);
  });
});

describe("draw -- the persistence-footgun guard is wired through every factory", () => {
  const factoryArgs: Record<keyof typeof draw, unknown[]> = {
    line: [{ time1: 0, price1: 0, time2: 1, price2: 1 }],
    box: [{ time1: 0, price1: 0, time2: 1, price2: 1 }],
    label: [{ time: 0, price: 0 }],
    polyline: [{ points: [{ time: 0, price: 0 }] }],
    table: [],
  };

  it("covers every key actually exported on `draw` -- no factory left unchecked", () => {
    expect(Object.keys(factoryArgs).sort()).toEqual(Object.keys(draw).sort());
  });

  it("every factory logs the guard error, naming itself, when called outside a creation window", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const [name, args] of Object.entries(factoryArgs)) {
      error.mockClear();
      const factory = draw[name as keyof typeof draw] as (...a: unknown[]) => unknown;
      expect(() => factory(...args)).not.toThrow();
      expect(error, `draw.${name}() did not warn outside a creation window`).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain(`draw.${name}()`);
    }

    error.mockRestore();
  });

  it("a factory called outside a creation window returns an inert handle whose methods do not throw and register nothing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const line = draw.line({ time1: 0, price1: 0, time2: 1, price2: 1 });
    expect(() => {
      line.setXY1(1, 1);
      line.setColor("#fff");
      line.delete();
    }).not.toThrow();
    expect(handlesForOwners(["rsi"])).toEqual([]);

    error.mockRestore();
  });

  it("no factory warns when called inside a legitimate owner scope", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    withDrawOwnerScope("rsi", () => {
      for (const [name, args] of Object.entries(factoryArgs)) {
        (draw[name as keyof typeof draw] as (...a: unknown[]) => unknown)(...args);
      }
    });

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
