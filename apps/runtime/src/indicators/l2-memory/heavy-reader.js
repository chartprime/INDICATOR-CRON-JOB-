"use strict";

function createHeavyReader({ engine, fromSeq } = {}) {
  if (!engine || typeof engine.events !== "function" || typeof engine.eventHead !== "function") {
    throw new Error("heavy-reader: an engine with events() and eventHead() is required");
  }
  if (fromSeq !== undefined && (!Number.isSafeInteger(fromSeq) || fromSeq < 0)) {
    throw new Error("heavy-reader: fromSeq must be a non-negative safe integer");
  }
  let cursor = fromSeq ?? engine.eventHead();

  function read() {
    const from = cursor;
    const result = engine.events(cursor);
    cursor = result.nextSeq;
    let gap = result.missed > 0;
    for (const event of result.events) {
      if (event.type === "segment" && event.state === "GAP") {
        gap = true;
        break;
      }
    }
    return Object.freeze({ events: result.events, missed: result.missed, gap, fromSeq: from, nextSeq: result.nextSeq });
  }

  function level(side, key) {
    return engine.level(side, key);
  }

  function range({ side, fromKey, toKey }) {
    return engine.range({ side, fromKey, toKey });
  }

  function ladder({ side, depth }) {
    return engine.ladder({ side, depth });
  }

  return Object.freeze({
    read,
    level,
    range,
    ladder,
    get cursor() {
      return cursor;
    },
  });
}

module.exports = { createHeavyReader };
