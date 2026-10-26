"use strict";

const { rowClustersFor, windowRowsFor } = require("../passive_liquidity/liquidity-geometry");

function assertPositiveFinite(value, field) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`replay-truncate: ${field} must be a positive finite number`);
  }
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`replay-truncate: ${field} must be a positive safe integer`);
  }
}

function keyFor(price, tickSize, clusterTicks) {
  return Math.floor(Math.round(Number(price) / tickSize) / clusterTicks);
}

function midPriceFromBook(book) {
  if (!book || typeof book !== "object") return null;
  if (book.bestBid != null && book.bestAsk != null) {
    const bid = Number(book.bestBid);
    const ask = Number(book.bestAsk);
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
  }
  const bid = book.bids?.[0]?.[0];
  const ask = book.asks?.[0]?.[0];
  const bidN = bid === undefined ? NaN : Number(bid);
  const askN = ask === undefined ? NaN : Number(ask);
  if (bidN > 0 && askN > 0) return (bidN + askN) / 2;
  if (bidN > 0) return bidN;
  if (askN > 0) return askN;
  return null;
}

function windowForMid(midPrice, {
  tickSize,
  clusterTicks,
  rowBp,
  windowBp,
  rowClusters: fixedRowClusters = null,
  windowRows: fixedWindowRows = null,
}) {
  const clusterWidth = tickSize * clusterTicks;
  const rowClusters = fixedRowClusters ?? rowClustersFor(midPrice, clusterWidth, rowBp);
  const rowWidth = clusterWidth * rowClusters;
  const windowRows = fixedWindowRows ?? windowRowsFor(midPrice, rowWidth, windowBp);
  const midRow = Math.floor(keyFor(midPrice, tickSize, clusterTicks) / rowClusters);
  const lo = Math.max(0, midRow - windowRows);
  const hi = midRow + windowRows;
  return { rowClusters, rowWidth, windowRows, lo, hi };
}

function tupleInWindow(tuple, geometry, tickSize, clusterTicks) {
  if (!Array.isArray(tuple) || tuple.length < 1) return false;
  const price = Number(tuple[0]);
  if (!(price > 0)) return false;
  const row = Math.floor(keyFor(price, tickSize, clusterTicks) / geometry.rowClusters);
  return row >= geometry.lo && row <= geometry.hi;
}

function truncateSide(tuples, geometry, tickSize, clusterTicks) {
  if (!Array.isArray(tuples)) return tuples;
  return tuples.filter((tuple) => tupleInWindow(tuple, geometry, tickSize, clusterTicks));
}

function isSparseBook(book) {
  return !!book && typeof book === "object" && !Array.isArray(book.bids) && !Array.isArray(book.asks);
}

function truncateBook(book, geometry, tickSize, clusterTicks) {
  if (!book || typeof book !== "object" || isSparseBook(book)) return book;
  return {
    ...book,
    bids: truncateSide(book.bids, geometry, tickSize, clusterTicks),
    asks: truncateSide(book.asks, geometry, tickSize, clusterTicks),
  };
}

function truncateDelta(delta, geometry, tickSize, clusterTicks) {
  if (!delta || typeof delta !== "object") return delta;
  return {
    ...delta,
    bids: truncateSide(delta.bids, geometry, tickSize, clusterTicks),
    asks: truncateSide(delta.asks, geometry, tickSize, clusterTicks),
  };
}

function deltaBetweenSides(before, after, descending) {
  const out = [];
  const first = descending ? (a, b) => a > b : (a, b) => a < b;
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (j >= after.length) {
      out.push([before[i][0], 0]);
      i += 1;
      continue;
    }
    if (i >= before.length) {
      out.push([after[j][0], after[j][1]]);
      j += 1;
      continue;
    }
    const [priceBefore, sizeBefore] = before[i];
    const [priceAfter, sizeAfter] = after[j];
    const numericPriceBefore = Number(priceBefore);
    const numericPriceAfter = Number(priceAfter);
    if (numericPriceBefore === numericPriceAfter) {
      if (Number(sizeBefore) !== Number(sizeAfter)) out.push([priceAfter, sizeAfter]);
      i += 1;
      j += 1;
    } else if (first(numericPriceBefore, numericPriceAfter)) {
      out.push([priceBefore, 0]);
      i += 1;
    } else {
      out.push([priceAfter, sizeAfter]);
      j += 1;
    }
  }
  return out;
}

function boundedDelta(beforeBook, book) {
  const bidsBefore = Array.isArray(beforeBook?.bids) ? beforeBook.bids : [];
  const asksBefore = Array.isArray(beforeBook?.asks) ? beforeBook.asks : [];
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  return {
    bids: deltaBetweenSides(bidsBefore, bids, true),
    asks: deltaBetweenSides(asksBefore, asks, false),
  };
}

function truncateReplayFrame(frame, {
  tickSize,
  clusterTicks = 1,
  rowBp,
  windowBp,
  rowClusters = null,
  windowRows = null,
  midPrice,
  lastKnownMid = null,
} = {}) {
  if (!frame || typeof frame !== "object") {
    throw new Error("replay-truncate: frame must be an object");
  }
  if (frame.kind !== "book") return frame;
  assertPositiveFinite(tickSize, "tickSize");
  assertPositiveInteger(clusterTicks, "clusterTicks");
  if (rowClusters === null) assertPositiveFinite(rowBp, "rowBp");
  else assertPositiveInteger(rowClusters, "rowClusters");
  assertPositiveFinite(windowBp, "windowBp");
  if (windowRows !== null) assertPositiveInteger(windowRows, "windowRows");
  const mid = midPrice ?? midPriceFromBook(frame.book) ?? (lastKnownMid > 0 ? lastKnownMid : null);
  if (!(mid > 0)) return frame;
  const geometry = windowForMid(mid, { tickSize, clusterTicks, rowBp, windowBp, rowClusters, windowRows });
  return {
    ...frame,
    book: truncateBook(frame.book, geometry, tickSize, clusterTicks),
    delta: truncateDelta(frame.delta, geometry, tickSize, clusterTicks),
  };
}

const BOOK_MODES = Object.freeze(["full", "sparse"]);

function bestPricesOf(book) {
  return {
    ...(book.lastUpdateId === undefined ? {} : { lastUpdateId: book.lastUpdateId }),
    bestBid: book.bids.length > 0 ? book.bids[0][0] : null,
    bestAsk: book.asks.length > 0 ? book.asks[0][0] : null,
  };
}

function createReplayTruncator({ midPrice = null, bookMode = "full", ...options } = {}) {
  if (!BOOK_MODES.includes(bookMode)) {
    throw new Error(`replay-truncate: bookMode must be one of ${BOOK_MODES.join(", ")}`);
  }
  let lastKnownMid = midPrice > 0 ? midPrice : null;
  let lastReadyBook = null;

  function truncate(frame) {
    if (frame?.kind === "anchor") lastReadyBook = null;
    const ownMid = frame && typeof frame === "object" ? midPriceFromBook(frame.book) : null;
    const truncated = truncateReplayFrame(frame, { ...options, midPrice: ownMid ?? undefined, lastKnownMid });
    if (ownMid > 0) lastKnownMid = ownMid;
    if (frame?.kind !== "book" || frame.status !== "READY" || truncated === frame || !truncated.book) {
      if (frame?.kind === "book" && (frame.status !== "READY" || truncated === frame)) lastReadyBook = null;
      return truncated;
    }
    const seeding = lastReadyBook === null;
    if (isSparseBook(truncated.book)) {
      if (seeding) throw new Error("replay-truncate: a frame that must seed or resync arrived with only its best prices");
      return truncated;
    }
    const delta = seeding ? truncated.delta : boundedDelta(lastReadyBook, truncated.book);
    lastReadyBook = truncated.book;
    if (bookMode === "sparse" && !seeding) return { ...truncated, book: bestPricesOf(truncated.book), delta };
    return { ...truncated, delta };
  }

  return Object.freeze({ truncate });
}

function truncateReplayFrames(frames, options) {
  if (!Array.isArray(frames)) {
    throw new Error("replay-truncate: frames must be an array");
  }
  const truncator = createReplayTruncator(options);
  return frames.map((frame) => truncator.truncate(frame));
}

module.exports = {
  truncateReplayFrame,
  truncateReplayFrames,
  createReplayTruncator,
  midPriceFromBook,
  windowForMid,
  boundedDelta,
  BOOK_MODES,
};
