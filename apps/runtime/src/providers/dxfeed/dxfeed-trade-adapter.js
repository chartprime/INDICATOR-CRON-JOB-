function synthesizeLiveTradeId(symbol, rawItem) {
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.trim() !== symbol) {
    throw new Error("dxfeed-trade-adapter: symbol is invalid for trade-id synthesis");
  }
  for (const field of ["time", "timeNanoPart", "sequence"]) {
    if (!Number.isSafeInteger(rawItem?.[field]) || rawItem[field] < 0) {
      throw new Error(`dxfeed-trade-adapter: ${field} is invalid for trade-id synthesis`);
    }
  }
  return `${symbol}:${rawItem.time}:${rawItem.timeNanoPart}:${rawItem.sequence}`;
}

function aggressorSideToSide(aggressorSide) {
  if (aggressorSide === "BUY") return "buy";
  if (aggressorSide === "SELL") return "sell";
  throw new Error("dxfeed-trade-adapter: unsupported or undefined aggressorSide");
}

function aggressorSideToBarSide(aggressorSide) {
  return aggressorSide === "UNDEFINED" ? null : aggressorSideToSide(aggressorSide);
}

const AUCTION_SALE_CONDITION_CODES = Object.freeze(["O", "5", "6", "Q", "M", "9", "X"]);

function isEquityAuctionPrint(assetClass, payload) {
  if (assetClass !== "EQUITY" || typeof payload?.exchangeSaleConditions !== "string") return false;
  return AUCTION_SALE_CONDITION_CODES.some((code) => payload.exchangeSaleConditions.includes(code));
}

function assertRequireValidTick(requireValidTick) {
  if (typeof requireValidTick !== "boolean") {
    throw new Error("dxfeed-trade-adapter: requireValidTick must be a boolean");
  }
}

const BAR_ELIGIBILITY_REASONS = Object.freeze({
  ACCEPTED: "ACCEPTED",
  MALFORMED: "MALFORMED",
  NOT_NEW: "NOT_NEW",
  SPREAD_LEG: "SPREAD_LEG",
  INVALID_TICK: "INVALID_TICK",
});

function classifyDxFeedTimeAndSaleForBar(payload, { requireValidTick }) {
  assertRequireValidTick(requireValidTick);
  if (!payload || typeof payload !== "object") return BAR_ELIGIBILITY_REASONS.MALFORMED;
  if (payload.type !== "NEW") return BAR_ELIGIBILITY_REASONS.NOT_NEW;
  if (payload.spreadLeg === true) return BAR_ELIGIBILITY_REASONS.SPREAD_LEG;
  if (requireValidTick && payload.validTick !== true) return BAR_ELIGIBILITY_REASONS.INVALID_TICK;
  return BAR_ELIGIBILITY_REASONS.ACCEPTED;
}

function adaptLiveDxFeedTimeAndSaleForBar(envelope, rawItem) {
  if (!envelope || envelope.state === "UNAVAILABLE" || envelope.eventType !== "TIMEANDSALE") {
    throw new Error("dxfeed-trade-adapter: envelope must be a healthy TIMEANDSALE envelope");
  }
  const { payload } = envelope;
  if (
    rawItem?.time !== payload.time ||
    rawItem?.timeNanoPart !== payload.timeNanoPart ||
    rawItem?.sequence !== payload.sequence
  ) {
    throw new Error("dxfeed-trade-adapter: raw trade identity does not match its canonical envelope");
  }
  return {
    symbol: envelope.providerSymbol,
    assetClass: envelope.assetClass,
    tsExchange: Date.parse(envelope.eventTime),
    price: payload.price,
    size: payload.size,
    side: aggressorSideToBarSide(payload.aggressorSide),
    timeNanoPart: payload.timeNanoPart,
    sequence: payload.sequence,
    tradeId: synthesizeLiveTradeId(envelope.providerSymbol, payload),
  };
}

function adaptLiveDxFeedTimeAndSale(envelope, rawItem) {
  const trade = adaptLiveDxFeedTimeAndSaleForBar(envelope, rawItem);
  if (trade.side === null) {
    throw new Error("dxfeed-trade-adapter: unsupported or undefined aggressorSide");
  }
  return trade;
}

function adaptStoredDxFeedTimeAndSaleRow(row, { requireValidTick }) {
  assertRequireValidTick(requireValidTick);
  if (!row || typeof row !== "object") {
    throw new Error("dxfeed-trade-adapter: row must be an object");
  }
  if (row.event_kind !== "NEW" || (requireValidTick && row.valid_tick !== 1)) {
    throw new Error("dxfeed-trade-adapter: stored TimeAndSale row is not a valid new tick");
  }
  if (row.aggressor_side !== "BUY" && row.aggressor_side !== "SELL") {
    throw new Error("dxfeed-trade-adapter: unsupported or undefined aggressorSide");
  }
  return {
    symbol: row.symbol,
    assetClass: row.asset_class,
    tsExchange: row.event_time,
    price: row.price,
    size: row.size,
    side: aggressorSideToSide(row.aggressor_side),
    timeNanoPart: row.time_nano_part,
    sequence: row.sequence,
    tradeId: synthesizeLiveTradeId(row.symbol, {
      time: row.time,
      timeNanoPart: row.time_nano_part,
      sequence: row.sequence,
    }),
  };
}

function classifyStoredDxFeedTimeAndSaleRowForBar(row, { requireValidTick }) {
  assertRequireValidTick(requireValidTick);
  if (!row || typeof row !== "object") return BAR_ELIGIBILITY_REASONS.MALFORMED;
  return classifyDxFeedTimeAndSaleForBar(
    { type: row.event_kind, spreadLeg: row.spread_leg === 1, validTick: row.valid_tick === 1 },
    { requireValidTick },
  );
}

function adaptStoredDxFeedTimeAndSaleRowForBar(row) {
  if (!row || typeof row !== "object") {
    throw new Error("dxfeed-trade-adapter: row must be an object");
  }
  return {
    symbol: row.symbol,
    assetClass: row.asset_class,
    tsExchange: row.event_time,
    price: row.price,
    size: row.size,
    side: aggressorSideToBarSide(row.aggressor_side),
    timeNanoPart: row.time_nano_part,
    sequence: row.sequence,
    tradeId: synthesizeLiveTradeId(row.symbol, {
      time: row.time,
      timeNanoPart: row.time_nano_part,
      sequence: row.sequence,
    }),
  };
}

function isStoredDxFeedTimeAndSaleTapeRow(row, { requireValidTick }) {
  assertRequireValidTick(requireValidTick);
  return (
    row?.event_kind === "NEW" &&
    (!requireValidTick || row.valid_tick === 1) &&
    (row.aggressor_side === "BUY" || row.aggressor_side === "SELL")
  );
}

function isDxFeedTimeAndSaleBarWorthy(payload, { requireValidTick }) {
  return classifyDxFeedTimeAndSaleForBar(payload, { requireValidTick }) === BAR_ELIGIBILITY_REASONS.ACCEPTED;
}

module.exports = {
  classifyStoredDxFeedTimeAndSaleRowForBar,
  adaptStoredDxFeedTimeAndSaleRowForBar,
  aggressorSideToSide,
  aggressorSideToBarSide,
  synthesizeLiveTradeId,
  adaptLiveDxFeedTimeAndSaleForBar,
  adaptLiveDxFeedTimeAndSale,
  isStoredDxFeedTimeAndSaleTapeRow,
  adaptStoredDxFeedTimeAndSaleRow,
  BAR_ELIGIBILITY_REASONS,
  classifyDxFeedTimeAndSaleForBar,
  isDxFeedTimeAndSaleBarWorthy,
  isEquityAuctionPrint,
  AUCTION_SALE_CONDITION_CODES,
};
