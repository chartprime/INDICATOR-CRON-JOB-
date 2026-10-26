const { MAX_KLINES_PER_REQUEST } = require("./binance-http-client");

const DEFAULT_FINALIZE_GRACE_MS = 1000;
const TWO_ROW_POLL_LIMIT = 2;

/**
 * The cursor over one pair's candles polled from /api/v3/klines. Every row is
 * classified by its own open and close time against the exchange clock, never
 * by its position in the response or by the machine clock: a row whose close
 * time (plus a grace) has passed on the exchange is final and is emitted
 * closed exactly once; any other row is the forming bar, emitted as a
 * revision whenever its values changed. A response from an older poll never
 * overwrites a newer one.
 */
function createBinanceRestBarCursor({ intervalMs, finalizeGraceMs = DEFAULT_FINALIZE_GRACE_MS } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("intervalMs must be a positive safe integer");
  if (!Number.isSafeInteger(finalizeGraceMs) || finalizeGraceMs < 0) throw new Error("finalizeGraceMs must be a non-negative safe integer");

  let confirmedOpenTime = null;
  let lastSeq = 0;
  let holes = 0;
  const forming = new Map();

  function currentOpen(exchangeNowMs) {
    return Math.floor(exchangeNowMs / intervalMs) * intervalMs;
  }

  /** After an outage the previous closed bar lies more than one bar past the last confirmed close. */
  function needsCatchUp(exchangeNowMs) {
    return confirmedOpenTime !== null && currentOpen(exchangeNowMs) - intervalMs > confirmedOpenTime + intervalMs;
  }

  function nextRequest(exchangeNowMs) {
    if (needsCatchUp(exchangeNowMs)) {
      return Object.freeze({ startTime: confirmedOpenTime + intervalMs, limit: MAX_KLINES_PER_REQUEST, catchUp: true });
    }
    return Object.freeze({ startTime: currentOpen(exchangeNowMs) - intervalMs, limit: TWO_ROW_POLL_LIMIT, catchUp: false });
  }

  function signatureOf(row) {
    return `${row.open}|${row.high}|${row.low}|${row.close}|${row.volume}|${row.numberOfTrades}|${row.takerBuyBaseVolume}`;
  }

  /** `rows` are parsed kline rows ascending by open time (parseKlineRows); `seq` orders the polls that produced them. */
  function apply({ rows, exchangeNowMs, seq }) {
    if (!Number.isSafeInteger(seq) || seq <= lastSeq) {
      return Object.freeze({ stale: true, emit: Object.freeze([]), hole: false, catchingUp: needsCatchUp(exchangeNowMs) });
    }
    lastSeq = seq;
    const emit = [];
    let hole = false;
    for (const row of rows) {
      if (confirmedOpenTime !== null && row.openTime <= confirmedOpenTime) continue;
      const closed = row.closeTime + finalizeGraceMs <= exchangeNowMs;
      if (closed) {
        if (confirmedOpenTime !== null && row.openTime > confirmedOpenTime + intervalMs) {
          hole = true;
          holes += 1;
        }
        emit.push(Object.freeze({ row, closed: true }));
        confirmedOpenTime = row.openTime;
        forming.delete(row.openTime);
        continue;
      }
      const signature = signatureOf(row);
      if (forming.get(row.openTime) === signature) continue;
      forming.set(row.openTime, signature);
      emit.push(Object.freeze({ row, closed: false }));
    }
    for (const openTime of forming.keys()) {
      if (confirmedOpenTime !== null && openTime <= confirmedOpenTime) forming.delete(openTime);
    }
    return Object.freeze({ stale: false, emit: Object.freeze(emit), hole, catchingUp: needsCatchUp(exchangeNowMs) });
  }

  function reset() {
    confirmedOpenTime = null;
    forming.clear();
  }

  return Object.freeze({
    nextRequest,
    needsCatchUp,
    apply,
    reset,
    get confirmedOpenTime() { return confirmedOpenTime; },
    get stats() { return Object.freeze({ confirmedOpenTime, holes, lastSeq }); },
  });
}

module.exports = { createBinanceRestBarCursor, DEFAULT_FINALIZE_GRACE_MS, TWO_ROW_POLL_LIMIT };
