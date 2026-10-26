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
  // The first minute this cursor is responsible for: the earlier bar of its
  // first request. Until a close is confirmed, catch-up and hole detection
  // continue from here, so minutes missed before the first confirmed close
  // (a start inside the grace, then a pause) are fetched, never skipped.
  let anchorOpenTime = null;
  let lastSeq = 0;
  let holes = 0;
  let holeRetries = 0;
  let repairing = null; // { fromOpenTime, toOpenTime } while the exchange is asked again for missing minutes
  const missing = [];
  const forming = new Map();

  function currentOpen(exchangeNowMs) {
    return Math.floor(exchangeNowMs / intervalMs) * intervalMs;
  }

  /** The earliest minute still expected: the bar after the last confirmed close, or the anchor before any close. */
  function continuationOpenTime() {
    return confirmedOpenTime !== null ? confirmedOpenTime + intervalMs : anchorOpenTime;
  }

  /** The two-row poll covers the previous and the current bar; anything expected before that needs catch-up pages. */
  function needsCatchUp(exchangeNowMs) {
    const continuation = continuationOpenTime();
    return continuation !== null && continuation < currentOpen(exchangeNowMs) - intervalMs;
  }

  function nextRequest(exchangeNowMs) {
    if (anchorOpenTime === null) anchorOpenTime = currentOpen(exchangeNowMs) - intervalMs;
    if (needsCatchUp(exchangeNowMs) || repairing !== null) {
      return Object.freeze({ startTime: continuationOpenTime(), limit: MAX_KLINES_PER_REQUEST, catchUp: true });
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
      // A response carried at least one expected candle (the continuation or
      // later, the forming bar included); an empty response or one holding
      // only candles already confirmed is not an observation of the pair.
      covered: false,
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
    const continuation = continuationOpenTime();
    const pending = rows.filter((row) => (continuation === null ? true : row.openTime >= continuation));
    if (pending.length === 0) return outcome({ covered: false }, exchangeNowMs);
    let hole = null;
    let abandoned = null;
    if (continuation !== null && pending[0].openTime > continuation) {
      hole = Object.freeze({ fromOpenTime: continuation, toOpenTime: pending[0].openTime - intervalMs });
      if (repairing === null || repairing.fromOpenTime !== hole.fromOpenTime) {
        holes += 1;
        holeRetries = 0;
        repairing = hole;
      }
      holeRetries += 1;
      if (holeRetries < maxHoleRetries) {
        // Ask again from the first missing minute before believing the gap.
        return outcome({ hole, covered: true }, exchangeNowMs);
      }
      // The exchange did not supply the interval: record it as missing and
      // move the cursor past it so the candles it does have are delivered.
      abandoned = hole;
      missing.push(hole);
      repairing = null;
      holeRetries = 0;
      confirmedOpenTime = hole.toOpenTime;
    } else {
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
    return outcome({ emit: Object.freeze(emit), hole, abandoned, covered: true }, exchangeNowMs);
  }

  function reset() {
    confirmedOpenTime = null;
    anchorOpenTime = null;
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
    get anchorOpenTime() { return anchorOpenTime; },
    get continuationOpenTime() { return continuationOpenTime(); },
    get repairing() { return repairing; },
    get missing() { return Object.freeze([...missing]); },
    missingBars,
    get stats() { return Object.freeze({ confirmedOpenTime, anchorOpenTime, continuationOpenTime: continuationOpenTime(), holes, holeRetries, lastSeq, missingBars: missingBars() }); },
  });
}

module.exports = { createBinanceRestBarCursor, DEFAULT_FINALIZE_GRACE_MS, DEFAULT_MAX_HOLE_RETRIES, TWO_ROW_POLL_LIMIT };
