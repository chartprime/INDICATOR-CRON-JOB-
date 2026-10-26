"use strict";

const { CANDLE_MS, hasTrades } = require("./exhaustion-engine");

const HOUR_MS = 3_600_000;
const SHORT_MAX_MS = 1_800_000;
const DEFAULT_CONCURRENCY = 3;
const GROUPS = Object.freeze([
  Object.freeze({ maxMs: 180_000, warm: 1, after: 1 }),
  Object.freeze({ maxMs: 300_000, warm: 2, after: 2 }),
  Object.freeze({ maxMs: 900_000, warm: 5, after: 5 }),
  Object.freeze({ maxMs: SHORT_MAX_MS, warm: 8, after: 8 }),
]);

function groupOf(candleMs) {
  if (!CANDLE_MS.includes(candleMs) || candleMs > SHORT_MAX_MS) return null;
  return GROUPS.find((group) => candleMs <= group.maxMs);
}

function isShort(candleMs) {
  return groupOf(candleMs) !== null;
}

function warmHours(lengths) {
  return Math.max(0, ...lengths.map((candleMs) => groupOf(candleMs)?.warm ?? 0));
}

function afterHours(lengths) {
  return Math.max(0, ...lengths.map((candleMs) => groupOf(candleMs)?.after ?? 0));
}

function readHours({
  pair,
  fromTs,
  toTs,
  hostColumns,
  chunkMs = HOUR_MS,
  concurrency = DEFAULT_CONCURRENCY,
  onHour = () => {},
  stopped = () => false,
}) {
  if (!Number.isSafeInteger(fromTs) || !Number.isSafeInteger(toTs)) throw new Error("exhaustion-history: fromTs and toTs must be integers");
  if (typeof hostColumns !== "function") throw new Error("exhaustion-history: hostColumns must be a function");
  if (typeof onHour !== "function") throw new Error("exhaustion-history: onHour must be a function");
  if (!Number.isSafeInteger(chunkMs) || chunkMs <= 0) throw new Error("exhaustion-history: chunkMs must be a positive safe integer");
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error("exhaustion-history: concurrency must be a positive safe integer");
  const hours = [];
  for (let start = fromTs; start < toTs; start += chunkMs) hours.push(Object.freeze({ start, end: Math.min(toTs, start + chunkMs) }));
  const outcomes = new Map();
  const result = { coveredTo: fromTs, read: 0, columns: 0, hours: 0, failed: null, reason: null, stopped: false };
  let next = 0;
  let delivered = 0;
  let active = 0;
  let halted = hours.length === 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });

  function fail(index, reason) {
    if (halted && result.failed !== null && result.failed < index) return;
    halted = true;
    result.failed = index;
    result.reason = reason;
  }

  function deliver() {
    while (!halted && outcomes.has(delivered)) {
      const outcome = outcomes.get(delivered);
      outcomes.delete(delivered);
      if (outcome.reason !== null) {
        fail(delivered, outcome.reason);
        break;
      }
      try {
        onHour(outcome.columns, hours[delivered]);
      } catch (error) {
        fail(delivered, `FEED_FAILED: ${String(error?.message ?? error).slice(0, 120)}`);
        break;
      }
      result.columns += outcome.columns.length;
      result.hours += 1;
      result.coveredTo = hours[delivered].end;
      delivered += 1;
    }
  }

  function complete() {
    if (active > 0 || (!halted && next < hours.length)) return;
    if (!halted && delivered < hours.length) return;
    finish(result);
  }

  function launch(index) {
    active += 1;
    let read;
    try {
      read = Promise.resolve(hostColumns(pair, hours[index].start, hours[index].end));
    } catch (error) {
      read = Promise.reject(error);
    }
    read
      .then((outcome) => (outcome && outcome.reason === null && Array.isArray(outcome.columns) ? outcome : { columns: [], reason: outcome?.reason ?? "MALFORMED" }), (error) => ({ columns: [], reason: `READ_FAILED: ${String(error?.message ?? error).slice(0, 120)}` }))
      .then((outcome) => {
        active -= 1;
        result.read += 1;
        if (stopped()) {
          result.stopped = true;
          halted = true;
        } else if (!halted) {
          outcomes.set(index, outcome);
          deliver();
        }
        pump();
        complete();
      });
  }

  function pump() {
    while (!halted && active < concurrency && next < hours.length) {
      launch(next);
      next += 1;
    }
  }

  pump();
  complete();
  return done;
}

function probeBack({
  pair,
  toTs,
  floorTs,
  needed,
  hostColumns,
  chunkMs = HOUR_MS,
  concurrency = DEFAULT_CONCURRENCY,
  stopped = () => false,
}) {
  if (!Number.isSafeInteger(toTs) || !Number.isSafeInteger(floorTs)) throw new Error("exhaustion-history: toTs and floorTs must be integers");
  if (!Number.isSafeInteger(needed) || needed <= 0) throw new Error("exhaustion-history: needed must be a positive safe integer");
  if (typeof hostColumns !== "function") throw new Error("exhaustion-history: hostColumns must be a function");
  if (!Number.isSafeInteger(chunkMs) || chunkMs <= 0) throw new Error("exhaustion-history: chunkMs must be a positive safe integer");
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error("exhaustion-history: concurrency must be a positive safe integer");
  const hours = [];
  for (let end = toTs; end > floorTs; end -= chunkMs) hours.push(Object.freeze({ start: Math.max(floorTs, end - chunkMs), end }));
  const outcomes = new Map();
  const result = { fromTs: toTs, read: 0, traded: 0, failed: null, reason: null, stopped: false };
  let next = 0;
  let active = 0;
  let halted = hours.length === 0;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });

  function settle() {
    let count = 0;
    for (let index = 0; index < hours.length; index += 1) {
      const outcome = outcomes.get(index);
      if (outcome === undefined) return;
      if (outcome.reason !== null) {
        result.failed = index;
        result.reason = outcome.reason;
        result.fromTs = index === 0 ? toTs : hours[index - 1].start;
        halted = true;
        return;
      }
      if (outcome.columns.some(hasTrades)) count += 1;
      result.fromTs = hours[index].start;
      result.traded = count;
      if (count >= needed) {
        halted = true;
        return;
      }
    }
  }

  function complete() {
    if (active > 0 || (!halted && next < hours.length)) return;
    finish(result);
  }

  function launch(index) {
    active += 1;
    let read;
    try {
      read = Promise.resolve(hostColumns(pair, hours[index].start, hours[index].end));
    } catch (error) {
      read = Promise.reject(error);
    }
    read
      .then((outcome) => (outcome && outcome.reason === null && Array.isArray(outcome.columns) ? outcome : { columns: [], reason: outcome?.reason ?? "MALFORMED" }), (error) => ({ columns: [], reason: `READ_FAILED: ${String(error?.message ?? error).slice(0, 120)}` }))
      .then((outcome) => {
        active -= 1;
        result.read += 1;
        if (stopped()) {
          result.stopped = true;
          result.fromTs = toTs;
          halted = true;
        } else if (!halted) {
          outcomes.set(index, outcome);
          settle();
        }
        pump();
        complete();
      });
  }

  function pump() {
    while (!halted && active < concurrency && next < hours.length) {
      launch(next);
      next += 1;
    }
  }

  pump();
  complete();
  return done;
}

module.exports = { readHours, probeBack, groupOf, isShort, warmHours, afterHours, GROUPS, HOUR_MS, SHORT_MAX_MS, DEFAULT_CONCURRENCY };
