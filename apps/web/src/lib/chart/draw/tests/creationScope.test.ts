import { afterEach, describe, expect, it } from "vitest";
import { currentDrawOwnerId, resetDrawOwnerScopeForTests, withDrawOwnerScope } from "../creationScope";
import { create, get, handlesForOwners, resetDrawRegistryForTests } from "../registry";

afterEach(() => {
  resetDrawOwnerScopeForTests();
  resetDrawRegistryForTests();
});

describe("creationScope -- currentDrawOwnerId", () => {
  it("reports null outside any scope", () => {
    expect(currentDrawOwnerId()).toBeNull();
  });

  it("reports the owner id while inside its scope, and null again after it closes", () => {
    withDrawOwnerScope("rsi", () => {
      expect(currentDrawOwnerId()).toBe("rsi");
    });
    expect(currentDrawOwnerId()).toBeNull();
  });

  it("closes the scope even when the wrapped function throws", () => {
    expect(() =>
      withDrawOwnerScope("rsi", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(currentDrawOwnerId()).toBeNull();
  });

  it("returns the value produced by the wrapped function", () => {
    const result = withDrawOwnerScope("rsi", () => 42);
    expect(result).toBe(42);
  });
});

describe("creationScope -- nested scopes", () => {
  it("an inner scope's owner id is reported while active, and the outer owner id resumes after it closes", () => {
    withDrawOwnerScope("outer", () => {
      expect(currentDrawOwnerId()).toBe("outer");
      withDrawOwnerScope("inner", () => {
        expect(currentDrawOwnerId()).toBe("inner");
      });
      expect(currentDrawOwnerId()).toBe("outer");
    });
    expect(currentDrawOwnerId()).toBeNull();
  });
});

describe("creationScope -- entering a scope clears whatever that owner had previously registered", () => {
  it("a fresh createState-equivalent call for the same owner starts with no leftover objects from a prior incarnation", () => {
    withDrawOwnerScope("rsi", () => {
      create("rsi", "line", { n: 1 });
    });
    expect(handlesForOwners(["rsi"])).toHaveLength(1);

    withDrawOwnerScope("rsi", () => {
      expect(handlesForOwners(["rsi"])).toHaveLength(0); // cleared on entry, before this callback ran
      create("rsi", "line", { n: 2 });
    });
    const remaining = handlesForOwners(["rsi"]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].data).toEqual({ n: 2 });
  });

  it("clearing one owner's scope does not touch a different owner's registered objects", () => {
    const otherHandle = create("other", "line", { n: 1 });
    withDrawOwnerScope("rsi", () => {});
    expect(get(otherHandle)).toBeDefined();
  });
});
