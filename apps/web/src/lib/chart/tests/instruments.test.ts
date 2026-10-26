import { describe, expect, it } from "vitest";
import { identitiesMatch, parseFrameIdentity } from "../../../types/frames";
import { INSTRUMENTS } from "../instruments";

function rawSelectMessageFor(symbol: string, identity: (typeof INSTRUMENTS)[number]["identity"]) {
  return identity.provider === "BINANCE"
    ? { provider: "BINANCE", symbol, marketKind: identity.marketKind }
    : { provider: "DXFEED", symbol, assetClass: identity.assetClass };
}

describe("instruments -- the dropdown's single source of truth", () => {
  it("every instrument's symbol/identity combination is actually selectable, not just plausible-looking", () => {
    for (const option of INSTRUMENTS) {
      const parsed = parseFrameIdentity(rawSelectMessageFor(option.symbol, option.identity));
      expect(parsed).not.toBeNull();
      expect(identitiesMatch(parsed!, option.identity)).toBe(true);
    }
  });

  it("covers exactly the three expected groups", () => {
    expect(new Set(INSTRUMENTS.map((option) => option.group))).toEqual(new Set(["Crypto", "Futures", "Equities"]));
  });

  it("has no duplicate labels within a group -- the dropdown would otherwise show two indistinguishable rows", () => {
    const byGroup = new Map<string, Set<string>>();
    for (const option of INSTRUMENTS) {
      const labels = byGroup.get(option.group) ?? new Set<string>();
      expect(labels.has(option.label)).toBe(false);
      labels.add(option.label);
      byGroup.set(option.group, labels);
    }
  });

  it("has no duplicate full identities and is deeply frozen so runtime UI code cannot mutate deployment scope", () => {
    const identities = INSTRUMENTS.map((option) => option.identity.provider === "BINANCE"
      ? `${option.identity.provider}:${option.identity.marketKind}:${option.symbol}`
      : `${option.identity.provider}:${option.identity.assetClass}:${option.symbol}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(Object.isFrozen(INSTRUMENTS)).toBe(true);
    for (const option of INSTRUMENTS) {
      expect(Object.isFrozen(option)).toBe(true);
      expect(Object.isFrozen(option.identity)).toBe(true);
    }
  });

  it("Crypto covers the full BTC/ETH x SPOT/PERPETUAL cross-product", () => {
    const crypto = INSTRUMENTS.filter((option) => option.group === "Crypto");
    expect(crypto).toHaveLength(4);
    expect(crypto.map((option) => option.label).sort()).toEqual(["BTC Perp", "BTC Spot", "ETH Perp", "ETH Spot"]);
  });
});
