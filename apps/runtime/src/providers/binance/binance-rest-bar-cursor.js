const { MAX_KLINES_PER_REQUEST } = require("./binance-http-client");

const DEFAULT_FINALIZE_GRACE_MS = 1000;
const TWO_ROW_POLL_LIMIT = 2;
// A page that starts past the continuation cursor is asked for again this
// many times before the missing minutes are given up as not supplied.
const DEFAULT_MAX_HOLE_RETRIES = 3;

/**
 * The cursor over one pair's candles polled from /api/v3/klines. Every row is
 * classified by its own open and close time against the exchange clock as it
 * stood when the request was DISPATCHED, never by its position in the
 * response, by the machine clock or by the time of receipt: the exchange may
 * have built a row before the candle closed, so a row counts as final only
 * when the request left after that candle's close plus a grace; otherwise it
 * is the forming bar, re-sent as a revision whenever its values changed, and
 * a later poll confirms it. A response from an older poll never overwrites a
 * newer one. A page that starts beyond the next expected minute leaves the
 * continuation cursor on the first missing minute while the exchange is asked
 * again; after bounded retries the interval is recorded as missing and the
 * cursor moves past it, so the gap is reported rather than silently skipped.
 */
function createBinanceRestBarCursor({ intervalMs, finalizeGraceMs = DEFAULT_FINALIZE_GRACE_MS, maxHoleRetries = DEFAULT_MAX_HOLE_RETRIES } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error("intervalMs must be a positive safe integer");
  if (!Number.isSafeInteger(finalizeGraceMs) || finalizeGraceMs < 0) throw new Error("finalizeGraceMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxHoleRetries) || maxHoleRetries <= 0) throw new Error("maxHoleRetries must be a positive safe integer");

  let confirmedOpenTime = null;
  let lastSeq = 0;
  let holes = 0;
  let holeRetries = 0;
  let repairing = null; // { fromOpenTime, toOpenTime } while the exchange is asked again for missing minutes
  const missing = [];
  const forming = new Map();

  function currentOpen(exchangeNowMs) {
    return Math.floor(exchangeNowMs / intervalMs) * intervalMs;
  }

  /** After an outage the previous closed bar lies more than one bar past the last confirmed close. */
  function needsCatchUp(exchangeNowMs) {
    return confirmedOpenTime !== null && currentOpen(exchangeNowMs) - intervalMs > confirmedOpenTime + intervalMs;
  }

  function nextRequest(exchangeNowMs) {
    if (needsCatchUp(exchangeNowMs) || repairing !== null) {
      return Object.freeze({ startTime: confirmedOpenTime + intervalMs, limit: MAX_KLINES_PER_REQUEST, catchUp: true });
    }
    return Object.freeze({ startTime: currentOpen(exchangeNowMs) - intervalMs, limit: TWO_ROW_POLL_LIMIT, catchUp: false });
  }

  function signatureOf(row) {
    return `${row.open}|${row.high}|${row.low}|${row.close}|${row.volume}|${row.numberOfTrades}|${row.takerBuyBaseVolume}`;
  }

  function outcome(fields, exchangeNowMs) {
    return Object.freeze({
      stale: false,
      emit: Object.freeze([]),
      hole: null,
      abandoned: null,
      repairing: repairing !== null,
      catchingUp: needsCatchUp(exchangeNowMs) || repairing !== null,
      ...fields,
    });
  }

  /**
   * `rows` are parsed kline rows ascending by open time (parseKlineRows);
   * `exchangeNowMs` is the exchange time when their request was dispatched;
   * `seq` orders the polls that produced them.
   */
  function apply({ rows, exchangeNowMs, seq }) {
    if (!Number.isSafeInteger(seq) || seq <= lastSeq) {
      return outcome({ stale: true }, exchangeNowMs);
    }
    lastSeq = seq;
    const pending = rows.filter((row) => confirmedOpenTime === null || row.openTime > confirmedOpenTime);
    let hole = null;
    let abandoned = null;
    if (pending.length > 0 && confirmedOpenTime !== null && pending[0].openTime > confirmedOpenTime + intervalMs) {
      hole = Object.freeze({ fromOpenTime: confirmedOpenTime + intervalMs, toOpenTime: pending[0].openTime - intervalMs });
      if (repairing === null || repairing.fromOpenTime !== hole.fromOpenTime) {
        holes += 1;
        holeRetries = 0;
        repairing = hole;
      }
      holeRetries += 1;
      if (holeRetries < maxHoleRetries) {
        // Ask again from the first missing minute before believing the gap.
        return outcome({ hole }, exchangeNowMs);
      }
      // The exchange did not supply the interval: record it as missing and
      // move the cursor past it so the candles it does have are delivered.
      abandoned = hole;
      missing.push(hole);
      repairing = null;
      holeRetries = 0;
      confirmedOpenTime = hole.toOpenTime;
    } else if (pending.length > 0) {
      repairing = null;
      holeRetries = 0;
    }
    const emit = [];
    for (const row of pending) {
      const closed = row.closeTime + finalizeGraceMs <= exchangeNowMs;
      if (closed) {
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
    return outcome({ emit: Object.freeze(emit), hole, abandoned }, exchangeNowMs);
  }

  function reset() {
    confirmedOpenTime = null;
    repairing = null;
    holeRetries = 0;
    forming.clear();
  }

  /** Minutes the exchange never supplied, summed over the recorded missing intervals. */
  function missingBars() {
    return missing.reduce((sum, gap) => sum + (gap.toOpenTime - gap.fromOpenTime) / intervalMs + 1, 0);
  }

  return Object.freeze({
    nextRequest,
    needsCatchUp,
    apply,
    reset,
    get confirmedOpenTime() { return confirmedOpenTime; },
    get repairing() { return repairing; },
    get missing() { return Object.freeze([...missing]); },
    missingBars,
    get stats() { return Object.freeze({ confirmedOpenTime, holes, holeRetries, lastSeq, missingBars: missingBars() }); },
  });
}

module.exports = { createBinanceRestBarCursor, DEFAULT_FINALIZE_GRACE_MS, DEFAULT_MAX_HOLE_RETRIES, TWO_ROW_POLL_LIMIT };
