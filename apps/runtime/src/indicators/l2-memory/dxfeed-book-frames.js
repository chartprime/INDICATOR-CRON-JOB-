"use strict";

const DXFEED_COALESCE_MS = 250;
const DXFEED_BATCHING = Object.freeze({
  LIVE: "trailing-wall-clock",
  REPLAY: "leading-exchange-time",
});
const DXFEED_BOOK_MODES = Object.freeze(["full", "sparse"]);

function hasChanges(changes) {
  return changes.bids.length > 0 || changes.asks.length > 0;
}

function changeBook(assembler, bookMode) {
  return bookMode === "full" ? assembler.getState().book : assembler.getBestPrices();
}

function seedDelta(book) {
  return { bids: book.bids, asks: book.asks };
}

module.exports = { DXFEED_COALESCE_MS, DXFEED_BATCHING, DXFEED_BOOK_MODES, hasChanges, changeBook, seedDelta };
