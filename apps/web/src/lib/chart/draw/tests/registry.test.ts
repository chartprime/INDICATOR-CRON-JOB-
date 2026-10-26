import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearForIndicator,
  drawRegistryStats,
  create,
  get,
  handlesForOwners,
  remove,
  ownerChangedAt,
  resetDrawRegistryForTests,
  setRequestUpdate,
  update,
} from "../registry";

afterEach(() => {
  resetDrawRegistryForTests();
});

describe("registry -- create/get/update/remove", () => {
  it("owner turnover releases empty ownership entries and callbacks", () => {
    for (let i = 0; i < 1000; i++) {
      const owner = `chart-instance-${i}`;
      setRequestUpdate(owner, () => {});
      const id = create(owner, "line", {});
      if (i % 2) remove(id);
      else clearForIndicator(owner);
      setRequestUpdate(owner, null);
      expect(ownerChangedAt(owner)).toBe(0);
    }
    expect(drawRegistryStats()).toEqual({ objects: 0, owners: 0, callbacks: 0 });
  });
  it("create returns a handle id that get resolves back to the same owner, kind and data", () => {
    const handleId = create("rsi", "line", { x1: 1, y1: 2 });
    expect(get(handleId)).toEqual({ handleId, ownerId: "rsi", kind: "line", data: { x1: 1, y1: 2 } });
  });

  it("update replaces the stored data via the given patch function, leaving owner/kind unchanged", () => {
    const handleId = create("rsi", "box", { left: 0, right: 1 });
    update<{ left: number; right: number }>(handleId, (data) => ({ ...data, right: 99 }));
    expect(get(handleId)?.data).toEqual({ left: 0, right: 99 });
  });

  it("update on an unknown handle id is a silent no-op", () => {
    expect(() => update(999, (data) => data)).not.toThrow();
  });

  it("remove deletes the handle so get returns undefined and it no longer appears in handlesForOwners", () => {
    const handleId = create("rsi", "label", {});
    remove(handleId);
    expect(get(handleId)).toBeUndefined();
    expect(handlesForOwners(["rsi"])).toEqual([]);
  });

  it("remove on an unknown handle id is a silent no-op", () => {
    expect(() => remove(999)).not.toThrow();
  });
});

describe("registry -- handlesForOwners", () => {
  it("returns only the handles owned by the requested ids, in creation order per owner", () => {
    const a1 = create("a", "line", { n: 1 });
    const b1 = create("b", "line", { n: 2 });
    const a2 = create("a", "line", { n: 3 });

    const forA = handlesForOwners(["a"]);
    expect(forA.map((r) => r.handleId)).toEqual([a1, a2]);

    const forBoth = handlesForOwners(["a", "b"]);
    expect(forBoth.map((r) => r.handleId).sort()).toEqual([a1, b1, a2].sort());
  });

  it("returns an empty array for an owner with no registered objects", () => {
    expect(handlesForOwners(["nobody"])).toEqual([]);
  });
});

describe("registry -- clearForIndicator", () => {
  it("removes every handle owned by the given id and leaves other owners untouched", () => {
    const a1 = create("a", "line", {});
    const b1 = create("b", "line", {});
    clearForIndicator("a");
    expect(get(a1)).toBeUndefined();
    expect(get(b1)).toBeDefined();
    expect(handlesForOwners(["a"])).toEqual([]);
  });

  it("clearing an owner with nothing registered is a silent no-op", () => {
    expect(() => clearForIndicator("nobody")).not.toThrow();
  });

  it("test reset clears owner revision stamps", () => {
    create("previous-test", "line", {});
    expect(ownerChangedAt("previous-test")).toBeGreaterThan(0);
    resetDrawRegistryForTests();
    expect(ownerChangedAt("previous-test")).toBe(0);
  });

  it("a handle created after a clear is not affected by that clear", () => {
    clearForIndicator("a");
    const handleId = create("a", "line", {});
    expect(get(handleId)).toBeDefined();
  });
});

describe("registry -- requestUpdate notification", () => {
  it("create, update, remove and clearForIndicator each notify the owner's registered callback exactly once", () => {
    const callback = vi.fn();
    setRequestUpdate("rsi", callback);

    const handleId = create("rsi", "line", { n: 0 });
    expect(callback).toHaveBeenCalledTimes(1);

    update<{ n: number }>(handleId, (data) => ({ n: data.n + 1 }));
    expect(callback).toHaveBeenCalledTimes(2);

    remove(handleId);
    expect(callback).toHaveBeenCalledTimes(3);

    create("rsi", "line", { n: 0 });
    clearForIndicator("rsi");
    expect(callback).toHaveBeenCalledTimes(5);
  });

  it("does not notify an owner with no registered callback, and does not throw", () => {
    expect(() => create("nobody-listening", "line", {})).not.toThrow();
  });

  it("setRequestUpdate(ownerId, null) unregisters the callback", () => {
    const callback = vi.fn();
    setRequestUpdate("rsi", callback);
    setRequestUpdate("rsi", null);
    create("rsi", "line", {});
    expect(callback).not.toHaveBeenCalled();
  });
});
