const { emitTelemetry } = require("../../platform/telemetry");
const { EVENT_TYPES } = require("./binance-config");
const { safeTelemetrySymbol } = require("./binance-subscription-guard");

const DEFAULT_MAX_QUEUE_DEPTH = 500;
const OVERFLOW_POLICIES = Object.freeze({ DROP_OLDEST: "DROP_OLDEST", FAIL: "FAIL" });

const QUEUEABLE_EVENT_TYPES = Object.freeze([
  EVENT_TYPES.TRADE,
  EVENT_TYPES.BOOK_TICKER,
  EVENT_TYPES.KLINE,
]);
const QUEUEABLE_EVENT_TYPE_SET = new Set(QUEUEABLE_EVENT_TYPES);

function keyFor(symbol, eventType, interval) {
  return JSON.stringify([symbol, eventType, interval ?? null]);
}

class BinanceBackpressureOverflowError extends Error {
  constructor({ symbol, eventType, interval, queueDepth }) {
    super(`Binance ${eventType} queue overflow for ${symbol} at depth ${queueDepth}`);
    this.name = "BinanceBackpressureOverflowError";
    this.code = "BACKPRESSURE_OVERFLOW";
    this.symbol = symbol;
    this.eventType = eventType;
    this.interval = interval;
    this.queueDepth = queueDepth;
  }
}

function createBinanceBackpressureQueue({
  telemetry,
  maxQueueDepth = DEFAULT_MAX_QUEUE_DEPTH,
  overflowPolicy = OVERFLOW_POLICIES.DROP_OLDEST,
} = {}) {
  if (!Number.isInteger(maxQueueDepth) || maxQueueDepth <= 0) {
    throw new Error("maxQueueDepth must be a positive integer.");
  }
  if (!Object.values(OVERFLOW_POLICIES).includes(overflowPolicy)) {
    throw new Error("overflowPolicy must be DROP_OLDEST or FAIL.");
  }

  const queues = new Map();
  const counters = {
    enqueued: 0,
    drained: 0,
    dropped: 0,
    overflows: 0,
    cleared: 0,
    highWaterMark: 0,
  };

  function queueSize(queue) {
    return queue.items.length - queue.head;
  }

  function compact(queue) {
    if (queue.head >= 1024 && queue.head * 2 >= queue.items.length) {
      queue.items = queue.items.slice(queue.head);
      queue.head = 0;
    }
  }

  function requireQueueable(eventType) {
    if (!QUEUEABLE_EVENT_TYPE_SET.has(eventType)) {
      throw new Error(
        `${eventType} is not backpressure-queued here; DEPTH deltas route through the book assembler's own gap-recovery path.`,
      );
    }
  }

  function enqueue(symbol, eventType, event, interval) {
    requireQueueable(eventType);
    const key = keyFor(symbol, eventType, interval);
    let queue = queues.get(key);
    if (!queue) {
      queue = { items: [], head: 0 };
      queues.set(key, queue);
    }
    const currentDepth = queueSize(queue);
    if (currentDepth >= maxQueueDepth && overflowPolicy === OVERFLOW_POLICIES.FAIL) {
      counters.overflows += 1;
      emitTelemetry(telemetry, "market_data.binance_backpressure.queue_overflow", {
        symbol: safeTelemetrySymbol(symbol),
        eventType,
        queueDepth: currentDepth,
        droppedCount: 1,
      });
      throw new BinanceBackpressureOverflowError({
        symbol,
        eventType,
        interval,
        queueDepth: currentDepth,
      });
    }
    queue.items.push(event);
    counters.enqueued += 1;
    counters.highWaterMark = Math.max(counters.highWaterMark, queueSize(queue));
    if (queueSize(queue) <= maxQueueDepth) {
      return null;
    }
    const dropped = queue.items[queue.head];
    queue.head += 1;
    counters.dropped += 1;
    compact(queue);
    emitTelemetry(telemetry, "market_data.binance_backpressure.event_dropped", {
      symbol: safeTelemetrySymbol(symbol),
      eventType,
      queueDepth: queueSize(queue),
    });
    return dropped;
  }

  function drain(symbol, eventType, interval) {
    requireQueueable(eventType);
    const key = keyFor(symbol, eventType, interval);
    const queue = queues.get(key);
    if (!queue || queueSize(queue) === 0) {
      return [];
    }
    queues.delete(key);
    const drained = queue.items.slice(queue.head);
    counters.drained += drained.length;
    return drained;
  }

  function drainUpTo(symbol, eventType, maxCount, interval) {
    requireQueueable(eventType);
    if (!Number.isInteger(maxCount) || maxCount <= 0) {
      throw new Error("maxCount must be a positive integer.");
    }
    const key = keyFor(symbol, eventType, interval);
    const queue = queues.get(key);
    if (!queue || queueSize(queue) === 0) {
      return [];
    }
    const takenCount = Math.min(maxCount, queueSize(queue));
    const taken = queue.items.slice(queue.head, queue.head + takenCount);
    queue.head += takenCount;
    counters.drained += taken.length;
    if (queueSize(queue) === 0) {
      queues.delete(key);
    } else {
      compact(queue);
    }
    return taken;
  }

  function drainOne(symbol, eventType, interval) {
    requireQueueable(eventType);
    const key = keyFor(symbol, eventType, interval);
    const queue = queues.get(key);
    if (!queue || queueSize(queue) === 0) return null;
    const item = queue.items[queue.head];
    queue.head += 1;
    counters.drained += 1;
    if (queueSize(queue) === 0) queues.delete(key);
    else compact(queue);
    return item;
  }

  function size(symbol, eventType, interval) {
    requireQueueable(eventType);
    const queue = queues.get(keyFor(symbol, eventType, interval));
    return queue ? queueSize(queue) : 0;
  }

  function clear(symbol, eventType, interval) {
    requireQueueable(eventType);
    const key = keyFor(symbol, eventType, interval);
    const queue = queues.get(key);
    const removed = queue ? queueSize(queue) : 0;
    queues.delete(key);
    counters.cleared += removed;
    return removed;
  }

  function clearAll() {
    let removed = 0;
    for (const queue of queues.values()) removed += queueSize(queue);
    queues.clear();
    counters.cleared += removed;
    return removed;
  }

  function getStats() {
    let pending = 0;
    for (const queue of queues.values()) pending += queueSize(queue);
    return Object.freeze({ ...counters, pending, queueCount: queues.size });
  }

  return Object.freeze({ enqueue, drain, drainUpTo, drainOne, size, clear, clearAll, getStats });
}

module.exports = {
  createBinanceBackpressureQueue,
  QUEUEABLE_EVENT_TYPES,
  OVERFLOW_POLICIES,
  BinanceBackpressureOverflowError,
};
