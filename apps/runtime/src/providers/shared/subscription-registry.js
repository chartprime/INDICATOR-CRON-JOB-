function keyFor(symbol, eventType, interval) {
  return JSON.stringify([symbol, eventType, interval ?? null]);
}

function createSubscriptionRegistry() {
  const entries = new Map();

  function add(symbol, eventType, consumerId, fromTime, interval) {
    const key = keyFor(symbol, eventType, interval);
    const entry = entries.get(key);

    if (!entry) {
      entries.set(key, { symbol, eventType, fromTime, interval, consumers: new Set([consumerId]) });
      return true;
    }

    entry.consumers.add(consumerId);
    return false;
  }

  function remove(symbol, eventType, consumerId, interval) {
    const key = keyFor(symbol, eventType, interval);
    const entry = entries.get(key);

    if (!entry || !entry.consumers.has(consumerId)) {
      return false;
    }

    entry.consumers.delete(consumerId);

    if (entry.consumers.size > 0) {
      return false;
    }

    entries.delete(key);
    return true;
  }

  function removeConsumer(consumerId) {
    const released = [];

    for (const [key, entry] of entries) {
      if (!entry.consumers.has(consumerId)) {
        continue;
      }

      entry.consumers.delete(consumerId);

      if (entry.consumers.size === 0) {
        entries.delete(key);
        released.push({
          symbol: entry.symbol,
          eventType: entry.eventType,
          ...(entry.fromTime === undefined ? {} : { fromTime: entry.fromTime }),
          ...(entry.interval === undefined ? {} : { interval: entry.interval }),
        });
      }
    }

    return released;
  }

  function has(symbol, eventType, interval) {
    return entries.has(keyFor(symbol, eventType, interval));
  }

  function list() {
    return [...entries.values()].map(({ symbol, eventType, fromTime, interval }) => ({
      symbol,
      eventType,
      ...(fromTime === undefined ? {} : { fromTime }),
      ...(interval === undefined ? {} : { interval }),
    }));
  }

  return { add, remove, removeConsumer, has, list };
}

module.exports = { createSubscriptionRegistry, keyFor };
