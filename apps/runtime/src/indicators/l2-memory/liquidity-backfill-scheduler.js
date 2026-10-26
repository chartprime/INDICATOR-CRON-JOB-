"use strict";

const DEFAULT_MAX_WORKERS = 1;
const DEFAULT_TIMEOUT_MS = 300_000;

function emptyResult(reason) {
  return { columns: 0, frames: 0, reason, stats: null, levels: [], aggressive: [] };
}

function createBackfillScheduler({ backfill, maxWorkers = DEFAULT_MAX_WORKERS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof backfill !== "function") throw new Error("liquidity-backfill-scheduler: backfill must be a function");
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0) throw new Error("liquidity-backfill-scheduler: maxWorkers must be a positive safe integer");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("liquidity-backfill-scheduler: timeoutMs must be a positive safe integer");

  const queue = [];
  const running = new Set();
  const counters = { started: 0, completed: 0, failed: 0, cancelled: 0, timedOut: 0 };
  let disposed = false;

  function settle(entry, outcome, value) {
    if (entry.settled) return;
    entry.settled = true;
    if (outcome === "reject") entry.reject(value);
    else entry.resolve(value);
  }

  function finish(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    running.delete(entry);
    pump();
  }

  function start(entry) {
    running.add(entry);
    counters.started += 1;
    const own = entry.request.shouldContinue;
    entry.controller = new AbortController();
    const request = {
      ...entry.request,
      shouldContinue: () => !entry.stopped && (typeof own === "function" ? own() !== false : true),
      signal: entry.controller.signal,
    };
    entry.timer = setTimeout(() => {
      entry.stopped = true;
      counters.timedOut += 1;
      settle(entry, "resolve", emptyResult("TIMEOUT"));
      entry.controller.abort();
    }, timeoutMs);
    entry.timer.unref?.();
    let outcome;
    try {
      outcome = Promise.resolve(backfill(request));
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.then(
      (result) => {
        if (!entry.settled) counters.completed += 1;
        settle(entry, "resolve", result);
        finish(entry);
      },
      (error) => {
        if (!entry.settled) counters.failed += 1;
        settle(entry, "reject", error);
        finish(entry);
      },
    );
  }

  function pump() {
    while (!disposed && running.size < maxWorkers && queue.length > 0) {
      const at = queue.findIndex((entry) => !entry.background);
      if (at >= 0) {
        start(queue.splice(at, 1)[0]);
        continue;
      }
      if (running.size > 0) return;
      start(queue.shift());
    }
  }

  function run(request, { urgent = false } = {}) {
    if (!request || typeof request !== "object") return Promise.reject(new Error("liquidity-backfill-scheduler: request must be an object"));
    if (disposed) return Promise.resolve(emptyResult("DISPOSED"));
    return new Promise((resolve, reject) => {
      const entry = { request, key: request.key, resolve, reject, settled: false, stopped: false, timer: null, urgent, background: request.background === true };
      if (urgent) {
        let at = 0;
        while (at < queue.length && queue[at].urgent) at += 1;
        queue.splice(at, 0, entry);
      } else {
        queue.push(entry);
      }
      pump();
    });
  }

  function cancelEntry(entry) {
    counters.cancelled += 1;
    if (running.has(entry)) {
      entry.stopped = true;
      entry.controller.abort();
      return;
    }
    const at = queue.indexOf(entry);
    if (at >= 0) queue.splice(at, 1);
    settle(entry, "resolve", emptyResult("CANCELLED"));
  }

  function cancel(key) {
    for (const entry of [...queue, ...running]) if (entry.key === key) cancelEntry(entry);
  }

  function prioritise(key) {
    let moved = 0;
    for (const entry of queue.filter((candidate) => candidate.key === key && !candidate.urgent)) {
      queue.splice(queue.indexOf(entry), 1);
      entry.urgent = true;
      let at = 0;
      while (at < queue.length && queue[at].urgent) at += 1;
      queue.splice(at, 0, entry);
      moved += 1;
    }
    return moved;
  }

  function dispose() {
    disposed = true;
    for (const entry of [...queue, ...running]) cancelEntry(entry);
  }

  function stats() {
    return Object.freeze({ running: running.size, queued: queue.length, ...counters });
  }

  return Object.freeze({ run, cancel, prioritise, dispose, stats });
}

module.exports = { createBackfillScheduler, DEFAULT_MAX_WORKERS, DEFAULT_TIMEOUT_MS };
