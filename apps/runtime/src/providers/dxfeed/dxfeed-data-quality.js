const { BAR_ELIGIBILITY_REASONS, isEquityAuctionPrint } = require("./dxfeed-trade-adapter");

const MAX_DISTINCT_SALE_CONDITIONS = 32;

const REJECTION_REASONS = Object.freeze(
  Object.values(BAR_ELIGIBILITY_REASONS).filter((reason) => reason !== BAR_ELIGIBILITY_REASONS.ACCEPTED),
);

const REJECTION_SEVERITY = Object.freeze({
  [BAR_ELIGIBILITY_REASONS.MALFORMED]: "warn",
  [BAR_ELIGIBILITY_REASONS.NOT_NEW]: "info",
  [BAR_ELIGIBILITY_REASONS.SPREAD_LEG]: "info",
  [BAR_ELIGIBILITY_REASONS.INVALID_TICK]: "info",
});

function isDiagnosticCount(count) {
  return count === 1 || (count & (count - 1)) === 0;
}

function safeTradeDiagnostic(item) {
  return Object.freeze({
    eventTime: Number.isSafeInteger(item?.time) ? item.time : null,
    price: Number.isFinite(item?.price) ? item.price : null,
    size: Number.isFinite(item?.size) ? item.size : null,
    validTick: typeof item?.validTick === "boolean" ? item.validTick : null,
    spreadLeg: typeof item?.spreadLeg === "boolean" ? item.spreadLeg : null,
    exchangeCode: typeof item?.exchangeCode === "string" ? item.exchangeCode.slice(0, 16) : null,
    exchangeSaleConditions: typeof item?.exchangeSaleConditions === "string"
      ? item.exchangeSaleConditions.slice(0, 64)
      : null,
  });
}

function createDxFeedDataQualityLedger({ telemetry = null, now = () => Date.now() } = {}) {
  if (typeof now !== "function") throw new TypeError("dxfeed data-quality ledger: now must be a function");
  const instruments = new Map();

  function stateFor(symbol, assetClass) {
    const key = `${assetClass}:${symbol}`;
    let state = instruments.get(key);
    if (!state) {
      state = {
        accepted: 0,
        rejected: Object.fromEntries(REJECTION_REASONS.map((reason) => [reason, 0])),
        lastRejectedAtMs: null,
        lastRejection: null,
        saleConditions: new Map(),
        saleConditionsOverflow: 0,
      };
      instruments.set(key, state);
    }
    return state;
  }

  function emit(entry) {
    if (typeof telemetry === "function") telemetry(entry);
    else console.warn("[telemetry]", JSON.stringify(entry));
  }

  function noteSaleCondition(state, symbol, assetClass, item) {
    const condition = typeof item?.exchangeSaleConditions === "string" ? item.exchangeSaleConditions.slice(0, 16) : "NONE";
    const seen = state.saleConditions.get(condition);
    if (seen !== undefined) {
      state.saleConditions.set(condition, seen + 1);
      return;
    }
    if (state.saleConditions.size >= MAX_DISTINCT_SALE_CONDITIONS) {
      state.saleConditionsOverflow += 1;
      return;
    }
    state.saleConditions.set(condition, 1);
    emit(Object.freeze({
      event: "market_data.dxfeed_sale_condition.first_seen",
      ts: new Date(now()).toISOString(),
      provider: "DXFEED",
      symbol,
      assetClass,
      condition,
      auction: isEquityAuctionPrint(assetClass, item),
      diagnostic: safeTradeDiagnostic(item),
    }));
  }

  function record({ symbol, assetClass, reason, item }) {
    if (!Object.values(BAR_ELIGIBILITY_REASONS).includes(reason)) {
      throw new Error("dxfeed data-quality ledger: unknown eligibility reason");
    }
    const state = stateFor(symbol, assetClass);
    noteSaleCondition(state, symbol, assetClass, item);
    if (reason === BAR_ELIGIBILITY_REASONS.ACCEPTED) {
      state.accepted += 1;
      return;
    }
    const count = ++state.rejected[reason];
    state.lastRejectedAtMs = now();
    state.lastRejection = Object.freeze({ reason, ...safeTradeDiagnostic(item) });
    if (isDiagnosticCount(count)) {
      const entry = Object.freeze({
        event: "market_data.dxfeed_candle_input.rejected",
        severity: REJECTION_SEVERITY[reason] ?? "warn",
        ts: new Date(state.lastRejectedAtMs).toISOString(),
        provider: "DXFEED",
        symbol,
        assetClass,
        operation: "CANDLE_INPUT",
        reason,
        count,
        diagnostic: state.lastRejection,
      });
      emit(entry);
    }
  }

  function snapshot(symbol, assetClass) {
    const state = stateFor(symbol, assetClass);
    return Object.freeze({
      accepted: state.accepted,
      rejected: Object.freeze({ ...state.rejected }),
      lastRejectedAtMs: state.lastRejectedAtMs,
      lastRejection: state.lastRejection,
      saleConditions: Object.freeze(Object.fromEntries(state.saleConditions)),
      saleConditionsOverflow: state.saleConditionsOverflow,
    });
  }

  return Object.freeze({ record, snapshot });
}

module.exports = { REJECTION_REASONS, REJECTION_SEVERITY, safeTradeDiagnostic, createDxFeedDataQualityLedger };
