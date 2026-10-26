const REMOVE_EVENT_FLAG = 0x02;
const NOOP_ACTIONS = new Set(["TRADE", "BUST"]);
const SIDE_LABEL = Object.freeze({ BUY: "bid", SELL: "ask" });
const NATIVE_STATUS = Object.freeze(["active", "filled", "pulled", "replaced", "interrupted"]);
const MAX_OPEN_LIVES = 200_000;

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function hasSize(size) {
  return Number.isFinite(size) && size > 0;
}

function createNativeIcebergTracker({ symbol, maxOpenLives = MAX_OPEN_LIVES } = {}) {
  if (typeof symbol !== "string" || symbol.length === 0) {
    throw new Error("native-iceberg-tracker: symbol must be a non-empty string");
  }
  if (!isPositiveSafeInteger(maxOpenLives)) {
    throw new Error("native-iceberg-tracker: maxOpenLives must be a positive safe integer");
  }
  const lives = new Map();
  let icebergs = 0;

  function isIceberg(life) {
    return life.tranches >= 2;
  }

  function snapshot(life, status, updatedAt) {
    return Object.freeze({
      id: `${symbol}|${life.index}|${life.startedAt}`,
      symbol,
      kind: "native",
      confidence: "certain",
      side: SIDE_LABEL[life.side],
      price: life.price,
      display: life.display,
      tranches: life.tranches,
      executed: life.executed,
      startedAt: life.startedAt,
      firstRefillAt: life.firstRefillAt,
      updatedAt,
      status,
    });
  }

  function emit(life, status, receivedAt) {
    life.updatedAt = receivedAt;
    return snapshot(life, status, receivedAt);
  }

  function end(life, status, receivedAt) {
    lives.delete(life.index);
    if (!isIceberg(life)) return null;
    icebergs -= 1;
    return emit(life, status, receivedAt);
  }

  function evictOneOrdinaryLife() {
    for (const [index, life] of lives) {
      if (isIceberg(life)) continue;
      lives.delete(index);
      return true;
    }
    return false;
  }

  function start(event, receivedAt) {
    if (lives.size >= maxOpenLives && !evictOneOrdinaryLife()) return;
    lives.set(event.index, {
      index: event.index,
      price: event.price,
      side: event.side,
      size: event.size,
      display: event.size,
      tranches: 1,
      executed: 0,
      startedAt: receivedAt,
      firstRefillAt: null,
      updatedAt: receivedAt,
    });
  }

  function removal(life, event, receivedAt) {
    if (!life) return null;
    if (event.action === "EXECUTE") {
      life.executed += life.size;
      return end(life, "filled", receivedAt);
    }
    return end(life, "pulled", receivedAt);
  }

  function partial(life, size, receivedAt) {
    if (size > life.size) {
      life.tranches += 1;
      if (life.tranches === 2) {
        icebergs += 1;
        life.firstRefillAt = receivedAt;
      }
      if (size > life.display) life.display = size;
      life.size = size;
      return emit(life, "active", receivedAt);
    }
    if (size < life.size) {
      life.executed += life.size - size;
      life.size = size;
      return isIceberg(life) ? emit(life, "active", receivedAt) : null;
    }
    return null;
  }

  function apply(event, receivedAt) {
    if (event === null || typeof event !== "object") {
      throw new Error("native-iceberg-tracker: event must be an object");
    }
    if (typeof event.index !== "string" || event.index.length === 0) {
      throw new Error("native-iceberg-tracker: event index must be a non-empty string");
    }
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      throw new Error("native-iceberg-tracker: receivedAt must be a non-negative safe integer");
    }
    const life = lives.get(event.index);
    if ((event.eventFlags & REMOVE_EVENT_FLAG) !== 0) return life ? end(life, "pulled", receivedAt) : null;
    if (NOOP_ACTIONS.has(event.action)) return null;
    if (!hasSize(event.size)) return removal(life, event, receivedAt);
    if (event.action === "NEW") {
      const ended = life ? end(life, "replaced", receivedAt) : null;
      start(event, receivedAt);
      return ended;
    }
    if (!life) {
      start(event, receivedAt);
      return null;
    }
    if (event.price !== life.price || event.side !== life.side) {
      const ended = end(life, "replaced", receivedAt);
      start(event, receivedAt);
      return ended;
    }
    if (event.action === "PARTIAL") return partial(life, event.size, receivedAt);
    if (event.size > life.display) life.display = event.size;
    life.size = event.size;
    return null;
  }

  function reset(receivedAt) {
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      throw new Error("native-iceberg-tracker: receivedAt must be a non-negative safe integer");
    }
    const ended = [];
    for (const life of lives.values()) {
      if (isIceberg(life)) ended.push(emit(life, "interrupted", receivedAt));
    }
    lives.clear();
    icebergs = 0;
    return Object.freeze(ended);
  }

  function active() {
    const out = [];
    for (const life of lives.values()) {
      if (isIceberg(life)) out.push(snapshot(life, "active", life.updatedAt));
    }
    return Object.freeze(out);
  }

  function openLives() {
    return lives.size;
  }

  function activeCount() {
    return icebergs;
  }

  return Object.freeze({ apply, reset, active, activeCount, openLives });
}

module.exports = { createNativeIcebergTracker, NATIVE_STATUS, MAX_OPEN_LIVES };
