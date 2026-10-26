"use strict";

const FRAME_KINDS = Object.freeze(["book", "trade", "gap", "anchor"]);
const TRADE_SIDES = Object.freeze(["buy", "sell"]);
const DEFAULT_GAP_CAUSE = "UNAVAILABLE";

function bookFrame(ts, status, book, delta, coverage = null) {
  const frame = { kind: "book", ts, status, book, delta };
  if (coverage !== null) frame.coverage = coverage;
  return frame;
}

function tradeFrame(ts, price, size, side, tradeId) {
  return { kind: "trade", ts, price, size, side, tradeId };
}

function gapFrame(cause = DEFAULT_GAP_CAUSE, ts = null) {
  return { kind: "gap", ts, cause };
}

function isTimestamp(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  return typeof value === "string" && Number.isSafeInteger(Date.parse(value));
}

function isSide(levels) {
  return Array.isArray(levels) && levels.every((level) => Array.isArray(level) && level.length >= 2 && finiteLevelNumber(level[0]) > 0 && finiteLevelNumber(level[1]) >= 0);
}

function finiteLevelNumber(value) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function isBestPrice(value) {
  return value === undefined || value === null || finiteLevelNumber(value) > 0;
}

function frameProblem(frame) {
  if (frame === null || typeof frame !== "object") return "a frame must be an object";
  if (!FRAME_KINDS.includes(frame.kind)) return `unknown frame kind "${String(frame.kind)}"`;
  if (frame.kind === "gap") {
    if (typeof frame.cause !== "string" || frame.cause.length === 0) return "a gap needs a cause";
    if (frame.ts !== null && frame.ts !== undefined && !isTimestamp(frame.ts)) return "a gap's ts must be a timestamp when present";
    return null;
  }
  if (!isTimestamp(frame.ts)) return `a ${frame.kind} frame needs a timestamp`;
  if (frame.kind === "anchor") return null;
  if (frame.kind === "trade") {
    if (!(finiteLevelNumber(frame.price) > 0)) return "a trade needs a positive price";
    if (!(finiteLevelNumber(frame.size) > 0)) return "a trade needs a positive size";
    if (!TRADE_SIDES.includes(frame.side)) return "a trade's side is the aggressor, buy or sell";
    return null;
  }
  if (typeof frame.status !== "string" || frame.status.length === 0) return "a book frame needs a status";
  if (frame.coverage !== undefined && frame.coverage !== null && frame.status !== "READY") {
    return "bounded coverage needs a READY book";
  }
  if (frame.status !== "READY") return null;
  const book = frame.book;
  if (book === null || typeof book !== "object") return "a READY book frame needs a book";
  const full = Array.isArray(book.bids) || Array.isArray(book.asks);
  if (full && !(isSide(book.bids) && isSide(book.asks))) return "a full book needs bids and asks as [price, size] levels";
  if (!full && book.bestBid === undefined && book.bestAsk === undefined) return "a light book needs its best prices";
  if (!isBestPrice(book.bestBid) || !isBestPrice(book.bestAsk)) return "a book needs valid best prices";
  if (frame.delta !== null && frame.delta !== undefined && !(isSide(frame.delta.bids) && isSide(frame.delta.asks))) {
    return "a delta needs bids and asks as [price, size] levels";
  }
  if (frame.coverage !== undefined && frame.coverage !== null) {
    if (!full || frame.delta === null || frame.delta === undefined) return "bounded coverage needs a full book and delta";
    const { unobserved, preexisting } = frame.coverage;
    if (!unobserved || !preexisting || !Array.isArray(unobserved.bids) || !Array.isArray(unobserved.asks)
        || !unobserved.bids.every((price) => finiteLevelNumber(price) > 0)
        || !unobserved.asks.every((price) => finiteLevelNumber(price) > 0)
        || !isSide(preexisting.bids) || !isSide(preexisting.asks)) {
      return "book coverage needs unobserved prices and preexisting [price, size] levels for both sides";
    }
  }
  return null;
}

module.exports = { FRAME_KINDS, TRADE_SIDES, DEFAULT_GAP_CAUSE, bookFrame, tradeFrame, gapFrame, frameProblem };
