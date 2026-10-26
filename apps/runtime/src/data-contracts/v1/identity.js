"use strict";
const { requireValue, token, timestamp } = require("./exact");

function instrument(value) {
  requireValue(value && ["SPOT", "PERPETUAL", "FUTURE", "EQUITY"].includes(value.market), "INVALID_MARKET");
  for (const k of ["venue", "symbol", "currency", "sizeUnit"]) token(value[k]);
  requireValue(!/\.n\.\d+$/.test(value.symbol), "CONTINUOUS_ALIAS_NOT_INSTRUMENT");
  if (value.market === "FUTURE") {
    token(value.contract); requireValue(value.contract === value.symbol, "ACTUAL_CONTRACT_REQUIRED");
  } else requireValue(value.contract === null, "UNEXPECTED_CONTRACT");
  const id = JSON.stringify([value.venue, value.market, value.symbol, value.currency, value.sizeUnit]);
  return { id, venue: value.venue, market: value.market, symbol: value.symbol, currency: value.currency, sizeUnit: value.sizeUnit, contract: value.contract };
}
function createIdentityResolver(mappings) {
  requireValue(Array.isArray(mappings), "INVALID_MAPPINGS");
  const rows = mappings.map(m => ({
    provider: token(m.provider), dataset: token(m.dataset), sourceSymbol: token(m.sourceSymbol),
    fromNs: timestamp(m.fromNs), toNs: timestamp(m.toNs), instrument: instrument(m.instrument),
    mappingVersion: token(m.mappingVersion), reference: token(m.reference),
  }));
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]; requireValue(BigInt(a.fromNs) < BigInt(a.toNs), "EMPTY_MAPPING_INTERVAL");
    for (const b of rows.slice(i + 1)) if (a.provider === b.provider && a.dataset === b.dataset && a.sourceSymbol === b.sourceSymbol) {
      requireValue(BigInt(a.toNs) <= BigInt(b.fromNs) || BigInt(b.toNs) <= BigInt(a.fromNs), "AMBIGUOUS_MAPPING");
    }
  }
  return ({ provider, dataset, sourceSymbol, eventNs }) => {
    const t = BigInt(timestamp(eventNs));
    const match = rows.find(m => m.provider === provider && m.dataset === dataset && m.sourceSymbol === sourceSymbol && BigInt(m.fromNs) <= t && t < BigInt(m.toNs));
    requireValue(match, "UNRESOLVED_IDENTITY");
    return structuredClone(match);
  };
}
module.exports = { instrument, createIdentityResolver };
