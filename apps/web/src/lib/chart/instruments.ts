import marketInstrumentCatalog from "../../../../../config/market-instruments.json";
import type { FrameIdentity, MarketKind } from "../../types/frames";

export type InstrumentGroup = "Crypto" | "Futures" | "Equities";

export interface InstrumentOption {
  readonly group: InstrumentGroup;
  readonly label: string;
  readonly symbol: string;
  readonly identity: Readonly<FrameIdentity>;
}

const MARKET_KINDS = new Set<MarketKind>(["SPOT", "PERPETUAL"]);
const ASSET_CLASSES = new Set(["FUTURE", "EQUITY"] as const);
const GROUPS = new Set<InstrumentGroup>(["Crypto", "Futures", "Equities"]);

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`market-instruments: ${field} must be a non-empty string`);
  }
  return value;
}

function freezeOption(group: unknown, label: unknown, symbol: unknown, identity: FrameIdentity): InstrumentOption {
  if (!GROUPS.has(group as InstrumentGroup)) throw new Error("market-instruments: invalid group");
  return Object.freeze({
    group: group as InstrumentGroup,
    label: requiredText(label, "label"),
    symbol: requiredText(symbol, "symbol"),
    identity: Object.freeze(identity),
  });
}

function buildInstrumentCatalog(): readonly InstrumentOption[] {
  if (marketInstrumentCatalog.version !== 1) throw new Error("market-instruments: unsupported catalog version");
  const options: InstrumentOption[] = [];
  for (const entry of marketInstrumentCatalog.binance) {
    if (!MARKET_KINDS.has(entry.marketKind as MarketKind) || entry.group !== "Crypto") {
      throw new Error("market-instruments: invalid Binance instrument");
    }
    options.push(freezeOption(entry.group, entry.label, entry.symbol, {
      provider: "BINANCE",
      marketKind: entry.marketKind as MarketKind,
    }));
  }
  for (const entry of marketInstrumentCatalog.dxfeed) {
    if (!ASSET_CLASSES.has(entry.assetClass as "FUTURE" | "EQUITY")) {
      throw new Error("market-instruments: invalid dxFeed instrument");
    }
    const expectedGroup = entry.assetClass === "FUTURE" ? "Futures" : "Equities";
    if (entry.group !== expectedGroup) throw new Error("market-instruments: dxFeed group/assetClass mismatch");
    options.push(freezeOption(entry.group, entry.label, entry.symbol, {
      provider: "DXFEED",
      assetClass: entry.assetClass as "FUTURE" | "EQUITY",
    }));
  }
  const identities = new Set<string>();
  for (const option of options) {
    const identity = option.identity.provider === "BINANCE"
      ? `${option.identity.provider}:${option.identity.marketKind}:${option.symbol}`
      : `${option.identity.provider}:${option.identity.assetClass}:${option.symbol}`;
    if (identities.has(identity)) throw new Error(`market-instruments: duplicate identity ${identity}`);
    identities.add(identity);
  }
  if (options.length === 0) throw new Error("market-instruments: catalog must not be empty");
  return Object.freeze(options);
}

export const INSTRUMENTS = buildInstrumentCatalog();
