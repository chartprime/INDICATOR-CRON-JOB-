"use strict";

const PRUNE_MODES = Object.freeze(["timer", "book"]);

function pairKey(scope, symbol) {
  return `${scope}:${symbol}`;
}

function createL2InputBinding({
  createEngine,
  prune,
  now = () => Date.now(),
  setIntervalImpl = (fn, ms) => setInterval(fn, ms),
  clearIntervalImpl = (timer) => clearInterval(timer),
} = {}) {
  if (typeof createEngine !== "function") throw new Error("l2-input-binding: createEngine is required");
  if (!prune || !PRUNE_MODES.includes(prune.mode)) throw new Error(`l2-input-binding: prune.mode must be one of ${PRUNE_MODES.join(", ")}`);
  if (!Number.isSafeInteger(prune.everyMs) || prune.everyMs <= 0) throw new Error("l2-input-binding: prune.everyMs must be a positive safe integer");

  const engines = new Map();
  const prunedAt = new Map();
  let pruneTimer = null;
  let stopped = false;

  function getEngine(scope, symbol) {
    return engines.get(pairKey(scope, symbol)) ?? null;
  }

  function engineFor(scope, symbol) {
    const key = pairKey(scope, symbol);
    const existing = engines.get(key);
    if (existing) return existing;
    if (stopped) return null;
    const created = createEngine(scope, symbol);
    if (!created) return null;
    engines.set(key, created);
    return created;
  }

  function pruneAfterBook(key, engine, frame) {
    if (prune.mode !== "book" || frame.kind !== "book" || frame.status !== "READY") return;
    const at = typeof frame.ts === "number" ? frame.ts : Date.parse(frame.ts);
    if (at - (prunedAt.get(key) ?? 0) < prune.everyMs) return;
    prunedAt.set(key, at);
    engine.prune(at);
  }

  function apply(scope, symbol, frame) {
    if (stopped) return false;
    const key = pairKey(scope, symbol);
    const engine = engines.get(key);
    if (!engine) return false;
    engine.apply(frame);
    pruneAfterBook(key, engine, frame);
    return true;
  }

  function release(scope, symbol) {
    const key = pairKey(scope, symbol);
    engines.delete(key);
    prunedAt.delete(key);
  }

  function start() {
    if (prune.mode !== "timer" || pruneTimer !== null || stopped) return;
    pruneTimer = setIntervalImpl(() => {
      const at = now();
      for (const engine of engines.values()) engine.prune(at);
    }, prune.everyMs);
    pruneTimer.unref?.();
  }

  function stop() {
    stopped = true;
    if (pruneTimer !== null) clearIntervalImpl(pruneTimer);
    pruneTimer = null;
  }

  function clear() {
    engines.clear();
    prunedAt.clear();
  }

  return Object.freeze({
    getEngine,
    engineFor,
    apply,
    release,
    start,
    stop,
    clear,
    entries: () => engines.entries(),
    get stopped() {
      return stopped;
    },
  });
}

module.exports = { createL2InputBinding, pairKey, PRUNE_MODES };
